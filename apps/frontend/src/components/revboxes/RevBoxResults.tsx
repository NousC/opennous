// The Results tab (GET-872): a compact list, one ~40px row per run, hairline separators, no cards.
// A row: a status dot (green completed, amber needs review, red failed, grey running), the JOB's
// name, the output's title muted, and on the right the relative time and credits in small tabular
// text. Clicking it opens the run inline: the output rendered as markdown (scrolls past ~60vh), why
// a failed run failed in words with its fix ("Slack isn't connected · Connect Slack"), deliveries
// as tiny lines, and actions only where they apply (Approve / Deny on a run waiting for review,
// Retry on a legacy run whose deliveries failed). Above the list: one compact row, a segmented
// filter (All · Needs review · Failed) and a job select when the box has more than one job.
//
// A row is a revbox_runs run or a workflow-engine routine run (kind 'routine'). The server maps both
// to this shape; every field is read defensively so one odd row cannot blank the tab.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Prose } from '@/components/AgentMarkdown';
import { revboxesRequest } from '@/lib/revboxes';
import { cn } from '@/lib/utils';
import { when } from '@/lib/format';

type Delivery = { id: string; state: string; error: string | null; destination?: { kind?: string; target?: string } | null };
type Failure = { text: string; fix: { label: string; href: string } | null };
type Run = {
  credits?: number; id: string; job_id: string; job_name?: string | null; kind?: string; state?: string | null; status?: string | null;
  created_at: string; error?: string | null; failure?: Failure | null;
  result?: { title?: string; body?: string; kind?: string } | null; deliveries?: Delivery[] | null;
};
type Filter = 'all' | 'review' | 'failed';
const FILTERS: { id: Filter; label: string }[] = [{ id: 'all', label: 'All' }, { id: 'review', label: 'Needs review' }, { id: 'failed', label: 'Failed' }];

const runState = (r: Run) => String(r.state ?? r.status ?? 'running');
const DOT: Record<string, string> = { completed: 'bg-emerald-500', needs_review: 'bg-amber-500', failed: 'bg-risk' };
const STATE_WORDS: Record<string, string> = { completed: 'Completed', needs_review: 'Needs review', failed: 'Failed', running: 'Running', queued: 'Queued', rejected: 'Denied' };
const KIND_WORDS: Record<string, string> = { slack: 'Slack', email: 'Email', gmail: 'Gmail draft', webhook: 'Webhook' };
const credits = (n?: number) => typeof n === 'number' && n > 0 ? `${n % 1 ? n.toFixed(1) : n} cr` : '';

