// node db.check.mjs
//
// The browser's logic, against a real database rather than a fixture. Two things here are worth
// more than the rest: the statement splitter, which is wrong the moment a semicolon appears
// inside a string literal, and isReadOnly, which is a guard — a write it fails to recognise is
// a write that runs against the user's file.
//
// Wally's database is used as the sample because it is already on this machine and has a real
// schema. If it is absent the schema half skips; the pure string functions still run, since they
// need no database at all.
import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import initSqlJs from "sql.js";

const out = await build({
  entryPoints: ["src/db.ts"],
  bundle: true, format: "esm", write: false, platform: "node",
});
const q = await import(
  `data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`
);

// ---- statement splitting -------------------------------------------------------------------
// The whole reason this function exists rather than String.split(";").
assert.deepEqual(q.splitStatements("select 1; select 2"), ["select 1", "select 2"]);
assert.deepEqual(q.splitStatements("select 1;"), ["select 1"], "trailing semicolon is not a statement");
assert.deepEqual(q.splitStatements("  \n ; ; "), [], "empty statements are dropped");
assert.deepEqual(
  q.splitStatements("select 'a;b'"), ["select 'a;b'"],
  "a semicolon inside a string literal does not split",
);
assert.deepEqual(
  q.splitStatements(`select "we;ird" from t`), [`select "we;ird" from t`],
  "nor inside a quoted identifier",
);
assert.deepEqual(
  q.splitStatements("select [a;b] from t"), ["select [a;b] from t"],
  "nor inside bracket quoting",
);
assert.deepEqual(
  q.splitStatements("select 'it''s; fine'"), ["select 'it''s; fine'"],
  "a doubled quote is an escape, not the end of the literal",
);
assert.deepEqual(
  q.splitStatements("select 1 -- a; comment\n; select 2"), ["select 1 -- a; comment", "select 2"],
  "nor inside a line comment",
);
assert.deepEqual(
  q.splitStatements("select /* a; b */ 1; select 2"), ["select /* a; b */ 1", "select 2"],
  "nor inside a block comment",
);
// An unterminated literal must not hang or lose the text.
assert.equal(q.splitStatements("select 'unclosed").length, 1);

// ---- the read-only guard -------------------------------------------------------------------
for (const sql of [
  "select 1", "SELECT 1", "  select 1", "values (1)", "explain select 1",
  "pragma table_info(t)", "-- note\nselect 1", "/* note */ select 1",
  "with x as (select 1) select * from x",
]) assert.ok(q.isReadOnly(sql), `read: ${sql}`);

for (const sql of [
  "insert into t values (1)", "update t set a = 1", "delete from t", "drop table t",
  "create table t (a)", "alter table t add b", "replace into t values (1)",
  "pragma user_version = 1", "vacuum", "attach 'x' as y",
  "with x as (select 1) delete from t where a in (select * from x)",
]) assert.equal(q.isReadOnly(sql), false, `write: ${sql}`);

// Fails closed: anything unrecognised counts as a write.
assert.equal(q.isReadOnly("frobnicate the database"), false, "unknown statements are not reads");
assert.equal(q.isReadOnly(""), false, "empty is not a read");
assert.equal(q.isReadOnly("-- only a comment"), false, "a comment alone is not a read");

// ---- identifier quoting --------------------------------------------------------------------
assert.equal(q.quoteIdent("order"), '"order"', "a keyword table name is quoted");
assert.equal(q.quoteIdent('we"ird'), '"we""ird"', "an embedded quote is doubled");

// ---- cell rendering ------------------------------------------------------------------------
assert.deepEqual(q.cell(null), { text: "NULL", kind: "null" });
assert.deepEqual(q.cell(""), { text: "", kind: "text" }, "empty string is not NULL");
assert.deepEqual(q.cell(0), { text: "0", kind: "number" }, "zero is not NULL either");
assert.equal(q.cell(new Uint8Array([1, 2, 3])).kind, "blob");
assert.equal(q.cell(new Uint8Array(3)).text, "BLOB (3 bytes)");

// ---- CSV ------------------------------------------------------------------------------------
assert.equal(
  q.toCsv({ columns: ["a", "b"], rows: [[1, "x"]], total: 1, truncated: false }),
  "a,b\n1,x",
);
assert.equal(
  q.toCsv({ columns: ["a"], rows: [['say "hi", ok']], total: 1, truncated: false }),
  'a\n"say ""hi"", ok"',
  "a value with a comma or quote is quoted and its quotes doubled",
);


