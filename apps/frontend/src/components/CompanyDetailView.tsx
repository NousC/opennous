// CompanyDetailView — the account page (interface refresh, GET-608). The left pane is the refresh's;
// the Overview and Intel tabs are the workspace redesign's, restored 2026-10-06 at the founder's ask.
//
// Two panes. LEFT, the record's properties: who it is and whose it is, the open pipeline, then
// Deals (the old Deals tab), Contacts, Qualification and Company details. RIGHT, the work, as
// tabs: Overview · Intel · Activity · Tasks · Org chart, with Share and the CRM link at the end of
// the tab row. "Brief me" went: Ask Nous in the top bar does the same with the account attached.
//
//   Overview  — for a customer, six CRM numbers; the AI Overview; a follow-up waiting, recent
//               activity, intel and open tasks.
//   Intel     — every fact in a card per category.
//
// Since GET-800 the Overview shows ACCOUNT health (engagement, decision makers covered, open
// blockers, risk signals, adoption for a customer; packages/core accountHealthScore), not deal
// health: deal health belongs to a deal and lives on the deal page. The next step is read off the
// latest conversation, and the Qualification panel lists every decision maker, named or not.
//   Activity  — the feed, the account's pages (call summaries, documents) and its public signals in
//               one list, cut by filter chips.
//   Tasks / Org chart — as before.
//
// Reads the existing /companies/:id/detail payload plus the account's deals and tasks.
//
// Every edition renders it, self-host included (GET-947): the open-source app shows the same account
// page as the Cloud API plan. What only Cloud serves (tasks, follow-ups) is off on self-host.
import { useEffect, useMemo, useState } from "react";
import { AccountPane } from "@/components/account/AccountPane";
import { RecordShell, RecordTabs, TabBody, type RecordTab } from "@/components/record/RecordLayout";
import ShareMenu from "@/components/ShareMenu";
import { CrmLink } from "@/components/ui/crm-link";
import { AiOverviewCard } from "@/components/account/classic/AiOverviewCard";
import { IntelOverview, intelCountOf } from "@/components/record/IntelOverview";
import { useTopBarCrumbs } from "@/components/shell/topBar";
import { relTime, tierFromScore } from "@/components/mind/shared";
import { useAuth } from "@/contexts/AuthContext";
import OrgChartFlow from "@/components/OrgChartFlow";
import { TaskList, taskSections, useTaskToggle, bandOf, intelChips, type IntelTopic, type TaskListState, type Note, type DealSignal, type DealHealth } from "@/components/record/RecordParts";
import { useAccountDeals } from "@/components/deals/AccountDeals";
import { DealHealthCard } from "@/components/record/DealHealthCard";
import { NextStepCard, type NextStep } from "@/components/account/NextStepCard";
import type { DecisionMaker } from "@/components/account/AccountPane";
import { CustomerStrip } from "@/components/account/CustomerStrip";
import { AccountHealthCard, useAccountHealth } from "@/components/account/AccountHealthCard";
import { useAccountHealthTrend } from "@/components/account/useAccountHealthTrend";
import { AccountActivityTab, RecentActivity, buildAccountFeed } from "@/components/account/AccountActivity";
import { FollowUpReady, useAccountFollowUps } from "@/components/account/AccountFollowUps";
import { CommitteeCoverage } from "@/components/account/CommitteeCoverage";
import { customerKind, num, type CsBag } from "@/components/account/parts";
import { NewTaskDialog } from "@/components/tasks/NewTaskDialog";
import { usePlan } from "@/hooks/usePlan";
import { isApiTier } from "@/config/plans";
import { EventFeed } from "@/components/events/EventFeed";
import { ListCard } from "@/components/ui/list";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

type Tab = "overview" | "intel" | "activity" | "events" | "tasks" | "orgchart";

