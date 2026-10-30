# deck-db-bridge

`deck-db-bridge.exe` is a Rust program holding the SQL Server, Redis and MongoDB drivers for the
Databases plugin. They are not in Deck because they would grow deck.exe by about half for engines
most people never open. The plugin downloads the program from this repository's GitHub releases
the first time one of those engines is connected to (after asking), checks it against the SHA-256
pinned in `../src/helper.ts`, keeps it in the plugin's data folder and runs it with `procStream`.
It speaks one JSON object per line on stdin and stdout; `src/main.rs` describes the protocol.

## Build and test

In this folder:

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

## Release

To release a new version: bump `version` in `Cargo.toml`, build it, publish
`target/release/deck-db-bridge.exe` as a release tagged `bridge-v<version>`, and set `HELPER` in
`../src/helper.ts` to that version, its download url and the exe's SHA-256. Each version installs
into its own folder, so a plugin update that names a new one downloads it on the next connect.
