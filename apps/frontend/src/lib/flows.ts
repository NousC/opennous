// Automation flows (GET-523) — a trigger, then steps.
//
// The trigger says when; each step reads the variables the trigger and the steps above it
// produced. Four step groups and no more: the agent (think), HubSpot (write the CRM), four
// ways to send, and three controls. Anything that acts outside the app is added behind an
// Approval by default — you take the approval out, we never put the send in front of it.
//
// Mirrors apps/api/src/lib/flows.mjs, which validates what this builds. The two move together.
import { JOBS, MODEL_LABEL, type Automation, type Job, type Tool } from "@/lib/automations";

// ── Triggers ─────────────────────────────────────────────────────────────────

export type Family = "conversations" | "signals" | "deals" | "other";
export const FAMILY_LABEL: Record<Family, string> = {
  conversations: "Conversations", signals: "Account signals", deals: "Deals", other: "Other",
};

export type TriggerDef = {
  key: string; label: string; family: Family;
  /** The variable groups this trigger fills in. */
  vars: VarGroup[];
};

export const TRIGGERS: TriggerDef[] = [
  { key: "call_ended",       label: "When a call ends",               family: "conversations", vars: ["account", "call", "deal"] },
  { key: "before_meeting",   label: "Before a meeting",               family: "conversations", vars: ["account", "meeting", "deal"] },
  { key: "email_received",   label: "When a reply comes in",          family: "conversations", vars: ["account", "person", "thread"] },
  { key: "reply_owed",       label: "When a reply is owed",           family: "conversations", vars: ["account", "person", "thread"] },
  { key: "thread_quiet",     label: "When a thread goes quiet",       family: "conversations", vars: ["account", "person", "thread"] },

  { key: "account_signal",   label: "When an account signal lands",   family: "signals", vars: ["account", "person", "signal"] },
  { key: "health_changed",   label: "When account health changes",    family: "signals", vars: ["account", "deal", "signal"] },
  { key: "posthog_event",    label: "When a PostHog event fires",     family: "signals", vars: ["account", "person", "event"] },
  { key: "champion_quiet",   label: "When the champion goes quiet",   family: "signals", vars: ["account", "person", "deal"] },
  { key: "committee_joined", label: "When someone joins the committee", family: "signals", vars: ["account", "person", "deal"] },
  { key: "icp_tier_changed", label: "When the ICP tier changes",      family: "signals", vars: ["account", "signal"] },
  { key: "expansion_signal", label: "When an expansion signal shows", family: "signals", vars: ["account", "signal"] },
  { key: "promise_overdue",  label: "When a promise is overdue",      family: "signals", vars: ["account", "person", "promise"] },

  { key: "deal_stage_changed", label: "When a deal changes stage",    family: "deals", vars: ["account", "deal"] },
  { key: "deal_closed_won",  label: "When a deal is won",             family: "deals", vars: ["account", "deal"] },
  { key: "deal_closed_lost", label: "When a deal is lost",            family: "deals", vars: ["account", "deal"] },
  { key: "deal_stalled",     label: "When a deal stalls",             family: "deals", vars: ["account", "deal"] },
  { key: "deal_created",     label: "When a deal is created",         family: "deals", vars: ["account", "deal"] },
  { key: "hubspot_field_changed", label: "When a HubSpot field changes", family: "deals", vars: ["account", "signal"] },

  { key: "clock",            label: "On a schedule",                  family: "other", vars: [] },
  { key: "webhook_in",       label: "When a webhook arrives",         family: "other", vars: ["payload"] },
  { key: "manual",           label: "Run manually",                   family: "other", vars: ["account"] },
];

export const triggerDef = (key: string) => TRIGGERS.find(t => t.key === key) ?? null;

/** Health states a health trigger can watch for. */
export const HEALTH_STATES: [string, string][] = [
  ["at_risk", "At risk"], ["watch", "Needs attention"], ["healthy", "Healthy"], ["any", "Any change"],
];

// ── Variables ────────────────────────────────────────────────────────────────

export type VarGroup = "account" | "deal" | "call" | "meeting" | "person" | "thread" | "signal" | "event" | "promise" | "payload";

