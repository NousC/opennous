// Adoption — how the team actually uses AI.
//
// The question every buyer has and nobody can answer: "we deployed agents, is
// anyone using them, and for what?" Every AI tool can prove it ran. Only Nous can
// show what it ran FOR, across Claude Code, the SDK and the in-app agent at once,
// because all three come through one graph.
//
// The chart deliberately does NOT count webhooks firing or bulk scripts — see
// isAgentUsage() on the server. Those are the product working, not a person using
// it, and counting them would bury every real interaction.
import { useState, useEffect, useMemo, useRef, useLayoutEffect } from "react";
import { format } from "date-fns";
import { useAuth } from "@/contexts/AuthContext";
import { MetricStrip } from "@/components/MetricStrip";
import { PageHeader } from "@/components/ui/page-header";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

type UseCase = { key: string; label: string; count: number; pct: number };
type TrendRow = { week: string; total: number } & Record<string, number | string>;
type Surface = { key: string; label: string; count: number };
type Member = {
  user_id: string;
  name: string;
  avatar: string | null;
  ops: number;
  last_activity: string | null;
  mix: Record<string, number>;
};
type Data = {
  days: number;
  total: number;
  use_cases: UseCase[];
  trend: TrendRow[];
  surfaces: Surface[];
  members: Member[];
  dormant: { user_id: string; name: string; avatar: string | null }[];
  unattributed: number;
  excluded: number;
};

// Categorical palette, validated with the dataviz validator against both
// surfaces (light: passes, contrast WARN → obliges visible labels; dark: passes,
// CVD ΔE 10.3 → obliges direct labels). Every series is directly labelled in the
// distribution list below, which is what satisfies both.
//
// Colour follows the USE CASE, never its rank — filtering must never repaint the
// survivors.
const SERIES: Record<string, { light: string; dark: string }> = {
  account_research: { light: "#2a78d6", dark: "#3987e5" },
  icp_targeting:    { light: "#1baf7a", dark: "#199e70" },
  recording_intel:  { light: "#eda100", dark: "#c98500" },
  list_building:    { light: "#008300", dark: "#008300" },
  meeting_prep:     { light: "#4a3aa7", dark: "#9085e9" },
  follow_up:        { light: "#e34948", dark: "#e66767" },
  pattern_analysis: { light: "#e87ba4", dark: "#d55181" },
  outreach:         { light: "#eb6834", dark: "#d95926" },
  // Beyond the eight slots we do NOT generate a hue — these fold into neutrals.
  data_hygiene:     { light: "#6b7280", dark: "#9ca3af" },
  other:            { light: "#9ca3af", dark: "#6b7280" },
};

