// node db.check.mjs
//
// The plugin's logic, in node with no Deck around it. Two things here are worth more than the
// rest: the statement splitter, which is wrong the moment a semicolon appears inside a string
// literal, and isReadOnly, which is a guard — a write it fails to recognise is a write that runs
// against the user's database.
//
// Where SQL has to be proven to run, it runs against node's own SQLite (node:sqlite, in memory),
// so no sample database needs to be on the machine.
import assert from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

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

// ---- the statement under the cursor -------------------------------------------------------------
{
  const s = "select 1;\nselect 'a;b';\n\n";
  assert.equal(q.statementAt(s, 3), "select 1");
  assert.equal(q.statementAt(s, 9), "select 1", "right after the ; is still the statement it ends");
  assert.equal(q.statementAt(s, 14), "select 'a;b'", "a ; inside a literal does not split");
  assert.equal(q.statementAt(s, s.length), "select 'a;b'", "trailing blank space falls to the last");
  assert.equal(q.statementAt("  ", 1), "", "nothing to run");
}

// ---- formatting -----------------------------------------------------------------------------
assert.equal(q.formatSql("sqlite", "select a,b from t where a=1"), "select\n  a,\n  b\nfrom\n  t\nwhere\n  a = 1");
assert.match(q.formatSql("mysql", "select `a b` from t"), /`a b`/, "mysql's backticks survive");
assert.match(q.formatSql("postgres", "select x::int from t"), /x::int/, "a postgres cast stays whole");
assert.throws(() => q.formatSql("sqlite", "select 'unclosed"), "unparseable SQL throws, not mangles");

// ---- explain --------------------------------------------------------------------------------
assert.equal(q.explainFor("sqlite", "select 1;"), "explain query plan select 1");
assert.equal(q.explainFor("postgres", " select 1 "), "explain select 1");
assert.equal(q.explainFor("mysql", "select 1"), "explain select 1");
assert.equal(q.explainFor("postgres", "EXPLAIN select 1"), "EXPLAIN select 1", "not explained twice");
assert.ok(q.isReadOnly(q.explainFor("sqlite", "delete from t")), "an explained write is a read");

// ---- export ---------------------------------------------------------------------------------
{
  const r = { columns: ["id", "name", "note", "b"], rows: [[1, "it's", null, ""], [2, "", "x", "0"]], total: 2, truncated: false };
  assert.deepEqual(JSON.parse(q.toJson(r)), [
    { id: 1, name: "it's", note: null, b: "" },
    { id: 2, name: "", note: "x", b: "0" },
  ], "JSON keeps null, empty and numeric-looking strings as they are");
  assert.equal(
    q.toInserts("postgres", "t", r),
    `insert into "t" ("id", "name", "note", "b") values (1, 'it''s', null, '');\n`
    + `insert into "t" ("id", "name", "note", "b") values (2, '', 'x', '0');`,
    "an export keeps '' as '' and '0' as a string, unlike a typed cell",
  );
  assert.equal(
    q.toInserts("mysql", "t", { columns: ["p"], rows: [["a\\b"]], total: 1, truncated: false }),
    "insert into `t` (`p`) values ('a\\\\b');",
    "mysql doubles a backslash",
  );
  assert.equal(q.toInserts("sqlite", "t", { columns: ["a"], rows: [], total: 0, truncated: false }), "");
}

// ---- the value viewer's JSON ------------------------------------------------------------------
assert.equal(q.prettyJson('{"a":[1,2]}'), '{\n  "a": [\n    1,\n    2\n  ]\n}');
assert.equal(q.prettyJson("42"), null, "a bare number is not shown as JSON");
assert.equal(q.prettyJson("{not json"), null);
assert.equal(q.prettyJson(null), null);

