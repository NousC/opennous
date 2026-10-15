import { PREVIEW } from '@/lib/preview';
import { freshAccessToken } from '@/lib/freshToken';

export type Scope = { mode: 'selected' | 'all' | 'won' | 'lost' | 'icp'; account_ids: string[]; min_icp: number };
export type ContextBlock = { id: string; title: string; body: string };
// A box destination (GET-868). Email: `target` is the recipients ("a@x, b@y"), sent from OpenNous.
// Gmail: `target` is the mailbox id (one of the saver's own), `to` the recipients; a draft only, never
// sent. `mailbox_email` is set by the server.
/**
 * A box destination. Slack: `target` the channel id, `channel` its name (older ones: a name in
 * `target`). Email (sent from OpenNous): `to` and `cc`, with `target` mirroring `to`. Gmail draft:
 * `target` the mailbox id, `to` and `cc`. Recipients are "a@x, b@y" strings.
 */
export type Delivery = { id: string; kind: 'slack' | 'email' | 'gmail' | 'webhook'; target: string; to?: string; cc?: string; channel?: string; mailbox_email?: string | null; format?: string };
/** Where one of the box's jobs delivers on its own, from its real steps (server-derived, read-only). */
export type JobDelivery = {
  job_id: string; job_name: string | null; kind: 'slack' | 'email' | 'gmail' | 'webhook'; label: string; target: string;
  /** The step this target belongs to (GET-872): the rail's job-step dialog edits it in place. */
  step_id?: string | null; step_type?: string; editable?: boolean;
  channel_id?: string | null; channel?: string | null; to?: string; cc?: string; mailbox_id?: string | null;
};
const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
/** "a@x, b@y" as a list. */
export const recipients = (v: string | undefined | null) => String(v ?? '').split(/[,;]/).map(x => x.trim()).filter(Boolean);
/** The first recipient that is not an email address, or null. */
export const badRecipient = (v: string | undefined | null) => recipients(v).find(a => !EMAIL.test(a)) ?? null;
/** A box destination in words: "#cs-handoffs", "Email · to a@x", "Gmail draft · from me@ · to a@x", a URL. */
export function deliveryLabel(d: Delivery): string {
  const cc = recipients(d.cc).length ? `cc ${recipients(d.cc).join(', ')}` : null;
  if (d.kind === 'slack') return d.channel ? `#${d.channel.replace(/^#/, '')}` : d.target || 'Slack channel';
  if (d.kind === 'email') { const to = recipients(d.to ?? d.target); return to.length ? ['Email', `to ${to.join(', ')}`, cc].filter(Boolean).join(' · ') : 'Email'; }
  if (d.kind === 'gmail') return ['Gmail draft', d.mailbox_email && `from ${d.mailbox_email}`, recipients(d.to).length && `to ${recipients(d.to).join(', ')}`, cc].filter(Boolean).join(' · ');
  return d.target || 'Custom webhook';
}
export type RevBox = {
  id: string; name: string; objective: string; shared: boolean; owner_id: string;
  scope: Scope; blocks: ContextBlock[]; delivery: Delivery[]; revision: number;
  created_at: string; updated_at: string; access: 'owner' | 'editor' | 'viewer';
  members?: { user_id: string; role: 'editor' | 'viewer' }[];
  /** OpenNous built-in jobs this box lists (GET-872). Empty before the migration. */
  builtin_jobs?: BuiltinJobKey[];
};
/** The box's owner and members with their profile photo (GET-872). */
export type BoxPerson = { id: string; role: 'owner' | 'editor' | 'viewer'; name: string | null; email: string | null; avatar_url: string | null };
/** An account the box's jobs touched in their last 30 days of runs (GET-872). */

