// Deal health on the Overview (interface refresh, GET-609). The smart signals as tiles, each with a
// three-step meter; the numeric signals in a band under them (a deal's; account health sends none
// since GET-807). A tile opens its factor in a panel on the right (GET-807; it used to be a grey
// slab under the row that repeated the numbers and never listed what it counted): one line with the
// factor and its verdict, the actual items as inset rows, then what would improve it. The trend line
// is always shown (GET-804). The account and every deal draw this one card.
import { SlackText } from "@/components/record/SlackText";
import { useMemo, useState, type ReactNode } from "react";
import { healthColor } from "@/components/mind/entities";
import { day, when as fmtWhen } from "@/lib/format";
import { cn } from "@/lib/utils";
import { HealthChart, bandOf, type DealHealth, type DealSignal, type FactorItem, type Note, type Qualification } from "./RecordParts";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { H3 } from "./OverviewParts";
import { ListCard, ListEmpty } from "@/components/ui/list";

const TONE_COLOR: Record<string, string> = { good: "#2E7A4E", warn: "#C08A3E", bad: "#B0412E", unknown: "#A9A8A2" };

/** How full the meter is: the level's strength, not whether it is good. "Low" risk is one bar. */
function meterFill(level?: string): number {
  const l = String(level ?? "").toLowerCase();
  if (/high|critical|strong|severe|agreed|discussed/.test(l)) return 3;
  if (/moderate|medium|some|partial|overdue/.test(l)) return 2;
  if (/low|minor|weak|none|blocked|left/.test(l)) return 1;
  return 0;
}

/** "Competitive Risk" → "Competitive risk": sentence case, as the rest of the app. */
const sentence = (s: string) => (s ? s.charAt(0) + s.slice(1).toLowerCase().replace(/\bai\b/g, "AI") : s);
const bandText = (score: number | null, band?: string | null) => {
  const b = bandOf(score, band).replace(/_/g, " ");
  return b.charAt(0).toUpperCase() + b.slice(1);
};

export function HealthPill({ score, band, title = "Nous deal health, 0 to 100, from calls, email and the facts on the record" }: { score: number | null; band?: string | null; title?: string }) {
  if (score == null && !band) return null;
  const tone = score == null ? "muted" : score >= 70 ? "positive" : score >= 40 ? "warning" : "risk";
  // Colour on the words only, no filled pill: the palette's quiet way to say "at risk".
  const cls = tone === "positive" ? "text-positive" : tone === "warning" ? "text-warning" : tone === "risk" ? "text-risk" : "text-muted-foreground/70";
  return (
    <span title={title}
      className={cn("inline-flex flex-shrink-0 items-center gap-1.5 text-[12px]", cls)}>
      {bandText(score, band)}{score != null && <span className="tabular-nums opacity-70">{Math.round(score)}</span>}
    </span>
  );
}

function Meter({ level, tone, meter }: { level?: string; tone?: string; meter?: { bars: number; color: string } }) {
  // Account health sends its meter from the grade (GET-804): good fills three green bars, warn two
  // amber, bad one red. Deal health still reads the level's strength ("Low" risk is one bar).
  const n = meter ? meter.bars : meterFill(level);
  const color = meter?.color ?? TONE_COLOR[tone ?? "unknown"] ?? TONE_COLOR.unknown;
  return (
    <span aria-hidden className="inline-flex gap-0.5">
      {[0, 1, 2].map(i => <i key={i} className="block h-1 w-3 rounded-sm bg-border" style={i < n ? { background: color } : undefined} />)}
    </span>
  );
}

/** A fact as a tag: its short label, else the named thing, else the first few words. */
function tagOf(n: Note): string {
  const label = n.label?.trim();
  if (label) return label;
  const entity = String(n.metadata?.entity ?? "").trim();
  if (entity) return entity;
  const words = String(n.content ?? "").trim().split(/\s+/);
  return words.length > 6 ? `${words.slice(0, 6).join(" ")}…` : words.join(" ");
}

const DM_STATUS: Record<string, { label: string; tone: string }> = {
  engaged: { label: "Engaged", tone: "text-positive" },
  not_engaged: { label: "Not engaged", tone: "text-warning" },
  not_contacted: { label: "Not contacted", tone: "text-muted-foreground/60" },
  blocking: { label: "Blocking", tone: "text-risk" },
};
const DM_ROLE: Record<string, string> = { economic_buyer: "Economic buyer", decision_maker: "Decision maker", champion: "Champion", blocker: "Blocker" };

