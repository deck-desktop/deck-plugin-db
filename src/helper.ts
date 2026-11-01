// SQL Server, Redis and MongoDB, through deck-db-bridge.exe.
//
// Deck opens Postgres, MySQL and SQLite itself. The drivers for these three would have grown
// deck.exe by half, for engines most people never connect to, so they are a separate program:
// built from bridge/ in this repository and published as a GitHub release. It is downloaded the
// first time one of them is opened, once the user says yes, checked against the SHA-256 pinned
// here, and kept in the plugin's data folder. Each version has its own folder, so a new one is a
// fresh download rather than an overwrite of a program that may be running.
//
// It is started once, by procStream, and spoken to in JSON lines (bridge/src/main.rs has the
// protocol). Its four calls answer exactly as Deck's dbConnect, dbQuery, dbSchema and
// dbDisconnect do, so sources.ts treats both the same.
import { listen } from "../shim/event.js";
import {
  dataDir, exec, fsDelete, fsHash, fsRename, isWindows, procKill, procStream, procWrite,
  type DbQueryResult, type DbSchema,
} from "../shim/bridge.js";
import type { EngineId } from "./db";

/** The release this plugin runs. A new build is a new version here, its tag and its checksum. */
export const HELPER = {
  version: "1.0.0",
  url: "https://github.com/deck-desktop/deck-plugin-db/releases/download/bridge-v1.0.0/deck-db-bridge.exe",
  sha256: "6200f53ec4d2caedbda99f7a46c57505a511b58ff46662cd2a09e19211ffd46c",
  size: "10 MB",
  file: "deck-db-bridge.exe",
};

/**
 * The Linux build of the same version, once it is published beside the Windows one: built by
 * .github/workflows/bridge-linux.yml on Ubuntu 22.04, the oldest glibc it is to run on, whose log
 * prints the SHA-256 to put here. Until then its engines say they need Windows.
 */
const HELPER_LINUX: typeof HELPER | null = null;

/** This system's build of the helper, or null when it has none. */
const asset = () => (isWindows() ? HELPER : HELPER_LINUX);

/** Why the helper's engines are not offered here. */
const NOT_HERE = "SQL Server, Redis and MongoDB go through a helper program that has no build for this system yet";

/** The engines that need the helper. */
export const usesHelper = (engine: EngineId) => engine === "mssql" || engine === "redis" || engine === "mongo";

const exePath = async () => {
  const sep = isWindows() ? "\\" : "/";
  return [await dataDir(), "bridge", HELPER.version, asset()?.file ?? HELPER.file].join(sep);
};

/** Set once the file on disk has been checked, so each connect does not hash 10 MB again. */
let verified = false;

/** Whether this version of the helper is on disk, whole. */
export async function helperInstalled(): Promise<boolean> {
  const a = asset();
  if (!a) return false;
  if (!verified) verified = (await fsHash([await exePath()]))[0] === a.sha256;
  return verified;
}

/**
 * Download the helper, check it, and put it in place.
 *
 * Through Windows' own curl (in System32 since Windows 10), named by its full path so another
 * curl earlier on PATH cannot stand in for it; elsewhere the system's curl. The download goes to a `.part` file and becomes
 * the program only once its checksum matches, so a cut-off or altered download is never run.
 */
export async function installHelper(): Promise<void> {
  const a = asset();
  if (!a) throw new Error(NOT_HERE);
  const exe = await exePath();
  const part = `${exe}.part`;
  const r = await exec(isWindows() ? "%SystemRoot%\\System32\\curl.exe" : "curl", [
    "-fsSL", "--create-dirs", "--connect-timeout", "20",
    // A download that stalls (under 1 KB/s for 20s) is dropped and retried, not left hanging.
    "--speed-limit", "1024", "--speed-time", "20", "--retry", "3",
    "-o", part, a.url,
  ]);
  if (r.code !== 0) throw new Error(`The download failed: ${r.stderr.trim() || `curl exited with ${r.code}`}`);
  const [got] = await fsHash([part]);
  if (got !== a.sha256) {
    await fsDelete(part).catch(() => {});
    throw new Error(`The download's SHA-256 is ${got}, not ${a.sha256}, so it was deleted unused.`);
  }
  // A damaged copy left from before would stop the rename.
  await fsDelete(exe).catch(() => {});
  await fsRename(part, a.file);
  // A Linux download keeps no execute bit.
  if (!isWindows()) await exec("chmod", ["+x", exe]);
  verified = true;
}

