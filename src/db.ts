// The SQLite browser's logic, with no React and no sql.js import in sight.
//
// Everything here is a pure function of a database handle or of a string, so it can be checked
// by `node plugins/sqlite/sqlite.check.mjs` against a real database. The UI is a thin layer over
// this file — which is the point: a wrong column type or a statement splitter that breaks on a
// semicolon inside a string literal looks entirely plausible on screen.

/** The subset of sql.js this file needs, so nothing here imports sql.js's types. */
export interface Db {
  exec(sql: string): { columns: string[]; values: unknown[][] }[];
  prepare(sql: string): Stmt;
  /** Frees the wasm heap the database occupies. An unclosed handle leaks the whole file. */
  close(): void;
}
interface Stmt {
  step(): boolean;
  getAsObject(): Record<string, unknown>;
  free(): void;
}

/** How many rows a single result will hold before it is truncated. */
export const ROW_CAP = 1000;

export interface Column {
  name: string;
  type: string;
  notNull: boolean;
  pk: boolean;
}

export interface Table {
  name: string;
  /** "table" or "view" — a view is browsable but has no row count worth showing eagerly. */
  kind: "table" | "view";
  sql: string;
}

export interface Result {
  columns: string[];
  rows: unknown[][];
  /** Rows the query actually produced, which is larger than `rows.length` when capped. */
  total: number;
  truncated: boolean;
}

/** Rows from a select, as objects. sql.js hands back columns and values separately. */
function rows(db: Db, sql: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const stmt = db.prepare(sql);
  try {
    while (stmt.step()) out.push(stmt.getAsObject());
  } finally {
    stmt.free();
  }
  return out;
}

/**
 * Every table and view, in the order SQLite lists them.
 *
 * `sqlite_%` and `sqlite_sequence` are SQLite's own bookkeeping. They are hidden rather than
 * shown greyed out: nobody browsing their own schema means to look at them, and the one time
 * they matter (`sqlite_sequence` after a delete) is better served by typing the query.
 */
export function tables(db: Db): Table[] {
  return rows(
    db,
    `select name, type, coalesce(sql, '') as sql from sqlite_master
     where type in ('table','view') and name not like 'sqlite_%'
     order by type, name`,
  ).map((r) => ({
    name: String(r.name),
    kind: r.type === "view" ? "view" : "table",
    sql: String(r.sql),
  }));
}

/**
 * One table's columns.
 *
 * `pragma table_info` rather than parsing the CREATE statement, because the stored SQL is
 * whatever the author typed — a parser for it would be a parser for the whole of SQLite's DDL
 * grammar, and the pragma is the answer SQLite itself computed.
 */
export function columns(db: Db, table: string): Column[] {
  return rows(db, `pragma table_info(${quoteIdent(table)})`).map((r) => ({
    name: String(r.name),
    // A column declared with no type is legal in SQLite and comes back as "".
    type: String(r.type ?? ""),
    notNull: Number(r.notnull) === 1,
    pk: Number(r.pk) > 0,
  }));
}

/** A table's row count. Separate from `tables` so opening a database does not scan every one. */
export function rowCount(db: Db, table: string): number {
  const r = db.exec(`select count(*) from ${quoteIdent(table)}`);
  return Number(r[0]?.values?.[0]?.[0] ?? 0);
}

