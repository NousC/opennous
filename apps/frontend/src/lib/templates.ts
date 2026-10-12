// Automation templates (GET-528) — a name, one line on what it does, the tools it touches, and
// the flow it opens as. Pick one and the editor starts with the flow drawn; you fill the gaps.
//
// Some of these OpenNous already runs for every workspace. Those are `byDefault`: they show on
// the automations page as locked presets — you can see what they do, you cannot change them —
// and in the gallery they say so instead of offering a copy.
import { newId, type Flow, type Step } from "@/lib/flows";

export type TemplateGroup = "sales" | "cs" | "reporting" | "product";
export const GROUP_LABEL: Record<TemplateGroup, string> = {
  sales: "Sales", cs: "Customer success", reporting: "Reporting", product: "Product",
};

/** A mark in the template's tool row: a tool's logo by slug, or a glyph key. */
export type TemplateTool = { slug: string; label: string } | { glyph: "agent" | "clock" | "signals" | "email"; label: string };

export type Template = {
  id: string;
  name: string;
  does: string;
  group: TemplateGroup;
  tools: TemplateTool[];
  /** Run by OpenNous for every workspace: shown locked, never copied. */
  byDefault?: boolean;
  /** For a default, what actually runs today, said plainly. The flow is where it is going;
   *  this is where it is — a locked row must not claim a draft nobody wrote. Stale deal, Deal risk
   *  and Expansion signals do write theirs (GET-685, api lib/detectorDrafts.mjs): each night the
   *  approval → Gmail draft steps run as a pending draft in the approvals inbox, never a send. */
  today?: string;
  flow: () => Flow;
};

const agent = (prompt: string, job: string | null = null, model?: string): Step => ({
  id: newId(), type: "agent",
  config: { ...(job ? { mode: "pick", job, extra: "", prompt: "" } : { mode: "write", job: null, extra: "", prompt }), ...(model ? { model } : {}) },
});
const approval = (): Step => ({ id: newId(), type: "approval", config: {} });
const gmailDraft = (from: Step): Step => ({
  id: newId(), type: "gmail",
  config: { mode: "draft", to: "{{person.email}}", cc: "", subject: "", body: `{{steps.${from.id}.output}}` },
});

/** AI → approval → Gmail draft: the "drafted for you, just hit send" shape. The defaults run
 *  it on OpenNous's model; that is theirs alone. */
const drafted = (prompt: string, job: string | null = null) => () => {
  const a = agent(prompt, job, "opennous");
  return [a, approval(), gmailDraft(a)];
};

const RECORDER = { slug: "granola", label: "Granola" };
const HUBSPOT = { slug: "hubspot", label: "HubSpot" };
const GMAIL = { slug: "gmail", label: "Gmail" };
const POSTHOG = { slug: "posthog", label: "PostHog" };
const AGENT: TemplateTool = { glyph: "agent", label: "AI" };

