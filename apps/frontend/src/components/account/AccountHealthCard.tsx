// Account health on a customer's Overview (GET-692): which list the Customers page puts this
// account on, and why. The same classifier and reasons as that page, never a score of ours: each
// line is a CRM field or something the customer said, with where it came from. A prospect has no
// account health, and the card draws nothing.
import { SlackText } from "@/components/record/SlackText";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";
import { H3 } from "@/components/record/OverviewParts";
import { ListCard } from "@/components/ui/list";
import { kindOf, sourceOf, REASON_KIND, type Side } from "@/components/customers/reasonKinds";
import type { CsReason } from "@/components/customers/types";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

export type AccountHealthState = "healthy" | "expansion" | "at_risk" | "churned";
type AccountHealth = {
  state: AccountHealthState | null;
  riskReasons?: CsReason[];
  expansionReasons?: CsReason[];
  promisedReasons?: CsReason[];
};

const STATE: Record<AccountHealthState, { label: string; tone: string }> = {
  healthy: { label: "Healthy", tone: "text-foreground/80" },
  expansion: { label: "Expansion", tone: "text-positive" },
  at_risk: { label: "At risk", tone: "text-risk" },
  churned: { label: "Churned", tone: "text-risk" },
};

export function useAccountHealth(companyId: string | null, enabled: boolean) {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const wsId = (userData as { workspace?: { id?: string } } | null)?.workspace?.id ?? "";
  return useQuery({
    queryKey: ["account-health", wsId, companyId],
    enabled: enabled && !!token && !!wsId && !!companyId,
    queryFn: async () => {
      const r = await fetch(`${apiUrl}/api/companies/${companyId}/account-health?workspaceId=${wsId}`, { headers: { Authorization: `Bearer ${token}` } });
      return (r.ok ? await r.json() : { state: null }) as AccountHealth;
    },
  });
}

function Reason({ r, side }: { r: CsReason; side: Side }) {
  const kind = kindOf(r, side);
  const quote = r.quote?.trim() || null;
  return (
    <li className="flex gap-3 rounded-lg px-2 py-1.5 transition-colors duration-fast hover:bg-hover">
      <span className={cn("w-[74px] flex-shrink-0 pt-px text-[11.5px] font-medium", REASON_KIND[kind].chip)}>{REASON_KIND[kind].label}</span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] leading-snug text-foreground">{r.text}</p>
        {quote && <p className="mt-0.5 text-[12px] italic leading-snug text-muted-foreground">“<SlackText text={String(quote)} />”</p>}
        <p className="mt-0.5 truncate text-[11.5px] text-muted-foreground/70">{sourceOf(r, kind)}</p>
      </div>
    </li>
  );
}

export function AccountHealthCard({ health }: { health: AccountHealth | undefined }) {
  if (!health?.state) return null;
  const st = STATE[health.state];
  const risk = health.riskReasons ?? [];
  const exp = health.expansionReasons ?? [];
  const owed = health.promisedReasons ?? [];
  // At risk, the reasons that put it there lead; an opening is held until it is saved.
  const atRisk = health.state === "at_risk";
  const lead = atRisk || health.state === "churned" ? risk.slice(0, 4) : exp.slice(0, 3);
  const second = atRisk ? exp.slice(0, 2) : risk.filter(r => r.tier <= 3).slice(0, 2);
  const secondLabel = atRisk ? "Expansion, held while at risk" : "Worth watching";

  return (
    <ListCard className="min-w-0">
      <div className="flex min-h-8 items-center gap-2 px-2 pb-1 pt-0.5">
        {/* "Customer health" since GET-800: "Account health" is now the Nous score card above it. */}
        <H3>Customer health</H3>
        <span className="flex-1" />
        <span className={cn("text-[12.5px] font-medium", st.tone)}>{st.label}</span>
      </div>
      {!lead.length && !second.length && !owed.length ? (
        <p className="px-2 py-2 text-[12.5px] text-muted-foreground">Nothing needs you. No risk in the CRM or in what they said.</p>
      ) : (
        <div className="space-y-1.5">
          {lead.length > 0 && <ul>{lead.map((r, i) => <Reason key={`l${i}`} r={r} side={atRisk || health.state === "churned" ? "risk" : "expansion"} />)}</ul>}
          {second.length > 0 && (
            <div>
              <p className="px-2 pt-1 text-[11.5px] text-muted-foreground/60">{secondLabel}</p>
              <ul>{second.map((r, i) => <Reason key={`s${i}`} r={r} side={atRisk ? "expansion" : "risk"} />)}</ul>
            </div>
          )}
          {owed.length > 0 && <ul>{owed.slice(0, 3).map((r, i) => <Reason key={`o${i}`} r={r} side="risk" />)}</ul>}
        </div>
      )}
    </ListCard>
  );
}
