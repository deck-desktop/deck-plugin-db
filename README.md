# Databases

Browse SQLite files, Postgres and MySQL, and run queries against them.

Tables, columns, row counts and a query editor with history. Results can be sorted, exported to
CSV, and - where the query maps to a single table with a key - edited in place.

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