export const VARS: Record<VarGroup, [string, string][]> = {
  account: [["account.name", "Account"], ["account.domain", "Domain"], ["account.tier", "ICP tier"], ["account.health", "Health"], ["account.owner", "Owner"]],
  deal:    [["deal.name", "Deal"], ["deal.stage", "Stage"], ["deal.amount", "Amount"], ["deal.close_date", "Close date"], ["deal.owner", "Deal owner"]],
  call:    [["call.title", "Call"], ["call.date", "Call date"], ["call.attendees", "Attendees"], ["call.summary", "Call summary"], ["call.next_step", "Next step"], ["call.next_steps", "Next steps"], ["call.transcript", "Transcript"]],
  meeting: [["meeting.title", "Meeting"], ["meeting.start", "Starts"], ["meeting.attendees", "Attendees"]],
  person:  [["person.name", "Person"], ["person.email", "Email"], ["person.title", "Title"]],
  thread:  [["thread.subject", "Subject"], ["thread.last_message", "Last message"], ["thread.days_quiet", "Days quiet"]],
  // An account signal (GET-686): what kind, what was said, in whose words.
  signal:  [["signal.type", "Signal"], ["signal.text", "What was said"], ["signal.quote", "Quote"], ["signal.who", "Who said it"]],
  event:   [["event.name", "Event"], ["event.properties", "Properties"]],
  promise: [["promise.text", "Promise"], ["promise.due", "Due"]],
  payload: [["payload", "Payload"]],
};

export const VAR_GROUP_LABEL: Record<VarGroup, string> = {
  account: "Account", deal: "Deal", call: "Call", meeting: "Meeting", person: "Person",
  thread: "Thread", signal: "Signal", event: "Event", promise: "Promise", payload: "Webhook",
};

/** Every variable a step at `index` can read: the trigger's, then each agent step above it. */
export function varsAt(flow: Flow, index: number): { group: string; vars: [string, string][] }[] {
  const t = triggerDef(flow.trigger.kind);
  const out = (t?.vars ?? []).map(g => ({ group: VAR_GROUP_LABEL[g], vars: VARS[g] }));
  const agents = flow.steps.slice(0, index)
    .map((s, i) => ({ s, i }))
    // An AI step's words, and what a Read step read (GET-773).
    .filter(({ s }) => s.type === "agent" || (s.type === "hubspot" && s.config.action === "read"));
  if (agents.length) {
    out.push({
      group: "Steps",
      vars: agents.map(({ s, i }) => [`steps.${s.id}.output`, `${stepTitle(s)} (step ${i + 1})`] as [string, string]),
    });
  }
  return out;
}

/** What a {{token}} is called, for chips and the sentence. */
export function varLabel(token: string, flow: Flow): string {
  for (const g of Object.values(VARS)) for (const [k, l] of g) if (k === token) return l;
  const m = token.match(/^steps\.([^.]+)\.output$/);
  if (m) {
    const i = flow.steps.findIndex(s => s.id === m[1]);
    return i >= 0 ? `${stepTitle(flow.steps[i])} output` : "Step output";
  }
  return token;
}

// ── Steps ────────────────────────────────────────────────────────────────────

