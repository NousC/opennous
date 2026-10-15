// The RevBox Jobs list (GET-868). A box's jobs are workflow-engine routines (agent_routines with
// revbox_id) made by the Job Builder, plus any legacy revbox_jobs rows until those are removed.
// Each row: name, trigger, on/off, last run and an On/Off switch (approving a job switches it on; the
// switch pauses it). Clicking a builder job's row (or Enter/Space on it: the row's main area is a
// button) opens the job's chat, the person's own conversation on it (GET-889; there is no Edit
// button). Legacy rows carry `plan` and cannot be opened in the builder. Built-in jobs (GET-872)
// follow as agent cards like the builder's (GET-897): name with a small "Built in" tag, the
// workspace's real On/Off (read-only: OpenNous runs them, detectors and the after-call follow-up,
// for the whole workspace, so there is no per-box switch), the server's sentence in the agent's
// voice (core builtinJobBrief), one meta line (Starts · tool logos → Priorities) and what it did in
// 30 days. Clicking one opens a read-only panel (BuiltinJobPanel), never a builder chat. There is no
// remove control: an invisible hover X here is how a built-in fell out of its box. Test
// (GET-873), on hover or focus of a builder job's row: one run now on real data with every external
// send held; the output and what it would have sent show in Results, labelled Test. Test and the
// switch never open the chat.
import { ArrowUpRight, Link2, Loader2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { when } from '@/lib/format';
import { routineTriggerLabel, SIGNAL_CHOICES, TOOL_NAMES, type BoxBuiltinJob, type RevBoxJob, type RevBoxRoutine } from '@/lib/revboxes';
import { builtinActivity, builtinState } from '@/lib/builtinJobs';
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

export function RevBoxJobs({ rows, runs, editable, busy, fresh, onNew, onToggle, onChange, onTest, onWebhookKey, builtins = [], onOpenBuiltin }: {
  rows: JobRow[]; runs: RunLite[]; editable: boolean; busy: string | null;
  /** The built-in jobs this box holds (GET-872), as agent cards (GET-897); a click opens the read-only panel. */
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
      </li>;
    })}
    {builtins.map(b => <li key={b.key} className="py-2"><BuiltinCard job={b} onOpen={onOpenBuiltin} /></li>)}
  </ul>;
}

const toolName = (t: string) => TOOL_NAMES[t] ?? t.charAt(0).toUpperCase() + t.slice(1);
const openPriorities = () => window.dispatchEvent(new Event(OPEN_PRIORITIES));

/** The one meta line: Starts · tool logos → where its work lands. */
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

/** The workspace's real On/Off for a built-in, read-only (a dot and the word), or nothing when unknown. */
function BuiltinOnOff({ enabled }: { enabled?: boolean | null }) {
  const state = builtinState(enabled);
  if (!state) return null;
  return <span title="OpenNous runs it for the whole workspace. It has no per-box switch." className="inline-flex shrink-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
    <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', state === 'On' ? 'bg-emerald-600' : 'bg-muted-foreground/40')} />{state}
  </span>;
}

/**
 * A built-in job as an agent card (GET-897), the builder's card in its saved form: name with a
 * "Built in" tag and its On/Off, the server's sentence, the meta line and what it did in 30 days
 * (opening Priorities). The card opens the read-only panel.
 */
function BuiltinCard({ job, onOpen }: { job: BoxBuiltinJob; onOpen?: (job: BoxBuiltinJob) => void }) {
  return <section aria-label={`Built-in job: ${job.name}`} onClick={onOpen ? () => onOpen(job) : undefined}
    className={cn('rounded-xl border border-hairline bg-card px-4 py-3 transition-colors', onOpen && 'cursor-pointer hover:bg-hover/50')}>
    <header className="flex items-center gap-2">
      {onOpen
        ? <button type="button" onClick={e => { e.stopPropagation(); onOpen(job); }} className="min-w-0 truncate rounded text-left text-[14px] font-medium tracking-[-0.005em] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/60">{job.name}</button>
        : <span className="min-w-0 truncate text-[14px] font-medium tracking-[-0.005em] text-foreground">{job.name}</span>}
      <span className="shrink-0 rounded-md bg-muted px-1.5 py-px text-[10.5px] text-muted-foreground">Built in</span>
      <span className="flex-1" />
      <BuiltinOnOff enabled={job.enabled} />
    </header>
    <p className="mt-1 text-[13px] leading-[1.5] text-ink-2">{job.brief?.text ?? job.does}</p>
    <BuiltinMeta job={job} />
    <p className="mt-1 flex items-center gap-1.5 text-[12px] text-muted-foreground">
      <span className="tabular-nums">{builtinActivity(job, when)}</span>
      <span aria-hidden className="text-muted-foreground/50">·</span>
      <button type="button" onClick={e => { e.stopPropagation(); openPriorities(); }} className="inline-flex items-center gap-0.5 font-medium text-foreground underline-offset-2 hover:underline">See in Priorities<ArrowUpRight className="h-3 w-3" /></button>
    </p>
  </section>;
}

/**
 * The read-only panel a built-in card opens (GET-897): what it does in the agent's words, the meta
 * line, how it works, whether it runs and what it did lately, and a link to its items. No builder
 * chat: OpenNous runs it, and it has nothing to configure per box.
 */
export function BuiltinJobPanel({ job, boxName, onClose }: { job: BoxBuiltinJob; boxName: string; onClose: () => void }) {
  const state = builtinState(job.enabled);
  return <div className="space-y-4">
    <div>
      <p className="text-[13.5px] leading-[1.55] text-foreground">{job.brief?.text ?? job.does}</p>
      <BuiltinMeta job={job} />
    </div>
    {!!job.brief?.details?.length && <ul className="space-y-1.5 text-[12.5px] leading-[1.5] text-ink-2">
      {job.brief.details.map(d => <li key={d} className="flex gap-2"><span aria-hidden className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-muted-foreground/60" />{d}</li>)}
    </ul>}
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-[12.5px]">
      <dt className="text-muted-foreground">Status</dt>
      <dd>{state ? `${state} for the whole workspace` : 'Run by OpenNous for the whole workspace'}{state === 'Off' ? '. Ask OpenNous to switch it on.' : ''}</dd>
      <dt className="text-muted-foreground">In this box</dt>
      <dd>Listed in {boxName}, so its work reads as this box's. It runs the same in any box.</dd>
      <dt className="text-muted-foreground">Lately</dt>
      <dd className="tabular-nums">{builtinActivity(job, when)}</dd>
    </dl>
    <Button size="sm" variant="outline" onClick={() => { onClose(); openPriorities(); }}>Open its items in Priorities<ArrowUpRight /></Button>
  </div>;
}
