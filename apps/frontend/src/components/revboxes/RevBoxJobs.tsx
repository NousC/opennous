// The RevBox Jobs list (GET-868). A box's jobs are workflow-engine routines (agent_routines with
// revbox_id) made by the Job Builder, plus any legacy revbox_jobs rows until those are removed.
// Each row: name, trigger, on/off, last run, an On/Off switch (approving a job switches it on; the
// switch pauses it) and Edit (reopens the chat that made the job). Legacy rows carry `plan` and
// cannot be reopened in the builder. Built-in jobs (GET-872) follow as read-only rows: OpenNous
// runs them (detectors, the after-call follow-up), so there is no Edit and no switch; the row says
// how often it runs and what it drafted lately, with "See drafts" opening Priorities. Removing one
// from the box only takes it off this list; it keeps running.
import { Link2, Loader2, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { when } from '@/lib/format';
import { routineTriggerLabel, SIGNAL_CHOICES, BUILTIN_JOBS, type BoxBuiltinJob, type RevBoxJob, type RevBoxRoutine } from '@/lib/revboxes';
import { Logo } from '@/components/revboxes/WorkflowCard';
import { OPEN_PRIORITIES } from '@/components/shell/PrioritiesButton';

export type JobRow = { id: string; name: string; trigger: string; enabled: boolean; lastRunAt: string | null; routine: boolean; webhook: boolean };
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
      rows.push({ id: r.id, name: r.name, trigger: routineTriggerLabel(r), enabled: !!r.enabled, lastRunAt: r.last_run_at ?? null, routine: true, webhook: r.trigger_kind === 'webhook_in' });
    }
  }
  return rows;
}

export function RevBoxJobs({ rows, runs, editable, busy, fresh, onNew, onToggle, onChange, onWebhookKey, builtins = [], onRemoveBuiltin }: {
  rows: JobRow[]; runs: RunLite[]; editable: boolean; busy: string | null;
  builtins?: BoxBuiltinJob[]; onRemoveBuiltin?: (key: string) => void;
  /** The job the builder just created or changed: highlighted for a moment. */
  fresh: string | null;
  onNew: () => void; onToggle: (row: JobRow) => void;
  onChange: (row: JobRow) => void; onWebhookKey: (row: JobRow) => void;
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
      return <li key={row.id} className={cn('flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl px-2 py-3.5 transition-colors', isFresh ? 'bg-hover' : 'hover:bg-hover/60')}>
        <span className={cn('h-2 w-2 shrink-0 rounded-full', working ? 'animate-pulse bg-emerald-600' : failed ? 'bg-risk' : row.enabled ? 'bg-emerald-600' : 'bg-muted-foreground/35')} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-foreground">{row.name}</span>
          <span className="mt-0.5 block truncate text-[11.5px] text-muted-foreground">
            {row.trigger} · {row.enabled ? 'On' : 'Off'} · {working ? 'Running now' : failed ? `Last run failed ${when(latest!.created_at)}` : last ? `Last run ${when(last)}` : 'Not run yet'}
          </span>
        </span>
        {editable && <span className="flex shrink-0 items-center gap-1.5">
          {acting && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          {row.routine && <Button size="sm" variant="ghost" className="h-7 text-[12px]" disabled={acting} onClick={() => onChange(row)}>Edit</Button>}
          {!row.routine && row.webhook && <Button size="sm" variant="ghost" className="h-7 text-[12px]" onClick={() => onWebhookKey(row)}><Link2 className="h-3 w-3" />Webhook key</Button>}
          <Switch aria-label={`${row.enabled ? 'Pause' : 'Switch on'} ${row.name}`} className="ml-1" checked={row.enabled} disabled={acting} onCheckedChange={() => onToggle(row)} />
        </span>}
      </li>;
    })}
    {builtins.map(b => <BuiltinRow key={b.key} job={b} editable={editable} onRemove={onRemoveBuiltin} />)}
  </ul>;
}

/** A built-in job: read-only. Its tool's logo, name, "Built-in · run by OpenNous · Nightly", and what it drafted. */
function BuiltinRow({ job, editable, onRemove }: { job: BoxBuiltinJob; editable: boolean; onRemove?: (key: string) => void }) {
  const tool = BUILTIN_JOBS.find(b => b.key === job.key)?.tools[0] ?? 'agent';
  const drafted = job.drafts_30d ? `${job.drafts_30d} ${job.drafts_30d === 1 ? 'draft' : 'drafts'} in 30 days${job.last_draft_at ? ` · last ${when(job.last_draft_at)}` : ''}` : 'No drafts in 30 days';
  return <li className="group flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl px-2 py-3.5 hover:bg-hover/60" title={job.does}>
    <span className="flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden><Logo tool={tool} /></span>
    <span className="min-w-0 flex-1">
      <span className="block truncate text-[13px] font-medium text-foreground">{job.name}</span>
      <span className="mt-0.5 block truncate text-[11.5px] text-muted-foreground">Built-in · run by OpenNous · {job.cadence} · {drafted}</span>
    </span>
    <span className="flex shrink-0 items-center gap-1.5">
      <Button size="sm" variant="ghost" className="h-7 text-[12px]" onClick={() => window.dispatchEvent(new Event(OPEN_PRIORITIES))}>See drafts</Button>
      {editable && onRemove && <button type="button" aria-label={`Remove ${job.name} from this box`} title="Remove from this box. It keeps running." onClick={() => onRemove(job.key)} className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"><X className="h-3.5 w-3.5" /></button>}
    </span>
  </li>;
}
