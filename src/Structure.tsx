// One table's structure: its columns, the foreign keys into and out of it, its indexes and its
// CREATE statement.
//
// Columns and foreign keys are the schema the sidebar already holds, so they show at once. Column
// defaults and indexes are not in it, and are read here with one read-only query each
// (`structureQueries` in db.ts) when the view opens. Asked of the source directly rather than
// through the editor's run path: these are the plugin's own reads, not the user's SQL, and MySQL's
// SHOW CREATE TABLE is not in the editor's read-only allowlist although it only reads.
import { useEffect, useState } from "react";
import { Copy, Eye, KeyRound, Link2, RefreshCw, Table2 } from "lucide-react";
import { Chip, CountChip, tone, toast } from "../shim/ui.js";
import {
  isSql, parseDefaults, parseIndexes, structureQueries,
  type EngineId, type ForeignKeyRef, type IndexInfo, type SchemaTable, type Source,
} from "./db";

const toolBtn = "flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-subtle bg-elev px-2.5 text-[12px] text-text-secondary transition-colors hover:border-strong hover:text-text-primary disabled:opacity-40 disabled:hover:border-subtle";
const linkBtn = "font-mono transition-colors hover:underline";

interface Extra {
  defaults: Map<string, string>;
  indexes: IndexInfo[];
  create: string;
  /** What could not be read, by part, shown in that part's card. */
  failed: { defaults?: string; indexes?: string; create?: string };
}