// ---- structure --------------------------------------------------------------------------------
{
  const pg = q.structureQueries("postgres", "o'brien");
  assert.match(pg.indexes, /tablename = 'o''brien'/, "the table name is a literal, quote doubled");
  assert.equal(pg.create, null);
  assert.equal(q.structureQueries("mysql", "we`ird").create, "show create table `we``ird`");
  const ix = q.parseIndexes({
    columns: ["name", "definition"],
    rows: [
      ["t_pkey", "CREATE UNIQUE INDEX t_pkey ON public.t USING btree (id)"],
      ["t_ab", "CREATE INDEX t_ab ON public.t USING btree (a, b)"],
    ],
    total: 2, truncated: false,
  });
  assert.deepEqual(ix.map((i) => [i.name, i.unique, i.columns]), [["t_pkey", true, ["id"]], ["t_ab", false, ["a", "b"]]]);
  const my = q.parseIndexes({
    columns: ["name", "uniq", "col"],
    rows: [["PRIMARY", 1, "id"], ["ab", 0, "a"], ["ab", 0, "b"]],
    total: 3, truncated: false,
  });
  assert.deepEqual(my.map((i) => [i.name, i.unique, i.columns]), [["PRIMARY", true, ["id"]], ["ab", false, ["a", "b"]]]);
}

// A query against a real (in-memory) SQLite, shaped as Deck's db_query shapes a result.
const mem = new DatabaseSync(":memory:");
const runMem = (sql) => {
  const st = mem.prepare(sql);
  const columns = st.columns().map((c) => c.name);
  const rows = st.all().map((r) => columns.map((c) => r[c]));
  return { columns, rows, total: rows.length, truncated: false };
};

// The structure queries: the table-valued pragmas are the part only a real engine can confirm.
{
  mem.exec(`create table "o'k" (id integer primary key, a text not null default 'x', b int);
    create unique index ix_ab on "o'k" (a, b); create index ix_b on "o'k" (b);`);
  const sq = q.structureQueries("sqlite", "o'k");
  const d = q.parseDefaults(runMem(sq.defaults));
  assert.equal(d.get("a"), "'x'", "sqlite reports the default as written");
  assert.equal(d.has("b"), false, "a column with no default is left out");
  const ixs = q.parseIndexes(runMem(sq.indexes));
  assert.deepEqual(ixs.map((i) => [i.name, i.unique, i.columns]), [["ix_ab", true, ["a", "b"]], ["ix_b", false, ["b"]]]);
}

// ---- query tabs --------------------------------------------------------------------------------
// The one buffer before tabs must come through whole: it is the user's only copy of that query.
assert.deepEqual(q.migrateTabs({ sql: "select 1" }), {
  tabs: [{ id: "t1", name: "Query 1", sql: "select 1" }], activeTab: "t1",
}, "an old config's sql becomes one tab");
assert.deepEqual(q.migrateTabs({}).tabs.map((t) => t.sql), [""], "no sql still gives one tab");
{
  const tabs = [{ id: "a", name: "A", sql: "1" }, { id: "b", name: "B", sql: "2" }];
  assert.deepEqual(q.migrateTabs({ tabs, activeTab: "b", sql: "old" }), { tabs, activeTab: "b" }, "tabs win over a stale sql");
  assert.equal(q.migrateTabs({ tabs, activeTab: "gone" }).activeTab, "a", "a missing active tab falls to the first");
  assert.equal(q.migrateTabs({ tabs: [], sql: "x" }).tabs[0].sql, "x", "an empty tab list is not a migration");
}
assert.equal(q.nextTabName([{ id: "1", name: "Query 1", sql: "" }, { id: "3", name: "Query 3", sql: "" }]), "Query 2");
assert.equal(q.nextTabName([]), "Query 1");

// ---- engines --------------------------------------------------------------------------------
const SQL_ENGINES = ["sqlite", "duckdb", "postgres", "mysql", "mssql"];
for (const e of SQL_ENGINES) assert.ok(q.isSql(e), `${e} is SQL`);
assert.equal(q.isSql("redis"), false);
assert.equal(q.isSql("mongo"), false);
assert.ok(q.isFile("sqlite") && q.isFile("duckdb") && !q.isFile("postgres") && !q.isFile("mongo"));

