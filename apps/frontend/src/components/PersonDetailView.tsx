// PersonDetailView — Phase 2 person record.
//
// Tabs: Overview · Activity · Tasks · Meetings · Intel.
//   Overview — record details on the LEFT; "Who they are" (AI summary, no icon) sitting
//              ABOVE the activity heatmap on the RIGHT.
//   Activity — the full-width interaction feed.
//   Tasks    — action items owed on THIS person.
//   Meetings — the per-meeting summaries (documents) for this person.
//   Intel    — the person-scoped claims: Role (authority), How to approach (preference),
//              Relationships, and everything else.
//
// Reads the existing /api/contacts/:id payload ({contact, prediction, company,
// activities, memories, signals}).
import { useEffect, useState } from "react";
import { EntityAvatar } from "./EntityAvatar";
import { FileText } from "lucide-react";
import { relTime } from "@/components/mind/shared";
import { RecordOverview, ActivityYear } from "@/components/RecordOverview";
import { useAuth } from "@/contexts/AuthContext";
import { ALL_PIPELINE_STAGES, DEFAULT_STAGE, normalizeStage } from "@/config/pipeline";
import { toast } from "@/components/ui/sonner";
import { ActivityFeed, TaskList, useTaskToggle, SectionLabel, intelChips, taskSections, type TaskListState } from "@/components/record/RecordParts";
import { IntelOverview, intelCountOf } from "@/components/record/IntelOverview";
import { NewTaskDialog } from "@/components/tasks/NewTaskDialog";
import { usePlan } from "@/hooks/usePlan";
import { PaneItem, PaneSection, RecordShell, RecordTabs, TabBody, type RecordTab } from "@/components/record/RecordLayout";
import { Tile, TileStrip } from "@/components/record/OverviewParts";
import { ListCard, ListEmpty, ListHeader, ListMeta, ListText, ListTile, listRowClass } from "@/components/ui/list";
import { toolLogo, toolOfRef } from "@/lib/toolLogo";
import { AccountLogo } from "@/components/pipeline/DealBits";
import { EmptyState } from "@/components/ui/empty-state";
import { useTopBarCrumbs } from "@/components/shell/topBar";
import { when } from "@/lib/format";

