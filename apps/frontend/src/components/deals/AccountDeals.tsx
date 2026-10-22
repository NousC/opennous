// The deals on an account (GET-262, GET-267): the data hooks, the Deals section in the account's
// left rail, and the deal switch the
// account's Deal Health card uses when there is more than one open deal.
//
// Not a CRM list. A deal card says where the deal stands, who is on it and how healthy it is;
// editing a deal stays in the CRM. An account with no CRM deal shows its own implied deal, so
// every account has exactly one thing to open even before a CRM is connected.
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";
import { stageLabel } from "@/config/pipeline";
import { type DealHealth, type Note, type IntelTopic } from "@/components/record/RecordParts";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

export type DealPerson = { id: string; name: string; title: string | null; photo_url: string | null; last_activity_at?: string | null; conversations?: number };
export type DealSummary = {
  id: string; implied: boolean; name: string; stage: string | null; status: "open" | "won" | "lost";
  value: number | null; currency?: string | null; close_date: string | null; opened_date?: string | null;
  pipeline?: string | null; pipeline_id?: string | null; owner_name?: string | null; owner_email?: string | null;
  /** "Open in HubSpot" — null until the sync has learned the portal, or for an implied deal. */
  hubspot_url?: string | null;
  owners?: { user_id: string | null; name: string | null; avatar: string | null }[];
  roster: DealPerson[]; roster_count?: number; roster_known: boolean;
  last_stage_change_at: string | null; days_in_stage: number | null; products?: string[];
  health: { score: number | null; band: string | null };
};
export type DealStage = { label: string; status: "open" | "won" | "lost"; entered_at: string; days: number; current: boolean };
export type DealDetail = {
  deal: DealSummary; account: { id: string; name: string | null; domain: string | null };
  people: DealPerson[]; stages: DealStage[]; line_items: any[]; activity: any[]; notes: Note[]; intel_topics?: IntelTopic[] | null;
  health: DealHealth; attributed_count: number;
  // The CRM's id for the workspace's primary pipeline; null when unknown.
  primary_pipeline_ref?: string | null;
  // Why it closed: the dated path of evidence, frozen at close (GET-405). Null while open.
  close_record?: CloseRecord | null;
  /** "How to win this deal" as last written (GET-793); null until the page asks for one. */
  overview?: { text: string; at: string | null } | null;
};
export type CloseEvent = {
  kind: string; at: string; text: string; claim_id?: string; quote?: string | null;
  attribution: "deal" | "roster" | "crm" | "derived"; detail?: Record<string, unknown>;
};
export type CloseRecord = {
  outcome: "won" | "lost" | "no_decision"; opened_at: string | null; closed_at: string;
  events: CloseEvent[]; path: string[]; rep_reason: string | null; explained: boolean; built_at: string;
};

function useApi() {
  const { session, userData } = useAuth();
  return { token: session?.access_token ?? "", wsId: (userData as any)?.workspace?.id ?? "" };
}

/** The account's deals. Keyed without the token: it rotates every minute and must not refetch. */
// The stages from which an account with no CRM deal is a real opportunity (GET-792).
const WORKING_STAGES = new Set(["meeting_booked", "discovery", "demo", "negotiation"]);

/**
 * Does this deal count in the account's open pipeline? A CRM deal always does. The implied deal
 * (the account's own, when the CRM has none) counts once someone gave it an amount or it reached a
 * meeting; an untouched prospect still reads zero. One rule for the account's left pane, the
 * accounts list and the hover preview (GET-816: the preview kept the old rule and said $0).
 */
export function countsAsDeal(d: DealSummary): boolean {
  if (!d.implied) return true;
  return (d.value ?? 0) > 0 || WORKING_STAGES.has(String(d.stage ?? "").toLowerCase());
}

export function useAccountDeals(companyId: string | null | undefined) {
  const { token, wsId } = useApi();
  return useQuery<{ deals: DealSummary[]; implied: boolean; primary_pipeline_ref?: string | null }>({
    queryKey: ["account-deals", wsId, companyId],
    enabled: !!token && !!wsId && !!companyId,
    staleTime: 60_000,
    queryFn: async () => {
      const r = await fetch(`${apiUrl}/api/companies/${companyId}/deals?workspaceId=${wsId}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(`deals ${r.status}`);
      return r.json();
    },
  });
}

/** One deal in full. */
export function useAccountDeal(companyId: string | null | undefined, dealId: string | null | undefined) {
  const { token, wsId } = useApi();
  return useQuery<DealDetail>({
    queryKey: ["account-deal", wsId, companyId, dealId],
    enabled: !!token && !!wsId && !!companyId && !!dealId,
    staleTime: 60_000,
    queryFn: async () => {
      const r = await fetch(`${apiUrl}/api/companies/${companyId}/deals/${dealId}?workspaceId=${wsId}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(`deal ${r.status}`);
      return r.json();
    },
  });
}

export const money = (n: number | null | undefined, currency?: string | null) => {
  if (n == null) return null;
  const sym = !currency || currency === "USD" ? "$" : `${currency} `;
  return n >= 1000 ? `${sym}${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k` : `${sym}${n.toLocaleString()}`;
};
export const shortDate = (iso: string | null | undefined) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
};
export const STATUS_UI: Record<string, { label: string; color: string }> = {
  open: { label: "Open", color: "#0ea5e9" },
  won: { label: "Won", color: "#059669" },
  lost: { label: "Lost", color: "#dc2626" },
};
/** A CRM deal carries its pipeline's own label; the implied deal carries our stage key. */
export const dealStageText = (d: { implied: boolean; stage: string | null }) => (d.stage ? (d.implied ? stageLabel(d.stage) : d.stage) : null);
/**
 * Whether a deal sits in the workspace's primary pipeline, compared by the CRM's own ids (never
 * the display name, which reps rename). Either side unknown reads as primary: the default stays
 * quiet, and only a deal we KNOW is in another pipeline gets marked.
 */
