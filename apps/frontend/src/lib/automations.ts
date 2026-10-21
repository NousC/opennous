// Automations — the shape shared by the list and the flow editor (GET-523).
//
// An automation is still three choices and a switch: WHEN · AGENT · SEND. What changed is the
// middle. It used to be "pick an artifact"; now it is an agent step, and the agent either does
// a JOB we wrote the brief for, or does what you wrote. A job is one of two kinds underneath:
// an artifact the server knows how to make (account/call summary, call score), or a prompt we
// ship — which the server stores as an ordinary custom automation. The editor reads a saved
// prompt back into its job by its opening line, so a prompt-job reopens as the job, not as a
// wall of text you did not write.
import { freshAccessToken } from "@/lib/freshToken";

export const apiUrl = import.meta.env.VITE_API_URL ?? "";

export type Automation = {
  id: string; name: string; artifact: string | null; custom: boolean; prompt: string | null;
  when: string; destination: string; destination_target: string | null;
  enabled: boolean; last_run_at: string | null; tools: string[];
  offset_minutes?: number | null; frequency?: string | null; at_time?: string | null;
  /** Versions (GET-584): the live version's number, and the unpublished draft when there is one. */
  version?: number; draft?: DraftBody | null;
};
/** What the editor saves as a draft: the same body a save sends. */
export type DraftBody = {
  name?: string; when?: string; trigger_config?: Record<string, unknown>; steps?: unknown[];
  artifact?: string | null; prompt?: string | null; saved_at?: string;
};
/** A version's snapshot, in the table's own column names. */
export type Snapshot = {
  name?: string; trigger_kind?: string; trigger_config?: Record<string, unknown> | null; steps?: unknown[] | null;
  artifact?: string | null; prompt?: string | null; destination?: string | null; destination_target?: string | null;
  frequency?: string | null; at_time?: string | null; offset_minutes?: number | null; tools?: string[] | null;
};
/** The automation as its draft has it: the live row with the draft laid over it. */
export function withDraft(a: Automation): Automation {
  const d = a.draft;
  if (!d) return a;
  return {
    ...a, name: d.name ?? a.name, when: d.when ?? a.when,
    ...(d.trigger_config ? { trigger_config: d.trigger_config } : {}),
    ...(d.steps ? { steps: d.steps } : {}),
    artifact: "artifact" in d ? d.artifact ?? null : a.artifact, prompt: "prompt" in d ? d.prompt ?? null : a.prompt,
  } as Automation;
}
/** A version's snapshot as an automation row, for drawing it. */
export function fromSnapshot(s: Snapshot, a: Automation): Automation {
  return {
    ...a, name: s.name ?? a.name, when: s.trigger_kind ?? "", artifact: s.artifact ?? null, prompt: s.prompt ?? null,
    destination: s.destination ?? "none", destination_target: s.destination_target ?? null,
    frequency: s.frequency ?? null, at_time: s.at_time ?? null, offset_minutes: s.offset_minutes ?? null,
    tools: s.tools ?? [], steps: s.steps ?? null, trigger_config: s.trigger_config ?? {},
  } as Automation;
}
export type Recipe = {
  artifact: string; name: string; blurb: string; when: string; when_label: string;
  available: boolean; needs_plan: string | null;
};
export type Trigger = { key: string; label: string; live?: boolean };
export type Tool = { slug: string; label: string };
export type Run = {
  id: string; routine_id: string | null; when: string | null; automation: string; artifact: string | null;
  status: string; started_at: string; error: string | null;
  document_id: string | null; document_title: string | null;
  version?: number | null;
  /** What the run cost (GET-714), and each step's share. */
  credits?: number; credit_steps?: { step: number; credits: number }[];
};
export type Payload = {
  plan: string; limit: number | null; used: number;
  automations: Automation[]; catalogue: Recipe[];
  destinations: { key: string; label: string; needs_target?: boolean }[];
  triggers: Trigger[];
};

