//! Redis, through one multiplexed `ConnectionManager` per handle (it reconnects by itself).
//!
//! `redis://[user][:pass@]host[:port][/db]`. No TLS (`rediss://`).
//!
//! **A query is one command line**, split like a shell would — `"..."` with backslash escapes,
//! `'...'` literally — so a key with a space is written `GET "my key"`. The reply becomes rows:
//!
//! | reply                                              | columns            | rows           |
//! |----------------------------------------------------|--------------------|----------------|
//! | a scalar (string, number, OK)                      | `value`            | one            |
//! | nil                                                | `value`            | one, null      |
//! | an array or set (LRANGE, SMEMBERS, KEYS, MGET)     | `value`            | one per item   |
//! | pairs (HGETALL, CONFIG GET, … WITHSCORES, a map)   | `field`, `value`   | one per pair   |
//!
//! An item that is itself an array (XRANGE's entries) is shown as compact JSON. SCAN, HSCAN, SSCAN
//! and ZSCAN follow the cursor themselves until it comes back to 0 or a page is full, so
//! `SCAN 0 MATCH user:*` returns every match (up to the cap) rather than one server-sized batch;
//! without a COUNT each step asks for 1000.
//!
//! **Read-only refuses any command not on READS**, before it is sent. Redis has no read-only
//! session of its own (READONLY is a cluster-replica routing flag), so the allowlist is the
//! guarantee: a command it does not name is refused, rather than a write being missed.
use std::time::Duration;

use redis::aio::{ConnectionManager, ConnectionManagerConfig};
use redis::Value;

use super::{blob, capped, float, stopped, ColumnInfo, QueryResult, SchemaInfo, TableInfo, QUERY_LIMIT, ROW_CAP};

#[derive(Clone)]
pub(super) struct Handle(ConnectionManager);

/// Commands that only read, by name; two-word ones (`CONFIG GET`) by both words.
const READS: &[&str] = &[
    "GET", "MGET", "GETRANGE", "STRLEN", "EXISTS", "TYPE", "TTL", "PTTL", "EXPIRETIME",
    "PEXPIRETIME", "KEYS", "SCAN", "RANDOMKEY", "DBSIZE", "PING", "ECHO", "INFO", "TIME",
    "LASTSAVE", "HGET", "HMGET", "HGETALL", "HKEYS", "HVALS", "HLEN", "HEXISTS", "HSTRLEN", "HSCAN",
    "HRANDFIELD", "LRANGE", "LLEN", "LINDEX", "LPOS", "SMEMBERS", "SCARD", "SISMEMBER",
    "SMISMEMBER", "SRANDMEMBER", "SSCAN", "SINTER", "SUNION", "SDIFF", "SINTERCARD", "ZRANGE",
    "ZRANGEBYSCORE", "ZRANGEBYLEX", "ZREVRANGE", "ZREVRANGEBYSCORE", "ZREVRANGEBYLEX", "ZCARD",
    "ZSCORE", "ZMSCORE", "ZRANK", "ZREVRANK", "ZCOUNT", "ZLEXCOUNT", "ZSCAN", "ZRANDMEMBER",
    "XRANGE", "XREVRANGE", "XLEN", "GETBIT", "BITCOUNT", "BITPOS", "GEOPOS", "GEODIST", "GEOHASH",
    "GEOSEARCH", "SORT_RO", "MEMORY USAGE", "MEMORY STATS", "CONFIG GET", "OBJECT ENCODING",
    "OBJECT FREQ", "OBJECT IDLETIME", "OBJECT REFCOUNT", "XINFO STREAM", "XINFO GROUPS",
    "XINFO CONSUMERS", "CLIENT LIST", "CLIENT INFO", "SLOWLOG GET", "SLOWLOG LEN",
];

/// Replies that are alternating field, value — when they come as a flat array (RESP2).
fn paired(name: &str, args: &[String]) -> bool {
    matches!(name, "HGETALL" | "CONFIG" | "HSCAN" | "ZSCAN")
        || args.iter().any(|a| a.eq_ignore_ascii_case("WITHSCORES") || a.eq_ignore_ascii_case("WITHVALUES"))
}

pub(super) async fn connect(url: &str) -> Result<Handle, String> {
    let client = redis::Client::open(url).map_err(|e| e.to_string())?;
    let config = ConnectionManagerConfig::new()
        .set_connection_timeout(Some(Duration::from_secs(20)))
        // The default is 500ms, which a KEYS on a large database or a slow link exceeds.
        .set_response_timeout(Some(QUERY_LIMIT))
        .set_number_of_retries(2);
    let conn = ConnectionManager::new_with_config(client, config).await.map_err(|e| e.to_string())?;
    Ok(Handle(conn))
}