export const inPrimaryPipeline = (pipelineId: string | null | undefined, primaryRef: string | null | undefined) =>
  !primaryRef || !pipelineId || pipelineId === primaryRef;
/**
 * The pipeline as a person reads it: the trimmed name, with "(default)" only when we know it is
 * the primary one. Null when the deal has none (the account's own deal), so nothing is rendered.
 */
export const pipelineText = (d: { pipeline?: string | null; pipeline_id?: string | null }, primaryRef: string | null | undefined) => {
  const name = d.pipeline?.trim();
  if (!name) return null;
  return primaryRef && d.pipeline_id === primaryRef ? `${name} (default)` : name;
};
export const dealPath = (companyId: string, dealId: string) => `/accounts/${companyId}/deals/${dealId}`;

/**
 * The account's deals in its left rail, below Owner and above Contacts (GET-267). Open deals as
 * compact rows (stage, value, close date); closed deals folded into one line. A row opens the
 * deal page. Replaces the Deals tab: a deal is part of the account's record, not a separate view.
 */
export function DealsSection({ companyId }: { companyId: string }) {
  const navigate = useNavigate();
  const { data, isPending } = useAccountDeals(companyId);
  const [showClosed, setShowClosed] = useState(false);
  const secLabel = "text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/55";
  const deals = data?.deals ?? [];
  const open = deals.filter(d => d.status === "open");
  const closed = deals.filter(d => d.status !== "open");
  const won = closed.filter(d => d.status === "won").length;

  const Row = ({ d }: { d: DealSummary }) => {
    const st = STATUS_UI[d.status] ?? STATUS_UI.open;
    const close = shortDate(d.close_date);
    const overdue = d.status === "open" && !!d.close_date && Date.parse(d.close_date) < Date.now();
    return (
      <button onClick={() => navigate(dealPath(companyId, d.id))}
        className="flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 -mx-2 hover:bg-muted/50 transition-colors text-left">
        <span className="mt-[7px] h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ background: st.color }} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[13px] font-medium text-foreground truncate flex-1">{d.name}</span>
            <span className="text-[12.5px] font-semibold tabular-nums text-foreground/85 flex-shrink-0">{money(d.value, d.currency) ?? "—"}</span>
          </div>
          <div className="text-[11px] text-muted-foreground/55 truncate">
            {dealStageText(d) || st.label}
            {close && <span className={cn(overdue && "text-amber-600 dark:text-amber-400")}> · {d.status === "open" ? (overdue ? `was due ${close}` : `closes ${close}`) : `closed ${close}`}</span>}
            {d.owners?.[0]?.name && <span> · {d.owners[0].name}{d.owners.length > 1 ? ` +${d.owners.length - 1}` : ""}</span>}
          </div>
        </div>
      </button>
    );
  };

  return (
    <div className="pt-1 border-t border-border/60">
      <div className={cn(secLabel, "pt-3 mb-2")}>Deals{data ? ` · ${open.length}` : ""}</div>
      {isPending
        ? <p className="text-[12px] text-muted-foreground/50">Loading…</p>
        : deals.length === 0
          ? <p className="text-[12px] text-muted-foreground/50">No deals yet</p>
          : <div className="space-y-0.5">
              {open.map(d => <Row key={d.id} d={d} />)}
              {open.length === 0 && <p className="text-[12px] text-muted-foreground/50">No open deals</p>}
              {closed.length > 0 && (
                <>
                  <button onClick={() => setShowClosed(v => !v)} className="mt-1 flex items-center gap-1 text-[11.5px] text-muted-foreground/60 hover:text-foreground">
                    {showClosed ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    {closed.length} closed · {won} won
                  </button>
                  {showClosed && closed.map(d => <Row key={d.id} d={d} />)}
                </>
              )}
            </div>}
    </div>
  );
}