/** Fetch against the automations API with a fresh token. */
export async function automationsFetch(path: string, token: string, init: RequestInit = {}) {
  const headers: Record<string, string> = { Authorization: `Bearer ${await freshAccessToken() ?? token}` };
  if (init.body) headers["Content-Type"] = "application/json";
  return fetch(`${apiUrl}/api/automations${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> ?? {}) } });
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

export type Job = {
  id: string;
  name: string;
  sub: string;
  /** What the sentence says the agent does. */
  verb: string;
  /** The trigger a new automation starts on when you pick this job. */
  when: string;
  /** A server artifact, or null when the job is a prompt we ship. */
  artifact: string | null;
  /** The brief, for prompt-jobs. Its first line is how a saved row is recognised. */
  prompt?: string;
  /** What the job asks the model to do, for every job — what an AI step on your own key sends. */
  brief: string;
};

const JOB_LIST: (Omit<Job, "brief"> & { brief?: string })[] = [
  {
    id: "premeeting_brief", name: "Pre-meeting brief", sub: "Who is in the room, where it stands, what to ask",
    verb: "write a pre-meeting brief", when: "before_meeting", artifact: null,
    prompt: "Write a pre-meeting brief for this meeting.\nWho is attending and what each of them cares about, where the deal stands, what is still open from earlier conversations, and the two or three questions worth asking. Short, scannable, no preamble.",
  },
  {
    id: "call_summary", name: "Call summary", sub: "What was said, agreed, and who owes what",
    verb: "write a call summary", when: "call_ended", artifact: "call_summary",
    brief: "Summarise this call.\nWhat was said, what was agreed, and who owes what by when. Lead with the decision or next step. Short and scannable.",
  },
  {
    id: "follow_up", name: "Follow-up draft", sub: "An email in your voice, ready to review",
    verb: "draft a follow-up", when: "call_ended", artifact: null,
    prompt: "Draft the follow-up email for this call.\nIn my voice, short, with what we agreed, anything we promised to send, and one clear next step. Draft only; do not send.",
  },
  {
    id: "account_summary", name: "Account summary", sub: "Everything the graph knows, written up",
    verb: "write an account summary", when: "deal_closed_won", artifact: "account_summary",
    brief: "Write up this account from everything known about it.\nWho they are, who is involved and what each cares about, where the deal stands, open questions, and the next move.",
  },
  {
    id: "deal_handoff", name: "Deal handoff", sub: "For CS: context, promises, risks",
    verb: "write a CS handoff", when: "deal_closed_won", artifact: null,
    prompt: "Write the handoff from sales to customer success for this account.\nWhy they bought, who the people are and what each cares about, everything we promised, and the risks to watch in the first 90 days.",
  },
  {
    id: "call_score", name: "Call score", sub: "Against your bar, one thing to work on",
    verb: "score the call", when: "call_scored", artifact: "call_score",
    brief: "Score this call against a good sales call.\nDiscovery, next step, talk ratio and objection handling, each out of 5 with one line of evidence, then the one thing to work on.",
  },
];

/** Every job with its brief: a prompt-job's brief is its prompt. */
export const JOBS: Job[] = JOB_LIST.map(j => ({ ...j, brief: j.brief ?? j.prompt ?? "" }));

const firstLine = (s: string) => s.split("\n")[0].trim();

/**
 * Which job a saved automation is, and what was added to it. An artifact row is its artifact's
 * job with the prompt as the addition; a prompt row is a prompt-job when it opens with that
 * job's first line; anything else is your own instructions (job null).
 */
export function jobOf(a: Pick<Automation, "artifact" | "prompt">): { job: Job | null; extra: string } {
  if (a.artifact) return { job: JOBS.find(j => j.artifact === a.artifact) ?? null, extra: a.prompt ?? "" };
  const p = a.prompt ?? "";
  for (const j of JOBS) {
    if (!j.prompt || firstLine(p) !== firstLine(j.prompt)) continue;
    const rest = p.startsWith(j.prompt) ? p.slice(j.prompt.length) : "";
    return { job: j, extra: rest.replace(/^\s+/, "") };
  }
  return { job: null, extra: "" };
}

/** The artifact + prompt the API wants for a job (or your own words). */
export function payloadFor(job: Job | null, extra: string, own: string) {
  if (!job) return { artifact: null, prompt: own.trim() || null };
  if (job.artifact) return { artifact: job.artifact, prompt: extra.trim() || null };
  return { artifact: null, prompt: [job.prompt, extra.trim()].filter(Boolean).join("\n\n") };
}

// ── Triggers & destinations ──────────────────────────────────────────────────

export const TRIGGER_LABEL: Record<string, string> = {
  call_ended: "When a call ends",
  call_scored: "When a call is scored",
  deal_closed_won: "When a deal is won",
  deal_closed_lost: "When a deal is lost",
  deal_stage_changed: "When a deal changes stage",
  thread_quiet: "When a thread goes quiet",
  before_meeting: "Before a meeting",
  clock: "On a schedule",
};

/** The trigger's family decides which connected tool heads it. */
export function toolKindFor(when: string): "meeting" | "crm" | null {
  if (when.startsWith("deal_")) return "crm";
  if (when === "call_ended" || when === "call_scored") return "meeting";
  return null;
}

/**
 * The tools a trigger runs on: the ones picked, else every connected tool of the kind the
 * trigger implies. Granola alone is Granola's mark; Granola and Fellow both connected, with
 * neither picked, is both — "any recorder" means either of them fires it.
 */
export function toolsFor(when: string, picked: string[], tools: { meeting: Tool[]; crm: Tool[] }): Tool[] {
  const kind = toolKindFor(when);
  if (!kind) return [];
  const own = tools[kind];
  const chosen = (picked ?? []).map(slug => own.find(t => t.slug === slug)).filter(Boolean) as Tool[];
  return chosen.length ? chosen : own;
}

/**
 * The models an AI step runs on (GET-528). Your automations run on your own ChatGPT or Claude
 * key; `opennous` is ours and only the defaults use it — it is never offered in the editor.
 */
export const OWN_MODELS = ["openai", "anthropic"] as const;
export const MODEL_LABEL: Record<string, string> = { openai: "ChatGPT", anthropic: "Claude", opennous: "OpenNous" };
export const MODEL_LOGO: Record<string, string> = {
  openai: "/logos/chatgpt.svg", anthropic: "/provider-logos/claude.svg", opennous: "/nous-logo.svg",
};


/** The marks a trigger shows: its connected tools. A recorder trigger with none connected
 *  shows the usual pair; a CRM trigger shows the CRM you actually have, or nothing — HubSpot
 *  and Salesforce side by side claims two CRMs nobody has. */
export function marksFor(when: string, picked: string[], tools: { meeting: Tool[]; crm: Tool[] }): Tool[] {
  // ONE MARK, THE TOOL IT RUNS ON. Two logos side by side read as "both", which is never what
  // an automation is: it was picked for one tool, or it runs on the only one connected. A
  // workspace with two recorders gets a row per recorder, not one row wearing both logos.
  if (when === "before_meeting") return [{ slug: "gcal", label: "Google Calendar" }];
  const kind = toolKindFor(when);
  if (!kind) return [];
  const known = [...tools[kind], ...KIND_CATALOGUE[kind]];
  const chosen = (picked ?? []).map(slug => known.find(t => t.slug === slug) ?? { slug, label: slug }).slice(0, 1);
  if (chosen.length) return chosen;
  return tools[kind].length === 1 ? [tools[kind][0]] : [];
}

/** Every tool of a kind we can read, for naming a picked tool that is not connected. */
const KIND_CATALOGUE: Record<"meeting" | "crm", Tool[]> = {
  meeting: [
    { slug: "fathom", label: "Fathom" }, { slug: "granola", label: "Granola" }, { slug: "fireflies", label: "Fireflies" },
    { slug: "fellow", label: "Fellow" }, { slug: "ringcentral", label: "RingCentral" }, { slug: "otter", label: "Otter" },
    { slug: "zoom", label: "Zoom" },
  ],
  crm: [{ slug: "hubspot", label: "HubSpot" }, { slug: "attio", label: "Attio" }],
};

/** Logos we ship, drawn instead of a favicon: Google's favicon is the Google "G" for Gmail and
 *  Calendar alike, and those two need their own marks. */
export const LOCAL_LOGO: Record<string, string> = {
  gmail: "/provider-logos/gmail.svg", gcal: "/provider-logos/google-calendar.svg",
  google_calendar: "/provider-logos/google-calendar.svg",
  hubspot: "/provider-logos/hubspot.svg", salesforce: "/provider-logos/salesforce.svg",
};

/** A tool's own domain, so its own logo draws. */
export const TOOL_DOMAIN: Record<string, string> = {
  fireflies: "fireflies.ai", granola: "granola.ai", fathom: "fathom.video",
  fellow: "fellow.app", otter: "otter.ai", zoom: "zoom.us", ringcentral: "ringcentral.com",
  hubspot: "hubspot.com", salesforce: "salesforce.com", attio: "attio.com", pipedrive: "pipedrive.com",
  slack: "slack.com", gmail: "gmail.com", posthog: "posthog.com", gcal: "calendar.google.com",
};

/**
 * The account signals an automation can listen for (GET-686), in the words the product uses. A
 * next step agreed is a task, not a signal (GET-954), so it is not offered; a missed or slipped one is.
 */
export const SIGNAL_OPTIONS: [string, string][] = [
  ["objection_raised", "Objection raised"], ["objection_resolved", "Objection resolved"],
  ["competitor_mentioned", "Competitor mentioned"], ["competitor_evaluating", "Competitor evaluated"],
  ["stakeholder_identified", "Key stakeholder"], ["stakeholder_joined", "New stakeholder"], ["stakeholder_left", "Stakeholder left"],
  ["budget_discussed", "Budget discussed"], ["buying_signal", "Buying signal"],
  ["next_step_missed", "Next step missed"], ["next_step_slipped", "Next step slipped"],
  ["expansion_signal", "Expansion signal"], ["expansion_declined", "Expansion declined"], ["churn_risk", "Churn risk"],
  // Product usage from PostHog (GET-751).
  ["usage_dropped", "Usage dropped"], ["account_inactive", "Account inactive"], ["feature_adopted", "Feature adopted"], ["seat_dropped", "Seat dropped"],
  ["product_qualified", "Product-qualified"], ["seats_growing", "Seats growing"], ["account_activated", "Account activated"],
];
/** What a card calls a kind it may already hold: every option, plus a next step from before GET-954. */
export const SIGNAL_OPTION_LABELS: [string, string][] = [...SIGNAL_OPTIONS, ["next_step", "Next step agreed"]];

export const FREQUENCY_LABEL: Record<string, string> = {
  daily: "Every day", weekly: "Every Monday", monthly: "First of the month", quarterly: "Start of the quarter",
};

export const OFFSET_LABEL: Record<string, string> = {
  "15": "15 minutes before", "30": "30 minutes before", "60": "An hour before",
  "180": "Three hours before", "720": "The evening before", "1440": "A day before",
};

export const DEST_LABEL: Record<string, string> = {
  none: "Home only", email: "Email", slack: "Slack", webhook: "Webhook",
};

/** The one-line reading of a flow — the check that it says what you meant. */
export function sentenceFor(d: {
  when: string; toolLabel: string | null; offset: string; frequency: string; at: string;
  job: Job | null; destination: string; target: string;
}): string {
  const when =
    !d.when ? "When …"
    : d.when === "clock" ? `${FREQUENCY_LABEL[d.frequency] ?? "Every day"} at ${d.at}`
    : d.when === "before_meeting" ? `${(OFFSET_LABEL[d.offset] ?? "30 minutes before").replace(/ before$/, "")} before a meeting`
    : d.when === "call_ended" ? (d.toolLabel ? `When a ${d.toolLabel} call ends` : "After every call")
    : d.when.startsWith("deal_") && d.toolLabel ? TRIGGER_LABEL[d.when].replace("a deal", `a ${d.toolLabel} deal`)
    : TRIGGER_LABEL[d.when] ?? d.when;
  const what = d.job ? d.job.verb : "run your instructions";
  const first = d.target.split(",")[0]?.trim();
  const where =
    d.destination === "slack" ? `post it to ${first || "Slack"}`
    : d.destination === "email" ? `email it to ${first || "you"}`
    : d.destination === "webhook" ? "send it to your webhook"
    : "put it on Home";
  return `${when}, ${what} and ${where}.`;
}

/**
 * Why a run failed, in words. The runner stores the provider's raw reply — `400 {"type":"error",
 * "error":{"message":"Your credit balance is too low…"}}` — which is a log line, not a reason.
 * Known causes get a sentence; anything else shows the provider's own message without the JSON.
 */
export function runError(raw: string | null): string {
  const text = String(raw ?? "").trim();
  if (!text) return "Failed";
  let message = text;
  const json = text.indexOf("{");
  if (json >= 0) {
    try {
      const body = JSON.parse(text.slice(json));
      message = String(body?.error?.message ?? body?.message ?? body?.error ?? text);
    } catch { /* not JSON — keep the text */ }
  }
  if (/credit balance|insufficient_quota|exceeded your current quota|billing/i.test(message)) return "The model provider is out of credit";
  if (/^401\b|invalid x-api-key|invalid api key|incorrect api key|authentication/i.test(text)) return "The model key was rejected";
  if (/rate.?limit|^429\b/i.test(text)) return "The model provider was rate limited";
  if (/overloaded|^529\b|^5\d\d\b/i.test(text)) return "The model provider was unavailable";
  return message;
}