/** A deal factor sends claim ids, not rows: turn its evidence into the same rows the account sends. */
function itemsFromEvidence(notes: Note[], voicedByName?: (id?: string | null) => string | null): FactorItem[] {
  return notes.map(n => {
    const m = (n.metadata ?? {}) as Record<string, unknown>;
    const quote = typeof m.quote === "string" && m.quote.trim() ? m.quote.trim() : null;
    const speaker = voicedByName?.(m.voiced_by_contact_id as string | undefined) ?? (typeof m.speaker === "string" ? m.speaker : null);
    const status = typeof m.status === "string" ? (/^(resolved|closed|done|dismissed)$/i.test(m.status) ? "resolved" : "open") : undefined;
    return { id: n.id, label: tagOf(n), content: n.content ?? "", quote, speaker, said_at: (m.occurred_at as string | undefined) ?? n.created_at ?? null, status };
  });
}

const Group = ({ label, children }: { label?: string; children: ReactNode }) => (
  <div>
    {label && <p className="px-2 pb-1 text-[11px] text-muted-foreground/50">{label}</p>}
    <ul className="space-y-px">{children}</ul>
  </div>
);
const ROW = "rounded-lg px-2 py-2 transition-colors duration-fast hover:bg-muted/50";
const weeksText = (d?: number | null) => (d == null ? null : `${Math.floor(d / 7)} weeks`);

/** A claim as an inset row: what it says, the words someone used, who and when, open or resolved. */
function ClaimRow({ item }: { item: FactorItem }) {
  const meta = [item.speaker, item.said_at ? day(item.said_at) : null, item.status].filter(Boolean);
  return (
    <li className={ROW}>
      <p className="text-[13px] leading-snug text-foreground [overflow-wrap:anywhere]">{item.content || item.label}</p>
      {item.quote && <p className="mt-1 text-[12.5px] italic leading-snug text-foreground/60 [overflow-wrap:anywhere]">“<SlackText text={String(item.quote)} />”</p>}
      {(meta.length > 0 || item.aging) && (
        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11.5px] text-muted-foreground/55">
          {meta.map((x, i) => <span key={i} className="inline-flex items-center gap-x-1.5">{i > 0 && <span aria-hidden>·</span>}{x}</span>)}
          {item.aging && <span className="text-warning" title="Said over three weeks ago and not mentioned since">{meta.length ? "· " : ""}aging, {weeksText(item.age_days)}</span>}
        </p>
      )}
    </li>
  );
}

/** A decision maker as an inset row: who, their role, where they stand, and what was said. */
function PersonRow({ item }: { item: FactorItem }) {
  const st = DM_STATUS[item.status ?? ""] ?? DM_STATUS.not_contacted;
  const who = item.name ?? item.title ?? "Unnamed";
  const sub = [item.name ? item.title : null, DM_ROLE[item.role ?? ""] ?? null].filter(Boolean).join(" · ");
  return (
    <li className={ROW}>
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 truncate text-[13px] text-foreground">{who}{item.unnamed && <span className="text-muted-foreground/55"> (not yet named)</span>}</span>
        {sub && <span className="min-w-0 truncate text-[11.5px] text-muted-foreground/55">{sub}</span>}
        <span className={cn("ml-auto flex-shrink-0 text-[11.5px]", st.tone)}>{st.label}</span>
      </div>
      {item.quote && <p className="mt-1 text-[12.5px] italic leading-snug text-foreground/60 [overflow-wrap:anywhere]">“<SlackText text={String(item.quote)} />”</p>}
      {item.quote && item.said_at && <p className="mt-0.5 text-[11.5px] text-muted-foreground/55">{day(item.said_at)}</p>}
    </li>
  );
}

/** Eight weeks of conversations as tiny bars, this week last. */
function Spark({ weeks }: { weeks: number[] }) {
  const max = Math.max(1, ...weeks);
  const W = 10, G = 4, H = 28;
  return (
    <svg width={weeks.length * (W + G) - G} height={H} role="img" aria-label={`Conversations per week, last ${weeks.length} weeks: ${weeks.join(", ")}`}>
      {weeks.map((v, i) => {
        const h = v ? Math.max(3, Math.round((v / max) * H)) : 2;
        return <rect key={i} x={i * (W + G)} y={H - h} width={W} height={h} rx={2}
          className={i === weeks.length - 1 ? "fill-muted-foreground/45" : "fill-muted-foreground/25"} />;
      })}
    </svg>
  );
}

