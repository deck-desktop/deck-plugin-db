# Databases

Browse SQLite files, Postgres, MySQL, SQL Server, Redis and MongoDB, and run queries against them.
SQLite, Postgres and MySQL are opened by Deck itself (its db_* commands), a file in place: with
writes allowed, a write is saved to the file. SQL Server, Redis and MongoDB are opened by a helper
program the plugin downloads the first time you connect to one (see below).

Tables, columns, row counts and a query editor with tabs, saved queries, history, Format
(Shift+Alt+F, by sql-formatter in the engine's dialect) and Explain. Results load 1,000 rows at
a time (Load more for the next page), can be sorted, copied or saved as CSV, JSON or INSERT
statements, read a cell at a time in the value panel (Ctrl+C copies the picked cell, Space or
Enter opens the panel), and - where the query maps to a single table with a key - edited in place.
A table's Structure view shows its columns, defaults, foreign keys in and out, indexes and CREATE
statement.

## The read-only guard

A connection can be opened read-only, and then anything that would write is refused before it is
sent. That check is `isReadOnly` in `src/db.ts` and it is tested, because the whole value of the
setting is that it cannot be talked around by a cleverly shaped statement.

Statement splitting is its own problem - a semicolon inside a string literal is not a statement
boundary - and is tested for the same reason.

## The helper program

`bridge/` is `deck-db-bridge.exe`, a Rust program holding the SQL Server, Redis and MongoDB drivers.
They are not in Deck because they would grow deck.exe by about half for engines most people never
open. The plugin downloads the program from this repository's GitHub releases the first time one
of those engines is connected to (after asking), checks it against the SHA-256 pinned in
`src/helper.ts`, keeps it in the plugin's data folder and runs it with `procStream`. It speaks
one JSON object per line on stdin and stdout; `bridge/src/main.rs` describes the protocol.

Build and test it in `bridge/`:

```sh
cargo test                       # the protocol, the read-only checks, the Redis command splitter
cargo test -- --ignored          # each engine end to end, against the local servers below
cargo build --release            # target/release/deck-db-bridge.exe
```

The end-to-end tests expect disposable servers on these ports, and create their own data in
`deckbridgetest` (Redis database 15):

```sh
docker run -d --name deck-test-mssql -p 14330:1433 -e ACCEPT_EULA=Y -e "MSSQL_SA_PASSWORD=DeckTest!2026" mcr.microsoft.com/mssql/server:2022-latest
docker run -d --name deck-test-redis -p 16379:6379 redis:7-alpine
docker run -d --name deck-test-mongo -p 27018:27017 mongo:7
```

To release a new version: bump `version` in `bridge/Cargo.toml`, build it, publish
`target/release/deck-db-bridge.exe` as a release tagged `bridge-v<version>`, and set `HELPER` in
`src/helper.ts` to that version, its download url and the exe's SHA-256. Each version installs
into its own folder, so a plugin update that names a new one downloads it on the next connect.

## What it exports

| Export | Where it renders |
|---|---|
| `default` | the tab: schema browser and query editor |
| `dispose` | stops the helper program before a reload |

## Checks

```sh
npm test
```

Statement splitting and the read-only guard.

## Build

```sh
npm run build
```

## Install

Copy `plugin.json` and `plugin.js` into `%APPDATA%\Deck\plugins\db\` (`Deck-Dev` for a
debug build) and restart Deck.