// ─── Built-in jobs (GET-872) ─────────────────────────────────────────────────────────────────
// The Workspace plan's default automations, run by OpenNous (detectors and the after-call
// follow-up), not by the workflow engine. A box can list each; each is in at most one box. Mirrors
// core REVBOX_BUILTIN_JOBS (packages/core/src/db/revboxes.mjs): keep the two in step.
export type BuiltinJobKey = 'sales_follow_up' | 'stale_deal' | 'deal_signals' | 'deal_risk' | 'expansion';
export const BUILTIN_JOBS: { key: BuiltinJobKey; name: string; does: string; cadence: string; tools: string[] }[] = [
  { key: 'sales_follow_up', name: 'Sales follow-up', does: 'After a meeting, the follow-up email is drafted and waiting to send.', cadence: 'After each call', tools: ['granola', 'gmail'] },
  { key: 'stale_deal', name: 'Stale deal detection', does: 'A deal goes quiet, and a follow-up is drafted for you.', cadence: 'Nightly', tools: ['hubspot', 'gmail'] },
  { key: 'deal_signals', name: 'Deal signals', does: 'A call raises an objection, a competitor, a buying signal or a departure, and the right follow-up is drafted for you.', cadence: 'Hourly', tools: ['agent', 'gmail'] },
  { key: 'deal_risk', name: 'Deal risk detection', does: 'An account turns at-risk, and a follow-up is drafted for you.', cadence: 'Nightly', tools: ['agent', 'gmail'] },
  { key: 'expansion', name: 'Expansion signals', does: 'An expansion signal shows, and a follow-up is drafted for you.', cadence: 'Nightly', tools: ['agent', 'gmail'] },
];
/** A built-in job as the box detail returns it: its definition and what it drafted lately. */
export type BoxBuiltinJob = { key: BuiltinJobKey; name: string; does: string; cadence: string; drafts_30d: number; last_draft_at: string | null };
export type JobPlan = {
  email?: {to:string;recipient_rule?:'meeting_attendees'|'address'};
  trigger: { kind: string; frequency: string; at: string; timezone: string; provider: string; signal_id?: string; weekdays_only?:boolean; day_of_week?:number;day_of_month?:number };
  tools: string[]; bindings?: Record<string, string>; steps: { id: string; type: string; label: string; detail: string }[];
  questions: string[]; compiler: string; execution_enabled: false;
};
export type RevBoxJob = { enabled?: boolean; id: string; name: string; prompt: string; plan: JobPlan; state: 'draft' | 'reviewed'; version: number; reviewed_at: string | null; snapshots: { version: number; reviewed_at: string }[] };
export type ContextKind = 'reference' | 'instructions' | 'icp';
export type ContextFile = { id: string; title: string; body: string; document_id: string | null; kind?: ContextKind };
// The workspace context library (GET-875): a file saved once and tagged to RevBoxes. `boxes` are the
// tags this viewer can see; `hidden_boxes` counts tags on boxes they cannot open.
export type LibraryFile = ContextFile & {
  kind: ContextKind; visibility: 'boxes' | 'workspace'; created_by: string; updated_at: string; icp_marked_at: string | null;
  boxes: { id: string; name: string; shared: boolean }[]; hidden_boxes: number; can_edit: boolean;
};
export type ContextLibraryData = {
  files: LibraryFile[]; icp_file_id: string | null; is_admin: boolean;
  boxes: { id: string; name: string; shared: boolean; access: 'owner' | 'editor' | 'viewer'; blocks: ContextBlock[] }[];
};
export const CONTEXT_KIND_LABEL: Record<ContextKind, string> = { reference: 'Reference', instructions: 'Instructions', icp: 'ICP' };
// jobs: legacy revbox_jobs rows (with `plan`) and, since GET-868, the box's engine routines; a
// server may also return the routines under their own key. The Jobs list reads both.
export type BoxDetail = {
  box: RevBox; context: ContextFile[]; jobs: (RevBoxJob | RevBoxRoutine)[]; routines?: RevBoxRoutine[]; job_deliveries?: JobDelivery[];
  people?: BoxPerson[];
  builtin_jobs?: BoxBuiltinJob[]; builtin_taken?: { key: BuiltinJobKey; box_id: string; box_name: string | null }[];
};
export type Account = { id: string; name: string; domain: string | null; icp_score: number | null; people_count: number; deal_count: number; won_deals: number; lost_deals: number; last_activity_at: string | null; latest_signal: { title: string; kind: string; at: string } | null };
export type Catalog = { accounts: Account[]; members: { id: string; name: string; email: string }[]; documents: { id: string; title: string }[]; connections: { id: string; slug: string; name: string; email: string | null }[] };

