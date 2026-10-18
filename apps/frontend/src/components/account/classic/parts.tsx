// The small pieces the account page is built from: card and section chrome, the category tones
// the Intel tab and the Overview's Intel preview share, and the two health badges.
//
// Two health numbers live on a customer's page and they are not the same claim. Nous account
// health is ours (0-100, derived from the conversation). The CRM's customer health is the score the
// customer's own CS team maintains; Nous reads it and never computes it. Every place one is drawn
// says whose it is: the Nous badge carries the word, the CRM's carries HubSpot's orange dot.
import type { ReactNode } from "react";
import { Zap } from "lucide-react";
import { cn } from "@/lib/utils";

export const CARD = "rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]";

/** The CRM customer-health bag on /api/companies/:id/detail (`cs`). Every field may be missing. */
export type CsBag = {
  status?: string | null;
  owner_name?: string | null;
  owner_email?: string | null;
  mrr?: number | string | null;
  health_score?: number | string | null;
  active_users_30d?: number | string | null;
  total_users?: number | string | null;
  /** Phase 5. Null until the renewal date is read from the CRM. */
  renewal_date?: string | null;
  [k: string]: unknown;
};

/** A claim value can arrive as a string ("1250"); anything that is not a finite number is null. */
export const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") { const n = Number(v); return Number.isFinite(n) ? n : null; }
  return null;
};

export type CustomerKind = "customer" | "cancelled" | "prospect";
/** Whoever the CRM says is a customer (cs.status), never a guess from won deals. */
export const customerKind = (cs: CsBag | null | undefined): CustomerKind => {
  const s = String(cs?.status ?? "").toLowerCase();
  return s === "client" ? "customer" : s === "cancelled" ? "cancelled" : "prospect";
};

export function TypeChip({ kind }: { kind: CustomerKind }) {
  const ui = kind === "customer"
    ? { label: "Customer", cls: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300" }
    : kind === "cancelled"
      ? { label: "Cancelled", cls: "bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300" }
      : { label: "Prospect", cls: "bg-muted text-muted-foreground" };
  return <span className={cn("inline-flex flex-shrink-0 items-center rounded px-1.5 py-0.5 text-[11.5px] font-medium", ui.cls)}>{ui.label}</span>;
}

/**
 * Category → a LIGHT tone for the Intel cards' headers and the Overview's category tags. Same hue
 * per category as ClaimTag's chips (mind/ClaimTag.tsx), so a header and the chips under it never
 * disagree, and a category reads the same colour on the person page too. A category not listed
 * reads neutral rather than borrowing a hue that means something else.
 */
const CAT_TONE: Record<string, string> = {
  pain: "bg-orange-50 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300",
  goal: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  budget: "bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
  timeline: "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  objection: "bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300",
  competitor: "bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
  authority: "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300",
  buying_signal: "bg-green-50 text-green-700 dark:bg-green-500/15 dark:text-green-300",
  preference: "bg-teal-50 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300",
  relationship: "bg-pink-50 text-pink-700 dark:bg-pink-500/15 dark:text-pink-300",
  risk_signal: "bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300",
  expansion_signal: "bg-green-50 text-green-700 dark:bg-green-500/15 dark:text-green-300",
};
export const catTone = (c?: string | null) => CAT_TONE[(c || "").toLowerCase()] ?? "bg-muted text-muted-foreground";

const CAT_NAME: Record<string, string> = {
  objection: "Objection", competitor: "Competitor", pain: "Pain", goal: "Goal",
  budget: "Budget", timeline: "Timeline", buying_signal: "Buying signal",
  authority: "Authority", preference: "Preference", relationship: "Connection",
  status_quo: "Status quo", discovery: "Discovery", general: "Other",
  adoption: "Adoption", proficiency: "Proficiency", seasonality: "Seasonality",
  staff_change: "Staff change", firmographic: "Business profile", performance: "Performance",
  expansion_signal: "Expansion signal", risk_signal: "Risk signal", "declined expansion": "Declined expansion",
};
export const catName = (c?: string | null) => {
  const k = (c || "general").toLowerCase();
  return CAT_NAME[k] ?? (k.charAt(0).toUpperCase() + k.slice(1)).replace(/_/g, " ");
};

export function SectionHead({ title, meta, onAll, allLabel = "View all" }: { title: string; meta?: ReactNode; onAll?: () => void; allLabel?: string }) {
  return (
    <div className="mb-2 flex min-w-0 items-baseline justify-between gap-3">
      <div className="flex min-w-0 items-baseline gap-2">
        <h2 className="truncate text-[14px] font-semibold text-foreground">{title}</h2>
        {meta != null && <span className="truncate text-[12px] text-muted-foreground">{meta}</span>}
      </div>
      {onAll && <button onClick={onAll} className="flex-shrink-0 text-[12px] text-muted-foreground hover:text-foreground">{allLabel}</button>}
    </div>
  );
}

export const HUBSPOT_ORANGE = "#FF7A59";
export function HubSpotDot({ title = "From HubSpot" }: { title?: string }) {
  return <span title={title} className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ background: HUBSPOT_ORANGE }} />;
}

// Same cut-offs as RecordParts.bandOf, so the badge and the Deal Health read agree.
const nousTone = (s: number) => s >= 70
  ? "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/30"
  : s >= 40
    ? "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/30"
    : "bg-red-50 text-red-700 ring-red-200 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-500/30";

/** Nous health, ours. `label` names whose it is on the badge itself (the header); a row may omit it. */
export function NousHealthBadge({ score, title, label, big = false }: { score: number | null | undefined; title?: string; label?: string; big?: boolean }) {
  if (score == null) return null;
  return (
    <span title={title} className={cn("inline-flex flex-shrink-0 cursor-help items-center gap-1 rounded-md font-semibold tabular-nums ring-1 ring-inset",
      big ? "px-2 py-1 text-[12px]" : "px-1.5 py-0.5 text-[11px]", nousTone(score))}>
      <Zap className={big ? "h-3.5 w-3.5" : "h-3 w-3"} strokeWidth={2.2} />{Math.round(score)}
      {label && <span className="font-medium opacity-75">{label}</span>}
    </span>
  );
}

/** The CRM's customer-health word, on the CRM's own scale. */
export const crmHealthWord = (h: number) => (h >= 70 ? "Healthy" : h >= 50 ? "Watch" : "At risk");
const crmTone = (h: number) => h >= 70
  ? "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/30"
  : h >= 50
    ? "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/30"
    : "bg-red-50 text-red-700 ring-red-200 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-500/30";

export function CrmHealthBadge({ score }: { score: number | null }) {
  if (score == null) return null;
  return (
    <span title="HubSpot's own customer health score. Nous reads it, never computes it."
      className={cn("inline-flex flex-shrink-0 cursor-help items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium ring-1 ring-inset", crmTone(score))}>
      <HubSpotDot title="HubSpot's score" />{Math.round(score)} · {crmHealthWord(score)}
    </span>
  );
}

/** "updated 3h ago". relTime's "Today" reads oddly after "updated". */
export function updatedAgo(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const mins = Math.max(0, Math.round((Date.now() - t) / 60_000));
  if (mins < 2) return "updated just now";
  if (mins < 60) return `updated ${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `updated ${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `updated ${days}d ago`;
  return `updated ${new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

/** Tone text for a health signal: good / warn / bad / unknown. */
export const signalText = (tone?: string) =>
  tone === "good" ? "text-emerald-700 dark:text-emerald-400"
    : tone === "warn" ? "text-amber-700 dark:text-amber-400"
      : tone === "unknown" ? "text-muted-foreground"
        : "text-red-700 dark:text-red-400";