export type StepType = "agent" | "hubspot" | "gmail" | "slack" | "email" | "webhook" | "only_if" | "wait" | "approval";
export type Rule = { field: string; op: string; value: string };
/** Every setting any step type takes; each type reads its own. */
export type StepConfig = {
  mode?: string; job?: string | null; extra?: string; prompt?: string;
  /** Which model an agent step runs on: a connected provider slug, or unset for OpenNous. */
  model?: string | null;
  /** The provider's model id (claude-opus-5-5, gpt-…), from the key's own model list. */
  model_id?: string | null;
  /** Claude: how hard it thinks (low | medium | high). ChatGPT: temperature, 0–1. */
  effort?: string; temperature?: number;
  /** Upper bound on the answer, in tokens. */
  max_tokens?: number;
  /** What the AI reads (GET-568): each part on unless set false, and an account it always
   *  reads instead of the trigger's. */
  context?: Partial<Record<"deal" | "people" | "activity" | "intel" | "commitments" | "seller", boolean>>;
  account_id?: string | null; account_name?: string | null;
  action?: string; body?: string; title?: string; due_days?: number; properties?: { name: string; value: string }[];
  to?: string; cc?: string; subject?: string; channel?: string; text?: string; url?: string;
  /** Slack (GET-771): post in a channel (channel_id) or send a direct message (user_id). */
  channel_id?: string | null; user_id?: string | null; user_name?: string | null;
  /** HubSpot · Read records (GET-773): an object (custom ones too), its fields, a date window. */
  object?: string; object_label?: string; fields?: string[]; field_labels?: { name: string; label: string }[];
  group_by?: string; date_property?: string; window?: "yesterday" | "last_7_days" | "last_30_days";
  /** Compare with the period before (default on). */
  compare?: boolean;
  /** AI step: Read steps (by id) NOT passed in on their own; their table goes only where {{steps.<id>.output}} is placed. */
  inputs_off?: string[];
  /** AI step context (GET-791): the steps above whose output it reads. Unset: every Read step not in inputs_off. */
  inputs?: string[];
  /** Email: what rides with it — the AI output as a PDF (default) or nothing (GET-566). */
  attach?: "pdf" | "none";
  /** HubSpot update: fields from what was discussed ("ai", GET-715) or the ones you set ("fields"). */
  fill?: "ai" | "fields";
  /** "ai": the fields it may set; none = the defaults for the record. */
  ai_fields?: string[];
  /** The mailbox an email goes from (GET-716): a Gmail account (a draft) or SMTP (sent once approved). */
  send_from?: { id: string; kind: "gmail" | "smtp"; email: string | null } | null;
  /** Wait in Approvals before this step runs (GET-713). */
  approval?: boolean;
  /** HubSpot task: one per next step from the call ("call"), or the one you write ("one"). */
  task_from?: "call" | "one";
  /** OpenNous Draft follow-up: put the draft in the owner's Gmail ("gmail", the default) or not. */
  draft_in?: "gmail" | "none";
  match?: string; rules?: Rule[]; amount?: number; unit?: string;
};
/** Every setting any trigger takes; each trigger reads its own. */
export type TriggerConfig = {
  tools?: string[]; frequency?: string; at?: string; offset?: string | number; to?: string;
  event?: string; days?: number; hours?: number; stage?: string;
  /** Account signal (GET-686): the kinds that fire it; none means any. */
  signals?: string[];
  /** When a HubSpot field changes (GET-781): the object, the field, optionally the value it changes to or from. */
  object?: string; object_label?: string; property?: string; property_label?: string; from?: string; name_property?: string;
};
export type Step = { id: string; type: StepType; config: StepConfig };
export type Flow = { trigger: { kind: string; config: TriggerConfig }; steps: Step[] };

export const STEP_GROUPS: { label: string; types: StepType[] }[] = [
  { label: "Agent",   types: ["agent"] },
  { label: "CRM",     types: ["hubspot"] },
  { label: "Send",    types: ["gmail", "slack", "email", "webhook"] },
  { label: "Control", types: ["only_if", "wait", "approval"] },
];

export const STEP_LABEL: Record<StepType, string> = {
  agent: "AI", hubspot: "HubSpot", gmail: "Gmail", slack: "Slack", email: "Email",
  webhook: "Webhook", only_if: "Only if", wait: "Wait", approval: "Approval",
};
export const STEP_HINT: Record<StepType, string> = {
  agent: "ChatGPT or Claude",
  hubspot: "Note, task or property",
  gmail: "Draft or send from your inbox",
  slack: "Post to a channel or DM",
  email: "Send from OpenNous",
  webhook: "POST to your endpoint",
  only_if: "Stop unless a rule holds",
  wait: "Pause, then carry on",
  approval: "Hold until you approve",
};

/** Steps that act outside the app get an Approval in front of them when added. */
export const OUTWARD: StepType[] = ["hubspot", "gmail", "slack", "email", "webhook"];

/** OpenNous's actions by their menu names (GET-712), used on the card, the panel and the picker. */
export const JOB_LABEL: Record<string, string> = {
  follow_up: "Draft follow-up", call_summary: "Call summary", premeeting_brief: "Pre-meeting brief",
  account_summary: "Account summary", deal_handoff: "Deal handoff",
};

