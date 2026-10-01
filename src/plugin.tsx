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
  ChevronRight, Search, Hash, Columns3, Copy,
} from "lucide-react";
import { configRead, configWrite, fsWrite, pickFile, pickSavePath } from "../shim/bridge.js";
import {
  ConfirmDialog, ContextMenu, Field, TextInput, toast, useResize,
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

const CFG = "plugin-db";

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
    await configWrite(CFG, JSON.stringify(next)).catch(() => {});
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
    }).catch(() => {});
    // Once, on mount: `connect` is stable and re-running this would reconnect on every save.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const upsert = (conn: Connection) => {
    const connections = cfgRef.current.connections.some((c) => c.id === conn.id)
      ? cfgRef.current.connections.map((c) => (c.id === conn.id ? conn : c))
      : [...cfgRef.current.connections, conn];
    void save({ ...cfgRef.current, connections });
  };

  const remove = (id: string) => {
    void save({
      ...cfgRef.current,
      connections: cfgRef.current.connections.filter((c) => c.id !== id),
    });
  };

  if (!source || !active) {
    return (
      <Connections list={cfg.connections} error={error} busy={busy}
        onConnect={(c) => void connect(c)}
        onSave={upsert} onDelete={remove} />
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
 * Connections live in `plugin-db`, which config.rs keeps device-local — so a password typed here
 * never reaches the vault or Syncthing. It IS stored in plain text on this machine, which is the
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
    const p = await pickFile("db").catch(() => "");
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
        <h2 className="text-lg font-semibold text-text-primary">Databases</h2>
        <p className="text-[13px] text-text-muted">
          {list.length === 0
            ? "No connections yet"
            : `${list.length} connection${list.length === 1 ? "" : "s"}`}
        </p>
      </div>

      {/* One card of divided rows, matching Script Runner: the same shape for the same job means
          a list of saved things reads the same everywhere in Deck. */}
      {list.length > 0 && (
        <div className="divide-y divide-subtle overflow-hidden rounded-xl border border-subtle"
          style={{ background: "var(--bg-card-glass)" }}>
          {list.map((c) => (
            <div key={c.id} className="group flex items-center gap-3 px-4 py-2.5 transition-colors">
              {/* A dot for engine and state, the way a script's dot shows enabled. */}
              {/* The dot becomes a spinner on the one being opened: with several connections a
                  single "Connecting…" line does not say WHICH, and over a tunnel that wait is
                  long enough for the question to come up. */}
              {busy && pending === c.id ? (
                <RefreshCw size={11} className="shrink-0 animate-spin text-accent" />
              ) : (
                <span className="h-2.5 w-2.5 shrink-0 rounded-full"
                  title={ENGINES.find((e) => e.id === c.engine)?.label ?? c.engine}
                  style={{ background: c.engine === "sqlite" ? "var(--border-strong)" : "var(--accent)" }} />
              )}
              <button onClick={() => { setPending(c.id); onConnect(c); }} disabled={busy}
                className="min-w-0 flex-1 text-left disabled:opacity-50">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium text-text-primary">{c.name}</span>
                  <span className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide"
                    style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
                    {c.engine === "postgres" ? "PG" : c.engine === "mysql" ? "MySQL" : "SQLite"}
                  </span>
                  {c.sshHost && (
                    <span className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-text-muted ring-1 ring-subtle"
                      title={`through ssh ${c.sshHost}`}>ssh</span>
                  )}
                  {c.allowWrites && (
                    <span className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-400 ring-1 ring-amber-400/40"
                      title="Writes are allowed on this connection">writes</span>
                  )}
                </div>
                <div className="truncate text-[11px] text-text-muted">{redact(c.target)}</div>
              </button>
              <button onClick={() => setDraft(c)} title="Edit"
                className="shrink-0 rounded-md p-1.5 text-text-muted opacity-0 transition hover:bg-white/5 hover:text-text-primary group-hover:opacity-100">
                <Pencil size={13} />
              </button>
              <button onClick={() => onDelete(c.id)} title="Remove"
                className="shrink-0 rounded-md p-1.5 text-text-muted opacity-0 transition hover:bg-white/5 hover:text-red-400 group-hover:opacity-100">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {draft ? (
        <div className="mt-3 rounded-xl border border-subtle p-4"
          style={{ background: "var(--bg-card-glass)" }}>
          <div className="mb-3 flex gap-1.5">
            {ENGINES.map((e) => (
              <button key={e.id} onClick={() => setDraft({ ...draft, engine: e.id, target: "" })}
                className={`rounded-md border px-2.5 py-1 text-[12px] transition ${
                  draft.engine === e.id
                    ? "border-accent-soft bg-white/10"
                    : "border-subtle text-text-muted hover:text-text-secondary"
                }`}>
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
                    className="flex shrink-0 items-center gap-2 rounded-lg border border-subtle bg-elev px-3 text-sm hover:border-accent-soft">
                    <FolderOpen size={15} /> Browse
                  </button>
                )}
              </div>
            </Field>
          </div>

          {draft.engine !== "sqlite" && (
            <div className="mt-3 rounded-md border border-subtle/60 p-3">
              <label className="flex cursor-pointer items-center gap-2 text-[12px]">
                <input type="checkbox" checked={!!draft.sshHost}
                  onChange={(ev) => setDraft({
                    ...draft,
                    sshHost: ev.target.checked ? "vps" : "",
                    sshRemote: ev.target.checked ? (draft.sshRemote || "localhost:5432") : "",
                  })}
                  className="accent-accent" />
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
                  <p className="text-[11px] text-text-muted">
                    Write the url below as if you were on that host; Deck points it at the tunnel.
                  </p>
                </div>
              )}
            </div>
          )}

          {draft.engine !== "sqlite" && (
            <p className="mt-2 text-[11px] text-text-muted">
              The url is saved on this machine only — never synced, never in the vault — but it is
              stored as plain text, password included. Fine for a local or development database;
              for anything production, connect with an account that can only read.
            </p>
          )}

          <div className="mt-4 flex gap-2">
            <button onClick={commit} disabled={!draft.target.trim()}
              className="flex items-center gap-2 rounded-lg border border-subtle bg-elev px-3 py-2 text-sm hover:border-accent-soft disabled:opacity-50">
              <Plug size={15} /> Save and connect
            </button>
            <button onClick={() => setDraft(null)}
              className="rounded-lg border border-subtle px-3 py-2 text-sm text-text-muted hover:text-text-primary">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button onClick={() => setDraft(blank("sqlite"))}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-subtle py-2.5 text-sm text-text-muted transition hover:border-accent hover:text-text-primary">
          <Plus size={16} /> Add a connection
        </button>
      )}

        {busy && (
          <p className="mt-4 flex items-center gap-2 text-[13px] text-text-muted">
            <RefreshCw size={13} className="animate-spin" />
            {/* A tunnel is the slow part, so name it rather than leaving a generic wait. */}
            {list.find((c) => c.id === pending)?.sshHost
              ? "Opening the SSH tunnel and connecting…"
              : "Connecting…"}
          </p>
        )}
        {error && <p className="mt-4 whitespace-pre-wrap text-[13px] text-red-400">{error}</p>}
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
  const [showHistory, setShowHistory] = useState(false);
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
    setRunning(Date.now());
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
        <div className="flex shrink-0 items-center gap-2 border-b border-subtle px-3 py-2">
          <DatabaseIcon size={14} className="shrink-0 text-text-muted" />
          <span className="truncate text-[12px] text-text-secondary" title={conn.target}>
            {conn.name}
          </span>

          <label className="ml-auto flex shrink-0 cursor-pointer items-center gap-1.5 text-[12px] text-text-muted"
            title={engine === "sqlite"
              ? "Writes apply to the in-memory copy only and are never saved to the file."
              : "Writes reach the real database. Off means the server itself refuses them."}>
            <input type="checkbox" checked={allowWrites}
              onChange={(e) => onToggleWrites(e.target.checked)} className="accent-accent" />
            Allow writes
          </label>

          <button onClick={onReopen} disabled={busy} title="Reload the file from disk"
            className="flex shrink-0 items-center gap-1 rounded-md border border-subtle bg-elev px-2 py-1 text-[12px] hover:border-accent-soft disabled:opacity-50">
            <RefreshCw size={12} className={busy ? "animate-spin" : ""} /> Reload
          </button>
          <button onClick={onClose} title="Close this database"
            className="flex shrink-0 items-center gap-1 rounded-md border border-subtle bg-elev px-2 py-1 text-[12px] text-text-muted hover:text-text-primary">
            <X size={12} />
          </button>
        </div>

        <Editor value={() => sql.current} onChange={(v) => { sql.current = v; }} onRun={execute}
          onSelect={(v) => {
            selectedSql.current = v;
            setHasSelection(Boolean(v.trim()));
          }}
          revision={ran} height={editorHeight} cols={cols} />

        {/* The handle is 4px of hit area on a 1px line: a divider you can actually grab, without
            a 4px band of colour across the pane. */}
        <div {...dragProps} title="Drag to resize"
          className="group h-1 shrink-0 cursor-row-resize border-t border-subtle transition-colors hover:border-accent-soft" />

        <div className="relative flex shrink-0 items-center gap-2 border-y border-subtle px-3 py-1.5">
          <button onClick={runAll} disabled={running !== null}
            title="Run everything in the editor"
            className="flex items-center gap-1.5 rounded-md border border-subtle bg-elev px-2.5 py-1 text-[12px] hover:border-accent-soft disabled:opacity-50">
            {running !== null
              ? <RefreshCw size={12} className="animate-spin" />
              : <Play size={12} />}
            Run all
          </button>
          <button onClick={execute} disabled={!hasSelection || running !== null}
            title={hasSelection
              ? "Run only the highlighted SQL"
              : "Select some SQL in the editor to run just that"}
            className="flex items-center gap-1.5 rounded-md border border-subtle bg-elev px-2.5 py-1 text-[12px] hover:border-accent-soft disabled:opacity-40">
            <TextSelect size={12} /> Run selection
          </button>
          <span className="text-[11px] text-text-muted">Ctrl+Enter</span>
          {running !== null && <Elapsed since={running} />}

          <button onClick={() => setShowHistory((v) => !v)} disabled={forThisDb.length === 0}
            title="Queries you have run against this database"
            className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] disabled:opacity-40 ${
              showHistory ? "border-accent-soft bg-white/10" : "border-subtle bg-elev hover:border-accent-soft"
            }`}>
            <History size={12} /> History{forThisDb.length ? ` (${forThisDb.length})` : ""}
          </button>

          {!allowWrites && (
            <span className="ml-auto text-[11px] text-text-muted">Read-only</span>
          )}

          {showHistory && forThisDb.length > 0 && (
            <>
              {/* A click anywhere else closes it, without a document listener to clean up. */}
              <div className="fixed inset-0 z-20" onClick={() => setShowHistory(false)} />
              <div className="absolute left-0 right-0 top-full z-30 mx-3 max-h-80 overflow-auto rounded-lg border border-subtle bg-elev shadow-xl">
                {forThisDb.map((h, i) => (
                  <button key={`${h.at}-${i}`}
                    onClick={() => { setEditorText(h.sql, false); setShowHistory(false); }}
                    className={`block w-full px-3 py-2 text-left hover:bg-white/5 ${
                      i === 0 ? "" : "border-t border-subtle/60"
                    }`}>
                    <div className="truncate font-mono text-[12px]">{h.sql.replace(/\s+/g, " ")}</div>
                    <div className="text-[10px] text-text-muted">
                      {new Date(h.at).toLocaleString()}
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <Results results={results} error={error} table={selected} fks={fks} onFollow={follow}
          running={running}
          engine={engine} allowWrites={allowWrites} editTable={ranTable}
          tableColumns={ranTable ? (cols.get(ranTable) ?? []) : []}
          onEdit={(st) => void applyEdit(st)} />
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
          <div className="mb-1.5 flex items-baseline gap-1.5 px-1 text-[11px] text-text-muted">
            <span className="uppercase tracking-wide">
              {tableCount} table{tableCount === 1 ? "" : "s"}
            </span>
            {viewCount > 0 && <span>{"·"} {viewCount} view{viewCount === 1 ? "" : "s"}</span>}
          </div>
          {/* Worth its space once a schema is more than a screenful, which is most of them. */}
          <div className="relative">
            <Search size={11}
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-text-muted" />
            <input value={filter} onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter tables and columns"
              className="h-6 w-full rounded border border-subtle bg-elev pl-6 pr-2 text-[11px] outline-none transition focus:border-accent-soft" />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto pb-2">
          {shown.length === 0 && (
            <p className="px-3 py-4 text-center text-[11px] text-text-muted">Nothing matches.</p>
          )}
          {shown.map((t) => {
            const count = counts.get(t.name);
            return (
              <div key={t.name}>
                <button onClick={() => expand(t)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY, table: t });
                  }}
                  className={`flex w-full items-center gap-1 px-2 py-1.5 text-left text-[12px] hover:bg-white/5 ${
                    selected === t.name ? "bg-white/10" : ""
                  }`}>
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
                  <div className="pb-1 pl-5 pr-2">
                    {t.columns.length === 0 && (
                      <div className="py-0.5 text-[11px] text-text-muted">No columns reported.</div>
                    )}
                    {t.columns.map((c) => (
                      <div key={c.name}
                        // Clicking a column filters by its name, which is the quickest way to
                        // find every other table that shares it.
                        onClick={() => setFilter(c.name)}
                        title={`${c.name} ${c.type}${c.notNull ? " not null" : ""}${c.pk ? " primary key" : ""}`}
                        className="flex cursor-pointer items-center gap-1 py-0.5 text-[11px] hover:bg-white/5">
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
                        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded border border-subtle bg-app/60 p-1.5 text-[10px] leading-snug text-text-secondary">
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
        className="w-1 shrink-0 cursor-col-resize border-l border-subtle transition-colors hover:border-accent-soft" />

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
  running,
}: {
  results: Result[]; error: string; table: string | null; running: number | null;
  fks: ForeignKeyRef[]; onFollow: (fk: ForeignKeyRef, value: unknown) => void;
  engine: EngineId; allowWrites: boolean; editTable: string | null; tableColumns: Column[];
  onEdit: (statement: string) => void;
}) {
  const download = async (r: Result) => {
    // The rows EXPORTED are the rows on screen, which is what the cap makes them. Writing the
    // full result instead would silently disagree with the count shown above the grid.
    const path = await pickSavePath("query.csv", "csv").catch(() => "");
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
        <pre className="m-3 whitespace-pre-wrap rounded-lg border border-red-500/40 bg-red-500/5 p-3 text-[12px] text-red-300">
          {error}
        </pre>
      )}
      {results.map((r, i) => <Grid key={i} result={r} index={i} many={results.length > 1}
        fks={table ? fks.filter((f) => f.table === table) : []} onFollow={onFollow}
        engine={engine} table={editTable} allowWrites={allowWrites} tableColumns={tableColumns}
        onEdit={onEdit}
        onExport={() => void download(r)} />)}
      {/* Over a tunnel the first query has nothing to show yet, so the empty state would read as
          "no results" when it means "not finished". */}
      {running !== null && !results.length && (
        <div className="flex items-center justify-center gap-2 p-8 text-[13px] text-text-muted">
          <RefreshCw size={14} className="animate-spin" /> Running…
        </div>
      )}
      {!error && !results.length && running === null && (
        <p className="p-8 text-center text-[13px] text-text-muted">
          Pick a table, or write a query and press Ctrl+Enter.
        </p>
      )}
    </div>
  );
}

function Grid({
  result, index, many, fks, onFollow, engine, table, allowWrites, tableColumns, onEdit, onExport,
}: {
  result: Result; index: number; many: boolean;
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
    <div className="flex min-h-0 flex-col border-b border-subtle/60 last:border-0">
      <div className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-text-muted">
        {many && <span className="text-text-secondary">#{index + 1}</span>}
        <span className="tabular-nums">
          {result.truncated
            ? `showing ${result.rows.length.toLocaleString()} of ${result.total.toLocaleString()} rows (capped at ${ROW_CAP.toLocaleString()})`
            : `${result.total.toLocaleString()} row${result.total === 1 ? "" : "s"}`}
        </span>
        <span className="ml-auto" />
        {canEdit && (
          <button onClick={() => setAdding({})} disabled={!!adding} title="Insert a new row"
            className="flex items-center gap-1 rounded border border-subtle bg-elev px-1.5 py-0.5 hover:text-text-primary disabled:opacity-40">
            <Plus size={11} /> Row
          </button>
        )}
        {allowWrites && blocked && (
          // Said plainly rather than leaving editing mysteriously absent: the reason is always
          // something the user can act on — select the key, or query one table.
          <span className="text-[11px] text-text-muted" title={blocked}>read-only result</span>
        )}
        <button onClick={onExport} title="Copy as CSV"
          className="flex items-center gap-1 rounded border border-subtle bg-elev px-1.5 py-0.5 hover:text-text-primary">
          <Download size={11} /> CSV
        </button>
      </div>
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />
      {/* Scrolls both axes: a wide table must not push the whole pane sideways, and the sticky
          column headers need their vertical scroll container to be an ancestor — otherwise they
          have nothing to stick to and scroll away with the rows. */}
      <div className="min-h-0 overflow-auto">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr>
              {result.columns.map((c, ci) => (
                <th key={c} onClick={() => toggle(ci)}
                  title={`Sort by ${c}${result.truncated ? " (the rows on screen)" : ""}`}
                  className={`sticky top-0 z-10 cursor-pointer select-none whitespace-nowrap border-b border-b-subtle bg-app px-2 py-1 text-left font-medium hover:text-text-primary ${
                  // Each side named explicitly. `border-b border-subtle` would set the colour of
                  // ALL FOUR sides, and whether the later border-r-white/20 wins then depends on
                  // stylesheet order rather than class order — which is why the header rules were
                  // missing while the body's were fine.
                  ci === result.columns.length - 1 ? "" : "border-r border-r-white/20"
                }`}>
                  <span className="inline-flex items-center gap-1">
                    {c}
                    {fkFor(c) && <Link2 size={9} className="text-text-muted" />}
                    {sort?.index === ci && (sort.dir === "asc"
                      ? <ArrowUp size={10} className="text-accent" />
                      : <ArrowDown size={10} className="text-accent" />)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri} className="group/row hover:bg-white/5">
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
                      <td key={ci} className="border-b border-r border-white/20 border-r-white/20 p-0">
                        <input autoFocus value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onBlur={commit}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commit();
                            // Escape abandons the edit; without it the only way out of a
                            // mistyped cell would be to commit it.
                            if (e.key === "Escape") setEditing(null);
                          }}
                          className="w-full bg-elev px-2 py-1 text-[12px] text-text-primary outline-none ring-1 ring-inset ring-accent-soft" />
                      </td>
                    );
                  }
                  return (
                    <td key={ci}
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
                      className={`max-w-[28rem] truncate border-b border-white/20 px-2 py-1 ${
                        ci === row.length - 1 ? "" : "border-r border-r-white/20"
                      } ${
                        kind === "null" ? "italic text-text-muted"
                          : kind === "blob" ? "text-text-muted"
                            : kind === "number" ? "text-right tabular-nums" : ""
                      }`}>
                      {fk ? (
                        <button onClick={() => onFollow(fk, v)}
                          className="text-accent underline decoration-dotted underline-offset-2 hover:decoration-solid">
                          {text}
                        </button>
                      ) : text}
                    </td>
                  );
                })}
                {canEdit && (
                  <td className="w-8 border-b border-white/20 px-1 text-center">
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
                              <pre className="overflow-x-auto rounded border border-subtle bg-app/60 p-2 text-[11px] text-text-secondary">
                                {statement}
                              </pre>
                            </div>
                          ),
                          confirmLabel: "Delete",
                          onConfirm: () => onEdit(statement),
                        });
                      }}
                      title="Delete this row"
                      className="text-text-muted opacity-0 transition group-hover/row:opacity-100 hover:text-red-400">
                      <Trash2 size={11} />
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {/* The new-row form, as the last row of the table so the columns line up with the
                data above it rather than being a separate dialog that has to repeat them. */}
            {adding && (
              <tr className="bg-white/[0.04]">
                {result.columns.map((c) => (
                  <td key={c} className="border-b border-r border-white/20 border-r-white/20 p-0">
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
