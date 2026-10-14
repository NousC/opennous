// The RevBox Job Builder chat (GET-868). One builder session: you describe the job, the agent
// investigates the workspace for real (status rows), asks what it cannot find out (AskCard), and
// proposes a job (WorkflowCard). Approve creates the engine routine and switches it on (or says why
// it could not), and hands it to the page, which closes the builder on the Jobs list.
//
// Edit on a job reopens the chat that made it: the server starts a new session on the job seeded
// with that chat (openBuilderForJob) and returns it as `history`, shown above the input (the
// approved proposal dimmed, with its Approved badge), so "make the report better" continues there. The contract is
// docs/revboxes/JOB_BUILDER.md; the stream is lib/revboxes.ts streamBuilderTurn.
//
// The composer (GET-868 redesign): one wide, low input. Bottom-left, two pickers: Integrations
// (the workspace's connected tools; a pick is attached above the input as its logo, so the agent
// knows that tool is involved) and Signals (what starts the job, from the signal catalog; nothing
// picked = most likely a schedule). Both ride along with every message as `hints`, and when the
// agent settles the trigger itself ("after every meeting") its `trigger` event updates the chip; its
// `integrations` event attaches the tools it settled on, so the user never has to.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, ArrowUp, Check, ChevronDown, Clock, Loader2, Plug, Plus, Search, Square, X, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { AskCard } from '@/components/revboxes/AskCard';
import { Logo, WorkflowCard } from '@/components/revboxes/WorkflowCard';
import {
  approveBuilderProposal, openBuilderForJob, streamBuilderTurn, revboxesRequest, signalsRequest, signalKeyLabel,
  MEETING_PROVIDER_LABEL, SIGNAL_GROUP_LABEL, TOOL_NAMES,
  type BuilderAnswer, type BuilderEvent, type BuilderHints, type BuilderHistoryAsk, type BuilderHistoryItem, type BuilderHistoryProposal, type BuilderHistoryText, type BuilderQuestion, type Catalog, type Delivery, type ApproveResult, type JobProposal,
  type SignalCatalog, type SignalEntry, type SignalGroup,
} from '@/lib/revboxes';

type Activity = { kind: 'text'; text: string } | { kind: 'tool'; name: string | null; label: string; state: 'running' | 'done' | 'error' };
type Turn = {
  id: string;
  /** What the user sent, as shown in the bubble (answers are rendered readable). */
  user: string;
  items: Activity[];
  ask?: BuilderQuestion[]; proposal?: JobProposal; credits?: number;
  error?: { message: string; code?: string }; stopped?: boolean; streaming: boolean;
};

const HUMAN_TOOL: Record<string, string> = {
  workspace_connections: 'Checking connected tools', revbox_context: 'Reading this box’s context', hubspot_objects: 'Listing HubSpot objects',
  hubspot_fields: 'Reading HubSpot fields', hubspot_find: 'Searching HubSpot', hubspot_access: 'Checking HubSpot access',
  hubspot_preview: 'Previewing a HubSpot read', slack_channels: 'Finding the Slack channel', mailboxes: 'Checking mailboxes',
  search_accounts: 'Searching accounts', signal_catalog: 'Reading signals',
};

