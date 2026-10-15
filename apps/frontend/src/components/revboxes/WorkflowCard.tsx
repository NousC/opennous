// A RevBox job's card (GET-868, redesigned GET-858, GET-884): the job reads as an agent at work, not
// a workflow. Header: the job's name (editable on a live proposal), its state (On/Off in an Edit
// view, else Approved) and its cost per run. Then the brief: one sentence in the agent's voice
// ("Every morning I read yesterday's Company Daily Stats in HubSpot, write the report and post it to
// #ops-daily."), built by the SERVER from the job's facts (core jobBrief; `proposal.brief`), never
// from the model's summary or display titles, so a prompt cannot put words on the card. Under it
// three rows: Starts (the trigger), Uses (the logos of the tools it touches) and Delivers (every
// target, from the server's `facts` and the box's destinations: a Slack channel the server did not
// find is shown by id and flagged; email recipients and webhook hosts are named in full; HubSpot
// writes carry a "writes" tag; "In the app" when it sends nothing). An approval step adds "Asks you
// before sending". No step tiles. Warnings are one muted line with the fix as a link, "+N more" for
// the rest. Earlier proposals render dimmed with no actions.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Check, Hand, Mail, Sparkles, Table2, Webhook } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { toolLogo } from '@/lib/toolLogo';
import { TOOL_NAMES, type Delivery, type JobProposal, type ProposalWarning } from '@/lib/revboxes';
import { asksFirst, jobDelivers, jobStarts, jobUses, type CardTarget } from '@/lib/jobCard';