/**
 * What each OpenNous action covers, said plainly so nobody has to guess and nobody has to repeat it
 * in their own instructions (GET-712). A description of the result, never the prompt itself.
 */
export const JOB_INCLUDES: Record<string, string[]> = {
  follow_up: ["Short, in your voice", "What you agreed on the call", "Anything you promised to send", "One clear next step", "Waits for your approval before it's drafted"],
  call_summary: ["What was discussed and decided", "Next steps and who owes each", "Cited to the call and the account record"],
  premeeting_brief: ["Who is attending and what each cares about", "Where the deal stands", "What is still open from earlier conversations", "Two or three questions worth asking"],
  account_summary: ["Everything OpenNous knows about the account", "People, deals and recent activity", "Cited to the source"],
  deal_handoff: ["Why they bought", "Who the people are and what each cares about", "Everything we promised", "Risks to watch in the first 90 days"],
};

/** Does this step reach another person by itself? A draft or a CRM write does not. */
export function sendsToSomeone(s: Step): boolean {
  return s.type === "email" || s.type === "slack" || s.type === "webhook" || (s.type === "gmail" && s.config.mode === "send");
}

export const HUBSPOT_ACTIONS: [string, string][] = [
  ["read", "Read records"], ["note", "Add a note"], ["task", "Create a task"], ["update_deal", "Update the deal"], ["update_contact", "Update the contact"], ["update_company", "Update the company"],
];

export const OPS: [string, string][] = [
  ["is", "is"], ["is_not", "is not"], ["contains", "contains"], ["gt", "is more than"], ["lt", "is less than"],
  ["set", "is set"], ["not_set", "is not set"],
];

/**
 * The picker, tool first (GET-523): you think "HubSpot", then "create a task" — the way n8n
 * and every tool you already use is organised. A tool with one action adds it straight away.
 */
export type Action = { type: StepType; label: string; config?: StepConfig };
export type ToolEntry = { key: string; label: string; mark: StepType; model?: string; actions: Action[] };

export const TOOL_CATALOG: ToolEntry[] = [
  // OpenNous's own jobs (GET-706): our prompts on our model, billed to the workspace's credits.
  // Each opens with an "Additional instructions" box for your own touches.
  { key: "opennous", label: "OpenNous", mark: "agent", model: "opennous", actions: [
    { type: "agent", label: "Draft follow-up", config: { mode: "pick", job: "follow_up", model: "opennous", extra: "" } },
    { type: "agent", label: "Call summary", config: { mode: "pick", job: "call_summary", model: "opennous", extra: "" } },
    { type: "agent", label: "Pre-meeting brief", config: { mode: "pick", job: "premeeting_brief", model: "opennous", extra: "" } },
    { type: "agent", label: "Account summary", config: { mode: "pick", job: "account_summary", model: "opennous", extra: "" } },
    { type: "agent", label: "Deal handoff", config: { mode: "pick", job: "deal_handoff", model: "opennous", extra: "" } },
  ] },
  // AI with your own instructions (GET-710). OpenNous writes every run, so there is no model to pick.
  { key: "ai", label: "AI", mark: "agent", actions: [
    { type: "agent", label: "Write your own", config: { mode: "write", prompt: "" } },
  ] },
  { key: "hubspot", label: "HubSpot", mark: "hubspot", actions: [
    { type: "hubspot", label: "Read records", config: { action: "read", window: "yesterday", fields: [] } },
    { type: "hubspot", label: "Add a note", config: { action: "note" } },
    { type: "hubspot", label: "Create a task", config: { action: "task" } },
    { type: "hubspot", label: "Update the deal", config: { action: "update_deal", fill: "ai" } },
    { type: "hubspot", label: "Update the contact", config: { action: "update_contact", fill: "ai" } },
    { type: "hubspot", label: "Update the company", config: { action: "update_company", fill: "ai" } },
  ] },
  { key: "gmail", label: "Gmail", mark: "gmail", actions: [
    { type: "gmail", label: "Create a draft", config: { mode: "draft" } },
    { type: "gmail", label: "Send an email", config: { mode: "send" } },
  ] },
  { key: "slack", label: "Slack", mark: "slack", actions: [{ type: "slack", label: "Post to a channel" }] },
  { key: "email", label: "Email", mark: "email", actions: [{ type: "email", label: "Send an email" }] },
  { key: "webhook", label: "Webhook", mark: "webhook", actions: [{ type: "webhook", label: "Send a POST" }] },
  { key: "flow", label: "Flow", mark: "only_if", actions: [
    { type: "only_if", label: "Only if" },
    { type: "wait", label: "Wait", config: { mode: "duration" } },
    { type: "wait", label: "Wait for a reply", config: { mode: "until_reply", amount: 3, unit: "days" } },
    { type: "approval", label: "Approval" },
  ] },
];

