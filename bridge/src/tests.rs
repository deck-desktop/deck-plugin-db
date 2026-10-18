//! The engines end to end, through the same four calls the protocol makes.
//!
//! Each expects a disposable local server (the urls below), so each is `#[ignore]`d and a plain
//! `cargo test` needs none of them; run them with `cargo test -- --ignored`. Each creates its own
//! data first. The Docker commands that start the three servers are in the README.
use super::*;

/// One runtime for every call, as in the program: Redis's and MongoDB's clients run background
/// tasks on the runtime that connected them, and stop with it.
fn block<T>(f: impl std::future::Future<Output = T>) -> T {
    static RT: std::sync::OnceLock<tokio::runtime::Runtime> = std::sync::OnceLock::new();
    RT.get_or_init(|| tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap()).block_on(f)
}

fn q(h: u32, sql: &str, read_only: bool, skip: u32) -> Result<QueryResult, String> {
    block(db_query(h, sql.into(), read_only, Some(skip)))
}

/// Run a write that must succeed.
fn w(h: u32, sql: &str) -> QueryResult {
    q(h, sql, false, 0).unwrap_or_else(|e| panic!("{sql}: {e}"))
}
fn table<'a>(s: &'a SchemaInfo, name: &str) -> &'a TableInfo {
    s.tables.iter().find(|t| t.name == name).unwrap_or_else(|| panic!("no table {name}"))
}

fn column<'a>(t: &'a TableInfo, name: &str) -> &'a ColumnInfo {
    t.columns.iter().find(|c| c.name == name).unwrap_or_else(|| panic!("no column {name} in {}", t.name))
}

fn has_fk(s: &SchemaInfo, table: &str, column: &str, ref_table: &str, ref_column: &str) -> bool {
    s.foreign_keys.iter().any(|f| {
        f.table == table && f.column == column && f.ref_table == ref_table && f.ref_column == ref_column
    })
}

/// The paging contract, the same on every engine: 1500 rows of 1..=1500 come as a capped page
/// and then the rest.
fn assert_pages(first: QueryResult, second: QueryResult) {
    assert_eq!(first.rows.len(), ROW_CAP);
    assert!(first.truncated);
    assert_eq!(first.rows[0][0], serde_json::json!(1));
    assert_eq!(second.rows.len(), 500);
    assert!(!second.truncated);
    assert_eq!(second.rows[0][0], serde_json::json!(1001));
    assert_eq!(second.rows[499][0], serde_json::json!(1500));
}