// ---- sorting -------------------------------------------------------------------------------
// Numeric, not lexical: the classic bug puts 10 before 9.
assert.deepEqual(
  q.sortRows([[10], [9], [100]], 0, "asc").map((r) => r[0]), [9, 10, 100],
  "numbers sort numerically",
);
assert.deepEqual(
  q.sortRows([[10], [9], [100]], 0, "desc").map((r) => r[0]), [100, 10, 9],
);
assert.deepEqual(
  q.sortRows([["b"], ["a"], ["C"]], 0, "asc").map((r) => r[0]), ["a", "b", "C"],
  "strings sort by locale, so case does not split the alphabet",
);
// NULL last in BOTH directions — it is the absence of a value, not the smallest one.
for (const dir of ["asc", "desc"]) {
  const got = q.sortRows([[1], [null], [2]], 0, dir).map((r) => r[0]);
  assert.equal(got[got.length - 1], null, `nulls last when ${dir}`);
}
// Sorting must not mutate the caller's array: the grid keeps the original to sort again.
const original = [[3], [1], [2]];
q.sortRows(original, 0, "asc");
assert.deepEqual(original, [[3], [1], [2]], "the input array is untouched");
assert.equal(q.sortRows([], 0, "asc").length, 0, "an empty result sorts to empty");

// ---- history --------------------------------------------------------------------------------
const H = "db.sqlite";
let hist = q.pushHistory([], "select 1", H, 1);
assert.equal(hist.length, 1);
hist = q.pushHistory(hist, "select 2", H, 2);
assert.equal(hist[0].sql, "select 2", "newest first");
assert.equal(hist.length, 2);

// Re-running the same query moves it to the front rather than adding a duplicate.
hist = q.pushHistory(hist, "select 1", H, 3);
assert.equal(hist.length, 2, "no duplicate entry");
assert.equal(hist[0].sql, "select 1", "and it moved to the front");

// Whitespace-only differences are the same query; blank is not a query at all.
assert.equal(q.pushHistory(hist, "  select 1  ", H, 4).length, 2, "trimmed before comparing");
assert.equal(q.pushHistory(hist, "   ", H, 5).length, 2, "blank is not recorded");

// The same SQL against a DIFFERENT database is a different entry.
assert.equal(q.pushHistory(hist, "select 1", "other.db", 6).length, 3);

// The cap holds, and drops the OLDEST.
let long = [];
for (let i = 0; i < q.MAX_HISTORY + 10; i++) long = q.pushHistory(long, `select ${i}`, H, i);
assert.equal(long.length, q.MAX_HISTORY, "capped");
assert.equal(long[0].sql, `select ${q.MAX_HISTORY + 9}`, "newest kept");
assert.ok(!long.some((h) => h.sql === "select 0"), "oldest dropped");

// ---- what Ctrl+Enter runs ---------------------------------------------------------------------
assert.equal(q.textToRun("select 1; select 2", ""), "select 1; select 2", "no selection runs all");
assert.equal(q.textToRun("select 1; select 2", "select 2"), "select 2", "a selection runs alone");
assert.equal(q.textToRun("select 1", "   "), "select 1", "a whitespace selection is no selection");

// ---- foreign keys ------------------------------------------------------------------------------
assert.equal(
  q.lookupQuery({ column: "category_id", table: "categories", toColumn: "id" }, 3),
  'select * from "categories" where "id" = 3;',
  "a numeric key is interpolated bare",
);
assert.equal(
  q.lookupQuery({ column: "code", table: "t", toColumn: "k" }, "it's"),
  `select * from "t" where "k" = 'it''s';`,
  "a text key is quoted and its quotes doubled",
);

// ---- dialects ----------------------------------------------------------------------------
// MySQL quotes with backticks, the other two with the standard double quote. Getting this wrong
// is a syntax error on every query against a table whose name needs quoting.
assert.equal(q.quoteFor("mysql", "order"), "`order`");
assert.equal(q.quoteFor("postgres", "order"), '"order"');
assert.equal(q.quoteFor("sqlite", "order"), '"order"');
assert.equal(q.quoteFor("mysql", "we`ird"), "`we``ird`", "a backtick is doubled");

assert.equal(q.previewFor("mysql", "t"), "select * from `t` limit 200;");
assert.equal(q.previewFor("postgres", "t"), 'select * from "t" limit 200;');

const ref = { table: "orders", column: "customer_id", refTable: "customers", refColumn: "id" };
assert.equal(
  q.lookupFor("postgres", ref, 7),
  'select * from "customers" where "id" = 7;',
  "a foreign key follows to the REFERENCED table, not its own",
);
assert.equal(q.lookupFor("mysql", ref, 7), "select * from `customers` where `id` = 7;");