export function JobBuilder({ workspaceId, token, boxId, job, destinations, editable, onApproved }: {
  workspaceId: string; token: string; boxId: string;
  /** Set for Edit on an existing job: its earlier chat is reopened and continued. */
  job?: { id: string; name: string } | null;
  destinations: Delivery[]; editable: boolean;
  /** Kept for callers; the way out is the page's "Back to jobs" (no Close link under the input). */
  onApproved: (result: ApproveResult) => void; onClose?: () => void;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [hint, setHint] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  /** Edit: the job's earlier chat, and whether it is still loading. */
  const [history, setHistory] = useState<BuilderHistoryItem[]>([]);
  const [opening, setOpening] = useState(!!job && editable);
  /** Tools the user attached (slugs) and the signal that starts the job (catalog key; null = not chosen). */
  const [integrations, setIntegrations] = useState<string[]>([]);
  const [signal, setSignal] = useState<string | null>(null);
  const [signalFallback, setSignalFallback] = useState<string | null>(null);
  const connections = useQuery({ queryKey: ['revbox-catalog', workspaceId], enabled: editable && !!workspaceId, queryFn: () => revboxesRequest<Catalog>(workspaceId, token, '/catalog') });
  const signals = useQuery({ queryKey: ['signal-catalog', workspaceId], enabled: editable && !!workspaceId, queryFn: () => signalsRequest<SignalCatalog>(workspaceId, token, '/catalog') });
  const tools = useMemo(() => {
    const seen = new Map<string, string>();
    for (const c of connections.data?.connections ?? []) if (!seen.has(c.slug)) seen.set(c.slug, TOOL_NAMES[c.slug] ?? (c.name && c.name !== c.slug ? c.name : c.slug.charAt(0).toUpperCase() + c.slug.slice(1)));
    return [...seen].map(([slug, name]) => ({ slug, name }));
  }, [connections.data]);
  const signalText = signal ? signalKeyLabel(signal, signals.data) ?? signalFallback ?? signal : null;
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState('');
  const abort = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const streaming = turns.some(t => t.streaming);
  const lastTurn = turns[turns.length - 1];
  const latestProposalTurn = [...turns].reverse().find(t => t.proposal)?.id;

  // Focus on the next frame: the click that opened the builder also unmounts the "New job" button, and
  // an early focus can lose to it, leaving keystrokes to the page's shortcuts (GET-868).
  useEffect(() => { const f = requestAnimationFrame(() => input.current?.focus()); return () => { cancelAnimationFrame(f); abort.current?.abort(); }; }, []);
  // Edit: open the job's own chat. On failure the first message starts a fresh session on the job.
  useEffect(() => {
    if (!job || !editable) return;
    let live = true;
    openBuilderForJob(workspaceId, token, boxId, job.id)
      .then(r => { if (live) { setSessionId(r.session_id); setHistory(r.history ?? []); } })
      .catch(() => { /* the job_id path below still works */ })
      .finally(() => { if (!live) return; setOpening(false); requestAnimationFrame(() => {
        const el = scroller.current; if (el) el.scrollTop = el.scrollHeight;
        input.current?.focus();
      }); });
    return () => { live = false; };
  }, [workspaceId, token, boxId, job, editable]);
  // Follow the stream while it is near the bottom; leave the reader alone if they scrolled up.
  useEffect(() => {
    const el = scroller.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [turns]);

  function patch(id: string, fn: (t: Turn) => Turn) { setTurns(prev => prev.map(t => t.id === id ? fn(t) : t)); }
  function apply(id: string, ev: BuilderEvent) {
    switch (ev.type) {
      case 'session': setSessionId(ev.session_id); break;
      case 'status': patch(id, t => ({ ...t, items: [...t.items, { kind: 'tool', name: null, label: ev.text, state: 'running' }] })); break;
      case 'tool': patch(id, t => {
        const items = [...t.items];
        if (ev.state === 'start') {
          // A status line usually announces the tool just before it starts: adopt it.
          const open = lastIndex(items, x => x.kind === 'tool' && x.state === 'running' && x.name === null);
          if (open >= 0) items[open] = { ...(items[open] as Extract<Activity, { kind: 'tool' }>), name: ev.name };
          else items.push({ kind: 'tool', name: ev.name, label: HUMAN_TOOL[ev.name] ?? ev.name.replace(/_/g, ' '), state: 'running' });
        } else {
          let at = lastIndex(items, x => x.kind === 'tool' && x.state === 'running' && x.name === ev.name);
          if (at < 0) at = lastIndex(items, x => x.kind === 'tool' && x.state === 'running');
          const row = { kind: 'tool' as const, name: ev.name, label: ev.summary || (at >= 0 ? (items[at] as Extract<Activity, { kind: 'tool' }>).label : ev.name), state: ev.state === 'error' ? 'error' as const : 'done' as const };
          if (at >= 0) items[at] = row; else items.push(row);
        }
        return { ...t, items };
      }); break;
      case 'text': patch(id, t => {
        const items = [...t.items];
        const tail = items[items.length - 1];
        if (tail?.kind === 'text') items[items.length - 1] = { kind: 'text', text: tail.text + ev.text };
        else items.push({ kind: 'text', text: ev.text });
        return { ...t, items };
      }); break;
      case 'ask': patch(id, t => ({ ...t, ask: ev.questions })); break;
      case 'proposal': patch(id, t => ({ ...t, proposal: ev.proposal })); break;
      case 'credits': patch(id, t => ({ ...t, credits: (t.credits ?? 0) + ev.credits })); break;
      case 'trigger': {
        // The agent picked or changed what starts the job: the Signals chip follows it.
        const key = ev.signal || null;
        setSignal(key); setSignalFallback(ev.label ?? null);
        const label = key ? signalKeyLabel(key, signals.data) ?? ev.label ?? key : ev.label ?? 'On a schedule';
        patch(id, t => ({ ...t, items: [...t.items, { kind: 'tool', name: 'trigger', label: `Starts when: ${label}`, state: 'done' }] }));
        break;
      }
      case 'integrations': {
        // The agent settled the tools the job uses: they join the attached chips (merged with the
        // user's picks, removable like them) and go back as hints on the next turn. Users never have
        // to attach tools themselves.
        const slugs = (Array.isArray(ev.slugs) ? ev.slugs : []).filter((s): s is string => typeof s === 'string' && !!s);
        if (slugs.length) setIntegrations(list => [...list, ...slugs.filter(s => !list.includes(s))]);
        break;
      }
      case 'error': patch(id, t => ({ ...t, error: { message: ev.message, code: ev.code } })); break;
      case 'done': patch(id, t => ({ ...t, streaming: false })); break;
    }
  }

  async function run(user: string, body: { message: string; job_id?: string | null } | { answers: BuilderAnswer[] }) {
    if (streaming || approving) return;
    const id = crypto.randomUUID();
    setTurns(prev => [...prev, { id, user, items: [], streaming: true }]);
    setHint(''); setApproveError('');
    const controller = new AbortController();
    abort.current = controller;
    try {
      const hints: BuilderHints = { integrations, signal };
      await streamBuilderTurn({ workspaceId, token, boxId, sessionId, body: { ...body, hints }, signal: controller.signal, onEvent: ev => apply(id, ev) });
    } catch (e) {
      if (controller.signal.aborted) patch(id, t => ({ ...t, stopped: true }));
      else patch(id, t => ({ ...t, error: { message: e instanceof Error ? e.message : 'The builder stopped unexpectedly.' } }));
    } finally {
      // Spinners never outlive the turn: whatever was still running when it ended is settled.
      patch(id, t => ({ ...t, streaming: false, items: t.items.map(x => x.kind === 'tool' && x.state === 'running' ? { ...x, state: controller.signal.aborted ? 'error' : 'done' } : x) }));
      abort.current = null;
      requestAnimationFrame(() => input.current?.focus());
    }
  }
  function send() {
    const text = draft.trim();
    if (!text || streaming || opening || !editable) return;
    setDraft('');
    if (input.current) input.current.style.height = 'auto';
    void run(text, { message: text, ...(!sessionId && job ? { job_id: job.id } : {}) });
  }
  function answer(questions: BuilderQuestion[], answers: BuilderAnswer[]) {
    const lines = answers.map(a => {
      const q = questions.find(x => x.id === a.id);
      const picked = [...a.selected.map(s => s.replace(/\s*\(recommended\)\s*$/i, '')), ...(a.other ? [a.other] : [])].join(', ');
      return `${q?.header || q?.question || a.id}: ${picked}`;
    });
    void run(lines.join('\n'), { answers });
  }
  async function approve(name: string) {
    // A turn still streaming may change (or replace) the proposal: approve what is settled only.
    if (!sessionId || streaming || approving) return;
    setApproving(true); setApproveError('');
    try { onApproved(await approveBuilderProposal(workspaceId, token, boxId, sessionId, name)); }
    catch (e) { setApproveError(e instanceof Error ? e.message : 'Could not approve the job.'); }
    finally { setApproving(false); }
  }
  function makeChanges() {
    if (streaming || approving) return;
    setHint('What should change? For example: post at 07:30, or add the deal owner to the report.');
    input.current?.focus();
  }

  const empty = !turns.length && !history.length;
  // The agent composer's shape (product owner's design): pinned to the bottom of the column, a grey
  // rounded box with no border, outlined pickers bottom-left and the dark square send button
  // bottom-right; what is attached sits above the box as soft grey tags.
  const composer = editable && <div className="shrink-0 bg-background px-6 pb-5 pt-3 md:px-10">
    <div className="mx-auto w-full max-w-[880px]">
      {(integrations.length > 0 || signal) && <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {signal && <Tag onRemove={() => { setSignal(null); setSignalFallback(null); }} label={`Remove signal ${signalText}`}>
          <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', signal === 'schedule' ? 'bg-muted-foreground/60' : 'bg-emerald-500')} />
          <span className="text-muted-foreground">Starts when</span><span className="text-muted-foreground/50">·</span><span className="text-foreground">{signalText}</span>
        </Tag>}
        {integrations.map(slug => <Tag key={slug} onRemove={() => setIntegrations(list => list.filter(x => x !== slug))} label={`Remove ${tools.find(t => t.slug === slug)?.name ?? slug}`}>
          <Logo tool={slug} size="xs" /><span className="text-foreground">{tools.find(t => t.slug === slug)?.name ?? TOOL_NAMES[slug] ?? slug}</span>
        </Tag>)}
      </div>}
      <form onSubmit={e => { e.preventDefault(); send(); }} className="rounded-2xl bg-muted px-4 pb-3 pt-3.5">
        {hint && <div className="mb-1.5 flex items-start gap-2 text-[12px] text-muted-foreground"><span className="flex-1">{hint}</span><button type="button" aria-label="Dismiss hint" onClick={() => setHint('')} className="hover:text-foreground"><X className="h-3 w-3" /></button></div>}
        <textarea ref={input} aria-label="Describe the job" value={draft} maxLength={12000} rows={1}
          onChange={e => setDraft(e.target.value)}
          onInput={e => { e.currentTarget.style.height = 'auto'; e.currentTarget.style.height = `${Math.min(e.currentTarget.scrollHeight, 150)}px`; }}
          onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send(); } }}
          placeholder={turns.length ? 'Reply, or describe what to change…' : job ? `What should change in ${job.name}?` : 'Describe the job you want…'}
          className="block max-h-[150px] min-h-[22px] w-full resize-none bg-transparent px-0.5 text-[14px] font-normal leading-[22px] text-foreground outline-none placeholder:font-normal placeholder:text-muted-foreground" />
        <div className="mt-3 flex items-center gap-1.5">
          <IntegrationsMenu tools={tools} loading={connections.isLoading} selected={integrations}
            onToggle={slug => setIntegrations(list => list.includes(slug) ? list.filter(x => x !== slug) : [...list, slug])} />
          <SignalsMenu catalog={signals.data} loading={signals.isLoading} error={signals.error?.message} selected={signal}
            onPick={key => { setSignal(key); setSignalFallback(null); }} />
          <span className="flex-1" />
          <span className="hidden text-[11px] text-muted-foreground/60 sm:inline">⌘↵</span>
          {streaming
            ? <button type="button" aria-label="Stop" onClick={() => abort.current?.abort()} className="inline-flex h-[30px] w-[30px] items-center justify-center rounded-[9px] bg-foreground text-background shadow-[0_1px_2px_rgba(20,20,18,0.2)] transition-opacity duration-fast hover:opacity-90"><Square className="h-3 w-3 fill-current" /></button>
            : <button type="submit" aria-label="Send" disabled={!draft.trim() || approving || opening} className="inline-flex h-[30px] w-[30px] items-center justify-center rounded-[9px] bg-foreground text-background shadow-[0_1px_2px_rgba(20,20,18,0.2)] transition-opacity duration-fast hover:opacity-90 disabled:opacity-30"><ArrowUp className="h-[15px] w-[15px]" strokeWidth={1.8} /></button>}
        </div>
      </form>
    </div>
  </div>;

  return <div className="flex min-h-0 flex-1 flex-col">
    {empty
      ? <div className="min-h-0 flex-1" />
      : <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-6 md:px-10">
      <div className="mx-auto w-full max-w-[880px] space-y-6 py-6" aria-live="polite">
        {history.length > 0 && <div className="space-y-3">
          {history.map((item, i) => <HistoryItem key={i} item={item} destinations={destinations} />)}
        </div>}
        {turns.map(turn => <div key={turn.id} className="space-y-3">
          <div className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-muted/70 px-4 py-2.5 text-[13px] leading-relaxed text-foreground">{turn.user}</div>
          {turn.items.map((item, i) => item.kind === 'text'
            ? <p key={i} className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-foreground">{item.text}</p>
            : <ToolRow key={i} label={item.label} state={item.state} />)}
          {turn.streaming && !turn.items.length && <ToolRow label="Thinking" state="running" />}
          {turn.ask && (turn === lastTurn && !turn.streaming
            ? <AskCard questions={turn.ask} disabled={streaming || !editable} onSubmit={answers => answer(turn.ask!, answers)} />
            : !turn.streaming && <p className="text-[11.5px] text-muted-foreground">Asked {turn.ask.length === 1 ? 'a question' : `${turn.ask.length} questions`}</p>)}
          {turn.proposal && <WorkflowCard proposal={turn.proposal} destinations={destinations} editable={editable}
            current={turn.id === latestProposalTurn && !turn.streaming} approving={approving} busy={streaming}
            onApprove={name => void approve(name)} onMakeChanges={makeChanges} />}
          {turn.id === latestProposalTurn && approveError && <ErrorRow message={approveError} />}
          {turn.error && <ErrorRow message={turn.error.message} code={turn.error.code} />}
          {turn.stopped && <p className="text-[11.5px] text-muted-foreground">Stopped.</p>}
          {turn.credits != null && !turn.streaming && <p className="text-[10.5px] text-muted-foreground/70">{turn.credits.toFixed(turn.credits % 1 ? 1 : 0)} {turn.credits === 1 ? 'credit' : 'credits'}</p>}
        </div>)}
      </div>
    </div>}
    {composer}
  </div>;
}