/** The tool a step belongs to, as the node's second line. */
export function stepTool(s: Step): string {
  if (s.type === "only_if" || s.type === "wait" || s.type === "approval") return "Flow";
  if (s.type === "agent") return s.config.model && MODEL_LABEL[s.config.model] ? MODEL_LABEL[s.config.model] : "AI";
  return TOOL_CATALOG.find(t => t.key === s.type)?.label ?? STEP_LABEL[s.type];
}

let seq = 0;
export const newId = () => `s${Date.now().toString(36)}${(seq++).toString(36)}`;

export function newStep(type: StepType): Step {
  const config: StepConfig =
    type === "agent" ? { mode: "pick", job: null, extra: "", prompt: "" }
    : type === "hubspot" ? { action: "note", body: "", title: "", due_days: 1, properties: [] }
    : type === "gmail" ? { mode: "draft", to: "{{person.email}}", cc: "", subject: "", body: "" }
    : type === "slack" ? { channel: "", text: "" }
    : type === "email" ? { to: "", cc: "", subject: "", body: "" }
    : type === "webhook" ? { url: "" }
    : type === "only_if" ? { match: "all", rules: [{ field: "account.tier", op: "is", value: "A" }] }
    : type === "wait" ? { mode: "duration", amount: 1, unit: "days" }
    : {};
  return { id: newId(), type, config };
}

/** What an AI step sends: its own words, or the job's brief plus anything added. */
export function agentPrompt(c: StepConfig): string {
  if (c.mode === "write") return String(c.prompt ?? "").trim();
  const job = JOBS.find(j => j.id === c.job);
  return [job?.brief, String(c.extra ?? "").trim()].filter(Boolean).join("\n\n");
}

export function agentJob(s: Step): Job | null {
  return s.type === "agent" && s.config.mode === "pick" ? JOBS.find(j => j.id === s.config.job) ?? null : null;
}

/** The card's title — what this step is, in a few words. */
export function stepTitle(s: Step): string {
  const c = s.config;
  switch (s.type) {
    case "agent": { const j = agentJob(s); return j ? (JOB_LABEL[j.id] ?? j.name) : (c.mode === "write" ? "Your instructions" : "Pick an action"); }
    case "hubspot": return HUBSPOT_ACTIONS.find(([k]) => k === c.action)?.[1] ?? "HubSpot";
    case "gmail": return c.mode === "send" ? "Send an email" : "Draft an email";
    case "slack": return c.action === "dm" ? (c.user_name ? `Message ${c.user_name}` : "Send a Slack message") : c.channel ? `Post to #${String(c.channel).replace(/^#/, "")}` : "Post to Slack";
    case "email": return "Send an email";
    case "webhook": return "Send to a webhook";
    case "only_if": return "Only if";
    case "wait": return c.mode === "until_reply" ? "Wait for a reply" : `Wait ${c.amount} ${c.amount === 1 ? String(c.unit).replace(/s$/, "") : c.unit}`;
    case "approval": return "Your approval";
  }
}

