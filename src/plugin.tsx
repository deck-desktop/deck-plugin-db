// Databases — browse a SQLite file, or connect to Postgres or MySQL, and run queries.
//
// SQLite runs HERE, in wasm: a file is read into memory and queried by sql.js, so nothing is
// written back to disk even with writes enabled. Postgres and MySQL cannot work that way — a
// webview has no way to open a TCP socket — so they go through Deck's own db_* commands, which
// hold the connection in Rust.
//
// The difference stops at `Source` (src/sources.ts). Everything below takes one of those, so no
// component here asks which engine it is holding: the schema pane, the editor, the grid, the
// history and the sorting are the same code for all three.
//
// READ-ONLY BY DEFAULT, per connection. For a file that is nearly free, since sql.js edits a
// private copy. For a server it is the database's own guarantee: the read-only pool sets the
// flag on every connection, so the SERVER refuses a write rather than a regex here doing it.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Database as DatabaseIcon, Play, FolderOpen, RefreshCw, Table2, Eye, Download, KeyRound, X,
  History, ArrowUp, ArrowDown, Link2, Code2, TextSelect, Plus, Pencil, Trash2, Plug,
  ChevronRight, Search, Hash, Columns3, Copy, Network,
} from "lucide-react";
import { configRead, configWrite, fsWrite, pickFile, pickSavePath } from "../shim/bridge.js";
import {
  ConfirmDialog, ContextMenu, Field, TextInput, Toggle, toast, useResize,
  type ConfirmState, type MenuEntry,
} from "../shim/ui.js";
import { monaco } from "../shim/monaco.js";
import {
  cell, deleteStatement, editable, insertStatement, isReadOnly, lookupFor, previewFor,
  pushHistory, quoteFor, ROW_CAP, singleTable, sortRows, splitStatements, textToRun, toCsv,
  updateStatement,
  type Column, type Connection, type EngineId, type ForeignKeyRef, type HistoryEntry,
  type Result, type SchemaTable, type Source,
} from "./db";
import { open } from "./sources";
import { Diagram } from "./Diagram";

const CFG = "plugin-db";

// Deck's design guide (docs/design.md), as the classes this plugin repeats.
/** An icon button inside a row: one step stronger on hover so it shows against the row's own. */
const iconBtn = "grid size-5 shrink-0 place-items-center rounded text-text-muted transition-colors hover:bg-white/10 hover:text-text-primary";
const dangerBtn = "grid size-5 shrink-0 place-items-center rounded text-text-muted transition-colors hover:bg-white/10 hover:text-red-400";
/** The one accent-filled action on a screen; give it `style={accentFill}`. */
const primaryBtn = "flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium text-white transition hover:brightness-110 disabled:opacity-50 disabled:hover:brightness-100";
const accentFill = { background: "var(--accent)" };
const secondaryBtn = "flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-subtle bg-elev px-3 text-[12.5px] text-text-secondary transition-colors hover:border-strong hover:text-text-primary disabled:opacity-50 disabled:hover:border-subtle";
/** A smaller secondary, for a result's header. */
const smallBtn = "flex h-6 shrink-0 items-center gap-1 rounded-md border border-subtle bg-elev px-1.5 text-[11px] text-text-secondary transition-colors hover:border-strong hover:text-text-primary disabled:opacity-40 disabled:hover:border-subtle";
/** A state in its colour: the text in it, the background the same at 14%. */
const chip = (color: string) => ({ color, background: `color-mix(in srgb, ${color} 14%, transparent)` });
const chipCls = "shrink-0 rounded-full px-1.5 py-px text-[10.5px]";
/** A secondary button sized for the query toolbar. */
const toolBtn = "flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-subtle bg-elev px-2.5 text-[12px] text-text-secondary transition-colors hover:border-strong hover:text-text-primary disabled:opacity-40 disabled:hover:border-subtle";

interface Saved {
  /** Every saved connection. Device-local: config.rs keeps `plugin-` files off the vault. */
  connections: Connection[];
  /** Which one to reopen on return, so the tab comes back where it was left. */
  lastId: string;
  /**
   * The editor's contents, so a query survives leaving the tab.
   *
   * One buffer for every connection rather than one each: the common case is looking at one
   * database, and a scratchpad that empties itself when you glance at another would be worse
   * than one that does not.
   */
  sql: string;
  /** Queries that have run, newest first, across all connections. Filtered on display. */
  history: HistoryEntry[];
}

const DEFAULTS: Saved = { connections: [], lastId: "", sql: "", history: [] };