function EngagementDetail({ detail }: { detail: NonNullable<DealSignal["detail"]> }) {
  const rows: [string, string][] = [
    ["Last conversation", detail.last_at ? day(detail.last_at) : "None yet"],
    ["Conversations, last 30 days", String(detail.recent)],
    ["Previous 30 days", String(detail.prior)],
    ["Meetings", String(detail.meetings)],
  ];
  return (
    <div className="space-y-3">
      <div className="px-2">
        <Spark weeks={detail.weeks} />
        <p className="mt-1.5 text-[11px] text-muted-foreground/50">Conversations per week, last {detail.weeks.length} weeks</p>
      </div>
      <ul className="space-y-px">
        {rows.map(([k, v]) => (
          <li key={k} className={cn(ROW, "flex items-baseline justify-between gap-3 py-1.5")}>
            <span className="text-[12.5px] text-muted-foreground/70">{k}</span>
            <span className="text-[13px] tabular-nums text-foreground">{v}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A factor in a panel on the right (GET-807): the factor and its verdict in one line, the items it
 * counted as inset rows (the palette's: no dividers, light greys), then what would improve it.
 */
function FactorPanel({ signal, title, evidence, voicedByName }: { signal: DealSignal; title: string; evidence: Note[]; voicedByName?: (id?: string | null) => string | null }) {
  const isPeople = signal.key === "decision_makers";
  const items: FactorItem[] = signal.items ?? itemsFromEvidence(evidence, voicedByName);
  const verdict = signal.summary ?? signal.level ?? null;
  // A deal factor has no summary; its reason says why, under the line.
  const why = signal.summary ? null : (signal.verdict || signal.reason || null);
  const open = items.filter(i => i.status !== "resolved");
  const resolved = items.filter(i => i.status === "resolved");
  const grouped = items.some(i => i.status);
  const hasList = !signal.detail;

  return (
    <div className="flex min-h-0 flex-col">
      <div className="px-5 pb-4 pt-5">
        <p className="text-[11.5px] text-muted-foreground/55">{title}</p>
        <SheetTitle className="mt-1 pr-8 text-[14px] font-medium leading-snug">
          {sentence(signal.label)}{verdict && <><span className="px-1.5 text-muted-foreground/40">·</span><span className="font-normal text-foreground/80">{verdict}</span></>}
        </SheetTitle>
        <SheetDescription className={why ? "mt-1 text-[12.5px] leading-snug text-muted-foreground/70" : "sr-only"}>
          {why ?? `${sentence(signal.label)}: what it counted and what would improve it`}
        </SheetDescription>
      </div>
      <div className="space-y-5 px-3 pb-6">
        {signal.detail && <EngagementDetail detail={signal.detail} />}
        {hasList && (items.length === 0
          ? <p className="px-2 text-[12.5px] text-muted-foreground/55">Nothing on record</p>
          : isPeople
            ? <Group>{items.map(i => <PersonRow key={i.key ?? i.id ?? i.name ?? i.title} item={i} />)}</Group>
            : grouped
              ? <>
                  {open.length > 0 && <Group label="Open">{open.map(i => <ClaimRow key={i.id} item={i} />)}</Group>}
                  {resolved.length > 0 && <Group label="Resolved">{resolved.map(i => <ClaimRow key={i.id} item={i} />)}</Group>}
                </>
              : <Group>{items.map(i => <ClaimRow key={i.id} item={i} />)}</Group>)}
        {signal.improve && (
          <div className="px-2">
            <p className="text-[11px] text-muted-foreground/50">What would improve it</p>
            <p className="mt-1 text-[13px] leading-snug text-foreground">{signal.improve}</p>
          </div>
        )}
      </div>
    </div>
  );
}

export function DealHealthCard({ health, notes, voicedByName, updatedAt, picker, loading = false, title = "Deal health", pillTitle }: {
  health: DealHealth | null;
  /** "Deal health" on a deal; the account page draws its account health with the same card. */
  title?: string;
  pillTitle?: string;
  /** The claims the signals cite as evidence. */
  notes: Note[];
  voicedByName?: (id?: string | null) => string | null;
  updatedAt?: string | null;
  /** Which deal's health, when the account has several open. */
  picker?: ReactNode;
  loading?: boolean;
}) {
  // Which factor the panel shows, and whether it is open: kept apart so the panel keeps its content
  // while it slides out.
  const [picked, setPicked] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const byId = useMemo(() => new Map(notes.map(n => [n.id, n])), [notes]);
  const score = health?.score ?? null;
  const smart = health?.smart ?? [];
  const numeric = health?.numeric ?? [];
  const sel = smart.find(s => s.key === picked) ?? null;
  const evidence = sel ? (sel.evidence ?? []).map(id => byId.get(id)).filter((n): n is Note => !!n) : [];

  // The palette's card: a header row, the four signals as inset cells (hover band, no grid lines),
  // the numbers under them in the same cells, quieter. Colour stays on the meters and on a bad number.
  return (
    <ListCard className="min-w-0">
      <div className="flex min-h-8 min-w-0 flex-wrap items-center gap-2 px-2 pb-1 pt-0.5">
        <H3>{title}</H3>
        {picker}
        <span className="flex-1" />
        {updatedAt && <span className="text-[12px] text-muted-foreground/60">Updated {fmtWhen(updatedAt)}</span>}
        {loading ? <span className="text-[12px] text-muted-foreground/60">Loading…</span> : <HealthPill score={score} band={health?.band} title={pillTitle} />}
      </div>

      {score != null && !loading && (
        <div className="px-2 py-2"><HealthChart score={score} color={healthColor(score)} history={health?.history} /></div>
      )}

      {!loading && smart.length > 0 && (
        <div className={cn("grid grid-cols-2 gap-0.5", smart.length > 4 ? "md:grid-cols-3" : "md:grid-cols-4")}>
          {smart.map(s => {
            const canOpen = !!s.reason || !!s.summary || (s.evidence?.length ?? 0) > 0 || (s.items?.length ?? 0) > 0 || !!s.detail;
            const on = panelOpen && picked === s.key;
            return (
              // Selected is a light wash, never a ring (GET-807); keyboard focus shows the same wash.
              <button key={s.key} type="button" disabled={!canOpen} onClick={() => { setPicked(s.key); setPanelOpen(true); }} aria-haspopup={canOpen ? "dialog" : undefined}
                className={cn("flex min-w-0 flex-col gap-1 rounded-lg px-2 py-2 text-left transition-colors duration-fast focus-visible:bg-muted/60 focus-visible:outline-none",
                  canOpen ? "cursor-pointer hover:bg-muted/40" : "cursor-default", on && "bg-muted/60")}>
                <span className="truncate text-[11.5px] text-muted-foreground/70">{sentence(s.label)}</span>
                <span className="text-[13px] text-foreground">{s.level || "—"}</span>
                <Meter level={s.level} tone={s.tone} meter={s.meter} />
              </button>
            );
          })}
        </div>
      )}

      <Sheet open={panelOpen && !!sel} onOpenChange={setPanelOpen}>
        <SheetContent side="right" className="w-full gap-0 overflow-y-auto border-border/50 p-0 sm:max-w-[420px]">
          {sel && <FactorPanel signal={sel} title={title} evidence={evidence} voicedByName={voicedByName} />}
        </SheetContent>
      </Sheet>

      {!loading && numeric.length > 0 && (
        <div className="mt-0.5 grid grid-cols-2 gap-0.5 md:grid-cols-4">
          {numeric.map(s => (
            <div key={s.key} className="flex min-w-0 flex-col gap-0.5 px-2 py-2">
              <span className="truncate text-[11.5px] text-muted-foreground/70">{sentence(s.label)}</span>
              <span className={cn("truncate text-[13px] tabular-nums", s.tone === "bad" ? "text-risk" : "text-foreground/85")}>{s.value || "—"}</span>
            </div>
          ))}
        </div>
      )}

      {!loading && !smart.length && !numeric.length && (
        <ListEmpty>Not enough on this record yet to read its health.</ListEmpty>
      )}
    </ListCard>
  );
}

const Q_STATUS: Record<string, { level: string; tone: DealSignal["tone"]; bars: number }> = {
  confirmed: { level: "Confirmed", tone: "good", bars: 3 },
  partial: { level: "Partial", tone: "warn", bars: 2 },
  unknown: { level: "Unknown", tone: "unknown", bars: 0 },
};

/**
 * What we know about the deal, beside how it feels (GET-1004). Each MEDDICC letter as a tile, the
 * same tiles and panel as Deal health; a letter opens its claims, or the question that would answer
 * it. The unknowns are listed under the tiles as the next things to ask.
 */
export function QualificationCard({ qualification, notes, voicedByName }: {
  qualification: Qualification | null | undefined;
  notes: Note[];
  voicedByName?: (id?: string | null) => string | null;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const byId = useMemo(() => new Map(notes.map(n => [n.id, n])), [notes]);
  if (!qualification?.items?.length) return null;
  const items = qualification.items;
  // A letter as a factor, so the panel is the one Deal health opens.
  const asSignal = (i: (typeof items)[number]): DealSignal => {
    const st = Q_STATUS[i.status] ?? Q_STATUS.unknown;
    return { key: i.key, label: i.label, level: st.level, tone: st.tone, reason: i.reason, evidence: i.evidence, improve: i.ask,
      meter: { bars: st.bars, color: TONE_COLOR[st.tone] } };
  };
  const sel = items.find(i => i.key === picked) ?? null;
  const evidence = sel ? sel.evidence.map(id => byId.get(id)).filter((n): n is Note => !!n) : [];
  const asks = items.filter(i => i.status === "unknown" && i.ask).slice(0, 3);
  const summary = `${qualification.confirmed} of ${qualification.total} confirmed${qualification.partial ? `, ${qualification.partial} partial` : ""}`;
  return (
    <ListCard className="min-w-0">
      <div className="flex min-h-8 min-w-0 flex-wrap items-center gap-2 px-2 pb-1 pt-0.5">
        <H3>Qualification</H3>
        <span className="text-[12px] text-muted-foreground/60">{qualification.label}</span>
        <span className="flex-1" />
        <span className={cn("text-[12px] tabular-nums", qualification.confirmed >= 6 ? "text-positive" : qualification.confirmed >= 4 ? "text-foreground/80" : "text-warning")}
          title="Letters a fact on the record answers. Partial means something points at it but it is not settled.">{summary}</span>
      </div>
      <div className="grid grid-cols-2 gap-0.5 md:grid-cols-4">
        {items.map(i => {
          const s = asSignal(i);
          const on = panelOpen && picked === i.key;
          return (
            <button key={i.key} type="button" onClick={() => { setPicked(i.key); setPanelOpen(true); }} aria-haspopup="dialog"
              className={cn("flex min-w-0 cursor-pointer flex-col gap-1 rounded-lg px-2 py-2 text-left transition-colors duration-fast hover:bg-muted/40 focus-visible:bg-muted/60 focus-visible:outline-none", on && "bg-muted/60")}>
              <span className="truncate text-[11.5px] text-muted-foreground/70">{i.label}</span>
              <span className={cn("text-[13px]", i.status === "unknown" ? "text-muted-foreground/70" : "text-foreground")}>{s.level}</span>
              <Meter tone={s.tone} meter={s.meter} />
            </button>
          );
        })}
      </div>
      {asks.length > 0 && (
        <div className="mt-1 px-2 pb-1 pt-2">
          <p className="text-[11px] text-muted-foreground/50">Ask next</p>
          <ul className="mt-1 space-y-1">
            {asks.map(i => <li key={i.key} className="text-[13px] leading-snug text-foreground/85">{i.ask}</li>)}
          </ul>
        </div>
      )}
      <Sheet open={panelOpen && !!sel} onOpenChange={setPanelOpen}>
        <SheetContent side="right" className="w-full gap-0 overflow-y-auto border-border/50 p-0 sm:max-w-[420px]">
          {sel && <FactorPanel signal={asSignal(sel)} title="Qualification" evidence={evidence} voicedByName={voicedByName} />}
        </SheetContent>
      </Sheet>
    </ListCard>
  );
}

/** Whose health the card reads: the account's, or one of its open deals'. A quiet select. */
export function HealthPicker({ options, value, onChange }: { options: { id: string; name: string }[]; value: string; onChange: (id: string) => void }) {
  return (
    <span className="relative inline-flex min-w-0 max-w-[220px]">
      <select value={value} onChange={e => onChange(e.target.value)} aria-label="Whose health"
        className="h-6 min-w-0 cursor-pointer appearance-none truncate rounded-md bg-transparent pl-1.5 pr-5 text-[12px] text-muted-foreground/80 outline-none transition-colors duration-fast hover:bg-hover focus-visible:bg-hover">
        {options.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
      <svg aria-hidden viewBox="0 0 24 24" className="pointer-events-none absolute right-1 top-1/2 h-3 w-3 -translate-y-1/2 fill-none stroke-current stroke-2 text-muted-foreground"><path d="M6 9l6 6 6-6" /></svg>
    </span>
  );
}