/** The card's second line — the one detail that tells two of the same kind apart. */
export function stepSub(s: Step, flow: Flow): string {
  const c = s.config;
  const plain = (t: string) => String(t ?? "").replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, k) => varLabel(k, flow)).trim();
  switch (s.type) {
    case "agent": return agentJob(s)?.sub ?? (plain(c.prompt) || "Tell it what to do");
    case "hubspot": return plain(c.title || c.body) || "HubSpot";
    case "gmail": return c.to ? `To ${plain(c.to)}` : "Gmail";
    case "slack": return plain(c.text) || "Slack";
    case "email": return c.to ? `To ${plain(c.to)}` : "OpenNous email";
    case "webhook": return c.url || "POST to your endpoint";
    case "only_if": {
      const r: Rule[] = c.rules ?? [];
      if (!r.length) return "No rules yet";
      const one = (x: Rule) => `${varLabel(x.field, flow)} ${OPS.find(([k]) => k === x.op)?.[1] ?? x.op}${x.op === "set" || x.op === "not_set" ? "" : ` ${x.value}`}`;
      return r.map(one).join(c.match === "any" ? " or " : " and ");
    }
    case "wait": return c.mode === "until_reply" ? `Up to ${c.amount} ${c.unit}` : "Then carry on";
    case "approval": return "Lands on Home until you approve";
  }
}

/** Is this step filled in enough to save? */
export function stepReady(s: Step): boolean {
  const c = s.config;
  switch (s.type) {
    case "agent": return c.mode === "pick" ? !!c.job : !!String(c.prompt ?? "").trim();
    // A note with no body writes what the AI step wrote; a task needs its title; an update needs a field.
    case "hubspot": return c.action === "read" ? !!c.object && (c.fields ?? []).length > 0 : String(c.action ?? "note").startsWith("update_") ? (c.fill === "ai" || (c.properties ?? []).some(p => p.name))
      : c.action === "task" ? c.task_from === "call" || !!String(c.title ?? "").trim() : true;
    case "gmail": case "email": return !!String(c.to ?? "").trim() && !!String(c.body ?? "").trim();
    // The message may be left empty: it is what the AI step wrote (GET-771).
    case "slack": return c.action === "dm" ? !!c.user_id : !!(c.channel_id || String(c.channel ?? "").trim());
    case "webhook": return /^https?:\/\//.test(String(c.url ?? ""));
    case "only_if": return (c.rules ?? []).length > 0 && (c.rules as Rule[]).every(r => r.field);
    case "wait": return Number(c.amount) > 0;
    case "approval": return true;
  }
}

// ── The sentence ─────────────────────────────────────────────────────────────

const FREQ: Record<string, string> = { daily: "Every day", weekly: "Every Monday", monthly: "On the first of the month", quarterly: "At the start of each quarter" };
const OFFSET: Record<string, string> = { "15": "15 minutes", "30": "30 minutes", "60": "An hour", "180": "Three hours", "720": "The evening", "1440": "A day" };

export function triggerPhrase(flow: Flow, toolLabel: string | null): string {
  const { kind, config: c } = flow.trigger;
  if (!kind) return "When …";
  if (kind === "clock") return `${FREQ[c.frequency] ?? "Every day"} at ${c.at ?? "08:00"}`;
  if (kind === "before_meeting") return `${OFFSET[String(c.offset ?? 30)] ?? "30 minutes"} before a meeting`;
  if (kind === "call_ended") return toolLabel ? `When a ${toolLabel} call ends` : "After every call";
  if (kind === "health_changed") {
    const to = HEALTH_STATES.find(([k]) => k === c.to)?.[1];
    return c.to && c.to !== "any" ? `When an account turns ${to?.toLowerCase()}` : "When account health changes";
  }
  if (kind === "posthog_event") return c.event ? `When PostHog sees ${c.event}` : "When a PostHog event fires";
  if (kind === "deal_stalled") return `When a deal sits in one stage for ${c.days ?? 14} days`;
  if (kind === "thread_quiet") return `When a thread goes quiet for ${c.days ?? 7} days`;
  if (kind === "reply_owed") return `When a reply is owed for ${c.hours ?? 24} hours`;
  if (kind.startsWith("deal_") && toolLabel) return (triggerDef(kind)?.label ?? kind).replace("a deal", `a ${toolLabel} deal`);
  return triggerDef(kind)?.label ?? kind;
}

