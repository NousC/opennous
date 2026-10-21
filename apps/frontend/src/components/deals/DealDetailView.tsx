// DealDetailView — one deal, laid out like the account it belongs to (GET-262, GET-608).
//
// LEFT  — the deal (DealPane): amount, stage and how far along, the dates, the owner, the people
//         on it and its products.
// RIGHT — Overview (highlights · Deal Health · stage movement · recent conversations),
//         Conversations (everything on the deal, the ones filed to it in the CRM marked),
//         People (who is on it and how much we've heard from each).
//
// Read-only on purpose: a deal is edited in the CRM. What Nous adds is where it is moving, who
// is actually engaged, and how healthy it is — the same card the account shows.
import { SlackText } from "@/components/record/SlackText";
import { useEffect, useState } from "react";
import { useTopBarCrumbs } from "@/components/shell/topBar";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/sonner";
import { useAuth } from "@/contexts/AuthContext";
import { usePlan } from "@/hooks/usePlan";
import { EntityAvatar } from "@/components/EntityAvatar";
import { relTime } from "@/components/mind/shared";
import { cn } from "@/lib/utils";
import { ActivityFeed, dedupeActivity, TaskList, useTaskToggle, type TaskListState } from "@/components/record/RecordParts";
import { shortDate, STATUS_UI, dealStageText, type DealDetail, type DealStage, type CloseRecord } from "./AccountDeals";
import { CrmLink } from "@/components/ui/crm-link";
import { EmptyState } from "@/components/ui/empty-state";
import { DealHealthCard } from "@/components/record/DealHealthCard";
import { IntelOverview, intelCountOf } from "@/components/record/IntelOverview";
import { SegmentedControl } from "@/components/ui/view-tabs";
import { CardHead, EventRow, Tile, TileStrip } from "@/components/record/OverviewParts";
import { DealOverviewCard } from "./DealOverviewCard";
import { ListCard, ListEmpty, ListMeta, ListText, listRowClass } from "@/components/ui/list";
import { stageGroup } from "@/components/record/stageGroup";
import { usePipelineStages } from "@/components/pipeline/usePipelineData";
import { feedEvent } from "@/components/account/AccountActivity";
import { money as fmtMoney, day as fmtDay, when as fmtWhen, inDays } from "@/lib/format";

const sentenceCase = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
import { RecordShell, RecordTabs, TabBody, type RecordTab } from "@/components/record/RecordLayout";
import { DealPane } from "./DealPane";

type Tab = "overview" | "intel" | "conversations" | "tasks" | "people";

