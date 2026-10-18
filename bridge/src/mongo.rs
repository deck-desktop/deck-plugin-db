//! MongoDB, through the official driver (one `Client`, which is its own pool, per handle).
//!
//! `mongodb://…` or `mongodb+srv://…`, the database named in the path; with none, `test`, as
//! mongosh does.
//!
//! **A query is one command document, as JSON** (extended JSON, so `{"$oid": "…"}` and
//! `{"$date": "…"}` work), run against the database: `{"find": "users", "filter": {"age":
//! {"$gt": 30}}, "limit": 50}` or `{"aggregate": "orders", "pipeline": [...]}` (the `cursor`
//! field may be left out). A reply with a cursor (find, aggregate, listCollections,
//! listIndexes) is followed through getMore until a page is full; its documents are the rows,
//! and the columns are every top-level field in the order first seen, `_id` first. A nested
//! value is shown as compact JSON, an ObjectId as its hex, a date as ISO-8601. `distinct`'s
//! values are one row each; any other reply is one row.
//!
//! **Read-only refuses any command not on READS**, by its name (the document's first key), and
//! an aggregate whose pipeline writes ($out, $merge — which can only be top-level stages).
//! `explain` is judged by the command it explains. MongoDB has no read-only session of its own,
//! so the allowlist is the guarantee: what it does not name is refused.
use futures_util::StreamExt;
use mongodb::bson::{doc, Bson, Document};
use mongodb::options::ClientOptions;
use mongodb::{Client, Database};

use super::{blob, capped, first_rows, float, stopped, ColumnInfo, QueryResult, SchemaInfo, TableInfo, QUERY_LIMIT, ROW_CAP};

#[derive(Clone)]
pub(super) struct Handle(Database);

/// Commands that only read. Compared without case.
const READS: &[&str] = &[
    "find", "aggregate", "count", "distinct", "listCollections", "listIndexes", "collStats",
    "dbStats", "explain", "ping", "buildInfo", "hello",
];

/// Commands whose reply is a cursor.
const CURSORS: &[&str] = &["find", "aggregate", "listCollections", "listIndexes"];

fn is_in(list: &[&str], name: &str) -> bool {
    list.iter().any(|n| n.eq_ignore_ascii_case(name))
}

pub(super) async fn connect(url: &str) -> Result<Handle, String> {
    let mut opts = ClientOptions::parse(url).await.map_err(|e| e.to_string())?;
    opts.app_name = Some("Deck".into());
    // The driver's default is 30s per attempt; a wrong host should not look like a hang.
    opts.server_selection_timeout = Some(std::time::Duration::from_secs(20));
    let name = opts.default_database.clone().unwrap_or_else(|| "test".into());
    let db = Client::with_options(opts).map_err(|e| e.to_string())?.database(&name);
    // The client connects lazily; a ping is what makes a bad url fail at connect.
    db.run_command(doc! { "ping": 1 }).await.map_err(|e| e.to_string())?;
    Ok(Handle(db))
}

/// The command text as a document. Straight into a `Document`, never through `serde_json::Value`:
/// the command's name is its FIRST key, and a JSON map is free to reorder keys (serde_json's does,
/// unless a feature somewhere in the build happens to say otherwise). bson's own deserializer
/// keeps the order and reads extended JSON (`$oid`, `$date`, `$numberLong`) as it goes.
fn parse(text: &str) -> Result<Document, String> {
    serde_json::from_str::<Document>(text)
        .map_err(|e| format!("the command must be a JSON object, e.g. {{\"find\": \"users\"}}: {e}"))
}

/// Why `cmd` may not run on a read-only connection, if it may not.
fn refused(cmd: &Document) -> Option<String> {
    let (name, value) = cmd.iter().next()?;
    if !is_in(READS, name) {
        return Some(format!("{name} is not a read, and the connection is read-only"));
    }
    if name.eq_ignore_ascii_case("explain") {
        return match value {
            Bson::Document(inner) => refused(inner),
            _ => Some("explain takes the command it explains, as a document".into()),
        };
    }
    if name.eq_ignore_ascii_case("aggregate") {
        let writes = cmd.get_array("pipeline").map_or(false, |stages| {
            stages.iter().any(|s| {
                s.as_document().is_some_and(|d| d.contains_key("$out") || d.contains_key("$merge"))
            })
        });
        if writes {
            return Some("$out and $merge write, and the connection is read-only".into());
        }
    }
    None
}

