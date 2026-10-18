// The Databases plugin's logic, with no React and no Deck bridge in sight.
//
// Everything here is a pure function of a string or a result, so `npm test` (db.check.mjs) can
// check it in node. The UI is a thin layer over this file — which is the point: a wrong quote
// character or a statement splitter that breaks on a semicolon inside a string literal looks
// entirely plausible on screen.
import { formatDialect, mysql, postgresql, sqlite as sqliteDialect, transactsql } from "sql-formatter";

/** How many rows one page of a result holds: what Deck's db_query returns at most. */
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
  /** Rows in this result, which is `rows.length`: Deck reads a page, not the whole result. */
  total: number;
  /** More rows exist past these: the grid offers to load the next page. */
  truncated: boolean;
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
  return statementRanges(sql).map(([a, b]) => sql.slice(a, b).trim()).filter(Boolean);
}

/**
 * Where each statement of a script starts and ends, as [start, end) offsets.
 *
 * The walk behind `splitStatements`, kept separate so "the statement under the cursor" can be
 * answered by the same quoting rules rather than a second, slightly different splitter.
 */
function statementRanges(sql: string): [number, number][] {
  const out: [number, number][] = [];
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
      out.push([start, i]);
      start = i + 1;
      i++;
    } else i++;
  }
  out.push([start, sql.length]);
  return out;
}

/**
 * The statement the cursor is in, for Explain: the one statement the user means without
 * selecting it.
 *
 * A cursor right after a `;` belongs to the statement it ends, since that is where it is left
 * after typing one. A cursor in trailing blank space falls to the last statement before it.
 */