/** One item of a job's earlier chat (Edit): the same bubbles and cards as a live turn, read-only. */
function HistoryItem({ item: raw, destinations }: { item: BuilderHistoryItem; destinations: Delivery[] }) {
  const kind = 'kind' in raw ? raw.kind : null;
  if (kind === 'ask') { const item = raw as BuilderHistoryAsk; return <details className="group text-[11.5px] text-muted-foreground">
    <summary className="cursor-pointer list-none hover:text-foreground">Asked {item.questions.length === 1 ? 'a question' : `${item.questions.length} questions`}<ChevronDown className="ml-1 inline h-3 w-3 transition-transform group-open:rotate-180" /></summary>
    <dl className="mt-2 space-y-1.5 border-l border-border/70 pl-3">
      {item.answers.map((a, i) => <div key={i}><dt className="text-muted-foreground">{a.question}</dt><dd className="text-foreground">{a.answer}</dd></div>)}
      {!item.answers.length && <dd>No answer was picked.</dd>}
    </dl>
  </details>; }
  if (kind === 'proposal') { const item = raw as BuilderHistoryProposal; return item.approved
    ? <WorkflowCard proposal={item.proposal} destinations={destinations} editable={false} current={false} approved onApprove={() => {}} onMakeChanges={() => {}} />
    : <p className="text-[11.5px] text-muted-foreground">Proposed “{item.proposal?.name ?? 'a job'}”</p>; }
  const item = raw as BuilderHistoryText;
  return item.role === 'user'
    ? <div className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-muted/70 px-4 py-2.5 text-[13px] leading-relaxed text-foreground">{item.text}</div>
    : <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-foreground">{item.text}</p>;
}