export const TEMPLATES: Template[] = [
  {
    id: "sales_follow_up", group: "sales", byDefault: true, today: "drafts from Focus",
    name: "Sales follow-up",
    does: "After a meeting, the follow-up email is drafted and waiting to send.",
    tools: [RECORDER, AGENT, GMAIL],
    flow: () => ({ trigger: { kind: "call_ended", config: {} }, steps: drafted("", "follow_up")() }),
  },
  {
    id: "stale_deal", group: "sales", byDefault: true, today: "drafts nightly",
    name: "Stale deal detection",
    does: "A deal goes quiet, and a follow-up is drafted for you. Just hit send.",
    tools: [HUBSPOT, AGENT, GMAIL],
    flow: () => ({
      trigger: { kind: "deal_stalled", config: { days: 14 } },
      steps: drafted("This deal has had no activity for a while. Draft a short, specific follow-up to the main contact that picks up from the last real conversation and asks for one next step.")(),
    }),
  },
  {
    id: "deal_signals", group: "sales", byDefault: true, today: "drafts within the hour",
    name: "Deal signals",
    does: "A call raises an objection, a competitor, a buying signal or a departure, and the right follow-up is drafted for you.",
    tools: [{ glyph: "signals", label: "Account signals" }, AGENT, GMAIL],
    flow: () => ({
      trigger: { kind: "account_signal", config: { signals: ["objection_raised", "competitor_evaluating", "buying_signal", "stakeholder_left"] } },
      steps: drafted("Something just changed on this deal. Draft a short, specific follow-up to the main contact that responds to it and asks for one next step.")(),
    }),
  },
  {
    id: "crm_sync_back", group: "sales",
    name: "CRM sync back",
    does: "After a call, the next step lands on the HubSpot deal and a task is created.",
    tools: [RECORDER, AGENT, HUBSPOT],
    flow: () => {
      const a = agent("From this call, write the agreed next step in one sentence. Nothing else.");
      return {
        trigger: { kind: "call_ended", config: {} },
        steps: [
          a, approval(),
          { id: newId(), type: "hubspot", config: { action: "update_deal", properties: [{ name: "hs_next_step", value: `{{steps.${a.id}.output}}` }] } },
          { id: newId(), type: "hubspot", config: { action: "task", title: "Next step: {{account.name}}", body: `{{steps.${a.id}.output}}`, due_days: 2 } },
        ],
      };
    },
  },
  {
    id: "account_handoff", group: "cs",
    name: "Account handoff",
    does: "When a deal is won, CS gets the account summary by email.",
    tools: [HUBSPOT, AGENT, { glyph: "email", label: "Email" }],
    flow: () => {
      const a = agent("", "deal_handoff");
      return {
        trigger: { kind: "deal_closed_won", config: {} },
        steps: [a, { id: newId(), type: "email", config: { to: "", cc: "", subject: "Won: {{account.name}}", body: `{{steps.${a.id}.output}}` } }],
      };
    },
  },
  {
    id: "deal_risk", group: "cs", byDefault: true, today: "drafts nightly",
    name: "Deal risk detection",
    does: "An account turns at-risk, and a follow-up is drafted for you. Just hit send.",
    tools: [{ glyph: "signals", label: "Account signals" }, AGENT, GMAIL],
    flow: () => ({
      trigger: { kind: "health_changed", config: { to: "at_risk" } },
      steps: drafted("This account just turned at-risk. Say in one line why, then draft a short check-in to the main contact that addresses it directly.")(),
    }),
  },
  {
    id: "expansion", group: "cs", byDefault: true, today: "drafts nightly",
    name: "Expansion signals",
    does: "An expansion signal shows, and a follow-up is drafted for you. Just hit send.",
    tools: [{ glyph: "signals", label: "Account signals" }, AGENT, GMAIL],
    flow: () => ({
      trigger: { kind: "expansion_signal", config: {} },
      steps: drafted("An expansion signal just showed on this account. Draft a short note to the main contact that picks up on it and suggests a conversation.")(),
    }),
  },
  {
    id: "usage_drop", group: "product",
    name: "Product usage drop",
    does: "When PostHog sees a session quit, the account owner gets an email.",
    tools: [POSTHOG, AGENT, { glyph: "email", label: "Email" }],
    flow: () => {
      const a = agent("A user on this account just quit a session. Say who, what they were doing, and whether it looks like a pattern on this account.");
      return {
        trigger: { kind: "posthog_event", config: { event: "session_quit" } },
        steps: [a, { id: newId(), type: "email", config: { to: "", cc: "", subject: "{{account.name}}: usage dropped", body: `{{steps.${a.id}.output}}` } }],
      };
    },
  },
  {
    id: "weekly_insights", group: "reporting",
    name: "Weekly insights report",
    does: "Every Monday, what the week's calls said, in one email.",
    tools: [{ glyph: "clock", label: "Schedule" }, AGENT, { glyph: "email", label: "Email" }],
    flow: () => {
      const a = agent("Write this week's insights report from every conversation: what customers asked for, what they objected to, what moved deals, and what changed since last week. Lead with the three things that matter most.");
      return {
        trigger: { kind: "clock", config: { frequency: "weekly", at: "08:00" } },
        steps: [a, { id: newId(), type: "email", config: { to: "", cc: "", subject: "Weekly insights", body: `{{steps.${a.id}.output}}` } }],
      };
    },
  },
  {
    id: "weekly_feedback", group: "product",
    name: "Product feedback report",
    does: "Every week, the feature requests and product feedback from calls.",
    tools: [{ glyph: "clock", label: "Schedule" }, AGENT, { glyph: "email", label: "Email" }],
    flow: () => {
      const a = agent("Collect this week's feature requests and product feedback from every conversation. Group them by theme, count how often each came up, and name the accounts behind each.");
      return {
        trigger: { kind: "clock", config: { frequency: "weekly", at: "09:00" } },
        steps: [a, { id: newId(), type: "email", config: { to: "", cc: "", subject: "Product feedback this week", body: `{{steps.${a.id}.output}}` } }],
      };
    },
  },
];

export const templateById = (id: string | null) => TEMPLATES.find(t => t.id === id) ?? null;
