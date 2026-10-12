// The force-graph canvas of /graph (GET-473): the network and the claims views draw
// the same way, so what a square, a dot or a lit neighbourhood means is learnt once.
//
// The canvas knows shapes, sizes and forces; each view decides what its nodes are. The layout runs,
// settles and stops; dragging a node pins it; hovering lights a node and its neighbours and dims
// the rest; labels show on hubs, on hover, on a search match and once zoomed in.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";
import { Maximize2, Minus, Plus } from "lucide-react";
import { useTheme } from "@/contexts/ThemeContext";

export interface CanvasNode {
  id: string;
  label: string;
  color: string;
  /** square = a hub that groups things; ring = drawn as an outline (nothing there yet). */
  shape?: "circle" | "square" | "ring";
  /** Base radius; grows a little with the number of links. */
  size: number;
  hub?: boolean;
  /** Push on the neighbours (negative repels). */
  charge: number;
  /** Faded (dormant, not current). */
  faint?: boolean;
  /** A thin outer ring, e.g. a decision maker. */
  ring?: string | null;
  tip?: string;
  /** Matched by the search box besides the label. */
  keywords?: string;
  /** A logo drawn in the circle (an account's favicon); the coloured dot until it loads. */
  image?: string | null;
}
export interface CanvasLink { source: string; target: string; distance: number; strength: number; color?: string }

interface GNode extends CanvasNode { deg: number; r: number; x?: number; y?: number; fx?: number | null; fy?: number | null }
interface GLink { source: string | GNode; target: string | GNode; distance: number; strength: number; color?: string }

const sid = (x: string | GNode) => (typeof x === "string" ? x : x.id);

// Logos, loaded once per URL for the whole page. `null` while loading or when the image failed.
// Every mounted canvas listens, so one that mounts while a logo is still loading repaints too.
const logos = new Map<string, HTMLImageElement | null>();
const logoListeners = new Set<() => void>();
function logo(url: string): HTMLImageElement | null {
  if (logos.has(url)) return logos.get(url)!;
  logos.set(url, null);
  const img = new Image();
  img.onload = () => { logos.set(url, img); for (const f of logoListeners) f(); };
  img.src = url;
  return null;
}
const LOGO_SCALE = 1.35;
/** The radius a node is drawn at: a loaded logo sits in a slightly larger disc. */
const drawnR = (n: { r: number; image?: string | null }) => (n.image && logos.get(n.image) ? n.r * LOGO_SCALE : n.r);

// The canvas colour of the graph surface, light and dark (matches the Relationships graph before it).
export const GRAPH_BG = { light: "#ffffff", dark: "#17191e" };

