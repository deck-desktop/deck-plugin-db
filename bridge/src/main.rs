//! deck-db-bridge: SQL Server, Redis and MongoDB for Deck's database plugin.
//!
//! | scheme                            | engine     | file          |
//! |-----------------------------------|------------|---------------|
//! | `mssql://`, `sqlserver://`        | SQL Server | `mssql.rs`    |
//! | `redis://`                        | Redis      | `redis_kv.rs` |
//! | `mongodb://`, `mongodb+srv://`    | MongoDB    | `mongo.rs`    |
//!
//! Deck itself opens Postgres, MySQL and SQLite. These three drivers took deck.exe from 35 MB to
//! 53 MB for engines most people never connect to, so they live here instead: a program the
//! plugin downloads the first time one of them is opened, and runs with Deck's `procStream`.
//!
//! **The protocol is one JSON object per line**, both ways. A request carries an `id` the plugin
//! chooses, and its reply carries the same `id`, so requests can overlap and replies come back in
//! whatever order they finish. The first line out, before any request, says the program is ready
//! and which version it is:
//!
//! ```text
//! < {"ready":"1.0.0"}
//! > {"id":1,"op":"connect","url":"redis://127.0.0.1:6379/0"}
//! < {"id":1,"ok":1}
//! > {"id":2,"op":"query","handle":1,"sql":"GET user:1","readOnly":true,"skip":0}
//! < {"id":2,"ok":{"columns":["value"],"rows":[["Ada"]],"total":1,"truncated":false,"affected":0}}
//! > {"id":3,"op":"disconnect","handle":1}
//! < {"id":3,"ok":null}
//! > {"id":4,"op":"schema","handle":1}
//! < {"id":4,"err":"that connection is closed"}
//! ```
//!
//! The four ops and their answers are Deck's own `dbConnect`, `dbQuery`, `dbSchema` and
//! `dbDisconnect`, shapes included, so the plugin treats both the same. `readOnly` defaults to
//! true: a request that forgets it cannot write. When stdin closes (Deck has gone, or the plugin
//! stopped it), the program exits.
//!
//! Every handle in the map is a cheap clone of something shared (a client, an `Arc`), so the map's
//! lock is only ever held to insert, remove or clone, never across a query.
use std::collections::HashMap;
use std::fmt::Display;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

/// How many rows one query returns. Matches ROW_CAP in the plugin and in Deck.
///
/// Enforced here and not only in the UI: `select * from` a ten-million-row table would otherwise
/// be read in full before the plugin saw any of it. Enforced while reading, not after: reading
/// stops one past the cap, which is how `truncated` is known.
const ROW_CAP: usize = 1000;

/// How long one query may run before it is dropped.
const QUERY_LIMIT: std::time::Duration = std::time::Duration::from_secs(120);

mod mongo;
mod mssql;
mod redis_kv;
#[cfg(test)]
mod tests;

/// Read rows `skip + 1 ..= skip + ROW_CAP + 1` of a stream, within QUERY_LIMIT.
///
/// The skipped rows are still read (no engine here can seek a result), but not kept. A hand loop
/// rather than `.skip().take()`: `skip` would swallow an error among the skipped rows, and a
/// stream that ends on an error would then read as an empty page instead of a failed query.
async fn first_rows<R, E: Display>(
    mut rows: futures_util::stream::BoxStream<'_, Result<R, E>>,
    skip: usize,
) -> Result<Vec<R>, String> {
    use futures_util::StreamExt;
    let read = async {
        let mut out = Vec::new();
        let mut seen = 0;
        while let Some(row) = rows.next().await {
            let row = row.map_err(|e| format!("{e}"))?;
            seen += 1;
            if seen > skip {
                out.push(row);
                if out.len() > ROW_CAP {
                    break;
                }
            }
        }
        Ok(out)
    };
    tokio::time::timeout(QUERY_LIMIT, read).await.map_err(|_| stopped())?
}

fn stopped() -> String {
    format!("the query was stopped after {}s", QUERY_LIMIT.as_secs())
}

/// A binary cell: its first bytes in hex and its length. Bytes in a grid help nobody, but the
/// start of a hash or of a uuid stored as bytes is recognisable.
fn blob(b: &[u8]) -> serde_json::Value {
    let head: String = b.iter().take(8).map(|x| format!("{x:02x}")).collect();
    let more = if b.len() > 8 { "…" } else { "" };
    serde_json::Value::String(format!("0x{head}{more} ({} bytes)", b.len()))
}

