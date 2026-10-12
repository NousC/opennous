// The Intel tab's Story (GET-794, GET-797, GET-799): the account's facts on one time axis by when
// they were said, a lane per group in that group's colour, a dashed line from a fact to the one that
// replaced it. Hover a dot for the fact. No counts and no legend: the colours are the Intel tab's
// lenses, and the lens picked there narrows the lanes. Public, so the account, the person and the
// deal all draw it from the account's timeline (GET /api/companies/:id/intel-timeline).
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";
import { ListCard } from "@/components/ui/list";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

export type StoryLane = { key: string; label: string; count: number };
export type StoryFact = {
  id: string; category: string; lane: string; label: string | null; content: string; said_at: string;
  live: boolean; superseded_by: string | null; supersedes: string | null; status: string | null;
  quote: string | null; speaker: string | null; voiced_by_contact_id: string | null; entity_id: string;
};
export type StoryData = { days: number | null; since: string | null; lanes: StoryLane[]; facts: StoryFact[]; links: { from: string; to: string }[] };
type Fact = StoryFact;

/** The account's timeline, one read per range; shared by the Story and the Intel view's "was → now". */
export function useIntelStory(companyId: string | null | undefined, range: string) {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const wsId = (userData as { workspace?: { id?: string } } | null)?.workspace?.id ?? "";
  return useQuery({
    queryKey: ["account-intel-timeline", wsId, companyId, range],
    enabled: !!token && !!wsId && !!companyId,
    staleTime: 60_000,
    queryFn: async (): Promise<StoryData | null> => {
      const r = await fetch(`${apiUrl}/api/companies/${companyId}/intel-timeline?workspaceId=${wsId}&days=${range}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) return null;
      return (await r.json()) as StoryData;
    },
  });
}

const RANGES: [string, string][] = [["30", "30 days"], ["90", "90 days"], ["all", "All"]];

const CATEGORY_LABEL: Record<string, string> = {
  buying_signal: "Buying signal", expansion_signal: "Expansion", blocker: "Blocker", objection: "Objection",
  timeline: "Timeline", budget: "Budget", requirement: "Requirement", authority: "Stakeholder",
  staff_change: "Staff change", relationship: "Relationship", tech_stack: "Tech stack", risk_signal: "Risk",
};

const DAY = 86_400_000;
const LANE_H = 30;
const AXIS_H = 22;
const PAD_R = 14;
const fmtDay = (t: number | string) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const isResolved = (f: Fact) => f.status === "resolved" || f.status === "addressed";
const clip = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    setW(Math.round(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

export type TimelineGroup = { key: string; label: string; color: string };

export function IntelStory({ companyId, nameOf, groups, laneOf, only }: {
  companyId: string | null;
  nameOf?: (id: string) => string | null;
  /** The Intel view's groups, in its order: the lanes are exactly the lenses (GET-801). */
  groups: TimelineGroup[];
  /** Which group a fact belongs to, as the Intel view files it; null leaves it off the timeline. */
  laneOf: (f: StoryFact) => string | null;
  /** The picked lens; null = every group. */
  only?: string | null;
}) {
  const [range, setRange] = useState("90");
  const [hover, setHover] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const q = useIntelStory(companyId, range);
  const data = q.data ?? null;
  const facts = useMemo(() => (data?.facts ?? [])
    .map(f => ({ ...f, lane: laneOf(f) ?? "" }))
    .filter(f => f.lane && (!only || f.lane === only)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, only, groups.map(g => g.key).join(",")]);
  const lanes = groups.filter(g => facts.some(f => f.lane === g.key));
  const colorOf = (lane: string) => groups.find(g => g.key === lane)?.color ?? "#A9A8A2";
  const byId = useMemo(() => new Map(facts.map(f => [f.id, f])), [facts]);

  // Geometry. The axis runs from the window's start (or the first fact, for All) to today.
  const labelW = width && width < 480 ? 88 : 128;
  const plotW = Math.max(0, width - labelW - PAD_R);
  const now = Date.now();
  const first = facts.length ? Date.parse(facts[0].said_at) : now - 30 * DAY;
  const t0 = data?.since ? Date.parse(data.since) : Math.min(first, now - 7 * DAY) - DAY;
  const span = Math.max(DAY, now - t0);
  const x = (iso: string) => labelW + Math.min(1, Math.max(0, (Date.parse(iso) - t0) / span)) * plotW;
  const laneIdx = new Map(lanes.map((l, i) => [l.key, i]));

  // Two facts a few pixels apart in one lane step apart vertically instead of hiding each other.
  const pos = useMemo(() => {
    const m = new Map<string, { cx: number; cy: number }>();
    const last = new Map<string, { cx: number; n: number }>();
    for (const f of facts) {
      const li = laneIdx.get(f.lane);
      if (li == null) continue;
      const cx = x(f.said_at);
      const prev = last.get(f.lane);
      const n = prev && cx - prev.cx < 9 ? prev.n + 1 : 0;
      last.set(f.lane, { cx, n });
      const off = n === 0 ? 0 : (n % 2 ? -1 : 1) * Math.min(9, 4 * Math.ceil(n / 2));
      m.set(f.id, { cx, cy: li * LANE_H + LANE_H / 2 + off });
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facts, width, lanes.length, t0, span]);

  const ticks = useMemo(() => {
    if (!plotW) return [] as number[];
    const n = Math.max(2, Math.min(6, Math.floor(plotW / 90)));
    return Array.from({ length: n + 1 }, (_, i) => t0 + (span * i) / n);
  }, [plotW, t0, span]);

  const active = pinned ?? hover;
  const activeFact = active ? byId.get(active) ?? null : null;
  // The whole chain the active fact sits on, so the line it belongs to lights up end to end.
  const chain = useMemo(() => {
    const s = new Set<string>();
    if (!activeFact) return s;
    let cur: Fact | undefined = activeFact;
    while (cur && !s.has(cur.id)) { s.add(cur.id); cur = cur.supersedes ? byId.get(cur.supersedes) : undefined; }
    cur = activeFact.superseded_by ? byId.get(activeFact.superseded_by) : undefined;
    while (cur && !s.has(cur.id)) { s.add(cur.id); cur = cur.superseded_by ? byId.get(cur.superseded_by) : undefined; }
    return s;
  }, [activeFact, byId]);

  const height = lanes.length * LANE_H + AXIS_H;

  return (
    <ListCard className="min-w-0">
      {/* The palette's header row: the name and its count on the left, the range on the right. */}
      <div className="flex min-h-8 min-w-0 items-center gap-2 px-2 pb-1.5 pt-0.5">
        <span className="text-[13px] font-medium text-foreground">Timeline</span>
        <span className="flex-1" />
        <span className="flex flex-shrink-0 items-center gap-0.5">
          {RANGES.map(([v, l]) => (
            <button key={v} type="button" onClick={() => { setRange(v); setPinned(null); }}
              className={cn("rounded-md px-1.5 py-0.5 text-[12px] transition-colors duration-fast",
                range === v ? "bg-hover text-foreground" : "text-muted-foreground/60 hover:text-foreground")}>
              {l}
            </button>
          ))}
        </span>
      </div>
      <div ref={wrapRef} className="relative min-w-0 px-2">
        {q.isLoading ? (
          <div className="h-[96px] animate-pulse rounded-[10px] bg-foreground/[0.03]" />
        ) : !facts.length ? (
          <p className="py-3 text-[12.5px] text-muted-foreground">
            {range === "all"
              ? "No intel yet. It's learned from calls and email on this account."
              : <>Nothing said in the last {range} days. <button className="text-foreground/80 underline-offset-2 hover:underline" onClick={() => setRange("all")}>Show all</button></>}
          </p>
        ) : width > 0 && (
          <>
            <svg width={width} height={height} className="block overflow-visible text-foreground"
              onClick={() => setPinned(null)}>
              {/* Lanes: a label and a hairline, nothing heavier. */}
              {lanes.map((l, i) => (
                <g key={l.key}>
                  <circle cx={4} cy={i * LANE_H + LANE_H / 2} r={3.5} fill={l.color} />
                  <text x={14} y={i * LANE_H + LANE_H / 2} dominantBaseline="middle" className="fill-muted-foreground text-[11.5px]">{l.label}</text>
                  <line x1={labelW} x2={labelW + plotW} y1={i * LANE_H + LANE_H / 2} y2={i * LANE_H + LANE_H / 2} className="stroke-foreground/[0.07]" />
                </g>
              ))}
              {/* Date axis. */}
              {ticks.map((t, i) => {
                const tx = labelW + ((t - t0) / span) * plotW;
                return (
                  <g key={i}>
                    <line x1={tx} x2={tx} y1={0} y2={lanes.length * LANE_H} className="stroke-foreground/[0.04]" />
                    <text x={tx} y={lanes.length * LANE_H + 14} textAnchor={i === 0 ? "start" : i === ticks.length - 1 ? "end" : "middle"}
                      className="fill-muted-foreground/60 text-[10.5px] tabular-nums">{i === ticks.length - 1 ? "Today" : fmtDay(t)}</text>
                  </g>
                );
              })}
              {/* Old → new: the line that connects a position to the one that replaced it. */}
              {(data?.links ?? []).map(({ from, to }) => {
                const a = pos.get(from), b = pos.get(to);
                if (!a || !b) return null;
                const lit = chain.has(from) && chain.has(to);
                const mx = (a.cx + b.cx) / 2;
                return (
                  <path key={`${from}>${to}`} d={`M${a.cx},${a.cy} C${mx},${a.cy} ${mx},${b.cy} ${b.cx},${b.cy}`}
                    fill="none" strokeWidth={lit ? 1.75 : 1.25} strokeDasharray={lit ? undefined : "3 3"}
                    stroke={colorOf(byId.get(to)?.lane ?? "")} strokeOpacity={lit ? 0.8 : 0.45} />
                );
              })}
              {/* The facts. */}
              {facts.map(f => {
                const p = pos.get(f.id);
                if (!p) return null;
                const on = active === f.id;
                const dim = !!activeFact && !chain.has(f.id);
                const ring = isResolved(f);
                return (
                  <g key={f.id} className="cursor-pointer"
                    onMouseEnter={() => setHover(f.id)} onMouseLeave={() => setHover(h => (h === f.id ? null : h))}
                    onClick={e => { e.stopPropagation(); setPinned(pid => (pid === f.id ? null : f.id)); }}>
                    <circle cx={p.cx} cy={p.cy} r={10} fill="transparent" />
                    <circle cx={p.cx} cy={p.cy} r={on ? 6 : 4.5} strokeWidth={ring || !f.live ? 1.5 : 0}
                      fill={ring || !f.live ? "hsl(var(--card))" : colorOf(f.lane)} stroke={colorOf(f.lane)}
                      className={cn("transition-all", !f.live && "opacity-50", dim && "opacity-20")} />
                  </g>
                );
              })}
            </svg>
            {activeFact && pos.get(activeFact.id) && (
              <FactCard fact={activeFact} at={pos.get(activeFact.id)!} width={width} byId={byId} nameOf={nameOf} />
            )}
          </>
        )}
      </div>
    </ListCard>
  );
}

function FactCard({ fact, at, width, byId, nameOf }: {
  fact: Fact; at: { cx: number; cy: number }; width: number; byId: Map<string, Fact>; nameOf?: (id: string) => string | null;
}) {
  const W = Math.min(300, width - 16);
  const left = Math.max(0, Math.min(at.cx - W / 2, width - W));
  const who = fact.speaker ?? (fact.voiced_by_contact_id ? nameOf?.(fact.voiced_by_contact_id) ?? null : null);
  const before = fact.supersedes ? byId.get(fact.supersedes) : undefined;
  const after = fact.superseded_by ? byId.get(fact.superseded_by) : undefined;
  const state = !fact.live ? "Replaced" : isResolved(fact) ? "Resolved" : null;
  return (
    <div className="pointer-events-none absolute z-10 rounded-[10px] bg-popover px-3 py-2.5 text-popover-foreground shadow-[0_4px_20px_rgba(0,0,0,0.08),0_0_0_1px_rgba(0,0,0,0.04)]"
      style={{ left: left + 8, top: at.cy + 14, width: W }}>
      <p className="flex items-baseline gap-2 text-[11.5px] text-muted-foreground">
        <span>{CATEGORY_LABEL[fact.category] ?? fact.category}</span>
        <span className="text-muted-foreground/60">{fmtDay(fact.said_at)}</span>
        {state && <span className="ml-auto text-muted-foreground/70">{state}</span>}
      </p>
      <p className={cn("mt-1 text-[12.5px] leading-snug", fact.live ? "text-foreground" : "text-foreground/60")}>{fact.content}</p>
      {fact.quote && (
        <p className="mt-1 text-[12px] italic leading-snug text-muted-foreground">
          “{clip(fact.quote, 180)}”{who ? <span className="not-italic"> · {who}</span> : null}
        </p>
      )}
      {!fact.quote && who && <p className="mt-1 text-[11.5px] text-muted-foreground/70">{who}</p>}
      {before && (
        <p className="mt-1.5 text-[11.5px] leading-snug text-muted-foreground/70">
          Replaced {fmtDay(before.said_at)}: {clip(before.content)}
        </p>
      )}
      {after && (
        <p className="mt-1.5 text-[11.5px] leading-snug text-muted-foreground/70">
          Became {fmtDay(after.said_at)}: {clip(after.content)}
        </p>
      )}
    </div>
  );
}