/**
 * Quote an identifier for interpolation into SQL.
 *
 * Table names come from sqlite_master rather than from the user, so this is not the boundary a
 * parameterised query would be. It is here for the ordinary case instead: a table called `order`
 * or `my table` is a syntax error unquoted, and doubling any embedded quote is what makes the
 * quoting total rather than mostly working.
 */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Split a script into statements, respecting string literals, identifiers and comments.
 *
 * A plain `split(";")` is the obvious version and it is wrong the first time anyone types
 * `where note = 'a;b'`. This walks the text once, tracking which quoting construct it is inside,
 * so a semicolon only ends a statement when it is actually at the top level.
 *
 * It is not a SQL parser and does not try to be — it knows quoting and comments, which is
 * everything that changes what a `;` means. A trailing statement with no semicolon counts.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === "`") {
      // A doubled quote inside a quoted run is an escaped quote, not the end of it.
      i++;
      while (i < sql.length) {
        if (sql[i] === c) {
          if (sql[i + 1] === c) i += 2;
          else { i++; break; }
        } else i++;
      }
    } else if (c === "[") {
      // SQLite accepts MS-style bracket quoting. There is no escape inside it.
      while (i < sql.length && sql[i] !== "]") i++;
      i++;
    } else if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
    } else if (c === ";") {
      out.push(sql.slice(start, i));
      start = i + 1;
      i++;
    } else i++;
  }
  out.push(sql.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * Whether a statement only reads.
 *
 * The allowlist is deliberate: anything this does not recognise is treated as a write, so a
 * statement form nobody thought of fails closed. `explain` and `pragma` are reads in the sense
 * that matters here — though a pragma CAN write (`pragma user_version = 1`), which is why the
 * assignment form is excluded.
 *
 * This is the guard behind the read-only toggle. It runs on each statement of a script, so one
 * `delete` in the middle of five selects still blocks the batch.
 */
export function isReadOnly(sql: string): boolean {
  const s = stripLeading(sql).toLowerCase();
  if (s.startsWith("pragma")) return !/^pragma[^;]*=/.test(s);
  if (s.startsWith("explain")) return true;
  if (s.startsWith("with")) {
    // A CTE is only a read if what it feeds is. `with x as (...) delete from t` is a write.
    return !/\b(insert|update|delete|replace)\b/.test(s);
  }
  return s.startsWith("select") || s.startsWith("values");
}

/** Drop leading comments and whitespace, so `-- note\nselect 1` is recognised as a select. */
function stripLeading(sql: string): string {
  let s = sql.trim();
  for (;;) {
    if (s.startsWith("--")) {
      const nl = s.indexOf("\n");
      if (nl === -1) return "";
      s = s.slice(nl + 1).trim();
    } else if (s.startsWith("/*")) {
      const end = s.indexOf("*/");
      if (end === -1) return "";
      s = s.slice(end + 2).trim();
    } else return s;
  }
}

/**
 * Run one statement and shape the answer for the grid.
 *
 * sql.js returns an empty array for a statement that yields no rows — an `insert`, but equally a
 * `select` that matched nothing. Both are reported as zero rows with no columns, which is honest:
 * the distinction that matters to the reader is the row count, and it is the same either way.
 *
 * Capped at ROW_CAP because `select * from` a large table otherwise builds a million DOM rows and
 * locks the renderer. The full count is reported alongside so the truncation is never silent.
 */
export function run(db: Db, sql: string): Result {
  const res = db.exec(sql);
  const first = res[0];
  if (!first) return { columns: [], rows: [], total: 0, truncated: false };
  const total = first.values.length;
  return {
    columns: first.columns,
    rows: total > ROW_CAP ? first.values.slice(0, ROW_CAP) : first.values,
    total,
    truncated: total > ROW_CAP,
  };
}

/** The default query for a table: enough rows to see the shape, few enough to stay instant. */
export function previewQuery(table: string): string {
  return `select * from ${quoteIdent(table)} limit 200;`;
}

/**
 * Render one cell for display.
 *
 * NULL is rendered as the word rather than as an empty cell, because an empty string and a NULL
 * are different values and a browser that cannot tell them apart is lying about the data. A
 * BLOB arrives as a Uint8Array and is summarised by length: dumping bytes into a table cell
 * helps nobody, and the length is the fact worth seeing.
 */
export function cell(v: unknown): { text: string; kind: "null" | "blob" | "number" | "text" } {
  if (v === null || v === undefined) return { text: "NULL", kind: "null" };
  if (v instanceof Uint8Array) return { text: `BLOB (${v.length} bytes)`, kind: "blob" };
  if (typeof v === "number") return { text: String(v), kind: "number" };
  return { text: String(v), kind: "text" };
}

/** A result as CSV, for the export button. Quotes only what needs it, per RFC 4180. */
export function toCsv(result: Result): string {
  const esc = (v: unknown) => {
    const { text } = cell(v);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [result.columns.join(","), ...result.rows.map((r) => r.map(esc).join(","))].join("\n");
}

/** One declared foreign key: this table's `column` points at `table`.`toColumn`. */
export interface ForeignKey {
  column: string;
  table: string;
  toColumn: string;
}

/**
 * A table's declared foreign keys.
 *
 * Only what the schema states. A `*_id` column with no declared key is NOT inferred: guessing
 * that `category_id` means `categories.id` is right until the one time it is not, and a browser
 * that silently follows a link the schema never declared is worse than one that follows none.
 */
export function foreignKeys(db: Db, table: string): ForeignKey[] {
  return rows(db, `pragma foreign_key_list(${quoteIdent(table)})`).map((r) => ({
    column: String(r.from),
    table: String(r.table),
    toColumn: String(r.to ?? "id"),
  }));
}

/** The query behind a foreign-key click: the one row on the far side of the reference. */
export function lookupQuery(fk: ForeignKey, value: unknown): string {
  // Numbers unquoted, everything else single-quoted with its quotes doubled. A key is an integer
  // in almost every schema, but a TEXT key is legal and would be a syntax error interpolated bare.
  const literal = typeof value === "number" ? String(value) : `'${String(value).replace(/'/g, "''")}'`;
  return `select * from ${quoteIdent(fk.table)} where ${quoteIdent(fk.toColumn)} = ${literal};`;
}

/**
 * Sort rows by one column, in memory.
 *
 * In memory rather than by re-querying, because the result may be a join or an aggregate that no
 * `order by` can be bolted onto. The cost is that a TRUNCATED result sorts only the rows on
 * screen — the grid already says "showing N of M", which is the honest statement of that.
 *
 * Numbers compare numerically (so 10 sorts after 9, which lexical order gets wrong), strings by
 * locale, and NULL sorts last in BOTH directions: a null is the absence of a value, not a value
 * smaller than every other, and burying them at the bottom is what a reader expects either way.
 */
export function sortRows(rows: unknown[][], index: number, dir: "asc" | "desc"): unknown[][] {
  const sign = dir === "asc" ? 1 : -1;
  const isNull = (v: unknown) => v === null || v === undefined;
  return [...rows].sort((a, b) => {
    const x = a[index];
    const y = b[index];
    if (isNull(x) && isNull(y)) return 0;
    if (isNull(x)) return 1;
    if (isNull(y)) return -1;
    if (typeof x === "number" && typeof y === "number") return (x - y) * sign;
    return String(x).localeCompare(String(y)) * sign;
  });
}

/** How many queries are remembered. Enough to find last week's; few enough to scan. */
export const MAX_HISTORY = 50;

export interface HistoryEntry {
  sql: string;
  /** Which database it was run against, so the list can show only this one's. */
  path: string;
  at: number;
}

/**
 * Add a query to the history, newest first.
 *
 * Re-running the same query moves it to the front rather than adding a second copy — otherwise
 * running one query five times while getting it right fills the list with five of it and pushes
 * out everything else.
 */
export function pushHistory(
  history: HistoryEntry[], sql: string, path: string, at: number,
): HistoryEntry[] {
  const trimmed = sql.trim();
  if (!trimmed) return history;
  return [
    { sql: trimmed, path, at },
    ...history.filter((h) => h.sql !== trimmed || h.path !== path),
  ].slice(0, MAX_HISTORY);
}

/**
 * What Ctrl+Enter should run: the selection if there is one, otherwise the whole editor.
 *
 * The convention in every SQL tool, and the reason a scratchpad holding five queries is usable
 * at all — without it, running one means deleting the other four.
 */
export function textToRun(all: string, selected: string): string {
  return selected.trim() ? selected : all;
}

// ---- engines -------------------------------------------------------------------------------
//
// SQLite runs here, in wasm, against a file. Postgres and MySQL run in Rust, because a webview
// cannot open a TCP socket. Everything ABOVE this line is shared: the statement splitter, the
// read-only allowlist, sorting, CSV, the cell renderer. Only these three functions differ, so
// the UI takes a `Source` and never asks which engine it is holding.

export type EngineId = "sqlite" | "postgres" | "mysql";

/** One saved connection. A file path for sqlite, a url for the others. */
export interface Connection {
  id: string;
  name: string;
  engine: EngineId;
  /** File path (sqlite) or a postgres:// | mysql:// url. */
  target: string;
  /** Off by default. Per connection, because "safe to write to" is a property of the database. */
  allowWrites: boolean;
  /**
   * An SSH host to tunnel through, from ~/.ssh/config — "vps", or user@example.com.
   *
   * Empty for a direct connection. A database on a server should not be exposed to the internet,
   * so reaching one usually means going through the host that can see it; this is how that
   * happens without a terminal running `ssh -L` beside Deck.
   */
  sshHost?: string;
  /** What to reach FROM the ssh host, as host:port — a container ip, or localhost:5432. */
  sshRemote?: string;
}

/**
 * Point a connection url at a local tunnel port.
 *
 * The url is written as if connecting directly — the same one that works on the server — and the
 * host and port are swapped for the tunnel's. Keeping the original means the credentials and the
 * database name are still edited in one obvious place rather than split across fields.
 */
export function throughTunnel(url: string, port: number): string {
  // Only the authority is touched: userinfo, path and query are left exactly as typed.
  //
  // The userinfo match is GREEDY on purpose. A url splits at the LAST `@` before the path, not
  // the first — a password containing one (`p@ss`) is legal and common, and a lazy match would
  // treat everything after the first `@` as the host and quietly drop the rest of the password.
  const m = /^(\w+:\/\/)(.*)$/.exec(url);
  if (!m) return url;
  const [, scheme, rest] = m;
  const slash = rest.search(/[/?#]/);
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const tail = slash === -1 ? "" : rest.slice(slash);
  const at = authority.lastIndexOf("@");
  const userinfo = at === -1 ? "" : authority.slice(0, at + 1);
  return `${scheme}${userinfo}127.0.0.1:${port}${tail}`;
}

/** A table with its columns, as both engines report it. */
export interface SchemaTable extends Table {
  columns: Column[];
}

/**
 * What the UI drives. Both engines satisfy it, so no component branches on the engine.
 *
 * `close` matters more than it looks: a sqlite source holds a wasm heap copy of the file, and a
 * server source holds real connections on someone else's machine. Neither should outlive the tab.
 */
export interface Source {
  engine: EngineId;
  schema(): Promise<{ tables: SchemaTable[]; foreignKeys: ForeignKeyRef[] }>;
  run(sql: string, allowWrites: boolean): Promise<Result>;
  rowCount(table: string): Promise<number>;
  close(): Promise<void>;
}

/** A foreign key, engine-independent: `table.column` points at `refTable.refColumn`. */
export interface ForeignKeyRef {
  table: string;
  column: string;
  refTable: string;
  refColumn: string;
}

/**
 * Quote an identifier for one engine.
 *
 * MySQL uses backticks; the other two use double quotes, which is the SQL standard. Doubling the
 * quote character is what makes the escaping total rather than nearly right.
 */
export function quoteFor(engine: EngineId, name: string): string {
  return engine === "mysql"
    ? `\`${name.replace(/`/g, "``")}\``
    : `"${name.replace(/"/g, '""')}"`;
}

/** The default query for a table, in one engine's dialect. */
export function previewFor(engine: EngineId, table: string): string {
  return `select * from ${quoteFor(engine, table)} limit 200;`;
}

/** The query behind a foreign-key click, in one engine's dialect. */
export function lookupFor(engine: EngineId, fk: ForeignKeyRef, value: unknown): string {
  const literal = typeof value === "number"
    ? String(value)
    : `'${String(value).replace(/'/g, "''")}'`;
  return `select * from ${quoteFor(engine, fk.refTable)} `
    + `where ${quoteFor(engine, fk.refColumn)} = ${literal};`;
}

// ---- editing ---------------------------------------------------------------------------------
//
// A grid edit becomes one statement against one row. The dangerous case is an UPDATE with no
// unique key: it silently changes every matching row, which is why `editable` refuses rather
// than guessing. Every serious viewer gates the same way.

/** Why a result cannot be edited, or null if it can. */
export type EditBlock = string | null;

/**
 * Whether a result's rows can be written back, and why not when they cannot.
 *
 * Three conditions, all necessary:
 *
 * - the result came from ONE table, so a column's owner is unambiguous. A join cannot be updated
 *   because `name` might belong to either side.
 * - that table has a primary key, and
 * - every key column is present in the result, so a row can be named exactly. Without this an
 *   UPDATE matches on whatever columns happen to be there, and "every row where name = 'Ada'"
 *   is how a grid edit quietly rewrites several rows.
 */
export function editable(
  table: string | null,
  columns: string[],
  tableColumns: Column[],
): EditBlock {
  if (!table) return "Editing needs a single table — run a plain select from one table.";
  const pk = tableColumns.filter((c) => c.pk).map((c) => c.name);
  if (!pk.length) return `${table} has no primary key, so a row cannot be identified.`;
  const missing = pk.filter((k) => !columns.includes(k));
  if (missing.length) {
    return `Add ${missing.join(", ")} to the query — a row cannot be identified without its key.`;
  }
  return null;
}

/** A literal for interpolation. NULL is the word, numbers are bare, everything else is quoted. */
export function literal(v: unknown): string {
  if (v === null || v === undefined || v === "") return "null";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  const s = String(v);
  // A value the user typed as a number stays a number: quoting it would fail against a numeric
  // column on Postgres, which does not coerce a quoted string in an UPDATE the way MySQL does.
  if (/^-?\d+(\.\d+)?$/.test(s)) return s;
  if (s === "true" || s === "false") return s;
  return `'${s.replace(/'/g, "''")}'`;
}

/** `where` naming exactly one row, from its primary key values. */
function whereKey(
  engine: EngineId,
  pk: string[],
  columns: string[],
  row: unknown[],
): string {
  return pk
    .map((k) => `${quoteFor(engine, k)} = ${literal(row[columns.indexOf(k)])}`)
    .join(" and ");
}

/** The UPDATE for one changed cell. */
export function updateStatement(
  engine: EngineId,
  table: string,
  columns: string[],
  row: unknown[],
  pk: string[],
  column: string,
  value: unknown,
): string {
  return `update ${quoteFor(engine, table)} set ${quoteFor(engine, column)} = ${literal(value)} `
    + `where ${whereKey(engine, pk, columns, row)};`;
}

/** The DELETE for one row. */
export function deleteStatement(
  engine: EngineId,
  table: string,
  columns: string[],
  row: unknown[],
  pk: string[],
): string {
  return `delete from ${quoteFor(engine, table)} where ${whereKey(engine, pk, columns, row)};`;
}

/**
 * The INSERT for a new row.
 *
 * Columns left blank are OMITTED rather than sent as null, so a default or an auto-increment key
 * does its job. Sending null explicitly would override both — and on a NOT NULL column with a
 * default, it fails outright.
 */
export function insertStatement(
  engine: EngineId,
  table: string,
  values: Record<string, unknown>,
): string {
  const entries = Object.entries(values).filter(([, v]) => v !== undefined && v !== "");
  if (!entries.length) return `insert into ${quoteFor(engine, table)} default values;`;
  const cols = entries.map(([k]) => quoteFor(engine, k)).join(", ");
  const vals = entries.map(([, v]) => literal(v)).join(", ");
  return `insert into ${quoteFor(engine, table)} (${cols}) values (${vals});`;
}

/**
 * The single table a select reads from, or null if it is not a plain one-table select.
 *
 * Editing needs this, and the sidebar selection cannot supply it: a typed query has no
 * selection, and a stale selection from an earlier click would name the WRONG table — which is
 * how a grid edit would update a row in a table the user is not looking at.
 *
 * Deliberately conservative. Anything with a join, a comma-separated list, a subquery or a set
 * operation returns null, because in all of those a column's owner is ambiguous. The cost of
 * being wrong here is an UPDATE against the wrong table, so "not sure" must mean "not editable".
 */
export function singleTable(sql: string): string | null {
  const s = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim()
    .replace(/;+\s*$/, "");
  if (!/^select\b/i.test(s)) return null;
  // More than one statement, or a set operation: not one table's rows.
  if (/;/.test(s)) return null;
  if (/\b(union|intersect|except)\b/i.test(s)) return null;
  if (/\bjoin\b/i.test(s)) return null;

  // Stops at a comma and a paren as well as whitespace. Matching plain non-whitespace instead
  // swallowed the comma of `from a, b` into the name, which then hid the old-style join from the
  // check below and reported the table as "a," — editable, against a two-table result.
  const from = /\bfrom\s+([^\s,;()]+)/i.exec(s);
  if (!from) return null;
  const after = s.slice((from.index ?? 0) + from[0].length);
  if (/^\s*,/.test(after)) return null;
  // A subquery: `from (select ...)`. The regex cannot match the paren, so it is tested directly.
  if (/\bfrom\s*\(/i.test(s)) return null;
  // An alias is fine — `from customers c` still reads one table — but anything else after it
  // that is not a clause keyword suggests a shape this does not understand.
  const name = from[1].replace(/^["`\[]|["`\]]$/g, "");
  // A schema-qualified name keeps only the table part, which is what information_schema lists.
  return name.includes(".") ? (name.split(".").pop() ?? null) : name;
}