export function ForceCanvas({ nodes, links, query, onClick, selected = null, onBackground, controls = true, centerOn = null }: {
  nodes: CanvasNode[]; links: CanvasLink[]; query: string; onClick?: (id: string) => void;
  /** Stays lit, with its neighbours, while nothing is hovered. */
  selected?: string | null; onBackground?: () => void;
  /** The zoom buttons; off for a small canvas such as the local graph. */
  controls?: boolean;
  /** Pan to this node; a new object each time, so picking the same node twice pans twice. */
  centerOn?: { id: string } | null;
}) {
  const { theme } = useTheme();
  const dark = theme === "dark";
  const ink = dark ? { fg: "#f2f3f5", muted: "rgba(242,243,245,0.55)", link: "rgba(242,243,245,0.14)", lit: "rgba(242,243,245,0.6)", dim: "rgba(242,243,245,0.04)" }
    : { fg: "#1a1d23", muted: "rgba(26,29,35,0.55)", link: "rgba(26,29,35,0.13)", lit: "rgba(26,29,35,0.55)", dim: "rgba(26,29,35,0.04)" };
  const bg = dark ? GRAPH_BG.dark : GRAPH_BG.light;

  const wrap = useRef<HTMLDivElement>(null);
  const fg = useRef<ForceGraphMethods<GNode, GLink>>();
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [hover, setHover] = useState<string | null>(null);
  // Bumped when a logo arrives, so the canvas repaints with it even after the layout has settled.
  const [, setLogoTick] = useState(0);
  useEffect(() => {
    const f = () => setLogoTick((t) => t + 1);
    logoListeners.add(f);
    return () => { logoListeners.delete(f); };
  }, []);
  const fitted = useRef(false);
  const fit = useCallback((ms: number) => {
    fg.current?.zoomToFit(ms, 56);
    setTimeout(() => { const z = fg.current?.zoom(); if (z && z > 2.5) fg.current?.zoom(2.5, 200); }, ms + 20);
  }, []);
  const zoomBy = (f: number) => { const z = fg.current?.zoom(); if (z) fg.current?.zoom(z * f, 200); };

  useEffect(() => {
    const el = wrap.current; if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el); setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const data = useMemo(() => {
    const byId = new Map<string, GNode>(nodes.map((n) => [n.id, { ...n, deg: 0, r: n.size }]));
    const ls: GLink[] = links.filter((l) => byId.has(l.source) && byId.has(l.target) && l.source !== l.target).map((l) => ({ ...l }));
    for (const l of ls) { byId.get(l.source as string)!.deg++; byId.get(l.target as string)!.deg++; }
    for (const n of byId.values()) n.r = n.size + Math.min(6, Math.sqrt(n.deg) * (n.hub ? 0.9 : 0.4));
    return { nodes: [...byId.values()], links: ls };
  }, [nodes, links]);

  const adj = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const n of data.nodes) m.set(n.id, new Set());
    for (const l of data.links) { const a = sid(l.source), b = sid(l.target); m.get(a)?.add(b); m.get(b)?.add(a); }
    return m;
  }, [data]);

  const q = query.trim().toLowerCase();
  const focus = hover ?? selected;
  const lit = useMemo(() => (focus && adj.has(focus) ? new Set([focus, ...adj.get(focus)!]) : null), [focus, adj]);
  const matchIds = useMemo(() => (q
    ? new Set(data.nodes.filter((n) => n.label.toLowerCase().includes(q) || (n.keywords ?? "").toLowerCase().includes(q)).map((n) => n.id))
    : null), [q, data]);

  useEffect(() => {
    const g = fg.current; if (!g) return;
    const charge = g.d3Force("charge") as unknown as { strength: (f: (n: GNode) => number) => void; distanceMax?: (d: number) => void } | undefined;
    charge?.strength((n: GNode) => n.charge);
    charge?.distanceMax?.(420);
    const lk = g.d3Force("link") as unknown as { distance: (f: (l: GLink) => number) => { strength: (f: (l: GLink) => number) => void } } | undefined;
    lk?.distance((l: GLink) => l.distance).strength((l: GLink) => l.strength);
    fitted.current = false;
    g.d3ReheatSimulation();
    const t = setTimeout(() => fit(300), 900);
    return () => clearTimeout(t);
  }, [data, fit]);

  // A node picked outside the canvas (the record panel's lists) is brought into view. Only then:
  // a click on the canvas is already in view, and a re-layout must not pan to a stale position.
  const dataRef = useRef(data); dataRef.current = data;
  useEffect(() => {
    if (!centerOn) return;
    const n = dataRef.current.nodes.find((x) => x.id === centerOn.id);
    if (n?.x != null && n.y != null) fg.current?.centerAt(n.x, n.y, 500);
  }, [centerOn]);

  const draw = (n: GNode, ctx: CanvasRenderingContext2D, scale: number) => {
    const x = n.x ?? 0, y = n.y ?? 0;
    const dim = (lit && !lit.has(n.id)) || (matchIds && !matchIds.has(n.id) && !lit);
    const a = dim ? 0.1 : n.faint ? 0.5 : 1;
    ctx.globalAlpha = a;
    ctx.beginPath();
    if (n.shape === "square") {
      const s = n.r * 1.7, rr = s * 0.28;
      ctx.moveTo(x - s / 2 + rr, y - s / 2); ctx.arcTo(x + s / 2, y - s / 2, x + s / 2, y + s / 2, rr); ctx.arcTo(x + s / 2, y + s / 2, x - s / 2, y + s / 2, rr);
      ctx.arcTo(x - s / 2, y + s / 2, x - s / 2, y - s / 2, rr); ctx.arcTo(x - s / 2, y - s / 2, x + s / 2, y - s / 2, rr);
      ctx.fillStyle = n.color; ctx.fill();
    } else if (n.shape === "ring") {
      ctx.arc(x, y, n.r, 0, 2 * Math.PI); ctx.strokeStyle = n.color; ctx.lineWidth = 1.2 / scale; ctx.stroke();
    } else {
      const img = n.image ? logo(n.image) : null;
      const r = drawnR(n);
      ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fillStyle = img ? "#ffffff" : n.color; ctx.fill();
      if (img) {
        ctx.save(); ctx.beginPath(); ctx.arc(x, y, r * 0.78, 0, 2 * Math.PI); ctx.clip();
        ctx.drawImage(img, x - r * 0.78, y - r * 0.78, r * 1.56, r * 1.56); ctx.restore();
        ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.strokeStyle = ink.link; ctx.lineWidth = 0.8 / scale; ctx.stroke();
      }
    }
    if (n.ring) { ctx.beginPath(); ctx.arc(x, y, drawnR(n) + 1.6, 0, 2 * Math.PI); ctx.strokeStyle = n.ring; ctx.lineWidth = 1.1 / scale; ctx.stroke(); }
    if (matchIds?.has(n.id) && !lit) {
      ctx.beginPath(); ctx.arc(x, y, drawnR(n) + 3 / scale + 1.5, 0, 2 * Math.PI);
      ctx.strokeStyle = "#d4a017"; ctx.lineWidth = 1.6 / scale; ctx.stroke();
    }
    const showLabel = n.hub || (lit?.has(n.id) ?? false) || (matchIds?.has(n.id) ?? false) || scale > 2.4;
    if (showLabel && !dim) {
      const fs = (n.hub ? 11 : 10.5) / scale;
      ctx.font = `${n.hub ? 500 : 400} ${fs}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
      let text = n.label; const max = n.hub ? 32 : 48; if (text.length > max) text = `${text.slice(0, max - 1)}…`;
      ctx.textAlign = "center"; ctx.textBaseline = "top";
      ctx.globalAlpha = dim ? 0.1 : 1;
      const below = drawnR(n);
      ctx.fillStyle = bg; ctx.fillText(text, x + 0.4 / scale, y + below + 2.4 / scale);
      ctx.fillStyle = n.hub ? ink.fg : ink.muted; ctx.fillText(text, x, y + below + 2 / scale);
    }
    ctx.globalAlpha = 1;
  };

  const btn = "flex h-8 w-8 items-center justify-center rounded-[9px] border border-border bg-background/90 text-muted-foreground shadow-[0_1px_2px_rgba(0,0,0,0.04)] hover:text-foreground";
  return (
    <div ref={wrap} className="absolute inset-0" style={{ background: bg }} onMouseLeave={() => setHover(null)}>
      <ForceGraph2D<GNode, GLink>
        ref={fg}
        width={size.w} height={size.h}
        graphData={data}
        backgroundColor={bg}
        nodeId="id"
        nodeRelSize={1}
        nodeVal={(n) => n.r * n.r}
        nodeLabel={(n) => n.tip ?? n.label}
        nodeCanvasObject={draw}
        nodePointerAreaPaint={(n, color, ctx) => { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(n.x ?? 0, n.y ?? 0, drawnR(n) + 2, 0, 2 * Math.PI); ctx.fill(); }}
        linkColor={(l) => {
          if (!lit) return l.color ?? ink.link;
          return sid(l.source) === focus || sid(l.target) === focus ? (l.color ?? ink.lit) : ink.dim;
        }}
        linkWidth={(l) => (lit && (sid(l.source) === focus || sid(l.target) === focus) ? 1.2 : 0.6)}
        cooldownTicks={260}
        d3AlphaDecay={0.022}
        d3VelocityDecay={0.38}
        warmupTicks={40}
        onEngineStop={() => { if (!fitted.current) { fitted.current = true; fit(400); } }}
        onNodeHover={(n) => setHover(n ? n.id : null)}
        onNodeClick={(n) => onClick?.(n.id)}
        onBackgroundClick={() => onBackground?.()}
        onNodeDragEnd={(n) => { n.fx = n.x; n.fy = n.y; }}
        minZoom={0.2}
        maxZoom={8}
      />
      {controls && <div className="absolute bottom-4 left-4 flex gap-1.5">
        <button className={btn} onClick={() => zoomBy(1 / 1.4)} title="Zoom out"><Minus className="h-3.5 w-3.5" /></button>
        <button className={btn} onClick={() => fit(400)} title="Fit"><Maximize2 className="h-3.5 w-3.5" /></button>
        <button className={btn} onClick={() => zoomBy(1.4)} title="Zoom in"><Plus className="h-3.5 w-3.5" /></button>
      </div>}
    </div>
  );
}
