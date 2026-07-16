import { useState, useEffect, useRef, useMemo } from "react";
import { Zap, Globe2, Activity } from "lucide-react";
// @ts-expect-error — dotted-map ships JS; types may not resolve in this Vite config.
import DottedMap from "dotted-map";

// ─────────────────────────────────────────────────────────────────────────────
// Public /live page — proof-of-aliveness dashboard.
// Single-screen layout (no page scroll). Only the live ops feed scrolls.
// ─────────────────────────────────────────────────────────────────────────────

const API_URL = import.meta.env.VITE_API_URL ?? "";
const SNAPSHOT_URL = `${API_URL}/api/public/live/snapshot`;
const POLL_MS = 5_000;
const TICK_MS = 120;

interface RecentEvent { type: string; ts: number; inc: number }
interface RecentRegion { country: string; ops: number }
interface LiveSnapshot {
  totalEver: number;
  opsLast60Min: number;
  opsPerSec: number;
  instancesOnline: number;
  countries: number;
  uptimePct: number;
  recentEventTypes: RecentEvent[];
  recentRegions: RecentRegion[];
  generatedAt: number;
}

// ISO 3166-1 alpha-2 → approximate country centroid (lat, lng).
// Curated to the countries most likely to show up in v1 — falls back to
// (0, 0) for anything missing (renders near west-Africa, easy to spot
// and add).
const COUNTRY_CENTROIDS: Record<string, { lat: number; lng: number }> = {
  US: { lat: 39.8, lng: -98.6 },
  CA: { lat: 56.1, lng: -106.3 },
  MX: { lat: 23.6, lng: -102.6 },
  BR: { lat: -14.2, lng: -51.9 },
  AR: { lat: -38.4, lng: -63.6 },
  CL: { lat: -35.7, lng: -71.5 },
  GB: { lat: 55.4, lng: -3.4 },
  IE: { lat: 53.4, lng: -8.2 },
  FR: { lat: 46.2, lng: 2.2 },
  DE: { lat: 51.2, lng: 10.5 },
  NL: { lat: 52.1, lng: 5.3 },
  BE: { lat: 50.5, lng: 4.5 },
  ES: { lat: 40.5, lng: -3.7 },
  PT: { lat: 39.4, lng: -8.2 },
  IT: { lat: 41.9, lng: 12.6 },
  CH: { lat: 46.8, lng: 8.2 },
  AT: { lat: 47.5, lng: 14.6 },
  PL: { lat: 51.9, lng: 19.1 },
  CZ: { lat: 49.8, lng: 15.5 },
  SE: { lat: 60.1, lng: 18.6 },
  NO: { lat: 60.5, lng: 8.5 },
  FI: { lat: 61.9, lng: 26.0 },
  DK: { lat: 56.3, lng: 9.5 },
  EE: { lat: 58.6, lng: 25.0 },
  LT: { lat: 55.2, lng: 23.9 },
  RU: { lat: 61.5, lng: 105.3 },
  UA: { lat: 48.4, lng: 31.2 },
  TR: { lat: 38.9, lng: 35.2 },
  IL: { lat: 31.0, lng: 34.9 },
  AE: { lat: 23.4, lng: 53.8 },
  SA: { lat: 23.9, lng: 45.1 },
  IN: { lat: 20.6, lng: 78.9 },
  PK: { lat: 30.4, lng: 69.3 },
  BD: { lat: 23.7, lng: 90.4 },
  CN: { lat: 35.9, lng: 104.2 },
  JP: { lat: 36.2, lng: 138.3 },
  KR: { lat: 35.9, lng: 127.8 },
  TW: { lat: 23.7, lng: 121.0 },
  HK: { lat: 22.4, lng: 114.1 },
  SG: { lat: 1.4, lng: 103.8 },
  ID: { lat: -0.8, lng: 113.9 },
  TH: { lat: 15.9, lng: 100.9 },
  VN: { lat: 14.1, lng: 108.3 },
  PH: { lat: 12.9, lng: 121.8 },
  MY: { lat: 4.2, lng: 101.9 },
  AU: { lat: -25.3, lng: 133.8 },
  NZ: { lat: -40.9, lng: 174.9 },
  ZA: { lat: -30.6, lng: 22.9 },
  NG: { lat: 9.1, lng: 8.7 },
  KE: { lat: -0.0, lng: 37.9 },
  EG: { lat: 26.8, lng: 30.8 },
  MA: { lat: 31.8, lng: -7.1 },
};

