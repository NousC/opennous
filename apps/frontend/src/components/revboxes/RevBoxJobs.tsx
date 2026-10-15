// The RevBox Jobs list (GET-868). A box's jobs are workflow-engine routines (agent_routines with
// revbox_id) made by the Job Builder, plus any legacy revbox_jobs rows until those are removed.
// Each row: name, trigger, on/off, last run and an On/Off switch (approving a job switches it on; the
// switch pauses it). Clicking a builder job's row (or Enter/Space on it: the row's main area is a
// button) opens the job's chat, the person's own conversation on it (GET-889; there is no Edit
// button). Legacy rows carry `plan` and cannot be opened in the builder. Built-in jobs (GET-872)
// follow as the same compact row as a routine (GET-902): the dot, the name, "Starts · On · Last run"
// (its last draft), no Test and no switch (its On/Off is the workspace's, read-only here); what it
// did lately is the row's tooltip. Clicking one opens the job chat, like any job (JobBuilder with
// `builtin`): its card (BuiltinCard: the name with ● On/Off, the server's sentence, core
// builtinJobBrief, and Starts · tool logos → Priorities) is the agent's first message; the agent explains it,
// changes what can change (its email voice, its On/Off where allowed) and builds a custom job in the
// box for what it cannot do. There is no remove control: an invisible hover X here is how a built-in
// fell out of its box (GET-897). Test
import { Link2, Loader2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { when } from '@/lib/format';
import { routineTriggerLabel, SIGNAL_CHOICES, TOOL_NAMES, type BoxBuiltinJob, type RevBoxJob, type RevBoxRoutine, type SlackStatus } from '@/lib/revboxes';
import { SlackStatusLine } from '@/components/revboxes/SlackStatusLine';
import { builtinRowMeta, builtinState, builtinTooltip } from '@/lib/builtinJobs';
import { Logo } from '@/components/revboxes/WorkflowCard';

export type JobRow = { id: string; name: string; trigger: string; enabled: boolean; lastRunAt: string | null; routine: boolean; webhook: boolean;
  /** Why its Slack posts fail now (GET-901), from the server; shown as one line under the row. */
  slack?: SlackStatus | null };
type RunLite = { job_id: string; state?: string | null; status?: string | null; created_at: string };
/** A run's state; a row that only carries the engine's `status` still reads. */
const runState = (r: RunLite | undefined) => r ? String(r.state ?? (r.status === 'error' ? 'failed' : r.status) ?? '') : '';

/** One list from whatever the box detail carries: legacy jobs (with `plan`), routine rows mixed
 *  into `jobs`, or routines under their own key. */
export function jobRows(jobs: (RevBoxJob | RevBoxRoutine)[], routines: RevBoxRoutine[] = []): JobRow[] {
  const seen = new Set<string>();
  const rows: JobRow[] = [];
  for (const j of [...jobs, ...routines]) {
    if (seen.has(j.id)) continue;
    seen.add(j.id);
    if ('plan' in j && j.plan) {
      const t = j.plan.trigger;
      const trigger = t.kind === 'clock' ? `${t.weekdays_only ? 'Weekdays' : t.frequency === 'daily' ? 'Every day' : `Every ${t.frequency.replace(/ly$/, '')}`} at ${t.at}` : t.kind === 'webhook_in' ? 'Webhook event' : t.kind === 'manual' ? 'Run by hand' : SIGNAL_CHOICES.find(([k]) => k === t.kind)?.[1] ?? t.kind;
      rows.push({ id: j.id, name: j.name, trigger, enabled: !!j.enabled, lastRunAt: null, routine: false, webhook: t.kind === 'webhook_in' });
    } else {
      const r = j as RevBoxRoutine;
      rows.push({ id: r.id, name: r.name, trigger: routineTriggerLabel(r), enabled: !!r.enabled, lastRunAt: r.last_run_at ?? null, routine: true, webhook: r.trigger_kind === 'webhook_in', slack: r.slack_status ?? null });
    }
  }
  return rows;
}

export function RevBoxJobs({ rows, runs, editable, busy, fresh, onNew, onToggle, onChange, onTest, onWebhookKey, builtins = [], onOpenBuiltin }: {
  rows: JobRow[]; runs: RunLite[]; editable: boolean; busy: string | null;
  /** The built-in jobs this box holds (GET-872), as job rows (GET-902); a click opens the job chat. */
  builtins?: BoxBuiltinJob[]; onOpenBuiltin?: (job: BoxBuiltinJob) => void;
  /** The job the builder just created or changed: highlighted for a moment. */
  fresh: string | null;
  onNew: () => void; onToggle: (row: JobRow) => void;
  /** Open the job's chat (a click on its row). */
  onChange: (row: JobRow) => void; onWebhookKey: (row: JobRow) => void;
  /** Test the job once now with its sends held (builder jobs only). */
  onTest?: (row: JobRow) => void;
}) {
  if (!rows.length && !builtins.length) return <div className="mx-auto max-w-md py-14 text-center">
    <h2 className="text-[15px] font-medium">No jobs yet</h2>
    <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted-foreground">Describe the work you want done. The builder checks your tools, asks what it needs, and proposes the job for you to approve.</p>
    {editable && <Button size="sm" className="mt-4" onClick={onNew}><Plus />New job</Button>}
  </div>;
  return <ul className="divide-y divide-hairline">
    {rows.map(row => {
      const latest = (runs ?? []).find(r => r?.job_id === row.id);
      const working = runState(latest) === 'queued' || runState(latest) === 'running';
      const failed = runState(latest) === 'failed';
      const last = latest?.created_at ?? row.lastRunAt;
      const isFresh = fresh === row.id;
      const acting = busy === row.id;
      const opens = editable && row.routine;
      const info = <>
        <span className={cn('h-2 w-2 shrink-0 rounded-full', working ? 'animate-pulse bg-emerald-600' : failed ? 'bg-risk' : row.enabled ? 'bg-emerald-600' : 'bg-muted-foreground/35')} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-foreground">{row.name}</span>
          <span className="mt-0.5 block truncate text-[11.5px] text-muted-foreground">
            {row.trigger} · {row.enabled ? 'On' : 'Off'} · {working ? 'Running now' : failed ? `Last run failed ${when(latest!.created_at)}` : last ? `Last run ${when(last)}` : 'Not run yet'}
          </span>
        </span>
      </>;
      // The row opens the chat: a click anywhere on it (the actions stop theirs), or the main area as a button.
      return <li key={row.id} onClick={opens && !acting ? () => onChange(row) : undefined}
        className={cn('group flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl px-2 py-1.5 transition-colors', isFresh ? 'bg-hover' : 'hover:bg-hover/60', opens && 'cursor-pointer')}>
        {opens
          ? <button type="button" aria-label={`Open ${row.name}'s chat`} disabled={acting}
              className="-mx-1 flex min-w-0 flex-1 items-center gap-4 rounded-lg px-1 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60">{info}</button>
          : <span className="flex min-w-0 flex-1 items-center gap-4 py-2">{info}</span>}
        {editable && <span className="flex shrink-0 items-center gap-1.5" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
          {acting && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          {row.routine && onTest && <Button size="sm" variant="ghost" title="Run it once now on real data. Nothing is sent: Slack, email, webhooks and HubSpot writes are held." aria-label={`Test ${row.name}`} className="h-7 text-[12px] text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100" disabled={acting || working} onClick={() => onTest(row)}>Test</Button>}
          {!row.routine && row.webhook && <Button size="sm" variant="ghost" className="h-7 text-[12px]" onClick={() => onWebhookKey(row)}><Link2 className="h-3 w-3" />Webhook key</Button>}
          <Switch aria-label={`${row.enabled ? 'Pause' : 'Switch on'} ${row.name}`} className="ml-1" checked={row.enabled} disabled={acting} onCheckedChange={() => onToggle(row)} />
        </span>}
        {/* Slack trouble (GET-901): its own line, outside the row's button, with the action. */}
        {row.slack && <div className="-mt-2 basis-full pb-1.5 pl-[25px]"><SlackStatusLine status={row.slack} /></div>}
      </li>;
    })}
    {/* Built-ins (GET-902): the same row as a routine's. No Test (OpenNous runs them) and no switch here
        (their On/Off is the workspace's, read-only on the row and changed in the chat where allowed). */}
    {builtins.map(b => {
      const info = <>
        <span className={cn('h-2 w-2 shrink-0 rounded-full', b.enabled ? 'bg-emerald-600' : 'bg-muted-foreground/35')} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-foreground">{b.name}</span>
          <span className="mt-0.5 block truncate text-[11.5px] text-muted-foreground">{builtinRowMeta(b, when)}</span>
        </span>
      </>;
      const opens = editable && !!onOpenBuiltin;
      return <li key={b.key} title={builtinTooltip(b, when)} onClick={opens ? () => onOpenBuiltin!(b) : undefined}
        className={cn('group flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl px-2 py-1.5 transition-colors hover:bg-hover/60', opens && 'cursor-pointer')}>
        {opens
          ? <button type="button" aria-label={`Open ${b.name}'s chat`} onClick={e => { e.stopPropagation(); onOpenBuiltin!(b); }}
              className="-mx-1 flex min-w-0 flex-1 items-center gap-4 rounded-lg px-1 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60">{info}</button>
          : <span className="flex min-w-0 flex-1 items-center gap-4 py-2">{info}</span>}
      </li>;
    })}
  </ul>;
}

const toolName = (t: string) => TOOL_NAMES[t] ?? t.charAt(0).toUpperCase() + t.slice(1);

/** The one meta line, as a job card's: Starts · tool logos → where its work lands. */
function BuiltinMeta({ job }: { job: BoxBuiltinJob }) {
  const tools = job.brief?.tools ?? [];
  const starts = job.brief?.starts ?? job.cadence;
  const lands = job.brief?.lands ?? 'Priorities';
  return <p className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] leading-5 text-muted-foreground">
    <span className="sr-only">{`Starts: ${starts}. ${tools.length ? `Uses ${tools.map(toolName).join(', ')}. ` : ''}Lands in ${lands}.`}</span>
    <span aria-hidden>{starts}</span>
    <span aria-hidden className="text-muted-foreground/50">·</span>
    {tools.length > 0 && <span aria-hidden className="inline-flex items-center gap-1">{tools.map(t => <span key={t} title={toolName(t)} className="flex h-3.5 w-3.5 items-center justify-center [&>img]:h-3.5 [&>img]:w-3.5"><Logo tool={t} /></span>)}</span>}
    {tools.length > 0 && <span aria-hidden>→</span>}
    <span aria-hidden className="text-ink-2">{lands}</span>
  </p>;
}

/**
 * A built-in job's card (GET-902), a job card like WorkflowCard's approved one: the name with "● On"
 * or "● Off" (the workspace's real switch; nothing when unknown), the server's sentence and the meta
 * line. What it did lately is the tooltip. The job chat shows it as its first message; `onOpen`
 * (unused in the list, which shows rows) makes it a button.
 */
export function BuiltinCard({ job, onOpen }: { job: BoxBuiltinJob; onOpen?: (job: BoxBuiltinJob) => void }) {
  const state = builtinState(job.enabled);
  const body = <>
    <header className="flex items-center gap-3">
      <span className="min-w-0 flex-1 truncate py-0.5 text-[14px] font-medium tracking-[-0.005em] text-foreground">{job.name}</span>
      {state && <span className="inline-flex shrink-0 items-center gap-1.5 text-[11.5px] text-muted-foreground"><span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', state === 'On' ? 'bg-emerald-600' : 'bg-muted-foreground/40')} />{state}</span>}
    </header>
    <p className="mt-1 text-[13px] leading-[1.5] text-ink-2">{job.brief?.text ?? job.does}</p>
    <BuiltinMeta job={job} />
  </>;
  const look = 'block w-full rounded-xl border border-hairline bg-card px-4 py-3 text-left';
  const tip = builtinTooltip(job, when);
  return onOpen
    ? <button type="button" title={tip} aria-label={`Open ${job.name}'s chat`} onClick={() => onOpen(job)} className={cn(look, 'transition-colors hover:bg-hover/50 outline-none focus-visible:ring-2 focus-visible:ring-ring/60')}>{body}</button>
    : <section title={tip} aria-label={`Job: ${job.name}`} className={look}>{body}</section>;
}
