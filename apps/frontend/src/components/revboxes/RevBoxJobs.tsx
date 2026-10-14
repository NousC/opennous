// The RevBox Jobs list (GET-868). A box's jobs are workflow-engine routines (agent_routines with
// revbox_id) made by the Job Builder, plus any legacy revbox_jobs rows until those are removed.
// Each row: name, trigger, on/off, last run, an On/Off switch (approving a job switches it on; the
// switch pauses it) and Edit (reopens the chat that made the job). Legacy rows carry `plan` and
// cannot be reopened in the builder.
import { Link2, Loader2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { when } from '@/lib/format';
import { routineTriggerLabel, SIGNAL_CHOICES, type RevBoxJob, type RevBoxRoutine } from '@/lib/revboxes';

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

export function RevBoxJobs({ rows, runs, editable, busy, fresh, onNew, onToggle, onChange, onWebhookKey }: {
  rows: JobRow[]; runs: RunLite[]; editable: boolean; busy: string | null;
  /** The job the builder just created or changed: highlighted for a moment. */
  fresh: string | null;
  onNew: () => void; onToggle: (row: JobRow) => void;
  onChange: (row: JobRow) => void; onWebhookKey: (row: JobRow) => void;
}) {
  if (!rows.length) return <div className="mx-auto max-w-md py-14 text-center">
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
  </ul>;
}
