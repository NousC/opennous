// The deal's left pane (GET-608): back to its account, the deal's name and amount, where it
// stands (the stage, its group and how far along the pipeline), its dates and owner, the people
// on it and its products.
//
// Read-only for a CRM deal: stage, amount and owner change in the CRM. An account's own deal (no
// CRM record behind it) keeps its two edits, the stage and the value.
import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { AccountLogo } from "@/components/pipeline/DealBits";
import { usePipelineStages } from "@/components/pipeline/usePipelineData";
import { PaneItem, PaneSection, PropRow } from "@/components/record/RecordLayout";
import { RecordPreview } from "@/components/record/RecordPreview";
import { stageGroup, stageProgress } from "@/components/record/stageGroup";
import { MemberAvatar } from "@/components/ui/member-avatar";
import { PersonAvatar } from "@/components/ui/owner-filter";
import { ListEmpty, ListText } from "@/components/ui/list";
import { day, inDays, money, isOverdue } from "@/lib/format";
import { cn } from "@/lib/utils";
import { dealStageText, pipelineText, type DealDetail } from "./AccountDeals";
import { STAGE_CHOICES, stageChoiceKey } from "./stageChoices";

const SEGMENTS = 5;

const n = (v: unknown): number | null => {
  const x = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(x) ? x : null;
};

/** A CRM line item as a row: name, "· 2 × annual" when it says so, and its amount. */
function lineItem(li: Record<string, unknown>) {
  const qty = n(li.quantity);
  const period = typeof li.hs_recurring_billing_period === "string" ? li.hs_recurring_billing_period : null;
  const term = period ? ({ P12M: "annual", P1M: "monthly", P3M: "quarterly", P6M: "6 months" } as Record<string, string>)[period] ?? null : null;
  const amount = n(li.amount) ?? ((n(li.price) ?? 0) * (qty ?? 1) || null);
  return {
    name: String(li.name ?? "Line item"),
    detail: qty != null && (qty !== 1 || term) ? `${qty} × ${term ?? "unit"}` : term,
    amount,
  };
}