function stepPhrase(s: Step): string {
  const c = s.config;
  switch (s.type) {
    case "agent": return agentJob(s)?.verb ?? "run your instructions";
    case "hubspot": return c.action === "read" ? `read ${c.object_label ?? "HubSpot records"}` : c.action === "task" ? "create a HubSpot task" : c.action === "note" ? "add a HubSpot note" : c.action === "update_deal" ? "update the HubSpot deal" : "update the HubSpot contact";
    case "gmail": return c.mode === "send" ? "send it from Gmail" : "draft it in Gmail";
    case "slack": return c.action === "dm" ? `message ${c.user_name ?? "someone"} on Slack` : c.channel ? `post it to #${String(c.channel).replace(/^#/, "")}` : "post it to Slack";
    case "email": return "email it";
    case "webhook": return "send it to your webhook";
    case "only_if": return "check the rules";
    case "wait": return c.mode === "until_reply" ? "wait for a reply" : `wait ${c.amount} ${c.amount === 1 ? String(c.unit).replace(/s$/, "") : c.unit}`;
    case "approval": return "wait for my approval";
  }
}

export function sentence(flow: Flow, toolLabel: string | null): string {
  const head = triggerPhrase(flow, toolLabel);
  const onlyIf = flow.steps.find(s => s.type === "only_if");
  const rest = flow.steps.filter(s => s !== onlyIf).map(stepPhrase);
  const cond = onlyIf ? `, if ${stepSub(onlyIf, flow).toLowerCase()}` : "";
  if (!rest.length) return `${head}${cond}, …`;
  const list = rest.length === 1 ? rest[0] : `${rest.slice(0, -1).join(", ")} and ${rest[rest.length - 1]}`;
  return `${head}${cond}, ${list}.`;
}

// ── From the row the API sends ───────────────────────────────────────────────

type Row = Automation & { steps?: Step[] | null; trigger_config?: TriggerConfig | null };

/** A saved automation as a flow. Rows from before flows become [agent, send]. */
export function flowFromRow(a: Row): Flow {
  const config: TriggerConfig = { ...(a.trigger_config ?? {}) };
  if (a.when === "clock") { config.frequency ??= a.frequency ?? "daily"; config.at ??= (a.at_time ?? "08:00").slice(0, 5); }
  if (a.when === "before_meeting") config.offset ??= String(a.offset_minutes ?? 30);
  if (a.tools?.length) config.tools ??= a.tools;
  // An AI step saved before you could pick a model runs on OpenNous, as it always has. It says
  // so, and it saves: only a NEW step has to be on your own key.
  const onOpenNous = (s: Step): Step => (s.type === "agent" && !s.config.model ? { ...s, config: { ...s.config, model: "opennous" } } : s);
  if (Array.isArray(a.steps) && a.steps.length) return { trigger: { kind: a.when, config }, steps: a.steps.map(onOpenNous) };

  // A row from before flows: its steps are rebuilt from the old columns. THE IDS ARE FIXED, not
  // fresh: {{steps.<id>.output}} in a field names the step by id, and a new id on every load
  // broke that reference each time the page opened (and made a clean page read as unsaved).
  const steps: Step[] = [];
  if (a.artifact || a.prompt) {
    const job = a.artifact ? JOBS.find(j => j.artifact === a.artifact) : JOBS.find(j => j.prompt && (a.prompt ?? "").startsWith(j.prompt));
    steps.push({
      id: "agent", type: "agent",
      config: job
        ? { mode: "pick", job: job.id, extra: a.artifact ? (a.prompt ?? "") : (a.prompt ?? "").slice(job.prompt!.length).trim(), prompt: "", model: "opennous" }
        : { mode: "write", job: null, extra: "", prompt: a.prompt ?? "", model: "opennous" },
    });
  }
  const [to, ...cc] = String(a.destination_target ?? "").split(",").map(x => x.trim()).filter(Boolean);
  if (a.destination === "slack") steps.push({ id: "slack", type: "slack", config: { channel: to ?? "", text: "{{steps." + (steps[0]?.id ?? "") + ".output}}" } });
  if (a.destination === "email") steps.push({ id: "email", type: "email", config: { to: to ?? "", cc: cc.join(", "), subject: "", body: "{{steps." + (steps[0]?.id ?? "") + ".output}}" } });
  if (a.destination === "webhook") steps.push({ id: "webhook", type: "webhook", config: { url: to ?? "" } });
  return { trigger: { kind: a.when, config }, steps };
}