// A file is opened by Deck as `<scheme>:<absolute path>`; a server's url goes as it is.
assert.equal(q.connectUrl("sqlite", "C:\\data\\a.db"), "sqlite:C:\\data\\a.db");
assert.equal(q.connectUrl("duckdb", "D:/x.duckdb"), "duckdb:D:/x.duckdb");
assert.equal(q.connectUrl("redis", "redis://h:6379/0"), "redis://h:6379/0");

// Quoting: SQL Server brackets (a ] doubled), DuckDB the standard double quote.
assert.equal(q.quoteFor("mssql", "order"), "[order]");
assert.equal(q.quoteFor("mssql", "a]b"), "[a]]b]", "a closing bracket is doubled");
assert.equal(q.quoteFor("duckdb", 'we"ird'), '"we""ird"');
assert.equal(q.quoteFor("redis", "user:*"), "user:*", "Redis has nothing to quote");

// Previews, one per engine's language.
assert.equal(q.previewFor("mssql", "t"), "select top 200 * from [t];");
assert.equal(q.previewFor("duckdb", "t"), 'select * from "t" limit 200;');
assert.equal(q.previewFor("redis", "user:*"), "SCAN 0 MATCH user:*", "a key group's name is its MATCH pattern");
assert.equal(q.previewFor("redis", 'my key*'), 'SCAN 0 MATCH "my key*"', "a pattern with a space is quoted");
assert.equal(q.previewFor("redis", 'a"b'), 'SCAN 0 MATCH "a\\"b"', "and a quote in it escaped");
assert.deepEqual(JSON.parse(q.previewFor("mongo", "users")), { find: "users", limit: 200 });
assert.equal(Object.keys(JSON.parse(q.previewFor("mongo", "users")))[0], "find", "the command name comes first");

assert.equal(q.countFor("redis", "user:*"), null, "a Redis group has no count query");
assert.deepEqual(JSON.parse(q.countFor("mongo", "users")), { count: "users" });
assert.equal(q.countFor("mssql", "t"), "select count(*) from [t]");

assert.equal(
  q.lookupFor("mssql", { table: "o", column: "c", refTable: "customers", refColumn: "id" }, 7),
  "select * from [customers] where [id] = 7;",
);

// What one run sends: SQL is split, a Redis or MongoDB command is one thing whatever it holds.
assert.deepEqual(q.statementsFor("sqlite", "select 1; select 2"), ["select 1", "select 2"]);
assert.deepEqual(q.statementsFor("mongo", ' {"find": "a;b"} '), ['{"find": "a;b"}'], "a ; in JSON does not split");
assert.deepEqual(q.statementsFor("redis", "SET a 1; GET a"), ["SET a 1; GET a"]);
assert.deepEqual(q.statementsFor("redis", "   "), []);

assert.equal(q.editorLanguage("mongo"), "json");
assert.equal(q.editorLanguage("redis"), "plaintext");
assert.equal(q.editorLanguage("mssql"), "sql");

// Editing is SQL only, and says why not.
for (const e of SQL_ENGINES) assert.equal(q.engineEditBlock(e), null);
assert.match(q.engineEditBlock("redis") ?? "", /command/);
assert.match(q.engineEditBlock("mongo") ?? "", /command/);

// Explain: unavailable on SQL Server, Redis and MongoDB; plain EXPLAIN on DuckDB.
assert.equal(q.explainFor("mssql", "select 1"), null);
assert.equal(q.explainFor("redis", "GET a"), null);
assert.equal(q.explainFor("mongo", "{}"), null);
assert.equal(q.explainFor("duckdb", "select 1;"), "explain select 1");