export function RevBoxResults({ ws, token, boxId, editable, jobs }: { ws: string; token: string; boxId: string; editable: boolean; jobs: { id: string; name: string }[] }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [jobId, setJobId] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const query = useQuery({ queryKey: ['revbox-results', ws, boxId], queryFn: () => revboxesRequest<{ results: Run[] }>(ws, token, `/${boxId}/results`), refetchInterval: 5000 });
  const names = new Map(jobs.map(j => [j.id, j.name]));
  const runs = (query.data?.results ?? []).filter(r => (!jobId || r.job_id === jobId)
    && (filter === 'all' || (filter === 'review' && runState(r) === 'needs_review') || (filter === 'failed' && runState(r) === 'failed')));
  if (query.error) return <p role="alert" className="text-[12px] text-risk">{query.error.message}</p>;
  return <div>
    <div className="mb-2 flex items-center gap-3">
      <div role="radiogroup" aria-label="Show results" className="flex gap-0.5 rounded-lg bg-muted/70 p-0.5">
        {FILTERS.map(f => <button key={f.id} type="button" role="radio" aria-checked={filter === f.id} onClick={() => setFilter(f.id)}
          className={cn('rounded-md px-2.5 py-1 text-[12px] transition-colors', filter === f.id ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>{f.label}</button>)}
      </div>
      {jobs.length > 1 && <select aria-label="Filter results by job" value={jobId} onChange={e => setJobId(e.target.value)}
        className="ml-auto h-7 max-w-[220px] truncate rounded-md border border-border/70 bg-background px-2 text-[12px] text-muted-foreground outline-none focus:border-foreground/30">
        <option value="">All jobs</option>{jobs.map(j => <option key={j.id} value={j.id}>{j.name}</option>)}
      </select>}
    </div>
    {query.isLoading
      ? <p className="py-3 text-[12px] text-muted-foreground">Loading results…</p>
      : !runs.length
        ? <p className="py-3 text-[12.5px] text-muted-foreground">{filter === 'review' ? 'Nothing waiting for review.' : filter === 'failed' ? 'No failed runs.' : 'No results yet. Runs show up here as your jobs work.'}</p>
        : <ul className="divide-y divide-hairline border-y border-hairline">
          {runs.map(run => <ResultRow key={run.id} run={run} jobName={run.job_name ?? names.get(run.job_id) ?? 'Job'} open={open === run.id}
            onToggle={() => setOpen(open === run.id ? null : run.id)} ws={ws} token={token} boxId={boxId} editable={editable} refetch={() => void query.refetch()} />)}
        </ul>}
  </div>;
}

function ResultRow({ run, jobName, open, onToggle, ws, token, boxId, editable, refetch }: {
  run: Run; jobName: string; open: boolean; onToggle: () => void; ws: string; token: string; boxId: string; editable: boolean; refetch: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const state = runState(run);
  const title = run.result?.title && run.result.title !== jobName ? run.result.title : '';
  const act = async (path: string, body?: object) => {
    setBusy(true); setError('');
    try { await revboxesRequest(ws, token, `/${boxId}/results/${run.id}${path}`, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) }); refetch(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not do that.'); }
    finally { setBusy(false); }
  };
  const failure = run.failure ?? (state === 'failed' ? { text: run.error || 'The run stopped before it finished.', fix: null } : null);
  const deliveries = run.deliveries ?? [];
  return <li>
    <button type="button" aria-expanded={open} onClick={onToggle} className="flex h-10 w-full items-center gap-3 px-1 text-left transition-colors hover:bg-hover/60">
      <span aria-label={STATE_WORDS[state] ?? state} title={STATE_WORDS[state] ?? state} className={cn('h-1.5 w-1.5 shrink-0 rounded-full', DOT[state] ?? 'bg-muted-foreground/40', (state === 'running' || state === 'queued') && 'animate-pulse')} />
      <span className="max-w-[45%] shrink-0 truncate text-[13px] font-medium text-foreground">{jobName}</span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground">{title}</span>
      <span className="shrink-0 text-[11.5px] tabular-nums text-muted-foreground">{when(run.created_at)}{credits(run.credits) && <span className="ml-3">{credits(run.credits)}</span>}</span>
    </button>
    {open && <div className="space-y-3 pb-4 pl-[18px] pr-1 pt-1">
      {failure && <p role="alert" className="text-[12.5px] text-risk">{failure.text}{failure.fix && <> · <Link to={failure.fix.href} className="inline-flex items-center gap-0.5 font-medium text-foreground underline-offset-2 hover:underline">{failure.fix.label}<ArrowUpRight className="h-3 w-3" /></Link></>}</p>}
      {state === 'needs_review' && editable && <div className="flex items-center gap-2">
        <span className="text-[12px] text-muted-foreground">Waiting for review.</span>
        <Button size="sm" className="h-7 text-[12px]" disabled={busy} onClick={() => void act(run.kind === 'routine' ? '/decide' : '/approve', run.kind === 'routine' ? { approve: true } : undefined)}>Approve</Button>
        {run.kind === 'routine' && <Button size="sm" variant="ghost" className="h-7 text-[12px]" disabled={busy} onClick={() => void act('/decide', { approve: false })}>Deny</Button>}
      </div>}
      {run.result?.body
        ? <div className="max-h-[60vh] overflow-y-auto pr-2 text-[13px]"><Prose text={run.result.body} doc /></div>
        : !failure && <p className="text-[12.5px] text-muted-foreground">{state === 'running' || state === 'queued' ? 'Still running.' : 'No output from this run.'}</p>}
      {deliveries.length > 0 && <div className="space-y-0.5">
        {deliveries.map(d => <p key={d.id} className="text-[11px] text-muted-foreground"><span className={cn(d.state === 'failed' && 'text-risk')}>{d.state === 'sent' ? 'Sent' : d.state === 'failed' ? 'Not sent' : d.state}</span> · {KIND_WORDS[d.destination?.kind ?? ''] ?? d.destination?.kind ?? 'Destination'}{d.destination?.target ? ` · ${d.destination.target}` : ''}{d.error ? ` · ${d.error}` : ''}</p>)}
        {editable && run.kind !== 'routine' && state === 'completed' && deliveries.some(d => d.state === 'failed') && <button type="button" disabled={busy} className="text-[11px] font-medium text-foreground underline-offset-2 hover:underline" onClick={() => void act('/retry-delivery')}>Retry failed deliveries</button>}
      </div>}
      {error && <p role="alert" className="text-[12px] text-risk">{error}</p>}
    </div>}
  </li>;
}
