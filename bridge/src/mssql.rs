//! SQL Server, through tiberius.
//!
//! `mssql://user:pass@host:port/database` (or `sqlserver://`). The port defaults to 1433. Query
//! options: `trustServerCertificate=true` accepts a self-signed certificate, which a local or
//! Docker server always has; `encrypt=false` encrypts only the login (`true`, the default,
//! encrypts everything). SQL logins only — no Windows integrated auth, no `host\instance` names.
//!
//! One connection per handle, behind an async lock: tiberius's client takes `&mut` for every
//! request, so queries on one handle run one after another. The lock is the handle's own, never
//! the handle map's. If a query fails for any reason other than the server refusing the SQL (a
//! timeout, a dropped socket), the connection may be mid-response and is thrown away; the next
//! query opens a fresh one from the kept `Config`.
//!
//! **Read-only is weaker here than on every other engine, and that is a fact about SQL Server.**
//! It has no session switch that refuses writes (`ApplicationIntent=ReadOnly` only routes to a
//! replica). So a read-only query runs as `BEGIN TRANSACTION; <sql>` and is always followed by
//! `IF @@TRANCOUNT > 0 ROLLBACK`, whatever happened — even after an error or a page cut short.
//! Text containing COMMIT or ROLLBACK (outside strings, comments and [names]) is refused before
//! it is sent, since either would end that transaction and let what follows commit. What a
//! rollback cannot undo, it cannot protect against: CREATE/ALTER DATABASE and BACKUP (which refuse
//! to run inside a transaction, so they fail — the safe direction), sequence and identity values,
//! `xp_cmdshell`, mail and other procedures with effects outside the database, and dynamic SQL
//! (`EXEC('COM' + 'MIT')`) that spells the forbidden words. It guards against an accident, not
//! against someone set on writing; a login granted only `db_datareader` is the real guarantee.
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use tiberius::{AuthMethod, Client, ColumnData, Config, EncryptionLevel, FromSql, QueryItem};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

use super::{assemble, blob, capped, float, stopped, QueryResult, SchemaInfo, QUERY_LIMIT, ROW_CAP};

type Conn = Client<Compat<TcpStream>>;

#[derive(Clone)]
pub(super) struct Handle {
    config: Arc<Config>,
    client: Arc<Mutex<Option<Conn>>>,
}

pub(super) async fn connect(url: &str) -> Result<Handle, String> {
    let config = parse(url)?;
    let client = open(&config).await?;
    Ok(Handle { config: Arc::new(config), client: Arc::new(Mutex::new(Some(client))) })
}