export async function revboxesRequest<T>(workspaceId: string, token: string, path = '', init: RequestInit = {}): Promise<T> {
  // A path may carry its own query (GET-874: ?cursor=&q=); workspaceId is added to it.
  const [route, own = ''] = path.split('?');
  const query = new URLSearchParams(own);
  query.set('workspaceId', workspaceId);
  const res = await fetch(`${import.meta.env.VITE_API_URL ?? ''}/api/revboxes${route}?${query}`, {
    ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await freshAccessToken() ?? token}`, ...(PREVIEW ? { 'X-Preview-User': localStorage.getItem('nous.preview.role') === 'member' ? 'u2' : 'u1' } : {}), ...init.headers },
  });
  const body = await res.json().catch(() => ({}));
  // status and code ride along so a caller can act on a specific refusal (GET-878: icp_scorer_switch_required).
  if (!res.ok) throw Object.assign(new Error(body.error ?? `Request failed (${res.status}).`), { status: res.status, code: typeof body.code === 'string' ? body.code : undefined });
  return body;
}

export const SIGNAL_CHOICES = [
  ['call_ended', 'Meeting completed'], ['deal_closed_won', 'Deal won'], ['deal_closed_lost', 'Deal lost'],
  ['deal_stage_changed', 'Deal stage changed'], ['account_signal', 'Account signal'], ['campaign_completed','Campaign completed'],
];
export const SCOPE_LABELS: Record<Scope['mode'], string> = { selected: 'Selected accounts', all: 'All accessible accounts', won: 'Closed-won deals', lost: 'Closed-lost deals', icp: 'ICP score' };
export const JOB_EXAMPLES = [
  { name: 'Meeting follow-ups', prompt: 'After every Granola meeting assigned to me, draft a follow-up in Gmail. Use the email voice and format in this RevBox. Do not send until I review it.' },
  { name: 'CS handoff', prompt: 'When a HubSpot deal is closed won, prepare an onboarding brief for customer success. Include the buying reason, promises and risks. Send it to the CS Handoffs Slack channel.' },
  { name: 'Daily revenue update', prompt: 'Every morning at 7am, read the latest business metrics for the accounts in this RevBox. Create a daily update in the format provided in Context and deliver it to Slack.' },
];

// ─── Job Builder (GET-868) ───────────────────────────────────────────────────────────────────
// The contract is docs/revboxes/JOB_BUILDER.md. A builder session is a chat with an agent whose
// only job is to set up this box's jobs: every user message runs one turn that streams events
// (SSE, `data: <json>\n\n`) and ends in plain text, an `ask`, or a `proposal`. Approving the
// proposal creates (or updates) a workflow-engine job, an agent_routines row with revbox_id.

/** One clarifying question. `header` is the short tab chip (≤12 chars). */
export type BuilderQuestion = { id: string; header: string; question: string; multi: boolean; options: { label: string; description?: string }[] };
/** What the AskCard sends back as the next user message. */
export type BuilderAnswer = { id: string; selected: string[]; other?: string };
export type ProposalWarning = { kind: 'missing_access' | 'missing_connection' | 'unverified' | 'cost' | string; message: string; fix?: { label: string; href: string } };
/**
 * What one real step touches, derived by the server from `steps` (core proposalFacts), never from
 * the model's `display`. The card shows `target` under the model's title, and `sends_to` (webhook
 * hosts, email recipients) on its own "Sends data to" line.
 */
export type ProposalFact = {
  step_id: string; type: string; target: string; external: boolean;
  action?: string; access?: 'read' | 'write';
  channel_id?: string; channel?: string | null; user_id?: string; user?: string | null;
  url?: string; host?: string | null; recipients?: string[]; mailbox?: string | null; mode?: string;
  object?: string | null; fields?: string[]; model?: string; job?: string | null;
  sends_to?: string[];
  /** A table step (GET-874): its key, the table's name (the box's, or the one this proposal creates), whether it is new. */
  dataset_key?: string | null; dataset?: string | null; new_dataset?: boolean; window?: string; dedupe_from?: string;
};
/** A table the proposal creates on approval (GET-874). */
export type ProposedDataset = { key?: string; name: string; description?: string; columns: { key?: string; label: string; type: string; options?: string[] }[] };
export type JobProposal = {
  name: string; summary: string;
  /** signal_key: the signal-catalog key the trigger came from ("schedule" for a clock job). A job on
   *  several signals (GET-873) lists them all in signal_keys (signal_key is the first). */
  trigger: { signal_key?: string; signal_keys?: string[]; kind: string; config: Record<string, unknown>; timezone?: string; label: string };
  /** Exactly the agent_routines.steps format; the card draws `display`, never these. */
  steps: { id: string; type: string; config?: Record<string, unknown> }[];
  display: { step_id: string; tool: string; title: string; detail?: string }[];
  /** Server-derived, one per step. Missing on older proposals: the card then falls back to the raw step. */
  facts?: ProposalFact[];
  uses_box_delivery: boolean;
  /** The Slack layout the box's Slack destinations get for this job (the agent picks it, GET-872). */
  box_delivery_format?: string | null;
  /** Tables created on approval, before the job, so its steps' dataset_key resolves (GET-874). */
  datasets?: ProposedDataset[];
  /** Jobs still to set up in this chat: after approval the chat goes on and proposes the next. */
  next_jobs?: string[];
  warnings: ProposalWarning[]; assumptions: string[];
  estimated_credits_per_run: number | null;
};
export type BuilderEvent =
  | { type: 'session'; session_id: string }
  | { type: 'status'; text: string }
  | { type: 'tool'; name: string; state: 'start' | 'done' | 'error'; summary?: string }
  | { type: 'text'; text: string }
  | { type: 'ask'; questions: BuilderQuestion[] }
  | { type: 'proposal'; proposal: JobProposal }
  | { type: 'credits'; credits: number }
  | { type: 'error'; message: string; code?: string }
  /** The agent picked or changed what starts the job ("after every meeting" -> meeting.done). */
  | { type: 'trigger'; signal: string | null; signals?: string[]; label?: string }
  /** The integrations the job will use, as the agent settled them (connection slugs). The composer
   *  attaches them like user picks, and they ride along as `hints.integrations` on the next turn. */
  | { type: 'integrations'; slugs: string[] }
  | { type: 'done' };
/** What the composer's Integrations and Signals pickers add to every builder message. */
export type BuilderHints = { integrations: string[]; signals: string[] };
/** A box job as the Jobs list shows it once jobs are engine routines (agent_routines.revbox_id).
 *  Legacy revbox_jobs rows carry `plan`; routine rows do not. */
export type RevBoxRoutine = {
  id: string; name: string; enabled: boolean; source?: 'routine';
  trigger_kind?: string; trigger_config?: Record<string, unknown> | null; timezone?: string | null;
  trigger_label?: string | null; last_run_at?: string | null; last_run_state?: string | null;
  steps?: { id: string; type: string }[]; version?: number;
};

function previewHeader(): Record<string, string> {
  return PREVIEW ? { 'X-Preview-User': localStorage.getItem('nous.preview.role') === 'member' ? 'u2' : 'u1' } : {};
}

/**
 * Runs one builder turn: POST and read the event stream until it closes. A new session is
 * POST /api/revboxes/:id/builder (body `{ message, job_id? }`, first event `session`); a later turn
 * POSTs to /builder/:sessionId with `{ message }` or `{ answers }`. Abort with `signal` (Stop).
 * A non-2xx answer (402 out of credits, 403, 404) arrives as one `error` event, so the caller has
 * one path for every failure.
 */
export async function streamBuilderTurn(opts: {
  workspaceId: string; token: string; boxId: string; sessionId: string | null;
  body: ({ message: string; job_id?: string | null } | { answers: BuilderAnswer[] }) & { hints?: BuilderHints };
  signal?: AbortSignal; onEvent: (event: BuilderEvent) => void;
}): Promise<void> {
  const { workspaceId, token, boxId, sessionId, body, signal, onEvent } = opts;
  const query = new URLSearchParams({ workspaceId });
  const res = await fetch(`${import.meta.env.VITE_API_URL ?? ''}/api/revboxes/${boxId}/builder${sessionId ? `/${sessionId}` : ''}?${query}`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${await freshAccessToken() ?? token}`, ...previewHeader() },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({}));
    onEvent({ type: 'error', message: err.message ?? err.error ?? `The builder could not start (${res.status}).`, code: err.code ?? (res.status === 402 ? 'insufficient_credits' : undefined) });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // SSE frames are separated by a blank line; a frame may carry several data lines.
  const flush = (frame: string) => {
    const data = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data) return;
    try { onEvent(JSON.parse(data) as BuilderEvent); } catch { /* a malformed frame is skipped, never fatal */ }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      frames.forEach(flush);
    }
    if (buffer.trim()) flush(buffer);
  } finally { reader.releaseLock(); }
}