#[test]
#[ignore = "needs a local SQL Server: mssql://sa:DeckTest!2026@127.0.0.1:14330"]
fn mssql_end_to_end() {
    let server = "mssql://sa:DeckTest!2026@127.0.0.1:14330";
    let master = block(db_connect(format!("{server}/master?trustServerCertificate=true"))).unwrap();
    w(master, "IF DB_ID('deckbridgetest') IS NULL CREATE DATABASE deckbridgetest");
    block(db_disconnect(master)).unwrap();

    let h = block(db_connect(format!("{server}/deckbridgetest?trustServerCertificate=true"))).unwrap();
    w(
        h,
        "IF OBJECT_ID('orders') IS NOT NULL DROP TABLE orders;
         IF OBJECT_ID('customers') IS NOT NULL DROP TABLE customers;
         CREATE TABLE customers (id int PRIMARY KEY, name nvarchar(50) NOT NULL, joined datetime2,
           balance decimal(10, 2), vip bit, raw varbinary(16), uid uniqueidentifier);
         CREATE TABLE orders (id int PRIMARY KEY, customer_id int NOT NULL REFERENCES customers(id),
           total float);
         INSERT INTO customers VALUES
           (1, N'Ada', '2026-01-02 03:04:05', 12.50, 1, 0x00FF10, '6F9619FF-8B86-D011-B42D-00C04FC964FF'),
           (2, N'Grace', NULL, NULL, 0, NULL, NULL);
         INSERT INTO orders (id, customer_id, total)
           SELECT TOP 1500 ROW_NUMBER() OVER (ORDER BY (SELECT NULL)), 1 + ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) % 2, 9.5
           FROM sys.all_objects a CROSS JOIN sys.all_objects b;",
    );

    // Paging, and a page cut short at the cap leaves the connection usable: tiberius drains the
    // unread rows before the next request.
    let sql = "SELECT id FROM orders ORDER BY id";
    assert_pages(q(h, sql, true, 0).unwrap(), q(h, sql, true, 1000).unwrap());
    assert_eq!(q(h, "SELECT COUNT(*) AS n FROM orders", true, 0).unwrap().rows[0][0], serde_json::json!(1500));

    // Cells.
    let r = q(h, "SELECT id, name, joined, balance, vip, raw, uid FROM customers ORDER BY id", true, 0).unwrap();
    assert_eq!(r.columns, ["id", "name", "joined", "balance", "vip", "raw", "uid"]);
    assert_eq!(r.rows[0][0], serde_json::json!(1));
    assert_eq!(r.rows[0][1], serde_json::json!("Ada"));
    assert_eq!(r.rows[0][2], serde_json::json!("2026-01-02 03:04:05"));
    assert_eq!(r.rows[0][3], serde_json::json!("12.50"));
    assert_eq!(r.rows[0][4], serde_json::json!(true));
    assert_eq!(r.rows[0][5], serde_json::json!("0x00ff10 (3 bytes)"));
    assert_eq!(r.rows[0][6].as_str().unwrap().to_uppercase(), "6F9619FF-8B86-D011-B42D-00C04FC964FF");
    assert_eq!(r.rows[1][2], serde_json::Value::Null);

    // Read-only: a write runs inside a transaction that is always rolled back, even when it
    // returned rows that saw the change; COMMIT and ROLLBACK are refused before anything is sent.
    let inside = q(h, "DELETE FROM orders; SELECT COUNT(*) AS n FROM orders", true, 0).unwrap();
    assert_eq!(inside.rows[0][0], serde_json::json!(0));
    assert_eq!(q(h, "SELECT COUNT(*) AS n FROM orders", true, 0).unwrap().rows[0][0], serde_json::json!(1500));
    assert!(q(h, "DELETE FROM orders; COMMIT", true, 0).unwrap_err().contains("read-only"));
    assert!(q(h, "rollback; delete from orders", true, 0).is_err());
    // ...but the words inside a string or a comment are not the statement.
    assert!(q(h, "SELECT 'commit' AS a -- rollback", true, 0).is_ok());
    assert!(q(h, "SELECT 1 AS [commit]", true, 0).is_ok());
    // An error inside the transaction still ends it, and the connection carries on.
    assert!(q(h, "DELETE FROM orders; SELECT 1/0", true, 0).is_err());
    assert_eq!(q(h, "SELECT @@TRANCOUNT AS t, COUNT(*) AS n FROM orders", true, 0).unwrap().rows[0],
        [serde_json::json!(1), serde_json::json!(1500)]);
    assert_eq!(q(h, "SELECT @@TRANCOUNT AS t", false, 0).unwrap().rows[0][0], serde_json::json!(0));

    // Schema.
    let s = block(db_schema(h)).unwrap();
    let customers = table(&s, "customers");
    assert!(column(customers, "id").pk);
    assert!(column(customers, "name").not_null);
    assert_eq!(column(customers, "name").data_type, "nvarchar");
    assert!(!column(table(&s, "orders"), "customer_id").pk);
    assert!(has_fk(&s, "orders", "customer_id", "customers", "id"));
    block(db_disconnect(h)).unwrap();
}