// Format: each SQL engine in its own dialect; the others are not SQL.
assert.match(q.formatSql("mssql", "select [a b] from t"), /\[a b\]/, "SQL Server's brackets survive");
assert.match(q.formatSql("duckdb", "select x::int from t"), /x::int/);
assert.throws(() => q.formatSql("redis", "GET a"), /not SQL/);

// Export on SQL Server: N'' strings and bits as 1 and 0.
assert.equal(
  q.toInserts("mssql", "t", { columns: ["n", "b"], rows: [["it's", true]], total: 1, truncated: false }),
  "insert into [t] ([n], [b]) values (N'it''s', 1);",
);

// Structure on the engines that differ.
{
  const ms = q.structureQueries("mssql", "o'k");
  assert.match(ms.indexes, /quotename\(N'o''k'\)/, "the table name is a literal, quote doubled");
  assert.equal(ms.create, null);
  const dk = q.structureQueries("duckdb", "t");
  assert.match(dk.indexes, /duckdb_indexes\(\)/);
  assert.deepEqual(q.structureQueries("redis", "user:*"), { defaults: null, indexes: null, create: null });
  const mg = q.structureQueries("mongo", "users");
  assert.deepEqual(JSON.parse(mg.indexes), { listIndexes: "users" });
  assert.equal(mg.defaults, null);
  // MongoDB's listIndexes: the key document names the fields, `unique` is its own field.
  const mix = q.parseIndexes({
    columns: ["v", "key", "name", "unique"],
    rows: [[2, '{"_id":1}', "_id_", null], [2, '{"email":1,"at":-1}', "email_1_at_-1", true]],
    total: 2, truncated: false,
  });
  assert.deepEqual(mix.map((i) => [i.name, i.unique, i.columns]), [["_id_", false, ["_id"]], ["email_1_at_-1", true, ["email", "at"]]]);
  // DuckDB: a flag and a definition, the columns read from the definition.
  const dix = q.parseIndexes({
    columns: ["name", "uniq", "definition"],
    rows: [["ix", false, "CREATE INDEX ix ON t(a, b);"]], total: 1, truncated: false,
  });
  assert.deepEqual(dix.map((i) => [i.name, i.unique, i.columns]), [["ix", false, ["a", "b"]]]);
}

// ---- paging ---------------------------------------------------------------------------------
{
  const first = { columns: ["a"], rows: [[1], [2]], total: 2, truncated: true };
  const more = q.appendPage(first, { columns: ["a"], rows: [[3]], total: 1, truncated: false });
  assert.deepEqual(more.rows, [[1], [2], [3]], "the next page goes after the rows on hand");
  assert.equal(more.total, 3);
  assert.equal(more.truncated, false, "whether more exist is the new page's to say");
  assert.deepEqual(first.rows, [[1], [2]], "the earlier result is not changed");
}

// ---- the generated SQL runs -----------------------------------------------------------------
// On a real SQLite, against names that need quoting: a preview, a count and a foreign-key follow.
{
  mem.exec(`create table "we""ird" (id integer primary key, note text);
    insert into "we""ird" (note) values ('a'), ('it''s');`);
  assert.equal(runMem(q.previewFor("sqlite", 'we"ird')).rows.length, 2);
  assert.equal(runMem(q.countFor("sqlite", 'we"ird')).rows[0][0], 2);
  const fk = { table: "x", column: "y", refTable: 'we"ird', refColumn: "note" };
  assert.equal(runMem(q.lookupFor("sqlite", fk, "it's")).rows.length, 1, "a text key with a quote finds its row");
  // An exported INSERT puts the rows back exactly.
  const r = runMem(`select * from "we""ird"`);
  mem.exec(`delete from "we""ird"`);
  mem.exec(q.toInserts("sqlite", 'we"ird', r));
  assert.deepEqual(runMem(`select * from "we""ird"`).rows, r.rows);
}
mem.close();

console.log("db: ok");