/** What approving answers: the routine, whether it was switched on, and why not when it was not. */
export type ApproveResult = {
  routine: RevBoxRoutine; enabled?: boolean; reason?: string;
  /** The tables approve created or reused (GET-874). */
  datasets?: { key: string; name: string; created: boolean }[];
  /** Chaining: the session the chat goes on in for the next job, and the jobs still to set up. */
  next_session_id?: string; next_jobs?: string[];
};
/** Approve the session's latest proposal: creates or updates the routine and switches it on (or says why not). */
export function approveBuilderProposal(workspaceId: string, token: string, boxId: string, sessionId: string, name?: string) {
  return revboxesRequest<ApproveResult>(workspaceId, token, `/${boxId}/builder/${sessionId}/approve`, { method: 'POST', body: JSON.stringify(name ? { name } : {}) });
}

/** One item of a job's earlier chat, as the server derives it from the transcript (Edit). */
export type BuilderHistoryText = { role: 'user' | 'assistant'; text: string };
export type BuilderHistoryAsk = { kind: 'ask'; questions: BuilderQuestion[]; answers: { question: string; answer: string }[] };
export type BuilderHistoryProposal = { kind: 'proposal'; proposal: JobProposal; approved: boolean };
export type BuilderHistoryItem = BuilderHistoryText | BuilderHistoryAsk | BuilderHistoryProposal;
/**
 * Edit on a job: POST /api/revboxes/:id/builder with `{ job_id }` and no message opens a new session
 * on the job, seeded with the chat that made it (JSON, no stream). Continue it with streamBuilderTurn.
 */
