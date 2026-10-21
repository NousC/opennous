// The Intel tab (interface refresh, GET-610), for an account and for a deal.
//
// Main's intel model, read as topics: every fact on the record grouped into topics (one subject,
// "Security review timing", heard on several calls), each topic in its category, the categories
// folded into the five groups a rep reads by — Risks, Buying signals, Objections, Decision &
// budget, Competitors — and everything else under Other. A fact no topic covers yet is a topic of
// one.
//
// ONE INTEL FOR EVERY RECORD (GET-793): the account, the person and the deal all draw this, in
// the Deal health card's language — one card per group, a header row with its count, the topics
// as inset cells (a quiet label, the topic at 13px, a quiet line of who and when), full width.
// Picking a topic opens it inside its card, the way a health signal opens: its summary, then
// "What was said" —
// each fact with its quote, speaker, channel, date and confidence, linking to the call or email
// when the fact knows where it came from. The data carries no suggested next step, so the panel
// offers the two actions a rep takes instead: create a task, ask Nous about it.
import { SlackText } from "@/components/record/SlackText";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Quote } from "lucide-react";
import { fallbackLabel } from "@/components/mind/ClaimTag";
import { openAgent } from "@/lib/agentEvents";
import { NewTaskDialog } from "@/components/tasks/NewTaskDialog";
import { EmptyState } from "@/components/ui/empty-state";
import { GROUP_COLOR } from "./intelLook";
import { IntelStory, useIntelStory, type StoryFact, type TimelineGroup } from "./IntelStory";
import { PersonAvatar } from "@/components/ui/owner-filter";
import { useAuth } from "@/contexts/AuthContext";
import { day, when } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ListCard, ListGroup, ListMeta, ListText, ListTile, listRowClass } from "@/components/ui/list";
import { intelChips, type IntelTopic, type Note } from "./RecordParts";
import { FactSourceLink, SourceLine, factSource } from "./SourceLine";

export type IntelGroupKey = "blockers" | "risks" | "buying" | "objections" | "decision" | "stakeholders" | "stack" | "competitors" | "other";

export const INTEL_GROUPS: { key: IntelGroupKey; label: string; one: string; color: string }[] = [
  // GET-776: what stands between now and the deal reads first; the stack is its own group, one topic per tool.
  // GET-799: each group's colour is intelLook's, the same on the lenses, the tags and the Story.
  { key: "blockers", label: "Blockers", one: "Blocker", color: GROUP_COLOR.blockers },
  { key: "risks", label: "Risks", one: "Risk", color: GROUP_COLOR.risks },
  { key: "buying", label: "Buying signals", one: "Buying signal", color: GROUP_COLOR.buying },
  { key: "objections", label: "Objections", one: "Objection", color: GROUP_COLOR.objections },
  { key: "decision", label: "Decision & budget", one: "Decision & budget", color: GROUP_COLOR.decision },
  { key: "stakeholders", label: "Stakeholders", one: "Stakeholder", color: GROUP_COLOR.stakeholders },
  { key: "stack", label: "Tech stack", one: "Tech stack", color: GROUP_COLOR.stack },
  { key: "competitors", label: "Competitors", one: "Competitor", color: GROUP_COLOR.competitors },
  { key: "other", label: "Other", one: "Other", color: GROUP_COLOR.other },
];
const GROUP = Object.fromEntries(INTEL_GROUPS.map(g => [g.key, g])) as Record<IntelGroupKey, (typeof INTEL_GROUPS)[number]>;

/** main's INTEL_ORDER categories → the five groups. Anything not named reads as Other. */
const CAT_GROUP: Record<string, IntelGroupKey> = {
  risk_signal: "risks", "declined expansion": "risks", staff_change: "risks",
  buying_signal: "buying", expansion_signal: "buying",
  objection: "objections",
  authority: "stakeholders", relationship: "stakeholders", budget: "decision", timeline: "decision", requirement: "decision",
  blocker: "blockers", tech_stack: "stack",
  competitor: "competitors",
};
export const groupOf = (cat: string): IntelGroupKey => CAT_GROUP[(cat || "").toLowerCase()] ?? "other";

/** A category's own name, for "Other" rows and the detail header. */
const CAT_NAME: Record<string, string> = {
  pain: "Pain", goal: "Goal", performance: "Performance", status_quo: "Status quo", adoption: "Adoption",
  proficiency: "Proficiency", seasonality: "Seasonality", firmographic: "Business profile", preference: "Preference",
  relationship: "Connection", discovery: "Discovery", general: "Note", risk_signal: "Risk", "declined expansion": "Declined expansion",
  staff_change: "Staff change", buying_signal: "Buying signal", expansion_signal: "Expansion signal", objection: "Objection",
  authority: "Authority", budget: "Budget", timeline: "Timeline", competitor: "Competitor",
  blocker: "Blocker", requirement: "Requirement", tech_stack: "Tech stack",
};
const catName = (c: string) => CAT_NAME[c] ?? (c.charAt(0).toUpperCase() + c.slice(1)).replace(/_/g, " ");

