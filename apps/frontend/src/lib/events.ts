// The Events page (GET-939): every event in the workspace, as GET /v2/events returns them. The
// bodies are exactly what a webhook receives (packages/core/src/services/events.mjs). Pure, so
// tests/events.test.ts pins it.

/** One event, as a webhook receives it. Only the fields the page reads are typed. */
export type NousEvent = {
  id: string;
  type: string;
  api_version?: string;
  occurred_at: string;
  account?: { entity_id: string; name?: string | null; domain?: string | null } | null;
  people?: { entity_id: string; name?: string | null; title?: string | null }[];
  deal?: { name?: string | null; stage?: string | null } | null;
  data?: Record<string, unknown>;
  [k: string]: unknown;
};

export type EventsPage = { data: NousEvent[]; has_more: boolean; next_starting_after: string | null };

/** The filter row: one family each, the way the event types are named. */
export const EVENT_FILTERS: { id: string; label: string; type: string | null }[] = [
  { id: "all", label: "All", type: null },
  { id: "signal", label: "Signals", type: "signal.*" },
  { id: "account", label: "Accounts", type: "account.*" },
  { id: "conversation", label: "Calls and replies", type: "conversation.*" },
  { id: "deal", label: "Deals", type: "deal.*" },
  { id: "icp", label: "ICP", type: "icp.*" },
  { id: "people", label: "People", type: "people.*" },
];