pub(super) async fn query(
    h: Handle,
    text: String,
    read_only: bool,
    skip: usize,
) -> Result<QueryResult, String> {
    let mut cmd = parse(&text)?;
    let name = cmd.keys().next().cloned().ok_or("the command document is empty")?;
    if read_only {
        if let Some(why) = refused(&cmd) {
            return Err(why);
        }
    }
    let db = h.0;
    if is_in(CURSORS, &name) {
        if name.eq_ignore_ascii_case("aggregate") && !cmd.contains_key("cursor") {
            cmd.insert("cursor", Document::new());
        }
        let cursor = tokio::time::timeout(QUERY_LIMIT, db.run_cursor_command(cmd))
            .await
            .map_err(|_| stopped())?
            .map_err(|e| e.to_string())?;
        // Dropping the cursor at the cap kills it on the server.
        let docs = first_rows(cursor.boxed(), skip).await?;
        return Ok(rows(docs));
    }
    let reply = tokio::time::timeout(QUERY_LIMIT, db.run_command(cmd))
        .await
        .map_err(|_| stopped())?
        .map_err(|e| e.to_string())?;
    if name.eq_ignore_ascii_case("distinct") {
        if let Ok(values) = reply.get_array("values") {
            let rows = values.iter().skip(skip).take(ROW_CAP + 1).map(|v| vec![cell(v)]).collect();
            return Ok(capped(vec!["value".into()], rows));
        }
    }
    Ok(rows(if skip == 0 { vec![reply] } else { Vec::new() }))
}

/// Documents as rows: every top-level field, `_id` first, then in the order first seen.
fn rows(docs: Vec<Document>) -> QueryResult {
    let mut columns: Vec<String> = Vec::new();
    if docs.iter().any(|d| d.contains_key("_id")) {
        columns.push("_id".into());
    }
    for d in &docs {
        for k in d.keys() {
            if !columns.contains(k) {
                columns.push(k.clone());
            }
        }
    }
    let rows = docs
        .iter()
        .map(|d| columns.iter().map(|c| d.get(c).map_or(serde_json::Value::Null, cell)).collect())
        .collect();
    capped(columns, rows)
}

fn cell(v: &Bson) -> serde_json::Value {
    use serde_json::Value as J;
    match v {
        Bson::Null | Bson::Undefined => J::Null,
        Bson::Boolean(b) => J::Bool(*b),
        Bson::Int32(i) => (*i).into(),
        Bson::Int64(i) => (*i).into(),
        Bson::Double(f) => float(*f),
        Bson::String(s) => s.clone().into(),
        Bson::ObjectId(o) => o.to_hex().into(),
        Bson::DateTime(d) => d.try_to_rfc3339_string().map(J::String).unwrap_or_else(|_| d.timestamp_millis().into()),
        // Exact digits: Decimal128 is what money is stored as.
        Bson::Decimal128(d) => d.to_string().into(),
        Bson::Binary(b) => blob(&b.bytes),
        Bson::Symbol(s) => s.clone().into(),
        other => J::String(other.clone().into_relaxed_extjson().to_string()),
    }
}

/// A field's type, for the sidebar. Every number type is one "number", as the grid shows them.
fn kind(v: &Bson) -> &'static str {
    match v {
        Bson::String(_) | Bson::Symbol(_) => "string",
        Bson::Int32(_) | Bson::Int64(_) | Bson::Double(_) | Bson::Decimal128(_) => "number",
        Bson::Boolean(_) => "bool",
        Bson::Document(_) => "object",
        Bson::Array(_) => "array",
        Bson::DateTime(_) | Bson::Timestamp(_) => "date",
        Bson::ObjectId(_) => "objectId",
        Bson::Binary(_) => "binary",
        Bson::Null | Bson::Undefined => "null",
        _ => "other",
    }
}

/// How many documents of each collection `db_schema` reads to guess its fields.
const SAMPLE: i64 = 50;

