# Databases

Browse SQLite and DuckDB files, Postgres, MySQL, SQL Server, Redis and MongoDB, and run queries
against them. Every engine is opened by Deck itself (its db_* commands), a file in place: with
writes allowed, a write is saved to the file.

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

## What it exports

| Export | Where it renders |
|---|---|
| `default` | the tab: schema browser and query editor |

## Checks

```sh
node plugins/db/db.check.mjs
```

Statement splitting and the read-only guard.

## Build

```sh
node plugins/db/build.mjs
```

See [../README.md](../README.md) for how the build and the shims work.

## Install

Copy `plugin.json` and `plugin.js` into `%APPDATA%\Deck\plugins\db\` (`Deck-Dev` for a
debug build) and restart Deck.
