// The graph panel.
//
// GROUP and FILTER are different verbs. Conflating them is what made this thing feel
// like it was lying to you.
//
//   FILTER removes. "No budget-holder" is a filter: a condition you want to look at on
//   its own. It is not a group — a bucket of accounts with no budget-holder tells you
//   nothing about the accounts that do have one, so there is nothing to compare it to.
//
//   GROUP partitions. Every account lands in exactly one bucket and the buckets ARE the
//   answer. ICP tier is a grouping. So is "which signal scored this account". You do not
//   pick a group to look at — you pick an AXIS, and the graph colours itself along it.
//
// The old panel called both of them groups. So switching one on dimmed 90% of the canvas
// and left you staring at a highlighted fragment with no context, which is why it read
// as decoration. Grouping by tier lights up the WHOLE graph in four colours and the
// clusters physically separate. That is a map. The other thing was a spotlight.
//
// Every control shows its consequence. A filter that will not tell you how much it just
// removed is a filter you cannot trust.
import { useState } from "react";
import { Search, X, RotateCcw, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export type Show = { people: boolean; companies: boolean; claims: boolean; orphans: boolean };
export type Group = { q: string; color: string; label?: string };
export type Display = { node: number; label: number; link: number };
export type Forces = { repel: number; dist: number; center: number };
export type Counts = {
  companies: number; people: number; claims: number; matched: number | null; total: number;
  groups: number[];
  signals?: { key: string; n: number }[];
  patterns?: { key: string; n: number; cat: string }[];
};

export type GroupBy = "tier" | "signal" | "pattern" | "activity" | "custom";

// A palette, not a colour picker. Colours you can tell apart at 6px on white, which is
// the only test that matters here.
const SWATCHES = ["#e0a03a", "#2fa36b", "#d4574c", "#7c5cf0", "#2aa8a0", "#4a7fd4", "#c2410c", "#0891b2"];

// The tier colours are the SAME ones the table and the record use. The graph must never
// have its own private idea of what Tier 1 looks like.
const TIER_GROUPS: Group[] = [
  { label: "Tier 1",   q: "tier:t1",      color: "#15803d" },
  { label: "Tier 2",   q: "tier:t2",      color: "#ca8a04" },
  { label: "Tier 3",   q: "tier:t3",      color: "#ea580c" },
  { label: "Not ICP",  q: "tier:not-icp", color: "#9aa0ad" },
  // Never scored is a real bucket, not an absence. It is usually the biggest one, and
  // leaving it grey and dimmed hid the single most actionable fact on the canvas.
  { label: "Never scored", q: "unscored", color: "#4a7fd4" },
];

const ACTIVITY_GROUPS: Group[] = [
  { label: "This week",   q: "quiet:0-7",    color: "#15803d" },
  { label: "This month",  q: "quiet:8-30",   color: "#2aa8a0" },
  { label: "Went cold",   q: "quiet:31-90",  color: "#e0a03a" },
  { label: "Long gone",   q: "quiet>90",     color: "#d4574c" },
  { label: "Never active", q: "dormant",     color: "#9aa0ad" },
];

const pretty = (k: string) =>
  k.replace(/^exclusion\./, "").replace(/_/g, " ").replace(/^\w/, c => c.toUpperCase());

// A pattern is coloured by WHAT KIND of thing it is, not by its position in a palette.
// Stack, pain, intent and segment are four different reasons to care about an account, and
// the colour should say which one you are looking at before you read the label.
// Revenue types — the colour says the ACTION before you read the label:
// pain=wedge, objection=friction, tool=stack, competitor=win/loss, play=timing,
// person=who-signs, connection=warm-path, channel=attribution, segment=lookalike.
const CAT_COLOR: Record<string, string> = {
  pain:       "#d4574c",
  objection:  "#c2410c",
  tool:       "#7c5cf0",
  competitor: "#0891b2",
  play:       "#2aa8a0",
  person:     "#2fa36b",
  connection: "#4a7fd4",
  channel:    "#e0a03a",
  segment:    "#9aa0ad",
  // legacy fallbacks (old whole-claim cluster kinds)
  stack:   "#7c5cf0",
  intent:  "#2aa8a0",
  theme:   "#9aa0ad",
};

const slug = (s: string) => s.toLowerCase().replace(/\s+/g, "_");

// Build the grouping for an axis. `signals` comes from the engine — the signals that have
// actually fired on a visible account — so the panel never asks you to know the
// scorecard's key names by heart.
export function buildGroups(
  by: GroupBy,
  facets: { signals?: { key: string; n: number }[]; patterns?: { key: string; n: number; cat: string }[] } = {},
): Group[] {
  if (by === "tier")     return TIER_GROUPS;
  if (by === "activity") return ACTIVITY_GROUPS;
  if (by === "signal") {
    return (facets.signals ?? []).slice(0, 7)
      .map((s, i) => ({ label: pretty(s.key), q: `sig:${s.key}`, color: SWATCHES[i % SWATCHES.length] }));
  }
  if (by === "pattern") {
    // Eight, because patterns overlap and a node belongs to several — past eight hubs the
    // spokes turn into a hairball and you stop being able to read the overlap, which was
    // the only reason to draw it.
    return (facets.patterns ?? []).slice(0, 8)
      .map(p => ({ label: p.key, q: `pat:${slug(p.key)}`, color: CAT_COLOR[p.cat] ?? CAT_COLOR.theme }));
  }
  return [];
}

export function GraphFilters({
  show, setShow, search, setSearch,
  groupBy, setGroupBy, lens, setLens, groups, setGroups,
  filter, setFilter,
  display, setDisplay, forces, setForces, counts, onFit,
}: {
  show: Show; setShow: (s: Show) => void;
  search: string; setSearch: (s: string) => void;
  groupBy: GroupBy; setGroupBy: (g: GroupBy) => void;
  lens: string; setLens: (l: string) => void;
  groups: Group[]; setGroups: (g: Group[]) => void;
  filter: string; setFilter: (f: string) => void;
  display: Display; setDisplay: (d: Display) => void;
  forces: Forces; setForces: (f: Forces) => void;
  counts: Counts;
  onFit: () => void;
}) {
  // Lens list — ICP overview + one row per revenue category present in the graph.
  // These re-render the graph toward that category (its concept hubs + the accounts
  // on them); they colour nothing, so there is deliberately no swatch.
  const LENSES: { id: string; label: string }[] = [
    { id: "icp", label: "ICP overview" },
    { id: "pain", label: "Pains" },
    { id: "objection", label: "Objections" },
    { id: "play", label: "Goals & plays" },
    { id: "competitor", label: "Competitors" },
    { id: "tool", label: "Stack" },
    { id: "person", label: "People" },
    { id: "connection", label: "Warm paths" },
    { id: "channel", label: "Channels" },
    { id: "segment", label: "Segments" },
  ];
  const typeCounts: Record<string, number> = {};
  for (const p of (counts.patterns ?? [])) typeCounts[p.cat] = (typeCounts[p.cat] || 0) + 1;
  const [openDisplay, setOpenDisplay] = useState(false);
  const [openForces, setOpenForces] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const active = filter.trim().split(/\s+/).filter(Boolean);
  const toggleFilter = (q: string) => {
    const has = active.includes(q);
    setFilter((has ? active.filter(x => x !== q) : [...active, q]).join(" "));
  };

  const reset = () => {
    setShow({ people: true, companies: true, claims: true, orphans: true });
    setSearch("");
    setFilter("");
    setGroupBy("tier");
    setLens("icp");
    setDisplay({ node: 1, label: 1, link: 1 });
    setForces({ repel: 1, dist: 1, center: 1 });
    onFit();
  };

  return (
    <aside className={cn(
      "absolute right-4 top-4 bottom-4 z-10 w-[268px] flex flex-col",
      "rounded-xl border border-border/80 bg-background/85 backdrop-blur-xl",
      "shadow-[0_8px_30px_rgba(0,0,0,0.10)] overflow-hidden",
      collapsed && "bottom-auto",
    )}>
      <div className="px-3.5 py-3 flex items-center justify-between border-b border-border/60 flex-shrink-0">
        <button onClick={() => setCollapsed(c => !c)} className="flex items-center gap-1 group">
          <ChevronRight className={cn("h-3.5 w-3.5 text-muted-foreground/40 transition-transform", !collapsed && "rotate-90")} strokeWidth={2} />
          <span className="text-[13px] font-semibold text-foreground">Graph</span>
        </button>
        <button onClick={reset} title="Reset"
          className="p-1 rounded-md text-muted-foreground/40 hover:text-foreground hover:bg-accent transition-colors">
          <RotateCcw className="h-[14px] w-[14px]" strokeWidth={1.75} />
        </button>
      </div>

      {!collapsed && (
      <div className="flex-1 min-h-0 overflow-y-auto">

        <div className="px-3.5 py-3.5">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-[14px] w-[14px] text-muted-foreground/40" strokeWidth={1.75} />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search accounts…"
              className="w-full rounded-lg border border-border bg-background pl-8 pr-7 py-1.5 text-[12.5px] text-foreground outline-none focus:border-foreground/25 placeholder:text-muted-foreground/40"
            />
            {search && (
              <button onClick={() => setSearch("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-muted-foreground/40 hover:text-foreground">
                <X className="h-3 w-3" strokeWidth={2} />
              </button>
            )}
          </div>
          {counts.matched != null && (
            <p className="mt-1.5 text-[11.5px] text-muted-foreground/50 tabular-nums">
              <span className="text-foreground/75 font-medium">{counts.matched}</span> match
            </p>
          )}
        </div>

        {/* ── VIEW — the graph opens as the ICP overview (accounts by tier). Each row
            REFOCUSES the graph onto one revenue category: that type's concept hubs plus
            the accounts on them. It colours nothing, so there is deliberately no dot. */}
        <Section title="View" note="click to refocus the graph">
          <div className="space-y-[2px]">
            {LENSES.filter(l => l.id === "icp" || (typeCounts[l.id] || 0) > 0).map(l => (
              <button
                key={l.id}
                onClick={() => setLens(l.id)}
                className={cn(
                  "w-full flex items-center justify-between rounded-md px-2 py-1.5 text-[12.5px] text-left transition-colors",
                  lens === l.id
                    ? "bg-foreground text-background font-medium"
                    : "text-foreground/80 hover:bg-accent hover:text-foreground",
                )}
              >
                <span className="truncate">{l.label}</span>
                {l.id !== "icp" && (
                  <span className={cn("text-[11.5px] tabular-nums flex-shrink-0 ml-2",
                    lens === l.id ? "opacity-70" : "text-muted-foreground/40")}>
                    {typeCounts[l.id] || 0}
                  </span>
                )}
              </button>
            ))}
          </div>
          <p className="mt-2.5 text-[11.5px] leading-relaxed text-muted-foreground/40">
            {lens === "icp"
              ? "Accounts by ICP tier. Click a category to see its shared concepts and the accounts on them."
              : "The accounts that share each concept in this category. Click ICP overview to go back."}
          </p>
        </Section>

        {/* One filter. The panel is for CUTTING the graph (Group by), not for hunting a
            subset — that is what search is for. The single exception is decision-makers:
            "who can actually sign" is the one question worth pulling everyone else off the
            canvas to answer. Everything else (single-threaded, no-budget, activity) is a
            grouping, and lives above. */}
        <Section title="Filter">
          <Toggle
            label="Decision makers only"
            on={active.includes("dm")}
            set={() => toggleFilter("dm")}
          />
        </Section>

        <Collapse title="Display" open={openDisplay} setOpen={setOpenDisplay}>
          <Slider label="Node size"  v={display.node}  set={v => setDisplay({ ...display, node: v })} />
          <Slider label="Text size"  v={display.label} set={v => setDisplay({ ...display, label: v })} />
          <Slider label="Link width" v={display.link}  set={v => setDisplay({ ...display, link: v })} />
        </Collapse>

        <Collapse title="Forces" open={openForces} setOpen={setOpenForces}>
          <Slider label="Repel"       v={forces.repel}  set={v => setForces({ ...forces, repel: v })} />
          <Slider label="Link length" v={forces.dist}   set={v => setForces({ ...forces, dist: v })} />
          <Slider label="Gravity"     v={forces.center} set={v => setForces({ ...forces, center: v })} />
        </Collapse>
      </div>
      )}
    </aside>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="px-3.5 pb-4">
      <div className="flex items-baseline gap-2 mb-2">
        <span className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/45">{title}</span>
        {note && <span className="text-[11px] text-muted-foreground/35">{note}</span>}
      </div>
      {children}
    </div>
  );
}

function Collapse({ title, open, setOpen, children }: {
  title: string; open: boolean; setOpen: (v: boolean) => void; children: React.ReactNode;
}) {
  return (
    <div className="px-3.5 pb-3 border-t border-border/50 pt-3">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-1 group">
        <ChevronRight className={cn("h-3.5 w-3.5 text-muted-foreground/40 transition-transform", open && "rotate-90")} strokeWidth={2} />
        <span className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/45 group-hover:text-foreground/70 transition-colors">{title}</span>
      </button>
      {open && <div className="mt-2.5 space-y-2.5">{children}</div>}
    </div>
  );
}

function Toggle({ label, on, set, count, hint }: {
  label: string; on: boolean; set: (v: boolean) => void; count?: number; hint?: string;
}) {
  return (
    <button onClick={() => set(!on)} title={hint} className="w-full flex items-center gap-2 py-[5px] group">
      <span className={cn(
        "relative h-[15px] w-[26px] rounded-full flex-shrink-0 transition-colors",
        on ? "bg-foreground" : "bg-muted-foreground/20",
      )}>
        <span className={cn(
          "absolute top-[2px] h-[11px] w-[11px] rounded-full bg-background transition-all",
          on ? "left-[13px]" : "left-[2px]",
        )} />
      </span>
      <span className={cn("text-[12.5px] flex-1 text-left transition-colors", on ? "text-foreground/85" : "text-muted-foreground/45")}>
        {label}
      </span>
      {count != null && <span className="text-[11.5px] tabular-nums text-muted-foreground/40">{count}</span>}
    </button>
  );
}

function Slider({ label, v, set }: { label: string; v: number; set: (v: number) => void }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[12px] text-muted-foreground/60">{label}</span>
        <span className="text-[11px] tabular-nums text-muted-foreground/35">{v.toFixed(1)}×</span>
      </div>
      <input
        type="range" min={0.3} max={2.5} step={0.1} value={v}
        onChange={e => set(Number(e.target.value))}
        className="w-full h-1 rounded-full appearance-none bg-muted-foreground/20 accent-foreground cursor-pointer"
      />
    </div>
  );
}