// ---- which table a select reads ---------------------------------------------------------------
// Editing writes to whatever this returns, so a wrong answer is an UPDATE against the wrong
// table. "Not sure" must mean null.
assert.equal(q.singleTable("select * from customers"), "customers");
assert.equal(q.singleTable("select id, name from customers order by id limit 10;"), "customers");
assert.equal(q.singleTable("SELECT * FROM Customers"), "Customers");
assert.equal(q.singleTable('select * from "customers"'), "customers", "quotes stripped");
assert.equal(q.singleTable("select * from public.customers"), "customers", "schema-qualified");
assert.equal(q.singleTable("select * from customers c where c.id = 1"), "customers", "an alias is fine");
assert.equal(
  q.singleTable(["-- note", "select * from customers"].join("\n")),
  "customers",
  "a leading comment does not hide the select",
);

for (const sql of [
  "select * from a join b on a.id = b.a_id",
  "select * from a, b",
  "select * from (select 1) x",
  "select * from a union select * from b",
  "select 1",
  "update customers set name = 'x'",
  "delete from customers",
  "select * from a; select * from b",
]) assert.equal(q.singleTable(sql), null, `not one table: ${sql}`);


// ---- tunnelling a url -------------------------------------------------------------------------
// The url is written as if connecting directly; only the authority is swapped for the local
// tunnel. Losing the password or the database name here means a connection that fails for a
// reason nobody can see from the form.
assert.equal(
  q.throughTunnel("postgres://board:board@172.21.0.2:5432/board", 5434),
  "postgres://board:board@127.0.0.1:5434/board",
);
assert.equal(
  q.throughTunnel("mysql://root:pw@db.internal:3306/shop", 7001),
  "mysql://root:pw@127.0.0.1:7001/shop",
);
// No password, no port, and a query string: all preserved.
assert.equal(
  q.throughTunnel("postgres://user@host/db", 5555),
  "postgres://user@127.0.0.1:5555/db",
);
assert.equal(
  q.throughTunnel("postgres://host/db?sslmode=disable", 5555),
  "postgres://127.0.0.1:5555/db?sslmode=disable",
  "a query string survives",
);
// A password containing an @ or a colon must not confuse the split.
assert.equal(
  q.throughTunnel("postgres://user:p@ss:word@host:5432/db", 6000),
  "postgres://user:p@ss:word@127.0.0.1:6000/db",
  "the LAST @ separates userinfo from the host",
);

// ---- editing: the gate ------------------------------------------------------------------------
// The dangerous case is an UPDATE that matches more than one row, so refusing is the behaviour
// under test — not the SQL it would otherwise have produced.
const idCol = { name: "id", type: "int", notNull: true, pk: true };
const nameCol = { name: "name", type: "text", notNull: false, pk: false };

assert.equal(q.editable("customers", ["id", "name"], [idCol, nameCol]), null, "key present: editable");
assert.match(
  q.editable(null, ["name"], [idCol, nameCol]) ?? "",
  /single table/i,
  "a join cannot be edited",
);
assert.match(
  q.editable("logs", ["msg"], [{ name: "msg", type: "text", notNull: false, pk: false }]) ?? "",
  /no primary key/i,
  "a table without a key cannot be edited",
);
assert.match(
  q.editable("customers", ["name"], [idCol, nameCol]) ?? "",
  /cannot be identified/i,
  "the key must be IN the result, not merely exist",
);

// A composite key needs every part present.
const a = { name: "a", type: "int", notNull: true, pk: true };
const b = { name: "b", type: "int", notNull: true, pk: true };
assert.equal(q.editable("t", ["a", "b", "x"], [a, b]), null);
assert.match(q.editable("t", ["a", "x"], [a, b]) ?? "", /cannot be identified/i, "half a key is not a key");

// ---- editing: the statements ------------------------------------------------------------------
const editCols = ["id", "name", "balance"];
const editRow = [7, "Ada", 1250.5];

assert.equal(
  q.updateStatement("postgres", "customers", editCols, editRow, ["id"], "name", "Grace"),
  `update "customers" set "name" = 'Grace' where "id" = 7;`,
);
assert.equal(
  q.updateStatement("mysql", "customers", editCols, editRow, ["id"], "name", "Grace"),
  "update `customers` set `name` = 'Grace' where `id` = 7;",
  "mysql quotes with backticks",
);
// An apostrophe must not end the literal early — the classic way a grid edit becomes a syntax
// error, or worse.
assert.equal(
  q.updateStatement("postgres", "t", ["id"], [1], ["id"], "note", "it's"),
  `update "t" set "note" = 'it''s' where "id" = 1;`,
);
// Blank means NULL, and a number stays unquoted so a numeric column accepts it.
assert.match(q.updateStatement("postgres", "t", ["id"], [1], ["id"], "n", ""), /= null /);
assert.match(q.updateStatement("postgres", "t", ["id"], [1], ["id"], "n", "42.5"), /= 42\.5 /);
assert.match(q.updateStatement("postgres", "t", ["id"], [1], ["id"], "n", "true"), /= true /);