function groupOf(eventType: string): string {
  const prefix = eventType.split(/[._]/)[0];
  switch (prefix) {
    case "agent":      return "text-[#e8915b]"; // agent traffic — hot orange
    case "v2":         return "text-[#e8915b]";
    case "memory":
    case "identity":   return "text-[#d97757]";
    case "crm":
    case "linkedin":
    case "gmail":
    case "ingest":     return "text-[#c98a6a]";
    default:           return "text-[#8a8178]";
  }
}

// ─── Real dotted world map — computed once at module load ───────────────────
const dottedMap = new DottedMap({ height: 56, grid: "vertical" });
const WORLD_DOT_SVG = dottedMap.getSVG({
  radius: 0.32,
  color: "#3d362c",         // warm dim — dots on the dark map
  shape: "circle",
  backgroundColor: "transparent",
});

// Equirectangular projection: lat/lng → x%/y%.
const project = (lat: number, lng: number) => ({
  x: ((lng + 180) / 360) * 100,
  y: ((90 - lat) / 180) * 100,
});

// ─── Snapshot hook ──────────────────────────────────────────────────────────
function useLiveSnapshot() {
  const [snap, setSnap] = useState<LiveSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [counter, setCounter] = useState<number>(0);
  const [feed, setFeed] = useState<RecentEvent[]>([]);
  const seenTs = useRef<Set<number>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const r = await fetch(SNAPSHOT_URL, { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data: LiveSnapshot = await r.json();
        if (cancelled) return;
        setSnap(data);
        setError(null);
        setCounter((c) => Math.max(c, data.totalEver));

        const fresh = data.recentEventTypes.filter((e) => !seenTs.current.has(e.ts));
        if (fresh.length > 0) {
          fresh.forEach((e) => seenTs.current.add(e.ts));
          if (seenTs.current.size > 600) {
            seenTs.current = new Set(Array.from(seenTs.current).slice(-300));
          }
          setFeed((prev) => [...fresh, ...prev].slice(0, 80));
        } else if (data.recentEventTypes.length > 0) {
          // Seed from server snapshot on first load
          setFeed((prev) => {
            if (prev.length > 0) return prev;
            data.recentEventTypes.forEach((e) => seenTs.current.add(e.ts));
            return data.recentEventTypes.slice(0, 80);
          });
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? "fetch_failed");
      }
    };
    fetchOnce();
    const id = window.setInterval(fetchOnce, POLL_MS);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  useEffect(() => {
    if (!snap) return;
    const id = window.setInterval(() => {
      setCounter((c) => c + Math.max(0, snap.opsPerSec) * (TICK_MS / 1000));
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [snap]);

  return { snap, error, counter, feed };
}

// ─── Viewer geolocation (IP-based, public, no key) ──────────────────────────
// Asks ipapi.co for the visitor's approximate lat/lng. No prompt, no PII
// beyond what the visitor's IP already reveals to any server they hit.
// Falls back silently if the service is unreachable.
function useViewerLocation() {
  const [loc, setLoc] = useState<{ lat: number; lng: number; city?: string; country?: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("https://ipapi.co/json/")
      .then((r) => r.ok ? r.json() : null)
      .then((d) => {
        if (cancelled || !d) return;
        if (typeof d.latitude === "number" && typeof d.longitude === "number") {
          setLoc({ lat: d.latitude, lng: d.longitude, city: d.city, country: d.country_code });
        }
      })
      .catch(() => { /* silent */ });
    return () => { cancelled = true; };
  }, []);
  return loc;
}

// ─── Helpers ────────────────────────────────────────────────────────────────
const formatCounter = (n: number, width = 12) =>
  Math.floor(n).toString().padStart(width, "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const fmtTime = (ts: number) => {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0")).join(":");
};

