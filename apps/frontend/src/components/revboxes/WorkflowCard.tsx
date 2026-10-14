// The builder's proposal (GET-868, redesigned GET-858): one quiet card that reads left to right.
// Header: the job's name (editable) and its cost per run; under it the one-line summary. Then the
// flow as a row of small tiles joined by hairline connectors: what starts the job, one tile per REAL
// step, and the box's destinations when the job delivers there. A tile's title says what the step
// type does (never the model's words), its subtitle the human target. Anything that leaves the
// workspace (webhook hosts, email recipients) is named in its tile's subtitle, read from the server's
// `facts` (or the raw step config when facts are missing), so a step the model mislabelled cannot
// hide where it sends things (GET-858 review); HubSpot writes carry a "writes" tag. There is no
// Details disclosure (GET-872): the tiles are the whole story. Warnings are one muted line with
// the fix as a link, "+N more" for the rest. A tile is compact: the logo inline before its one-line
// title, the subtitle under it. The row scrolls sideways when narrow and stacks under
// 480px. Earlier proposals render dimmed with no actions; approved ones carry an Approved badge.
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Check, ChevronRight, Clock3, Mail, Sparkles, Webhook, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { toolLogo } from '@/lib/toolLogo';
import { SIGNAL_CHOICES, TOOL_NAMES, deliveryLabel, recipients, type Delivery, type JobProposal, type ProposalFact, type ProposalWarning } from '@/lib/revboxes';

