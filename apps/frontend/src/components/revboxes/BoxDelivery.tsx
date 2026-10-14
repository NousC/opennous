// A RevBox's Delivery (GET-868): the right rail's list and the Add/Edit destination dialog.
//
// The list shows the box's own destinations (removable; every job that ends in box delivery posts to
// them at run time) and, read-only under them, every target the box's jobs deliver to on their own,
// derived by the server from the jobs' real steps (`job_deliveries`), labelled "via <job>". Those
// change through the job's Edit, never here. A `warning` row in job_deliveries (review 8) is shown
// as a small amber note under the box destination it names: a Gmail draft destination in a mailbox
// the job's owner does not own, so its drafts would fail.
//
// The dialog offers three kinds (GET-868): Slack (picked from the workspace's real channels, stored
// as the channel id with its name), Email, and Custom webhook. Email is Send (from OpenNous, kind
// 'email') or Draft (a draft in one of your own Gmail inboxes, kind 'gmail', never sent
// automatically); both take To and an optional Cc.
import { useMemo, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowUpRight, Lock, Mail, Search, Trash2, Webhook, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useMailboxes } from '@/components/MailboxPicker';
import { Logo } from '@/components/revboxes/WorkflowCard';
import { freshAccessToken } from '@/lib/freshToken';
import { cn } from '@/lib/utils';
import { deliveryLabel, recipients, type Delivery, type JobDelivery, type RevBox } from '@/lib/revboxes';

const field = 'w-full rounded-lg border border-border bg-background px-3 py-2 text-[13px] text-foreground outline-none focus:border-foreground/35 focus:ring-2 focus:ring-foreground/5 disabled:opacity-60';
const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
type Card = 'slack' | 'email' | 'webhook';
const KINDS: { kind: Card; title: string; sub: string }[] = [
  { kind: 'slack', title: 'Slack', sub: 'Post results to a channel' },
  { kind: 'email', title: 'Email', sub: 'Send from OpenNous, or draft in your Gmail' },
  { kind: 'webhook', title: 'Custom webhook', sub: 'Send results to an HTTPS endpoint' },
];
const cardOf = (d?: Delivery): Card | null => !d ? null : d.kind === 'gmail' ? 'email' : d.kind;

/** A destination's mark: the Slack and Gmail logos, a mail icon for OpenNous email, else a webhook. */
export function DeliveryMark({ kind }: { kind: string }) {
  if (kind === 'slack' || kind === 'gmail') return <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center"><Logo tool={kind} size="xs" /></span>;
  if (kind === 'email') return <Mail className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
  return <Webhook className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
}

/** A job_deliveries row that warns about a box destination instead of naming a job's own target (review 8). */
type DeliveryWarning = Omit<JobDelivery, 'kind'> & { kind: 'warning'; destination_id?: string | null };
const isWarning = (j: JobDelivery | DeliveryWarning): j is DeliveryWarning => (j.kind as string) === 'warning';

/** A destination with nothing to deliver to yet (left out at run time, dropped on Cancel). */
export const unfinished = (d: Delivery) => d.kind === 'email' ? !recipients(d.to ?? d.target).length
  : !d.target.trim() || (d.kind === 'gmail' && !recipients(d.to).length);