export function openBuilderForJob(workspaceId: string, token: string, boxId: string, jobId: string) {
  return revboxesRequest<{ session_id: string; job_id: string; history: BuilderHistoryItem[]; proposal: JobProposal | null }>(workspaceId, token, `/${boxId}/builder`, { method: 'POST', body: JSON.stringify({ job_id: jobId }) });
}

/** "Every day at 08:00 (Toronto)" from a routine row when the server did not label it. */
export function routineTriggerLabel(job: RevBoxRoutine): string {
  if (job.trigger_label) return job.trigger_label;
  const c = (job.trigger_config ?? {}) as { frequency?: string; at?: string };
  const city = job.timezone?.split('/').pop()?.replace(/_/g, ' ');
  if (job.trigger_kind === 'clock') return `${c.frequency === 'weekly' ? 'Every week' : c.frequency === 'monthly' ? 'Every month' : 'Every day'}${c.at ? ` at ${c.at}` : ''}${city ? ` (${city})` : ''}`;
  if (job.trigger_kind === 'manual' || !job.trigger_kind) return 'Run by hand';
  return SIGNAL_CHOICES.find(([k]) => k === job.trigger_kind)?.[1] ?? job.trigger_kind.replace(/_/g, ' ');
}

/** Display name for a tool slug in builder rows and cards. */
export const TOOL_NAMES: Record<string, string> = { hubspot: 'HubSpot', slack: 'Slack', gmail: 'Gmail', granola: 'Granola', fireflies: 'Fireflies', fathom: 'Fathom', attio: 'Attio', instantly: 'Instantly', agent: 'OpenNous', revbox_delivery: 'RevBox delivery', webhook: 'Webhook', dataset_append: 'Add to table', dataset_read: 'Read table' };

