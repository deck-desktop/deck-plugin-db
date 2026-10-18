// Databases — open a SQLite file, or connect to Postgres, MySQL, SQL Server, Redis or
// MongoDB, and run queries.
//
// Every engine goes through Deck's own db_* commands, which hold the connection in Rust: a
// webview has no way to open a TCP socket, and a database file is better opened in place than
// read into memory. So a file is the real file, and a write to it, with writes allowed, is a
// write to the file.
//
// The difference stops at `Source` (src/sources.ts) and the per-engine functions in db.ts.
// Everything below takes a Source, so the schema pane, the editor, the grid, the history and the
// sorting are the same code for every engine; where one differs (Redis and MongoDB are not SQL),
// it asks db.ts rather than spelling the engine out.
//
// READ-ONLY BY DEFAULT, per connection, and the database's own guarantee: Rust opens the file
// read-only or sets the session flag, so the ENGINE refuses a write rather than a regex here
// doing it (Redis and MongoDB, which have no such flag, by Rust's list of read commands).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Database as DatabaseIcon, Play, FolderOpen, RefreshCw, Table2, Eye, Download, KeyRound, X,
  History, ArrowUp, ArrowDown, Link2, Code2, TextSelect, Plus, Pencil, Trash2, Plug,
  ChevronRight, Search, Hash, Columns3, Copy, Network, TableProperties, PanelRight,
  WandSparkles, ListTree, Bookmark, BookmarkPlus, ChevronDown,
} from "lucide-react";
import { configRead, configWrite, fsWrite, pickFile, pickSavePath } from "../shim/bridge.js";
import {
  ConfirmDialog, ContextMenu, Field, NamePrompt, TabStrip, TextInput, Toggle, toast, useResize,
  type ConfirmState, type MenuEntry, type NamePromptState,
} from "../shim/ui.js";
import { monaco } from "../shim/monaco.js";
import {
  appendPage, cell, countFor, deleteStatement, editable, editorLanguage, engineEditBlock, explainFor,
  formatSql, insertStatement, isFile, isReadOnly, isSql, lookupFor, statementsFor,
  migrateTabs, nextTabName, prettyJson, previewFor, pushHistory, quoteFor, ROW_CAP, singleTable,
  sortRows, splitStatements, statementAt, textToRun, toCsv, toInserts, toJson, updateStatement,
  type Column, type Connection, type EngineId, type ForeignKeyRef, type HistoryEntry,
  type QueryTab, type Result, type SchemaTable, type Source,
} from "./db";
import { open } from "./sources";
import { Diagram } from "./Diagram";
import { Structure } from "./Structure";

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
   * The query tabs and their SQL, so a query survives leaving the tab.
   *
   * One set for every connection rather than one each: the common case is looking at one
   * database, and scratchpads that empty themselves when you glance at another would be worse
   * than ones that do not. A config from before tabs has a single `sql` instead, which
   * `migrateTabs` turns into the first tab.
   */
  tabs: QueryTab[];
  activeTab: string;
  /** Queries saved by name, each with the connection it was saved against. */
  queries: SavedQuery[];
  /** Queries that have run, newest first, across all connections. Filtered on display. */
  history: HistoryEntry[];
}

interface SavedQuery {
  id: string;
  /** The connection it belongs to: a query is written against one database's tables. */
  connId: string;
  name: string;
  sql: string;
}

const DEFAULTS: Saved = { connections: [], lastId: "", ...migrateTabs({}), queries: [], history: [] };

/** One tab's last run: what the results pane shows when the tab is opened again. */
interface TabRun {
  results: Result[];
  error: string;
  took: number | null;
  /** The table the results came from, which is what an edit writes to. */
  ranTable: string | null;
  /** The statement behind each result, which Load more runs again for the next page. */
  statements: string[];
}
const NO_RUN: TabRun = { results: [], error: "", took: null, ranTable: null, statements: [] };

/**
 * Each tab's last run, by connection and tab, for as long as the plugin is loaded.
 *
 * At module scope because the component unmounts whenever Deck shows another tab, and coming back
 * to an empty grid would mean running every query again. Kept per connection so a tab opened
 * against another database never shows rows from this one. Not saved: rows are the database's to
 * keep, not the config's.
 */