/// A float as a JSON number, or as text where JSON has no number for it (NaN, infinity).
fn float(v: f64) -> serde_json::Value {
    serde_json::Number::from_f64(v)
        .map(serde_json::Value::Number)
        .unwrap_or_else(|| serde_json::Value::String(v.to_string()))
}

static POOLS: Mutex<Option<HashMap<u32, Conn>>> = Mutex::new(None);
static NEXT_ID: Mutex<u32> = Mutex::new(1);

#[derive(Clone)]
enum Conn {
    Mssql(mssql::Handle),
    Redis(redis_kv::Handle),
    Mongo(mongo::Handle),
}

#[derive(Serialize, Debug)]
pub struct QueryResult {
    columns: Vec<String>,
    rows: Vec<Vec<serde_json::Value>>,
    /// Rows returned. When `truncated`, this is the cap rather than the true count.
    total: usize,
    truncated: bool,
    /// Rows changed by a write, which returns no rows of its own.
    affected: u64,
}

#[derive(Serialize)]
pub struct ColumnInfo {
    name: String,
    #[serde(rename = "type")]
    data_type: String,
    #[serde(rename = "notNull")]
    not_null: bool,
    pk: bool,
}

#[derive(Serialize)]
pub struct TableInfo {
    name: String,
    /// "table" or "view".
    kind: String,
    columns: Vec<ColumnInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sql: Option<String>,
}

#[derive(Serialize)]
pub struct ForeignKeyInfo {
    table: String,
    column: String,
    #[serde(rename = "refTable")]
    ref_table: String,
    #[serde(rename = "refColumn")]
    ref_column: String,
}

#[derive(Serialize)]
pub struct SchemaInfo {
    tables: Vec<TableInfo>,
    #[serde(rename = "foreignKeys")]
    foreign_keys: Vec<ForeignKeyInfo>,
}

fn take(handle: u32) -> Result<Conn, String> {
    let guard = POOLS.lock().map_err(|_| "the connection map is poisoned")?;
    let map = guard.as_ref().ok_or("that connection is closed")?;
    map.get(&handle).cloned().ok_or_else(|| "that connection is closed".into())
}

async fn db_connect(url: String) -> Result<u32, String> {
    let url = url.trim();
    let lower = url.to_lowercase();
    let conn = if lower.starts_with("mssql://") || lower.starts_with("sqlserver://") {
        Conn::Mssql(mssql::connect(url).await?)
    } else if lower.starts_with("redis://") {
        Conn::Redis(redis_kv::connect(url).await?)
    } else if lower.starts_with("mongodb://") || lower.starts_with("mongodb+srv://") {
        Conn::Mongo(mongo::connect(url).await?)
    } else {
        return Err("the url must start with mssql://, redis:// or mongodb://".into());
    };

    let id = {
        let mut next = NEXT_ID.lock().map_err(|_| "the id counter is poisoned")?;
        let id = *next;
        *next += 1;
        id
    };
    POOLS.lock().map_err(|_| "the connection map is poisoned")?.get_or_insert_with(HashMap::new).insert(id, conn);
    Ok(id)
}

/// Every engine here closes when the last clone of its handle drops: here, or when a query still
/// running on one finishes with it.
async fn db_disconnect(handle: u32) -> Result<(), String> {
    POOLS.lock().map_err(|_| "the connection map is poisoned")?.as_mut().and_then(|m| m.remove(&handle));
    Ok(())
}

/// Run one statement, returning up to ROW_CAP rows after skipping the first `skip`, which is how
/// the grid pages. What a statement is depends on the engine: SQL for SQL Server, a command line
/// for Redis (`HGETALL user:1`), a JSON command document for MongoDB (`{"find":"users"}`). How
/// `read_only` is enforced differs too, and each module's header says how.
async fn db_query(handle: u32, sql: String, read_only: bool, skip: Option<u32>) -> Result<QueryResult, String> {
    let skip = skip.unwrap_or(0) as usize;
    match take(handle)? {
        Conn::Mssql(h) => mssql::query(h, sql, read_only, skip).await,
        Conn::Redis(h) => redis_kv::query(h, sql, read_only, skip).await,
        Conn::Mongo(h) => mongo::query(h, sql, read_only, skip).await,
    }
}

async fn db_schema(handle: u32) -> Result<SchemaInfo, String> {
    match take(handle)? {
        Conn::Mssql(h) => mssql::schema(h).await,
        Conn::Redis(h) => redis_kv::schema(h).await,
        Conn::Mongo(h) => mongo::schema(h).await,
    }
}