export function statementAt(sql: string, offset: number): string {
  const all = statementRanges(sql)
    .map(([a, b]) => ({ a, b, text: sql.slice(a, b).trim() }))
    .filter((s) => s.text);
  if (!all.length) return "";
  const at = all.find((s) => offset >= s.a && offset <= s.b + 1)
    ?? [...all].reverse().find((s) => s.b < offset)
    ?? all[0];
  return at.text;
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
// Every engine runs in Rust behind one handle API (Deck's db_* commands): a webview cannot open a
// TCP socket, and a database file is better opened in place than read into memory. Everything
// ABOVE this line is shared. What differs per engine is decided here, so the UI takes a `Source`
// and asks these functions rather than branching on the engine itself.

export type EngineId = "sqlite" | "postgres" | "mysql" | "mssql" | "redis" | "mongo";

/**
 * Whether an engine speaks SQL. Redis takes one command line and MongoDB one JSON command, so the
 * statement splitter, the SQL read-only allowlist, grid editing and INSERT export do not apply.
 */
export function isSql(engine: EngineId): boolean {
  return engine !== "redis" && engine !== "mongo";
}

/** Whether a connection names a file (picked from disk) rather than a server url. */
export function isFile(engine: EngineId): boolean {
  return engine === "sqlite";
}

/** The url Deck's dbConnect takes: a file engine's path behind its scheme, a server's url as is. */
export function connectUrl(engine: EngineId, target: string): string {
  return isFile(engine) ? `${engine}:${target}` : target;
}

/**
 * What one run sends, as separate statements.
 *
 * SQL is split, so a script's statements run one by one and a failure names the one that failed.
 * A Redis command line or a MongoDB command is ONE thing whatever it contains: a `;` inside a
 * JSON string is just a character.
 */
export function statementsFor(engine: EngineId, text: string): string[] {
  if (isSql(engine)) return splitStatements(text);
  return text.trim() ? [text.trim()] : [];
}

/** The editor's language for what an engine is sent: a command document, a command line, or SQL. */
export function editorLanguage(engine: EngineId): "json" | "plaintext" | "sql" {
  return engine === "mongo" ? "json" : engine === "redis" ? "plaintext" : "sql";
}

/**
 * A result with the next page of the same query after it.
 *
 * Deck reads a result a page at a time, so `total` is only ever the rows on hand, and whether
 * there are more is the NEW page's to say.
 */
export function appendPage(prev: Result, next: Result): Result {
  const rows = [...prev.rows, ...next.rows];
  return { columns: prev.columns, rows, total: rows.length, truncated: next.truncated };
}

/** One saved connection. A file path for SQLite, a url for the others. */
export interface Connection {
  id: string;
  name: string;
  engine: EngineId;
  /** File path (SQLite) or a postgres:// | mysql:// | mssql:// | redis:// | mongodb:// url. */
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

/**
 * A table with its columns, as every engine reports it. For Redis a "table" is a key group (its
 * name is the MATCH pattern, `user:*`) and for MongoDB a collection with its sampled fields.
 */
export interface SchemaTable extends Table {
  columns: Column[];
}

/**
 * What the UI drives. Every engine satisfies it, so no component holds a connection itself.
 *
 * `close` matters more than it looks: a source holds a file open or real connections on someone
 * else's machine. Neither should outlive the tab.
 */
export interface Source {
  engine: EngineId;
  schema(): Promise<{ tables: SchemaTable[]; foreignKeys: ForeignKeyRef[] }>;
  /** `skip` rows are passed over first, which is how the grid loads the next page. */
  run(sql: string, allowWrites: boolean, skip?: number): Promise<Result>;
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
 * MySQL uses backticks and SQL Server brackets; the rest use double quotes, the SQL standard.
 * Doubling the closing quote character is what makes the escaping total rather than nearly right.
 * Redis and MongoDB have no identifiers to quote, so a name comes back as it is.
 */
export function quoteFor(engine: EngineId, name: string): string {
  if (engine === "mysql") return `\`${name.replace(/`/g, "``")}\``;
  if (engine === "mssql") return `[${name.replace(/]/g, "]]")}]`;
  if (!isSql(engine)) return name;
  return `"${name.replace(/"/g, '""')}"`;
}

/** A word of a Redis command line, quoted the way Deck splits one when it has to be. */
function redisWord(w: string): string {
  return /^[^\s"'\\]+$/.test(w) ? w : `"${w.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The default query for a table, in one engine's language: enough rows to see the shape.
 *
 * Redis lists the group's keys, its name being their MATCH pattern; MongoDB finds 200 documents.
 */
export function previewFor(engine: EngineId, table: string): string {
  if (engine === "mssql") return `select top 200 * from ${quoteFor(engine, table)};`;
  if (engine === "redis") return `SCAN 0 MATCH ${redisWord(table)}`;
  if (engine === "mongo") return JSON.stringify({ find: table, limit: 200 });
  return `select * from ${quoteFor(engine, table)} limit 200;`;
}

/** The query that counts a table's rows, or null where there is no such thing (a Redis group). */
export function countFor(engine: EngineId, table: string): string | null {
  if (engine === "redis") return null;
  if (engine === "mongo") return JSON.stringify({ count: table });
  return `select count(*) from ${quoteFor(engine, table)}`;
}

/** The query behind a foreign-key click, in one engine's dialect. SQL engines only. */
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
 * Why no result from this engine can be edited in the grid, or null when one can.
 *
 * Redis and MongoDB rows are a reply shaped into a table, not a table's rows: there is no key
 * column to name a row by and no UPDATE to write. A command does the change instead.
 */
export function engineEditBlock(engine: EngineId): EditBlock {
  if (engine === "redis") return "A Redis reply is read here, not edited. Change a key with a command, such as SET or HSET.";
  if (engine === "mongo") return "MongoDB documents are read here, not edited. Change them with a command, such as update.";
  return null;
}

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

// ---- export ----------------------------------------------------------------------------------
//
// What the Export menu copies or saves. The rows on screen, like the CSV: a capped result exports
// the rows the grid shows, and the menu says so, rather than quietly disagreeing with the count.

/** A result as a JSON array of row objects, keyed by column name. */
export function toJson(result: Result): string {
  // Deck hands every cell over as JSON already (a BLOB as its "BLOB (n bytes)" summary), so the
  // values go out as they came in.
  return JSON.stringify(
    result.rows.map((r) => Object.fromEntries(result.columns.map((c, i) => [c, r[i] ?? null]))),
    null,
    2,
  );
}

/**
 * A stored value as a literal, exactly.
 *
 * Not `literal`, which reads what a person typed into a cell: there "" means NULL and "42" means
 * the number. An exported value came out of the database, so a string stays a string, empty
 * included, and only a real null is NULL.
 */
function exactLiteral(engine: EngineId, v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return String(v);
  // SQL Server has no boolean literal: a bit column takes 1 and 0.
  if (typeof v === "boolean") return engine === "mssql" ? (v ? "1" : "0") : v ? "true" : "false";
  return strFor(engine, String(v));
}

/**
 * One INSERT per row, into `table`.
 *
 * Every column is named and every value sent, unlike `insertStatement`: that one builds a new row
 * from a form, where a blank field should fall to the column's default, and an export has to put
 * back exactly what was read.
 */
export function toInserts(engine: EngineId, table: string, result: Result): string {
  const cols = result.columns.map((c) => quoteFor(engine, c)).join(", ");
  const into = `insert into ${quoteFor(engine, table)} (${cols}) values`;
  return result.rows
    .map((r) => `${into} (${r.map((v) => exactLiteral(engine, v)).join(", ")});`)
    .join("\n");
}

/**
 * A value pretty-printed as JSON, or null when it is not JSON.
 *
 * Only an object or an array counts: `42` and `"x"` are valid JSON too, but showing them
 * "formatted" changes nothing, and a text column of numbers is not a JSON column.
 */
export function prettyJson(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!/^[[{]/.test(s)) return null;
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return null;
  }
}

// ---- formatting ------------------------------------------------------------------------------

/**
 * SQL laid out by sql-formatter, in the engine's own dialect.
 *
 * The dialect matters beyond taste: MySQL's backticks, SQL Server's [brackets] and Postgres's `::`
 * casts are tokens only in their own dialect, and formatting one as plain SQL splits them apart.
 * Only the dialects named here are imported, so the others the package knows stay out of
 * plugin.js. Throws on SQL the formatter cannot parse, and for Redis and MongoDB, which are not
 * SQL; the UI offers Format only where `isSql` says so.
 */
export function formatSql(engine: EngineId, sql: string): string {
  const dialect = { sqlite: sqliteDialect, postgres: postgresql, mysql, mssql: transactsql }[engine as string];
  if (!dialect) throw new Error(`${engine} is not SQL`);
  return formatDialect(sql, { dialect });
}

// ---- explain ---------------------------------------------------------------------------------

/**
 * A statement as each engine's plan for it.
 *
 * SQLite's plain EXPLAIN is its bytecode, which says nothing to a reader; QUERY PLAN is the tree
 * of scans and searches. Plain EXPLAIN (never ANALYZE) on the servers plans without executing, so
 * an explained write is still not run. A statement that is already an EXPLAIN is left as it is.
 *
 * Null where there is no such prefix: SQL Server shows a plan only through SET SHOWPLAN, a session
 * switch that has to be a batch of its own, and Redis and MongoDB are not SQL.
 */
export function explainFor(engine: EngineId, sql: string): string | null {
  if (engine === "mssql" || !isSql(engine)) return null;
  const s = sql.trim().replace(/;+\s*$/, "");
  if (/^explain\b/i.test(stripLeading(s))) return s;
  return `${engine === "sqlite" ? "explain query plan" : "explain"} ${s}`;
}

// ---- structure -------------------------------------------------------------------------------
//
// What the Structure view reads beyond the schema the sidebar already holds: column defaults and
// indexes. Each is one read-only query per engine, aliased to the same column names so one parser
// serves all three.

/**
 * A string literal for one engine. MySQL also treats a backslash as an escape by default, and SQL
 * Server's N'' keeps text outside the database's code page intact.
 */
function strFor(engine: EngineId, s: string): string {
  const body = (engine === "mysql" ? s.replace(/\\/g, "\\\\") : s).replace(/'/g, "''");
  return engine === "mssql" ? `N'${body}'` : `'${body}'`;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  /** The engine's own CREATE INDEX, where it keeps one (Postgres). */
  definition: string;
}

/**
 * The queries behind the Structure view, each null where the engine has no such thing.
 *
 * `defaults` returns (name, dflt). `indexes` returns (name, uniq, col), a row per indexed column;
 * or (name, definition) on Postgres, whose pg_indexes holds the whole definition; or MongoDB's
 * listIndexes documents (name, key, unique).
 * `create` returns the table's DDL as its second column where the engine can give it: MySQL only,
 * since SQLite's is already in the schema and Postgres and SQL Server keep none.
 * A Redis key group has no defaults, indexes or DDL at all.
 */
export function structureQueries(engine: EngineId, table: string): {
  defaults: string | null; indexes: string | null; create: string | null;
} {
  if (engine === "redis") return { defaults: null, indexes: null, create: null };
  if (engine === "mongo") return { defaults: null, indexes: JSON.stringify({ listIndexes: table }), create: null };
  const t = strFor(engine, table);
  if (engine === "mssql") {
    return {
      defaults: `select column_name as name, column_default as dflt from information_schema.columns
        where table_schema = schema_name() and table_name = ${t}`,
      // sys.indexes rather than information_schema, which has no indexes at all. A heap's row
      // (type 0) has no name and no columns, and included columns are not part of the key.
      indexes: `select i.name as name, i.is_unique as uniq, c.name as col
        from sys.indexes i
        join sys.index_columns ic on ic.object_id = i.object_id and ic.index_id = i.index_id
        join sys.columns c on c.object_id = ic.object_id and c.column_id = ic.column_id
        where i.object_id = object_id(quotename(schema_name()) + '.' + quotename(${t}))
          and i.type > 0 and ic.is_included_column = 0
        order by i.name, ic.key_ordinal`,
      create: null,
    };
  }
  if (engine === "sqlite") {
    return {
      defaults: `select name, dflt_value as dflt from pragma_table_info(${t})`,
      // Table-valued pragmas, so every index and its columns come back from one query.
      indexes: `select il.name as name, il."unique" as uniq, ii.name as col
        from pragma_index_list(${t}) as il, pragma_index_info(il.name) as ii
        order by il.name, ii.seqno`,
      create: null,
    };
  }
  if (engine === "postgres") {
    return {
      defaults: `select column_name as name, column_default as dflt from information_schema.columns
        where table_schema = current_schema() and table_name = ${t}`,
      indexes: `select indexname as name, indexdef as definition from pg_indexes
        where schemaname = current_schema() and tablename = ${t} order by indexname`,
      create: null,
    };
  }
  return {
    defaults: `select column_name as name, column_default as dflt from information_schema.columns
      where table_schema = database() and table_name = ${t}`,
    indexes: `select index_name as name, non_unique = 0 as uniq, column_name as col
      from information_schema.statistics
      where table_schema = database() and table_name = ${t}
      order by index_name, seq_in_index`,
    create: `show create table ${quoteFor(engine, table)}`,
  };
}

/** Column name to its default, from the `defaults` query. A column with none is left out. */
export function parseDefaults(result: Result): Map<string, string> {
  const n = result.columns.indexOf("name");
  const d = result.columns.indexOf("dflt");
  const out = new Map<string, string>();
  for (const r of result.rows) {
    if (r[d] !== null && r[d] !== undefined) out.set(String(r[n]), String(r[d]));
  }
  return out;
}

/** Indexes from the `indexes` query, one per name, with its columns in key order. */
export function parseIndexes(result: Result): IndexInfo[] {
  const at = (c: string) => result.columns.indexOf(c);
  // MongoDB's listIndexes cannot alias its fields: `unique` and `key` are its own names.
  const [n, c, def, key] = [at("name"), at("col"), at("definition"), at("key")];
  const u = at("uniq") >= 0 ? at("uniq") : at("unique");
  const out = new Map<string, IndexInfo>();
  for (const r of result.rows) {
    const name = String(r[n]);
    let ix = out.get(name);
    if (!ix) {
      const definition = def >= 0 ? String(r[def] ?? "") : "";
      ix = {
        name,
        columns: [],
        // A flag (1, true or "1"); Postgres says it in the definition instead.
        unique: u >= 0 ? r[u] === 1 || r[u] === true || r[u] === "1" : /^create unique/i.test(definition),
        definition,
      };
      out.set(name, ix);
    }
    if (c >= 0 && r[c] !== null && r[c] !== undefined) ix.columns.push(String(r[c]));
    // MongoDB: the key document, as compact JSON, names the fields in order (`{"a":1,"b":-1}`).
    if (key >= 0 && typeof r[key] === "string") {
      try { ix.columns = Object.keys(JSON.parse(r[key] as string)); } catch { /* shown without columns */ }
    }
    // Postgres: the columns are the last parenthesised list, `... USING btree (a, b)`.
    if (def >= 0 && !ix.columns.length) {
      const m = /\(([^()]*)\)[^()]*$/.exec(ix.definition);
      if (m) ix.columns = m[1].split(",").map((x) => x.trim()).filter(Boolean);
    }
  }
  return [...out.values()];
}

// ---- query tabs ------------------------------------------------------------------------------

/** One query tab: its name and the SQL in it. */
export interface QueryTab {
  id: string;
  name: string;
  sql: string;
}

/**
 * The tabs from a saved config, whatever its age.
 *
 * Before tabs there was one buffer, `sql`. A config from then becomes ONE tab holding exactly that
 * text, so upgrading never loses a query; a config with no text at all still gets an empty tab,
 * since the editor needs something to show.
 */
export function migrateTabs(saved: { tabs?: QueryTab[]; activeTab?: string; sql?: string }): {
  tabs: QueryTab[]; activeTab: string;
} {
  const tabs = Array.isArray(saved.tabs) && saved.tabs.length
    ? saved.tabs
    : [{ id: "t1", name: "Query 1", sql: typeof saved.sql === "string" ? saved.sql : "" }];
  const activeTab = tabs.some((t) => t.id === saved.activeTab) ? saved.activeTab! : tabs[0].id;
  return { tabs, activeTab };
}

/** The lowest "Query N" not already open, so a new tab never repeats a name. */
export function nextTabName(tabs: QueryTab[]): string {
  const taken = new Set(tabs.map((t) => t.name));
  let n = 1;
  while (taken.has(`Query ${n}`)) n++;
  return `Query ${n}`;
}