// ─── Signals (GET-862) ───────────────────────────────────────────────────────────────────────
// What can start a job: the catalog (core signalCatalog) and the workspace's own signals, at
// /api/signals. A key is stable: `meeting.done` (or `meeting.done:granola`), `deal.won`,
// `signal.churn_risk`, `schedule`, `custom.<key>`. No signal = a scheduled job.
export type SignalGroup = 'meetings' | 'deals' | 'account' | 'schedule' | 'custom';
export type SignalEntry = {
  key: string; label: string; description: string; group: SignalGroup;
  providers?: string[]; needs_config?: boolean; trigger: { kind: string; config: Record<string, unknown> };
  id?: string; active?: boolean; version?: number; sources?: string[];
};
export type SignalCatalog = { builtin: SignalEntry[]; custom: SignalEntry[]; groups?: { id: SignalGroup; label: string }[] };
export type WorkspaceSignal = {
  id: string; key: string; name: string; rule: string; examples: string; sources: string[];
  owner_id: string; revbox_id: string | null; active: boolean; version: number;
  archived: boolean; archived_at: string | null; hits?: number; updated_at?: string;
};
export const SIGNAL_GROUP_LABEL: Record<SignalGroup, string> = { meetings: 'Meetings', deals: 'Deals', account: 'Account signals', schedule: 'Schedule', custom: 'Your signals' };
export const MEETING_PROVIDER_LABEL: Record<string, string> = { granola: 'Granola', fireflies: 'Fireflies', fathom: 'Fathom', any: 'Any recorder' };

export async function signalsRequest<T>(workspaceId: string, token: string, path = '', init: RequestInit = {}): Promise<T> {
  const query = new URLSearchParams({ workspaceId });
  const res = await fetch(`${import.meta.env.VITE_API_URL ?? ''}/api/signals${path}?${query}`, {
    ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await freshAccessToken() ?? token}`, ...previewHeader(), ...init.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status}).`);
  return body;
}

/** "Meeting done · Granola" for a key, from the catalog; null when it does not know the key. */
export function signalKeyLabel(key: string | null, catalog?: SignalCatalog | null): string | null {
  if (!key) return null;
  const [base, provider] = key.split(':');
  const entry = [...(catalog?.builtin ?? []), ...(catalog?.custom ?? [])].find(e => e.key === base);
  if (!entry) return null;
  return provider && provider !== 'any' ? `${entry.label} · ${MEETING_PROVIDER_LABEL[provider] ?? provider}` : entry.label;
}

// ── Datasets (GET-874): the tables a box's jobs keep ──────────────────────────────────────────
export type DatasetColumnType = 'text' | 'number' | 'date' | 'boolean' | 'enum';
export type DatasetColumn = { key: string; label: string; type: DatasetColumnType; options?: string[]; description?: string };
export type RevBoxDataset = {
  id: string; revbox_id: string; key: string; name: string; description: string; columns: DatasetColumn[];
  created_at: string | null; updated_at: string | null; row_count?: number; row_count_capped?: boolean; last_added_at?: string | null;
};
export type DatasetRow = { id: string; data: Record<string, string | number | boolean | null>; entity_id: string | null; source_run_id: string | null; source_job_id: string | null; created_at: string };
export type DatasetRowsPage = { dataset: RevBoxDataset; rows: DatasetRow[]; next_cursor: string | null };

/** Download the dataset's visible rows as CSV (the API sets the file name). */
export async function downloadDatasetCsv(workspaceId: string, token: string, boxId: string, key: string, q = ''): Promise<void> {
  const query = new URLSearchParams({ workspaceId, ...(q.trim() ? { q: q.trim() } : {}) });
  const res = await fetch(`${import.meta.env.VITE_API_URL ?? ''}/api/revboxes/${boxId}/datasets/${encodeURIComponent(key)}/export.csv?${query}`, {
    headers: { Authorization: `Bearer ${await freshAccessToken() ?? token}`, ...previewHeader() },
  });
  if (!res.ok) { const body = await res.json().catch(() => ({})); throw new Error(body.error ?? `Export failed (${res.status}).`); }
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? `${key}.csv`;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