#[test]
#[ignore = "needs a local Redis: redis://127.0.0.1:16379"]
fn redis_end_to_end() {
    // Database 15 of a disposable server, emptied first.
    let h = block(db_connect("redis://127.0.0.1:16379/15".into())).unwrap();
    w(h, "FLUSHDB");
    w(h, r#"SET "user:1:name" "Ada Lovelace""#);
    w(h, "HSET user:1 name Ada age 36");
    w(h, "RPUSH queue a b c");
    w(h, "SADD tags x y");
    w(h, "ZADD board 1 p 2 q");
    let mset: String = (1..=1200).map(|i| format!(" k:{i} {i}")).collect();
    w(h, &format!("MSET{mset}"));

    let r = q(h, "GET user:1:name", true, 0).unwrap();
    assert_eq!((r.columns.as_slice(), r.rows[0][0].clone()), (&["value".to_string()][..], serde_json::json!("Ada Lovelace")));
    assert_eq!(q(h, "GET nothing", true, 0).unwrap().rows, [[serde_json::Value::Null]]);
    assert_eq!(q(h, "STRLEN k:1", true, 0).unwrap().rows[0][0], serde_json::json!(1));
    let r = q(h, "HGETALL user:1", true, 0).unwrap();
    assert_eq!(r.columns, ["field", "value"]);
    assert_eq!(r.rows, [[serde_json::json!("name"), serde_json::json!("Ada")], [serde_json::json!("age"), serde_json::json!("36")]]);
    assert_eq!(q(h, "LRANGE queue 0 -1", true, 0).unwrap().rows.len(), 3);
    let r = q(h, "zrange board 0 -1 withscores", true, 0).unwrap();
    assert_eq!(r.rows, [[serde_json::json!("p"), serde_json::json!("1")], [serde_json::json!("q"), serde_json::json!("2")]]);
    assert_eq!(q(h, "CONFIG GET maxmemory", true, 0).unwrap().columns, ["field", "value"]);

    // SCAN follows its cursor itself, so a MATCH returns every match, paged like any query.
    let first = q(h, "SCAN 0 MATCH k:*", true, 0).unwrap();
    assert_eq!(first.rows.len(), ROW_CAP);
    assert!(first.truncated);
    let rest = q(h, "SCAN 0 MATCH k:* COUNT 100", true, 1000).unwrap();
    assert_eq!(rest.rows.len(), 200);
    assert!(!rest.truncated);

    // Read-only refuses anything not on the read list, before it is sent.
    for cmd in ["SET a b", "DEL user:1", "CONFIG SET maxmemory 1", "FLUSHDB", "EVAL \"return 1\" 0"] {
        let e = q(h, cmd, true, 0).unwrap_err();
        assert!(e.contains("read-only"), "{cmd}: {e}");
    }
    assert_eq!(q(h, "EXISTS user:1", true, 0).unwrap().rows[0][0], serde_json::json!(1));

    let s = block(db_schema(h)).unwrap();
    let k = table(&s, "k:*");
    assert_eq!((k.columns.len(), column(k, "string").data_type.as_str()), (1, "1200 keys"));
    let user = table(&s, "user:*");
    assert_eq!(column(user, "string").data_type, "1 key");
    assert_eq!(column(user, "hash").data_type, "1 key");
    assert_eq!(table(&s, "queue").columns[0].name, "list");
    assert_eq!(table(&s, "board").columns[0].name, "zset");
    // A table's name is the pattern that lists its keys.
    assert_eq!(q(h, "SCAN 0 MATCH user:*", true, 0).unwrap().rows.len(), 2);
    block(db_disconnect(h)).unwrap();
}

#[test]
#[ignore = "needs a local MongoDB: mongodb://127.0.0.1:27018"]
fn mongo_end_to_end() {
    let h = block(db_connect("mongodb://127.0.0.1:27018/deckbridgetest".into())).unwrap();
    // Dropping a collection that is not there is an error worth ignoring here.
    let _ = q(h, r#"{"drop": "users"}"#, false, 0);
    let _ = q(h, r#"{"drop": "orders"}"#, false, 0);
    let users: Vec<String> = (1..=1500)
        .map(|i| format!(r#"{{"n": {i}, "name": "user {i}", "tags": ["a"], "vip": {}}}"#, i % 2 == 0))
        .collect();
    w(h, &format!(r#"{{"insert": "users", "documents": [{}]}}"#, users.join(",")));
    w(
        h,
        r#"{"insert": "orders", "documents": [
            {"_id": {"$oid": "65a1f0c2e4b0a1b2c3d4e5f6"}, "user": 1, "total": {"$numberDecimal": "12.50"},
             "at": {"$date": "2026-01-02T03:04:05Z"}, "lines": [{"sku": "x", "qty": 2}]},
            {"user": 2, "total": 3, "note": "late"}]}"#,
    );

    // Paging through the cursor.
    let find = r#"{"find": "users", "sort": {"n": 1}, "projection": {"_id": 0, "n": 1}}"#;
    assert_pages(q(h, find, true, 0).unwrap(), q(h, find, true, 1000).unwrap());
    let r = q(h, r#"{"aggregate": "users", "pipeline": [{"$match": {"vip": true}}, {"$count": "c"}]}"#, true, 0).unwrap();
    assert_eq!(r.rows, [[serde_json::json!(750)]]);
    assert_eq!(q(h, r#"{"count": "users"}"#, true, 0).unwrap().rows[0][0], serde_json::json!(1500));
    assert_eq!(q(h, r#"{"distinct": "users", "key": "vip"}"#, true, 0).unwrap().rows.len(), 2);

    // Cells: `_id` first, the union of fields in the order first seen, nested values as JSON.
    let r = q(h, r#"{"find": "orders", "sort": {"user": 1}}"#, true, 0).unwrap();
    assert_eq!(r.columns, ["_id", "user", "total", "at", "lines", "note"]);
    assert_eq!(r.rows[0][0], serde_json::json!("65a1f0c2e4b0a1b2c3d4e5f6"));
    assert_eq!(r.rows[0][2], serde_json::json!("12.50"));
    assert_eq!(r.rows[0][3], serde_json::json!("2026-01-02T03:04:05Z"));
    assert_eq!(r.rows[0][4], serde_json::json!(r#"[{"sku":"x","qty":2}]"#));
    assert_eq!(r.rows[0][5], serde_json::Value::Null);
    assert_eq!(r.rows[1][5], serde_json::json!("late"));

    // Read-only refuses writes by name, and a pipeline that writes.
    for cmd in [
        r#"{"delete": "users", "deletes": [{"q": {}, "limit": 0}]}"#,
        r#"{"aggregate": "users", "pipeline": [{"$out": "copy"}]}"#,
        r#"{"drop": "users"}"#,
    ] {
        let e = q(h, cmd, true, 0).unwrap_err();
        assert!(e.contains("read-only"), "{cmd}: {e}");
    }
    assert_eq!(q(h, r#"{"count": "users"}"#, true, 0).unwrap().rows[0][0], serde_json::json!(1500));

    let s = block(db_schema(h)).unwrap();
    let orders = table(&s, "orders");
    assert!(column(orders, "_id").pk);
    assert_eq!(column(orders, "_id").data_type, "objectId");
    assert_eq!(column(orders, "total").data_type, "number");
    assert_eq!(column(orders, "at").data_type, "date");
    assert_eq!(column(orders, "lines").data_type, "array");
    assert!(column(orders, "user").not_null);
    assert!(!column(orders, "note").not_null);
    assert_eq!(column(table(&s, "users"), "vip").data_type, "bool");
    block(db_disconnect(h)).unwrap();
}

#[test]
fn requests_and_their_replies() {
    let r: serde_json::Value = serde_json::from_str(&block(answer(r#"{"id":7,"op":"schema","handle":99}"#))).unwrap();
    assert_eq!(r, serde_json::json!({ "id": 7, "err": "that connection is closed" }));
    let r: serde_json::Value = serde_json::from_str(&block(answer(r#"{"id":"a","op":"drop"}"#))).unwrap();
    assert_eq!(r["err"], "unknown op \"drop\"");
    assert_eq!(r["id"], "a");
    let r: serde_json::Value = serde_json::from_str(&block(answer("not json"))).unwrap();
    assert!(r["id"].is_null() && r["err"].as_str().unwrap().starts_with("not a request"));
    let r: serde_json::Value = serde_json::from_str(&block(answer(r#"{"id":1,"op":"connect","url":"postgres://x"}"#))).unwrap();
    assert!(r["err"].as_str().unwrap().contains("mssql://"));
    // A request that leaves readOnly out cannot write.
    let req: Request = serde_json::from_str(r#"{"id":1,"op":"query","handle":1,"sql":"DEL a"}"#).unwrap();
    assert!(req.read_only);
}