/** An attachment above the input, like the agent's job tag: a soft grey rounded tag, removable. */
function Tag({ children, onRemove, label }: { children: ReactNode; onRemove: () => void; label: string }) {
  return <span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-muted pl-2.5 pr-1 text-[12px]">
    {children}
    <button type="button" aria-label={label} onClick={onRemove} className="flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground"><X className="h-3 w-3" /></button>
  </span>;
}

const MENU_BUTTON = 'inline-flex h-7 items-center gap-1.5 rounded-lg border border-border/70 bg-background px-2.5 text-[12.5px] text-ink-2 transition-colors duration-fast hover:bg-hover hover:text-foreground data-[state=open]:bg-hover data-[state=open]:text-foreground';

function IntegrationsMenu({ tools, loading, selected, onToggle }: { tools: { slug: string; name: string }[]; loading: boolean; selected: string[]; onToggle: (slug: string) => void }) {
  return <Popover>
    <PopoverTrigger type="button" className={MENU_BUTTON}><Plug className="h-3.5 w-3.5" />Integrations{selected.length > 0 && <span className="rounded bg-muted px-1 text-[10.5px] tabular-nums text-foreground">{selected.length}</span>}<ChevronDown className="h-3 w-3 opacity-60" /></PopoverTrigger>
    <PopoverContent align="start" side="top" className="w-64 p-1.5">
      <p className="px-2 pb-1.5 pt-1 text-[11px] text-muted-foreground">Tools this job involves</p>
      {loading && <p className="px-2 py-2 text-[12px] text-muted-foreground">Loading…</p>}
      {!loading && !tools.length && <p className="px-2 py-2 text-[12px] text-muted-foreground">No integrations connected. <Link to="/company-sources" className="underline underline-offset-2">Connect one</Link></p>}
      {tools.map(t => {
        const on = selected.includes(t.slug);
        return <button key={t.slug} type="button" role="menuitemcheckbox" aria-checked={on} onClick={() => onToggle(t.slug)} className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[12.5px] hover:bg-hover">
          <span className="flex h-5 w-5 items-center justify-center"><Logo tool={t.slug} /></span>
          <span className="flex-1 truncate">{t.name}</span>
          {on && <Check className="h-3.5 w-3.5 text-foreground" />}
        </button>;
      })}
    </PopoverContent>
  </Popover>;
}

