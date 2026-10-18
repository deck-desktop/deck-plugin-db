// The schema as a diagram: every table a card listing its columns, every foreign key a line from
// the column that holds it to the one it points at.
//
// Laid out by dependency rather than by a layout library: a table that points at nothing sits in
// the first column, one that points at those in the next, and so on, so the lines mostly run one
// way. Cards can be dragged where that guess is wrong; where they were put is kept per database
// for the session (module scope, since the tab unmounts on every switch), not saved to disk.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Eye, KeyRound, Link2, Maximize, RotateCcw, Table2 } from "lucide-react";
import type { ForeignKeyRef, SchemaTable } from "./db";

const W = 240, HEAD = 34, ROW = 22, PAD = 6, GAP_X = 120, GAP_Y = 36;
const heightOf = (t: SchemaTable) => HEAD + Math.max(1, t.columns.length) * ROW + PAD;

type Pos = { x: number; y: number };
/** Cards moved by hand, per database. */
const moved = new Map<string, Record<string, Pos>>();

/** Where each table goes before anything is moved: one column per dependency depth. */
function autoLayout(tables: SchemaTable[], fks: ForeignKeyRef[]): Record<string, Pos> {
  const names = new Set(tables.map((t) => t.name));
  const refs = new Map<string, string[]>();
  for (const f of fks) {
    if (f.table === f.refTable || !names.has(f.refTable)) continue;
    refs.set(f.table, [...(refs.get(f.table) ?? []), f.refTable]);
  }
  const level = new Map<string, number>();
  // A cycle (two tables pointing at each other) is cut where it is met, so it still terminates.
  const depth = (name: string, seen: Set<string>): number => {
    const known = level.get(name);
    if (known !== undefined) return known;
    if (seen.has(name)) return 0;
    seen.add(name);
    const r = refs.get(name) ?? [];
    const d = r.length ? 1 + Math.max(...r.map((x) => depth(x, seen))) : 0;
    level.set(name, d);
    return d;
  };
  const cols: SchemaTable[][] = [];
  const views: SchemaTable[] = [];
  for (const t of tables) {
    if (t.kind === "view") { views.push(t); continue; }
    const d = depth(t.name, new Set());
    (cols[d] ??= []).push(t);
  }
  // Views last, in a column of their own: they have no keys to draw.
  if (views.length) cols.push(views);
  const out: Record<string, Pos> = {};
  cols.forEach((list, ci) => {
    let y = 0;
    for (const t of [...(list ?? [])].sort((a, b) => a.name.localeCompare(b.name))) {
      out[t.name] = { x: ci * (W + GAP_X), y };
      y += heightOf(t) + GAP_Y;
    }
  });
  return out;
}

