// The Get started stepper's steps (GET-622), from what is true of the workspace: the onboarding
// checklist (/api/onboarding/checklist) and the backfill preview (/api/backfill/preview). Pure, so
// tests/getStarted.test.ts pins the step set (founder vs invited member), what counts as done, and
// the one-line status under each step in the rail.

import type { OnboardingChecklist } from "@/hooks/useOnboardingChecklist";
import { num } from "./format.ts";

/** What the backfill step needs from /api/backfill/preview. */
export type BackfillPreview = {
  state: "none" | "awaiting_confirmation" | "over_allowance" | "needs_support" | "running" | "done" | "dismissed" | "paused_provider";
  /** A backfill already finished here: a new waiting one is for a tool connected since (GET-851). */
  ran_before?: boolean;
  /** Paused because the AI provider kept failing (GET-852): what it said. The worker asks again
   *  every few minutes and continues from where it stopped. */
  provider_error?: { reason: "credit" | "auth" | "rate_limit" | "outage"; message: string; provider?: string; phase?: string | null; at?: string } | null;
  last_probe_at?: string | null;
  resume_requested?: boolean;
  plan_live?: boolean;
  /** Credits a month the paid plan includes; null on Free, unpaid or unlimited (GET-682). */
  plan_credits?: number | null;
  /** On the Free plan: the step offers starting free beside paying now (GET-682). */
  on_free?: boolean;
  start_on_payment?: boolean;
  window_days?: number | null;
  finished_at?: string | null;
  estimate?: {
    credits: number; allowance: number | null; conversations: Record<string, number>;
    monthly?: { credits: number; counts: Record<string, number> } | null;
    /** Outside people (and their companies) the note-taker's meetings add that the graph does not
     *  hold yet: the backfill creates them, tagged Not in CRM (GET-788). */
    discovered?: { people: number; accounts: number } | null;
  } | null;
  accounts?: number;
  estimate_30?: { credits: number } | null;
  progress?: { pct: number; read: number | null; phase?: "filing" | "reading" | "done"; to_read?: number | null; reading_done?: number | null };
};

/** "12 people and 4 companies from your meeting notes aren't in your CRM…", or null when none (GET-788). */
export function notInCrmLine(d: { people: number; accounts: number } | null | undefined): string | null {
  if (!d?.people) return null;
  const people = `${num(d.people)} ${d.people === 1 ? "person" : "people"}`;
  const companies = d.accounts ? ` and ${num(d.accounts)} ${d.accounts === 1 ? "company" : "companies"}` : "";
  const one = d.people === 1 && !d.accounts;
  return `${people}${companies} from your meeting notes ${one ? "isn't" : "aren't"} in your CRM. They're added too, tagged Not in CRM.`;
}

export type StepKey = "crm" | "tools" | "backfill" | "agent";
export type SetupStep = { key: StepKey; title: string; done: boolean };

export const CRMS = [["hubspot", "HubSpot"], ["salesforce", "Salesforce"], ["attio", "Attio"]] as const;
export const MAIL = [["gmail_oauth", "Gmail"]] as const;
export const NOTES = [["fireflies", "Fireflies"], ["granola", "Granola"], ["fathom", "Fathom"]] as const;
export const TOOL_NAME: Record<string, string> = Object.fromEntries([
  ...CRMS, ...MAIL, ...NOTES, ["gmail", "Gmail"], ["otter", "Otter"], ["zoom", "Zoom"],
]);
export const toolName = (id: string) => TOOL_NAME[id] ?? id.charAt(0).toUpperCase() + id.slice(1);

/**
 * DOES THE PLAN FIT A MONTH LIKE THEIR LAST ONE? (GET-682) The backfill draws on its own pool, so
 * this is not about the backfill: it is about the months after it. Null when there is nothing to
 * compare or the plan covers it; otherwise what they'll use and the smallest bundle that covers it.
 */
export function planFit(
  monthly: number | null | undefined, planCredits: number | null | undefined,
  tiers: readonly { credits: number; priceUsd: number }[],
): { monthly: number; plan: number; rec: { credits: number; priceUsd: number } } | null {
  if (!monthly || !planCredits || monthly <= planCredits) return null;
  const rec = tiers.find((t) => t.credits >= monthly) ?? tiers[tiers.length - 1];
  return rec.credits > planCredits ? { monthly, plan: planCredits, rec } : null;
}