export default function DealDetailView({ dd, onOpenAccount, onOpenPerson }: {
  dd: DealDetail;
  onOpenAccount: () => void;
  onOpenPerson: (id: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("overview");
  const { deal, account, people, stages, activity, health } = dd;
  const st = STATUS_UI[deal.status] ?? STATUS_UI.open;
  const nameById = new Map(people.map(p => [p.id, p.name]));
  const voicedByName = (id?: string | null) => (id ? nameById.get(id) ?? null : null);
  useTopBarCrumbs([
    { label: "Pipeline", href: "/pipeline" },
    ...(account.id ? [{ label: account.name ?? "Account", href: `/accounts/${account.id}` }] : []),
    { label: deal.name ?? "Deal" },
  ]);
  const overdue = deal.status === "open" && !!deal.close_date && Date.parse(deal.close_date) < Date.now();
  const filed = activity.filter((a: any) => a.filed_to_deal).length;
  // Intel is the deal's when its source conversation is (GET-404): filed to the deal in the CRM,
  // or by a rep through the CRM agent. The rest is the account's, shown apart — the same split
  // the Tasks tab makes, for the same reason: two deals on one account must not read alike.
  const notes = dd.notes ?? [];
  // Intel only: not documents, not summaries (the account page's rule, GET-417).
  const intelNotes = notes.filter(n => (n as { intel?: boolean }).intel !== false && !n.metadata?.doc_type && n.metadata?.summary !== true);
  const intelOnDeal = intelNotes.filter(n => n.filed_to_deal);
  // This deal's own facts by default; the whole account's when nothing was filed to the deal.
  const [intelScope, setIntelScope] = useState<"deal" | "account">(intelOnDeal.length ? "deal" : "account");
  const edit = useImpliedDealEdits(dd);
  // Self-host has no tasks API (CLOUD_ONLY_FEATURES), so no Tasks tab rather than one that can
  // only fail. Same rule as PersonDetailView.
  const { selfHosted } = usePlan();
  const tasksOn = !selfHosted;
  const tasks = useDealTasks(account.id, deal.id, tasksOn);

  const TABS: RecordTab<Tab>[] = [
    { id: "overview", label: "Overview" },
    { id: "intel", label: "Intel", count: intelCountOf(deal.implied || intelScope === "account" ? intelNotes : intelOnDeal) },
    { id: "conversations", label: "Conversations", count: activity.length },
    ...(tasksOn ? [{ id: "tasks" as const, label: "Tasks", count: tasks.state === "ready" ? tasks.filed.length + tasks.unfiled.length : undefined }] : []),
    { id: "people", label: "People", count: people.length },
  ];


  return (
    <RecordShell
      left={
        <DealPane dd={dd} onOpenAccount={onOpenAccount} onOpenPerson={onOpenPerson} edit={edit}
          valueSlot={deal.implied ? <EditableValue value={deal.value} onSave={edit.setValue} /> : undefined} />
      }
    >
      <RecordTabs<Tab> tabs={TABS} value={tab} onChange={setTab} label="Deal tabs"
        actions={<CrmLink href={deal.hubspot_url} className="hidden sm:inline-flex" />} />
      <TabBody>
          {tab === "intel" ? (
            // One Intel for every record (GET-805); the deal keeps its This deal / Whole account switch.
            <IntelOverview
              facts={deal.implied || intelScope === "account" ? intelNotes : intelOnDeal}
              nameOf={id => nameById.get(id) ?? null} companyId={account.id}
              empty={intelScope === "deal" && !deal.implied ? "Nothing filed to this deal has produced intel yet. Whole account shows what the people on it have said." : undefined}
              scope={deal.implied ? undefined : (
                <SegmentedControl<"deal" | "account"> aria-label="Scope" value={intelScope} onChange={setIntelScope}
                  options={[{ value: "deal", label: "This deal" }, { value: "account", label: "Whole account" }]} />
              )}
            />
          ) : tab === "conversations" ? (
            <div className="min-w-0">
              {!deal.implied && filed > 0 && (
                <p className="mb-2 px-2 text-[12px] text-muted-foreground/60">{filed} filed to this deal in the CRM</p>
              )}
              <ActivityFeed acts={activity} />
            </div>
          ) : tab === "tasks" ? (
            <div className="min-w-0">
              <TaskList
                onToggle={tasks.toggle}
                recordName={account.name} recordDomain={account.domain}
                personOf={id => people.find(p => p.id === id) ?? null}
                state={tasks.state}
                sections={deal.implied
                  ? [{ label: "Open", rows: [...tasks.filed, ...tasks.unfiled] }, { label: "Done", rows: tasks.done, done: true }]
                  : [
                      { label: "On this deal", rows: tasks.filed },
                      { label: "On the account, not filed to this deal", rows: tasks.unfiled },
                      { label: "Done", rows: tasks.done, done: true },
                    ]}
                empty="No tasks on this deal"
              />
            </div>
          ) : tab === "people" ? (
            <PeopleOnDeal people={people} onOpenPerson={onOpenPerson} />
          ) : (
            <div className="min-w-0 space-y-4">
              {/* The deal's own overview, where the account has its AI Overview (GET-793). */}
              {account.id && <DealOverviewCard accountId={account.id} dealId={deal.id} initial={dd.overview} />}
              <TileStrip>
                {deal.status === "open"
                  ? <Tile label="Time in stage" value={deal.days_in_stage != null ? `${deal.days_in_stage} ${deal.days_in_stage === 1 ? "day" : "days"}` : "—"} sub={dealStageText(deal)} />
                  : <Tile label="Outcome" value={st.label} sub={dealStageText(deal)} />}
                <Tile label={deal.status === "open" ? "Close date" : "Closed"} value={deal.close_date ? fmtDay(deal.close_date) : "Not set"}
                  sub={deal.status === "open" && deal.close_date ? (overdue ? "Past its close date" : sentenceCase(inDays(deal.close_date))) : undefined}
                  subTone={overdue ? "risk" : undefined} />
                <Tile label="Deal value" value={deal.value != null ? fmtMoney(deal.value) : "—"}
                  sub={people.length ? `${people.length} ${people.length === 1 ? "person" : "people"} on it` : "No one linked yet"} />
              </TileStrip>

              {deal.status !== "open" && <WhyItClosed record={dd.close_record ?? null} outcome={deal.status} />}

              {stages.length > 0 && <StageMovement stages={stages} deal={deal} />}

              <DealHealthCard health={health} notes={dd.notes ?? []} voicedByName={voicedByName} />

              <ListCard className="min-w-0">
                <CardHead title="Recent conversations" onAll={activity.length ? () => setTab("conversations") : undefined} />
                {activity.length === 0
                  ? <ListEmpty>No conversations yet</ListEmpty>
                  : (dedupeActivity(activity) as { id?: string; occurred_at?: string; created_at?: string; filed_to_deal?: boolean }[])
                    .filter(a => Date.parse(a.occurred_at || a.created_at || "") <= Date.now()).slice(0, 4).map((a, i) => {
                    const e = feedEvent({ key: String(i), at: a.occurred_at || a.created_at || null, kinds: [], type: "activity", a });
                    return <EventRow key={a.id ?? i} logo={e.logo} kind={e.kind} title={e.title} meta={a.filed_to_deal ? "filed to this deal" : e.meta} sub={e.sub}
                      when={fmtWhen(a.occurred_at || a.created_at)} onClick={() => setTab("conversations")} />;
                  })}
              </ListCard>
            </div>
          )}
      </TabBody>
    </RecordShell>
  );
}

/**
 * The deal's tasks (GET-400): the account's commitments, each saying whether it was filed to THIS
 * deal. A task reaches a deal on the write side — the call was filed to it in the CRM, or it was
 * the account's one open deal when the promise was made — so the page reads a flag, never guesses.
 * An account's implied deal files nothing; it shows the account's list as one.
 */
function useDealTasks(accountId: string, dealId: string, enabled = true) {
  const { session, userData } = useAuth();
  const token = session?.access_token;
  const wsId = (userData as any)?.workspace?.id;
  const apiUrl = import.meta.env.VITE_API_URL ?? "";
  const [state, setState] = useState<TaskListState>("loading");
  const [rows, setRows] = useState<{ open: any[]; done: any[] }>({ open: [], done: [] });
  useEffect(() => {
    if (!token || !wsId || !accountId || !enabled) return;
    let cancelled = false;
    setState("loading");
    fetch(`${apiUrl}/api/tasks/account/${accountId}?workspaceId=${wsId}&dealId=${encodeURIComponent(dealId)}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(d => { if (cancelled) return; setRows({ open: d.commitments ?? [], done: d.completed ?? [] }); setState("ready"); })
      .catch(() => { if (!cancelled) setState("error"); });
    return () => { cancelled = true; };
  }, [token, wsId, accountId, dealId, apiUrl, enabled]);
  const toggle = useTaskToggle(setRows);
  return {
    state,
    toggle,
    filed: rows.open.filter(t => t.filed_to_deal),
    unfiled: rows.open.filter(t => !t.filed_to_deal),
    done: rows.done,
  };
}

/**
 * Where the deal has been: each stage it sat in as a step, coloured by its group, with the day it
 * entered and how long it stayed. An open deal ends on a greyed "Closed" step with its expected
 * close date.
 */
function StageMovement({ stages, deal }: { stages: DealStage[]; deal: DealDetail["deal"] }) {
  const ladder = usePipelineStages(deal.pipeline_id ?? "all").data;
  return (
    <ListCard className="min-w-0">
      <CardHead title="Stage movement" />
      <div className="flex min-w-0 flex-wrap gap-x-1.5 gap-y-4 px-2 pb-2 pt-1.5">
        {stages.map((s, i) => {
          const g = stageGroup(s.status, s.label, ladder);
          return (
            <div key={`${s.entered_at}-${i}`} className="flex min-w-[110px] flex-1 flex-col gap-1.5">
              <span className="h-[3px] rounded-full" style={{ background: g.color }} />
              <span className="truncate text-[13px]">{s.label}</span>
              <span className="truncate text-[11.5px] tabular-nums text-muted-foreground/70">
                {s.status !== "open" ? `${s.status === "won" ? "Won" : "Lost"} ${fmtDay(s.entered_at)}`
                  : `${fmtDay(s.entered_at)} · ${s.days} ${s.days === 1 ? "day" : "days"}${s.current ? " so far" : ""}`}
              </span>
            </div>
          );
        })}
        {deal.status === "open" && (
          <div className="flex min-w-[110px] flex-1 flex-col gap-1.5">
            <span className="h-[3px] rounded-full bg-muted" />
            <span className="text-[13px] text-muted-foreground/60">Closed</span>
            <span className="text-[11.5px] tabular-nums text-muted-foreground/50">{deal.close_date ? `${Date.parse(deal.close_date) < Date.now() ? "Was due" : "Expected"} ${fmtDay(deal.close_date)}` : "No close date"}</span>
          </div>
        )}
      </div>
    </ListCard>
  );
}

// Why it closed (GET-405): the evidence that was on the deal while it was live, as the path it
// took, oldest first, each step with the customer's own words under it. The rep's CRM reason
// sits beside it as their account, never as the finding; a disagreement is the finding.
const EVENT_LABEL: Record<string, string> = {
  no_decision_maker: "No economic buyer", close_date_slipped: "Close date slipped", objection_open: "Objection never resolved",
  competitor_named: "Competitor named", budget_constraint: "Budget constraint", timing_constraint: "Timing constraint",
  risk_signal: "Relationship in question", went_quiet: "Went quiet",
  champion: "A champion", objection_resolved: "Objection resolved", buying_signal: "Buying signal", expansion_asked: "They asked for it",
};
function WhyItClosed({ record, outcome }: { record: CloseRecord | null; outcome: string }) {
  const lost = outcome !== "won";
  return (
    <ListCard className="min-w-0">
      <CardHead title={lost ? "Why it was lost" : "Why it was won"} right={record?.rep_reason ? (
        <div className="truncate text-[12px] text-muted-foreground/70">Rep logged: <span className="text-foreground">{record.rep_reason}</span></div>
      ) : undefined} />
      <div className="px-2 pb-2 pt-1">
      {!record ? (
        <p className="text-[13px] text-muted-foreground/70">Written the day after a deal closes</p>
      ) : !record.explained ? (
        <p className="text-[13px] text-muted-foreground/70">
          Nothing on the record explains it: no open objection, no competitor, no constraint stated, no silence.
          {record.rep_reason ? " The rep's reason is the only account we have." : ""}
        </p>
      ) : (
        <ol className="space-y-2.5">
          {record.events.map((e, i) => (
            <li key={`${e.kind}-${i}`} className="flex gap-3">
              <div className="w-[76px] flex-shrink-0 pt-px text-[11.5px] tabular-nums text-muted-foreground/70">{shortDate(e.at)}</div>
              <div className="min-w-0">
                <div className="text-[13px]">
                  <span className={lost ? "text-risk" : "text-positive"}>
                    {EVENT_LABEL[e.kind] ?? e.kind.replace(/_/g, " ")}
                  </span>
                  <span className="text-ink-2"> · {e.text}</span>
                  {e.attribution === "roster" && <span className="text-muted-foreground"> · from the people on it</span>}
                </div>
                {e.quote && <div className="mt-0.5 text-[12px] text-muted-foreground">“<SlackText text={String(e.quote)} />”</div>}
              </div>
            </li>
          ))}
        </ol>
      )}
      </div>
    </ListCard>
  );
}

function PeopleOnDeal({ people, onOpenPerson }: { people: DealDetail["people"]; onOpenPerson: (id: string) => void }) {
  if (!people.length) return <EmptyState title="No one is linked to this deal yet" />;
  // One palette list: the face, the name with their title beside it, how much we've heard.
  return (
    <ListCard>
      {people.map(p => (
        <button key={p.id} type="button" onClick={() => onOpenPerson(p.id)} className={listRowClass}>
          <EntityAvatar kind="person" name={p.name} photoUrl={p.photo_url} className="h-6 w-6 flex-shrink-0 rounded-full" textClassName="text-[9.5px] font-medium" />
          <ListText title={p.name} sub={p.title ?? undefined} />
          <ListMeta>
            {p.conversations ? `${p.conversations} conversation${p.conversations === 1 ? "" : "s"}` : "No conversations yet"}
            {p.last_activity_at ? ` · ${relTime(p.last_activity_at)}` : ""}
          </ListMeta>
        </button>
      ))}
    </ListCard>
  );
}

/**
 * Setting the stage and value of an account's own deal (no CRM record behind it). The stage goes
 * through the account-stage write (GET-263: moves the account's people so it reads back exactly);
 * the value is the primary person's deal_value, the same field the Accounts board totals. Every
 * list that shows this deal is refreshed after a save. CRM deals are never edited here.
 */
function useImpliedDealEdits(dd: DealDetail) {
  const { session, userData } = useAuth();
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);
  const apiUrl = import.meta.env.VITE_API_URL ?? "";
  const wsId = (userData as any)?.workspace?.id ?? "";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token ?? ""}` };
  const refresh = () => {
    for (const key of [["account-deal", wsId, dd.account.id], ["account-deals", wsId, dd.account.id], ["workspace-deals", wsId], ["companies-list", wsId], ["contacts", wsId]]) {
      qc.invalidateQueries({ queryKey: key });
    }
  };
  const run = async (req: () => Promise<Response>) => {
    setSaving(true);
    try {
      const r = await req();
      if (!r.ok) { const b = await r.json().catch(() => null); toast.error(b?.message || "Couldn't save that change"); return; }
      refresh();
    } catch { toast.error("Couldn't save that change"); }
    finally { setSaving(false); }
  };
  return {
    saving,
    setStage: (stage: string) => run(() => fetch(`${apiUrl}/api/companies/${dd.account.id}`, { method: "PATCH", headers, body: JSON.stringify({ pipeline_stage: stage }) })),
    setValue: (value: number | null) => {
      const primary = dd.people[0];
      if (!primary) { toast.error("Add a person to this account first"); return; }
      return run(() => fetch(`${apiUrl}/api/contacts/${primary.id}`, { method: "PATCH", headers, body: JSON.stringify({ dealValue: value }) }));
    },
  };
}

function EditableValue({ value, onSave }: { value: number | null; onSave: (v: number | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const commit = () => {
    setEditing(false);
    const raw = draft.replace(/[^0-9.]/g, "").trim();
    const next = raw === "" ? null : Math.round(Number(raw));
    if (next !== null && Number.isNaN(next)) return;
    if (next !== value) onSave(next);
  };
  return editing ? (
    <div className="flex items-center gap-1.5">
      <span className="text-[22px] font-semibold tracking-[-0.02em] text-muted-foreground leading-none">$</span>
      <input autoFocus value={draft} onChange={e => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
        placeholder="0" inputMode="numeric"
        className="w-28 text-[22px] font-semibold tracking-[-0.02em] text-foreground tabular-nums leading-none bg-transparent border-b border-border focus:border-foreground/50 outline-none" />
    </div>
  ) : (
    <button type="button" onClick={() => { setDraft(value != null ? String(value) : ""); setEditing(true); }}
      className="group text-left rounded-md -mx-1 px-1 transition-colors hover:bg-muted/50" title="Click to set the deal value">
      <span className="text-[22px] font-semibold tracking-[-0.02em] text-foreground tabular-nums leading-none">{value != null ? fmtMoney(value) : "—"}</span>
      <span className="ml-2 text-[12px] text-muted-foreground">deal amount</span>
    </button>
  );
}