export function DealPane({ dd, onOpenAccount, onOpenPerson, valueSlot, edit }: {
  dd: DealDetail;
  onOpenAccount: () => void;
  onOpenPerson: (id: string) => void;
  /** The amount when it is editable (an account's own deal). */
  valueSlot?: ReactNode;
  edit: { saving: boolean; setStage: (write: string) => void };
}) {
  const { deal, account, people } = dd;
  const ladder = usePipelineStages(deal.pipeline_id ?? "all").data;
  const g = stageGroup(deal.status, deal.stage, ladder);
  const filled = stageProgress(deal.status, deal.stage, ladder, SEGMENTS);
  const pipeline = pipelineText(deal, dd.primary_pipeline_ref);
  const open = deal.status === "open";
  const late = open && isOverdue(deal.close_date);
  const items = (dd.line_items ?? []).map(lineItem);
  const total = items.reduce((s, i) => s + (i.amount ?? 0), 0);
  const owners = (deal.owners ?? []).map(o => o.name).filter((x): x is string => !!x);
  const ownerNames = owners.length ? owners : [deal.owner_name || deal.owner_email].filter((x): x is string => !!x);

  return (
    <>
      <div className="px-5 pb-[18px] pt-5">
        <button type="button" onClick={onOpenAccount}
          className="inline-flex max-w-full items-center gap-1.5 text-[12px] text-muted-foreground/70 transition-colors duration-fast hover:text-foreground">
          <RecordPreview kind="account" companyId={account.id}>
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <AccountLogo name={account.name} domain={account.domain} size={16} />
              <span className="truncate">{account.name ?? "Account"}</span>
            </span>
          </RecordPreview>
        </button>
        <h1 className="mt-2 text-[18px] font-semibold leading-snug tracking-[-0.015em] text-foreground [overflow-wrap:anywhere]">{deal.name}</h1>

        <div className="mt-3.5">
          {valueSlot ?? (
            <div className="flex items-baseline gap-2">
              <span className="text-[22px] font-semibold tabular-nums tracking-[-0.02em] text-foreground">{deal.value != null ? money(deal.value, "table", !deal.currency || deal.currency === "USD" ? "$" : `${deal.currency} `) : "—"}</span>
              <span className="text-[12px] text-muted-foreground/70">deal amount</span>
            </div>
          )}
        </div>

        <div className="mt-4 rounded-xl border border-border/70 bg-card px-3 py-2.5" title={deal.implied ? undefined : "Stage changes come from the CRM"}>
          {deal.implied ? (() => {
            const key = stageChoiceKey(deal.stage);
            const col = STAGE_CHOICES.find(x => x.key === key)?.color;
            return (
              <div className="relative">
                <select value={key} disabled={edit.saving} aria-label="Stage"
                  onChange={e => { const opt = STAGE_CHOICES.find(x => x.key === e.target.value); if (opt) edit.setStage(opt.write); }}
                  className="w-full cursor-pointer appearance-none rounded-lg border border-border bg-card py-1.5 pl-2.5 pr-8 text-[13px] font-medium outline-none focus:border-foreground/40 disabled:opacity-70" style={{ color: col }}>
                  {STAGE_CHOICES.map(o => <option key={o.key} value={o.key} style={{ color: "inherit" }}>{o.label}</option>)}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              </div>
            );
          })() : (
            <div className="flex min-w-0 items-center gap-1.5 text-[13px]">
              <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ background: g.color }} />
              <span className="truncate">{dealStageText(deal) || g.label}</span>
              {g.key !== "open" && (dealStageText(deal) ?? "") !== g.label && (
                <span className="truncate text-[11.5px] text-muted-foreground/70">{g.label}</span>
              )}
            </div>
          )}
          <div className="mt-2 flex gap-[3px]" aria-label={`${filled} of ${SEGMENTS}`}>
            {Array.from({ length: SEGMENTS }, (_, i) => (
              <span key={i} className={cn("h-[3px] flex-1 rounded-full", i < filled ? (deal.status === "lost" ? "bg-risk" : "bg-foreground/80") : "bg-border/70")} />
            ))}
          </div>
        </div>
      </div>

      <PaneSection>
        <PropRow label={ownerNames.length > 1 ? "Owners" : "Owner"} labelWidth={96} empty={!ownerNames.length}>
          <span className="flex flex-col gap-1">
            {ownerNames.map(o => (
              <span key={o} className="inline-flex min-w-0 items-center gap-1.5"><MemberAvatar name={o} size={18} /><span className="truncate">{o}</span></span>
            ))}
          </span>
        </PropRow>
        <PropRow label={open ? "Closes" : "Closed"} labelWidth={96} empty={!deal.close_date}>
          <span className="tabular-nums">
            {day(deal.close_date)}
            {open && <span className={late ? "text-warning" : "text-muted-foreground/70"}> · {late ? "overdue" : inDays(deal.close_date)}</span>}
          </span>
        </PropRow>
        <PropRow label="Opened" labelWidth={96} empty={!deal.opened_date}><span className="tabular-nums">{day(deal.opened_date)}</span></PropRow>
        {pipeline && <PropRow label="Pipeline" labelWidth={96}>{pipeline}</PropRow>}
        {open && (
          <PropRow label="In stage" labelWidth={96} empty={deal.days_in_stage == null}>
            <span className="tabular-nums">{deal.days_in_stage} {deal.days_in_stage === 1 ? "day" : "days"}</span>
          </PropRow>
        )}
      </PaneSection>

      <PaneSection title="People" count={people.length}>
        {people.length === 0
          ? <ListEmpty className="text-[12.5px]">{deal.roster_known ? "No one yet" : "The CRM doesn't link people to this deal"}</ListEmpty>
          : people.slice(0, 10).map(p => (
            <PaneItem key={p.id} onClick={() => onOpenPerson(p.id)}>
              <PersonAvatar person={{ id: p.id, name: p.name }} size={24} />
              <ListText
                title={(
                  <RecordPreview kind="person" name={p.name} title={p.title} lastActivityAt={p.last_activity_at}>
                    <span>{p.name}</span>
                  </RecordPreview>
                )}
                sub={p.title ?? undefined}
                className="[&>span:first-child]:max-w-[72%] [&>span:first-child]:flex-shrink-0" />
            </PaneItem>
          ))}
      </PaneSection>

      {items.length > 0 && (
        <PaneSection title="Products">
          {items.slice(0, 12).map((li, i) => (
            <div key={i} className="flex min-h-8 min-w-0 items-center gap-2 px-2 text-[13px]">
              <ListText title={li.name} sub={li.detail ?? undefined} />
              <span className="flex-shrink-0 tabular-nums text-foreground/85">{li.amount != null ? money(li.amount) : "—"}</span>
            </div>
          ))}
          <div className="flex min-h-8 items-center justify-between px-2 text-[13px]">
            <span className="text-muted-foreground/70">Total</span><span className="tabular-nums">{money(total)}</span>
          </div>
        </PaneSection>
      )}
    </>
  );
}