interface Running {
  id: string;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  unlisten: Promise<() => void>;
  /** Set by `ended`, which an exit and a failed start can both reach. */
  over?: boolean;
}

/** The helper while it runs, and the start in progress, so overlapping calls start it once. */
let current: Running | null = null;
let starting: Promise<Running> | null = null;
let nextId = 1;

function ended(proc: Running, why: string) {
  if (proc.over) return;
  proc.over = true;
  if (current === proc) current = null;
  void proc.unlisten.then((f) => f());
  for (const p of proc.pending.values()) p.reject(new Error(`The database helper ${why}.`));
  proc.pending.clear();
}

/** Start the helper and wait for its ready line. */
async function start(): Promise<Running> {
  if (!(await helperInstalled())) throw new Error("The database drivers are not installed.");
  const proc: Running = { id: `db-bridge-${Date.now().toString(36)}`, pending: new Map(), unlisten: Promise.resolve(() => {}) };
  let ready!: () => void;
  let failed!: (e: Error) => void;
  const up = new Promise<void>((res, rej) => { ready = res; failed = rej; });
  proc.unlisten = listen<{ id: string; stream: string; line: string }>("proc-line", (e) => {
    if (e.payload.id !== proc.id) return;
    if (e.payload.stream === "stderr") { console.warn("[db] helper:", e.payload.line); return; }
    let msg: { id?: number; ok?: unknown; err?: string; ready?: string };
    try { msg = JSON.parse(e.payload.line); } catch { console.warn("[db] helper said", e.payload.line); return; }
    if (msg.ready) { ready(); return; }
    const p = msg.id === undefined ? undefined : proc.pending.get(msg.id);
    if (!p) return;
    proc.pending.delete(msg.id!);
    if (msg.err !== undefined) p.reject(new Error(msg.err)); else p.resolve(msg.ok);
  });
  // Listening before the program starts, or its first lines could go by unheard.
  await proc.unlisten;
  // Resolves when the program exits, which is the end of every connection it held.
  procStream(proc.id, await exePath(), [], "", true).then(
    (r) => { const why = r.cancelled ? "was stopped" : `exited with code ${r.code}`; failed(new Error(`The database helper ${why}.`)); ended(proc, why); },
    (e) => { failed(new Error(String(e))); ended(proc, `could not start: ${e}`); },
  );
  const late = setTimeout(() => failed(new Error("The database helper did not start within 20s.")), 20_000);
  try { await up; } catch (e) { void procKill(proc.id).catch(() => {}); ended(proc, "did not start"); throw e; } finally { clearTimeout(late); }
  // Only now, so a call made while it starts waits for the ready line rather than writing early.
  current = proc;
  return proc;
}

async function call<T>(op: string, fields: Record<string, unknown>): Promise<T> {
  const proc = current ?? await (starting ??= start().finally(() => { starting = null; }));
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    proc.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    procWrite(proc.id, JSON.stringify({ id, op, ...fields }) + "\n").catch((e) => {
      proc.pending.delete(id);
      reject(e instanceof Error ? e : new Error(String(e)));
    });
  });
}

/** The helper's answers to Deck's four db calls, in the same shapes. */
export const helperDb = {
  connect: (url: string) => call<number>("connect", { url }),
  query: (handle: number, sql: string, readOnly: boolean, skip = 0) =>
    call<DbQueryResult>("query", { handle, sql, readOnly, skip }),
  schema: (handle: number) => call<DbSchema>("schema", { handle }),
  disconnect: (handle: number) => call<void>("disconnect", { handle }),
};

/** Stop the helper, for a reload: the next copy of the plugin starts its own. */
export function stopHelper() {
  const stop = (proc: Running) => { void procKill(proc.id).catch(() => {}); ended(proc, "was stopped"); };
  if (current) stop(current);
  // One still starting is stopped once it is up, or it would run on for a copy that has gone.
  void starting?.then(stop, () => {});
}