export function WorkflowCard({ proposal, destinations, editable, current, approving, busy, approved, onApprove, onMakeChanges }: {
  proposal: JobProposal; destinations: Delivery[]; editable: boolean;
  /** Only the latest proposal of a session is actionable; earlier ones stay readable, quieter. */
  current: boolean; approving?: boolean; approved?: boolean;
  /** A builder turn is streaming: the proposal may still change, so neither action is offered. */
  busy?: boolean;
  onApprove: (name: string) => void; onMakeChanges: () => void;
}) {
  const [name, setName] = useState(proposal.name);
  useEffect(() => setName(proposal.name), [proposal.name]);
  const nodes = flowNodes(proposal, destinations);
  const blocked = !!approving || !!busy;
  const actionable = editable && current && !approved;
  const credits = proposal.estimated_credits_per_run;
  return <section aria-label={`Proposed job: ${name}`} className={cn('rounded-2xl border border-hairline bg-card shadow-card transition-opacity duration-base', !current && 'opacity-60')}>
    <header className="px-5 pt-4">
      <div className="flex items-center gap-3">
        <input aria-label="Job name" value={name} maxLength={120} disabled={!actionable} onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          className="-mx-1 min-w-0 flex-1 truncate rounded-md bg-transparent px-1 py-0.5 text-[16px] font-medium tracking-[-0.01em] text-foreground outline-none transition-colors hover:enabled:bg-hover focus:bg-hover disabled:opacity-100" />
        {approved && <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-ink-2"><Check className="h-3 w-3" strokeWidth={2.5} />Approved</span>}
        {credits != null && <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">~{credits} {credits === 1 ? 'credit' : 'credits'} / run</span>}
      </div>
      {proposal.summary && <p className="mt-0.5 line-clamp-2 text-[13px] leading-[1.45] text-muted-foreground">{proposal.summary}</p>}
    </header>

    {/* The flow. Sideways scroll with snap (no scrollbar chrome); a column under 480px. */}
    <ol aria-label="What the job does" className="scrollbar-hide mt-4 flex snap-x snap-mandatory scroll-px-5 items-stretch overflow-x-auto px-5 py-1 max-[480px]:flex-col max-[480px]:overflow-visible">
      {nodes.map((n, i) => <li key={n.key} className="flex shrink-0 items-stretch max-[480px]:flex-col">
        {i > 0 && <Connector />}
        <FlowNode node={n} />
      </li>)}
    </ol>

    <Warnings warnings={proposal.warnings} />

    {actionable ? <footer className="flex items-center justify-end gap-2 px-5 pb-4 pt-3">
      <Button variant="ghost" size="sm" onClick={onMakeChanges} disabled={blocked}>Make changes</Button>
      <Button size="sm" onClick={() => { if (!blocked) onApprove(name.trim() || proposal.name); }} disabled={blocked || !name.trim()}>{approving ? 'Approving…' : 'Approve'}</Button>
    </footer> : <div className="h-4" />}
  </section>;
}


/** One tile of the flow. `facts`: what the step touches as [label, value, mono?]; not drawn since Details went (GET-872). */
type Node = { key: string; mark: ReactNode; title: string; subtitle: string; external: boolean; writes: boolean; unchecked: boolean; facts: [string, string, boolean?][] };

function FlowNode({ node }: { node: Node }) {
  const label = [node.title, node.subtitle, node.writes && 'writes to HubSpot', node.external && 'sends data outside the workspace'].filter(Boolean).join(', ');
  return <div tabIndex={0} aria-label={label} title={`${node.title}\n${node.subtitle}`}
    className={cn('flex snap-start flex-col justify-center gap-0.5 self-center rounded-xl bg-muted/60 px-2.5 py-2.5 outline-none ring-offset-card focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 max-[480px]:w-full max-[480px]:max-w-none',
      // A tile that sends data out may grow (to 240px) so its addresses are read, not cut.
      node.external ? 'w-max min-w-[164px] max-w-[240px]' : 'w-[164px]')}>
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">{node.mark}</span>
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-[18px] text-foreground">{node.title}</span>
      {node.writes && <span className="shrink-0 rounded-[5px] bg-warning/10 px-1 text-[10px] font-medium leading-[15px] text-warning">writes</span>}
    </span>
    {node.subtitle && <span className={cn('block pl-[22px] text-[12px] leading-4', node.external ? 'line-clamp-3 text-ink-2 [overflow-wrap:anywhere]' : 'truncate text-muted-foreground')}>{node.subtitle}</span>}
  </div>;
}

/** A hairline with a small chevron between two tiles; it turns to point down when the row stacks. */
function Connector() {
  return <span aria-hidden className="flex w-7 shrink-0 items-center self-center max-[480px]:h-5 max-[480px]:w-full max-[480px]:justify-center">
    <span className="flex w-full items-center max-[480px]:w-5 max-[480px]:rotate-90">
      <span className="h-px flex-1 bg-border" /><ChevronRight className="-ml-[7px] h-3 w-3 shrink-0 text-muted-foreground/50" strokeWidth={2} />
    </span>
  </span>;
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

// ─── What the tiles say ───────────────────────────────────────────────────────────────────────

/** "#cs-handoffs · Report": the Slack layout a Slack step posts in (GET-858), from its config. */
const SLACK_LAYOUTS: Record<string, string> = { report: 'Report', approval: 'Approval', alert: 'Alert', handoff: 'Handoff', digest: 'Digest', notification: 'Notification', plain: 'Plain' };
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const list = (...vs: unknown[]) => vs.flatMap(v => Array.isArray(v) ? v.map(String) : str(v).split(/[,;]/)).map(x => x.trim()).filter(Boolean);
const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };
/** "Write the VP summary" -> "VP summary": the model's title as a target, verb and article dropped. */
const target = (title?: string) => (title ?? '').trim().replace(/^(read|write|draft|create|update|post|send|summari[sz]e|get|pull|fetch)\s+/i, '').replace(/^(the|a|an)\s+/i, '').trim();
const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The tiles: trigger, one per real step, and the box's destinations when the job delivers there and the box has some. */
function flowNodes(p: JobProposal, destinations: Delivery[]): Node[] {
  const facts = new Map((p.facts ?? []).map(f => [f.step_id, f] as const));
  const display = new Map((p.display ?? []).map(d => [d.step_id, d] as const));
  const steps = (p.steps ?? []).filter(s => s.type !== 'revbox_delivery').map(s => stepNode(s, facts.get(s.id), display.get(s.id)));
  const delivery: Node[] = p.uses_box_delivery && destinations.length ? [deliveryNode(destinations, boxDeliveryLayout(p, destinations))] : [];
  return [triggerNode(p.trigger), ...steps, ...delivery];
}

function triggerNode(t: JobProposal['trigger']): Node {
  const provider = str((t.config ?? {}).provider);
  const clock = t.kind === 'clock';
  const title = clock ? 'Schedule' : t.kind === 'manual' ? 'By hand' : SIGNAL_CHOICES.find(([k]) => k === t.kind)?.[1] ?? titleCase(t.kind.replace(/_/g, ' '));
  const mark = clock ? <Clock3 className="h-4 w-4 text-muted-foreground" /> : provider ? <Logo tool={provider} /> : <Zap className="h-4 w-4 text-muted-foreground" />;
  const facts: Node['facts'] = [['When', t.label]];
  if (t.timezone) facts.push(['Time zone', t.timezone]);
  if (provider) facts.push(['Recorder', TOOL_NAMES[provider] ?? provider]);
  // "Every day at 08:00 (Toronto)" -> "Every day 08:00" on the tile; the time zone is in Details.
  const short = clock ? t.label.replace(/\s*\([^)]*\)\s*$/, '').replace(/\bat (\d)/, '$1') : t.label;
  return { key: '__trigger', mark, title, subtitle: short || t.label, external: false, writes: false, unchecked: false, facts };
}

/**
 * One step's tile. The title comes from the step type, the subtitle from the server's fact (or the
 * raw config when there is none); the model's display text only names what a read or an AI step is
 * about, never where data goes.
 */
function stepNode(s: JobProposal['steps'][number], f: ProposalFact | undefined, d: JobProposal['display'][number] | undefined): Node {
  const c = s.config ?? {};
  const base = { key: s.id, mark: <Logo tool={s.type} />, writes: false, external: false, unchecked: !f };
  const facts: Node['facts'] = [];
  switch (s.type) {
    case 'hubspot': {
      const action = f?.action ?? (str(c.action) || 'note');
      const write = f ? f.access === 'write' : action !== 'read';
      const object = f?.object ?? (str(c.object) || null);
      const label = str(c.object_label);
      const named = label || (object && !/^\d+-\d+$/.test(object) ? titleCase(object.replace(/_/g, ' ')) : '') || target(d?.title) || 'Records';
      const fields = f?.fields ?? list(c.fields);
      const title = action === 'read' ? 'Read HubSpot' : action === 'note' ? 'HubSpot note' : action === 'task' ? 'HubSpot task' : 'Update HubSpot';
      facts.push(['Access', write ? 'Writes' : 'Reads only']);
      if (object) facts.push(['Object', label && label !== object ? `${label} · ${object}` : object, !label]);
      if (fields.length) facts.push(['Fields', fields.join(', '), true]);
      for (const [k, key] of [['Window', 'window'], ['Grouped by', 'group_by'], ['Date field', 'date_property']] as const) if (str(c[key])) facts.push([k, str(c[key])]);
      if (c.compare === true) facts.push(['Compare', 'With the period before']);
      return { ...base, title, subtitle: named, writes: write, facts };
    }
    case 'agent': {
      const pick = (f?.mode ?? c.mode) === 'pick';
      facts.push(['Model', f?.model ?? (str(c.model) || 'opennous')], ['Mode', pick ? 'Picks' : 'Writes']);
      if (f?.job) facts.push(['Job', f.job]);
      if (d?.detail) facts.push(['Shape', d.detail]);
      return { ...base, title: pick ? 'AI picks' : 'Write with AI', subtitle: target(d?.title) || 'OpenNous model', facts };
    }
    case 'slack': {
      const layout = typeof c.format === 'string' ? SLACK_LAYOUTS[c.format] : undefined;
      const tail = layout ? ` · ${layout}` : '';
      if ((f?.action ?? c.action) === 'dm') {
        const uid = f?.user_id ?? str(c.user_id);
        const who = f?.user ?? null;
        facts.push(['To', who ?? 'Slack user'], ['User id', uid || '(none)', true]);
        if (layout) facts.push(['Layout', layout]);
        facts.push(['Sends as', 'The OpenNous Slack app']);
        return { ...base, title: 'Slack DM', subtitle: `${who ?? (uid || 'Slack user')}${tail}`, facts };
      }
      const id = f?.channel_id ?? str(c.channel_id);
      // Without facts, the builder's own channel name is all there is: Details says it was not checked.
      const channel = f ? f.channel ?? null : str(c.channel).replace(/^#/, '') || null;
      facts.push(['Channel', channel ? `#${channel}` : 'Not found in Slack'], ['Channel id', id || '(none)', true]);
      if (layout) facts.push(['Layout', layout]);
      facts.push(['Sends as', 'The OpenNous Slack app']);
      return { ...base, title: 'Post to Slack', subtitle: `${channel ? `#${channel}` : id || 'No channel'}${tail}`, facts };
    }
    case 'gmail': case 'email': {
      const to = f ? (f.recipients ?? f.sends_to ?? []) : list(c.to, c.cc, c.bcc);
      const draft = s.type === 'gmail' && (f?.mode ?? c.mode) === 'draft';
      const mailbox = s.type === 'gmail' ? (f?.mailbox ?? (str((c.send_from as { id?: unknown } | undefined)?.id) || null)) : null;
      facts.push(['To', to.join(', ') || '(no recipient)'], ['Sends as', s.type === 'email' ? 'The OpenNous sender' : mailbox ?? '(no mailbox)'], ['Mode', draft ? 'Draft only, never sent' : 'Sends']);
      return { ...base, title: draft ? 'Draft email' : 'Send email', subtitle: to.length ? `to ${to.join(', ')}` : 'No recipient', external: true, facts };
    }
    case 'webhook': {
      const url = f?.url ?? str(c.url);
      const host = f?.host ?? hostOf(url);
      facts.push(['Method', 'POST'], ['URL', url || '(none)', true]);
      return { ...base, title: 'Webhook', subtitle: `→ ${host || 'no URL'}`, external: true, facts };
    }
    case 'approval': return { ...base, title: 'Approval', subtitle: 'Waits for a person', facts: [['Step', 'A person approves before the job goes on']] };
    case 'only_if': {
      const rule = (f?.target ?? '').replace(/^Only if\s+/i, '');
      return { ...base, title: 'Only if', subtitle: rule || 'A condition', facts: rule ? [['Rule', rule]] : [] };
    }
    default: {
      const sendsTo = f?.external ? f.sends_to ?? [] : [];
      if (f) facts.push(['Does', f.target]);
      if (sendsTo.length) facts.push(['Sends to', sendsTo.join(', ')]);
      return { ...base, title: TOOL_NAMES[s.type] ?? titleCase(s.type.replace(/_/g, ' ')),
        subtitle: sendsTo.length ? `to ${sendsTo.join(', ')}` : target(d?.title) || f?.target || '', external: sendsTo.length > 0, facts };
    }
  }
}

/**
 * The Slack layout the box's Slack destinations get from this job, as the engine decides it (core
 * boxSlackFormat, GET-872): an older destination's own layout, else the one the agent chose, else
 * the job's own Slack step's, else a report for a schedule and a notification for an event.
 */
function boxDeliveryLayout(p: JobProposal, destinations: Delivery[]): string | null {
  const slack = destinations.filter(d => d.kind === 'slack');
  if (!slack.length) return null;
  const usable = (v: unknown) => typeof v === 'string' && v !== 'approval' && SLACK_LAYOUTS[v] ? v : null;
  const own = (p.steps ?? []).find(s => s.type === 'slack' && usable(s.config?.format));
  const key = usable(slack.find(d => usable(d.format))?.format) ?? usable(p.box_delivery_format) ?? usable(own?.config?.format) ?? (p.trigger.kind === 'clock' ? 'report' : 'notification');
  return SLACK_LAYOUTS[key];
}

/** The box's destinations, at run time (only drawn when there are some). Outside targets first. */
function deliveryNode(destinations: Delivery[], layout: string | null = null): Node {
  const outside = (d: Delivery) => d.kind !== 'slack';
  const sorted = [...destinations].sort((a, b) => Number(outside(b)) - Number(outside(a)));
  // Every outside address or host is named (never cut to a count); Slack channels follow, counted past one.
  const mail = sorted.filter(d => d.kind === 'email' || d.kind === 'gmail').flatMap(d => recipients(d.kind === 'email' ? d.to ?? d.target : d.to));
  const hooks = sorted.filter(d => d.kind === 'webhook').map(d => `→ ${hostOf(d.target)}`);
  const slack = sorted.filter(d => d.kind === 'slack').map(deliveryLabel);
  const subtitle = [mail.length ? `to ${[...new Set(mail)].join(', ')}` : '', ...hooks, slack.length > 1 ? `${slack[0]} +${slack.length - 1}` : slack[0] ?? '', slack.length && layout ? layout : ''].filter(Boolean).join(' · ');
  const first = sorted[0];
  const mark = first.kind === 'slack' || first.kind === 'gmail' ? <Logo tool={first.kind} /> : first.kind === 'email' ? <Mail className="h-4 w-4 text-muted-foreground" /> : <Webhook className="h-4 w-4 text-muted-foreground" />;
  return { key: '__delivery', mark, title: 'Box delivery', subtitle, external: sorted.some(outside), writes: false, unchecked: false,
    facts: sorted.map(d => [d.kind === 'slack' ? 'Slack' : d.kind === 'email' ? 'Email' : d.kind === 'gmail' ? 'Gmail draft' : 'Webhook', deliveryLabel(d), d.kind === 'webhook'] as [string, string, boolean]) };
}

/** A tool's mark: the provider logo when we have one, the AI mark for agent steps, else its initial. */
export function Logo({ tool, size = 'sm' }: { tool: string; size?: 'xs' | 'sm' }) {
  const src = toolLogo(tool);
  const px = size === 'xs' ? 'h-3 w-3' : 'h-4 w-4';
  if (src) return <img src={src} alt="" className={cn(px, 'object-contain')} />;
  if (tool === 'agent') return <Sparkles className={cn(px, 'text-foreground')} />;
  if (tool === 'webhook' || tool === 'revbox_delivery') return <Webhook className={cn(px, 'text-muted-foreground')} />;
  return <span className="text-[10px] font-medium text-muted-foreground">{(TOOL_NAMES[tool] ?? tool)[0]?.toUpperCase()}</span>;
}