export default function Database() {
  const [cfg, setCfg] = useState<Saved>(DEFAULTS);
  const [confirmRemove, setConfirmRemove] = useState<ConfirmState | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [active, setActive] = useState<Connection | null>(null);
  const [schema, setSchema] = useState<SchemaTable[]>([]);
  const [fks, setFks] = useState<ForeignKeyRef[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // The latest config, readable from callbacks that outlive a render — notably the unmount
  // cleanup that saves the editor text, which would otherwise capture whatever was current when
  // the component mounted and write it back over everything since.
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  // The live source, so leaving the tab frees it. Without this every visit opens another copy —
  // another wasm heap for a file, or another pair of pools on someone else's server.
  const srcRef = useRef<Source | null>(null);
  useEffect(() => () => { void srcRef.current?.close(); srcRef.current = null; }, []);

  const save = useCallback(async (next: Saved) => {
    // The ref is updated HERE rather than only on the next render: adding a connection saves and
    // then immediately connects, and connect reads cfgRef — which would otherwise still hold the
    // config from before the save and write the new connection back out of existence.
    cfgRef.current = next;
    setCfg(next);
    await configWrite(CFG, JSON.stringify(next)).catch((e) => console.warn("[db] connections save failed", e));
  }, []);

  const connect = useCallback(async (conn: Connection) => {
    if (!conn.target) return;
    setBusy(true);
    setError("");
    try {
      const src = await open(conn);
      // Columns and foreign keys arrive with the table list, once. That gives the sidebar, the
      // autocomplete and the foreign-key links ONE source rather than three.
      //
      // Read BEFORE anything is shown. Setting the source first and awaiting the schema after
      // leaves a render in between where the header names the new connection while the sidebar
      // still lists the previous one's tables — which reads as "connected to the wrong database"
      // and is only cleared by pressing Reload.
      const s = await src.schema();
      // Close the previous one: reconnecting would otherwise leave it open forever. srcRef (not
      // the state) so the unmount cleanup never closes the same source twice.
      void srcRef.current?.close();
      srcRef.current = src;
      setSchema(s.tables);
      setFks(s.foreignKeys);
      setSource(src);
      setActive(conn);
      // cfgRef, not the `current` this was called with. Adding a connection saves it and then
      // connects, so `current` is the config from BEFORE the new connection existed — writing it
      // back here erased the connection that had just been added, leaving lastId pointing at an
      // id no longer in the list.
      await save({ ...cfgRef.current, lastId: conn.id });
    } catch (e) {
      setError(String(e));
      setSource(null);
      setActive(null);
    } finally {
      setBusy(false);
    }
  }, [save]);

  useEffect(() => {
    void configRead(CFG).then((t) => {
      const saved: Saved = t.trim() ? { ...DEFAULTS, ...JSON.parse(t) } : DEFAULTS;
      setCfg(saved);
      // Reconnect to whatever was open last, so the tab comes back where it was left. A server
      // that is no longer reachable surfaces as an error on the connection list, not a hang.
      const last = saved.connections.find((c) => c.id === saved.lastId);
      if (last) void connect(last);
    }).catch((e) => console.warn("[db] connections load failed", e));
    // Once, on mount: `connect` is stable and re-running this would reconnect on every save.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const upsert = (conn: Connection) => {
    const connections = cfgRef.current.connections.some((c) => c.id === conn.id)
      ? cfgRef.current.connections.map((c) => (c.id === conn.id ? conn : c))
      : [...cfgRef.current.connections, conn];
    void save({ ...cfgRef.current, connections });
  };

  const remove = (id: string) => {
    const c = cfgRef.current.connections.find((x) => x.id === id);
    setConfirmRemove({
      title: `Remove ${c ? defaultName(c) : "this connection"}?`,
      body: "Its saved details go, passwords included. The database itself is not touched.",
      confirmLabel: "Remove",
      onConfirm: () => void save({
        ...cfgRef.current,
        connections: cfgRef.current.connections.filter((x) => x.id !== id),
      }),
    });
  };

  if (!source || !active) {
    return (
      <>
        <Connections list={cfg.connections} error={error} busy={busy}
          onConnect={(c) => void connect(c)}
          onSave={upsert} onDelete={remove} />
        <ConfirmDialog state={confirmRemove} onClose={() => setConfirmRemove(null)} />
      </>
    );
  }

  return (
    <Browser source={source} conn={active} schema={schema} fks={fks}
      initialSql={cfg.sql} history={cfg.history}
      onToggleWrites={(v) => {
        const next = { ...active, allowWrites: v };
        setActive(next);
        upsert(next);
      }}
      onPersist={(patch) => void save({ ...cfgRef.current, ...patch })}
      onReopen={() => void connect(active)}
      onClose={() => {
        void srcRef.current?.close();
        srcRef.current = null;
        setSource(null);
        setActive(null);
        setSchema([]);
        setFks([]);
        // Forget which connection was open, or leaving the tab and coming back would reopen the
        // one that was just closed — "close" has to mean closed, not closed until the next
        // navigation.
        void save({ ...cfgRef.current, lastId: "" });
      }} busy={busy} />
  );
}

/**
 * Seconds since a statement started, once it has been slow enough to be worth mentioning.
 *
 * Silent for the first second: a local file answers in milliseconds, and a counter flashing up on
 * every fast query is noise. Past that it is the difference between "this is taking a while" and
 * "this has hung", which is the question a slow tunnel actually raises.
 */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const seconds = (now - since) / 1000;
  if (seconds < 1) return null;
  return <span className="text-[11px] tabular-nums text-text-muted">{seconds.toFixed(1)}s</span>;
}

/** A blank connection, ready to edit. */
function blank(engine: EngineId): Connection {
  return {
    id: `c${Date.now().toString(36)}`,
    name: "",
    engine,
    target: "",
    allowWrites: false,
  };
}

const ENGINES: { id: EngineId; label: string; hint: string }[] = [
  { id: "sqlite", label: "SQLite", hint: "A .db, .sqlite or .sqlite3 file" },
  { id: "postgres", label: "Postgres", hint: "postgres://user:password@host:5432/database" },
  { id: "mysql", label: "MySQL", hint: "mysql://user:password@host:3306/database" },
];

/**
 * The connection list, and the form for adding one.
 *
 * Connections live in `plugin-db`, in Deck's config dir on this machine. A password typed here
 * IS stored there in plain text, and a backup carries it whole, which is the
 * right trade for a local dev database and the wrong one for production; the note under the form
 * says so rather than leaving it to be discovered.
 */
function Connections({ list, error, busy, onConnect, onSave, onDelete }: {
  list: Connection[];
  error: string;
  busy: boolean;
  onConnect: (c: Connection) => void;
  onSave: (c: Connection) => void;
  onDelete: (id: string) => void;
}) {
  const [draft, setDraft] = useState<Connection | null>(null);
  // Which row was clicked, so the spinner lands on that connection rather than on all of them.
  const [pending, setPending] = useState<string | null>(null);
  const engine = ENGINES.find((e) => e.id === draft?.engine) ?? ENGINES[0];

  const browse = async () => {
    const p = await pickFile("db").catch((e) => { console.warn("[db] file picker failed", e); return ""; });
    if (p && draft) setDraft({ ...draft, target: p, name: draft.name || fileName(p) });
  };

  const commit = () => {
    if (!draft?.target.trim()) return;
    const conn = { ...draft, name: draft.name.trim() || defaultName(draft) };
    onSave(conn);
    setDraft(null);
    onConnect(conn);
  };

  // The list gets its OWN scroller, and is not vertically centred. The form grows past the pane
  // once the tunnel fields are showing, and a box taller than its parent centred with `mx-auto`
  // pushes its own top off-screen — which takes Deck's app bar with it and reads as the whole UI
  // breaking rather than as one panel overflowing.
  // The scroller is a flex child, and a box TALLER than the track gets centred by default —
  // which pushes its top above the viewport and takes Deck's app bar with it, so the whole
  // window reads as broken rather than as one panel overflowing. A flex column with a shrink-0
  // child makes the overflow scroll downward instead.
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="mx-auto w-full max-w-3xl shrink-0 p-8">
      <div className="mb-4">
        <h2 className="text-[20px] font-semibold text-text-primary">Databases</h2>
        <p className="text-[12.5px] text-text-muted">
          {list.length === 0
            ? "No connections yet"
            : `${list.length} connection${list.length === 1 ? "" : "s"}`}
        </p>
      </div>

      {/* One card of divided rows, matching Script Runner: the same shape for the same job means
          a list of saved things reads the same everywhere in Deck. */}
      {list.length > 0 && (
        <div className="divide-y divide-subtle overflow-hidden rounded-lg border border-subtle"
          style={{ background: "var(--bg-card-glass)" }}>
          {list.map((c) => (
            <div key={c.id} className="group flex items-center gap-3 px-3.5 py-2 transition-colors hover:bg-white/5">
              {/* A dot for engine and state, the way a script's dot shows enabled. */}
              {/* The dot becomes a spinner on the one being opened: with several connections a
                  single "Connecting…" line does not say WHICH, and over a tunnel that wait is
                  long enough for the question to come up. */}
              {busy && pending === c.id ? (
                <RefreshCw size={11} className="shrink-0 animate-spin text-text-secondary" />
              ) : (
                // A tone rather than the accent, which marks only what is selected.
                <span className="size-[7px] shrink-0 rounded-full"
                  title={ENGINES.find((e) => e.id === c.engine)?.label ?? c.engine}
                  style={{ background: c.engine === "sqlite" ? "var(--text-muted)" : "rgb(var(--tone-sky-400))" }} />
              )}
              <button onClick={() => { setPending(c.id); onConnect(c); }} disabled={busy}
                className="min-w-0 flex-1 text-left disabled:opacity-50">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[12.5px] font-medium text-text-primary">{c.name}</span>
                  <span className={chipCls + " text-text-secondary"} style={{ background: "var(--bg-elev)" }}>
                    {c.engine === "postgres" ? "Postgres" : c.engine === "mysql" ? "MySQL" : "SQLite"}
                  </span>
                  {c.sshHost && (
                    <span className={chipCls + " text-text-muted"} style={{ background: "var(--bg-elev)" }}
                      title={`through ssh ${c.sshHost}`}>SSH</span>
                  )}
                  {c.allowWrites && (
                    <span className={chipCls} style={chip("rgb(var(--tone-amber-400))")}
                      title="Writes are allowed on this connection">Writes</span>
                  )}
                </div>
                <div className="truncate text-[11px] text-text-muted">{redact(c.target)}</div>
              </button>
              <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                <button onClick={() => setDraft(c)} title="Edit" className={iconBtn}>
                  <Pencil size={13} />
                </button>
                <button onClick={() => onDelete(c.id)} title="Remove" className={dangerBtn}>
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {draft ? (
        <div className="mt-3 rounded-lg border border-subtle p-4"
          style={{ background: "var(--bg-card-glass)" }}>
          {/* The engine, as one group of buttons with the chosen one selected. */}
          <div className="mb-3 inline-flex items-center gap-0.5 rounded-lg border border-subtle bg-elev p-0.5">
            {ENGINES.map((e) => (
              <button key={e.id} onClick={() => setDraft({ ...draft, engine: e.id, target: "" })}
                aria-pressed={draft.engine === e.id}
                className={`h-6 rounded-md px-2.5 text-[12px] transition-colors ${
                  draft.engine === e.id
                    ? "text-text-primary"
                    : "text-text-muted hover:bg-white/5 hover:text-text-primary"
                }`}
                style={draft.engine === e.id ? { background: "var(--accent-soft)" } : undefined}>
                {e.label}
              </button>
            ))}
          </div>

          <Field label="Name" hint="What to call it in the list.">
            <TextInput value={draft.name} onChange={(ev) => setDraft({ ...draft, name: ev.target.value })}
              placeholder={defaultName(draft)} />
          </Field>

          <div className="mt-3">
            <Field label={draft.engine === "sqlite" ? "Database file" : "Connection url"}
              hint={engine.hint}>
              <div className="flex gap-2">
                <TextInput value={draft.target}
                  onChange={(ev) => setDraft({ ...draft, target: ev.target.value })}
                  onKeyDown={(ev) => { if (ev.key === "Enter") commit(); }}
                  placeholder={engine.hint} />
                {draft.engine === "sqlite" && (
                  <button onClick={browse}
                    className="flex shrink-0 items-center gap-1.5 rounded-lg border border-subtle bg-elev px-3 text-[12.5px] text-text-secondary transition-colors hover:border-strong hover:text-text-primary">
                    <FolderOpen size={14} /> Browse
                  </button>
                )}
              </div>
            </Field>
          </div>

          {draft.engine !== "sqlite" && (
            <div className="mt-3 rounded-lg border border-subtle p-3">
              <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-text-secondary">
                <input type="checkbox" checked={!!draft.sshHost}
                  onChange={(ev) => setDraft({
                    ...draft,
                    sshHost: ev.target.checked ? "vps" : "",
                    sshRemote: ev.target.checked ? (draft.sshRemote || "localhost:5432") : "",
                  })}
                  className="accent-[var(--accent)]" />
                <Plug size={12} className="text-text-muted" />
                Connect through an SSH tunnel
              </label>

              {!!draft.sshHost && (
                <div className="mt-3 space-y-3">
                  <Field label="SSH host"
                    hint="A host from ~/.ssh/config, or user@example.com. Deck runs ssh itself.">
                    <TextInput value={draft.sshHost}
                      onChange={(ev) => setDraft({ ...draft, sshHost: ev.target.value })}
                      placeholder="vps" />
                  </Field>
                  <Field label="Reach from there"
                    hint="host:port as seen FROM the SSH host: a container address, or localhost:5432.">
                    <TextInput value={draft.sshRemote ?? ""}
                      onChange={(ev) => setDraft({ ...draft, sshRemote: ev.target.value })}
                      placeholder="localhost:5432" />
                  </Field>
                  <p className="text-[11.5px] text-text-muted">
                    Write the url below as if you were on that host; Deck points it at the tunnel.
                  </p>
                </div>
              )}
            </div>
          )}

          {draft.engine !== "sqlite" && (
            <p className="mt-2 text-[11.5px] leading-relaxed text-text-muted">
              The url is saved on this machine only — never synced, never in the vault — but it is
              stored as plain text, password included. Fine for a local or development database;
              for anything production, connect with an account that can only read.
            </p>
          )}

          <div className="mt-4 flex gap-2">
            <button onClick={commit} disabled={!draft.target.trim()} className={primaryBtn} style={accentFill}>
              <Plug size={14} /> Save and connect
            </button>
            <button onClick={() => setDraft(null)} className={secondaryBtn}>
              Cancel
            </button>
          </div>
        </div>
      ) : list.length === 0 ? (
        // Nothing saved yet: what this is for, and the way in.
        <div className="flex items-start gap-2.5 rounded-lg border border-subtle bg-elev px-3 py-3 text-[12.5px] leading-relaxed text-text-muted">
          <DatabaseIcon size={16} className="mt-0.5 shrink-0" />
          <div className="flex flex-col items-start gap-2.5">
            <span>Open a SQLite file, or connect to a Postgres or MySQL server, to browse its tables and run queries. A connection is read-only until you allow writes.</span>
            <button onClick={() => setDraft(blank("sqlite"))} className={primaryBtn} style={accentFill}>
              <Plus size={14} /> Add a connection
            </button>
          </div>
        </div>
      ) : (
        <button onClick={() => setDraft(blank("sqlite"))} className={secondaryBtn + " mt-3"}>
          <Plus size={14} /> Add a connection
        </button>
      )}

        {busy && (
          <p className="mt-4 flex items-center gap-2 text-[12.5px] text-text-muted">
            <RefreshCw size={13} className="animate-spin" />
            {/* A tunnel is the slow part, so name it rather than leaving a generic wait. */}
            {list.find((c) => c.id === pending)?.sshHost
              ? "Opening the SSH tunnel and connecting…"
              : "Connecting…"}
          </p>
        )}
        {error && <p className="mt-4 whitespace-pre-wrap text-[12.5px] text-red-400">{error}</p>}
      </div>
    </div>
  );
}

/** The last path segment, for naming a file connection. */
function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function defaultName(c: Connection): string {
  if (c.engine === "sqlite") return c.target ? fileName(c.target) : "database.db";
  // The database name out of the url, which is the part a person recognises.
  const m = /\/([^/?#]+)(?:[?#]|$)/.exec(c.target.replace(/^\w+:\/\/[^/]*/, ""));
  return m?.[1] ?? c.engine;
}

/**
 * Hide the password when showing a url on screen.
 *
 * The list is the one place a saved connection is displayed, and a screen share or a screenshot
 * of this tab should not be a credential leak.
 */
function redact(target: string): string {
  return target.replace(/(\w+:\/\/[^:/@]+):[^@]*@/, "$1:••••@");
}

/** Schema on the left, editor over results on the right. */
function Browser({
  source, conn, schema, fks, initialSql, history,
  onToggleWrites, onPersist, onReopen, onClose, busy,
}: {
  source: Source; conn: Connection; schema: SchemaTable[]; fks: ForeignKeyRef[];
  initialSql: string; history: HistoryEntry[];
  onToggleWrites: (v: boolean) => void;
  onPersist: (patch: Partial<Saved>) => void;
  onReopen: () => void; onClose: () => void; busy: boolean;
}) {
  const { engine, allowWrites } = conn;
  // Columns by table, for the sidebar and the editor's completions.
  const cols = useMemo(
    () => new Map(schema.map((t) => [t.name, t.columns])),
    [schema],
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [results, setResults] = useState<Result[]>([]);
  const [error, setError] = useState("");
  const [ran, setRan] = useState(0);
  // Where the history menu opens, under its button; null while it is closed.
  const [historyAt, setHistoryAt] = useState<{ x: number; y: number } | null>(null);
  // The table the CURRENT result came from, which is what an edit writes to.
  const [ranTable, setRanTable] = useState<string | null>(null);
  /**
   * When the statement in flight started, or null when nothing is running.
   *
   * A local file answers in milliseconds and needs no spinner; a server over an ssh tunnel takes
   * long enough that a grid sitting there is indistinguishable from one that has hung. The START
   * TIME rather than a boolean, so the elapsed seconds can be shown — past a second or two,
   * "still working, 3.4s" is the thing worth saying and a bare spinner does not say it.
   */
  const [running, setRunning] = useState<number | null>(null);
  // How long the last run took, shown beside its row count.
  const [took, setTook] = useState<number | null>(null);
  const [view, setView] = useState<"query" | "diagram">("query");
  // The editor owns the text; this mirrors it so the run button and Ctrl+Enter see the same SQL.
  const sql = useRef(initialSql);
  // What the editor would run right now — the selection if there is one. Set by the Editor, read
  // here, so this component never has to reach into Monaco.
  const selectedSql = useRef("");
  // Mirrored into state ONLY as a flag: the button has to enable and disable, and a ref cannot
  // trigger that. Storing the boolean rather than the text keeps the re-render to cursor moves
  // that actually cross the has-selection boundary.
  const [hasSelection, setHasSelection] = useState(false);

  // Save the editor text when leaving the tab. On unmount rather than per keystroke: a config
  // write per character would be absurd, and this is the only moment the text can be lost.
  useEffect(() => () => onPersist({ sql: sql.current }), []); // eslint-disable-line react-hooks/exhaustive-deps
  // The split between query and results. `min` leaves a couple of lines visible rather than
  // letting the editor collapse to nothing, which looks like a bug rather than a choice.
  const [editorHeight, dragProps] = useResize({
    initial: 176, min: 64, max: 700, direction: "vertical",
  });
  // The schema pane. `min` keeps a usable width rather than letting it collapse to a sliver that
  // is then hard to grab again.
  const [sidebarWidth, sidebarDrag] = useResize({
    initial: 224, min: 140, max: 560, direction: "horizontal",
  });

  /**
   * Run some SQL. Given no argument it runs what Ctrl+Enter would — the selection if there is
   * one, otherwise everything — so the keyboard and the two buttons share one path rather than
   * three that can drift.
   */
  const runText = useCallback(async (explicit?: string) => {
    const text = explicit ?? textToRun(sql.current, selectedSql.current);
    const statements = splitStatements(text);
    if (!statements.length) return;
    const blocked = statements.filter((s) => !isReadOnly(s));
    if (blocked.length && !allowWrites) {
      setError(
        `Blocked ${blocked.length} statement${blocked.length > 1 ? "s" : ""} that would modify `
        + `the database. Turn on "Allow writes" for this connection to run them — `
        // What a write actually COSTS differs per engine, and saying the wrong one is worse than
        // saying nothing: a file's writes are thrown away, a server's are permanent.
        + (engine === "sqlite"
          ? "for a file they change the in-memory copy only and are discarded on close."
          : "on a server they are permanent.")
        + `\n\n${blocked.join(";\n")}`,
      );
      setResults([]);
      return;
    }
    setError("");
    const started = Date.now();
    setRunning(started);
    // Which table these rows came from, decided by the SQL that is about to run. The sidebar
    // selection cannot answer it: a typed query sets no selection, and an old one would name a
    // table the user is not looking at — which would send an edit to the wrong place.
    setRanTable(statements.length === 1 ? singleTable(statements[0]) : null);
    const out: Result[] = [];
    try {
      // Each statement in turn, so a failure reports which one and keeps what ran before it.
      // One at a time also matters for the servers: Postgres refuses several per round trip.
      for (const s of statements) out.push(await source.run(s, allowWrites));
      setResults(out);
      setTook(Date.now() - started);
      // Recorded only once it RAN. A query that was blocked or threw is not one to offer back.
      onPersist({
        sql: sql.current,
        history: pushHistory(historyRef.current, text, conn.id, Date.now()),
      });
    } catch (e) {
      setResults(out);
      setError(String(e));
    }
    setRunning(null);
    setRan((n) => n + 1);
  }, [source, allowWrites, conn.id, onPersist]);

  /**
   * Apply one editing statement, then reload the grid.
   *
   * Re-running the last query rather than patching the row in place: a trigger, a default or a
   * computed column can make the stored value differ from what was typed, and a grid that shows
   * the typed value instead of the stored one is lying about the database.
   */
  const applyEdit = useCallback(async (statement: string) => {
    if (!allowWrites) {
      setError("Turn on \"Allow writes\" for this connection to change data.");
      return;
    }
    setRunning(Date.now());
    try {
      await source.run(statement, true);
      toast("Applied");
      await runText(sql.current);
    } catch (e) {
      setError(`${statement}

${String(e)}`);
    }
    setRunning(null);
  }, [source, allowWrites, runText]);

  const execute = useCallback(() => { void runText(); }, [runText]);
  const runAll = useCallback(() => { void runText(sql.current); }, [runText]);

  // History as a ref too: execute() is a callback and would otherwise capture the list as it was
  // when it was built, losing every entry but the first.
  const historyRef = useRef(history);
  historyRef.current = history;

  /** Put text in the editor and run it. The one path for a table click and a history pick. */
  const setEditorText = useCallback((text: string, andRun: boolean) => {
    sql.current = text;
    selectedSql.current = "";
    // The editor reads this ref on the next render via its `revision` prop.
    setRan((n) => n + 1);
    if (andRun) setTimeout(execute, 0);
  }, [execute]);

  const pick = (name: string) => {
    setSelected(name);
    setEditorText(previewFor(engine, name), true);
  };

  /** Follow a foreign key: show the row it points at. */
  const follow = (fk: ForeignKeyRef, value: unknown) => {
    setSelected(fk.refTable);
    setEditorText(lookupFor(engine, fk, value), true);
  };

  const forThisDb = history.filter((h) => h.path === conn.id);

  // App.tsx wraps every module in `px-6 pb-3 pt-3`, which is right for a module that reads as a
  // card on the wallpaper and wrong for this one, where the schema pane and results grid should
  // run to the window edge. Cancelled with negative margins rather than by changing the wrapper:
  // that padding belongs to every other module, and this is the only one that wants out of it.
  return (
    // `flex-1`, not `h-full`: the wrapper sits in a flex column, where h-full resolves against
    // the parent's CONTENT box — which excludes the pb-3 the negative margin is cancelling, so
    // the element would be pulled up without growing and leave a strip of wallpaper at the
    // bottom. flex-1 claims the whole track, which is what the negative margins are for.
    <div className="-mx-6 -mb-3 -mt-3 flex min-h-0 flex-1">
      <Schema source={source} tables={schema} selected={selected} onPick={pick}
        onQuery={(text, andRun) => setEditorText(text, andRun)} engine={engine}
        width={sidebarWidth} dragProps={sidebarDrag} />

      {/* Opaque only on this side: a data grid over the wallpaper is unreadable in a way a list
          of table names is not, and it gives the sticky column headers (`bg-app/95`) something
          real to be opaque against. The schema pane keeps Deck's glass. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-app">
        {/* Which database this is, and what may be done to it. */}
        <div className="flex shrink-0 items-center gap-2 px-3 pb-1 pt-2">
          <DatabaseIcon size={14} className="shrink-0 text-text-muted" />
          <span className="shrink-0 truncate text-[13px] font-semibold text-text-primary" title={conn.target}>
            {conn.name}
          </span>
          <span className={chipCls + " text-text-secondary"} style={{ background: "var(--bg-elev)" }}>
            {ENGINES.find((e) => e.id === engine)?.label ?? engine}
          </span>
          <span className="min-w-0 truncate text-[11px] text-text-muted" title={conn.target}>{redact(conn.target)}</span>

          {/* The query and its results, or the whole schema drawn as a diagram. */}
          <div className="ml-auto flex shrink-0 items-center gap-0.5 rounded-lg border border-subtle bg-elev p-0.5">
            {([["query", "Query", Code2], ["diagram", "Diagram", Network]] as const).map(([id, label, Icon]) => (
              <button key={id} onClick={() => setView(id)} aria-pressed={view === id}
                className={"flex h-6 items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors " + (view === id ? "text-text-primary" : "text-text-muted hover:text-text-primary")}
                style={view === id ? { background: "var(--accent-soft)", boxShadow: "inset 0 0 0 1px var(--accent)" } : undefined}>
                <Icon size={12} />{label}
              </button>
            ))}
          </div>

          <label className="ml-2 flex shrink-0 cursor-pointer items-center gap-2 text-[12px] text-text-secondary"
            title={engine === "sqlite"
              ? "Writes apply to the in-memory copy only and are never saved to the file."
              : "Writes reach the real database. Off means the server itself refuses them."}>
            Allow writes
            <Toggle on={allowWrites} onChange={onToggleWrites} />
          </label>

          <button onClick={onReopen} disabled={busy} title="Reload the file from disk" className={toolBtn}>
            <RefreshCw size={12} className={busy ? "animate-spin" : ""} /> Reload
          </button>
          <button onClick={onClose} title="Close this database"
            className="grid size-7 shrink-0 place-items-center rounded-lg text-text-muted transition-colors hover:bg-white/5 hover:text-text-primary">
            <X size={14} />
          </button>
        </div>

        {view === "diagram" && (
          <div className="m-2 mt-1.5 flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-subtle bg-card">
            <Diagram tables={schema} fks={fks} layoutKey={conn.id} onOpen={(name) => { setView("query"); pick(name); }} />
          </div>
        )}
        {view === "query" && <>
        {/* The query: one card, its run controls along the top and the editor under them. */}
        <div className="mx-2 mt-1.5 flex shrink-0 flex-col overflow-hidden rounded-[10px] border border-subtle bg-card">
        <div className="flex shrink-0 items-center gap-2 border-b border-subtle px-2 py-1.5">
          {/* Run all is the screen's one accent action; the rest are secondary. */}
          <button onClick={runAll} disabled={running !== null}
            title="Run everything in the editor"
            className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium text-white transition hover:brightness-110 disabled:opacity-50 disabled:hover:brightness-100"
            style={accentFill}>
            {running !== null
              ? <RefreshCw size={12} className="animate-spin" />
              : <Play size={12} />}
            Run all
          </button>
          <button onClick={execute} disabled={!hasSelection || running !== null}
            title={hasSelection
              ? "Run only the highlighted SQL"
              : "Select some SQL in the editor to run just that"}
            className={toolBtn}>
            <TextSelect size={12} /> Run selection
          </button>
          <kbd className="rounded-md px-1.5 py-0.5 font-sans text-[10.5px] text-text-muted" style={{ background: "var(--bg-elev)" }}>Ctrl+Enter</kbd>
          {running !== null && <Elapsed since={running} />}

          {/* aria-expanded tells the menu this button opened it, so pressing it again closes it. */}
          <button disabled={forThisDb.length === 0} aria-haspopup="menu" aria-expanded={!!historyAt}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setHistoryAt((at) => (at ? null : { x: r.left, y: r.bottom + 4 }));
            }}
            title="Queries you have run against this database"
            className={toolBtn}
            // Lit while its menu is open.
            style={historyAt ? { background: "var(--accent-soft)", color: "var(--text-primary)" } : undefined}>
            <History size={12} /> History{forThisDb.length ? ` (${forThisDb.length})` : ""}
          </button>

          {!allowWrites && (
            <span className={chipCls + " ml-auto text-text-muted"} style={{ background: "var(--bg-elev)" }}>Read-only</span>
          )}

          {/* Deck's menu: it places and flips itself, and closes on a click anywhere else. */}
          {historyAt && forThisDb.length > 0 && (
            <ContextMenu x={historyAt.x} y={historyAt.y} onClose={() => setHistoryAt(null)}
              items={forThisDb.map((h) => ({
                label: h.sql.replace(/\s+/g, " "),
                subLabel: new Date(h.at).toLocaleString(),
                onClick: () => setEditorText(h.sql, false),
              }))} />
          )}
        </div>

        <Editor value={() => sql.current} onChange={(v) => { sql.current = v; }} onRun={execute}
          onSelect={(v) => {
            selectedSql.current = v;
            setHasSelection(Boolean(v.trim()));
          }}
          revision={ran} height={editorHeight} cols={cols} />
        </div>

        {/* The split between the query and its results: a slim bar with room to grab it, lit in
            the accent while the pointer is on it. */}
        <div {...dragProps} title="Drag to resize"
          className="mx-auto my-[3px] h-1 w-16 shrink-0 cursor-row-resize rounded-full bg-white/10 transition-colors hover:bg-[var(--accent)]" />

        <div className="mx-2 mb-2 flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-subtle bg-card">
          <Results results={results} error={error} table={selected} fks={fks} onFollow={follow}
            running={running} took={took}
            engine={engine} allowWrites={allowWrites} editTable={ranTable}
            tableColumns={ranTable ? (cols.get(ranTable) ?? []) : []}
            onEdit={(st) => void applyEdit(st)} />
        </div>
        </>}
      </div>
    </div>
  );
}

/** Tables and views; clicking one expands its columns and previews it. */
function Schema({
  source, tables: list, selected, onPick, onQuery, engine, width, dragProps,
}: {
  source: Source; tables: SchemaTable[];
  selected: string | null;
  onPick: (name: string) => void;
  /** Put SQL in the editor. `run` false leaves it for the user to edit before running. */
  onQuery: (sql: string, run: boolean) => void;
  engine: EngineId;
  width: number; dragProps: { onMouseDown: (e: React.MouseEvent) => void };
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; table: SchemaTable } | null>(null);
  // Row counts are read on demand and REMEMBERED: a database with a hundred tables should not
  // run a hundred count(*) queries to draw a list, but re-counting one every time it is reopened
  // is just as wasteful.
  const [counts, setCounts] = useState<Map<string, number>>(new Map());

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return list;
    // Matches a COLUMN name too, so "email" finds every table that has one — which is the
    // question actually being asked when searching a schema you do not know.
    return list.filter((t) =>
      t.name.toLowerCase().includes(q)
      || t.columns.some((c) => c.name.toLowerCase().includes(q)));
  }, [list, filter]);

  const expand = (t: SchemaTable) => {
    // Clicking the open one closes it. The preview still runs either way: the click means "show
    // me this table", and collapsing the column list is not a reason to stop showing its rows.
    if (open === t.name) {
      setOpen(null);
      onPick(t.name);
      return;
    }
    onPick(t.name);
    setOpen(t.name);
    if (t.kind === "table" && !counts.has(t.name)) {
      // -1 means "counting": the row shows a dash rather than nothing, so a slow count reads as
      // in progress rather than as a table whose count is unavailable.
      setCounts((m) => new Map(m).set(t.name, -1));
      void source.rowCount(t.name)
        .then((count) => setCounts((m) => new Map(m).set(t.name, count)))
        .catch(() => setCounts((m) => { const x = new Map(m); x.delete(t.name); return x; }));
    }
  };

  const tableCount = list.filter((t) => t.kind === "table").length;
  const viewCount = list.length - tableCount;

  return (
    <>
      <div className="flex shrink-0 flex-col overflow-hidden border-r border-subtle bg-panel/80 backdrop-blur-xl blur-surface"
        style={{ width }}>
        <div className="shrink-0 px-2 pb-1.5 pt-2">
          <div className="mb-1.5 flex items-baseline gap-1.5 px-1 text-[11.5px] text-text-muted">
            <span>
              {tableCount} table{tableCount === 1 ? "" : "s"}
            </span>
            {viewCount > 0 && <span>{"·"} {viewCount} view{viewCount === 1 ? "" : "s"}</span>}
          </div>
          {/* Worth its space once a schema is more than a screenful, which is most of them. */}
          <div className="flex h-7 items-center gap-1.5 rounded-lg border border-subtle bg-elev pl-2 pr-1 transition-colors focus-within:border-[var(--accent)]">
            <Search size={12} className="shrink-0 text-text-muted" />
            <input value={filter} onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter tables and columns"
              className="min-w-0 flex-1 bg-transparent text-[12px] text-text-primary outline-none placeholder:text-text-muted" />
            {filter && (
              <button onClick={() => setFilter("")} title="Clear the filter" className={iconBtn}><X size={12} /></button>
            )}
          </div>
        </div>

        <div className="scroll-thin min-h-0 flex-1 overflow-auto px-1.5 pb-2">
          {shown.length === 0 && (list.length === 0
            ? <p className="px-1.5 py-3 text-[12px] text-text-muted">This database has no tables or views yet.</p>
            : (
              <div className="flex flex-col items-start gap-2 px-1.5 py-3 text-[12px] text-text-muted">
                <span>No table or column matches “{filter.trim()}”.</span>
                <button onClick={() => setFilter("")} className={toolBtn}>Clear filter</button>
              </div>
            ))}
          {shown.map((t) => {
            const count = counts.get(t.name);
            return (
              <div key={t.name}>
                <button onClick={() => expand(t)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY, table: t });
                  }}
                  className={`flex h-6 w-full items-center gap-1 rounded-md px-1.5 text-left text-[12.5px] transition-colors ${
                    selected === t.name ? "text-text-primary" : "text-text-secondary hover:bg-white/5 hover:text-text-primary"
                  }`}
                  style={selected === t.name ? { background: "var(--accent-soft)" } : undefined}>
                  <ChevronRight size={11}
                    className={`shrink-0 text-text-muted transition-transform ${
                      open === t.name ? "rotate-90" : ""
                    }`} />
                  {t.kind === "view"
                    ? <Eye size={12} className="shrink-0 text-text-muted" />
                    : <Table2 size={12} className="shrink-0 text-text-muted" />}
                  <span className="truncate">{t.name}</span>
                  {/* The row count beside the name rather than inside the expanded panel: it is
                      the number most often wanted, and opening a table to read it is a click
                      spent on one figure. */}
                  {count !== undefined && (
                    <span className="ml-auto shrink-0 text-[10px] tabular-nums text-text-muted">
                      {count < 0 ? "…" : count.toLocaleString()}
                    </span>
                  )}
                </button>

                {open === t.name && (
                  <div className="pb-1 pl-4 pr-1">
                    {t.columns.length === 0 && (
                      <div className="py-0.5 text-[11px] text-text-muted">No columns reported.</div>
                    )}
                    {t.columns.map((c) => (
                      <div key={c.name}
                        // Clicking a column filters by its name, which is the quickest way to
                        // find every other table that shares it.
                        onClick={() => setFilter(c.name)}
                        title={`${c.name} ${c.type}${c.notNull ? " not null" : ""}${c.pk ? " primary key" : ""}`}
                        className="flex cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 text-[11px] transition-colors hover:bg-white/5">
                        {c.pk
                          ? <KeyRound size={9} className="shrink-0 text-amber-400" />
                          : <span className="w-[9px] shrink-0" />}
                        <span className="truncate text-text-secondary">{c.name}</span>
                        {/* NOT NULL as a dot rather than the words: worth seeing at a glance,
                            not worth a third of the row. */}
                        {c.notNull && <span className="shrink-0 text-[9px] text-text-muted">{"•"}</span>}
                        <span className="ml-auto shrink-0 truncate text-[10px] text-text-muted">
                          {shortType(c.type)}
                        </span>
                      </div>
                    ))}
                    {t.sql && (
                      <details className="mt-1">
                        <summary className="cursor-pointer list-none text-[10px] text-text-muted hover:text-text-secondary">
                          <Code2 size={9} className="mr-1 inline" />CREATE statement
                        </summary>
                        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-subtle bg-[var(--bg-app)] p-1.5 font-mono text-[10.5px] leading-snug text-text-secondary">
                          {t.sql}
                        </pre>
                      </details>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* 4px of hit area on a 1px line: grabbable without a visible band of colour. */}
      <div {...dragProps} title="Drag to resize"
        className="w-1 shrink-0 cursor-col-resize border-l border-subtle transition-colors hover:border-[var(--accent)]" />

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}
          items={tableMenu(engine, menu.table, onQuery, () => setFilter(menu.table.name))} />
      )}
    </>
  );
}

/**
 * What right-clicking a table offers.
 *
 * Everything here WRITES SQL INTO THE EDITOR rather than running something the user cannot see.
 * A count runs immediately because it answers a question and changes nothing; a DELETE is left
 * unrun, because a menu item that silently empties a table is a trap. The point of the menu is
 * to save typing, not to hide what is about to happen.
 */
function tableMenu(
  engine: EngineId,
  t: SchemaTable,
  onQuery: (sql: string, run: boolean) => void,
  filterByName: () => void,
): MenuEntry[] {
  const q = (name: string) => quoteFor(engine, name);
  const cols = t.columns.map((c) => q(c.name)).join(", ");
  const pk = t.columns.find((c) => c.pk);

  const items: MenuEntry[] = [
    {
      label: "Select all rows",
      icon: Table2,
      onClick: () => onQuery(previewFor(engine, t.name), true),
    },
    {
      label: "Count rows",
      icon: Hash,
      onClick: () => onQuery(`select count(*) from ${q(t.name)};`, true),
    },
    {
      // Named columns rather than *, which is what anyone writes a real query from.
      label: "Select columns…",
      subLabel: `${t.columns.length} column${t.columns.length === 1 ? "" : "s"}`,
      icon: Columns3,
      onClick: () => onQuery(`select ${cols}\nfrom ${q(t.name)}\nlimit 200;`, false),
    },
  ];

  if (pk) {
    items.push({
      label: "Find by primary key…",
      subLabel: pk.name,
      icon: KeyRound,
      onClick: () => onQuery(`select * from ${q(t.name)} where ${q(pk.name)} = ;`, false),
    });
  }

  items.push("sep");
  items.push({
    label: "Insert…",
    icon: Plus,
    onClick: () => onQuery(
      `insert into ${q(t.name)} (${cols})\nvalues (${t.columns.map(() => "").join(", ")});`,
      false,
    ),
  });
  items.push({
    label: "Update…",
    icon: Pencil,
    onClick: () => onQuery(
      `update ${q(t.name)}\nset ${t.columns[0] ? q(t.columns[0].name) : "column"} = \n`
      + `where ${pk ? q(pk.name) : "condition"} = ;`,
      false,
    ),
  });
  items.push({
    label: "Delete rows…",
    icon: Trash2,
    danger: true,
    // Deliberately NOT run, and deliberately carrying a where clause that is incomplete: a
    // DELETE that arrives ready to execute is one Ctrl+Enter from emptying the table.
    onClick: () => onQuery(
      `delete from ${q(t.name)}\nwhere ${pk ? q(pk.name) : "condition"} = ;`,
      false,
    ),
  });

  items.push("sep");
  items.push({
    label: "Filter the list by this name",
    icon: Search,
    onClick: filterByName,
  });
  items.push({
    label: "Copy name",
    icon: Copy,
    onClick: () => void navigator.clipboard.writeText(t.name).catch(() => {}),
  });
  if (t.sql) {
    items.push({
      label: "Copy CREATE statement",
      icon: Code2,
      onClick: () => void navigator.clipboard.writeText(t.sql).catch(() => {}),
    });
  }
  return items;
}

/**
 * A column type, shortened for a narrow pane.
 *
 * `timestamp with time zone` is 24 characters and says the same thing as `timestamptz` in a
 * sidebar. The full type stays on the row's tooltip, so nothing is actually lost.
 */
function shortType(type: string): string {
  return type
    .replace(/^timestamp with time zone$/i, "timestamptz")
    .replace(/^timestamp without time zone$/i, "timestamp")
    .replace(/^character varying/i, "varchar")
    .replace(/^character$/i, "char")
    .replace(/^double precision$/i, "double")
    .replace(/^integer$/i, "int")
    .replace(/^boolean$/i, "bool");
}

/**
 * The query editor — Deck's own Monaco, not a textarea.
 *
 * Monaco comes from window.__deck because two instances in one page fight over the language and
 * theme registries. `deck-dark` and the `sql` grammar are both already registered by the time a
 * plugin loads, so there is nothing to set up here.
 *
 * `value` is a getter rather than a prop so that typing does not re-render the whole browser on
 * every keystroke; `revision` is the signal to pull the text back in when something else (a
 * table click) changed it.
 */
function Editor({ value, onChange, onRun, onSelect, revision, height, cols }: {
  value: () => string; onChange: (v: string) => void; onRun: () => void;
  onSelect: (v: string) => void; revision: number; height: number;
  cols: Map<string, Column[]>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  // The latest onRun, so the Ctrl+Enter command does not capture a stale closure.
  const runRef = useRef(onRun);
  runRef.current = onRun;
  // Same for the schema: the completion provider is registered once, but the database it
  // describes can be reloaded underneath it.
  const colsRef = useRef(cols);
  colsRef.current = cols;

  useEffect(() => {
    if (!host.current) return;
    const ed = monaco.editor.create(host.current, {
      value: value(),
      language: "sql",
      theme: "deck-dark",
      minimap: { enabled: false },
      lineNumbers: "on",
      scrollBeyondLastLine: false,
      automaticLayout: true,
      fontSize: 13,
      padding: { top: 8, bottom: 8 },
    });
    editor.current = ed;
    ed.onDidChangeModelContent(() => onChange(ed.getValue()));
    // Report the selection rather than the whole buffer, so Ctrl+Enter can run just it.
    ed.onDidChangeCursorSelection(() => {
      const sel = ed.getSelection();
      onSelect(sel && !sel.isEmpty() ? (ed.getModel()?.getValueInRange(sel) ?? "") : "");
    });
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runRef.current());

    // Schema-aware completion. Registered GLOBALLY on Deck's shared Monaco — there is no
    // per-editor registration — so two things are mandatory: dispose it on unmount, or every
    // remount stacks another provider and suggestions arrive in duplicate; and return nothing
    // for any model but this one, or the Editor module's .sql files would offer this database's
    // table names.
    const myUri = ed.getModel()?.uri.toString();
    const provider = monaco.languages.registerCompletionItemProvider("sql", {
      provideCompletionItems(model, position) {
        if (model.uri.toString() !== myUri) return { suggestions: [] };
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber, endLineNumber: position.lineNumber,
          startColumn: word.startColumn, endColumn: word.endColumn,
        };
        const suggestions: monaco.languages.CompletionItem[] = [];
        for (const [table, list] of colsRef.current) {
          suggestions.push({
            label: table, kind: monaco.languages.CompletionItemKind.Class,
            insertText: table, range, detail: "table",
          });
          for (const c of list) {
            suggestions.push({
              label: c.name, kind: monaco.languages.CompletionItemKind.Field,
              insertText: c.name, range, detail: `${table}.${c.name}${c.type ? ` · ${c.type}` : ""}`,
            });
          }
        }
        return { suggestions };
      },
    });

    // Modules unmount on navigation; an editor left undisposed leaks its model and its DOM.
    return () => { provider.dispose(); ed.dispose(); editor.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Pull in text set from outside (clicking a table), without disturbing ordinary typing.
  useEffect(() => {
    const ed = editor.current;
    if (ed && ed.getValue() !== value()) ed.setValue(value());
  }, [revision]); // eslint-disable-line react-hooks/exhaustive-deps

  // `bg-card` behind the editor, not inside the theme: `deck-dark` paints editor.background
  // transparent on purpose so the Editor module can sit on Deck's glass panel, and a query
  // editor over the desktop wallpaper is unreadable. Setting it here keeps that choice local —
  // changing the theme would repaint every editor in Deck. `card` is the same token the theme
  // already uses for editor widgets, so it matches rather than approximates.
  // An inline height because it comes from a drag: a Tailwind class cannot carry a live pixel
  // value. `automaticLayout` in the editor options is what makes Monaco follow it.
  return <div ref={host} style={{ height }} className="shrink-0 bg-card" />;
}

/** One grid per statement, plus whatever went wrong. */
function Results({
  results, error, table, fks, onFollow, engine, allowWrites, editTable, tableColumns, onEdit,
  running, took,
}: {
  results: Result[]; error: string; table: string | null; running: number | null;
  /** How long the last run took, in ms. */
  took: number | null;
  fks: ForeignKeyRef[]; onFollow: (fk: ForeignKeyRef, value: unknown) => void;
  engine: EngineId; allowWrites: boolean; editTable: string | null; tableColumns: Column[];
  onEdit: (statement: string) => void;
}) {
  const download = async (r: Result) => {
    // The rows EXPORTED are the rows on screen, which is what the cap makes them. Writing the
    // full result instead would silently disagree with the count shown above the grid.
    const path = await pickSavePath("query.csv", "csv").catch((e) => { console.warn("[db] save dialog failed", e); return ""; });
    if (!path) return;
    try {
      await fsWrite(path, toCsv(r));
      toast(`Exported ${r.rows.length.toLocaleString()} rows`);
    } catch (e) {
      toast(`Could not write the file: ${String(e)}`);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      {error && (
        <pre className="m-3 whitespace-pre-wrap rounded-lg border border-red-400/40 bg-red-400/5 p-3 text-[12px] text-red-300">
          {error}
        </pre>
      )}
      {results.map((r, i) => <Grid key={i} result={r} index={i} many={results.length > 1}
        took={i === results.length - 1 ? took : null}
        fks={table ? fks.filter((f) => f.table === table) : []} onFollow={onFollow}
        engine={engine} table={editTable} allowWrites={allowWrites} tableColumns={tableColumns}
        onEdit={onEdit}
        onExport={() => void download(r)} />)}
      {/* Over a tunnel the first query has nothing to show yet, so the empty state would read as
          "no results" when it means "not finished". */}
      {running !== null && !results.length && (
        <div className="flex items-center justify-center gap-2 p-8 text-[12.5px] text-text-muted">
          <RefreshCw size={14} className="animate-spin" /> Running…
        </div>
      )}
      {!error && !results.length && running === null && (
        <div className="m-auto flex flex-col items-center gap-2 p-8 text-center">
          <span className="grid size-10 place-items-center rounded-full" style={{ background: "var(--bg-elev)" }}>
            <Table2 size={18} className="text-text-muted" />
          </span>
          <span className="text-[13px] font-medium text-text-secondary">No results yet</span>
          <span className="max-w-xs text-[12px] leading-relaxed text-text-muted">Pick a table on the left, or write a query above and press Ctrl+Enter.</span>
        </div>
      )}
    </div>
  );
}

function Grid({
  result, index, many, took, fks, onFollow, engine, table, allowWrites, tableColumns, onEdit, onExport,
}: {
  result: Result; index: number; many: boolean; took: number | null;
  fks: ForeignKeyRef[]; onFollow: (fk: ForeignKeyRef, value: unknown) => void;
  engine: EngineId; table: string | null; allowWrites: boolean; tableColumns: Column[];
  onEdit: (statement: string) => void;
  onExport: () => void;
}) {
  // Which cell is being edited, and the row being added, if any.
  const [editing, setEditing] = useState<{ row: number; col: number } | null>(null);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState<Record<string, string> | null>(null);
  // A delete cannot be undone and a misplaced click is a lost row, so it asks first. An edit
  // does not: a wrong value can be typed over, and a prompt on every cell would make the grid
  // unusable as an editor.
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  // The cell last clicked, ringed so it is plain which value a double-click would edit.
  const [picked, setPicked] = useState<{ row: number; col: number } | null>(null);
  // Each column's declared type, when the rows are one table's: shown under its name.
  const typeOf = (col: string) => tableColumns.find((c) => c.name === col)?.type ?? "";

  // Why this result cannot be written to, if it cannot. Only the FIRST result of a script is
  // editable: the others are not what the grid is showing a table for.
  const blocked = index > 0
    ? "Only the first result is editable."
    : editable(table, result.columns, tableColumns);
  const canEdit = allowWrites && !blocked;
  const pk = tableColumns.filter((c) => c.pk).map((c) => c.name);

  const commitAdd = () => {
    if (!adding || !table) return;
    setAdding(null);
    onEdit(insertStatement(engine, table, adding));
  };
  // Which column the grid is sorted by, if any. Third click clears it rather than cycling back to
  // ascending: returning to the order the query produced is a state worth being able to reach.
  const [sort, setSort] = useState<{ index: number; dir: "asc" | "desc" } | null>(null);
  const rows = sort ? sortRows(result.rows, sort.index, sort.dir) : result.rows;
  const toggle = (ci: number) => setSort((s) =>
    s?.index !== ci ? { index: ci, dir: "asc" }
      : s.dir === "asc" ? { index: ci, dir: "desc" }
        : null);
  // Only the columns this result actually has: a join's output may not carry the key column.
  const fkFor = (col: string) => fks.find((f) => f.column === col);
  if (!result.columns.length) {
    return (
      <p className="px-3 py-2 text-[12px] text-text-muted">
        {many && <span className="mr-2 text-text-secondary">#{index + 1}</span>}
        No rows returned.
      </p>
    );
  }
  return (
    <div className="flex min-h-0 flex-col border-b border-subtle last:border-0">
      <div className="flex h-9 shrink-0 items-center gap-2 px-3 text-[11.5px] text-text-muted">
        {many && <span className={chipCls + " text-text-secondary"} style={{ background: "var(--bg-elev)" }}>#{index + 1}</span>}
        <span className="tabular-nums text-text-secondary">
          {result.truncated
            ? `${result.rows.length.toLocaleString()} of ${result.total.toLocaleString()} rows`
            : `${result.total.toLocaleString()} row${result.total === 1 ? "" : "s"}`}
        </span>
        {result.truncated && (
          <span className={chipCls} title={`Only the first ${ROW_CAP.toLocaleString()} rows are shown`}
            style={{ color: "rgb(var(--tone-amber-400))", background: "color-mix(in srgb, rgb(var(--tone-amber-400)) 14%, transparent)" }}>
            Capped at {ROW_CAP.toLocaleString()}
          </span>
        )}
        {took !== null && <span className="tabular-nums">{took < 1000 ? `${took} ms` : `${(took / 1000).toFixed(1)} s`}</span>}
        <span className="ml-auto" />
        {canEdit && (
          <button onClick={() => setAdding({})} disabled={!!adding} title="Insert a new row"
            className={smallBtn}>
            <Plus size={11} /> Row
          </button>
        )}
        {allowWrites && blocked && (
          // Said plainly rather than leaving editing mysteriously absent: the reason is always
          // something the user can act on — select the key, or query one table.
          <span className="text-[11px] text-text-muted" title={blocked}>Read-only result</span>
        )}
        <button onClick={onExport} title="Copy as CSV"
          className={smallBtn}>
          <Download size={11} /> CSV
        </button>
      </div>
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />
      {/* Scrolls both axes: a wide table must not push the whole pane sideways, and the sticky
          column headers need their vertical scroll container to be an ancestor — otherwise they
          have nothing to stick to and scroll away with the rows. */}
      <div className="min-h-0 overflow-auto">
        {/* Columns as wide as what is in them, not stretched to the pane: across a wide window a
            stretched number column puts the value a screen away from its heading. */}
        <table className="w-max min-w-[50%] border-collapse text-[12px]">
          <thead>
            <tr>
              {/* The row number, for finding your place in a long result. */}
              <th className="sticky left-0 top-0 z-20 w-10 border-b border-r border-b-subtle border-r-white/[0.06] bg-panel px-2 py-1.5 text-right text-[10.5px] font-normal text-text-muted">#</th>
              {result.columns.map((c, ci) => (
                <th key={c} onClick={() => toggle(ci)}
                  title={`Sort by ${c}${result.truncated ? " (the rows on screen)" : ""}`}
                  className={`group/th sticky top-0 z-10 cursor-pointer select-none whitespace-nowrap border-b border-b-subtle bg-panel px-2.5 py-1.5 text-left align-top font-medium text-text-secondary transition-colors hover:text-text-primary ${
                  // Each side named explicitly. `border-b border-subtle` would set the colour of
                  // ALL FOUR sides, and whether the later border-r-white/20 wins then depends on
                  // stylesheet order rather than class order — which is why the header rules were
                  // missing while the body's were fine.
                  ci === result.columns.length - 1 ? "" : "border-r border-r-white/[0.06]"
                }`}>
                  <span className="flex items-center gap-1">
                    {c}
                    {fkFor(c) && <Link2 size={10} className="text-text-muted" />}
                    {sort?.index === ci
                      ? (sort.dir === "asc"
                        ? <ArrowUp size={11} style={{ color: "var(--accent)" }} />
                        : <ArrowDown size={11} style={{ color: "var(--accent)" }} />)
                      : <ArrowUp size={11} className="opacity-0 transition-opacity group-hover/th:opacity-40" />}
                  </span>
                  {typeOf(c) && <span className="block font-mono text-[10px] font-normal text-text-muted">{shortType(typeOf(c))}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri} className="group/row hover:bg-white/[0.03]">
                <td className="sticky left-0 border-b border-r border-white/[0.05] bg-card px-2 py-1 text-right text-[10.5px] tabular-nums text-text-muted group-hover/row:text-text-secondary">{ri + 1}</td>
                {row.map((v, ci) => {
                  const { text, kind } = cell(v);
                  // A declared foreign key with a value is clickable: it shows the row it names.
                  const fk = kind === "null" ? undefined : fkFor(result.columns[ci]);
                  const isEditing = editing?.row === ri && editing.col === ci;

                  if (isEditing) {
                    const commit = () => {
                      setEditing(null);
                      // Nothing changed: do not send a statement that would do nothing but show
                      // up in the history and touch an updated_at trigger.
                      if (draft === text) return;
                      onEdit(updateStatement(
                        engine, table!, result.columns, row, pk, result.columns[ci], draft,
                      ));
                    };
                    return (
                      <td key={ci} className="border-b border-r border-white/[0.05] p-0">
                        <input autoFocus value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onBlur={commit}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commit();
                            // Escape abandons the edit; without it the only way out of a
                            // mistyped cell would be to commit it.
                            if (e.key === "Escape") setEditing(null);
                          }}
                          className="w-full bg-elev px-2.5 py-1 text-[12px] text-text-primary outline-none ring-1 ring-inset ring-[var(--accent)]" />
                      </td>
                    );
                  }
                  const isPicked = picked?.row === ri && picked.col === ci;
                  return (
                    <td key={ci}
                      onClick={() => setPicked({ row: ri, col: ci })}
                      onDoubleClick={canEdit ? () => {
                        setEditing({ row: ri, col: ci });
                        // NULL edits as empty, so clearing a cell and setting it to NULL are the
                        // same gesture rather than requiring the word to be typed.
                        setDraft(kind === "null" ? "" : text);
                      } : undefined}
                      title={fk
                        ? `Show ${fk.refTable} where ${fk.refColumn} = ${text}`
                        : canEdit ? `${text}

Double-click to edit` : text}
                      className={`max-w-[28rem] truncate border-b border-white/[0.05] px-2.5 py-1 ${
                        ci === row.length - 1 ? "" : "border-r border-r-white/[0.05]"
                      } ${
                        kind === "blob" ? "text-text-muted"
                          : kind === "number" ? "text-right tabular-nums text-text-primary" : "text-text-primary"
                      } ${isPicked ? "bg-[var(--accent-soft)] outline outline-1 -outline-offset-1 outline-[var(--accent)]" : ""}`}>
                      {fk ? (
                        <button onClick={() => onFollow(fk, v)}
                          className="underline decoration-dotted underline-offset-2 hover:decoration-solid" style={{ color: "var(--accent)" }}>
                          {text}
                        </button>
                      ) : kind === "null" ? (
                        // NULL is not the text "NULL": a quiet tag, so it cannot be mistaken for a value.
                        <span className="rounded px-1 text-[10px] tracking-wide text-text-muted" style={{ background: "var(--bg-elev)" }}>NULL</span>
                      ) : text}
                    </td>
                  );
                })}
                {canEdit && (
                  <td className="w-8 border-b border-white/[0.05] px-1 text-center">
                    <button
                      onClick={() => {
                        const statement = deleteStatement(engine, table!, result.columns, row, pk);
                        setConfirm({
                          title: "Delete this row?",
                          // The statement itself, because it names exactly which row goes — more
                          // useful than a sentence describing it, and it is what will run.
                          body: (
                            <div className="space-y-2">
                              <p>This cannot be undone.</p>
                              <pre className="overflow-x-auto rounded-md border border-subtle bg-[var(--bg-app)] p-2 font-mono text-[11px] text-text-secondary">
                                {statement}
                              </pre>
                            </div>
                          ),
                          confirmLabel: "Delete",
                          onConfirm: () => onEdit(statement),
                        });
                      }}
                      title="Delete this row"
                      className="grid size-5 place-items-center rounded text-text-muted opacity-0 transition group-hover/row:opacity-100 hover:bg-white/10 hover:text-red-400">
                      <Trash2 size={12} />
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {/* The new-row form, as the last row of the table so the columns line up with the
                data above it rather than being a separate dialog that has to repeat them. */}
            {adding && (
              <tr style={{ background: "var(--accent-soft)" }}>
                <td className="sticky left-0 border-b border-r border-white/[0.05] bg-card px-2 py-1 text-right text-[10.5px] text-text-muted">+</td>
                {result.columns.map((c) => (
                  <td key={c} className="border-b border-r border-white/[0.05] p-0">
                    <input value={adding[c] ?? ""}
                      onChange={(e) => setAdding({ ...adding, [c]: e.target.value })}
                      onKeyDown={(e) => { if (e.key === "Enter") commitAdd(); }}
                      placeholder={c}
                      className="w-full bg-transparent px-2 py-1 text-[12px] text-text-primary outline-none placeholder:text-text-muted" />
                  </td>
                ))}
                <td className="w-8 px-1 text-center">
                  <button onClick={() => setAdding(null)} title="Cancel"
                    className="text-text-muted hover:text-text-primary">
                    <X size={11} />
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
