// The account's deals, in the record's left pane (GET-608). They were a tab and an Overview card;
// a deal is part of the account's record, so it sits with the account's other properties.
//
// Read-only on purpose. Deals are born in the CRM and their stage moves there; a deal whose close
// date has passed is marked for the rep to act on in the CRM, never a button that changes it here.
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAccountDeals, dealStageText, dealPath, pipelineText, countsAsDeal, type DealSummary } from "@/components/deals/AccountDeals";
import { usePipelineStages } from "@/components/pipeline/usePipelineData";
import { PaneItem, PaneSection } from "@/components/record/RecordLayout";
import { RecordPreview } from "@/components/record/RecordPreview";
import { stageGroup } from "@/components/record/stageGroup";
import { CrmMark } from "@/components/ui/crm-link";
import { ListEmpty, ListMeta, ListText, ListTile } from "@/components/ui/list";
import { crmName } from "@/lib/crm";
import { money, day } from "@/lib/format";

const overdue = (d: DealSummary) => d.status === "open" && !!d.close_date && Date.parse(d.close_date) < Date.now();

/** Open pipeline, the open-deal count and what was won, from the account's deals. */
export function dealTotals(deals: DealSummary[]) {
  const live = deals.filter(countsAsDeal);
  const open = live.filter(d => d.status === "open");
  const won = live.filter(d => d.status === "won");
  return {
    open: open.length,
    pipeline: open.reduce((s, d) => s + (d.value ?? 0), 0),
    wonCount: won.length,
    won: won.reduce((s, d) => s + (d.value ?? 0), 0),
  };
}

/**
 * A deal's name without its account's: CRM deals are often named "Meridian Analytics · Platform",
 * and on the account's own page the first half says nothing. The full name stays in the tooltip.
 */
export function shortDealName(name: string, account: string | null | undefined) {
  const a = (account ?? "").trim();
  if (!a || !name.toLowerCase().startsWith(a.toLowerCase())) return name;
  const rest = name.slice(a.length).replace(/^\s*[·\-–—:|/]\s*/, "").trim();
  return rest || name;
}

function DealRow({ d, companyId, primary, accountName }: { d: DealSummary; companyId: string; primary: string | null; accountName?: string | null }) {
  const navigate = useNavigate();
  const ladder = usePipelineStages(d.pipeline_id ?? "all").data;
  const g = stageGroup(d.status, d.stage, ladder);
  const late = overdue(d);
  const close = day(d.close_date);
  const title = [
    d.name,
    dealStageText(d) ?? g.label,
    pipelineText(d, primary),
    close ? (d.status === "open" ? (late ? `was due ${close}` : `closes ${close}`) : `closed ${close}`) : null,
    late ? `The close date passed. Update the deal in ${crmName()}.` : null,
  ].filter(Boolean).join(" · ");
  const value = d.value != null ? money(d.value) : null;
  // A palette row: the stage as a dot in the 24px tile (its colour is the stage group), the deal
  // at 13px with its stage beside it in the quiet tone, the amount on the right.
  return (
    <PaneItem onClick={() => navigate(dealPath(companyId, d.id))}>
      <span className="sr-only">{title}</span>
      {/* The implied deal (no CRM deal behind it, id "account") is named in full, "<Account> deal",
          and has no stage dot: it is the account worked as a deal, not a CRM record (GET-804). */}
      {!d.implied && <ListTile><span className="h-[7px] w-[7px] rounded-full" style={{ background: g.color }} /></ListTile>}
      <ListText
        title={(
          <RecordPreview kind="deal" companyId={companyId} dealId={d.id}>
            <span>{d.implied ? d.name : shortDealName(d.name, accountName)}</span>
          </RecordPreview>
        )}
        sub={late ? <span className="text-warning">Overdue</span> : d.status === "open" ? (dealStageText(d) ?? g.label) : d.status === "won" ? "Won" : "Lost"} />
      {d.hubspot_url && (
        <a href={d.hubspot_url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}
          title={`Open in ${crmName()}`} aria-label={`Open ${d.name} in ${crmName()}`}
          className="flex-shrink-0 rounded p-0.5 opacity-0 transition-opacity duration-fast focus-visible:opacity-100 group-hover:opacity-100">
          <CrmMark className="h-3 w-3 text-[7px]" />
        </a>
      )}
      <ListMeta className={d.status === "open" ? "text-[12.5px] text-foreground" : undefined}>{value ?? "—"}</ListMeta>
    </PaneItem>
  );
}

/** Every deal on the account: open ones listed, closed ones behind the "N closed" toggle. */
export function AccountDealsSection({ companyId, accountName }: { companyId: string; accountName?: string | null }) {
  const { data, isPending, isError } = useAccountDeals(companyId);
  const [showClosed, setShowClosed] = useState(false);
  const deals = data?.deals ?? [];
  const primary = data?.primary_pipeline_ref ?? null;
  const open = deals.filter(d => d.status === "open");
  const closed = deals.filter(d => d.status !== "open");
  const won = closed.filter(d => d.status === "won").length;

  return (
    <PaneSection title="Deals" count={data ? deals.length : undefined}
      meta={closed.length > 0 ? (
        <button type="button" onClick={() => setShowClosed(v => !v)} aria-expanded={showClosed}
          className="tabular-nums transition-colors duration-fast hover:text-foreground">
          {closed.length} closed · {won} won
        </button>
      ) : undefined}>
      {isPending ? <ListEmpty className="text-[12.5px]">Loading deals…</ListEmpty>
        : isError ? <ListEmpty className="text-[12.5px] text-warning">Deals could not be loaded right now.</ListEmpty>
        : deals.length === 0 ? <ListEmpty className="text-[12.5px]"><span title={`Deals are created in ${crmName()} and show up on the next sync`}>No deals</span></ListEmpty>
        : (
          <>
            {open.map(d => <DealRow key={d.id} d={d} companyId={companyId} primary={primary} accountName={accountName} />)}
            {open.length === 0 && <ListEmpty className="text-[12.5px]">No open deals</ListEmpty>}
            {showClosed && closed.map(d => <DealRow key={d.id} d={d} companyId={companyId} primary={primary} accountName={accountName} />)}
          </>
        )}
    </PaneSection>
  );
}
