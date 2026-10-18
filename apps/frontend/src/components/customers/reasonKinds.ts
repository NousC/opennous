// Why a customer is on the list, in words a CS rep can say out loud.
//
// The reason engine lives on the server (apps/api/src/lib/csHealth.mjs: riskReasons /
// expansionReasons) and already ranks by how defensible a reason is, strongest first. This file
// does not re-rank. It only decides which coloured kind a reason wears and which line says where
// it came from, because a rep who cannot tell a HubSpot field from something the customer said
// cannot judge how hard to lean on it.
import { when as ago } from "@/lib/format";
import type { CsAccount, CsReason } from "./types";
import { crmName } from "@/lib/crm";

type ReasonKindDef = { label: string; chip: string };

// Adding a kind is one entry here plus, if the server names it, one line in KIND_BY_REASON.
export const REASON_KIND = {
// A word in its tone, no filled chip (GET-658); colour only where it means something (risk,
// opening, silence). What was said or promised is information, not an alarm, so it stays grey.
  promised:  { label: "We promised", chip: "text-muted-foreground/80" },
  said:      { label: "They said",   chip: "text-muted-foreground/80" },
  risk:      { label: "Risk",        chip: "text-risk" },
  expansion: { label: "Expansion",   chip: "text-positive" },
  gap:       { label: "Gone quiet",  chip: "text-warning" },
} satisfies Record<string, ReasonKindDef>;
export type ReasonKind = keyof typeof REASON_KIND;

// Server reason kinds that wear a fixed display kind whatever their evidence says. `owed` is a
// promise we made and still owe; the server files it as evidence "said" because it came off a
// call, but labelling our own promise "They said" would put words in the customer's mouth.
// `quiet` is evidence "said" for the same reason and is silence, not speech.
const KIND_BY_REASON: Record<string, ReasonKind> = {
  owed: "promised",
  promised: "promised",
  quiet: "gap",
  they_asked: "expansion",
  // A champion leaving was said on a call, but it is a risk, not their words (GET-692).
  champion_left: "risk",
};

export type Side = "risk" | "expansion";

export function kindOf(r: CsReason, side: Side): ReasonKind {
  const fixed = KIND_BY_REASON[r.kind];
  if (fixed) return fixed;
  // A CRM fact on the expansion side is an opening (a scoped upgrade, products available); on
  // the risk side it is a risk (cancellation date, churn model, nobody logging in).
  if (r.evidence === "crm") return side === "expansion" ? "expansion" : "risk";
  return "said";
}

/** Where it came from: HubSpot and the field's detail, or how and when the customer said it. */
export function sourceOf(r: CsReason, kind: ReasonKind): string {
  if (r.evidence === "crm") return [crmName(), r.detail].filter(Boolean).join(" · ");
  const when = r.at ? ago(r.at) : null;
  if (kind === "promised") return [r.detail ?? "we owe this", when].filter(Boolean).join(" · ");
  if (kind === "gap") return "Activity";
  return [r.via ?? "on a call", when].filter(Boolean).join(" · ");
}

export type ShownReason = { r: CsReason; side: Side };

/**
 * The reasons a row shows, at most two. Each tab shows the reasons that put the row on it; the
 * All tab shows whichever list the account is on, and for a steady account the tier 3 context
 * the server still carries (never enough to put it on a list, still worth reading).
 */
export function reasonsFor(
  a: CsAccount,
  view: string,
  sets: { atRisk: Set<string>; expansion: Set<string> },
): ShownReason[] {
  const risk = a.riskReasons.map((r) => ({ r, side: "risk" as const }));
  const exp = a.expansionReasons.map((r) => ({ r, side: "expansion" as const }));
  if (view === "attention") return risk.slice(0, 2);
  if (view === "expansion") return exp.slice(0, 2);
  if (sets.atRisk.has(a.companyId)) return risk.slice(0, 2);
  if (sets.expansion.has(a.companyId)) return exp.slice(0, 2);
  return [...risk, ...exp].sort((x, y) => x.r.tier - y.r.tier).slice(0, 2);
}