/// The result of up to ROW_CAP + 1 rows: one past the cap is how `truncated` is known.
fn capped(columns: Vec<String>, mut rows: Vec<Vec<serde_json::Value>>) -> QueryResult {
    let truncated = rows.len() > ROW_CAP;
    rows.truncate(ROW_CAP);
    QueryResult { columns, total: rows.len(), rows, truncated, affected: 0 }
}

/// Fold the four schema queries into one answer: tables `[name, type, sql?]`, columns
/// `[table, column, type, is_nullable]`, primary keys `[table, column]`, foreign keys
/// `[table, column, ref table, ref column]`.
fn assemble(tables: &[Vec<String>], cols: &[Vec<String>], pks: &[Vec<String>], fks: &[Vec<String>]) -> SchemaInfo {
    let text = |r: &Vec<String>, i: usize| r.get(i).cloned().unwrap_or_default();
    let pk_set: std::collections::HashSet<(String, String)> = pks.iter().map(|r| (text(r, 0), text(r, 1))).collect();

    let mut by_table: HashMap<String, Vec<ColumnInfo>> = HashMap::new();
    for r in cols {
        let table = text(r, 0);
        let name = text(r, 1);
        let pk = pk_set.contains(&(table.clone(), name.clone()));
        by_table.entry(table).or_default().push(ColumnInfo {
            name,
            data_type: text(r, 2),
            not_null: text(r, 3).eq_ignore_ascii_case("NO"),
            pk,
        });
    }

    SchemaInfo {
        tables: tables
            .iter()
            .map(|r| {
                let name = text(r, 0);
                let columns = by_table.remove(&name).unwrap_or_default();
                TableInfo {
                    kind: if text(r, 1).to_uppercase().contains("VIEW") { "view".into() } else { "table".into() },
                    name,
                    columns,
                    sql: r.get(2).filter(|s| !s.is_empty()).cloned(),
                }
            })
            .collect(),
        foreign_keys: fks
            .iter()
            .map(|r| ForeignKeyInfo { table: text(r, 0), column: text(r, 1), ref_table: text(r, 2), ref_column: text(r, 3) })
            .collect(),
    }
}

fn yes() -> bool {
    true
}

#[derive(Deserialize)]
struct Request {
    id: serde_json::Value,
    op: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    handle: u32,
    #[serde(default)]
    sql: String,
    #[serde(default = "yes", rename = "readOnly")]
    read_only: bool,
    #[serde(default)]
    skip: Option<u32>,
}

/// One request line to its reply line.
async fn answer(line: &str) -> String {
    let req: Request = match serde_json::from_str(line) {
        Ok(r) => r,
        Err(e) => return serde_json::json!({ "id": null, "err": format!("not a request: {e}") }).to_string(),
    };
    let ok = |v: Result<serde_json::Value, String>| match v {
        Ok(v) => serde_json::json!({ "id": req.id, "ok": v }),
        Err(e) => serde_json::json!({ "id": req.id, "err": e }),
    };
    fn json<T: Serialize>(v: T) -> Result<serde_json::Value, String> {
        serde_json::to_value(v).map_err(|e| e.to_string())
    }
    ok(match req.op.as_str() {
        "connect" => db_connect(req.url.clone()).await.and_then(json),
        "query" => db_query(req.handle, req.sql.clone(), req.read_only, req.skip).await.and_then(json),
        "schema" => db_schema(req.handle).await.and_then(json),
        "disconnect" => db_disconnect(req.handle).await.and_then(json),
        other => Err(format!("unknown op {other:?}")),
    })
    .to_string()
}

#[tokio::main]
async fn main() {
    // One writer, so replies finishing at the same moment cannot interleave within a line.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        let mut out = tokio::io::stdout();
        while let Some(line) = rx.recv().await {
            let sent = async {
                out.write_all(line.as_bytes()).await?;
                out.write_all(b"\n").await?;
                out.flush().await
            };
            if sent.await.is_err() {
                // Nobody is reading: Deck has gone.
                std::process::exit(0);
            }
        }
    });
    // Said before any request is read: once the plugin sees it, Deck has the input pipe, so a
    // request written then cannot arrive before the program is there to take it.
    let _ = tx.send(serde_json::json!({ "ready": env!("CARGO_PKG_VERSION") }).to_string());
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let tx = tx.clone();
        // Each on its own task: a slow query on one connection must not hold up another's.
        tokio::spawn(async move {
            let _ = tx.send(answer(&line).await);
        });
    }
}