export function DeliveryList({ delivery, jobDeliveries, editable, onOpen, onRemove, onOpenJob }: {
  delivery: Delivery[]; jobDeliveries: (JobDelivery | DeliveryWarning)[]; editable: boolean;
  onOpen: (id: string) => void; onRemove: (id: string) => void; onOpenJob?: (job: { id: string; name: string }) => void;
}) {
  // A `warning` row (review 8) is not a target: a box Gmail destination a job cannot draft in, shown under it.
  const warnings = jobDeliveries.filter(isWarning);
  const targets = jobDeliveries.filter(j => !isWarning(j));
  if (!delivery.length && !targets.length) return <p className="px-2 py-1 text-[12px] text-muted-foreground">No destinations yet.</p>;
  return <>
    {delivery.map(d => <div key={d.id} className="mb-1 rounded-lg px-2 py-2 hover:bg-muted/50">
      <div className="flex items-center gap-2"><DeliveryMark kind={d.kind} /><button className="min-w-0 flex-1 truncate text-left text-[12px]" title={deliveryLabel(d)} onClick={() => onOpen(d.id)}>{deliveryLabel(d)}</button>{editable && <button aria-label="Remove destination" onClick={() => onRemove(d.id)}><Trash2 className="h-3 w-3 text-muted-foreground" /></button>}</div>
      {warnings.filter(w => w.destination_id === d.id).map(w => <p key={`${w.job_id}:${d.id}`} role="note" className="mt-1 flex gap-1.5 pl-[22px] text-[10.5px] leading-snug text-amber-700 dark:text-amber-400"><AlertTriangle className="mt-px h-3 w-3 shrink-0" />{w.label}</p>)}
    </div>)}
    {targets.map(j => {
      const row = <><DeliveryMark kind={j.kind} /><span className="min-w-0 flex-1"><span className="block truncate text-[12px]">{j.label}</span><span className="block truncate text-[10.5px] text-muted-foreground">via {j.job_name ?? 'a job'}</span></span></>;
      const hint = `Set in the job "${j.job_name ?? 'job'}". Change it with Edit on the job.`;
      return editable && onOpenJob
        ? <button key={`${j.job_id}:${j.kind}:${j.label}`} title={hint} onClick={() => onOpenJob({ id: j.job_id, name: j.job_name ?? 'Job' })} className="mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-muted/50">{row}</button>
        : <div key={`${j.job_id}:${j.kind}:${j.label}`} title={hint} className="mb-1 flex items-center gap-2 rounded-lg px-2 py-2">{row}</div>;
    })}
  </>;
}

type SlackChannel = { id: string; name: string; private: boolean; member: boolean };
/** Block Kit layouts a box's Slack destination can post in (the same set the Job Builder picks from). */
const SLACK_LAYOUTS = [
  { id: 'report', label: 'Report: header, summary, sections or a table' },
  { id: 'digest', label: 'Digest: a list of accounts or items' },
  { id: 'alert', label: 'Alert: something needs attention' },
  { id: 'handoff', label: 'Handoff: account, owner, deal, next steps' },
  { id: 'notification', label: 'Notification: one short update' },
  { id: 'plain', label: 'Plain text' },
];

/** The connected Slack's channels (GET /api/slack/targets), as the Slack step reads them. */
function useSlackChannels() {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? '';
  const ws = userData?.workspace?.id ?? '';
  return useQuery({
    queryKey: ['slack-targets', ws], enabled: !!token && !!ws, staleTime: 60_000,
    queryFn: async (): Promise<{ connected: boolean; channels: SlackChannel[] }> => {
      const r = await fetch(`${import.meta.env.VITE_API_URL ?? ''}/api/slack/targets?workspaceId=${encodeURIComponent(ws)}`, { headers: { Authorization: `Bearer ${await freshAccessToken() ?? token}` } });
      return r.ok ? r.json() : { connected: false, channels: [] };
    },
  });
}