type Stakeholder = {
  id: string; name: string; title: string | null; seniority: string | null;
  pipeline_stage: string; deal_health_score: number | null; icp_score: number | null;
  deal_value: number | null; photo_url: string | null;
  last_activity_at: string | null; signal_count: number;
  sentiment?: "supporter" | "detractor" | "neutral" | null;
  role?: string | null;
};
type CompanyDetail = {
  company: Record<string, any>;
  icp: { score: number; reason: string | null } | null;
  stakeholders: Stakeholder[];
  edges: { subject_id: string; relationship: string; object_id: string | null; object_label: string | null; confidence?: number | null; source_memory_id?: string | null; metadata?: any }[];
  activity: any[];
  notes: Note[];
  intel_topics?: IntelTopic[] | null;
  signals: any[];
  deal_health?: DealHealth | null;
  /** The account's own health (GET-800), with the decision makers behind its coverage factor. */
  account_health?: (DealHealth & { decision_makers?: DecisionMaker[] }) | null;
  /** The next step from the latest conversation (GET-800). */
  next_step?: NextStep | null;
  /** The account's own pages, and its calls kept apart from them (GET-349). */
  documents?: any[];
  calls?: any[];
  /** The CRM's customer-health bag (status, MRR, CS owner, its own health score). Null on a prospect or an older server. */
  cs?: CsBag | null;
  /** The account's record in HubSpot, when it has one. */
  hubspot_url?: string | null;
};