export function Diagram({ tables, fks, layoutKey, onOpen }: {
  tables: SchemaTable[];
  fks: ForeignKeyRef[];
  /** Which database: the moved cards are kept under it. */
  layoutKey: string;
  /** Show this table's rows (a double-click on its card). */
  onOpen: (name: string) => void;
}) {
  const auto = useMemo(() => autoLayout(tables, fks), [tables, fks]);
  const [hand, setHand] = useState<Record<string, Pos>>(() => moved.get(layoutKey) ?? {});
  useEffect(() => { moved.set(layoutKey, hand); }, [layoutKey, hand]);
  const pos = (name: string) => hand[name] ?? auto[name] ?? { x: 0, y: 0 };

  const [view, setView] = useState({ x: 40, y: 40, k: 1 });
  const [hover, setHover] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  /** Everything in sight, scaled down if it does not fit, never up past 1. */
  const fit = () => {
    const el = box.current;
    if (!el || !tables.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const t of tables) {
      const p = pos(t.name);
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x + W); y1 = Math.max(y1, p.y + heightOf(t));
    }
    const k = Math.min(1, (el.clientWidth - 80) / (x1 - x0), (el.clientHeight - 80) / (y1 - y0));
    setView({ k, x: (el.clientWidth - (x1 - x0) * k) / 2 - x0 * k, y: Math.max(24, (el.clientHeight - (y1 - y0) * k) / 2) - y0 * k });
  };
  // Fitted when the diagram opens and whenever the schema it shows is read again.
  // `refit` is bumped by Reset, so the fit runs after the moved cards are cleared, not before.
  const [refit, setRefit] = useState(0);
  useLayoutEffect(fit, [tables, refit]); // eslint-disable-line react-hooks/exhaustive-deps

  // Wheel zooms about the pointer. A native listener: React's wheel handler is passive, and the
  // page would scroll as well.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const v = viewRef.current;
      const k = Math.min(2, Math.max(0.2, v.k * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      setView({ k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);

  // One drag at a time: the background pans, a card's header moves the card.
  const drag = useRef<{ kind: "pan" | "card"; name?: string; sx: number; sy: number; ox: number; oy: number } | null>(null);
  const down = (e: React.PointerEvent, name?: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    // Without this the press also starts a text selection, which then follows the drag.
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const o = name ? pos(name) : view;
    drag.current = { kind: name ? "card" : "pan", name, sx: e.clientX, sy: e.clientY, ox: o.x, oy: o.y };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (d.kind === "pan") setView((v) => ({ ...v, x: d.ox + dx, y: d.oy + dy }));
    else setHand((h) => ({ ...h, [d.name!]: { x: d.ox + dx / view.k, y: d.oy + dy / view.k } }));
  };
  const up = () => { drag.current = null; };

  const byName = useMemo(() => new Map(tables.map((t) => [t.name, t])), [tables]);
  const rowY = (table: string, col: string) => {
    const t = byName.get(table);
    const i = t ? t.columns.findIndex((c) => c.name === col) : -1;
    return pos(table).y + (i < 0 ? HEAD / 2 : HEAD + i * ROW + ROW / 2);
  };
  // The tables a hovered one is joined to, lit with it; the rest fade.
  const related = useMemo(() => {
    if (!hover) return null;
    const s = new Set([hover]);
    for (const f of fks) if (f.table === hover || f.refTable === hover) { s.add(f.table); s.add(f.refTable); }
    return s;
  }, [hover, fks]);
  const fkCols = useMemo(() => new Set(fks.map((f) => `${f.table}.${f.column}`)), [fks]);

  const edges = fks.filter((f) => byName.has(f.table) && byName.has(f.refTable)).map((f, i) => {
    const a = pos(f.table), b = pos(f.refTable);
    const y1 = rowY(f.table, f.column), y2 = rowY(f.refTable, f.refColumn);
    let d: string, x1: number, x2: number;
    if (f.table === f.refTable) {
      // A table that points at itself (a parent_id): a loop off its right side.
      x1 = x2 = a.x + W;
      d = `M ${x1} ${y1} C ${x1 + 56} ${y1}, ${x2 + 56} ${y2}, ${x2} ${y2}`;
    } else {
      const childLeft = a.x + W / 2 < b.x + W / 2;
      x1 = childLeft ? a.x + W : a.x;
      x2 = childLeft ? b.x : b.x + W;
      const c = Math.max(48, Math.abs(x2 - x1) / 2) * (childLeft ? 1 : -1);
      d = `M ${x1} ${y1} C ${x1 + c} ${y1}, ${x2 - c} ${y2}, ${x2} ${y2}`;
    }
    const lit = !!hover && (f.table === hover || f.refTable === hover);
    return { key: `${f.table}.${f.column}->${f.refTable}.${f.refColumn}:${i}`, d, x1, y1, x2, y2, lit,
      title: `${f.table}.${f.column} → ${f.refTable}.${f.refColumn}` };
  });

  if (!tables.length) {
    return <p className="m-auto p-8 text-center text-[12.5px] text-text-muted">This database has no tables to draw.</p>;
  }
  const btn = "grid size-7 place-items-center rounded-md text-text-muted transition-colors hover:bg-white/5 hover:text-text-primary";
  return (
    <div ref={box} onPointerDown={(e) => down(e)} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      className="relative min-h-0 flex-1 cursor-grab touch-none select-none overflow-hidden active:cursor-grabbing"
      // Dots that move with the pan, so dragging reads as moving the page rather than the cards.
      style={{
        backgroundImage: "radial-gradient(rgb(var(--overlay-rgb) / 0.08) 1px, transparent 1px)",
        backgroundSize: `${20 * view.k}px ${20 * view.k}px`,
        backgroundPosition: `${view.x}px ${view.y}px`,
      }}>
      <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
        <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width="1" height="1" aria-hidden>
          {edges.map((e) => (
            <g key={e.key} style={{ color: e.lit ? "var(--accent)" : "rgb(var(--overlay-rgb) / 0.22)", opacity: related && !e.lit ? 0.35 : 1 }}>
              <path d={e.d} fill="none" stroke="currentColor" strokeWidth={e.lit ? 1.8 : 1.3}><title>{e.title}</title></path>
              <circle cx={e.x1} cy={e.y1} r={3} fill="currentColor" />
              {/* The end that is pointed at: a bar, as the "one" side of a relationship. */}
              <path d={`M ${e.x2} ${e.y2 - 5} L ${e.x2} ${e.y2 + 5}`} stroke="currentColor" strokeWidth={2} />
            </g>
          ))}
        </svg>
        {tables.map((t) => {
          const p = pos(t.name);
          const dim = related && !related.has(t.name);
          const lit = hover === t.name;
          return (
            <div key={t.name} onMouseEnter={() => setHover(t.name)} onMouseLeave={() => setHover((h) => (h === t.name ? null : h))}
              onDoubleClick={() => onOpen(t.name)}
              className="absolute cursor-default overflow-hidden rounded-[10px] border bg-card shadow-xl transition-opacity"
              style={{ left: p.x, top: p.y, width: W, opacity: dim ? 0.4 : 1, borderColor: lit ? "var(--accent)" : "var(--border-strong)" }}
              title={`${t.name} — double-click to show its rows`}>
              <div onPointerDown={(e) => down(e, t.name)}
                className="flex cursor-move items-center gap-2 border-b border-subtle px-2.5"
                style={{ height: HEAD, background: lit ? "var(--accent-soft)" : "var(--bg-elev)" }}>
                {t.kind === "view" ? <Eye size={13} className="shrink-0 text-text-muted" /> : <Table2 size={13} className="shrink-0 text-text-muted" />}
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-text-primary">{t.name}</span>
                <span className="shrink-0 text-[10.5px] tabular-nums text-text-muted">{t.columns.length}</span>
              </div>
              <div style={{ paddingBottom: PAD }}>
                {t.columns.length === 0 && <div className="px-2.5 text-[11px] italic text-text-muted" style={{ height: ROW, lineHeight: `${ROW}px` }}>No columns read</div>}
                {t.columns.map((c) => {
                  const fk = fkCols.has(`${t.name}.${c.name}`);
                  return (
                    <div key={c.name} className="flex items-center gap-1.5 px-2.5 text-[11.5px]" style={{ height: ROW }}>
                      <span className="grid w-3.5 shrink-0 place-items-center">
                        {c.pk ? <KeyRound size={11} style={{ color: "rgb(var(--tone-amber-400))" }} />
                          : fk ? <Link2 size={11} style={{ color: "var(--accent)" }} /> : null}
                      </span>
                      <span className={"min-w-0 flex-1 truncate " + (c.pk ? "font-medium text-text-primary" : "text-text-secondary")}>
                        {c.name}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-text-muted">{c.type.toLowerCase()}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* The view's own controls, in the corner over the canvas; the legend opposite, at the top, clear
          of the pane's own floating controls along the bottom. */}
      <div onPointerDown={(e) => e.stopPropagation()}
        className="absolute bottom-3 left-3 flex items-center gap-0.5 rounded-lg border border-subtle bg-card p-0.5 shadow-xl">
        <button onClick={fit} title="Fit everything in view" className={btn}><Maximize size={14} /></button>
        <button onClick={() => { setHand({}); setRefit((n) => n + 1); }} title="Put every table back where it started" className={btn}><RotateCcw size={14} /></button>
        <span className="px-1.5 text-[11px] tabular-nums text-text-muted">{Math.round(view.k * 100)}%</span>
      </div>
      <div className="pointer-events-none absolute right-3 top-3 flex items-center gap-3 rounded-lg border border-subtle bg-card px-2.5 py-1.5 text-[11px] text-text-muted shadow-xl">
        <span className="flex items-center gap-1"><KeyRound size={11} style={{ color: "rgb(var(--tone-amber-400))" }} />Primary key</span>
        <span className="flex items-center gap-1"><Link2 size={11} style={{ color: "var(--accent)" }} />Foreign key</span>
        <span>Scroll to zoom, drag to move</span>
      </div>
    </div>
  );
}