/** The Add/Edit destination dialog's body. `change` is the autosaved box's patch. */
export function DeliveryDialogBody({ box, deliveryId, editable, change, onCreated }: {
  box: RevBox; deliveryId: string | null; editable: boolean; change: (patch: Partial<RevBox>) => void; onCreated: (id: string) => void;
}) {
  const mailboxes = useMailboxes();
  const current = box.delivery.find(d => d.id === deliveryId);
  const put = (patch: Partial<Delivery>) => current && change({ delivery: box.delivery.map(d => d.id === current.id ? { ...d, ...patch } : d) });
  const defaultInbox = mailboxes.data?.default_id ?? mailboxes.data?.mailboxes[0]?.id ?? '';
  const pick = (card: Card) => {
    if (cardOf(current) === card) return;
    // Switching kind clears what the old kind needed. Email starts as Send.
    const id = current?.id ?? crypto.randomUUID();
    const fresh: Delivery = card === 'email' ? { id, kind: 'email', target: '', to: '', cc: '' } : { id, kind: card, target: '' };
    if (current) change({ delivery: box.delivery.map(d => d.id === current.id ? fresh : d) });
    else { change({ delivery: [...box.delivery, fresh] }); onCreated(fresh.id); }
  };
  const mine = mailboxes.data?.mailboxes ?? [];
  // Another member's mailbox on an existing destination stays listed (it can only be replaced by one of yours).
  const options = current?.kind === 'gmail' && current.target && !mine.some(m => m.id === current.target)
    ? [{ id: current.target, email: current.mailbox_email ?? 'Another member’s Gmail' }, ...mine] : mine;
  const to = current?.kind === 'email' ? current.to ?? current.target : current?.to ?? '';
  // Send <-> Draft keeps the recipients; Draft starts in your default inbox.
  const mode = (m: 'send' | 'draft') => {
    if (!current) return;
    if (m === 'draft' && current.kind !== 'gmail') put({ kind: 'gmail', target: defaultInbox, to, cc: current.cc ?? '' });
    if (m === 'send' && current.kind !== 'email') put({ kind: 'email', target: to, to, cc: current.cc ?? '', mailbox_email: undefined });
  };
  return <div className="space-y-4">
    <div className="grid grid-cols-3 gap-2">{KINDS.map(k => <button key={k.kind} disabled={!editable} onClick={() => pick(k.kind)} className={cn('rounded-xl border px-3.5 py-3.5 text-left text-[13px] transition-colors disabled:opacity-60', cardOf(current) === k.kind ? 'border-foreground/40 bg-muted/60' : 'border-border hover:bg-muted/40')}><span className="flex items-center gap-2 font-medium"><DeliveryMark kind={k.kind} />{k.title}</span><span className="mt-1 block text-[11px] leading-snug text-muted-foreground">{k.sub}</span></button>)}</div>
    {current?.kind === 'slack' && <SlackChannelPicker value={current} editable={editable} onPick={c => put({ target: c.id, channel: c.name, ...(current.format ? {} : { format: 'report' }) })} />}
    {current?.kind === 'slack' && (
      <label className="mt-3 block">
        <span className="mb-1 block text-[12px] font-medium text-foreground">Layout</span>
        <select disabled={!editable} value={current.format ?? 'plain'} onChange={e => put({ format: e.target.value })}
          className="h-9 w-full rounded-lg border border-border bg-background px-2.5 text-[13px] text-foreground outline-none focus:border-foreground/30">
          {SLACK_LAYOUTS.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
        </select>
        <span className="mt-1 block text-[11.5px] text-muted-foreground">How the message looks in Slack. Jobs that set their own layout keep theirs.</span>
      </label>
    )}
    {current?.kind === 'webhook' && <label className="block text-[12px] font-medium">Webhook URL<input aria-label="Webhook URL" disabled={!editable} className={cn(field, 'mt-2')} value={current.target} placeholder="https://example.com/webhook" onChange={e => put({ target: e.target.value })} /></label>}
    {current && (current.kind === 'email' || current.kind === 'gmail') && <>
      <div role="radiogroup" aria-label="Email mode" className="flex w-fit gap-1 rounded-lg bg-muted/70 p-1">
        {(['send', 'draft'] as const).map(m => { const on = (m === 'draft') === (current.kind === 'gmail'); return <button key={m} type="button" role="radio" aria-checked={on} disabled={!editable} onClick={() => mode(m)} className={cn('rounded-md px-3 py-1.5 text-[12px]', on ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>{m === 'send' ? 'Send' : 'Draft'}</button>; })}
      </div>
      {current.kind === 'gmail' && <label className="block text-[12px] font-medium">Inbox
        {mailboxes.data && !options.length
          ? <span className="mt-2 flex items-center gap-2 text-[12px] font-normal text-muted-foreground">No Gmail connected.<Link to="/company-sources?connect=gmail" className="inline-flex items-center gap-1 text-foreground underline-offset-2 hover:underline">Connect Gmail<ArrowUpRight className="h-3 w-3" /></Link></span>
          : <select aria-label="Inbox" disabled={!editable || !mailboxes.data} className={cn(field, 'mt-2')} value={current.target} onChange={e => put({ target: e.target.value })}>{!current.target && <option value="">Choose an inbox</option>}{options.map(m => <option key={m.id} value={m.id}>{m.email ?? 'Gmail'}</option>)}</select>}
      </label>}
      <AddressField label="To" required value={to} editable={editable} onChange={v => put(current.kind === 'email' ? { to: v, target: v } : { to: v })} />
      <AddressField label="CC" value={current.cc ?? ''} editable={editable} onChange={v => put({ cc: v })} />
      <p className="text-[11px] text-muted-foreground">{current.kind === 'email' ? 'Sent from OpenNous after each run.' : 'Each run leaves a draft in this inbox. Nothing is sent until you send it.'}</p>
    </>}
  </div>;
}

/** The workspace's Slack channels, searchable. A legacy destination typed as a name stays shown. */
function SlackChannelPicker({ value, editable, onPick }: { value: Delivery; editable: boolean; onPick: (c: SlackChannel) => void }) {
  const slack = useSlackChannels();
  const [query, setQuery] = useState('');
  const channels = useMemo(() => {
    const needle = query.trim().replace(/^#/, '').toLowerCase();
    return (slack.data?.channels ?? []).filter(c => !needle || c.name.toLowerCase().includes(needle)).slice(0, 100);
  }, [slack.data, query]);
  if (slack.data && !slack.data.connected) return <p className="flex items-center gap-2 text-[12px] text-muted-foreground">Slack isn’t connected.<Link to="/company-sources?connect=slack" className="inline-flex items-center gap-1 text-foreground underline-offset-2 hover:underline">Connect Slack<ArrowUpRight className="h-3 w-3" /></Link></p>;
  const known = (slack.data?.channels ?? []).some(c => c.id === value.target);
  return <div className="text-[12px]">
    <p className="font-medium">Slack channel</p>
    {value.target && !known && <p className="mt-1.5 text-[11.5px] text-muted-foreground">Now: {deliveryLabel(value)}</p>}
    <label className="mt-2 flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 focus-within:border-foreground/35"><Search className="h-3.5 w-3.5 text-muted-foreground" />
      <input aria-label="Search Slack channels" disabled={!editable} value={query} onChange={e => setQuery(e.target.value)} placeholder="Find a channel" className="w-full bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/70" />
    </label>
    <div role="listbox" aria-label="Slack channels" className="mt-1.5 max-h-52 overflow-y-auto rounded-lg border border-border/70 p-1">
      {slack.isLoading && <p className="px-2 py-2 text-muted-foreground">Loading channels…</p>}
      {channels.map(c => <button key={c.id} type="button" role="option" aria-selected={value.target === c.id} disabled={!editable} onClick={() => onPick(c)} className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted', value.target === c.id && 'bg-muted')}>
        {c.private ? <Lock aria-label="Private channel" className="h-3 w-3 shrink-0 text-muted-foreground" /> : <span className="w-3 shrink-0 text-center text-muted-foreground">#</span>}
        <span className="min-w-0 flex-1 truncate text-[12.5px]">{c.name}</span>
        {!c.member && <span className="shrink-0 text-[10.5px] text-muted-foreground">bot not in channel</span>}
      </button>)}
      {!slack.isLoading && !channels.length && <p className="px-2 py-2 text-muted-foreground">{query ? `No channel matches “${query}”.` : 'No channels found.'}</p>}
    </div>
  </div>;
}

/** Addresses as chips: Enter, comma or leaving the field adds what was typed once it is an address. */
function AddressField({ label, value, editable, required, onChange }: { label: string; value: string; editable: boolean; required?: boolean; onChange: (v: string) => void }) {
  const list = recipients(value);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const commit = () => {
    const typed = recipients(draft);
    if (!typed.length) return true;
    const bad = typed.find(a => !EMAIL.test(a));
    if (bad) { setError(`"${bad}" is not an email address.`); return false; }
    onChange([...list, ...typed.filter(a => !list.includes(a))].join(', ')); setDraft(''); setError(''); return true;
  };
  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ';') { e.preventDefault(); commit(); }
    else if (e.key === 'Backspace' && !draft && list.length) onChange(list.slice(0, -1).join(', '));
  };
  return <div className="text-[12px]">
    <label className="font-medium" htmlFor={`addr-${label}`}>{label}{!required && <span className="ml-1 font-normal text-muted-foreground">optional</span>}</label>
    <div className="mt-2 flex min-h-[38px] flex-wrap items-center gap-1.5 rounded-lg border border-border bg-background px-2 py-1.5 focus-within:border-foreground/35">
      {list.map(a => <span key={a} className="inline-flex h-6 items-center gap-1 rounded-full bg-muted pl-2.5 pr-1 text-[12px]">{a}{editable && <button type="button" aria-label={`Remove ${a}`} onClick={() => onChange(list.filter(x => x !== a).join(', '))} className="flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground"><X className="h-3 w-3" /></button>}</span>)}
      <input id={`addr-${label}`} aria-label={label} disabled={!editable} value={draft} onChange={e => { setDraft(e.target.value); setError(''); }} onKeyDown={key} onBlur={commit}
        placeholder={list.length ? '' : 'name@company.com'} className="min-w-[140px] flex-1 bg-transparent px-1 text-[13px] outline-none placeholder:text-muted-foreground/70" />
    </div>
    {error ? <p role="alert" className="mt-1.5 text-[11px] text-risk">{error}</p> : required && !list.length && <p className="mt-1.5 text-[11px] text-muted-foreground">Add at least one address.</p>}
  </div>;
}