fn parse(url: &str) -> Result<Config, String> {
    let u = url::Url::parse(url).map_err(|e| format!("not a valid url: {e}"))?;
    let decode = |s: &str| {
        percent_decode(s).ok_or_else(|| "the url's user or password is not valid percent-encoding".to_string())
    };
    let mut c = Config::new();
    c.host(u.host_str().ok_or("the url has no host")?);
    c.port(u.port().unwrap_or(1433));
    let db = u.path().trim_start_matches('/');
    if !db.is_empty() {
        c.database(decode(db)?);
    }
    c.authentication(AuthMethod::sql_server(decode(u.username())?, decode(u.password().unwrap_or(""))?));
    c.application_name("Deck");
    for (k, v) in u.query_pairs() {
        let on = matches!(v.to_ascii_lowercase().as_str(), "true" | "yes" | "1");
        match k.to_ascii_lowercase().as_str() {
            "trustservercertificate" if on => c.trust_cert(),
            "encrypt" => c.encryption(if on { EncryptionLevel::Required } else { EncryptionLevel::Off }),
            _ => {}
        }
    }
    Ok(c)
}

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            out.push(u8::from_str_radix(s.get(i + 1..i + 3)?, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Connect, following one redirect: Azure SQL answers the first login with the address of the
/// node that actually holds the database.
async fn open(config: &Config) -> Result<Conn, String> {
    let mut config = config.clone();
    for _ in 0..2 {
        let tcp = tokio::time::timeout(Duration::from_secs(20), TcpStream::connect(config.get_addr()))
            .await
            .map_err(|_| "the server did not answer within 20s".to_string())?
            .map_err(|e| e.to_string())?;
        tcp.set_nodelay(true).map_err(|e| e.to_string())?;
        match Client::connect(config.clone(), tcp.compat_write()).await {
            Ok(c) => return Ok(c),
            Err(tiberius::error::Error::Routing { host, port }) => {
                config.host(&host);
                config.port(port);
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("the server redirected the connection more than once".into())
}

/// Whether the connection is still in step with the server after this error. A refused
/// statement is; anything else (a timeout cutting a response short, a dropped socket) may not be.
fn reusable(e: &tiberius::error::Error) -> bool {
    matches!(e, tiberius::error::Error::Server(_))
}

/// COMMIT or ROLLBACK as a word of the batch, outside strings, comments and bracketed names.
fn ends_transaction(sql: &str) -> bool {
    let b = sql.as_bytes();
    let mut i = 0;
    let mut word = String::new();
    let mut hit = false;
    let mut flush = |w: &mut String| {
        hit |= w.eq_ignore_ascii_case("commit") || w.eq_ignore_ascii_case("rollback");
        w.clear();
    };
    while i < b.len() {
        let c = b[i];
        let close = match c {
            b'\'' => Some(&b"'"[..]),
            b'"' => Some(&b"\""[..]),
            b'[' => Some(&b"]"[..]),
            b'-' if b.get(i + 1) == Some(&b'-') => Some(&b"\n"[..]),
            b'/' if b.get(i + 1) == Some(&b'*') => Some(&b"*/"[..]),
            _ => None,
        };
        if let Some(close) = close {
            flush(&mut word);
            // Skip to the closing marker. A doubled quote inside a string ('it''s') reads as
            // closing and reopening, which lands in the same place.
            let from = i + if close == b"*/" { 2 } else { 1 };
            i = sql[from..].find(std::str::from_utf8(close).unwrap()).map_or(b.len(), |p| from + p + close.len());
            continue;
        }
        if c.is_ascii_alphanumeric() || c == b'_' || c == b'@' || c == b'#' {
            word.push(c as char);
        } else {
            flush(&mut word);
        }
        i += 1;
    }
    flush(&mut word);
    hit
}

pub(super) async fn query(
    h: Handle,
    sql: String,
    read_only: bool,
    skip: usize,
) -> Result<QueryResult, String> {
    if read_only && ends_transaction(&sql) {
        return Err("the text contains the word COMMIT or ROLLBACK, which would end the read-only transaction; a column or table of that name is written [commit]"
            .into());
    }
    let mut slot = h.client.lock().await;
    if slot.is_none() {
        *slot = Some(open(&h.config).await?);
    }
    let client = slot.as_mut().expect("just filled");
    let text = if read_only { format!("BEGIN TRANSACTION;\n{sql}") } else { sql };
    let got = tokio::time::timeout(QUERY_LIMIT, rows(client, &text, skip)).await;
    let mut keep = match &got {
        Ok(Ok(_)) => true,
        Ok(Err(e)) => reusable(e),
        Err(_) => false,
    };
    if read_only && keep {
        // Always, after a page cut short or an error as much as after success. If it cannot be
        // sent, the connection is dropped below — and the server rolls back a transaction whose
        // connection has gone.
        let undo = async { client.simple_query("IF @@TRANCOUNT > 0 ROLLBACK").await?.into_results().await };
        if let Err(e) = undo.await {
            eprintln!("mssql: the read-only rollback failed, dropping the connection: {e}");
            keep = false;
        }
    }
    if !keep {
        *slot = None;
    }
    match got {
        Ok(Ok((columns, rows))) => Ok(capped(columns, rows)),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err(stopped()),
    }
}

/// The first result set that has columns, rows `skip + 1 ..= skip + ROW_CAP + 1` of it. What is
/// left unread is drained by tiberius before the connection's next request.
async fn rows(
    client: &mut Conn,
    sql: &str,
    skip: usize,
) -> tiberius::Result<(Vec<String>, Vec<Vec<serde_json::Value>>)> {
    let mut stream = client.simple_query(sql).await?;
    let mut columns: Option<(usize, Vec<String>)> = None;
    let mut out = Vec::new();
    let mut seen = 0;
    while let Some(item) = stream.next().await {
        match item? {
            QueryItem::Metadata(m) => match &columns {
                Some(_) => break,
                None => {
                    let names = m.columns().iter().map(|c| c.name().to_string()).collect();
                    columns = Some((m.result_index(), names));
                }
            },
            QueryItem::Row(r) => {
                if columns.as_ref().map(|c| c.0) != Some(r.result_index()) {
                    continue;
                }
                seen += 1;
                if seen <= skip {
                    continue;
                }
                out.push(r.cells().map(|(_, d)| cell(d)).collect());
                if out.len() > ROW_CAP {
                    break;
                }
            }
        }
    }
    Ok((columns.map(|c| c.1).unwrap_or_default(), out))
}

/// One cell as JSON. Integers, floats and bits as themselves; DECIMAL/NUMERIC as their exact
/// digits (it is the money type, and an f64 would round it — MONEY itself arrives as a float
/// from tiberius, so it is shown as one); dates as ISO-8601 so they sort as text the way they
/// sort in the database.
fn cell(d: &ColumnData<'static>) -> serde_json::Value {
    use serde_json::Value as J;
    let date = |s: Option<String>| s.map(J::String).unwrap_or(J::Null);
    match d {
        ColumnData::U8(v) => v.map(J::from).unwrap_or(J::Null),
        ColumnData::I16(v) => v.map(J::from).unwrap_or(J::Null),
        ColumnData::I32(v) => v.map(J::from).unwrap_or(J::Null),
        ColumnData::I64(v) => v.map(J::from).unwrap_or(J::Null),
        ColumnData::F32(v) => v.map(|f| float(f as f64)).unwrap_or(J::Null),
        ColumnData::F64(v) => v.map(float).unwrap_or(J::Null),
        ColumnData::Bit(v) => v.map(J::Bool).unwrap_or(J::Null),
        ColumnData::String(v) => v.as_ref().map(|s| J::String(s.to_string())).unwrap_or(J::Null),
        ColumnData::Guid(v) => v.map(|g| J::String(g.to_string())).unwrap_or(J::Null),
        ColumnData::Binary(v) => v.as_ref().map(|b| blob(b)).unwrap_or(J::Null),
        ColumnData::Numeric(v) => v.map(|n| J::String(n.to_string())).unwrap_or(J::Null),
        ColumnData::Xml(v) => v.as_ref().map(|x| J::String(x.to_string())).unwrap_or(J::Null),
        ColumnData::DateTime(_) | ColumnData::SmallDateTime(_) | ColumnData::DateTime2(_) => date(
            chrono::NaiveDateTime::from_sql(d)
                .ok()
                .flatten()
                .map(|t| t.format("%Y-%m-%d %H:%M:%S%.f").to_string()),
        ),
        ColumnData::Date(_) => date(chrono::NaiveDate::from_sql(d).ok().flatten().map(|t| t.to_string())),
        ColumnData::Time(_) => date(chrono::NaiveTime::from_sql(d).ok().flatten().map(|t| t.to_string())),
        ColumnData::DateTimeOffset(_) => date(
            chrono::DateTime::<chrono::FixedOffset>::from_sql(d).ok().flatten().map(|t| t.to_rfc3339()),
        ),
    }
}

/// Tables and views of the login's default schema (usually dbo), the way Postgres reads only
/// `current_schema()`. All four queries go in one batch: one round trip, four result sets.
pub(super) async fn schema(h: Handle) -> Result<SchemaInfo, String> {
    const BATCH: &str = "\
        select TABLE_NAME, TABLE_TYPE from INFORMATION_SCHEMA.TABLES \
         where TABLE_SCHEMA = SCHEMA_NAME() order by TABLE_TYPE, TABLE_NAME;\n\
        select TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE from INFORMATION_SCHEMA.COLUMNS \
         where TABLE_SCHEMA = SCHEMA_NAME() order by TABLE_NAME, ORDINAL_POSITION;\n\
        select kcu.TABLE_NAME, kcu.COLUMN_NAME from INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc \
         join INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu \
           on tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME and tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA \
         where tc.TABLE_SCHEMA = SCHEMA_NAME() and tc.CONSTRAINT_TYPE = 'PRIMARY KEY';\n\
        select tp.name, cp.name, tr.name, cr.name from sys.foreign_key_columns fkc \
         join sys.tables tp on tp.object_id = fkc.parent_object_id \
         join sys.columns cp on cp.object_id = fkc.parent_object_id and cp.column_id = fkc.parent_column_id \
         join sys.tables tr on tr.object_id = fkc.referenced_object_id \
         join sys.columns cr on cr.object_id = fkc.referenced_object_id and cr.column_id = fkc.referenced_column_id \
         where tp.schema_id = SCHEMA_ID();";
    let mut slot = h.client.lock().await;
    if slot.is_none() {
        *slot = Some(open(&h.config).await?);
    }
    let client = slot.as_mut().expect("just filled");
    let read = async {
        // By each row's result index rather than by position in a list of result sets, so an
        // empty set (a database with no foreign keys) cannot shift the others along.
        let mut sets: [Vec<Vec<String>>; 4] = Default::default();
        let mut stream = client.simple_query(BATCH).await?;
        while let Some(item) = stream.next().await {
            if let QueryItem::Row(r) = item? {
                if let Some(set) = sets.get_mut(r.result_index()) {
                    set.push(r.cells().map(|(_, d)| text(d)).collect());
                }
            }
        }
        Ok::<_, tiberius::error::Error>(sets)
    };
    match tokio::time::timeout(QUERY_LIMIT, read).await {
        Ok(Ok([tables, cols, pks, fks])) => Ok(assemble(&tables, &cols, &pks, &fks)),
        Ok(Err(e)) => {
            if !reusable(&e) {
                *slot = None;
            }
            Err(e.to_string())
        }
        Err(_) => {
            *slot = None;
            Err(stopped())
        }
    }
}

fn text(d: &ColumnData<'static>) -> String {
    match d {
        ColumnData::String(Some(s)) => s.to_string(),
        other => match cell(other) {
            serde_json::Value::String(s) => s,
            serde_json::Value::Null => String::new(),
            v => v.to_string(),
        },
    }
}