/** On Free and chose to start free: the backfill is parked until they upgrade (GET-682). */
export const backfillDeferred = (c: OnboardingChecklist) =>
  !!c.plan?.free && !!c.backfill.start_on_payment && c.backfill.state === "waiting";

/** The step is settled — running, done, or parked for the upgrade — so onboarding can move on. */
export const backfillStarted = (c: OnboardingChecklist) =>
  c.backfill.state === "running" || c.backfill.state === "done" || backfillDeferred(c);

/**
 * The dialog locks only when there is nothing behind it: a founder's workspace that has not paid
 * and not started reading. An invited member joins a workspace that already has records, and a
 * paid workspace has its plan, so neither is ever trapped on a step they may not be able to finish.
 */
export const setupLocked = (c: OnboardingChecklist) => !backfillStarted(c) && c.seat !== "member" && !c.plan?.live;

/**
 * The steps, in order. An invited member joins records the founder's CRM already made (GET-571),
 * so has no CRM step. The agent step is done when a key has made its first call — the same
 * condition checklistComplete() ends onboarding on.
 */
export function setupSteps(c: OnboardingChecklist): SetupStep[] {
  return [
    ...(c.seat === "member" ? [] : [{ key: "crm" as const, title: "Connect your CRM", done: c.crm.done }]),
    { key: "tools", title: "Email and meeting notes", done: c.mail.done && c.notes.done },
    { key: "backfill", title: "Revenue Backfill", done: backfillStarted(c) },
    { key: "agent", title: "Connect your agent", done: c.api_key.used },
  ];
}

/** The one grey line under a step's title in the rail. Only what the data says. */
export function stepStatus(key: StepKey, c: OnboardingChecklist, p: BackfillPreview | null): string {
  switch (key) {
    case "crm": {
      if (!c.crm.done) return "HubSpot, Salesforce or Attio";
      const name = c.crm.provider ? toolName(c.crm.provider) : "CRM";
      return c.crm.imported ? `${name} · ${num(c.crm.accounts)} accounts` : `${name} · importing`;
    }
    case "tools": {
      const ids = [...(c.mail.providers ?? []), ...(c.notes.providers ?? [])];
      const names = [...new Set(ids.map(toolName))];
      if (names.length) return names.join(", ");
      return "Gmail and your notetaker";
    }
    case "backfill": {
      if (c.backfill.state === "done" || p?.state === "done") return "Done";
      if (p?.state === "paused_provider") return "Paused: AI provider";
      if (c.backfill.state === "running" || p?.state === "running") {
        const pr = p?.progress;
        if (pr?.to_read) return `${num(pr.read ?? 0)} of ${num(pr.to_read)}`;
        return `${pr?.pct ?? 0}%`;
      }
      if (backfillDeferred(c)) return "Runs when you upgrade";
      return c.backfill.state === "waiting" ? "Waiting to start" : "Not started";
    }
    case "agent":
      return c.api_key.used ? "Connected" : "Claude Code, MCP or API";
  }
}

/** The big number on the running backfill: conversations read, of how many when we know (the
 *  same pair the backfill progress button shows). */
export function backfillCount(p: BackfillPreview | null): { read: number; of: number | null; pct: number } {
  const pr = p?.progress;
  const pct = p?.state === "done" ? 100 : Math.max(0, Math.min(100, pr?.pct ?? 0));
  return { read: pr?.read ?? 0, of: pr?.to_read || null, pct };
}

/** The Backfill card's sentence for a pause on the AI provider (GET-852): what it said, then what to do. */
export function providerPauseLine(e: BackfillPreview["provider_error"]): string {
  const named = e?.provider && e.provider !== "your AI provider" ? e.provider : null;
  const who = named ?? "Your AI provider";
  switch (e?.reason) {
    case "credit": return `${who} says your account is out of credit. Top it up and the backfill continues by itself within about 5 minutes, from where it stopped.`;
    case "auth": return `${who} rejected the API key. Fix the key in nous.env (OPENROUTER_API_KEY or LLM_API_KEY) and restart, and the backfill continues from where it stopped.`;
    case "rate_limit": return `${who} is rate-limiting this install. The backfill tries again every 5 minutes and continues from where it stopped.`;
    default: return `${who} is not answering. The backfill tries again every 5 minutes and continues from where it stopped.`;
  }
}
