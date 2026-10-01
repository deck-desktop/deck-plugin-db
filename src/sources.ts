// The two engine implementations of `Source`.
//
// Kept out of db.ts so that file stays pure — it is compiled and imported by sqlite.check.mjs,
// which runs in node with no Deck around it. Everything here reaches for either sql.js or Deck's
// bridge, neither of which exists in that harness.
import {
  dbConnect, dbDisconnect, dbQuery, dbSchema, fsReadBytes, sshTunnelClose, sshTunnelOpen,
} from "../shim/bridge.js";
import initSqlJs from "sql.js";
import wasmBinary from "sql.js/dist/sql-wasm.wasm";
import {
  columns, foreignKeys, quoteFor, ROW_CAP, rowCount, run, tables, throughTunnel,
  type Connection, type Db, type EngineId, type ForeignKeyRef, type SchemaTable, type Source,
} from "./db";

/**
 * SQLite, read into memory from a file.
 *
 * Nothing is written back to disk — not even with writes enabled, which change the in-memory copy
 * and are discarded when the tab is left. Wally's database is the reason that is stated rather
 * than assumed: a `.db` edited underneath a syncing app is how the file, its -wal and its -shm
 * stop agreeing with each other.
 */
export async function openSqlite(path: string): Promise<Source> {
  const SQL = await initSqlJs({ wasmBinary });
  const db = new SQL.Database(await fsReadBytes(path)) as unknown as Db;

  return {
    engine: "sqlite",
    async schema() {
      const list = tables(db);
      const out: SchemaTable[] = [];
      const fks: ForeignKeyRef[] = [];
      for (const t of list) {
        let cols: ReturnType<typeof columns> = [];
        try {
          cols = columns(db, t.name);
          for (const fk of foreignKeys(db, t.name)) {
            fks.push({
              table: t.name, column: fk.column, refTable: fk.table, refColumn: fk.toColumn,
            });
          }
        } catch { /* a view over a missing table still belongs in the list */ }
        out.push({ ...t, columns: cols });
      }
      return { tables: out, foreignKeys: fks };
    },
    // `allowWrites` is unused: sql.js holds a private copy, so a write cannot reach the file
    // whatever it says. The UI still blocks writes first, which is where the guard is enforced.
    async run(sql) {
      return run(db, sql);
    },
    async rowCount(table) {
      return rowCount(db, table);
    },
    async close() {
      db.close();
    },
  };
}

/**
 * Postgres or MySQL, over the Rust commands.
 *
 * The connection lives in Rust and survives this module unmounting, which Deck does on every
 * navigation — so `close` is called when the connection is closed by the user, not when the
 * component goes away.
 */
export async function openServer(
  engine: EngineId,
  url: string,
  ssh?: { host: string; remote: string },
): Promise<Source> {
  // The tunnel comes up FIRST and the url is pointed at it, because the database it reaches is
  // not meant to be reachable any other way — a server's database should not be listening to the
  // internet. Deck spawning `ssh -L` is what removes the terminal that would otherwise have to
  // sit open beside it.
  let tunnel: number | null = null;
  let target = url;
  if (ssh?.host && ssh.remote) {
    const [id, port] = await sshTunnelOpen(ssh.host, ssh.remote);
    tunnel = id;
    target = throughTunnel(url, port);
  }

  let handle: number;
  try {
    handle = await dbConnect(target);
  } catch (e) {
    // A tunnel left open after a failed connect would hold an ssh process for a connection that
    // does not exist, and the next attempt would open another.
    if (tunnel !== null) await sshTunnelClose(tunnel).catch(() => {});
    throw e;
  }

  return {
    engine,
    async schema() {
      const s = await dbSchema(handle);
      return {
        tables: s.tables.map((t) => ({
          name: t.name,
          kind: t.kind,
          // The CREATE statement is a SQLite idea; information_schema has no equivalent to show.
          sql: "",
          columns: t.columns.map((c) => ({
            name: c.name, type: c.type, notNull: c.notNull, pk: c.pk,
          })),
        })),
        foreignKeys: s.foreignKeys,
      };
    },
    async run(sql, allowWrites) {
      // read_only is the inverse, and it is the SERVER's guarantee rather than the UI's: with it
      // on, the database itself refuses a write, whatever form the statement takes.
      const r = await dbQuery(handle, sql, !allowWrites);
      return {
        columns: r.columns,
        rows: r.rows,
        total: r.total,
        truncated: r.truncated,
      };
    },
    async rowCount(table) {
      const r = await dbQuery(handle, `select count(*) from ${quoteFor(engine, table)}`, true);
      return Number(r.rows[0]?.[0] ?? 0);
    },
    async close() {
      await dbDisconnect(handle);
      if (tunnel !== null) await sshTunnelClose(tunnel).catch(() => {});
    },
  };
}

/** Open whichever engine a connection names, tunnelling first if it asks for one. */
export function open(conn: Connection): Promise<Source> {
  return conn.engine === "sqlite"
    ? openSqlite(conn.target)
    : openServer(conn.engine, conn.target, conn.sshHost && conn.sshRemote
      ? { host: conn.sshHost, remote: conn.sshRemote }
      : undefined);
}

export { ROW_CAP };
