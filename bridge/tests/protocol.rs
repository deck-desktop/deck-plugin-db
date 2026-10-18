//! The built program over real pipes, as the plugin runs it: a line in, a line out with the same
//! id, and an exit once stdin closes.
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

#[test]
fn speaks_json_lines_and_exits_when_stdin_closes() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_deck-db-bridge"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let mut ready = String::new();
    output.read_line(&mut ready).unwrap();
    assert_eq!(ready.trim(), format!(r#"{{"ready":"{}"}}"#, env!("CARGO_PKG_VERSION")));

    writeln!(input, r#"{{"id":41,"op":"query","handle":9,"sql":"GET a"}}"#).unwrap();
    writeln!(input).unwrap();
    writeln!(input, r#"{{"id":42,"op":"nope"}}"#).unwrap();
    let mut replies: Vec<serde_json::Value> = (0..2)
        .map(|_| {
            let mut line = String::new();
            output.read_line(&mut line).unwrap();
            serde_json::from_str(&line).unwrap()
        })
        .collect();
    // Requests run concurrently, so replies may come back in either order.
    replies.sort_by_key(|r| r["id"].as_u64());
    assert_eq!(replies[0], serde_json::json!({ "id": 41, "err": "that connection is closed" }));
    assert_eq!(replies[1]["id"], 42);

    drop(input);
    let status = child.wait().unwrap();
    assert!(status.success());
}
