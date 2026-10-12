// HubSpot fields as variables (GET-567). The portal's own deal and company properties, custom
// ones included, offered in the picker as {{hubspot.deal.<name>}} / {{hubspot.company.<name>}}.
// Their values are read live from HubSpot when the automation runs.
import { triggerDef } from "@/lib/flows";

export type HsField = { name: string; label: string; type: string | null; custom: boolean };

/** The HubSpot groups this trigger can fill: a deal's fields when it fires on a deal, the
 *  company's whenever it knows the account. */
export function hubspotVarGroups(kind: string, fields: { deal: HsField[]; company: HsField[] }) {
  const has = new Set(triggerDef(kind)?.vars ?? []);
  const row = (obj: "deal" | "company") => (f: HsField): [string, string] =>
    [`hubspot.${obj}.${f.name}`, f.custom ? `${f.label} (custom)` : f.label];
  const out: { group: string; vars: [string, string][] }[] = [];
  if (has.has("deal") && fields.deal.length) out.push({ group: "HubSpot deal", vars: fields.deal.map(row("deal")) });
  if (has.has("account") && fields.company.length) out.push({ group: "HubSpot company", vars: fields.company.map(row("company")) });
  return out;
}

const GMAIL_TRIGGERS = new Set(["email_received", "reply_owed", "thread_quiet"]);
const OPENNOUS_NOTE = "OpenNous record";

/**
 * Each variable group with where it comes from, so the picker can say it: the deal from your
 * CRM, the call from your notetaker, the thread from Gmail, the account and signals from the
 * OpenNous record, a step's output from AI.
 */
export function withSources(
  groups: { group: string; vars: [string, string][] }[],
  kind: string,
  triggerTools: { slug: string; label: string }[],
) {
  const toolOfTrigger = triggerTools[0];
  const hubspot = { slug: "hubspot", label: "HubSpot" };
  return groups.map(g => {
    const source = (() => {
      switch (g.group) {
        case "HubSpot deal": case "HubSpot company": return { tool: hubspot, note: "live from HubSpot" };
        case "Deal": return toolOfTrigger ? { tool: toolOfTrigger, note: toolOfTrigger.label } : { opennous: true, note: OPENNOUS_NOTE };
        case "Call": return toolOfTrigger ? { tool: toolOfTrigger, note: toolOfTrigger.label } : { opennous: true, note: "your notetaker" };
        case "Meeting": return { tool: { slug: "gcal", label: "Google Calendar" }, note: "Google Calendar" };
        case "Person": case "Thread":
          return GMAIL_TRIGGERS.has(kind) ? { tool: { slug: "gmail", label: "Gmail" }, note: "Gmail" } : { opennous: true, note: OPENNOUS_NOTE };
        case "Event": return { tool: { slug: "posthog", label: "PostHog" }, note: "PostHog" };
        case "Steps": return { ai: true, note: "AI steps above" };
        case "Webhook": return { note: "the request body" };
        default: return { opennous: true, note: OPENNOUS_NOTE };
      }
    })();
    return { ...g, source };
  });
}