/** A person's product usage from PostHog (GET-751), as the record's API sends it. */
type PersonProductUsage = { user: boolean; last_seen_at: string | null; active_days_30d: number | null; events_30d: number | null };
const usageTitle = (u: PersonProductUsage) =>
  [u.last_seen_at ? `Last used ${new Date(u.last_seen_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : null,
   u.active_days_30d != null ? `active ${u.active_days_30d} of the last 30 days` : null].filter(Boolean).join(", ") || "Uses the product";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

// The panel's patch keys are the API's; the record's columns are snake_case.
const PATCH_COLUMN: Record<string, string> = {
  firstName: "first_name", lastName: "last_name", jobTitle: "job_title", linkedinUrl: "linkedin_url",
  dealStage: "deal_stage", dealValue: "deal_value",
};
const SAVE_ERROR: Record<string, string> = {
  invalid_email_format: "That isn't a valid email address",
  invalid_pipeline_stage: "That stage doesn't exist",
  contact_already_exists: "Another person already has that email",
};
type Tab = "overview" | "activity" | "tasks" | "pages" | "intel";
// The whole funnel, terminals included — this feeds the record's Stage select, which is
// the manual override. Copied into a mutable array because that's what RecordOverview's
// `pipelineStages` prop takes.
const STAGES: string[] = [...ALL_PIPELINE_STAGES];

export default function PersonDetailView({
  data, onOpenCompany,
}: {
  data: any;
  onOpenCompany: (id: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("overview");
  // Edits made on this page, shown at once. The record behind them is a projection that
  // catches up within a minute, so without this an edit looked like it hadn't saved.
  const [edits, setEdits] = useState<Record<string, any>>({});
  useEffect(() => { setEdits({}); }, [data?.contact?.id]);

  const c = { ...(data?.contact ?? {}), ...edits };
  const prediction = data?.prediction ?? null;
  const company = data?.company ?? null;
  const acts: any[] = (data?.activities ?? []).filter((a: any) => a.activity_type !== "icp_scored");
  const mems: any[] = data?.memories ?? [];
  const facts = mems.filter((m: any) => !m.metadata?.doc_type && m.intel !== false);
  const documents = mems.filter((m: any) => m.metadata?.doc_type);
  const meetingDocs = documents.filter((d: any) =>
    /meeting|call/i.test(d.metadata?.doc_type || "") || /meeting|call|sync|1:1/i.test(d.metadata?.title || ""));
  // Everything else written about this person — briefs, plans, objection prep. It used to be
  // reachable only from the Pages index, which is now a reports index (GET-349), so without this
  // it is reachable from nowhere.
  const otherDocs = documents.filter((d: any) => !meetingDocs.includes(d));

  // An edited first or last name wins over a stored full name, so adding a last name shows up.
  const editedName = "first_name" in edits || "last_name" in edits;
  const joined = [c.first_name, c.last_name].filter(Boolean).join(" ");
  const name = (editedName ? joined : "") || c.name || joined || c.email || "—";
  const title = c.job_title || null;
  const usage = (c as { product_usage?: PersonProductUsage | null }).product_usage ?? null;
  // The top bar names the person under their account, as the account page names itself under Accounts.
  useTopBarCrumbs(c.id ? [
    { label: "Accounts", href: "/accounts" },
    ...(company?.name && c.company_id ? [{ label: company.name as string, href: `/accounts/${c.company_id}` }] : []),
    { label: name },
  ] : null);
  // Normalize on read: rows written before the funnel change still hold aware/
  // evaluating/proposal/client, and the Stage select has no option for those — it would
  // render blank and the first edit would silently overwrite the real stage.
  const stage = normalizeStage(c.pipeline_stage) ?? DEFAULT_STAGE;
  const icpScore: number | null = prediction?.score ?? c.icp_score ?? null;

  const intelCount = intelCountOf(facts);

  // Tasks owed on THIS person. Fetched on mount (not just when the tab opens) so the
  // tab can show a count, the way Activity does.
  const { session, userData } = useAuth();
  const token = session?.access_token;
  const wsId = (userData as any)?.workspace?.id;
  const [tasks, setTasks] = useState<{ open: any[]; done: any[]; meetings: any[] }>({ open: [], done: [], meetings: [] });
  const [tasksState, setTasksState] = useState<TaskListState>("loading");
  const [creatingTask, setCreatingTask] = useState(false);
  const meId = (userData as any)?.user?.id ?? null;
  // A record's own tasks are on every Cloud plan, the API plan included (GET-785): the Tasks tab and
  // Add task live here, while the Tasks PAGE (the worklist) stays the Workspace plan's. Self-host has
  // no tasks API (CLOUD_ONLY_FEATURES), so there is no tab rather than one that can only fail.
  const { selfHosted } = usePlan();
  const tasksOn = !selfHosted;
  // The person's state also carries meetings; the toggle only moves rows between open and done.
  const toggleTask = useTaskToggle(f => setTasks(t => ({ ...t, ...f({ open: t.open, done: t.done }) })));
  useEffect(() => {
    if (!token || !wsId || !c.id || !tasksOn) return;
    let cancelled = false;
    const headers = { Authorization: `Bearer ${token}` };
    // A task is this person's when it hangs on them OR is for them — "Avery to send Lena the
    // signup steps" sits on the account and belongs on Lena's page too (GET-400).
    const theirs = (arr: any[]) => (arr ?? []).filter((i: any) => i.entity_id === c.id || i.for_entity_id === c.id);
    // Read by account when the person has one: one small request instead of the workspace's
    // whole list. Without an account, the workspace list is the only reader there is.
    const taskReq = c.company_id
      ? fetch(`${apiUrl}/api/tasks/account/${c.company_id}?workspaceId=${wsId}`, { headers })
      : fetch(`${apiUrl}/api/tasks?workspaceId=${wsId}`, { headers });
    setTasksState("loading");
    taskReq
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(d => { if (cancelled) return; setTasks(t => ({ ...t, open: theirs(d.commitments), done: theirs(d.completed) })); setTasksState("ready"); })
      .catch(() => { if (!cancelled) setTasksState("error"); });
    // Upcoming meetings come from the worklist, which is the one place the calendar is read for
    // the next two weeks. Best-effort: the Next-meeting highlight, not the tab, depends on it.
    fetch(`${apiUrl}/api/tasks?workspaceId=${wsId}`, { headers })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!d || cancelled) return;
        // A meeting is one per event now, so this person may be any attendee, not only the lead.
        const theirMeetings = (d.meetings ?? []).filter((m: any) => m.entity_id === c.id || (m.attendees ?? []).some((a: any) => a.entity_id === c.id));
        setTasks(t => ({ ...t, meetings: theirMeetings }));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [token, wsId, c.id, c.company_id, tasksOn]);

  const patchContact = async (key: string, value: string) => {
    if (!token || !c.id) return;
    const col = PATCH_COLUMN[key] ?? key;
    const next = key === "dealValue" ? (value === "" ? null : Number(value)) : (value?.trim() || null);
    const had = col in edits;
    const before = edits[col];
    setEdits(e => ({ ...e, [col]: next }));
    const undo = () => setEdits(e => {
      const copy = { ...e };
      if (had) copy[col] = before; else delete copy[col];
      return copy;
    });
    try {
      const r = await fetch(`${apiUrl}/api/contacts/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ [key]: next }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        undo();
        toast.error(SAVE_ERROR[body?.error] ?? "Couldn't save that change");
      }
    } catch {
      undo();
      toast.error("Couldn't save that change");
    }
  };

  // Upcoming highlights.
  const now = Date.now();
  // Next interaction = the next SCHEDULED meeting. Prefer the meetings feed (getMeetings
  // reads the meeting-scheduled observations directly and is reliable), and fall back to
  // a future meeting sitting in the raw activity feed.
  const nextMeetingRow = [...(tasks.meetings ?? [])]
    .filter((m: any) => m.status !== "cancelled" && m.when && new Date(m.when).getTime() > now)
    .sort((a: any, b: any) => new Date(a.when).getTime() - new Date(b.when).getTime())[0] || null;
  const nextMeetingAct = acts
    .filter((a: any) => /meeting/.test((a.activity_type || "").toLowerCase()) && (a.occurred_at || a.created_at) && new Date(a.occurred_at || a.created_at).getTime() > now)
    .sort((x: any, y: any) => new Date(x.occurred_at || x.created_at).getTime() - new Date(y.occurred_at || y.created_at).getTime())[0] || null;
  const nextInteraction = nextMeetingRow
    ? { when: nextMeetingRow.when as string, label: nextMeetingRow.title || "Meeting" }
    : nextMeetingAct
      ? { when: (nextMeetingAct.occurred_at || nextMeetingAct.created_at) as string, label: nextMeetingAct.title || nextMeetingAct.description || "Meeting" }
      : null;
  const nextTask = [...tasks.open].filter(t => t.due_at).sort((a, b) => new Date(a.due_at).getTime() - new Date(b.due_at).getTime())[0] || tasks.open[0] || null;

  const TABS: RecordTab<Tab>[] = [
    { id: "overview", label: "Overview" },
    { id: "activity", label: "Activity", count: acts.length },
    ...(tasksOn ? [{ id: "tasks" as const, label: "Tasks", count: tasksState === "ready" ? tasks.open.length : undefined }] : []),
    { id: "pages", label: "Pages", count: documents.length },
    { id: "intel", label: "Intel", count: intelCount },
  ];

  // The record's two panes, as the account and the deal draw them (record/RecordLayout).
  return (
    <RecordShell
      left={
        <>
          <div className="px-5 pb-[18px] pt-5">
            <div className="flex min-w-0 items-center gap-3">
              {/* Real photo when we have one (sync/enrichment); otherwise Gravatar from the
                  email (hashed, no Unipile needed); otherwise initials. */}
              <EntityAvatar
                kind="person" name={name} email={c.email}
                photoUrl={c.photo_url || c.avatar_url || c.profile_picture_url}
                className="h-9 w-9 flex-shrink-0 rounded-full"
                textClassName="text-[13px] font-semibold text-muted-foreground"
              />
              {/* Tier is NOT shown next to the name: it sits in the ICP row of the record below. */}
              <div className="min-w-0">
                <h1 className="truncate text-[18px] font-semibold tracking-[-0.015em] text-foreground">{name}</h1>
                {/* "Not in CRM" (GET-788): a CRM is connected and no record there is linked to this
                    person — a meeting note-taker created them. The API sends null without a CRM. */}
                {/* "User" (GET-751): PostHog says they used the product in the last 30 days. */}
                {(title || c.in_crm === false || usage?.user) && (
                  <div className="truncate text-[12px] text-muted-foreground/70">
                    {title}
                    {c.in_crm === false && <span className="text-muted-foreground/55">{title ? " · " : ""}Not in CRM</span>}
                    {usage?.user && (
                      <span className="text-muted-foreground/55" title={usageTitle(usage)}>
                        {title || c.in_crm === false ? " · " : ""}User
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* The account this person belongs to; click to open it. */}
          {company?.name && (
            <PaneSection title="Account">
              <PaneItem onClick={c.company_id ? () => onOpenCompany(c.company_id) : undefined}>
                <AccountLogo name={company.name} domain={company.domain ?? null} size={24} className="rounded-md" />
                <ListText title={company.name} sub={company.industry || company.domain || undefined} />
              </PaneItem>
            </PaneSection>
          )}

          {/* pipeline_stage goes in normalized so the Stage select finds its option — the
              raw row may still be on a legacy stage. */}
          <PaneSection>
            <RecordOverview recordOnly contact={{ ...c, pipeline_stage: stage }} company={company} prediction={prediction} activities={acts} pipelineStages={STAGES} onPatch={patchContact} />
          </PaneSection>
        </>
      }
    >
      <RecordTabs<Tab> tabs={TABS} value={tab} onChange={setTab} label="Person tabs" />
      <TabBody>
        {tab === "activity" ? <ActivityFeed acts={acts} />
          : tab === "tasks" ? (
              <>
                <TaskList
                  state={tasksState}
                  sections={taskSections(tasks.open, tasks.done)}
                  empty="No tasks for this person"
                  onToggle={toggleTask}
                  onAdd={token && wsId ? () => setCreatingTask(true) : undefined}
                  recordName={company?.name ?? name} recordDomain={company?.domain ?? null}
                />
                {token && wsId && (
                  // A task typed here hangs on this person: the API files one on a person as on a
                  // company, so it shows on their page and, through their account, on the account's.
                  <NewTaskDialog open={creatingTask} onOpenChange={setCreatingTask} token={token} workspaceId={wsId}
                    meId={meId} meName={(userData as any)?.user?.name ?? null}
                    accounts={[{ id: c.id, name, kind: "person", photoUrl: c.photo_url || c.avatar_url || c.profile_picture_url || null }]}
                    onCreated={(task, created) => { if (created) setTasks(t => ({ ...t, open: [task, ...t.open.filter(x => x.id !== task.id)] })); }} />
                )}
              </>
            )
          : tab === "pages" ? <PagesPanel documents={otherDocs} meetings={meetingDocs} />
          // One Intel for every record (GET-793): the account's and the deal's board.
          // One Intel for every record (GET-805): Current state, then Headwinds / Tailwinds / About.
          : tab === "intel" ? <IntelOverview facts={facts} nameOf={id => (id === c.id ? name : null)}
              companyId={c.company_id ?? null} empty="No intel on this person yet" />
          : (
            <div className="min-w-0 space-y-4">
              <TileStrip cols={2}>
                <Tile label="Next interaction"
                  value={nextInteraction ? relTime(nextInteraction.when) : "None scheduled"}
                  sub={nextInteraction?.label ?? undefined} />
                {tasksOn && <Tile label="Next due task" onClick={nextTask ? () => setTab("tasks") : undefined}
                  value={tasksState === "loading" ? "…" : nextTask ? (nextTask.title || "Task") : "Nothing due"}
                  sub={nextTask?.due_phrase ?? undefined} />}
              </TileStrip>
              <ListCard className="min-w-0">
                <ListHeader title="Summary" />
                {c.memory_summary
                  ? <p className="px-2 pb-1.5 text-[13px] leading-[1.6] text-foreground [overflow-wrap:anywhere]">{c.memory_summary}</p>
                  : <ListEmpty>No summary yet</ListEmpty>}
              </ListCard>
              <ListCard className="min-w-0 px-4 pb-4 pt-3">
                <ActivityYear acts={acts} />
              </ListCard>
            </div>
          )}
      </TabBody>
    </RecordShell>
  );
}

/**
 * Everything written about this person: their documents, and their meeting summaries kept apart
 * because there are far more of the latter and a brief buried under them is a brief nobody finds.
 * The same shape the account page uses, for the same reason (GET-349).
 */
function PagesPanel({ documents, meetings }: { documents: any[]; meetings: any[] }) {
  if (!documents.length && !meetings.length) return <EmptyState title="No pages about this person yet" />;
  return (
    <ListCard>
      {documents.length > 0 && (
        <>
          <SectionLabel label="Documents" count={documents.length} />
          <MeetingsPanel docs={documents} />
        </>
      )}
      {meetings.length > 0 && (
        <>
          <SectionLabel label="Meetings" count={meetings.length} />
          <MeetingsPanel docs={meetings} />
        </>
      )}
    </ListCard>
  );
}

function MeetingsPanel({ docs }: { docs: any[] }) {
  return (
    <>
      {docs.map((m: any) => {
        const logo = toolLogo(m.source ?? m.metadata?.source) ?? toolLogo(toolOfRef(m.metadata?.source_ref ?? m.metadata?.source_url));
        return (
          <button key={m.id} type="button" onClick={() => window.open(`/note/${m.id}`, "_blank")} className={listRowClass}>
            <ListTile>{logo ? <img src={logo} alt="" className="h-3.5 w-3.5 object-contain" /> : <FileText className="h-[13px] w-[13px]" strokeWidth={1.75} />}</ListTile>
            <ListText title={m.metadata?.title || "Meeting"} />
            <ListMeta>{when(m.metadata?.date || m.created_at)}</ListMeta>
          </button>
        );
      })}
    </>
  );
}