/** What the API is sent to save a flow. */
export function flowPayload(flow: Flow, name: string) {
  return { name, when: flow.trigger.kind, trigger_config: flow.trigger.config, steps: flow.steps };
}

// ── Before saving ────────────────────────────────────────────────────────────

/**
 * What would stop this flow working, said before it is saved (GET-528). `warn` is "this will
 * not do what you think" — a trigger with nothing connected to fire it, a step with no tool to
 * act on. `note` is worth knowing and fine to save through — nothing leaves the app, or a send
 * with no review in front of it. Never blocks: the person decides.
 */
export type Issue = { level: "warn" | "note"; text: string };

// What the runner executes today. Everything else saves and waits for the step runner.
const RUNS_TODAY = new Set(["agent", "email", "webhook", "gmail", "slack", "only_if", "approval", "hubspot"]);
const LABEL: Record<string, string> = {
  hubspot: "HubSpot", gmail: "Gmail", slack: "Slack", only_if: "Only if", wait: "Wait", approval: "Approval",
};

export function checkBeforeSave(flow: Flow, ctx: {
  meeting: Tool[]; crm: Tool[]; connected: string[]; live: Map<string, boolean>;
}): Issue[] {
  const out: Issue[] = [];
  const has = (slug: string) => ctx.connected.includes(slug);
  const kind = flow.trigger.kind;

  if (["call_ended", "call_scored"].includes(kind) && !ctx.meeting.length) out.push({ level: "warn", text: "No call recorder is connected, so this never fires." });
  if (kind.startsWith("deal_") && !ctx.crm.length) out.push({ level: "warn", text: "No CRM is connected, so this never fires." });
  if (["email_received", "reply_owed", "thread_quiet"].includes(kind) && !has("gmail")) out.push({ level: "warn", text: "Gmail isn't connected, so this never fires." });
  if (kind === "before_meeting" && !has("google_calendar")) out.push({ level: "warn", text: "Google Calendar isn't connected, so this never fires." });
  if (kind === "posthog_event") out.push({ level: "warn", text: "PostHog can't be connected yet, so this never fires." });
  else if (kind && ctx.live.get(kind) === false) out.push({ level: "warn", text: "This trigger doesn't fire yet. It saves and waits." });

  for (const [type, slug, name] of [["hubspot", "hubspot", "HubSpot"], ["gmail", "gmail", "Gmail"], ["slack", "slack", "Slack"]] as const) {
    if (flow.steps.some(s => s.type === type) && !has(slug)) out.push({ level: "warn", text: `${name} isn't connected, so its step has nothing to act on.` });
  }

  const waiting = [...new Set(flow.steps.filter(s => !RUNS_TODAY.has(s.type)).map(s => LABEL[s.type] ?? s.type))];
  const ownKey = (s: Step) => s.type === "agent" && !!s.config.model && s.config.model !== "opennous";
  const ownModel = flow.steps.find(ownKey)?.config.model;
  if (ownModel) waiting.push(`your ${MODEL_LABEL[ownModel] ?? ownModel} key`);
  for (const m of new Set(flow.steps.filter(ownKey).map(s => s.config.model as string))) {
    if (!has(m)) out.push({ level: "warn", text: `${MODEL_LABEL[m] ?? m} isn't connected. Add your key in Integrations.` });
  }
  if (waiting.length) out.push({ level: "warn", text: `Not running yet: ${waiting.join(", ")}. Saved now, runs once the step runner ships.` });

  // Only what reaches another person counts as sending (GET-712): an email, a Slack post, a
  // webhook, Gmail in send mode. A Gmail draft waits for you anyway, and a CRM write has its own
  // approval switch on the step.
  const sends = flow.steps.map((s, i) => ({ s, i })).filter(({ s }) => sendsToSomeone(s));
  if (sends.some(({ s, i }) => !s.config.approval && !flow.steps.slice(0, i).some(x => x.type === "approval"))) {
    out.push({ level: "note", text: "A message goes out without your review. Turn on Require approval on that step to check it first." });
  }
  return out;
}