const fmtDate = (ts: number) => {
  const d = new Date(ts);
  if (d.toDateString() === new Date().toDateString()) return fmtTime(ts);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${fmtTime(ts)}`;
};

// ─── Sub-components ─────────────────────────────────────────────────────────
function StatRow({ icon: Icon, label, value }: { icon: any; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-2 px-4">
      <div className="flex items-center gap-2.5 text-[#8a8178] text-[11.5px]">
        <Icon className="h-3.5 w-3.5" />
        <span>{label}</span>
      </div>
      <span className="text-[#e8e3dc] text-[12.5px] font-mono tabular-nums">{value}</span>
    </div>
  );
}

function WorldMap({
  regions,
  viewerLoc,
}: {
  regions: RecentRegion[];
  viewerLoc: { lat: number; lng: number; city?: string; country?: string } | null;
}) {
  // Pulse cadence — shared by all dots, restarts every 2.5s so they breathe.
  const [pulseKey, setPulseKey] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setPulseKey((k) => k + 1), 2500);
    return () => window.clearInterval(id);
  }, []);

  // Source-of-truth for which dots to draw:
  //  1) Real op origins from the snapshot (when migration is applied and
  //     workspaces have country set).
  //  2) Fallback to viewer's location if regions is empty, so the map
  //     never looks dead.
  type Dot = { x: number; y: number; weight: number; label?: string };
  const dots: Dot[] = (() => {
    if (regions.length > 0) {
      return regions.map((r) => {
        const c = COUNTRY_CENTROIDS[r.country] || { lat: 0, lng: 0 };
        const { x, y } = project(c.lat, c.lng);
        return { x, y, weight: r.ops, label: `${r.country} · ${r.ops}` };
      });
    }
    if (viewerLoc) {
      const { x, y } = project(viewerLoc.lat, viewerLoc.lng);
      return [{ x, y, weight: 1, label: `you · ${viewerLoc.city ?? ""}` }];
    }
    return [];
  })();

  const maxWeight = Math.max(1, ...dots.map((d) => d.weight));

  return (
    <div className="relative w-full h-full rounded-lg overflow-hidden bg-[#0e0c0b]">
      <div
        className="absolute inset-0 w-full h-full flex items-center justify-center"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: WORLD_DOT_SVG }}
      />
      {dots.map((d, i) => {
        // Scale the dot size + glow with op weight, capped so a hot region
        // doesn't dominate.
        const scale = 1 + Math.min(1.4, Math.log10(1 + (d.weight / maxWeight) * 9));
        return (
          <div
            key={`${d.x}-${d.y}-${i}`}
            className="absolute pointer-events-none"
            style={{ left: `${d.x}%`, top: `${d.y}%`, transform: "translate(-50%, -50%)" }}
          >
            <span
              className="block rounded-full bg-[#e8915b] shadow-[0_0_8px_2px_rgba(217,119,87,0.65)]"
              style={{ height: `${6 * scale}px`, width: `${6 * scale}px` }}
            />
            <span
              key={pulseKey}
              className="absolute inset-0 block rounded-full bg-[#d97757]/40 animate-[live-ping_2.4s_ease-out_forwards]"
              style={{ height: `${6 * scale}px`, width: `${6 * scale}px` }}
            />
          </div>
        );
      })}
      {dots.length === 0 && (
        <div className="absolute bottom-2 right-2 text-[10px] uppercase tracking-[0.15em] text-[#6f665c]">
          locating…
        </div>
      )}
      {regions.length === 0 && viewerLoc?.city && (
        <div className="absolute bottom-2 right-2 text-[10px] uppercase tracking-[0.15em] text-[#6f665c]">
          you · {viewerLoc.city}
          {viewerLoc.country ? `, ${viewerLoc.country}` : ""}
        </div>
      )}
    </div>
  );
}

function FeedRow({ event }: { event: RecentEvent }) {
  // v2.* events come from the Context API surface (MCP, SDK, agent, raw HTTP).
  // Prefix them with `agent.` at display time so they read as agent traffic
  // — and so groupOf() picks them up as orange instead of falling to dim.
  const displayType = event.type.startsWith("v2.") ? `agent.${event.type}` : event.type;
  return (
    <div className="grid grid-cols-[130px_1fr_42px] gap-3 px-4 py-1 text-[12px] hover:bg-[#0e0c0b] transition-colors">
      <span className="text-[#6f665c] tabular-nums">{fmtDate(event.ts)}</span>
      <span className={groupOf(displayType)}>{displayType}</span>
      <span className="text-[#bdb5aa] text-right tabular-nums">+{event.inc}</span>
    </div>
  );
}

// ─── Main page ──────────────────────────────────────────────────────────────
export default function Live() {
  const { snap, error, counter, feed } = useLiveSnapshot();
  const viewerLoc = useViewerLocation();

  const opsPerSecLabel = useMemo(() => {
    const v = snap?.opsPerSec ?? 0;
    if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
    if (v >= 10) return String(Math.round(v));
    return v.toFixed(1);
  }, [snap?.opsPerSec]);

  return (
    <div
      className="h-screen flex flex-col bg-[#0e0c0b] text-[#e8e3dc] font-mono overflow-hidden"
      style={{
        backgroundImage:
          "radial-gradient(rgba(200,190,178,0.05) 1px, transparent 1px)",
        backgroundSize: "20px 20px",
      }}
    >
      <style>{`
        @keyframes live-ping {
          0%   { transform: scale(0.6); opacity: 0.9; }
          100% { transform: scale(4.5); opacity: 0;   }
        }
      `}</style>

      {/* ─── Top bar ─────────────────────────────────────── */}
      <header className="shrink-0 border-b border-[#322c25] bg-[#16120f]">
        <div className="max-w-[1400px] mx-auto px-6 h-12 flex items-center justify-between gap-4">
          <a href="/" className="flex items-center gap-2" aria-label="Nous">
            <img src="/nous-logo.svg" alt="" className="h-5 w-5" />
            <span className="text-[12.5px] font-semibold tracking-tight text-[#e8e3dc]">nous</span>
          </a>
          <div className="text-[10.5px] uppercase tracking-[0.22em] text-[#8a8178] hidden sm:block">
            Global Operations
          </div>
          <div className="flex items-center gap-2 text-[12px] tabular-nums">
            <span className="h-1.5 w-1.5 rounded-full bg-[#d97757] animate-pulse" />
            <span className="text-[#e8e3dc] font-semibold">
              {(snap?.opsLast60Min ?? 0).toLocaleString()}
            </span>
            <span className="text-[#6f665c]">/ 60 min</span>
          </div>
        </div>
      </header>

      {error && !snap && (
        <div className="shrink-0 mx-6 mt-3 rounded-md border border-[#322c25] bg-[#16120f] px-3 py-2 text-[11px] text-[#c76b4a]">
          Couldn't reach the live ops endpoint ({error}).
        </div>
      )}

      {/* ─── Counter (compact, top-of-page) ─────────────── */}
      <section className="shrink-0 max-w-[1400px] mx-auto w-full px-6 pt-6 pb-4">
        <div
          className="text-[#e8915b] leading-none tabular-nums tracking-tight text-center break-all"
          style={{
            fontSize: "clamp(2rem, 6.5vw, 4.5rem)",
            textShadow: "0 0 22px rgba(217,119,87,0.22)",
          }}
        >
          {formatCounter(counter)}
        </div>
        <div className="mt-2 text-center text-[10.5px] uppercase tracking-[0.22em] text-[#8a8178]">
          operations served · all time
        </div>
      </section>

      {/* ─── Main grid: feed (left) · stats + map (right) ── */}
      <main className="flex-1 min-h-0 max-w-[1400px] mx-auto w-full px-6 pb-6 grid lg:grid-cols-[1.5fr_1fr] gap-4">
        {/* LEFT — Live feed (only scrollable region on page) */}
        <div className="rounded-xl border border-[#322c25] bg-[#16120f] flex flex-col min-h-0 overflow-hidden">
          <div className="shrink-0 flex items-center justify-between px-4 py-2.5 border-b border-[#322c25]">
            <div className="flex items-center gap-2 text-[10.5px] uppercase tracking-[0.18em] text-[#8a8178]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#d97757] animate-pulse" />
              <span>Live operations</span>
            </div>
            <span className="text-[10px] uppercase tracking-[0.18em] text-[#6f665c] tabular-nums">
              {feed.length}
            </span>
          </div>
          <div className="flex-1 overflow-y-auto">
            {feed.length === 0 ? (
              <div className="px-4 py-6 text-[12px] text-[#6f665c]">
                {snap ? "No ops logged yet." : "Connecting…"}
              </div>
            ) : (
              feed.map((ev, i) => <FeedRow key={`${ev.ts}-${i}`} event={ev} />)
            )}
          </div>
        </div>

        {/* RIGHT — Stats + Map */}
        <div className="flex flex-col gap-4 min-h-0">
          <div className="shrink-0 rounded-xl border border-[#322c25] bg-[#16120f] overflow-hidden">
            <div className="px-4 py-2.5 border-b border-[#322c25] text-[10.5px] uppercase tracking-[0.18em] text-[#8a8178]">
              Global stats
            </div>
            <div className="divide-y divide-[#322c25]/60">
              <StatRow icon={Globe2}   label="Instances online"  value={(snap?.instancesOnline ?? 0).toLocaleString()} />
              <StatRow icon={Zap}      label="Operations / sec"  value={opsPerSecLabel} />
              <StatRow icon={Activity} label="Ops · last 60 min"  value={(snap?.opsLast60Min ?? 0).toLocaleString()} />
              <StatRow icon={Globe2}   label="Countries"         value={String(snap?.countries ?? 0)} />
            </div>
          </div>

          <div className="flex-1 min-h-0 rounded-xl border border-[#322c25] bg-[#16120f] overflow-hidden flex flex-col">
            <div className="shrink-0 px-4 py-2.5 border-b border-[#322c25] text-[10.5px] uppercase tracking-[0.18em] text-[#8a8178]">
              Activity by region
            </div>
            <div className="flex-1 min-h-0 p-3">
              <WorldMap regions={snap?.recentRegions ?? []} viewerLoc={viewerLoc} />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