const useIsDark = () => {
  const [dark, setDark] = useState(() =>
    typeof document !== "undefined" && document.documentElement.classList.contains("dark"));
  useEffect(() => {
    const el = document.documentElement;
    const obs = new MutationObserver(() => setDark(el.classList.contains("dark")));
    obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return dark;
};

const colorOf = (key: string, dark: boolean) =>
  (SERIES[key] ?? SERIES.other)[dark ? "dark" : "light"];

/** The chart must be drawn at the width it will actually occupy — otherwise the
 *  SVG keeps its own aspect ratio and floats, centred, inside a wider card. */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width) setW(width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

// ─── The trend ──────────────────────────────────────────────────────────────
//
// Stacked area, weekly. Daily buckets on this volume are a spiky mess that reads
// as noise; a trend exists to show shape. 2px surface gaps between segments per
// the mark spec, and a crosshair tooltip because an SVG chart that can't be
// interrogated is a picture, not a chart.

/** Round an axis up to a number a person would actually choose (10, 25, 50, 100…)
 *  and step it evenly. An axis topping out at "86" is the raw max leaking through;
 *  a real axis is a scale you can read a value off. */
function niceScale(max: number, targetTicks = 4) {
  if (max <= 0) return { top: 1, ticks: [0, 1] };
  const raw = max / targetTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(Math.round(v * 100) / 100);
  return { top, ticks };
}

/** A smooth path through points. Straight polylines read as a sawtooth on weekly
 *  buckets; a monotone curve reads as a shape, which is what a trend is for. */
function smooth(pts: [number, number][]) {
  if (pts.length < 2) return pts.length ? `M ${pts[0][0]},${pts[0][1]}` : "";
  let d = `M ${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const cx = (x0 + x1) / 2;   // horizontal control points — no overshoot below zero
    d += ` C ${cx},${y0} ${cx},${y1} ${x1},${y1}`;
  }
  return d;
}

function TrendChart({ trend, keys, dark }: { trend: TrendRow[]; keys: string[]; dark: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const [box, boxW] = useWidth<HTMLDivElement>();

  const W = Math.max(boxW || 420, 280), H = 210, PAD_L = 34, PAD_R = 10, PAD_B = 26, PAD_T = 10;
  const rawMax = Math.max(1, ...trend.map(t => t.total));
  const { top, ticks } = niceScale(rawMax);
  const stepX = trend.length > 1 ? (W - PAD_L - PAD_R) / (trend.length - 1) : 0;
  const x = (i: number) => PAD_L + i * stepX;
  const y = (v: number) => PAD_T + (1 - v / top) * (H - PAD_T - PAD_B);

  // Every nth week gets an x label, so they never collide however narrow the card.
  const labelEvery = Math.max(1, Math.ceil(trend.length / Math.max(2, Math.floor((W - PAD_L) / 64))));

  // Cumulative stack, bottom-up in fixed series order.
  const stacked = trend.map(row => {
    let acc = 0;
    return keys.map(k => {
      const v = Number(row[k] ?? 0);
      const seg = { key: k, y0: acc, y1: acc + v, v };
      acc += v;
      return seg;
    });
  });

  const areaFor = (ki: number) => {
    const top = smooth(stacked.map((segs, i) => [x(i), y(segs[ki].y1)] as [number, number]));
    const bottomPts = stacked.map((segs, i) => [x(i), y(segs[ki].y0)] as [number, number]).reverse();
    const bottom = smooth(bottomPts).replace(/^M/, "L");
    return `${top} ${bottom} Z`;
  };

  if (!trend.length) return null;

  return (
    <div className="relative w-full" ref={box}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img"
        aria-label="Weekly use of the agents, stacked by use case">
        {/* Y axis — a gridline and a value at every tick. Recessive: it orients,
            it does not compete with the data. The baseline is solid, the rest are
            dashed, so the zero line reads as the floor rather than as one more
            gridline among several. */}
        {ticks.map(t => (
          <g key={t}>
            <line
              x1={PAD_L} x2={W - PAD_R} y1={y(t)} y2={y(t)}
              className="stroke-border"
              strokeWidth={1}
              strokeDasharray={t === 0 ? "0" : "2 4"}
              strokeOpacity={t === 0 ? 1 : 0.6}
            />
            <text
              x={PAD_L - 7}
              y={y(t) + 3}
              textAnchor="end"
              className="fill-muted-foreground/70 text-[9px] tabular-nums"
            >
              {t}
            </text>
          </g>
        ))}

        {keys.map((k, ki) => (
          <path
            key={k}
            d={areaFor(ki)}
            fill={colorOf(k, dark)}
            fillOpacity={0.9}
            // 2px surface gap between stacked segments, per the mark spec.
            stroke={dark ? "#1a1a19" : "#ffffff"}
            strokeWidth={2}
          />
        ))}

        {/* Crosshair */}
        {hover !== null && (
          <line x1={x(hover)} x2={x(hover)} y1={PAD_T} y2={H - PAD_B}
            className="stroke-foreground/40" strokeWidth={1} />
        )}

        {/* Hit targets, bigger than the marks. */}
        {trend.map((_, i) => (
          <rect key={i} x={x(i) - stepX / 2} y={0} width={Math.max(stepX, 12)} height={H}
            fill="transparent" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
        ))}

        {/* X axis — a dated tick every nth week, spaced so labels never collide at
            any card width. The last week is always labelled: "where are we now" is
            the question people actually bring to a trend. */}
        {trend.map((row, i) => {
          const isLast = i === trend.length - 1;
          if (i % labelEvery !== 0 && !isLast) return null;
          // Drop a regular tick that would crowd the pinned last one.
          if (!isLast && trend.length - 1 - i < labelEvery / 2) return null;
          return (
            <g key={row.week}>
              <line
                x1={x(i)} x2={x(i)} y1={H - PAD_B} y2={H - PAD_B + 3}
                className="stroke-border" strokeWidth={1}
              />
              <text
                x={x(i)}
                y={H - PAD_B + 13}
                textAnchor={i === 0 ? "start" : isLast ? "end" : "middle"}
                className="fill-muted-foreground/70 text-[9px]"
              >
                {format(new Date(row.week), "MMM d")}
              </text>
            </g>
          );
        })}
      </svg>

      {hover !== null && trend[hover] && (
        <div className="absolute top-0 right-0 rounded-lg border border-border bg-background shadow-md px-3 py-2 pointer-events-none">
          <p className="text-[11px] font-medium text-foreground mb-1">
            week of {format(new Date(trend[hover].week), "MMM d")}
          </p>
          {keys
            .filter(k => Number(trend[hover][k] ?? 0) > 0)
            .map(k => (
              <p key={k} className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-[2px]" style={{ background: colorOf(k, dark) }} />
                {SERIES_LABEL[k] ?? k}
                <span className="ml-auto tabular-nums text-foreground/80">{trend[hover][k]}</span>
              </p>
            ))}
        </div>
      )}
    </div>
  );
}

// Filled from the API response so labels stay in one place.
const SERIES_LABEL: Record<string, string> = {};

// ─── Skeleton ─────────────────────────────────────────────────────────────────
// Shown on the FIRST load only, so the page has its shape before the data lands —
// a spinner on a blank page makes the layout feel like it's being built from
// scratch every time. On later loads (a date-filter change) the real data stays on
// screen, blurred, instead of this.

const Bar = ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
  <div className={cn("rounded bg-muted/60 animate-pulse", className)} style={style} />
);

function AdoptionSkeleton() {
  return (
    <div aria-hidden>
      {/* Metric strip */}
      <div className="mb-5 grid grid-cols-2 sm:grid-cols-4 gap-px rounded-xl border border-border overflow-hidden">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="bg-background p-4">
            <Bar className="h-3 w-20 mb-2.5" />
            <Bar className="h-6 w-14" />
          </div>
        ))}
      </div>

      {/* Two charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5">
        <div className="rounded-xl border border-border bg-background p-5">
          <Bar className="h-3 w-40 mb-5" />
          <Bar className="h-[190px] w-full" />
        </div>
        <div className="rounded-xl border border-border bg-background p-5">
          <Bar className="h-3 w-36 mb-5" />
          <div className="space-y-3.5">
            {[92, 74, 58, 40, 28].map((w, i) => (
              <div key={i}>
                <div className="flex justify-between mb-1.5"><Bar className="h-3 w-28" /><Bar className="h-3 w-8" /></div>
                <Bar className="h-2 rounded-full" style={{ width: `${w}%` }} />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* People */}
      <div className="rounded-xl border border-border bg-background p-5">
        <Bar className="h-3 w-44 mb-4" />
        {[...Array(4)].map((_, i) => (
          <div key={i} className="flex items-center gap-3 py-3 border-b border-border/40">
            <div className="h-6 w-6 rounded-full bg-muted/60 animate-pulse shrink-0" />
            <Bar className="h-3 w-32 flex-1 max-w-[200px]" />
            <Bar className="hidden sm:block h-1.5 w-40 rounded-full" />
            <Bar className="h-3 w-8" />
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function Adoption() {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const workspaceId = userData?.workspace?.id ?? "";
  const dark = useIsDark();

  const [days, setDays] = useState(90);
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token || !workspaceId) return;
    setLoading(true);
    fetch(`${apiUrl}/api/adoption?workspaceId=${workspaceId}&days=${days}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!d) return;
        d.use_cases.forEach((u: UseCase) => { SERIES_LABEL[u.key] = u.label; });
        setData(d);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [token, workspaceId, days]);

  // Fixed series order — colour follows the use case, never its rank.
  const keys = useMemo(() => (data?.use_cases ?? []).map(u => u.key), [data]);
  const empty = !loading && data && data.total === 0;
  // First load has no data yet → show the skeleton so the layout exists. A later
  // load (date-filter change) keeps the current data on screen, blurred, so the page
  // never collapses back to a spinner.
  const firstLoad = loading && !data;
  const refetching = loading && !!data;

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="px-8 py-7">
        <PageHeader
          title="Adoption"
          actions={
            <div className="flex items-center gap-2">
              {[30, 90, 365].map(d => (
                <button
                  key={d}
                  onClick={() => setDays(d)}
                  className={`px-3 py-1 rounded-md text-[12px] font-semibold border transition-colors ${
                    days === d
                      ? "bg-foreground text-background border-foreground"
                      : "bg-background border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {d === 365 ? "1y" : `${d}d`}
                </button>
              ))}
            </div>
          }
        />

        {firstLoad && <AdoptionSkeleton />}

        {empty && (
          <div className="mt-12 border-t border-border pt-7">
            <p className="text-[13px] text-foreground">No agent activity yet.</p>
            <p className="text-[12px] text-muted-foreground/70 mt-1.5 leading-relaxed max-w-md">
              This fills in as your team uses the agents — in Claude Code, through the SDK, or here in
              the app. Webhooks and syncs don't count; this is people, not plumbing.
            </p>
          </div>
        )}

        {data && data.total > 0 && (
          <div className={cn(
            "transition-all duration-200",
            refetching && "blur-[3px] opacity-60 pointer-events-none select-none",
          )}>
            {/* Headline — the same strip the ICP page uses. See MetricStrip.

                Every surface gets a cell, not the top two: truncating the list hides
                whichever surface is newest, and a surface at 4 runs is the
                interesting number, not the unimportant one. */}
            <MetricStrip
              className="mb-5"
              metrics={[
                { label: "Agent runs",     value: data.total.toLocaleString() },
                { label: "People using it", value: data.members.length },
                ...data.surfaces.map(s => ({ label: s.label, value: s.count.toLocaleString() })),
              ]}
            />

            {/* Trend */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5">
              <div className="rounded-xl border border-border bg-background p-5">
                <p className="text-[12px] font-semibold tracking-wide text-muted-foreground uppercase mb-4">
                  Agent activity over time
                </p>
                {data.trend.length > 1
                  ? <TrendChart trend={data.trend} keys={keys} dark={dark} />
                  : <p className="text-[12px] text-muted-foreground/60 py-12 text-center">Not enough history yet.</p>}
              </div>

            {/* Distribution. This doubles as the legend AND the table view — which
                is what the palette's contrast/CVD warnings oblige. Every series is
                directly labelled with its name and its number. */}
              <div className="rounded-xl border border-border bg-background p-5">
              <p className="text-[12px] font-semibold tracking-wide text-muted-foreground uppercase mb-1">
                Use case distribution
              </p>
              {/* A ranked bar chart, not a list with a bar stuck on the end. The
                  bar IS the magnitude, so it's scaled to the biggest category and
                  gets the full width — a 32% share reading as a 40px sliver was
                  decoration pretending to be data. Every bar is directly labelled
                  with its name and count, which is what the palette's contrast and
                  CVD warnings oblige. */}
              <div className="mt-3 space-y-2.5">
                {data.use_cases.map(u => {
                  const share = data.use_cases[0].count
                    ? (u.count / data.use_cases[0].count) * 100
                    : 0;
                  return (
                    <div key={u.key} className="group">
                      <div className="flex items-baseline gap-2 mb-1">
                        <span className="text-[12.5px] text-foreground min-w-0 flex-1 truncate">
                          {u.label}
                        </span>
                        <span className="text-[12.5px] tabular-nums text-foreground/80">{u.count}</span>
                        <span className="text-[11px] tabular-nums text-muted-foreground/50 w-9 text-right">
                          {u.pct}%
                        </span>
                      </div>
                      <div className="h-2 w-full rounded-full bg-muted/60 overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all group-hover:brightness-110"
                          style={{
                            width: `${Math.max(share, 1.5)}%`,
                            background: colorOf(u.key, dark),
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
              </div>
            </div>

            {/* People — full width, below the two charts. */}
            <div className="rounded-xl border border-border bg-background p-5">
              <p className="text-[12px] font-semibold tracking-wide text-muted-foreground uppercase mb-1">
                Adoption by team member
              </p>

              {data.members.map(m => {
                const mix = Object.entries(m.mix).sort((a, b) => b[1] - a[1]);
                return (
                  <div key={m.user_id} className="flex items-center gap-3 py-3 border-b border-border/40">
                    <Avatar className="h-6 w-6 border border-border shrink-0">
                      <AvatarImage src={m.avatar || undefined} alt={m.name} />
                      <AvatarFallback className="text-[9px] font-semibold bg-muted text-muted-foreground">
                        {m.name.charAt(0).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <span className="text-[13px] text-foreground min-w-0 flex-1 truncate">{m.name}</span>
                    {/* Their use-case mix, as one bar. */}
                    <div className="hidden sm:flex w-40 h-1.5 rounded-full overflow-hidden bg-muted gap-px">
                      {mix.map(([k, v]) => (
                        <span key={k} title={`${SERIES_LABEL[k] ?? k}: ${v}`}
                          style={{ width: `${(v / m.ops) * 100}%`, background: colorOf(k, dark) }} />
                      ))}
                    </div>
                    <span className="text-[12px] tabular-nums text-muted-foreground w-12 text-right">{m.ops}</span>
                    <span className="text-[11px] text-muted-foreground/60 w-16 text-right">
                      {m.last_activity ? format(new Date(m.last_activity), "MMM d") : "—"}
                    </span>
                  </div>
                );
              })}

              {/* The absence is the insight. A page that only lists the people
                  already using it cannot tell you who isn't. */}
              {data.dormant.length > 0 && (
                <div className="mt-4 flex items-center gap-2.5 flex-wrap">
                  <span className="text-[12px] text-muted-foreground/60">Not using it yet:</span>
                  {data.dormant.map(d => (
                    <span key={d.user_id} className="inline-flex items-center gap-1.5">
                      <Avatar className="h-5 w-5 border border-border opacity-50">
                        <AvatarImage src={d.avatar || undefined} alt={d.name} />
                        <AvatarFallback className="text-[8px] bg-muted text-muted-foreground">
                          {d.name.charAt(0).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <span className="text-[12px] text-muted-foreground/70">{d.name}</span>
                    </span>
                  ))}
                </div>
              )}

              {/* Say what we can't attribute, rather than quietly dropping it. */}
              {data.unattributed > 0 && (
                <p className="text-[11.5px] text-muted-foreground/50 mt-4 leading-relaxed">
                  {data.unattributed.toLocaleString()} runs aren't attributed to a person — they
                  happened before per-user tracking, or came from a workspace-wide API key.
                  New activity is attributed.
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