type SignalOption = { key: string; label: string; detail?: string; logo?: string; draft?: boolean };
function SignalsMenu({ catalog, loading, error, selected, onPick }: { catalog?: SignalCatalog; loading: boolean; error?: string; selected: string | null; onPick: (key: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const match = (o: SignalOption) => !needle || `${o.label} ${o.detail ?? ''} ${o.key}`.toLowerCase().includes(needle);
    const out: { group: SignalGroup; options: SignalOption[] }[] = [];
    const push = (group: SignalGroup, options: SignalOption[]) => { const m = options.filter(match); if (m.length) out.push({ group, options: m }); };
    const builtin = catalog?.builtin ?? [];
    // A meeting signal is offered once per recorder: "Meeting done · Granola".
    push('meetings', builtin.filter(e => e.group === 'meetings').flatMap((e: SignalEntry) => (e.providers?.length ? e.providers : ['any']).map(p => ({
      key: p === 'any' ? e.key : `${e.key}:${p}`, label: p === 'any' ? `${e.label} · ${MEETING_PROVIDER_LABEL.any}` : `${e.label} · ${MEETING_PROVIDER_LABEL[p] ?? p}`, logo: p === 'any' ? undefined : p,
    }))).sort((a, b) => Number(!a.logo) - Number(!b.logo)));
    push('deals', builtin.filter(e => e.group === 'deals').map(e => ({ key: e.key, label: e.label, detail: e.description })));
    push('account', builtin.filter(e => e.group === 'account').map(e => ({ key: e.key, label: e.label, detail: e.description })));
    push('custom', (catalog?.custom ?? []).map(e => ({ key: e.key, label: e.label, detail: e.description, draft: e.active === false })));
    return out;
  }, [catalog, query]);
  const pick = (key: string | null) => { onPick(key); setOpen(false); setQuery(''); };
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger type="button" className={cn(MENU_BUTTON, selected && 'text-foreground')}><Zap className="h-3.5 w-3.5" />Signals<ChevronDown className="h-3 w-3 opacity-60" /></PopoverTrigger>
    <PopoverContent align="start" side="top" className="w-80 p-0">
      <label className="flex items-center gap-2 border-b border-border/70 px-3 py-2"><Search className="h-3.5 w-3.5 text-muted-foreground" />
        <input autoFocus aria-label="Search signals" value={query} onChange={e => setQuery(e.target.value)} placeholder="When should this job start?" className="w-full bg-transparent text-[12.5px] outline-none placeholder:text-muted-foreground/60" />
      </label>
      <div className="max-h-[320px] overflow-y-auto p-1.5">
        <SignalRow active={selected === 'schedule'} onClick={() => pick('schedule')} icon={<Clock className="h-3.5 w-3.5 text-muted-foreground" />} label="No signal (scheduled)" detail="Runs on a clock; the builder asks when." />
        {loading && <p className="px-2 py-2 text-[12px] text-muted-foreground">Loading signals…</p>}
        {error && <p role="alert" className="px-2 py-2 text-[12px] text-risk">{error}</p>}
        {groups.map(g => <div key={g.group} className="mt-1.5">
          <p className="px-2 pb-1 pt-1.5 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">{SIGNAL_GROUP_LABEL[g.group]}</p>
          {g.options.map(o => <SignalRow key={o.key} active={selected === o.key} onClick={() => pick(o.key)} label={o.label} detail={o.detail} draft={o.draft}
            icon={o.logo ? <Logo tool={o.logo} /> : <Zap className="h-3.5 w-3.5 text-muted-foreground" />} />)}
        </div>)}
        {!loading && query && !groups.length && <p className="px-2 py-2 text-[12px] text-muted-foreground">No signal matches “{query}”.</p>}
      </div>
      <div className="border-t border-border/70 p-1.5">
        <a href="/settings?section=signals&create=1" target="_blank" rel="noreferrer" onClick={() => setOpen(false)} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] text-foreground hover:bg-hover"><Plus className="h-3.5 w-3.5" />Create a signal</a>
      </div>
    </PopoverContent>
  </Popover>;
}

