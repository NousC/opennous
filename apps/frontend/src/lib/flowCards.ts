// What each card on the automation canvas says about itself (GET-705): a title, and up to three
// label/value rows that tell you what the step does without opening it — "Signals: Objection,
// Competitor", "To: the account owner". Pure: the canvas draws these, nothing else decides them.
import { FREQUENCY_LABEL, OFFSET_LABEL, SIGNAL_OPTION_LABELS } from "@/lib/automations";
import { HUBSPOT_ACTIONS, triggerDef, stepSub, stepTitle, stepTool, varLabel, type Flow, type Step } from "@/lib/flows";

export type CardRow = { label: string; value: string };

const SIGNAL = new Map(SIGNAL_OPTION_LABELS);
const plain = (t: string | undefined, flow: Flow) =>
  String(t ?? "").replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, k) => varLabel(k, flow)).replace(/\s+/g, " ").trim();

/** "When an account signal lands" — the trigger's own label, or the prompt to pick one. */
export function triggerCardTitle(flow: Flow): string {
  return triggerDef(flow.trigger.kind)?.label ?? "Pick a trigger";
}

export function triggerCardRows(flow: Flow, toolLabels: string[] = []): CardRow[] {
  const { kind, config: c } = flow.trigger;
  if (!kind) return [];
  const rows: CardRow[] = [];
  if (toolLabels.length) rows.push({ label: "Source", value: toolLabels.join(", ") });
  if (kind === "account_signal") {
    const picked = (c.signals ?? []).map(s => SIGNAL.get(s) ?? s);
    rows.push({ label: "Signals", value: picked.length ? picked.join(", ") : "Any signal" });
  }
  if (kind === "clock") rows.push({ label: "When", value: [FREQUENCY_LABEL[c.frequency ?? ""] ?? c.frequency, c.at].filter(Boolean).join(" at ") || "Set a schedule" });
  if (kind === "before_meeting") rows.push({ label: "When", value: OFFSET_LABEL[String(c.offset ?? "30")] ?? `${c.offset} minutes before` });
  if (kind === "deal_stage_changed") rows.push({ label: "Stage", value: c.stage || "Any stage" });
  if (kind === "deal_stalled" && c.days) rows.push({ label: "After", value: `${c.days} days in one stage` });
  if (kind === "icp_tier_changed" && c.to) rows.push({ label: "To", value: c.to });
  if (kind === "health_changed" && c.to) rows.push({ label: "To", value: c.to.replace(/_/g, " ") });
  if (kind === "posthog_event" && c.event) rows.push({ label: "Event", value: c.event });
  if (kind === "hubspot_field_changed") {
    rows.push({ label: "Field", value: c.property_label ? `${c.object_label ? `${c.object_label} · ` : ""}${c.property_label}` : "Pick the field" });
    if (c.to || c.from) rows.push({ label: "Change", value: [c.from ? `from ${c.from}` : null, c.to ? `to ${c.to}` : null].filter(Boolean).join(" ") });
  }
  return rows.slice(0, 3);
}

/**
 * OpenNous's Draft follow-up puts its own draft in Gmail (GET-708): one card instead of an AI step
 * and a Gmail step. It does unless switched off, or the flow already has its own email or Gmail step.
 * Mirrored by the runner (automationRun.mjs draftsItself).
 */
export function draftsItself(s: Step, flow: Flow): boolean {
  return s.type === "agent" && s.config.mode === "pick" && s.config.job === "follow_up" && s.config.model === "opennous"
    && s.config.draft_in !== "none" && !flow.steps.some(x => x.type === "gmail" || x.type === "email");
}

/** "Claude · Your instructions", "Gmail · Draft an email"; a control step is just its name. */
export function stepCardTitle(s: Step): string {
  if (s.type === "only_if" || s.type === "wait" || s.type === "approval") return stepTitle(s);
  return `${stepTool(s)} · ${stepTitle(s)}`;
}

export function stepCardRows(s: Step, flow: Flow): CardRow[] {
  const c = s.config;
  const v = (t?: string) => plain(t, flow);
  const rows: CardRow[] = [];
  switch (s.type) {
    case "agent":
      // The action is the card's title ("OpenNous · Call summary"). Additional instructions stay in
      // the panel, not on the card (GET-739).
      if (c.mode !== "pick") rows.push({ label: "Asks", value: stepSub(s, flow) });
      if (draftsItself(s, flow)) rows.push(c.send_from?.kind === "smtp"
        ? { label: "Sends from", value: `${c.send_from.email ?? "SMTP"}, once approved` }
        : { label: "Draft in", value: c.send_from?.email ? `Gmail · ${c.send_from.email}` : "Account owner's Gmail" });
      break;
    case "gmail":
    case "email":
      rows.push({ label: "To", value: v(c.to) || "—" });
      rows.push({ label: "Subject", value: v(c.subject) || "—" });
      break;
    case "slack":
      rows.push(c.action === "dm"
        ? { label: "To", value: c.user_name || "—" }
        : { label: "Channel", value: c.channel ? `#${String(c.channel).replace(/^#/, "")}` : "—" });
      rows.push({ label: "Message", value: c.text ? v(c.text) : "What the AI step wrote" });
      break;
    case "hubspot": {
      const action = HUBSPOT_ACTIONS.find(([k]) => k === c.action)?.[1];
      if (c.action === "read") {
        // Read records (GET-773): what, which fields, which days.
        rows.push({ label: "Reads", value: c.object_label || "—" });
        const n = (c.fields ?? []).length;
        if (n) rows.push({ label: "Fields", value: `${n} field${n === 1 ? "" : "s"}` });
        const span = c.window === "last_7_days" ? "7 days" : c.window === "last_30_days" ? "30 days" : "24 hours";
        rows.push({ label: "Window", value: `Last ${span}${c.compare === false ? "" : ", compared"}` });
      } else if (String(c.action ?? "").startsWith("update_") && c.fill === "ai") {
        rows.push({ label: "Fields", value: "From what was discussed" });
      } else if (String(c.action ?? "").startsWith("update_")) {
        const names = (c.properties ?? []).map(p => p.name).filter(Boolean);
        rows.push({ label: "Fields", value: names.length ? names.join(", ") : "—" });
      } else {
        if (c.action === "task" && c.task_from === "call") rows.push({ label: "Tasks", value: "One per next step from the call" });
        else rows.push({ label: action ?? "Note", value: v(c.title || c.body) || (c.action === "task" ? "—" : "What the AI step wrote") });
        if (c.action === "task" && c.due_days) rows.push({ label: "Due", value: `In ${c.due_days} day${c.due_days === 1 ? "" : "s"}` });
      }
      break;
    }
    case "webhook":
      rows.push({ label: "URL", value: c.url || "—" });
      break;
    case "only_if":
    case "wait":
    case "approval":
      rows.push({ label: s.type === "only_if" ? "Rule" : s.type === "wait" ? "Then" : "Holds", value: stepSub(s, flow) });
      break;
  }
  // Said on the card so the flow reads as it runs: this step waits for you (GET-713).
  if (c.approval) return [...rows.slice(0, 2), { label: "Approval", value: "You approve first" }];
  return rows.slice(0, 3);
}
