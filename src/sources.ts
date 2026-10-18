// The one implementation of `Source`, over Deck's db_* commands.
//
// Kept out of db.ts so that file stays pure — it is compiled and imported by db.check.mjs, which
// runs in node with no Deck around it. Everything here reaches for Deck's bridge, which does not
// exist in that harness.
//
// Every engine is opened the same way, by a url whose scheme picks it (`sqlite:<path>`,
// `duckdb:<path>`, postgres://, mysql://, mssql://, redis://, mongodb://), and the connection
// lives in Rust. A file is opened in place, not copied: with writes allowed, a write reaches the
// file itself.
import {
  dbConnect, dbDisconnect, dbQuery, dbSchema, sshTunnelClose, sshTunnelOpen,
} from "../shim/bridge.js";
import {
  connectUrl, countFor, isFile, throughTunnel,
  type Connection, type EngineId, type Source,
} from "./db";

/**
 * Any engine, over the Rust commands.
 *
 * The connection lives in Rust and survives this module unmounting, which Deck does on every
 * navigation — so `close` is called when the connection is closed by the user, not when the
 * component goes away.
 */
export async function openNative(
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
          // The CREATE statement where the engine keeps one (SQLite, DuckDB); information_schema
          // has no equivalent to show.
          sql: t.sql ?? "",
          columns: t.columns.map((c) => ({
            name: c.name, type: c.type, notNull: c.notNull, pk: c.pk,
          })),
        })),
        foreignKeys: s.foreignKeys,
      };
    },
    async run(sql, allowWrites, skip = 0) {
      // read_only is the inverse, and it is the DATABASE's guarantee rather than the UI's: with
      // it on, the engine itself (or, for Redis and MongoDB, Rust's list of read commands)
      // refuses a write, whatever form the statement takes.
      const r = await dbQuery(handle, sql, !allowWrites, skip);
      return {
        columns: r.columns,
        rows: r.rows,
        total: r.total,
        truncated: r.truncated,
      };
    },
    async rowCount(table) {
      const q = countFor(engine, table);
      if (!q) throw new Error(`${engine} has no row count for ${table}`);
      const r = await dbQuery(handle, q, true);
      // MongoDB's count replies { n, ok }; a SQL count is its one cell.
      const n = r.columns.indexOf("n");
      return Number(r.rows[0]?.[n >= 0 ? n : 0] ?? 0);
    },
    async close() {
      await dbDisconnect(handle);
      if (tunnel !== null) await sshTunnelClose(tunnel).catch(() => {});
    },
  };
}

/** Open whichever engine a connection names, tunnelling first if a server asks for one. */
export function open(conn: Connection): Promise<Source> {
  return openNative(
    conn.engine,
    connectUrl(conn.engine, conn.target),
    !isFile(conn.engine) && conn.sshHost && conn.sshRemote
      ? { host: conn.sshHost, remote: conn.sshRemote }
      : undefined,
  );
}