// A composite key names BOTH columns, or the update hits more than one row.
assert.equal(
  q.updateStatement("postgres", "t", ["a", "b", "v"], [1, 2, 9], ["a", "b"], "v", 10),
  `update "t" set "v" = 10 where "a" = 1 and "b" = 2;`,
);

assert.equal(
  q.deleteStatement("postgres", "customers", editCols, editRow, ["id"]),
  `delete from "customers" where "id" = 7;`,
);
assert.equal(
  q.deleteStatement("postgres", "t", ["a", "b"], [1, 2], ["a", "b"]),
  `delete from "t" where "a" = 1 and "b" = 2;`,
);

// Insert omits blanks, so a default or an auto-increment key still applies.
assert.equal(
  q.insertStatement("postgres", "customers", { name: "Ada", email: "", balance: 10 }),
  `insert into "customers" ("name", "balance") values ('Ada', 10);`,
  "an empty field is omitted, not sent as null",
);
assert.equal(
  q.insertStatement("mysql", "t", { a: 1 }),
  "insert into `t` (`a`) values (1);",
);

// ---- against a real database -----------------------------------------------------------------
const DB = join(process.env.APPDATA ?? "", "Deck", "wallet", "wallet_profile_1.db");
if (!existsSync(DB)) {
  console.log(`db: ok (string logic only — no database at ${DB})`);
  process.exit(0);
}

const SQL = await initSqlJs();
const db = new SQL.Database(readFileSync(DB));

const ts = q.tables(db);
assert.ok(ts.length > 0, "the database has tables");
assert.ok(ts.every((t) => t.name && !t.name.startsWith("sqlite_")), "internal tables are hidden");
assert.ok(ts.some((t) => t.name === "transactions"), "Wally's transactions table is listed");

const cols = q.columns(db, "transactions");
assert.ok(cols.length > 0, "transactions has columns");
assert.ok(cols.some((c) => c.pk), "and a primary key");
assert.ok(cols.every((c) => typeof c.name === "string" && typeof c.notNull === "boolean"));

assert.ok(q.rowCount(db, "transactions") > 0, "and rows");

// A result carries its columns even when it matched nothing, and never reports NaN.
const empty = q.run(db, "select * from transactions where 1 = 0");
assert.equal(empty.total, 0);
assert.equal(empty.truncated, false);

const some = q.run(db, "select id from transactions limit 5");
assert.equal(some.rows.length, 5);
assert.deepEqual(some.columns, ["id"]);

// The cap truncates the rows but reports the true total, so the UI can say "showing N of M".
const capped = q.run(db, `select 1 from transactions, transactions limit ${q.ROW_CAP + 50}`);
if (capped.total > q.ROW_CAP) {
  assert.equal(capped.rows.length, q.ROW_CAP, "rows are capped");
  assert.ok(capped.truncated && capped.total > capped.rows.length, "the true total is kept");
}

// A bad query throws with something worth showing, rather than returning empty.
assert.throws(() => q.run(db, "select * from no_such_table"), /no such table/i);

// previewQuery must actually run against every table in the database, including any whose name
// needs quoting — which is the only thing quoteIdent is there for.
for (const t of ts) q.run(db, q.previewQuery(t.name));

console.log(`db: ok (${ts.length} tables, ${cols.length} columns on transactions)`);

// ---- foreign keys, as actually declared --------------------------------------------------------
// Wally declares them, so the browser has real links to follow.
const fks = q.foreignKeys(db, "transactions");
assert.ok(fks.length >= 2, "transactions declares foreign keys");
const cat = fks.find((f) => f.column === "category_id");
assert.ok(cat && cat.table === "categories" && cat.toColumn === "id",
  "category_id points at categories.id");

// Following one must produce a query that actually runs and finds the row.
const anyTxn = q.run(db, "select category_id from transactions where category_id is not null limit 1");
if (anyTxn.rows.length) {
  const found = q.run(db, q.lookupQuery(cat, anyTxn.rows[0][0]));
  assert.equal(found.total, 1, "following a foreign key finds exactly one row");
}

// A table with no declared keys reports none rather than throwing.
assert.deepEqual(q.foreignKeys(db, "categories"), [], "categories declares none");


console.log("db: sort, history, selection and foreign keys ok");