/// Every collection and view (`system.*` hidden), each as a "table" whose columns are the
/// top-level fields of its first SAMPLE documents: `type` the kind of value seen (`string`,
/// `number`, `bool`, `object`, `array`, `date`, `objectId`, `binary`, or `mixed` when it
/// differs between documents), `notNull` when every sampled document has it, `pk` for `_id`.
/// The plugin browses one with `{"find": "<name>", "limit": N}`. No foreign keys.
pub(super) async fn schema(h: Handle) -> Result<SchemaInfo, String> {
    let db = h.0;
    let read = async {
        let mut specs: Vec<_> = db
            .list_collections()
            .await?
            .collect::<Vec<_>>()
            .await
            .into_iter()
            .collect::<Result<Vec<_>, _>>()?;
        specs.retain(|s| !s.name.starts_with("system."));
        specs.sort_by(|a, b| a.name.cmp(&b.name));
        // Sampled concurrently: each is a round trip, and they are independent.
        let samples = futures_util::future::try_join_all(specs.iter().map(|s| async {
            let docs: Vec<Document> =
                db.collection::<Document>(&s.name).find(doc! {}).limit(SAMPLE).await?.collect::<Vec<_>>().await
                    .into_iter()
                    .collect::<Result<_, _>>()?;
            Ok::<_, mongodb::error::Error>(docs)
        }))
        .await?;
        Ok::<_, mongodb::error::Error>((specs, samples))
    };
    let (specs, samples) =
        tokio::time::timeout(QUERY_LIMIT, read).await.map_err(|_| stopped())?.map_err(|e| e.to_string())?;
    let tables = specs
        .into_iter()
        .zip(samples)
        .map(|(spec, docs)| TableInfo {
            kind: if matches!(spec.collection_type, mongodb::results::CollectionType::View) {
                "view".into()
            } else {
                "table".into()
            },
            name: spec.name,
            columns: fields(&docs),
            sql: None,
        })
        .collect();
    Ok(SchemaInfo { tables, foreign_keys: Vec::new() })
}

fn fields(docs: &[Document]) -> Vec<ColumnInfo> {
    // (name, kind, documents that have a non-null value)
    let mut seen: Vec<(String, &'static str, usize)> = Vec::new();
    for d in docs {
        for (k, v) in d {
            let i = match seen.iter().position(|(n, ..)| n == k) {
                Some(i) => i,
                None => {
                    seen.push((k.clone(), "null", 0));
                    seen.len() - 1
                }
            };
            let entry = &mut seen[i];
            let now = kind(v);
            if now != "null" {
                entry.2 += 1;
                entry.1 = match entry.1 {
                    "null" => now,
                    was if was == now => was,
                    _ => "mixed",
                };
            }
        }
    }
    // `_id` first, as in the grid.
    seen.sort_by_key(|(n, ..)| n != "_id");
    seen.into_iter()
        .map(|(name, ty, present)| ColumnInfo {
            pk: name == "_id",
            not_null: !docs.is_empty() && present == docs.len(),
            data_type: ty.into(),
            name,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_only_refuses_writes() {
        let refuses = |j: &str| refused(&parse(j).unwrap()).is_some();
        // The name is the first key, even where it does not sort first.
        assert_eq!(parse(r#"{"find": "u", "filter": {}, "batchSize": 1}"#).unwrap().keys().next().unwrap(), "find");
        let id = parse(r#"{"find": "u", "filter": {"_id": {"$oid": "65a1f0c2e4b0a1b2c3d4e5f6"}}}"#).unwrap();
        assert!(matches!(id.get_document("filter").unwrap().get("_id"), Some(Bson::ObjectId(_))));
        assert!(!refuses(r#"{"find": "users", "filter": {"age": {"$gt": 3}}}"#));
        assert!(!refuses(r#"{"aggregate": "o", "pipeline": [{"$match": {}}], "cursor": {}}"#));
        assert!(refuses(r#"{"aggregate": "o", "pipeline": [{"$match": {}}, {"$out": "x"}]}"#));
        assert!(refuses(r#"{"aggregate": "o", "pipeline": [{"$merge": {"into": "x"}}]}"#));
        assert!(refuses(r#"{"delete": "users", "deletes": [{"q": {}, "limit": 0}]}"#));
        assert!(refuses(r#"{"insert": "users", "documents": [{}]}"#));
        assert!(refuses(r#"{"drop": "users"}"#));
        assert!(!refuses(r#"{"explain": {"find": "users"}}"#));
        assert!(refuses(r#"{"explain": {"delete": "users", "deletes": []}}"#));
    }
}