const lastRuns = new Map<string, TabRun>();

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
  // another open file, or another pair of pools on
  // someone else's server.
  const srcRef = useRef<Source | null>(null);
  useEffect(() => () => { void srcRef.current?.close(); srcRef.current = null; }, []);

  // The config as last read or written, so a save that changes nothing writes nothing. Every
  // config write wakes every config listener in Deck, and this one is saved on each tab switch,
  // each run and each unmount, most of which change nothing on disk.
  const written = useRef("");

  const save = useCallback(async (next: Saved) => {
    // The ref is updated HERE rather than only on the next render: adding a connection saves and
    // then immediately connects, and connect reads cfgRef — which would otherwise still hold the
    // config from before the save and write the new connection back out of existence.
    cfgRef.current = next;
    setCfg(next);
    const text = JSON.stringify(next);
    if (text === written.current) return;
    written.current = text;
    await configWrite(CFG, text).catch((e) => {
      // Forgotten, so the next save tries again rather than taking the failed one as on disk.
      written.current = "";
      console.warn("[db] connections save failed", e);
    });
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
      // The old single buffer, `sql`, is taken out and handed to migrateTabs, which makes it the
      // first tab when there are no tabs yet. It stays on disk until the next real change is
      // written, so a config this version only read is never rewritten without it.
      const { sql, ...raw } = t.trim() ? JSON.parse(t) : {};
      const saved: Saved = { ...DEFAULTS, ...raw, ...migrateTabs({ ...raw, sql }) };
      cfgRef.current = saved;
      written.current = JSON.stringify(saved);
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
      initialTabs={cfg.tabs} initialTab={cfg.activeTab} queries={cfg.queries} history={cfg.history}
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

/**
 * The engines the form offers. `ext` is the file picker's filter for a file engine; `port` is the
 * server's usual one, the default for an SSH tunnel's far end; `ask` is what the editor takes,
 * said in the empty results pane.
 */
// `later`: written for, but not yet offered. Their drivers are moving out of Deck into a helper the
// plugin downloads on first use, so until that exists Deck cannot open them; the rest of the plugin
// already handles them, and a connection saved to one still shows by its name.
const ENGINES: { id: EngineId; label: string; hint: string; ext?: string; port?: number; ask: string; later?: boolean }[] = [
  { id: "sqlite", label: "SQLite", hint: "A .db, .sqlite or .sqlite3 file", ext: "db", ask: "write a query above" },
  { id: "postgres", label: "Postgres", hint: "postgres://user:password@host:5432/database", port: 5432, ask: "write a query above" },
  { id: "mysql", label: "MySQL", hint: "mysql://user:password@host:3306/database", port: 3306, ask: "write a query above" },
  {
    id: "mssql", label: "SQL Server", port: 1433, ask: "write a query above", later: true,
    hint: "mssql://user:password@host:1433/database?trustServerCertificate=true",
  },
  { id: "redis", label: "Redis", hint: "redis://host:6379/0", port: 6379, later: true, ask: "type a command above, such as GET user:1 or HGETALL user:1" },
  {
    id: "mongo", label: "MongoDB", hint: "mongodb://user:password@host:27017/database", port: 27017, later: true,
    ask: `type a command above as JSON, such as {"find": "users", "filter": {}}`,
  },
];
const engineLabel = (e: EngineId) => ENGINES.find((x) => x.id === e)?.label ?? e;

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
    const p = await pickFile(engine.ext ?? "db").catch((e) => { console.warn("[db] file picker failed", e); return ""; });
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
                  style={{ background: isFile(c.engine) ? "var(--text-muted)" : "rgb(var(--tone-sky-400))" }} />
              )}
              <button onClick={() => { setPending(c.id); onConnect(c); }} disabled={busy}
                className="min-w-0 flex-1 text-left disabled:opacity-50">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[12.5px] font-medium text-text-primary">{c.name}</span>
                  <span className={chipCls + " text-text-secondary"} style={{ background: "var(--bg-elev)" }}>
                    {engineLabel(c.engine)}
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
          <div className="mb-3 inline-flex flex-wrap items-center gap-0.5 rounded-lg border border-subtle bg-elev p-0.5">
            {ENGINES.filter((e) => !e.later).map((e) => (
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
            <Field label={isFile(draft.engine) ? "Database file" : "Connection url"}
              hint={engine.hint}>
              <div className="flex gap-2">
                <TextInput value={draft.target}
                  onChange={(ev) => setDraft({ ...draft, target: ev.target.value })}
                  onKeyDown={(ev) => { if (ev.key === "Enter") commit(); }}
                  placeholder={engine.hint} />
                {isFile(draft.engine) && (
                  <button onClick={browse}
                    className="flex shrink-0 items-center gap-1.5 rounded-lg border border-subtle bg-elev px-3 text-[12.5px] text-text-secondary transition-colors hover:border-strong hover:text-text-primary">
                    <FolderOpen size={14} /> Browse
                  </button>
                )}
              </div>
            </Field>
          </div>

          {!isFile(draft.engine) && (
            <div className="mt-3 rounded-lg border border-subtle p-3">
              <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-text-secondary">
                <input type="checkbox" checked={!!draft.sshHost}
                  onChange={(ev) => setDraft({
                    ...draft,
                    sshHost: ev.target.checked ? "vps" : "",
                    sshRemote: ev.target.checked ? (draft.sshRemote || `localhost:${engine.port ?? 5432}`) : "",
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
                    hint={`host:port as seen FROM the SSH host: a container address, or localhost:${engine.port ?? 5432}.`}>
                    <TextInput value={draft.sshRemote ?? ""}
                      onChange={(ev) => setDraft({ ...draft, sshRemote: ev.target.value })}
                      placeholder={`localhost:${engine.port ?? 5432}`} />
                  </Field>
                  <p className="text-[11.5px] text-text-muted">
                    Write the url below as if you were on that host; Deck points it at the tunnel.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* A file is opened in place: with writes allowed they land in it, while whatever else
              has it open goes on assuming it is the only writer. Said here, before connecting. */}
          {isFile(draft.engine) && (
            <p className="mt-2 text-[11.5px] leading-relaxed text-text-muted">
              Deck opens the file itself, not a copy. With writes allowed they are saved to it, so
              be careful with a database another app has open, such as a wallet or a sync client:
              close that app first, or keep this connection read-only.
            </p>
          )}
          {!isFile(draft.engine) && (
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
            <span>Open a SQLite file, or connect to Postgres or MySQL, to browse what it holds and run queries. A connection is read-only until you allow writes.</span>
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
  if (isFile(c.engine)) return c.target ? fileName(c.target) : "database.db";
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
  source, conn, schema, fks, initialTabs, initialTab, queries, history,
  onToggleWrites, onPersist, onReopen, onClose, busy,
}: {
  source: Source; conn: Connection; schema: SchemaTable[]; fks: ForeignKeyRef[];
  initialTabs: QueryTab[]; initialTab: string; queries: SavedQuery[]; history: HistoryEntry[];
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
  const [ran, setRan] = useState(0);
  // Where the history and saved-queries menus open, under their buttons; null while closed.
  const [historyAt, setHistoryAt] = useState<{ x: number; y: number } | null>(null);
  const [savedAt, setSavedAt] = useState<{ x: number; y: number } | null>(null);
  const [prompt, setPrompt] = useState<NamePromptState | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  // The tabs, with refs beside them for the callbacks that outlive a render (the unmount save,
  // a run that finishes after a switch). The active tab's SQL in `tabs` is only as fresh as the
  // last switch: the live text is `sql.current`, and `tabsNow()` folds it back in.
  const [tabs, setTabs] = useState(initialTabs);
  const [activeTab, setActiveTab] = useState(initialTab);
  const tabsRef = useRef(tabs);
  const activeRef = useRef(activeTab);
  const tabsNow = () => tabsRef.current.map((t) => (t.id === activeRef.current ? { ...t, sql: sql.current } : t));
  const queriesRef = useRef(queries);
  queriesRef.current = queries;

  // The open tab's last run. Written through setRun, which keeps it in `lastRuns` so it outlives
  // this component, and re-renders.
  const [, rerender] = useState(0);
  const runKey = (tab: string) => `${conn.id}\n${tab}`;
  const setRun = (tab: string, patch: Partial<TabRun>) => {
    lastRuns.set(runKey(tab), { ...(lastRuns.get(runKey(tab)) ?? NO_RUN), ...patch });
    rerender((n) => n + 1);
  };
  const { results, error, took, ranTable } = lastRuns.get(runKey(activeTab)) ?? NO_RUN;
  /**
   * When the statement in flight started, or null when nothing is running.
   *
   * A local file answers in milliseconds and needs no spinner; a server over an ssh tunnel takes
   * long enough that a grid sitting there is indistinguishable from one that has hung. The START
   * TIME rather than a boolean, so the elapsed seconds can be shown — past a second or two,
   * "still working, 3.4s" is the thing worth saying and a bare spinner does not say it.
   */
  const [running, setRunning] = useState<number | null>(null);
  // The query and its results, the whole schema as a diagram, or one table's structure.
  const [view, setView] = useState<"query" | "diagram" | { structure: string }>("query");
  // The editor owns the text; this mirrors it so the run button and Ctrl+Enter see the same SQL.
  const sql = useRef(initialTabs.find((t) => t.id === initialTab)?.sql ?? "");
  // The editor itself, for Format and Explain, which act on its selection and cursor.
  const edRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  // What the editor would run right now — the selection if there is one. Set by the Editor, read
  // here, so this component never has to reach into Monaco.
  const selectedSql = useRef("");
  // Mirrored into state ONLY as a flag: the button has to enable and disable, and a ref cannot
  // trigger that. Storing the boolean rather than the text keeps the re-render to cursor moves
  // that actually cross the has-selection boundary.
  const [hasSelection, setHasSelection] = useState(false);

  // Save the editor text when leaving the tab. On unmount rather than per keystroke: a config
  // write per character would be absurd, and this is the only moment the text can be lost.
  useEffect(() => () => onPersist({ tabs: tabsNow(), activeTab: activeRef.current }), []); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Make `next` the tab list and `active` the open tab, and save both.
   *
   * The one path for switching, adding, closing, renaming and reordering. Opening a different tab
   * loads its SQL into the editor through the same `revision` signal a table click uses.
   */
  const commitTabs = (next: QueryTab[], active: string, extra?: Partial<Saved>) => {
    const switched = active !== activeRef.current;
    tabsRef.current = next;
    activeRef.current = active;
    setTabs(next);
    setActiveTab(active);
    if (switched) {
      sql.current = next.find((t) => t.id === active)?.sql ?? "";
      selectedSql.current = "";
      setHasSelection(false);
      setRan((n) => n + 1);
    }
    onPersist({ tabs: next, activeTab: active, ...extra });
  };
  const addTab = (name?: string, text = "") => {
    const t = { id: `q${Date.now().toString(36)}`, name: name ?? nextTabName(tabsRef.current), sql: text };
    commitTabs([...tabsNow(), t], t.id);
  };
  const closeTab = (id: string) => {
    const list = tabsNow();
    const at = list.findIndex((t) => t.id === id);
    let rest = list.filter((t) => t.id !== id);
    // The last tab closing leaves a fresh empty one: the editor always has a tab to belong to.
    if (!rest.length) rest = [{ id: `q${Date.now().toString(36)}`, name: nextTabName([]), sql: "" }];
    lastRuns.delete(runKey(id));
    commitTabs(rest, id === activeRef.current ? rest[Math.min(at, rest.length - 1)].id : activeRef.current);
  };

  /** Save the open tab's SQL under a name, for this connection. The same name replaces. */
  const saveQuery = () => {
    const tab = tabsRef.current.find((t) => t.id === activeRef.current);
    setPrompt({
      title: "Save query",
      subtitle: `Kept with ${conn.name}, under Saved.`,
      initial: tab?.name ?? "",
      placeholder: "Query name",
      onSave: (raw) => {
        const name = raw.trim();
        if (!name) return;
        const q: SavedQuery = { id: `s${Date.now().toString(36)}`, connId: conn.id, name, sql: sql.current };
        // The tab takes the name too, so it reads as the saved query it now is.
        commitTabs(tabsNow().map((t) => (t.id === activeRef.current ? { ...t, name } : t)), activeRef.current, {
          queries: [...queriesRef.current.filter((x) => !(x.connId === conn.id && x.name === name)), q],
        });
        toast("Saved");
      },
    });
  };
  const savedHere = queries.filter((q) => q.connId === conn.id);
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
    const statements = statementsFor(engine, text);
    if (!statements.length) return;
    // The tab this run belongs to, captured now: its results land there even if another tab is
    // open by the time a slow server answers.
    const tab = activeRef.current;
    // The SQL allowlist only judges SQL. A Redis or MongoDB command goes to Rust, whose list of
    // read commands refuses a write on a read-only connection with the reason.
    const blocked = isSql(engine) ? statements.filter((s) => !isReadOnly(s)) : [];
    if (blocked.length && !allowWrites) {
      setRun(tab, { results: [], error:
        `Blocked ${blocked.length} statement${blocked.length > 1 ? "s" : ""} that would modify `
        + `the database. Turn on "Allow writes" for this connection to run them — `
        // What a write actually reaches, said plainly: the file itself, or the server. Either way
        // it is permanent.
        + (isFile(engine)
          ? "they are saved to the file itself, so take care if another app has it open."
          : "on a server they are permanent.")
        + `\n\n${blocked.join(";\n")}`,
      });
      return;
    }
    const started = Date.now();
    setRunning(started);
    // Which table these rows came from, decided by the SQL that is about to run. The sidebar
    // selection cannot answer it: a typed query sets no selection, and an old one would name a
    // table the user is not looking at — which would send an edit to the wrong place.
    setRun(tab, {
      error: "",
      ranTable: isSql(engine) && statements.length === 1 ? singleTable(statements[0]) : null,
      statements,
    });
    const out: Result[] = [];
    try {
      // Each statement in turn, so a failure reports which one and keeps what ran before it.
      // One at a time also matters for the servers: Postgres refuses several per round trip.
      for (const s of statements) out.push(await source.run(s, allowWrites));
      setRun(tab, { results: out, took: Date.now() - started });
      // Recorded only once it RAN. A query that was blocked or threw is not one to offer back.
      onPersist({
        tabs: tabsNow(),
        activeTab: activeRef.current,
        history: pushHistory(historyRef.current, text, conn.id, Date.now()),
      });
    } catch (e) {
      setRun(tab, { results: out, error: String(e) });
    }
    setRunning(null);
    setRan((n) => n + 1);
    // setRun and tabsNow read only refs and the connection, which are already listed.
  }, [source, allowWrites, conn.id, onPersist]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Apply one editing statement, then reload the grid.
   *
   * Re-running the last query rather than patching the row in place: a trigger, a default or a
   * computed column can make the stored value differ from what was typed, and a grid that shows
   * the typed value instead of the stored one is lying about the database.
   */
  const applyEdit = useCallback(async (statement: string) => {
    if (!allowWrites) {
      setRun(activeRef.current, { error: "Turn on \"Allow writes\" for this connection to change data." });
      return;
    }
    setRunning(Date.now());
    try {
      await source.run(statement, true);
      toast("Applied");
      await runText(sql.current);
    } catch (e) {
      setRun(activeRef.current, { error: `${statement}

${String(e)}` });
    }
    setRunning(null);
  }, [source, allowWrites, runText]); // eslint-disable-line react-hooks/exhaustive-deps

  const execute = useCallback(() => { void runText(); }, [runText]);
  const runAll = useCallback(() => { void runText(sql.current); }, [runText]);

  /**
   * The plan for what the user means: the selection, or else the statement the cursor is in.
   *
   * Run through runText like any query, so the plan shows as an ordinary result, lands in the
   * history and goes past the same read-only guard (an EXPLAIN is a read, and plain EXPLAIN does
   * not execute the statement it plans).
   */
  const explain = () => {
    const ed = edRef.current;
    const pos = ed?.getPosition();
    const offset = pos ? (ed?.getModel()?.getOffsetAt(pos) ?? 0) : 0;
    const text = selectedSql.current.trim() ? selectedSql.current : statementAt(sql.current, offset);
    const plans = splitStatements(text).map((s) => explainFor(engine, s));
    if (plans.length && plans.every((p) => p !== null)) void runText(plans.join(";\n"));
  };

  /**
   * The next page of result `i`, appended to it.
   *
   * The statement is run again past the rows already shown, and ALWAYS read-only: a page is only
   * ever more rows to look at, so loading one can never repeat a write the first run made.
   */
  const loadMore = async (i: number) => {
    const tab = activeRef.current;
    const was = lastRuns.get(runKey(tab)) ?? NO_RUN;
    const r = was.results[i];
    const statement = was.statements[i];
    if (!r || !statement) return;
    setRunning(Date.now());
    try {
      const next = await source.run(statement, false, r.rows.length);
      const now = lastRuns.get(runKey(tab)) ?? NO_RUN;
      // Run again meanwhile: this page belongs to rows no longer on screen.
      if (now.results[i] === r) {
        setRun(tab, { results: now.results.map((x, j) => (j === i ? appendPage(x, next) : x)) });
      }
    } catch (e) {
      setRun(tab, { error: `Could not load more rows: ${String(e)}` });
    }
    setRunning(null);
  };

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
  const canExplain = explainFor(engine, "select 1") !== null;
  // The table whose structure is open, if that is the view. Gone after a reload that dropped it.
  const structureOf = typeof view === "object" ? schema.find((t) => t.name === view.structure) : undefined;
  const showStructure = (name: string) => { setSelected(name); setView({ structure: name }); };

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
      {/* With a structure open, a table click shows that table's structure: the view stays the
          one the user chose. The menu's queries go to the editor, where they can be seen. */}
      <Schema source={source} tables={schema} selected={selected} conn={conn}
        onPick={(name) => (typeof view === "object" ? showStructure(name) : pick(name))}
        onQuery={(text, andRun) => { setView("query"); setEditorText(text, andRun); }} engine={engine}
        onStructure={showStructure}
        width={sidebarWidth} dragProps={sidebarDrag} />

      {/* Opaque only on this side: a data grid over the wallpaper is unreadable in a way a list
          of table names is not, and it gives the sticky column headers (`bg-app/95`) something
          real to be opaque against. The schema pane keeps Deck's glass. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-app">
        {/* One row: which database, the query tabs, then what may be done to it. A tab picked
            from the diagram or a structure goes back to the query. */}
        <TabStrip chip
          tabs={tabs.map((t) => ({ id: t.id, title: t.name }))}
          activeId={activeTab}
          onSelect={(id) => { setView("query"); if (id !== activeRef.current) commitTabs(tabsNow(), id); }}
          onClose={closeTab}
          onDoubleClick={(id) => setPrompt({
            title: "Rename tab",
            initial: tabsRef.current.find((t) => t.id === id)?.name ?? "",
            confirmLabel: "Rename",
            onSave: (raw) => {
              const name = raw.trim();
              if (name) commitTabs(tabsNow().map((t) => (t.id === id ? { ...t, name } : t)), activeRef.current);
            },
          })}
          onReorder={(from, to) => {
            const list = tabsNow();
            const moving = list.find((t) => t.id === from);
            if (!moving) return;
            const next = list.filter((t) => t.id !== from);
            next.splice(list.findIndex((t) => t.id === to), 0, moving);
            commitTabs(next, activeRef.current);
          }}
          onAdd={() => addTab()} addTitle="New query tab"
          trailing={<>
            <button onClick={saveQuery} title="Save this tab's SQL under a name, for this database"
              className={smallBtn}>
              <BookmarkPlus size={11} /> Save query
            </button>
            <button disabled={savedHere.length === 0} aria-haspopup="menu" aria-expanded={!!savedAt}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setSavedAt((at) => (at ? null : { x: r.right, y: r.bottom + 4 }));
              }}
              title={savedHere.length ? "Queries saved for this database" : "No saved queries for this database yet"}
              className={smallBtn}
              style={savedAt ? { background: "var(--accent-soft)", color: "var(--text-primary)" } : undefined}>
              <Bookmark size={11} /> Saved{savedHere.length ? ` (${savedHere.length})` : ""}
            </button>
          {/* The query and its results, or the whole schema drawn as a diagram. */}
          <div className="ml-1 flex shrink-0 items-center gap-0.5 rounded-lg border border-subtle bg-elev p-0.5">
            {([["query", "Query", Code2], ["diagram", "Diagram", Network]] as const).map(([id, label, Icon]) => (
              <button key={id} onClick={() => setView(id)} aria-pressed={view === id}
                className={"flex h-6 items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors " + (view === id ? "text-text-primary" : "text-text-muted hover:text-text-primary")}
                style={view === id ? { background: "var(--accent-soft)", boxShadow: "inset 0 0 0 1px var(--accent)" } : undefined}>
                <Icon size={12} />{label}
              </button>
            ))}
          </div>

          <label className="ml-2 flex shrink-0 cursor-pointer items-center gap-2 text-[12px] text-text-secondary"
            title={isFile(engine)
              ? "Writes are saved to the file itself. Off means the file is opened read-only. Take care with a file another app has open, such as a wallet or a sync client."
              : "Writes reach the real database. Off means the server itself refuses them."}>
            Allow writes
            <Toggle on={allowWrites} onChange={onToggleWrites} />
          </label>

          <button onClick={onReopen} disabled={busy}
            title={isFile(engine) ? "Reload the file from disk" : "Reconnect and read the schema again"} className={toolBtn}>
            <RefreshCw size={12} className={busy ? "animate-spin" : ""} /> Reload
          </button>
          <button onClick={onClose} title="Close this database"
            className="grid size-7 shrink-0 place-items-center rounded-lg text-text-muted transition-colors hover:bg-white/5 hover:text-text-primary">
            <X size={14} />
          </button>
          </>} />
        {savedAt && savedHere.length > 0 && (
          <ContextMenu x={savedAt.x} y={savedAt.y} alignRight onClose={() => setSavedAt(null)}
            items={savedHere.map((q) => ({
              label: q.name,
              subLabel: q.sql.replace(/\s+/g, " ").slice(0, 120),
              icon: Bookmark,
              // A new tab rather than the open one: opening a saved query must not overwrite
              // whatever is being written in the current tab.
              onClick: () => addTab(q.name, q.sql),
              action: {
                icon: Trash2, title: "Delete", danger: true,
                onClick: () => setConfirm({
                  title: `Delete ${q.name}?`,
                  body: "The saved query goes. Tabs already opened from it keep their SQL.",
                  confirmLabel: "Delete",
                  onConfirm: () => onPersist({ queries: queriesRef.current.filter((x) => x.id !== q.id) }),
                }),
              },
            }))} />
        )}
        {view === "diagram" && (
          <div className="m-2 mt-1.5 flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-subtle bg-card">
            <Diagram tables={schema} fks={fks} layoutKey={conn.id} onOpen={(name) => { setView("query"); pick(name); }} />
          </div>
        )}
        {structureOf && (
          <Structure source={source} engine={engine} table={structureOf} fks={fks}
            onOpen={showStructure}
            onRows={() => { setView("query"); pick(structureOf.name); }} />
        )}
        {typeof view === "object" && !structureOf && (
          <p className="m-auto p-8 text-center text-[12.5px] text-text-muted">
            {view.structure} is no longer in this database.
          </p>
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

          {/* SQL only: a Redis command line or a MongoDB command has no plan to ask for and no SQL
              to lay out. SQL Server is SQL with no EXPLAIN, so the button stays and says so. */}
          {isSql(engine) && <>
            <button onClick={explain} disabled={running !== null || !canExplain}
              title={!canExplain
                ? "SQL Server has no EXPLAIN statement; its plans need SET SHOWPLAN, which Deck does not run"
                : isFile(engine)
                  ? "Show the query plan for the selection, or the statement the cursor is in"
                  : "Show the server's plan for the selection, or the statement the cursor is in, without running it"}
              className={toolBtn}>
              <ListTree size={12} /> Explain
            </button>
            <button onClick={() => { if (edRef.current) formatIn(edRef.current, engine); }}
              title="Format the selection, or all of it (Shift+Alt+F)" className={toolBtn}>
              <WandSparkles size={12} /> Format
            </button>
          </>}

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
          revision={ran} height={editorHeight} cols={cols} engine={engine} edRef={edRef} />
        </div>

        {/* The split between the query and its results: a slim bar with room to grab it, lit in
            the accent while the pointer is on it. */}
        <div {...dragProps} title="Drag to resize"
          className="mx-auto my-[3px] h-1 w-16 shrink-0 cursor-row-resize rounded-full bg-white/10 transition-colors hover:bg-[var(--accent)]" />

        <div className="mx-2 mb-2 flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-subtle bg-card">
          <Results results={results} error={error} table={selected} fks={fks} onFollow={follow}
            running={running} took={took} tabKey={activeTab} onMore={(i) => void loadMore(i)}
            engine={engine} allowWrites={allowWrites} editTable={ranTable}
            tableColumns={ranTable ? (cols.get(ranTable) ?? []) : []}
            onEdit={(st) => void applyEdit(st)} />
        </div>
        </>}
      </div>
      <NamePrompt state={prompt} onClose={() => setPrompt(null)} />
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

/**
 * Format the editor's selection, or all of it when nothing is selected.
 *
 * As an edit rather than setValue, so Ctrl+Z puts the old layout back. SQL the formatter cannot
 * parse is left exactly as it was, with the reason in a toast.
 */
function formatIn(ed: monaco.editor.IStandaloneCodeEditor, engine: EngineId) {
  const model = ed.getModel();
  if (!model) return;
  const sel = ed.getSelection();
  const range = sel && !sel.isEmpty() ? sel : model.getFullModelRange();
  const text = model.getValueInRange(range);
  if (!text.trim()) return;
  let formatted: string;
  try {
    formatted = formatSql(engine, text);
  } catch (e) {
    toast(`Could not format: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  if (formatted === text) return;
  ed.pushUndoStop();
  ed.executeEdits("db-format", [{ range, text: formatted }]);
  ed.pushUndoStop();
}

/** Tables and views; clicking one expands its columns and previews it. */
function Schema({
  source, tables: list, selected, onPick, onQuery, onStructure, engine, width, dragProps, conn,
}: {
  source: Source; tables: SchemaTable[];
  /** The open connection, named at the top of the sidebar. */
  conn: Connection;
  selected: string | null;
  onPick: (name: string) => void;
  /** Put SQL in the editor. `run` false leaves it for the user to edit before running. */
  onQuery: (sql: string, run: boolean) => void;
  /** Open a table's Structure view. */
  onStructure: (name: string) => void;
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
    // A Redis key group has no count to ask for: how many keys it holds is already its columns.
    if (t.kind === "table" && countFor(engine, t.name) && !counts.has(t.name)) {
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
  // What a "table" is called here: Redis groups keys by pattern, MongoDB holds collections.
  const noun = engine === "redis" ? "key group" : engine === "mongo" ? "collection" : "table";

  return (
    <>
      <div className="flex shrink-0 flex-col overflow-hidden border-r border-subtle bg-panel/80 backdrop-blur-xl blur-surface"
        style={{ width }}>
        <div className="shrink-0 px-2 pb-1.5 pt-2">
          {/* Which database this is; its address is in the tooltip. */}
          <div className="mb-1 flex min-w-0 items-center gap-2 px-1" title={redact(conn.target)}>
            <DatabaseIcon size={14} className="shrink-0 text-text-muted" />
            <span className="min-w-0 truncate text-[13px] font-semibold text-text-primary">{conn.name}</span>
            <span className={chipCls + " ml-auto text-text-secondary"} style={{ background: "var(--bg-elev)" }}>
              {ENGINES.find((e) => e.id === engine)?.label ?? engine}
            </span>
          </div>
          <div className="mb-1.5 flex items-baseline gap-1.5 px-1 text-[11.5px] text-text-muted">
            <span>
              {tableCount} {noun}{tableCount === 1 ? "" : "s"}
            </span>
            {viewCount > 0 && <span>{"·"} {viewCount} view{viewCount === 1 ? "" : "s"}</span>}
          </div>
          {/* Worth its space once a schema is more than a screenful, which is most of them. */}
          <div className="flex h-7 items-center gap-1.5 rounded-lg border border-subtle bg-elev pl-2 pr-1 transition-colors focus-within:border-[var(--accent)]">
            <Search size={12} className="shrink-0 text-text-muted" />
            <input value={filter} onChange={(e) => setFilter(e.target.value)}
              placeholder={isSql(engine) ? "Filter tables and columns" : `Filter ${noun}s and fields`}
              className="min-w-0 flex-1 bg-transparent text-[12px] text-text-primary outline-none placeholder:text-text-muted" />
            {filter && (
              <button onClick={() => setFilter("")} title="Clear the filter" className={iconBtn}><X size={12} /></button>
            )}
          </div>
        </div>

        <div className="scroll-thin min-h-0 flex-1 overflow-auto px-1.5 pb-2">
          {shown.length === 0 && (list.length === 0
            ? <p className="px-1.5 py-3 text-[12px] text-text-muted">{isSql(engine) ? "This database has no tables or views yet." : `This database has no ${noun}s yet.`}</p>
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
                    <button onClick={() => onStructure(t.name)}
                      className="mt-1 flex items-center gap-1 text-[10px] text-text-muted transition-colors hover:text-text-secondary">
                      <TableProperties size={9} />Structure
                    </button>
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
          items={tableMenu(engine, menu.table, onQuery, () => setFilter(menu.table.name), onStructure)} />
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
  onStructure: (name: string) => void,
): MenuEntry[] {
  const q = (name: string) => quoteFor(engine, name);
  const cols = t.columns.map((c) => q(c.name)).join(", ");
  const pk = t.columns.find((c) => c.pk);

  const items: MenuEntry[] = [
    {
      // Opens a view rather than writing SQL: its columns, keys, indexes and DDL, read-only.
      label: "Show structure",
      icon: TableProperties,
      onClick: () => onStructure(t.name),
    },
    {
      label: "Select all rows",
      icon: Table2,
      onClick: () => onQuery(previewFor(engine, t.name), true),
    },
  ];
  const count = countFor(engine, t.name);
  if (count) {
    items.push({
      label: "Count rows",
      icon: Hash,
      onClick: () => onQuery(isSql(engine) ? `${count};` : count, true),
    });
  }
  // The rest writes SQL, which a Redis key group or a MongoDB collection has no use for.
  if (!isSql(engine)) {
    items.push("sep");
    items.push({ label: "Filter the list by this name", icon: Search, onClick: filterByName });
    items.push({
      label: "Copy name",
      icon: Copy,
      onClick: () => void navigator.clipboard.writeText(t.name).catch(() => {}),
    });
    return items;
  }
  items.push({
    // Named columns rather than *, which is what anyone writes a real query from.
    label: "Select columns…",
    subLabel: `${t.columns.length} column${t.columns.length === 1 ? "" : "s"}`,
    icon: Columns3,
    onClick: () => onQuery(engine === "mssql"
      ? `select top 200 ${cols}\nfrom ${q(t.name)};`
      : `select ${cols}\nfrom ${q(t.name)}\nlimit 200;`, false),
  });

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
function Editor({ value, onChange, onRun, onSelect, revision, height, cols, engine, edRef }: {
  value: () => string; onChange: (v: string) => void; onRun: () => void;
  onSelect: (v: string) => void; revision: number; height: number;
  cols: Map<string, Column[]>;
  /** Which dialect Format lays the SQL out in. */
  engine: EngineId;
  /** Given the live editor, for the toolbar's Format and Explain. */
  edRef: React.MutableRefObject<monaco.editor.IStandaloneCodeEditor | null>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = edRef;
  const engineRef = useRef(engine);
  engineRef.current = engine;
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
      // JSON for a MongoDB command, plain text for a Redis command line: SQL colouring on either
      // would mark ordinary words as keywords.
      language: editorLanguage(engine),
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
    // An action of this editor rather than a formatting provider: a provider is registered on
    // Deck's shared Monaco for every SQL model, where it would compete with whatever formats the
    // Editor module's .sql files. Its keybinding is Monaco's own Format Document chord, and it
    // takes precedence in this editor only.
    // SQL only, like the toolbar's Format: a Redis or MongoDB command has no SQL to lay out.
    if (isSql(engineRef.current)) ed.addAction({
      id: "deck-db.format",
      label: "Format SQL",
      keybindings: [monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF],
      contextMenuGroupId: "1_modification",
      run: () => formatIn(ed, engineRef.current),
    });

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

/** Copy text, and say so. A failure is said too: a silent no-op reads as copied. */
function copyText(text: string, done: string) {
  void navigator.clipboard.writeText(text)
    .then(() => toast(done))
    .catch((e) => { console.warn("[db] copy failed", e); toast(`Could not copy: ${String(e)}`); });
}

/** The text a copied cell gives: what the grid shows, except that NULL is nothing at all. */
const cellText = (v: unknown) => (v === null || v === undefined ? "" : cell(v).text);

/** The cell the value panel shows: which grid it is in, and what it holds. */
interface Viewed { grid: number; column: string; type: string; value: unknown }

/** One grid per statement, plus whatever went wrong, and the value panel beside them. */
function Results({
  results, error, table, fks, onFollow, engine, allowWrites, editTable, tableColumns, onEdit,
  running, took, tabKey, onMore,
}: {
  results: Result[]; error: string; table: string | null; running: number | null;
  /** How long the last run took, in ms. */
  took: number | null;
  fks: ForeignKeyRef[]; onFollow: (fk: ForeignKeyRef, value: unknown) => void;
  engine: EngineId; allowWrites: boolean; editTable: string | null; tableColumns: Column[];
  onEdit: (statement: string) => void;
  /** The query tab these results belong to: another tab's results are other grids. */
  tabKey: string;
  /** Load the next page of result `i`. */
  onMore: (i: number) => void;
}) {
  const download = async (r: Result, kind: "csv" | "json") => {
    // The rows EXPORTED are the rows on screen, which is what the cap makes them. Writing the
    // full result instead would silently disagree with the count shown above the grid.
    const path = await pickSavePath(`query.${kind}`, kind).catch((e) => { console.warn("[db] save dialog failed", e); return ""; });
    if (!path) return;
    try {
      await fsWrite(path, kind === "csv" ? toCsv(r) : toJson(r));
      toast(`Exported ${r.rows.length.toLocaleString()} rows${r.truncated ? " (the rows on screen)" : ""}`);
    } catch (e) {
      toast(`Could not write the file: ${String(e)}`);
    }
  };

  // The value panel: open or not, and the cell it shows. One for every grid, since it sits beside
  // them all; a grid reports its picked cell here, and again when its rows change under it.
  const [panel, setPanel] = useState(false);
  const [viewed, setViewed] = useState<Viewed | null>(null);
  useEffect(() => setViewed(null), [tabKey]);
  const [panelWidth, panelDrag] = useResize({
    initial: 320, min: 200, max: 720, direction: "horizontal", invert: true,
  });

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
        {error && (
          <pre className="m-3 whitespace-pre-wrap rounded-lg border border-red-400/40 bg-red-400/5 p-3 text-[12px] text-red-300">
            {error}
          </pre>
        )}
        {/* Keyed by tab as well, so a grid's sort and picked cell stay with the tab they were
            made in, while a re-run in the same tab (after an edit) keeps them. */}
        {results.map((r, i) => <Grid key={`${tabKey}:${i}`} result={r} index={i} many={results.length > 1}
          took={i === results.length - 1 ? took : null}
          fks={table ? fks.filter((f) => f.table === table) : []} onFollow={onFollow}
          engine={engine} table={editTable} allowWrites={allowWrites} tableColumns={tableColumns}
          onEdit={onEdit}
          onSave={(kind) => void download(r, kind)}
          onMore={() => onMore(i)} busy={running !== null}
          viewing={viewed?.grid === i}
          onView={(v) => setViewed(v && { grid: i, ...v })}
          panel={panel} onPanel={setPanel} />)}
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
            <span className="max-w-xs text-[12px] leading-relaxed text-text-muted">
              Pick {engine === "redis" ? "a key group" : engine === "mongo" ? "a collection" : "a table"} on the left,
              or {ENGINES.find((e) => e.id === engine)?.ask ?? "write a query above"} and press Ctrl+Enter.
            </span>
          </div>
        )}
      </div>
      {panel && <>
        <div {...panelDrag} title="Drag to resize"
          className="w-1 shrink-0 cursor-col-resize border-l border-subtle transition-colors hover:border-[var(--accent)]" />
        <ValuePanel viewed={viewed} width={panelWidth} onClose={() => setPanel(false)} />
      </>}
    </div>
  );
}

/**
 * One cell's whole value: long text wrapped, JSON laid out, a NULL said as NULL.
 *
 * The grid truncates every cell to keep rows one line high, which is right for scanning and
 * wrong for reading a description or a JSON column; this is where those are read.
 */
function ValuePanel({ viewed, width, onClose }: {
  viewed: Viewed | null; width: number; onClose: () => void;
}) {
  const v = viewed?.value;
  const json = prettyJson(v);
  const isNull = v === null || v === undefined;
  const shown = json ?? cellText(v);
  return (
    <div className="flex min-h-0 shrink-0 flex-col" style={{ width }}>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-subtle px-3">
        <span className="min-w-0 truncate text-[12px] font-medium text-text-secondary" title={viewed?.column}>
          {viewed ? viewed.column : "Value"}
        </span>
        {viewed?.type && <span className="shrink-0 font-mono text-[10.5px] text-text-muted">{shortType(viewed.type)}</span>}
        {json && <span className={chipCls} style={chip("rgb(var(--tone-sky-400))")}>JSON</span>}
        <span className="ml-auto" />
        {viewed && !isNull && (
          <button onClick={() => copyText(shown, "Copied")} title="Copy the value" className={smallBtn}>
            <Copy size={11} /> Copy
          </button>
        )}
        <button onClick={onClose} title="Close the value panel" className={iconBtn}><X size={13} /></button>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-auto p-3">
        {!viewed ? (
          <p className="text-[12px] leading-relaxed text-text-muted">
            Click a cell to read its whole value here. Space or Enter opens this panel from the grid.
          </p>
        ) : isNull ? (
          <span className="rounded px-1 text-[10px] tracking-wide text-text-muted" style={{ background: "var(--bg-elev)" }}>NULL</span>
        ) : json ? (
          <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-snug text-text-primary">{json}</pre>
        ) : (
          <div className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-text-primary">{shown}</div>
        )}
      </div>
    </div>
  );
}

function Grid({
  result, index, many, took, fks, onFollow, engine, table, allowWrites, tableColumns, onEdit, onSave,
  viewing, onView, panel, onPanel, onMore, busy,
}: {
  result: Result; index: number; many: boolean; took: number | null;
  fks: ForeignKeyRef[]; onFollow: (fk: ForeignKeyRef, value: unknown) => void;
  engine: EngineId; table: string | null; allowWrites: boolean; tableColumns: Column[];
  onEdit: (statement: string) => void;
  /** Save the rows on screen to a file. */
  onSave: (kind: "csv" | "json") => void;
  /** Whether the value panel is showing this grid's picked cell. */
  viewing: boolean;
  onView: (v: Omit<Viewed, "grid"> | null) => void;
  /** Whether the value panel is open, and a way to open or close it. */
  panel: boolean; onPanel: (open: boolean) => void;
  /** Load the next page of these rows; `busy` while something is running. */
  onMore: () => void; busy: boolean;
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
  const blocked = engineEditBlock(engine) ?? (index > 0
    ? "Only the first result is editable."
    : editable(table, result.columns, tableColumns));
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
  // Where the Export menu opens, under its button; null while it is closed.
  const [exportAt, setExportAt] = useState<{ x: number; y: number } | null>(null);

  /** The picked cell, as the value panel shows it, or null when no such cell is on screen. */
  const viewOf = (p: { row: number; col: number } | null) => {
    const row = p ? rows[p.row] : undefined;
    if (!p || !row || p.col >= result.columns.length) return null;
    const column = result.columns[p.col];
    return { column, type: typeOf(column), value: row[p.col] };
  };
  const pick = (p: { row: number; col: number }) => {
    setPicked(p);
    onView(viewOf(p));
  };
  // A re-run after an edit, or a sort, changes what sits at the picked place; the panel follows
  // what the ring is on rather than keeping the value from before.
  const viewRef = useRef(() => {});
  viewRef.current = () => { if (viewing && picked) onView(viewOf(picked)); };
  useEffect(() => viewRef.current(), [result, sort]);

  /**
   * The grid's own keys: Ctrl+C copies the picked cell, Space or Enter opens the value panel.
   *
   * On the grid's element rather than through Deck's key bindings, so they hold only while focus
   * is in the grid (a click on a cell puts it there): Monaco, the filter box and the cell editor
   * keep Ctrl+C, and so does a text selection dragged across the grid.
   */
  const onKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (!picked || editing || target.closest("input, textarea")) return;
    const plain = !e.shiftKey && !e.altKey;
    // By code as well as key, so a non-Latin layout's Ctrl+C still counts, as App.tsx does for Ctrl+P.
    if ((e.ctrlKey || e.metaKey) && plain && (e.code === "KeyC" || e.key.toLowerCase() === "c")) {
      if (String(window.getSelection() ?? "")) return;
      e.preventDefault();
      e.stopPropagation();
      copyText(cellText(rows[picked.row]?.[picked.col]), "Copied");
    } else if ((e.key === " " || e.key === "Enter") && plain && !e.ctrlKey && !e.metaKey
      // A focused foreign-key link keeps Enter and Space for following it.
      && !target.closest("button")) {
      e.preventDefault();
      onView(viewOf(picked));
      onPanel(true);
    }
  };

  const shownRows = `${result.rows.length.toLocaleString()} row${result.rows.length === 1 ? "" : "s"}`;
  const copied = `Copied ${shownRows}${result.truncated ? " (the rows on screen)" : ""}`;
  const exportItems: MenuEntry[] = [
    // Said once at the top rather than on every item: everything below takes the same rows.
    ...(result.truncated ? [{
      label: `The ${result.rows.length.toLocaleString()} rows on screen; Load more for the rest`,
      disabled: true,
    }, "sep" as const] : []),
    { label: "Copy as CSV", icon: Copy, onClick: () => copyText(toCsv(result), copied) },
    { label: "Copy as JSON", icon: Copy, onClick: () => copyText(toJson(result), copied) },
    {
      label: "Copy as INSERT statements",
      icon: Copy,
      // Only with a table to insert into: a join or an expression has no one table to name.
      subLabel: !isSql(engine) ? "SQL only" : table ? `into ${table}` : "Needs a select from one table",
      disabled: !table || !isSql(engine),
      onClick: () => { if (table) copyText(toInserts(engine, table, result), copied); },
    },
    "sep",
    { label: "Save as CSV…", icon: Download, onClick: () => onSave("csv") },
    { label: "Save as JSON…", icon: Download, onClick: () => onSave("json") },
  ];
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
          {/* "N+" while more exist: Deck reads a page at a time, so the full count is not known. */}
          {`${result.rows.length.toLocaleString()}${result.truncated ? "+" : ""} row${result.rows.length === 1 && !result.truncated ? "" : "s"}`}
        </span>
        {result.truncated && <>
          <span className={chipCls} title={`Rows are read ${ROW_CAP.toLocaleString()} at a time, and there are more`}
            style={{ color: "rgb(var(--tone-amber-400))", background: "color-mix(in srgb, rgb(var(--tone-amber-400)) 14%, transparent)" }}>
            Capped at {result.rows.length.toLocaleString()}
          </span>
          <button onClick={onMore} disabled={busy}
            title={`Read the next ${ROW_CAP.toLocaleString()} rows and add them below`} className={smallBtn}>
            <ChevronDown size={11} /> Load more
          </button>
        </>}
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
        <button onClick={() => onPanel(!panel)} aria-pressed={panel}
          title={panel ? "Hide the value panel" : "Show the picked cell's whole value (Space)"}
          className={smallBtn}
          style={panel ? { background: "var(--accent-soft)", color: "var(--text-primary)" } : undefined}>
          <PanelRight size={11} /> Value
        </button>
        <button aria-haspopup="menu" aria-expanded={!!exportAt}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setExportAt((at) => (at ? null : { x: r.right, y: r.bottom + 4 }));
          }}
          title="Copy or save the rows on screen"
          className={smallBtn}
          style={exportAt ? { background: "var(--accent-soft)", color: "var(--text-primary)" } : undefined}>
          <Download size={11} /> Export <ChevronDown size={10} />
        </button>
        {exportAt && (
          <ContextMenu x={exportAt.x} y={exportAt.y} alignRight onClose={() => setExportAt(null)} items={exportItems} />
        )}
      </div>
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />
      {/* Scrolls both axes: a wide table must not push the whole pane sideways, and the sticky
          column headers need their vertical scroll container to be an ancestor — otherwise they
          have nothing to stick to and scroll away with the rows. */}
      <div className="min-h-0 overflow-auto outline-none" tabIndex={0} onKeyDown={onKeyDown}>
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
                      onClick={() => pick({ row: ri, col: ci })}
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