export function WorkflowCard({ proposal, destinations, editable, current, approving, busy, approved, enabled, onApprove, onMakeChanges }: {
  proposal: JobProposal; destinations: Delivery[]; editable: boolean;
  /** Only the latest proposal of a session is actionable; earlier ones stay readable, quieter. */
  current: boolean; approving?: boolean; approved?: boolean;
  /** The live job's switch (Edit view): shown as On/Off instead of Approved. */
  enabled?: boolean;
  /** A builder turn is streaming: the proposal may still change, so neither action is offered. */
  busy?: boolean;
  onApprove: (name: string) => void; onMakeChanges: () => void;
}) {
  const [name, setName] = useState(proposal.name);
  useEffect(() => setName(proposal.name), [proposal.name]);
  const blocked = !!approving || !!busy;
  const actionable = editable && current && !approved;
  const credits = proposal.estimated_credits_per_run;
  const uses = jobUses(proposal, destinations);
  const delivers = jobDelivers(proposal, destinations);
  return <section aria-label={`Job: ${name}`} className={cn('rounded-2xl border border-hairline bg-card shadow-card transition-opacity duration-base', !current && !approved && 'opacity-60')}>
    <header className="px-5 pt-4">
      <div className="flex items-center gap-3">
        <input aria-label="Job name" value={name} maxLength={120} disabled={!actionable} onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          className="-mx-1 min-w-0 flex-1 truncate rounded-md bg-transparent px-1 py-0.5 text-[16px] font-medium tracking-[-0.01em] text-foreground outline-none transition-colors hover:enabled:bg-hover focus:bg-hover disabled:opacity-100" />
        {approved && enabled !== undefined
          ? <span className="inline-flex shrink-0 items-center gap-1.5 text-[12px] font-medium text-ink-2"><span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', enabled ? 'bg-emerald-600' : 'bg-muted-foreground/40')} />{enabled ? 'On' : 'Off'}</span>
          : approved && <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-ink-2"><Check className="h-3 w-3" strokeWidth={2.5} />Approved</span>}
        {credits != null && <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">~{credits} {credits === 1 ? 'credit' : 'credits'} / run</span>}
      </div>
      {/* The brief: the server's sentence only (never the model's summary). */}
      {proposal.brief?.text && <p className="mt-1.5 text-[13.5px] leading-[1.55] text-ink-2">{proposal.brief.text}</p>}
    </header>

    <dl aria-label="What the job does" className="mt-4 grid grid-cols-[76px_minmax(0,1fr)] gap-x-3 gap-y-2.5 px-5 text-[12.5px] leading-5">
      <dt className="text-muted-foreground">Starts</dt>
      <dd className="min-w-0 text-foreground">{jobStarts(proposal)}</dd>
      {uses.length > 0 && <>
        <dt className="text-muted-foreground">Uses</dt>
        <dd className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-foreground">
          {uses.map(t => <span key={t} className="inline-flex items-center gap-1.5"><Mark tool={t} /><span>{toolName(t)}</span></span>)}
        </dd>
      </>}
      <dt className="text-muted-foreground">Delivers</dt>
      <dd className="min-w-0 space-y-1">
        {delivers.length ? delivers.map(t => <Target key={t.key} target={t} />) : <span className="text-foreground">In the app</span>}
      </dd>
    </dl>
    {asksFirst(proposal) && <p className="mt-2.5 flex items-center gap-1.5 px-5 text-[12px] text-muted-foreground"><Hand className="h-3 w-3" aria-hidden />Asks you before sending</p>}

    <Warnings warnings={proposal.warnings ?? []} />
    {/* Chaining (GET-874): the jobs this chat sets up after this one, once it is approved. */}
    {!!proposal.next_jobs?.length && !approved && <p className="mt-3 truncate px-5 text-[12px] text-muted-foreground">Then in this chat: {proposal.next_jobs.join(' · ')}</p>}

    {actionable ? <footer className="flex items-center justify-end gap-2 px-5 pb-4 pt-3">
      <Button variant="ghost" size="sm" onClick={onMakeChanges} disabled={blocked}>Make changes</Button>
      <Button size="sm" onClick={() => { if (!blocked) onApprove(name.trim() || proposal.name); }} disabled={blocked || !name.trim()}>{approving ? 'Approving…' : 'Approve'}</Button>
    </footer> : <div className="h-4" />}
  </section>;
}

const toolName = (t: string) => (t === 'email' ? 'Email' : TOOL_NAMES[t] ?? t.charAt(0).toUpperCase() + t.slice(1));

/** A tool's mark in the rows: its logo; OpenNous email and webhooks have their own icons. */
function Mark({ tool }: { tool: string }) {
  if (tool === 'email') return <Mail className="h-3.5 w-3.5 text-muted-foreground" />;
  return <span className="flex h-3.5 w-3.5 items-center justify-center [&>img]:h-3.5 [&>img]:w-3.5 [&>svg]:h-3.5 [&>svg]:w-3.5"><Logo tool={tool} /></span>;
}

/** One Delivers line: its mark and what it says. What leaves the workspace is never cut short. */
function Target({ target: t }: { target: CardTarget }) {
  const label = [t.text, t.writes && 'writes to HubSpot', t.external && 'sends data outside the workspace', t.problem && 'not found in Slack'].filter(Boolean).join(', ');
  return <div aria-label={label} title={t.text} className="flex min-w-0 items-start gap-1.5">
    <span className="mt-[3px] shrink-0"><Mark tool={t.tool} /></span>
    <span className={cn('min-w-0', t.external ? 'text-ink-2 [overflow-wrap:anywhere]' : 'truncate text-foreground', t.problem && 'text-warning')}>{t.text}</span>
    {t.writes && <span className="mt-[2px] shrink-0 rounded-[5px] bg-warning/10 px-1 text-[10px] font-medium leading-[15px] text-warning">writes</span>}
  </div>;
}

/** Warnings: one muted line (the first), "+N more" for the rest; each with its fix as a link. */
function Warnings({ warnings }: { warnings: ProposalWarning[] }) {
  const [open, setOpen] = useState(false);
  if (!warnings.length) return null;
  const shown = open ? warnings : warnings.slice(0, 1);
  return <div className="mt-3 space-y-1.5 px-5" role="note" aria-label={`${warnings.length} ${warnings.length === 1 ? 'warning' : 'warnings'}`}>
    {shown.map((w, i) => <div key={i} className="flex min-w-0 items-baseline gap-2 text-[12px] leading-[1.5]">
      <span aria-hidden className="relative top-[-1px] h-1.5 w-1.5 shrink-0 rounded-full bg-warning-dot" />
      {/* The message truncates to one line; clicking it shows it (and the rest) in full. */}
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        className={cn('min-w-0 text-left text-ink-2 hover:text-foreground focus-visible:underline focus-visible:outline-none', !open && 'truncate')}>{w.message}</button>
      {w.fix && <FixLink href={w.fix.href} label={w.fix.label} />}
      {!open && warnings.length > 1 && <button type="button" onClick={() => setOpen(true)} className="shrink-0 whitespace-nowrap text-muted-foreground hover:text-foreground">+{warnings.length - 1} more</button>}
    </div>)}
  </div>;
}

function FixLink({ href, label }: { href: string; label: string }) {
  const cls = 'inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap font-medium text-foreground underline-offset-2 hover:underline';
  return /^https?:\/\//.test(href)
    ? <a href={href} target="_blank" rel="noreferrer" className={cls}>{label}<ArrowUpRight className="h-3 w-3" /></a>
    : <Link to={href} className={cls}>{label}<ArrowUpRight className="h-3 w-3" /></Link>;
}

/** A tool's mark: the provider logo when we have one, the AI mark for agent steps, else its initial. */
export function Logo({ tool, size = 'sm' }: { tool: string; size?: 'xs' | 'sm' }) {
  const src = toolLogo(tool);
  const px = size === 'xs' ? 'h-3 w-3' : 'h-4 w-4';
  if (src) return <img src={src} alt="" className={cn(px, 'object-contain')} />;
  if (tool === 'agent') return <Sparkles className={cn(px, 'text-foreground')} />;
  if (tool === 'webhook' || tool === 'revbox_delivery') return <Webhook className={cn(px, 'text-muted-foreground')} />;
  if (tool === 'dataset_append' || tool === 'dataset_read') return <Table2 className={cn(px, 'text-muted-foreground')} />;
  return <span className="text-[10px] font-medium text-muted-foreground">{(TOOL_NAMES[tool] ?? tool)[0]?.toUpperCase()}</span>;
}