/** GET /v2/events with the page's filters. The signed-in page names its workspace. */
export function eventsUrl(apiUrl: string, workspaceId: string, opts: { type?: string | null; account?: string | null; after?: string | null; limit?: number } = {}): string {
  const q = new URLSearchParams({ workspaceId });
  if (opts.type) q.set("type", opts.type);
  if (opts.account) q.set("account", opts.account);
  if (opts.after) q.set("starting_after", opts.after);
  if (opts.limit) q.set("limit", String(opts.limit));
  return `${apiUrl}/v2/events?${q.toString()}`;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The one line a row says about what happened, from the event's own data. Empty when it has none. */
export function eventSummary(e: NousEvent): string {
  const d = e.data ?? {};
  const [family] = e.type.split(".");
  if (family === "signal") return str(d.title) ?? str(d.text) ?? "";
  if (e.type === "conversation.call_ended") return str(d.title) ?? "A call ended";
  if (e.type === "conversation.reply_received") return str(d.subject) ?? str(d.snippet) ?? "A reply came in";
  if (e.type === "deal.won" || e.type === "deal.lost") return str(e.deal?.name) ?? (e.type === "deal.won" ? "Deal won" : "Deal lost");
  if (e.type === "deal.stage_changed") return str(d.stage) ? `Stage is now ${str(d.stage)}` : "Stage changed";
  // The interpreted events (GET-950); packages/core/src/services/eventText.mjs says the same.
  if (e.type === "deal.stalled") return num(d.days_in_stage) != null && str(d.stage) ? `${d.days_in_stage} days in ${str(d.stage)}` : "Deal stalled";
  if (e.type === "account.champion_left") {
    const who = str((d.person as { name?: unknown } | null)?.name) ?? "Their champion";
    const next = str((d.replacement as { name?: unknown } | null)?.name);
    return next ? `${who} left; ${next} takes over` : `${who} left, no replacement named`;
  }
  if (e.type === "account.expansion_requested") return str(d.product) ? `Asked for more ${str(d.product)}` : "Asked for more";
  if (family === "icp") {
    const from = num((d.from as { score?: unknown } | null)?.score);
    const to = num((d.to as { score?: unknown } | null)?.score);
    return to == null ? "" : from == null ? `Scored ${to}` : `${from} → ${to}`;
  }
  if (e.type === "people.added") { const n = num(d.count); return n == null ? "" : `${n} ${n === 1 ? "person" : "people"} added`; }
  if (e.type === "automation.approval_requested") return str((d.automation as { name?: unknown } | null)?.name) ?? "An automation is waiting";
  return "";
}

/** "signal.stakeholder_left" → its family's label, for the row's quiet tag. */
export function eventFamilyLabel(type: string): string {
  const f = EVENT_FILTERS.find((x) => x.type === `${type.split(".")[0]}.*`);
  return f?.label ?? type.split(".")[0];
}

/** The plain name of each event type, as the feed's row title says it. */
export const EVENT_LABEL: Record<string, string> = {
  "signal.objection_raised": "Objection raised",
  "signal.objection_resolved": "Objection resolved",
  "signal.competitor_mentioned": "Competitor mentioned",
  "signal.competitor_evaluating": "Evaluating a competitor",
  "signal.stakeholder_identified": "Stakeholder identified",
  "signal.stakeholder_joined": "Stakeholder joined",
  "signal.stakeholder_left": "Stakeholder left",
  "signal.budget_discussed": "Budget discussed",
  "signal.buying_signal": "Buying signal",
  "signal.next_step": "Next step agreed",
  "signal.expansion_signal": "Expansion signal",
  "signal.expansion_declined": "Expansion declined",
  "signal.churn_risk": "Churn risk",
  "signal.next_step_missed": "Next step missed",
  "signal.next_step_slipped": "Next step slipped",
  "signal.usage_dropped": "Usage dropped",
  "signal.account_inactive": "Account inactive",
  "signal.feature_adopted": "Feature adopted",
  "signal.seat_dropped": "Seat dropped",
  "signal.product_qualified": "Product-qualified",
  "signal.seats_growing": "Seats growing",
  "signal.account_activated": "Account activated",
  "conversation.call_ended": "Call ended",
  "conversation.reply_received": "Reply received",
  "deal.won": "Deal won",
  "deal.lost": "Deal lost",
  "deal.stage_changed": "Stage changed",
  "deal.stalled": "Deal stalled",
  "account.champion_left": "Champion left",
  "account.expansion_requested": "Expansion requested",
  "icp.score_changed": "ICP score changed",
  "icp.tier_changed": "ICP tier changed",
  "people.added": "People added",
  "automation.approval_requested": "Approval requested",
  "insight.emerged": "New insight",
  "insight.rising": "Insight rising",
};

/** "signal.stakeholder_left" → "Stakeholder left"; an unknown type reads from its own name. */
export function eventLabel(type: string): string {
  if (EVENT_LABEL[type]) return EVENT_LABEL[type];
  const last = type.split(".").pop() ?? type;
  return last.charAt(0).toUpperCase() + last.slice(1).replace(/_/g, " ");
}

/** The Filter popover: each family, then the types in it. One choice at a time, as the API takes. */
export const EVENT_FILTER_GROUPS: { label: string; family: string; types: string[] }[] = [
  { label: "Signals", family: "signal.*", types: Object.keys(EVENT_LABEL).filter((t) => t.startsWith("signal.")) },
  { label: "Calls and replies", family: "conversation.*", types: ["conversation.call_ended", "conversation.reply_received"] },
  { label: "Accounts", family: "account.*", types: ["account.champion_left", "account.expansion_requested"] },
  { label: "Deals", family: "deal.*", types: ["deal.won", "deal.lost", "deal.stage_changed", "deal.stalled"] },
  { label: "ICP", family: "icp.*", types: ["icp.score_changed", "icp.tier_changed"] },
  { label: "People", family: "people.*", types: ["people.added"] },
  { label: "Insights", family: "insight.*", types: ["insight.emerged", "insight.rising"] },
];

/** What a chosen filter is called on the button and in the empty line. */
export function filterLabel(type: string | null): string {
  if (!type) return "All events";
  const group = EVENT_FILTER_GROUPS.find((g) => g.family === type);
  return group ? `All ${group.label.toLowerCase()}` : eventLabel(type);
}

/** A type (or family) whose events only exist once a webhook subscribes to its family. */
export function needsSubscription(type: string | null): boolean {
  if (type && ALWAYS_LOGGED.has(type)) return false;
  return !!type && SUBSCRIBED_ONLY_FAMILIES.has(type.endsWith(".*") ? type : `${type.split(".")[0]}.*`);
}

/** New events from a fresh first page, on top of what is loaded, without repeating any. Pure. */
export function mergeNewer(loaded: NousEvent[], fresh: NousEvent[]): NousEvent[] {
  const have = new Set(loaded.map((e) => e.id));
  const added = fresh.filter((e) => !have.has(e.id));
  return added.length ? [...added, ...loaded] : loaded;
}

/** Families only computed for a workspace once a webhook subscribes to them (their polls run per subscriber). */
export const SUBSCRIBED_ONLY_FAMILIES = new Set(["deal.*", "icp.*", "people.*"]);
/** Types in those families that are computed for every workspace anyway (deal.stalled, GET-950). */
export const ALWAYS_LOGGED = new Set(["deal.stalled"]);

export type EventTone = "positive" | "risk" | "warning" | "neutral";

// The dot a row leads with: good news green, bad news red, something to watch amber, the rest grey.
const TONE: Record<string, EventTone> = {
  "deal.won": "positive", "signal.buying_signal": "positive", "signal.expansion_signal": "positive",
  "signal.objection_resolved": "positive", "signal.next_step": "positive", "signal.stakeholder_joined": "positive",
  "deal.lost": "risk", "signal.churn_risk": "risk", "signal.stakeholder_left": "risk", "signal.expansion_declined": "risk",
  "signal.objection_raised": "warning", "signal.competitor_mentioned": "warning", "signal.competitor_evaluating": "warning",
  "signal.budget_discussed": "warning", "automation.approval_requested": "warning",
  "account.champion_left": "risk", "account.expansion_requested": "positive", "deal.stalled": "warning",
  "signal.next_step_missed": "risk", "signal.next_step_slipped": "warning",
  "signal.usage_dropped": "risk", "signal.account_inactive": "risk", "signal.seat_dropped": "warning", "signal.feature_adopted": "positive",
  "signal.product_qualified": "positive", "signal.seats_growing": "positive", "signal.account_activated": "positive",
};

/** An event type's tone; anything not listed is neutral. */
export function eventTone(type: string): EventTone {
  return TONE[type] ?? "neutral";
}

/** The dot's colour class for a tone. */
export const TONE_DOT: Record<EventTone, string> = {
  positive: "bg-positive", risk: "bg-risk", warning: "bg-warning-dot", neutral: "bg-muted-foreground/40",
};