/// A command line as words: `"..."` with backslash escapes, `'...'` literally, else whitespace.
fn split(line: &str) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    let mut chars = line.chars().peekable();
    loop {
        while chars.peek().is_some_and(|c| c.is_whitespace()) {
            chars.next();
        }
        let Some(&first) = chars.peek() else { return Ok(out) };
        let mut word = String::new();
        if first == '"' || first == '\'' {
            chars.next();
            loop {
                match chars.next() {
                    None => return Err(format!("a {first} is not closed")),
                    Some(c) if c == first => break,
                    Some('\\') if first == '"' => match chars.next() {
                        Some('n') => word.push('\n'),
                        Some('t') => word.push('\t'),
                        Some(c) => word.push(c),
                        None => return Err("the line ends in a backslash".into()),
                    },
                    Some(c) => word.push(c),
                }
            }
        } else {
            while let Some(&c) = chars.peek() {
                if c.is_whitespace() {
                    break;
                }
                word.push(c);
                chars.next();
            }
        }
        out.push(word);
    }
}

pub(super) async fn query(
    h: Handle,
    line: String,
    read_only: bool,
    skip: usize,
) -> Result<QueryResult, String> {
    let words = split(&line)?;
    let (first, args) = words.split_first().ok_or("type a command, e.g. GET key")?;
    let name = first.to_ascii_uppercase();
    if read_only {
        let two = args.first().map(|a| format!("{name} {}", a.to_ascii_uppercase()));
        if !READS.contains(&name.as_str()) && !two.is_some_and(|t| READS.contains(&t.as_str())) {
            return Err(format!("{name} is not a read, and the connection is read-only"));
        }
    }
    let mut conn = h.0;
    let run = async {
        if matches!(name.as_str(), "SCAN" | "HSCAN" | "SSCAN" | "ZSCAN") {
            scan(&mut conn, &name, args, skip + ROW_CAP + 1).await
        } else {
            redis::cmd(&name).arg(args).query_async::<Value>(&mut conn).await
        }
    };
    let reply = tokio::time::timeout(QUERY_LIMIT, run).await.map_err(|_| stopped())?.map_err(|e| e.to_string())?;
    let (columns, rows) = shape(reply, paired(&name, args));
    Ok(capped(columns, rows.into_iter().skip(skip).collect()))
}

/// Follow a SCAN-family cursor until it returns to 0 or `want` items are in hand. The items come
/// back as one array, as if the server had answered in a single reply.
async fn scan(
    conn: &mut ConnectionManager,
    name: &str,
    args: &[String],
    want: usize,
) -> redis::RedisResult<Value> {
    // SCAN's cursor is its first argument; the others' comes after the key.
    let at = if name == "SCAN" { 0 } else { 1 };
    let mut args = args.to_vec();
    if args.len() <= at {
        args.push("0".into());
    }
    if !args.iter().any(|a| a.eq_ignore_ascii_case("COUNT")) {
        args.extend(["COUNT".into(), "1000".into()]);
    }
    let mut items = Vec::new();
    loop {
        let (next, mut batch): (String, Vec<Value>) = redis::cmd(name).arg(&args).query_async(conn).await?;
        items.append(&mut batch);
        if next == "0" || items.len() >= want {
            return Ok(Value::Array(items));
        }
        args[at] = next;
    }
}

/// A reply as columns and rows; see the table in the module header.
fn shape(reply: Value, paired: bool) -> (Vec<String>, Vec<Vec<serde_json::Value>>) {
    let one = |v| (vec!["value".to_string()], vec![vec![v]]);
    let pairs = |items: Vec<(Value, Value)>| {
        let rows = items.into_iter().map(|(k, v)| vec![cell(k), cell(v)]).collect();
        (vec!["field".to_string(), "value".to_string()], rows)
    };
    match reply {
        Value::Map(items) => pairs(items),
        Value::Array(items) | Value::Set(items) if paired => {
            let mut it = items.into_iter();
            let mut out = Vec::new();
            while let (Some(k), Some(v)) = (it.next(), it.next()) {
                out.push((k, v));
            }
            pairs(out)
        }
        Value::Array(items) | Value::Set(items) => {
            (vec!["value".to_string()], items.into_iter().map(|v| vec![cell(v)]).collect())
        }
        other => one(cell(other)),
    }
}