export default function CompanyDetailView({
  cd, onOpenPerson, onPatch, getVal, saving, onRefresh,
}: {
  cd: CompanyDetail;
  onOpenPerson: (id: string) => void;
  onPatch: (key: string, value: string) => void;
  /** Kept for the caller's sake. A deal's value is the CRM's to set, so this page no longer edits it. */
  onSetDealValue?: (value: number | null) => void;
  getVal: (key: string, fallback: string | null | undefined) => string | null;
  saving: boolean;
  onRefresh?: () => void;
}) {
  const [tab, setTab] = useState<Tab>("overview");
  const co = cd.company || {};
  // A new account opens on its Overview, not on whichever tab the last one was left on.
  useEffect(() => { setTab("overview"); }, [co.id]);

  const name = getVal("name", co.name) ?? co.name ?? "—";
  useTopBarCrumbs(co.id ? [{ label: "Accounts", href: "/accounts" }, { label: name }] : null);
  const domain = getVal("domain", co.domain) ?? co.domain ?? null;
  const icpScore: number | null = co.icp_score ?? cd.icp?.score ?? null;
  const tier = icpScore != null ? tierFromScore(icpScore) : null;
  const cs: CsBag | null = (cd.cs ?? co.cs ?? null) as CsBag | null;
  const kind = customerKind(cs);
  const hubspotUrl: string | null = cd.hubspot_url ?? co.hubspot_url ?? null;
  // The AE is the account's owner; the CS owner is the CRM's separate field. Two people.
  const owners: { name: string | null }[] = co.owners ?? [];
  const ae: string | null = owners[0]?.name ?? co.owner_name ?? null;
  const csOwner: string | null = (cs?.owner_name as string | null | undefined) ?? null;

  // A refresh answers with the new summary before its claim is projected, so hold it here.
  const [freshSummary, setFreshSummary] = useState<{ text: string; at: string } | null>(null);
  const [summaryState, setSummaryState] = useState<"idle" | "working" | "failed">("idle");
  useEffect(() => { setFreshSummary(null); setSummaryState("idle"); }, [co.id]);
  const summaryText: string | null = freshSummary?.text ?? co.memory_summary ?? null;
  const summaryAt = freshSummary?.at ?? co.summary_generated_at ?? null;

  // Every extracted fact on this account, whoever wrote it. This used to test
  // `source === "signal_extraction"`, which reads as "extracted" but actually means "extracted by
  // the worker" — so a fact the revenue plugin recorded (source 'fellow'/'agent') or a health read
  // produced ('fellow:health') was filed on the right account and rendered nowhere: on a large
  // account that hid over a thousand company facts. What belongs off
  // this page is a DOCUMENT, and a document is what carries a doc_type.
  const intel = useMemo(
    // Intel only (GET-417): not documents, not the health read's adoption paragraph, not the
    // "Linked this meeting by speaker name" bookkeeping. The API says which with `intel`; the
    // metadata checks cover a payload from before it did.
    () => (cd.notes ?? []).filter(n => {
      const m = (n.metadata ?? {}) as { doc_type?: string; summary?: boolean; flag?: string; signal_type?: string };
      if ((n as { intel?: boolean }).intel === false) return false;
      return !m.doc_type && m.summary !== true && m.flag !== "speaker_name_link" && m.signal_type !== "health_adoption";
    }),
    [cd.notes],
  );
  const byCat = (c: string) => intel.filter(n => (n.category || "").toLowerCase() === c);
  // A company fact carries who voiced it (metadata.voiced_by_contact_id); resolve that
  // to a name so the claim popover can say "Voiced by <person>".
  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of cd.stakeholders) m.set(s.id, s.name);
    return m;
  }, [cd.stakeholders]);
  const voicedByName = (cid?: string | null) => (cid ? (nameById.get(cid) ?? null) : null);

  const acts = cd.activity ?? [];
  // One list for the Activity tab and the Overview's recent rows: activity, pages and signals.
  const feed = useMemo(
    () => buildAccountFeed({ acts, calls: cd.calls, documents: cd.documents, signals: cd.signals }),
    [acts, cd.calls, cd.documents, cd.signals],
  );

  // Tasks for this account (company + every contact), read by ACCOUNT (GET-400). This used to
  // fetch the whole workspace's list and keep this account's rows in the browser — on a large
  // workspace, ~700 rows paged five times to show ten — while the tab said "No tasks" until they arrived and
  // said the same after a timeout. The state is now explicit: loading, failed, or loaded.
  const { session, userData } = useAuth();
  const token = session?.access_token;
  const wsId = (userData as any)?.workspace?.id;
  const [tasks, setTasks] = useState<{ open: any[]; done: any[] }>({ open: [], done: [] });
  const [tasksState, setTasksState] = useState<TaskListState>("loading");
  const [creatingTask, setCreatingTask] = useState(false);
  const toggleTask = useTaskToggle(setTasks);
  // A record's own tasks are on every Cloud plan, the API plan included (GET-785): the Tasks tab and
  // Add task live here, while the Tasks PAGE (the worklist) stays the Workspace plan's. Self-host has
  // no tasks API (CLOUD_ONLY_FEATURES), so there is no tab rather than one that can only fail.
  const { selfHosted, plan } = usePlan();
  const tasksOn = !selfHosted;
  // The API plan and self-host see what happened on the account as events (GET-939, GET-947), the
  // same feed their webhooks and GET /v2/events carry; the Workspace keeps the CRM-style activity feed.
  const eventsTab = isApiTier(plan) || selfHosted;
  useEffect(() => {
    if (!token || !wsId || !co.id || !tasksOn) return;
    let cancelled = false;
    setTasksState("loading");
    fetch(`${apiUrl}/api/tasks/account/${co.id}?workspaceId=${wsId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(d => { if (cancelled) return; setTasks({ open: d.commitments ?? [], done: d.completed ?? [] }); setTasksState("ready"); })
      .catch(() => { if (!cancelled) setTasksState("error"); });
    return () => { cancelled = true; };
  }, [token, wsId, co.id, tasksOn]);

  // The account's deals, for when they became a customer. Each deal's own health is on its page.
  const dealsQ = useAccountDeals(co.id);
  const allDeals = dealsQ.data?.deals ?? [];
  // A customer's list on the Customers page and why (GET-692), drawn as "Customer health".
  const acctHealthQ = useAccountHealth(co.id ?? null, true);
  // When they became a customer: the first deal they signed, as the CRM dates it.
  const customerSince = allDeals
    .filter(d => d.status === "won" && !d.implied && d.close_date)
    .map(d => d.close_date as string)
    .sort()[0] ?? null;

  // Follow-ups are drafted by Cloud's engine; self-host has no /api/follow-ups.
  const followUps = useAccountFollowUps(co.id, cd.stakeholders.map(s => s.id), !selfHosted);

  const refreshSummary = async () => {
    if (!token || !wsId || !co.id || summaryState === "working") return;
    setSummaryState("working");
    try {
      const r = await fetch(`${apiUrl}/api/companies/${co.id}/summary?workspaceId=${wsId}`, {
        method: "POST", headers: { Authorization: `Bearer ${token}` },
      });
      const d = r.ok ? await r.json() : null;
      if (d?.summary) setFreshSummary({ text: d.summary, at: d.generated_at ?? new Date().toISOString() });
      setSummaryState(r.ok ? "idle" : "failed");
    } catch {
      setSummaryState("failed");
    }
  };

  // ── Account health (GET-800): computed in core from the account's facts and activity; this view
  // renders it in the health card's shape and expands each factor's evidence into its claims. ──
  const ah = cd.account_health ?? null;
  const health: number | null = ah?.score ?? null;
  // The trend under it (GET-804): backfilled weekly points and stored daily snapshots, always shown.
  const trendQ = useAccountHealthTrend(co.id ?? null);
  const accountHealth: DealHealth | null = ah ? { score: ah.score, band: ah.band, smart: ah.smart ?? [], numeric: ah.numeric ?? [], history: trendQ.data ?? [] } : null;
  const decisionMakers: DecisionMaker[] = ah?.decision_makers ?? [];
  // The header badge says whose number it is and the weakest factor behind it.
  const smartOf: DealSignal[] = accountHealth?.smart ?? [];
  const weakest = smartOf.find(s => s.tone === "bad") ?? smartOf.find(s => s.tone === "warn") ?? null;
  const nousTitle = `Account health: ${bandOf(health, accountHealth?.band ?? null)}${weakest ? `. ${weakest.label}: ${weakest.level}` : ""}`;

  const orgPlaceholders = useMemo(
    () => decisionMakers.filter(d => d.unnamed).map(d => ({ key: d.key, title: d.title, role: d.role, status: d.status, tier: d.tier ?? null, quote: d.quote ?? null })),
    [decisionMakers],
  );

  const intelCount = useMemo(() => intelCountOf(intel), [intel]);
  const TABS: RecordTab<Tab>[] = [
    { id: "overview", label: "Overview" },
    // EVERY fact on the account, grouped by category. A person has had this since the beginning;
    // a company never did, so the only ways to see a company's facts were six deal fields in the
    // sidebar and three capped lists on Overview — 19 of 53 on one account, with no screen
    // anywhere that showed the rest. The count is the honest total.
    { id: "intel", label: "Intel", count: intelCount },
    eventsTab ? { id: "events", label: "Events" } : { id: "activity", label: "Activity", count: feed.length },
    ...(tasksOn ? [{ id: "tasks" as const, label: "Tasks", count: tasksState === "ready" ? tasks.open.length : undefined }] : []),
    { id: "orgchart", label: "Org chart", count: cd.stakeholders.length || undefined },
  ];

  return (
    <RecordShell
      left={
        <AccountPane
          co={co} companyId={co.id ?? null} name={name} domain={domain} tier={tier} kind={kind}
          owners={owners.map(o => o.name).filter((n): n is string => !!n).concat(!owners.length && ae ? [ae] : [])}
          csOwner={csOwner} nousScore={health} nousBand={accountHealth?.band ?? null} nousTitle={nousTitle} crmScore={num(cs?.health_score)} saving={saving}
          people={cd.stakeholders} intel={intel} decisionMakers={decisionMakers} onOpenPerson={onOpenPerson} getVal={getVal} onPatch={onPatch}
        />
      }
    >
      <RecordTabs<Tab> tabs={TABS} value={tab} onChange={setTab}
        actions={
          <>
            {co.id && <ShareMenu entityId={co.id} entityKind="company" entityName={name} />}
            <CrmLink href={hubspotUrl} className="hidden sm:inline-flex" />
          </>
        } />

      <TabBody>
        {tab === "intel" ? (
          // One Intel for every record (GET-793), the health card's design. The health factors are
          // not repeated here: they are the Overview's Account health card.
          // Current state, then Headwinds / Tailwinds / About (GET-805).
          <IntelOverview facts={intel} nameOf={id => nameById.get(id) ?? null} companyId={co.id ?? null}
            empty="No intel yet. It's learned from calls and email on this account." />
        ) : tab === "activity" ? (
          <AccountActivityTab items={feed} />
        ) : tab === "events" ? (
          <ListCard><EventFeed accountId={co.id ?? null} showAccount={false} /></ListCard>
        ) : tab === "tasks" ? (
          <>
            <TaskList
              state={tasksState}
              sections={taskSections(tasks.open, tasks.done)}
              empty="No tasks on this account"
              onToggle={toggleTask}
              personOf={id => cd.stakeholders.find(s => s.id === id) ?? null}
              showQuote
              onAdd={token && wsId && co.id ? () => setCreatingTask(true) : undefined}
              recordName={name} recordDomain={domain}
            />
            {token && wsId && co.id && (
              <NewTaskDialog open={creatingTask} onOpenChange={setCreatingTask} token={token} workspaceId={wsId}
                meId={(userData as any)?.user?.id ?? null} meName={(userData as any)?.user?.name ?? null}
                accounts={[{ id: co.id, name, domain }]}
                onCreated={(task, created) => { if (created) setTasks(t => ({ ...t, open: [task, ...t.open.filter(x => x.id !== task.id)] })); }} />
            )}
          </>
        ) : tab === "orgchart" ? (
          <div className="min-w-0">
            <CommitteeCoverage stakeholders={cd.stakeholders} />
            {/* Unnamed decision roles ("the CEO", nobody met yet) as dashed placeholder nodes (GET-800). */}
            <OrgChartFlow stakeholders={cd.stakeholders} edges={cd.edges} companyId={co.id} companyName={co.name} onOpenPerson={onOpenPerson} onRefresh={onRefresh}
              placeholders={orgPlaceholders} />
          </div>
        ) : (
          // The workspace-redesign Overview (restored 2026-10-06): the AI Overview, then the work
          // beside the reference. Deals, contacts and company details stay in the left pane.
          <div className="min-w-0 space-y-6">
            {kind !== "prospect" && <CustomerStrip cs={cs} customerSince={customerSince} ae={ae} />}

            {/* One summary, three to five sentences (GET-792, GET-797). */}
            <AiOverviewCard summary={summaryText} at={summaryAt} state={summaryState} onRefresh={refreshSummary} />

            {/* Full width, one column (GET-792): the Intel and Open tasks cards left the overview.
                Facts live on Intel, tasks on Tasks; the intel timeline is on top of Intel (GET-797). */}
            <FollowUpReady recs={followUps} />
            <NextStepCard step={cd.next_step} />
            {/* The account's health, not a deal's (GET-800). Each deal's health is on its own page. */}
            {accountHealth && <DealHealthCard title="Account health"
              pillTitle="Nous account health, 0 to 100: engagement, decision makers covered, open blockers, risk signals and, for a customer, adoption"
              health={accountHealth} notes={cd.notes ?? []} voicedByName={voicedByName} />}
            <AccountHealthCard health={acctHealthQ.data} />
            {!eventsTab && <RecentActivity items={feed} onAll={() => setTab("activity")} />}
          </div>
        )}
      </TabBody>
    </RecordShell>
  );
}