const NEW_DAYS = 7;
const ts = (iso?: string | null) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : 0; };

export type IntelItem = {
  key: string;
  cat: string;
  group: IntelGroupKey;
  title: string;
  summary: string | null;
  /** Each distinct fact once; a fact heard on several calls is one group of several. */
  facts: Note[][];
  heard: number;
  /** Who raised it: contact ids where known, else the speaker's name as the source labels it. */
  voices: string[];
  lastAt: string | null;
  isNew: boolean;
};

const voiceOf = (n: Note): string | null =>
  (n.metadata?.voiced_by_contact_id as string | undefined) ?? ((n.metadata?.speaker as string | undefined)?.trim() || null);

export function buildIntelItems(facts: Note[], topics?: IntelTopic[] | null, now = Date.now()): IntelItem[] {
  return intelChips(facts, topics).map(c => {
    const groups: Note[][] = c.topic ? (c.topic.facts as Note[][]) : [[c.fact!]];
    const flat = groups.flat();
    const last = flat.map(n => n.created_at ?? null).filter(Boolean).sort().pop() ?? null;
    const first = c.fact ?? flat[0];
    return {
      key: c.key,
      cat: c.cat,
      group: groupOf(c.cat),
      title: c.topic?.label ?? (first.label?.trim()
        || (c.cat === "competitor" && typeof first.metadata?.entity === "string" ? first.metadata.entity : null)
        || fallbackLabel(first.content || "", first.category)),
      summary: c.topic?.summary ?? (c.topic ? groups[0]?.[0]?.content ?? null : first.content ?? null),
      facts: groups,
      heard: flat.length,
      voices: [...new Set(flat.map(voiceOf).filter((v): v is string => !!v))],
      lastAt: last,
      isNew: !!last && now - ts(last) < NEW_DAYS * 86_400_000,
    };
  });
}

const CHANNEL: Record<string, "call" | "email" | "message"> = {
  meeting_held: "call", meeting: "call", call: "call",
  email_received: "email", email_sent: "email", email: "email",
  linkedin_message: "message", linkedin: "message",
};
export const channelOf = (n: Note): "call" | "email" | "message" | null => {
  const t = String(n.metadata?.signal_type ?? "").toLowerCase();
  if (CHANNEL[t]) return CHANNEL[t];
  const ref = String(n.metadata?.source_ref ?? "");
  if (/^source:\/\/(fireflies|fellow|fathom|granola|gong|zoom|meet)/.test(ref)) return "call";
  if (/^source:\/\/gmail|^source:\/\/outlook/.test(ref)) return "email";
  return null;
};
const CHANNEL_WORD = { call: "On a call", email: "Email", message: "LinkedIn" } as const;

/** "From 3 calls and 5 emails": distinct sources behind the facts, when they say which. */
export function sourceLine(facts: Note[]): string | null {
  const calls = new Set<string>(), emails = new Set<string>();
  for (const n of facts) {
    const ch = channelOf(n);
    const ref = String(n.metadata?.source_ref ?? n.metadata?.source_activity_id ?? "");
    if (!ch || !ref) continue;
    (ch === "call" ? calls : ch === "email" ? emails : null)?.add(ref);
  }
  const part = (k: number, w: string) => `${k} ${w}${k === 1 ? "" : "s"}`;
  const bits = [calls.size ? part(calls.size, "call") : null, emails.size ? part(emails.size, "email") : null].filter(Boolean);
  return bits.length ? `From ${bits.join(" and ")}` : null;
}

export type IntelFilter = "all" | IntelGroupKey;
type Filter = IntelFilter;

/** What the view hands the timeline above it: its groups and where each fact files (GET-801). */
export type TimelineCtx = { groups: TimelineGroup[]; laneOf: (f: StoryFact) => string | null };

/** The timeline above an Intel view, on the view's own groups, narrowed to the picked lens. */
export function storyAbove(companyId: string | null | undefined, nameOf?: (id: string) => string | null) {
  return (f: IntelFilter, ctx: TimelineCtx) => {
    if (!companyId) return null;
    return <div className="mb-4"><IntelStory companyId={companyId} nameOf={nameOf} groups={ctx.groups} laneOf={ctx.laneOf} only={f === "all" ? null : f} /></div>;
  };
}