function SignalRow({ active, onClick, icon, label, detail, draft }: { active: boolean; onClick: () => void; icon: ReactNode; label: string; detail?: string; draft?: boolean }) {
  return <button type="button" role="menuitemradio" aria-checked={active} onClick={onClick} className={cn('flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-hover', active && 'bg-hover')}>
    <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center">{icon}</span>
    <span className="min-w-0 flex-1">
      <span className="flex items-center gap-1.5 text-[12.5px] text-foreground">{label}{draft && <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">Draft</span>}</span>
      {detail && <span className="block truncate text-[11px] text-muted-foreground">{detail}</span>}
    </span>
    {active && <Check className="mt-1 h-3.5 w-3.5 shrink-0" />}
  </button>;
}

function ToolRow({ label, state }: { label: string; state: 'running' | 'done' | 'error' }) {
  return <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
    <span className="flex h-4 w-4 shrink-0 items-center justify-center">
      {state === 'running' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : state === 'done' ? <Check className="h-3.5 w-3.5 text-emerald-600" strokeWidth={2.5} /> : <AlertCircle className="h-3.5 w-3.5 text-muted-foreground/70" />}
    </span>
    <span className={cn('truncate', state === 'running' && 'text-foreground/80')}>{label}{state === 'running' && '…'}</span>
  </div>;
}

function ErrorRow({ message, code }: { message: string; code?: string }) {
  return <div role="alert" className="flex items-start gap-2 rounded-xl border border-risk/20 bg-risk/5 px-3 py-2.5 text-[12px] text-risk">
    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
    <span className="flex-1">{message}</span>
    {code === 'insufficient_credits' && <Link to="/usage" className="shrink-0 font-medium underline underline-offset-2">Usage</Link>}
  </div>;
}

/** Array.prototype.findLastIndex, which the app's ES2020 lib does not declare. */
function lastIndex<T>(list: T[], test: (item: T) => boolean): number {
  for (let i = list.length - 1; i >= 0; i--) if (test(list[i])) return i;
  return -1;
}