export function Structure({ source, engine, table, fks, onOpen, onRows }: {
  source: Source;
  engine: EngineId;
  table: SchemaTable;
  fks: ForeignKeyRef[];
  /** Show another table's structure, from a foreign key. */
  onOpen: (name: string) => void;
  /** Show this table's rows in the query view. */
  onRows: () => void;
}) {
  const [extra, setExtra] = useState<Extra | null>(null);

  useEffect(() => {
    // A late answer for a table no longer on screen must not land on the one that is.
    let live = true;
    setExtra(null);
    const q = structureQueries(engine, table.name);
    void (async () => {
      const out: Extra = { defaults: new Map(), indexes: [], create: table.sql, failed: {} };
      if (q.defaults) {
        try { out.defaults = parseDefaults(await source.run(q.defaults, false)); }
        catch (e) { out.failed.defaults = String(e); }
      }
      // A view has no indexes of its own; asking would only list nothing.
      if (table.kind === "table" && q.indexes) {
        try { out.indexes = parseIndexes(await source.run(q.indexes, false)); }
        catch (e) { out.failed.indexes = String(e); }
      }
      if (q.create) {
        try { out.create = String((await source.run(q.create, false)).rows[0]?.[1] ?? ""); }
        catch (e) { out.failed.create = String(e); }
      }
      if (live) setExtra(out);
    })();
    return () => { live = false; };
  }, [source, engine, table]);

  // What this engine has to show at all: a Redis key group has neither defaults, keys, indexes
  // nor DDL, and a MongoDB collection has indexes but none of the rest.
  const sql = isSql(engine);
  const has = structureQueries(engine, table.name);
  const out = fks.filter((f) => f.table === table.name);
  const into = fks.filter((f) => f.refTable === table.name);
  const fkOf = (col: string) => out.find((f) => f.column === col);

  const copy = (text: string) => void navigator.clipboard.writeText(text)
    .then(() => toast("Copied"))
    .catch((e) => { console.warn("[db] copy failed", e); toast(`Could not copy: ${String(e)}`); });

  return (
    <div className="m-2 mt-1.5 flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-subtle bg-card">
      <div className="flex shrink-0 items-center gap-2 border-b border-subtle px-3 py-1.5">
        {table.kind === "view"
          ? <Eye size={14} className="shrink-0 text-text-muted" />
          : <Table2 size={14} className="shrink-0 text-text-muted" />}
        <span className="truncate text-[13px] font-semibold text-text-primary">{table.name}</span>
        <span className="shrink-0 text-[11.5px] text-text-muted">
          {table.kind === "view" ? "View" : "Table"} {"·"} {table.columns.length} column{table.columns.length === 1 ? "" : "s"}
        </span>
        {!extra && <RefreshCw size={12} className="shrink-0 animate-spin text-text-muted" />}
        <button onClick={onRows} title={`Show the rows of ${table.name}`} className={toolBtn + " ml-auto"}>
          <Table2 size={12} /> Show rows
        </button>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-auto p-3">
        <div className="mx-auto flex max-w-4xl flex-col gap-4">
          <Section title={engine === "redis" ? "Key types" : engine === "mongo" ? "Fields" : "Columns"}
            count={table.columns.length}>
            {table.columns.length === 0 ? <Empty>No columns reported.</Empty> : (
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-left text-[11px] text-text-muted">
                    <th className="px-3 py-1.5 font-normal">Name</th>
                    <th className="px-3 py-1.5 font-normal">{engine === "redis" ? "Keys" : "Type"}</th>
                    {has.defaults && <th className="px-3 py-1.5 font-normal">Default</th>}
                    <th className="px-3 py-1.5 font-normal" />
                  </tr>
                </thead>
                <tbody>
                  {table.columns.map((c) => {
                    const fk = fkOf(c.name);
                    const dflt = extra?.defaults.get(c.name);
                    return (
                      <tr key={c.name} className="border-t border-subtle transition-colors hover:bg-white/5">
                        <td className="px-3 py-1">
                          <span className="flex items-center gap-1.5">
                            {c.pk
                              ? <KeyRound size={11} className="shrink-0" style={{ color: tone("amber") }} />
                              : <span className="w-[11px] shrink-0" />}
                            <span className={c.pk ? "font-medium text-text-primary" : "text-text-secondary"}>{c.name}</span>
                          </span>
                        </td>
                        <td className="px-3 py-1 font-mono text-[11px] text-text-muted">{c.type || "—"}</td>
                        {has.defaults && (
                          <td className="max-w-[16rem] truncate px-3 py-1 font-mono text-[11px] text-text-secondary" title={dflt}>
                            {dflt ?? <span className="text-text-muted">{extra?.failed.defaults ? "?" : ""}</span>}
                          </td>
                        )}
                        <td className="px-3 py-1">
                          <span className="flex flex-wrap items-center justify-end gap-1">
                            {c.pk && <Chip color={tone("amber")}>Primary key</Chip>}
                            {c.notNull && !c.pk && <Chip color="var(--text-muted)">Not null</Chip>}
                            {fk && (
                              <button onClick={() => onOpen(fk.refTable)} title={`Open the structure of ${fk.refTable}`}>
                                <Chip color="var(--accent)">→ {fk.refTable}.{fk.refColumn}</Chip>
                              </button>
                            )}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {extra?.failed.defaults && <Failed what="the column defaults" error={extra.failed.defaults} />}
          </Section>

          {sql && <Section title="Foreign keys" count={out.length + into.length}>
            {out.length + into.length === 0 ? <Empty>None declared, in or out.</Empty> : (
              <div className="divide-y divide-subtle">
                {out.map((f) => (
                  <FkRow key={`o:${f.column}:${f.refTable}.${f.refColumn}`} label="References"
                    from={`${f.column}`} to={f.refTable} toColumn={f.refColumn} onOpen={onOpen} />
                ))}
                {into.map((f) => (
                  <FkRow key={`i:${f.table}.${f.column}:${f.refColumn}`} label="Referenced by"
                    from={f.refColumn} to={f.table} toColumn={f.column} onOpen={onOpen} />
                ))}
              </div>
            )}
          </Section>}

          {table.kind === "table" && has.indexes && (
            <Section title="Indexes" count={extra?.indexes.length}>
              {!extra ? <Empty>Reading…</Empty>
                : extra.failed.indexes ? <Failed what="the indexes" error={extra.failed.indexes} />
                  : extra.indexes.length === 0 ? <Empty>No indexes.</Empty> : (
                    <div className="divide-y divide-subtle">
                      {extra.indexes.map((ix) => (
                        <div key={ix.name} className="flex h-7 items-center gap-2 px-3 text-[12px]" title={ix.definition || undefined}>
                          <span className="truncate text-text-secondary">{ix.name}</span>
                          <span className="min-w-0 truncate font-mono text-[11px] text-text-muted">({ix.columns.join(", ")})</span>
                          {ix.unique && <span className="ml-auto shrink-0"><Chip color={tone("sky")}>Unique</Chip></span>}
                        </div>
                      ))}
                    </div>
                  )}
            </Section>
          )}

          {sql && <Section title="CREATE statement"
            action={extra?.create ? (
              <button onClick={() => copy(extra.create)} title="Copy the CREATE statement"
                className="grid size-5 place-items-center rounded text-text-muted transition-colors hover:bg-white/10 hover:text-text-primary">
                <Copy size={12} />
              </button>
            ) : undefined}>
            {extra?.failed.create ? <Failed what="the CREATE statement" error={extra.failed.create} />
              : (extra?.create || table.sql) ? (
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap p-3 font-mono text-[11.5px] leading-snug text-text-secondary">
                  {extra?.create || table.sql}
                </pre>
              ) : !extra ? <Empty>Reading…</Empty> : (
                // Said rather than left blank: Postgres genuinely keeps no such text, and an empty
                // card reads as "failed to load".
                <Empty>
                  {engine === "postgres" || engine === "mssql"
                    ? `${engine === "postgres" ? "Postgres" : "SQL Server"} keeps no CREATE TABLE text. The columns, keys and indexes above are what its catalog holds.`
                    : "No CREATE statement is stored for this one."}
                </Empty>
              )}
          </Section>}
        </div>
      </div>
    </div>
  );
}

function Section({ title, count, action, children }: {
  title: string; count?: number; action?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-1.5 flex h-7 items-center gap-1.5 px-1">
        <h3 className="text-[12px] font-medium text-text-secondary">{title}</h3>
        {count !== undefined && count > 0 && <CountChip n={count} />}
        {action && <span className="ml-auto">{action}</span>}
      </div>
      <div className="overflow-hidden rounded-lg border border-subtle">{children}</div>
    </section>
  );
}

function FkRow({ label, from, to, toColumn, onOpen }: {
  label: string; from: string; to: string; toColumn: string; onOpen: (name: string) => void;
}) {
  return (
    <div className="flex h-7 items-center gap-2 px-3 text-[12px]">
      <Link2 size={11} className="shrink-0" style={{ color: "var(--accent)" }} />
      <span className="w-24 shrink-0 text-[11px] text-text-muted">{label}</span>
      <span className="font-mono text-[11.5px] text-text-secondary">{from}</span>
      <span className="text-text-muted">{label === "References" ? "→" : "←"}</span>
      <button onClick={() => onOpen(to)} title={`Open the structure of ${to}`}
        className={linkBtn + " text-[11.5px]"} style={{ color: "var(--accent)" }}>
        {to}.{toColumn}
      </button>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-3 py-2 text-[12px] text-text-muted">{children}</p>;
}

function Failed({ what, error }: { what: string; error: string }) {
  return <p className="whitespace-pre-wrap px-3 py-2 text-[12px] text-red-400">Could not read {what}: {error}</p>;
}