type IntelStatus = "New" | "Changed" | "Resolved" | "Open";
// Status as coloured words, the way Deal health says "Healthy 79" (GET-801): no filled pills.
const STATUS_TONE: Record<IntelStatus, string> = {
  New: "text-[#2F55B0] dark:text-[#9DB6F0]",
  Changed: "text-warning",
  Resolved: "text-muted-foreground/50",
  Open: "text-muted-foreground/80",
};
/** The topic's newest fact. */
const newestOf = (i: IntelItem): Note => [...i.facts.flat()].sort((a, b) => ts(b.created_at) - ts(a.created_at))[0];
/** Where a topic stands (GET-799): a resolved blocker or objection, a fact that replaced an older one, new this week, or open. */
function statusOf(i: IntelItem): IntelStatus {
  const n = newestOf(i);
  const st = String(n?.metadata?.status ?? "").toLowerCase();
  if (st === "resolved" || st === "addressed") return "Resolved";
  if (n?.metadata?.supersedes) return "Changed";
  return i.isNew ? "New" : "Open";
}

export function IntelBoard({ facts, topics, nameOf, scope, companyId, companyName, empty, renderSource, renderSummary, above }: {
  facts: Note[];
  topics?: IntelTopic[] | null;
  /** A contact id → their name, for "who raised it". */
  nameOf: (id: string) => string | null;
  /** This deal / Whole account, on a deal. */
  scope?: ReactNode;
  companyId?: string | null;
  companyName?: string | null;
  empty?: string;
  /** Where a fact came from, drawn by the page (GET-612 adds the source dock). */
  renderSource?: (n: Note) => ReactNode;
  /** A topic's summary, drawn by the page (GET-612 adds its sources). */
  renderSummary?: (item: IntelItem) => ReactNode;
  /** Drawn between the group chips and the list, told which group is picked: the account's
   *  timeline (GET-797), so one click narrows the chart and the list together. */
  above?: (filter: IntelFilter, ctx: TimelineCtx) => ReactNode;
}) {
  const items = useMemo(() => buildIntelItems(facts, topics), [facts, topics]);
  const [filter, setFilter] = useState<Filter>("all");
  const [sel, setSel] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [allSaid, setAllSaid] = useState<string | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  // A topic opens in place, under its row, and only when picked.
  const pick = (key: string | null) => {
    setSel(key);
    if (key) requestAnimationFrame(() => detailRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  };
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const wsId = (userData as { workspace?: { id?: string } } | null)?.workspace?.id ?? "";
  const meId = (userData as { user?: { id?: string } } | null)?.user?.id ?? null;

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: items.length };
    for (const i of items) c[i.group] = (c[i.group] ?? 0) + 1;
    return c;
  }, [items]);
  const shown = useMemo(() => {
    const rows = filter === "all" ? items : items.filter(i => i.group === filter);
    return INTEL_GROUPS.map(g => ({ g, rows: rows.filter(i => i.group === g.key).sort((a, b) => ts(b.lastAt) - ts(a.lastAt)) })).filter(x => x.rows.length);
  }, [items, filter]);
  const flatShown = shown.flatMap(x => x.rows);
  const pickedItem = flatShown.find(i => i.key === sel) ?? null;
  useEffect(() => { if (sel && !flatShown.some(i => i.key === sel)) setSel(null); }, [flatShown, sel]);

  const voiceName = (v: string) => nameOf(v) ?? v;
  // The timeline's lanes are this view's lenses (GET-801): the same groups in the same order, and a
  // fact files where its topic does. A retired fact follows what replaced it; anything else falls
  // back to its category's group, and a group with no lens is left off.
  const timeline = useMemo<TimelineCtx>(() => {
    const groupOfFact = new Map<string, string>();
    for (const it of items) for (const n of it.facts.flat()) groupOfFact.set(n.id, it.group);
    const live = new Set(INTEL_GROUPS.filter(g => counts[g.key]).map(g => g.key as string));
    return {
      groups: INTEL_GROUPS.filter(g => counts[g.key]).map(g => ({ key: g.key, label: g.label, color: g.color })),
      laneOf: (f: StoryFact) => {
        const g = groupOfFact.get(f.id) ?? (f.superseded_by ? groupOfFact.get(f.superseded_by) : undefined) ?? groupOf(f.category);
        return live.has(g) ? g : null;
      },
    };
  }, [items, counts]);
  // What a changed topic used to say: the replaced fact, read off the account's Story (it keeps
  // retired facts; the record's own intel holds only live ones).
  const story = useIntelStory(companyId, "all");
  const storyById = useMemo(() => new Map((story.data?.facts ?? []).map(f => [f.id, f])), [story.data]);
  const wasOf = (i: IntelItem) => {
    const prev = newestOf(i)?.metadata?.supersedes;
    const f = typeof prev === "string" ? storyById.get(prev) : undefined;
    return f ? { content: f.content, at: f.said_at } : null;
  };

  const options = [
    { value: "all" as Filter, label: "All", count: items.length },
    ...INTEL_GROUPS.filter(g => counts[g.key]).map(g => ({ value: g.key as Filter, label: g.label, count: counts[g.key] ?? 0 })),
  ];

  // A topic opened (GET-801): what it says now (and what it used to say), then the two newest
  // things said with who and where, the rest one click away, then the two actions. No repeated
  // header, no source chips: the row above already says what it is.
  const detail = (item: IntelItem, was: { content: string; at: string } | null) => {
    const said = [...item.facts].sort((a, b) => ts(b[0].created_at) - ts(a[0].created_at));
    const shownSaid = allSaid === item.key ? said : said.slice(0, 2);
    const now = newestOf(item)?.content ?? item.summary ?? "";
    return (
      <div ref={detailRef} className="mx-2 mb-2 mt-0.5 space-y-2.5 rounded-lg bg-hover px-3 py-2.5 md:ml-[162px]">
        {was ? (
          <p className="text-[13px] leading-[1.5] [overflow-wrap:anywhere]">
            <span className="text-muted-foreground/55 line-through">{was.content}</span>
            <span className="px-1.5 text-muted-foreground/45">→</span>
            <span className="text-foreground">{now}</span>
            <span className="pl-2 text-[11.5px] text-muted-foreground/50">since {day(was.at)}</span>
          </p>
        ) : (renderSummary ? renderSummary(item) : <p className="text-[13px] leading-[1.5] text-foreground [overflow-wrap:anywhere]">{now}</p>)}
        <div className="space-y-1.5">
          {shownSaid.map(group => {
            const n = group[0];
            const v = voiceOf(n);
            const ch = channelOf(n);
            const quote = typeof n.metadata?.quote === "string" && n.metadata.quote.trim() ? n.metadata.quote.trim() : null;
            const text = quote ? `“${quote}”` : n.content;
            if (!text || text === now) return null;
            return (
              <div key={n.id} className="min-w-0">
                <p className="text-[12.5px] leading-snug text-foreground/80 line-clamp-2 [overflow-wrap:anywhere]"><SlackText text={String(text)} /></p>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted-foreground/60">
                  {[v ? voiceName(v) : null, ch ? CHANNEL_WORD[ch] : null, n.created_at ? day(n.created_at) : null].filter(Boolean).join(" · ")}
                  {renderSource ? renderSource(n) : factSource(n) ? <><span aria-hidden className="text-border">·</span><FactSourceLink note={n} /></> : null}
                </div>
              </div>
            );
          })}
          {said.length > 2 && (
            <button type="button" onClick={() => setAllSaid(allSaid === item.key ? null : item.key)}
              className="text-[12px] text-muted-foreground/70 transition-colors duration-fast hover:text-foreground">
              {allSaid === item.key ? "Show less" : `Show all ${said.length}`}
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button"
            onClick={() => openAgent({ prompt: `What should I do about "${item.title}" at ${companyName ?? "this account"}?`, mentions: companyId ? [{ id: companyId, kind: "company", label: companyName ?? "Account" }] : [] })}
            className="inline-flex h-7 items-center text-[12.5px] text-muted-foreground/80 transition-colors duration-fast hover:text-foreground">
            Ask Nous about this →
          </button>
          <span className="flex-1" />
          {token && wsId && companyId && (
            <button type="button" onClick={() => setCreating(true)}
              className="inline-flex h-7 items-center rounded-lg border border-border/70 bg-card px-2.5 text-[12.5px] transition-colors duration-fast hover:bg-background">
              Create task
            </button>
          )}
        </div>
      </div>
    );
  };

  const COLS = "md:grid-cols-[150px_minmax(0,1.1fr)_minmax(0,2fr)_80px_130px_76px]";
  return (
    <div className="min-w-0">
      {/* Lenses (GET-799): each group in its colour with its count. One click narrows the Story
          and the view together. */}
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 pb-3.5" role="radiogroup" aria-label="Intel lens">
        {options.map(o => {
          const on = filter === o.value;
          const col = o.value === "all" ? null : GROUP[o.value as IntelGroupKey].color;
          // Quiet, like Deal health's labels: the words, a small dot in the group's colour, the count;
          // the picked one sits on the hover band (GET-801).
          return (
            <button key={o.value} type="button" role="radio" aria-checked={on} onClick={() => setFilter(o.value)}
              className={cn("inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] transition-colors duration-fast",
                on ? "bg-hover text-foreground" : "text-muted-foreground/75 hover:bg-hover hover:text-foreground")}>
              {col && <span aria-hidden className="h-[6px] w-[6px] flex-shrink-0 rounded-full" style={{ background: col }} />}
              {o.label}
              <span className="tabular-nums text-muted-foreground/50">{o.count}</span>
            </button>
          );
        })}
        <span className="flex-1" />
        {scope}
      </div>

      {above?.(filter, timeline)}

      {items.length === 0 ? (
        <EmptyState title={empty ?? "No intel yet"} />
      ) : flatShown.length === 0 ? (
        <EmptyState title="Nothing in this group" />
      ) : (
        // The view (GET-799): one row per topic, newest first within each group's order.
        <ListCard role="listbox" aria-label="Topics" className="min-w-0">
          <div className={cn("hidden gap-3 px-2 pb-1 pt-0.5 text-[11.5px] text-muted-foreground/55 md:grid", COLS)}>
            <span>Type</span><span>Topic</span><span>Latest</span><span>Status</span><span>Who</span><span className="text-right">Last said</span>
          </div>
          {flatShown.map(i => {
            const on = sel === i.key;
            const g = GROUP[i.group];
            const status = statusOf(i);
            const who = i.voices.length ? (i.voices.length === 1 ? voiceName(i.voices[0]) : `${voiceName(i.voices[0])} +${i.voices.length - 1}`) : "—";
            const latest = newestOf(i)?.content ?? i.summary ?? "";
            return (
              <div key={i.key}>
                <div role="option" aria-selected={on} tabIndex={0}
                  onClick={() => pick(on ? null : i.key)}
                  onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(on ? null : i.key); } }}
                  className={cn("grid min-h-10 w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors duration-fast hover:bg-hover focus-visible:bg-hover focus-visible:outline-none",
                    COLS, on && "bg-hover")}>
                  <span className="min-w-0">
                    <span className="inline-flex max-w-full items-center gap-1.5 text-[12px] text-muted-foreground">
                      <span aria-hidden className="h-[6px] w-[6px] flex-shrink-0 rounded-full" style={{ background: g.color }} />
                      <span className="truncate">{i.group === "other" ? catName(i.cat) : g.one}</span>
                    </span>
                  </span>
                  <span className="min-w-0 truncate font-medium text-foreground">{i.title}</span>
                  <span className="hidden min-w-0 truncate text-muted-foreground/80 md:block">{latest}</span>
                  <span className="hidden md:block">
                    <span className={cn("text-[12px]", STATUS_TONE[status])}>{status}</span>
                  </span>
                  <span className="hidden min-w-0 truncate text-muted-foreground md:block">{who}{i.heard > 1 ? ` · ${i.heard}×` : ""}</span>
                  <span className="hidden truncate text-right tabular-nums text-muted-foreground/70 md:block">{when(i.lastAt)}</span>
                </div>
                {on && detail(i, status === "Changed" ? wasOf(i) : null)}
              </div>
            );
          })}
        </ListCard>
      )}

      {pickedItem && token && wsId && companyId && (
        <NewTaskDialog open={creating} onOpenChange={setCreating} token={token} workspaceId={wsId}
          heading="Create a task" description={`From "${pickedItem.title}".`}
          initialTitle={`Follow up on ${pickedItem.title.charAt(0).toLowerCase()}${pickedItem.title.slice(1)}`}
          accounts={[{ id: companyId, name: companyName ?? "Account" }]} meId={meId}
          onCreated={() => setCreating(false)} />
      )}
    </div>
  );
}

/** Who raised it, as the row's 24px lead: their face, a second one tucked behind; a quiet tile when no one is known. */
function Voices({ voices, nameOf }: { voices: string[]; nameOf: (v: string) => string }) {
  if (!voices.length) return <ListTile><Quote className="h-3 w-3" strokeWidth={1.75} /></ListTile>;
  return (
    <span className="relative flex h-6 w-6 flex-shrink-0" title={voices.map(nameOf).join(", ")}>
      <PersonAvatar person={{ id: voices[0], name: nameOf(voices[0]) }} size={24} />
      {voices.length > 1 && (
        <span className="absolute -bottom-0.5 -right-1"><PersonAvatar person={{ id: voices[1], name: nameOf(voices[1]) }} size={13} ring /></span>
      )}
    </span>
  );
}