fn cell(v: Value) -> serde_json::Value {
    use serde_json::Value as J;
    match v {
        Value::Nil => J::Null,
        Value::Int(i) => i.into(),
        Value::Double(f) => float(f),
        Value::Boolean(b) => J::Bool(b),
        Value::Okay => "OK".into(),
        Value::SimpleString(s) => s.into(),
        Value::VerbatimString { text, .. } => text.into(),
        Value::BulkString(b) => match String::from_utf8(b) {
            Ok(s) => s.into(),
            Err(e) => blob(e.as_bytes()),
        },
        // Without num-bigint, the number as the digits the server sent.
        Value::BigNumber(n) => J::String(String::from_utf8_lossy(&n).into_owned()),
        Value::Array(items) | Value::Set(items) => J::String(J::Array(items.into_iter().map(cell).collect()).to_string()),
        Value::Map(items) => J::String(
            J::Object(items.into_iter().map(|(k, v)| (text(cell(k)), cell(v))).collect()).to_string(),
        ),
        Value::ServerError(e) => J::String(format!("{e:?}")),
        other => J::String(format!("{other:?}")),
    }
}

fn text(v: serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s,
        other => other.to_string(),
    }
}

/// How many keys `db_schema` samples. A sample, not an inventory: a SCAN of millions of keys
/// would take as long as it sounds, and the groups it finds are what a sidebar can show.
const SAMPLE: usize = 2000;

/// Up to SAMPLE keys, grouped into "tables" by what comes before the first `:`.
///
/// Each table's `name` is the pattern that matches its keys — `user:*` for keys that start
/// `user:`, or the key itself for one with no `:` — so the plugin lists a table's keys with
/// `SCAN 0 MATCH <name>` whatever kind of table it is. Its `columns` are the key types seen in
/// it, one per type: `name` is the type (`string`, `hash`, `list`, `set`, `zset`, `stream`) and
/// `type` says how many sampled keys had it (`"12 keys"`). There are no foreign keys.
pub(super) async fn schema(h: Handle) -> Result<SchemaInfo, String> {
    let mut conn = h.0;
    let read = async {
        let keys = match scan(&mut conn, "SCAN", &["0".into(), "COUNT".into(), "500".into()], SAMPLE).await? {
            Value::Array(items) => items,
            _ => Vec::new(),
        };
        let keys: Vec<String> = keys.into_iter().take(SAMPLE).map(|k| text(cell(k))).collect();
        // One round trip for every TYPE, not one each.
        let mut pipe = redis::pipe();
        for k in &keys {
            pipe.cmd("TYPE").arg(k);
        }
        let types: Vec<String> =
            if keys.is_empty() { Vec::new() } else { pipe.query_async(&mut conn).await? };
        Ok::<_, redis::RedisError>(keys.into_iter().zip(types).collect::<Vec<_>>())
    };
    let keyed = tokio::time::timeout(QUERY_LIMIT, read).await.map_err(|_| stopped())?.map_err(|e| e.to_string())?;

    let mut groups: std::collections::BTreeMap<String, Vec<(String, usize)>> = Default::default();
    for (key, ty) in keyed {
        let name = match key.split_once(':') {
            Some((prefix, _)) => format!("{}:*", glob_escape(prefix)),
            None => glob_escape(&key),
        };
        let seen = groups.entry(name).or_default();
        match seen.iter_mut().find(|(t, _)| *t == ty) {
            Some((_, n)) => *n += 1,
            None => seen.push((ty, 1)),
        }
    }
    Ok(SchemaInfo {
        tables: groups
            .into_iter()
            .map(|(name, types)| TableInfo {
                name,
                kind: "table".into(),
                columns: types
                    .into_iter()
                    .map(|(t, n)| ColumnInfo {
                        data_type: format!("{n} {}", if n == 1 { "key" } else { "keys" }),
                        name: t,
                        not_null: false,
                        pk: false,
                    })
                    .collect(),
                sql: None,
            })
            .collect(),
        foreign_keys: Vec::new(),
    })
}

/// A key's text as a MATCH pattern that matches only itself.
fn glob_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '*' | '?' | '[' | ']' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::split;

    #[test]
    fn split_reads_quotes_like_a_shell() {
        assert_eq!(split(r#"SET "my key" 'it''s' a\b"#).unwrap(), ["SET", "my key", "it", "s", r"a\b"]);
        assert_eq!(split(r#"GET "a \"b\" \\ c""#).unwrap(), ["GET", r#"a "b" \ c"#]);
        assert!(split(r#"GET "open"#).is_err());
    }
}
