// Settings > Signals (GET-862): what can start a job. The workspace's own signals (they belong to
// the workspace, not a RevBox) and the built-in ones from the core signal catalog. A job picks one
// in the Job Builder's Signals menu; with none the builder settles the start with the user. Meeting
// signals list only the recorders the workspace has connected, as text (GET-892); with none, a muted
// line points to Integrations. The New signal dialog's Sources offer only connected tools.
//
// Built from the settings kit (SettingsGroup cards of rows) like General and Members; Settings.tsx
// wraps it in SectionShell, and the top bar names the section.
//
// A custom signal has a stable key (`custom.<key>`), set once at create. Rule changes start a new
// version and only an active rule runs. Retiring one archives it: it stops, leaves the picker, and
// its key is never reused. Opened with ?create=1 (the builder's "Create a signal"), the create
// dialog is already open.
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ChevronDown, Plus } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { SettingsGroup, SettingsRow, smallSwitchCls } from '@/components/settings/SettingsKit';
import { Logo } from '@/components/revboxes/WorkflowCard';
import { meetingSignalOptions, signalSourceChoices, MEETING_CONNECT_HINT, MEETING_CONNECT_HREF } from '@/lib/signalOptions';
import {
  revboxesRequest, signalsRequest, SIGNAL_GROUP_LABEL, TOOL_NAMES,
  type Catalog, type SignalCatalog, type SignalEntry, type SignalGroup, type WorkspaceSignal,
} from '@/lib/revboxes';

export function SignalsSettings() {
  const { session, userData } = useAuth();
  const ws = userData?.workspace?.id ?? '';
  const token = session?.access_token ?? '';
  const userId = userData?.user?.id ?? '';
  const [params, setParams] = useSearchParams();
  const catalog = useQuery({ queryKey: ['signal-catalog', ws], enabled: !!ws && !!token, queryFn: () => signalsRequest<SignalCatalog>(ws, token, '/catalog') });
  const groups = useMemo(() => (['meetings', 'deals', 'account', 'schedule'] as SignalGroup[])
    .map(group => ({ group, items: (catalog.data?.builtin ?? []).filter(e => e.group === group) }))
    .filter(g => g.items.length), [catalog.data]);

  return <>
    <YourSignals ws={ws} token={token} userId={userId} autoCreate={params.get('create') === '1'}
      onAutoCreateDone={() => { const next = new URLSearchParams(params); next.delete('create'); setParams(next, { replace: true }); }} />
    <SettingsGroup title="Built-in signals">
      {catalog.error && <p role="alert" className="px-2 py-2 text-[12.5px] text-risk">{catalog.error.message}</p>}
      {catalog.isLoading && <p className="px-2 py-2 text-[13px] text-muted-foreground/70">Loading…</p>}
      {groups.map(({ group, items }) => <div key={group}>
        <p className="px-2 pb-0.5 pt-3 text-[11.5px] text-muted-foreground/70">{SIGNAL_GROUP_LABEL[group]}</p>
        {group === 'meetings'
          // Only the recorders the workspace has connected, text only (GET-892); none: one muted line.
          ? items.flatMap((e: SignalEntry) => {
              const options = meetingSignalOptions(e);
              return options.length
                ? options.map(o => <SettingsRow key={o.key} label={o.label} hint={e.description} />)
                : [<a key={e.key} href={MEETING_CONNECT_HREF} className="block px-2 py-2 text-[12.5px] text-muted-foreground/70 hover:text-foreground">{MEETING_CONNECT_HINT}</a>];
            })
          : items.map((e: SignalEntry) => <SettingsRow key={e.key} label={e.label} hint={e.needs_config ? `${e.description} Needs a field.` : e.description} />)}
      </div>)}
    </SettingsGroup>
  </>;
}

type Draft = Partial<WorkspaceSignal>;
const STATUS = (s: WorkspaceSignal) => s.archived ? 'Archived' : s.active ? 'Active' : 'Draft';
const fieldCls = 'w-full min-w-0 rounded-lg border border-border/70 bg-card px-2.5 py-1.5 text-[13px] text-foreground outline-none transition-colors duration-fast placeholder:text-muted-foreground/45 focus:border-foreground/25 disabled:opacity-60';

/** The workspace's own signals as a settings card: list, create, edit, archive, reprocess. `boxId`
 *  records the RevBox a signal was proposed in when created from a box. */
export function YourSignals({ ws, token, userId, boxId, autoCreate = false, onAutoCreateDone }: {
  ws: string; token: string; userId: string; boxId?: string; autoCreate?: boolean; onAutoCreateDone?: () => void;
}) {
  const cache = useQueryClient();
  const list = useQuery({ queryKey: ['workspace-signals', ws], enabled: !!ws && !!token, queryFn: () => signalsRequest<{ signals: WorkspaceSignal[] }>(ws, token) });
  const members = useQuery({ queryKey: ['revbox-catalog', ws], enabled: !!ws && !!token, queryFn: () => revboxesRequest<Catalog>(ws, token, '/catalog') });
  // The connected tools, for the Sources chips (GET-892): the same query as the Built-in signals list.
  const catalog = useQuery({ queryKey: ['signal-catalog', ws], enabled: !!ws && !!token, queryFn: () => signalsRequest<SignalCatalog>(ws, token, '/catalog') });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [more, setMore] = useState(false);
  const [since, setSince] = useState(new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10));
  const [error, setError] = useState('');
  const [pending, setPending] = useState<'' | 'save' | 'archive' | 'reprocess'>('');
  const [showArchived, setShowArchived] = useState(false);
  // A new signal starts in use: its creator is the reviewer.
  const open = (d: Draft) => { setError(''); setMore(false); setDraft(d); };
  const blank = (): Draft => ({ name: '', rule: '', examples: '', sources: [], owner_id: userId, active: true });

  useEffect(() => { if (autoCreate && userId) { open(blank()); onAutoCreateDone?.(); } }, [autoCreate, userId]); // eslint-disable-line react-hooks/exhaustive-deps

  const saved = draft?.id ? list.data?.signals.find(s => s.id === draft.id) : undefined;
  const readOnly = !!saved?.archived || (!!saved && saved.owner_id !== userId);
  const ownerName = (id: string) => id === userId ? 'You' : members.data?.members.find(m => m.id === id)?.name ?? 'Member';
  const all = list.data?.signals ?? [];
  const rows = all.filter(s => showArchived || !s.archived);
  const archivedCount = all.filter(s => s.archived).length;

  async function act(kind: 'save' | 'archive' | 'reprocess') {
    if (!draft) return;
    setPending(kind); setError('');
    try {
      if (kind === 'save') {
        const body = { name: draft.name, rule: draft.rule, examples: draft.examples ?? '', sources: draft.sources ?? [], owner_id: draft.owner_id || userId, active: draft.active === true, version: draft.version, ...(draft.id ? {} : { ...(draft.key ? { key: draft.key } : {}), ...(boxId ? { revbox_id: boxId } : {}) }) };
        await signalsRequest(ws, token, draft.id ? `/${draft.id}` : '', { method: draft.id ? 'PUT' : 'POST', body: JSON.stringify(body) });
      } else if (kind === 'archive') await signalsRequest(ws, token, `/${draft.id}/archive`, { method: 'POST', body: '{}' });
      else await signalsRequest(ws, token, `/${draft.id}/reprocess`, { method: 'POST', body: JSON.stringify({ since: `${since}T00:00:00Z` }) });
      await Promise.all([cache.invalidateQueries({ queryKey: ['workspace-signals', ws] }), cache.invalidateQueries({ queryKey: ['signal-catalog', ws] })]);
      setDraft(null);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save the signal.'); }
    finally { setPending(''); }
  }

  return <>
    <SettingsGroup title="Your signals" action={<Button size="sm" variant="outline" onClick={() => open(blank())}><Plus />New signal</Button>}>
      {list.error && <p role="alert" className="px-2 py-2 text-[12.5px] text-risk">{list.error.message}</p>}
      {list.isLoading && <p className="px-2 py-2 text-[13px] text-muted-foreground/70">Loading…</p>}
      {!list.isLoading && !rows.length && <p className="px-2 py-2 text-[13px] text-muted-foreground/70">None yet. Create one for something your team listens for, like a buyer asking for a security review.</p>}
      {rows.map(s => <button key={s.id} type="button" onClick={() => open({ ...s })} className="flex min-h-12 w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors duration-fast hover:bg-hover">
        <span className="flex min-w-0 flex-1 flex-col gap-px">
          <span className={cn('truncate text-[13px]', s.archived ? 'text-muted-foreground' : 'text-foreground')}>{s.name}</span>
          <span className="truncate text-[11.5px] text-muted-foreground/70"><span className="font-mono">custom.{s.key}</span> · {ownerName(s.owner_id)} · v{s.version}</span>
        </span>
        <span className="text-[12.5px] tabular-nums text-ink-2" title="Times this signal was raised">{s.hits ?? '–'} {s.hits === 1 ? 'hit' : 'hits'}</span>
        <span className={cn('inline-flex h-[22px] w-[64px] items-center justify-center rounded-full text-[11.5px]', s.archived ? 'text-muted-foreground/60' : s.active ? 'bg-positive/10 text-positive' : 'bg-muted text-muted-foreground')}>{STATUS(s)}</span>
      </button>)}
      {archivedCount > 0 && <div className="px-2 pb-1 pt-1"><button type="button" onClick={() => setShowArchived(v => !v)} className="text-[11.5px] text-muted-foreground hover:text-foreground">{showArchived ? 'Hide archived' : `Show archived (${archivedCount})`}</button></div>}
    </SettingsGroup>

    <Dialog open={!!draft} onOpenChange={o => { if (!o) setDraft(null); }}>
      <DialogContent className="max-w-[520px] gap-3">
        <DialogHeader><DialogTitle>{draft?.id ? draft.name || 'Signal' : 'New signal'}</DialogTitle></DialogHeader>
        {draft && <div className="space-y-3">
          {readOnly && <p className="text-[12px] text-muted-foreground">{saved?.archived ? 'Archived. It no longer runs and its key stays retired.' : 'Only the owner can change this signal.'}</p>}
          <label className="block text-[12.5px] text-foreground">Name
            <input aria-label="Signal name" autoFocus disabled={readOnly} maxLength={100} className={cn(fieldCls, 'mt-1.5 h-8 py-0')} value={draft.name ?? ''} placeholder="Security review needed" onChange={e => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label className="block text-[12.5px] text-foreground">Description
            <textarea aria-label="Signal description" rows={3} disabled={readOnly} maxLength={4000} className={cn(fieldCls, 'mt-1.5 resize-none leading-relaxed')} value={draft.rule ?? ''} placeholder="The buyer asks for a security review or questionnaire before signing." onChange={e => setDraft({ ...draft, rule: e.target.value })} />
          </label>
          <div className="text-[12.5px] text-foreground">Sources <span className="text-muted-foreground/70">· optional, every source when none</span>
            {catalog.data?.connected && !signalSourceChoices(catalog.data.connected, draft.sources ?? []).length && <p className="mt-1.5 text-[12px] text-muted-foreground/70">No sources connected yet. It reads every source you connect.</p>}
            <div className="mt-1.5 flex flex-wrap gap-1.5">{signalSourceChoices(catalog.data?.connected, draft.sources ?? []).map(src => {
              const on = (draft.sources ?? []).includes(src);
              return <button key={src} type="button" disabled={readOnly} aria-pressed={on} title={TOOL_NAMES[src] ?? src}
                onClick={() => setDraft({ ...draft, sources: on ? (draft.sources ?? []).filter(x => x !== src) : [...(draft.sources ?? []), src] })}
                className={cn('inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12px] transition-colors duration-fast disabled:opacity-60', on ? 'border-foreground/25 bg-muted text-foreground' : 'border-border/70 text-muted-foreground hover:bg-hover')}>
                <Logo tool={src} size="xs" />{TOOL_NAMES[src] ?? src}
              </button>;
            })}</div>
          </div>
          <button type="button" aria-expanded={more} onClick={() => setMore(v => !v)} className="flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground">
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', more && 'rotate-180')} />More options
          </button>
          {more && <div className="space-y-3 rounded-xl bg-muted/50 p-3">
            {draft.id
              ? <p className="text-[12px] text-muted-foreground">Key <span className="font-mono text-foreground">custom.{draft.key}</span> · version {draft.version}</p>
              : <label className="block text-[12.5px] text-foreground">Key <span className="text-muted-foreground/70">· from the name, can’t change later</span>
                  <input aria-label="Signal key" className={cn(fieldCls, 'mt-1.5 h-8 py-0 font-mono')} value={draft.key ?? ''} placeholder={keyFrom(draft.name ?? '') || 'security_review'} onChange={e => setDraft({ ...draft, key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 63) })} />
                </label>}
            <label className="block text-[12.5px] text-foreground">Examples
              <textarea aria-label="Signal examples" rows={3} disabled={readOnly} maxLength={8000} className={cn(fieldCls, 'mt-1.5 resize-none leading-relaxed')} value={draft.examples ?? ''} placeholder="A few lines that should match, and one that should not." onChange={e => setDraft({ ...draft, examples: e.target.value })} />
            </label>
            <label className="block text-[12.5px] text-foreground">Owner
              <select aria-label="Signal owner" disabled={readOnly} className={cn(fieldCls, 'mt-1.5 h-8 py-0')} value={draft.owner_id || userId} onChange={e => setDraft({ ...draft, owner_id: e.target.value })}>
                {(members.data?.members ?? [{ id: userId, name: 'You', email: '' }]).map(m => <option key={m.id} value={m.id}>{m.id === userId ? `${m.name} (you)` : m.name}</option>)}
              </select>
            </label>
            {draft.id && !readOnly && saved?.active && <div>
              <label className="block text-[12.5px] text-foreground">Reprocess from
                <span className="mt-1.5 flex items-center gap-2"><input type="date" aria-label="Reprocess start date" className={cn(fieldCls, 'h-8 py-0')} value={since} onChange={e => setSince(e.target.value)} />
                  <Button type="button" variant="outline" size="sm" disabled={!!pending} onClick={() => void act('reprocess')}>{pending === 'reprocess' ? 'Starting…' : 'Reprocess'}</Button></span>
              </label>
              <p className="mt-1 text-[11.5px] text-muted-foreground/70">Re-reads past calls and emails with the saved rule. Uses credits.</p>
            </div>}
          </div>}
          <label className="flex items-center gap-2.5 text-[12.5px] text-foreground">
            <Switch aria-label="Start using it now" className={smallSwitchCls} disabled={readOnly} checked={draft.active === true} onCheckedChange={active => setDraft({ ...draft, active })} />
            Start using it now
          </label>
          {error && <p role="alert" className="text-[12px] text-risk">{error}</p>}
          {!readOnly && <div className="flex items-center gap-2 pt-1">
            {draft.id && <Button type="button" variant="ghost" size="sm" disabled={!!pending} onClick={() => void act('archive')}><Archive />{pending === 'archive' ? 'Archiving…' : 'Archive'}</Button>}
            <span className="flex-1" />
            <Button disabled={!!pending || !draft.name?.trim() || !draft.rule?.trim()} onClick={() => void act('save')}>{pending === 'save' ? 'Saving…' : draft.id ? 'Save' : 'Create signal'}</Button>
          </div>}
        </div>}
      </DialogContent>
    </Dialog>
  </>;
}

/** The key the server derives from a name (core signalKeyFrom), shown as the placeholder. */
function keyFrom(name: string): string {
  let k = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (k && !/^[a-z]/.test(k)) k = `signal_${k}`;
  return k.slice(0, 63).replace(/_+$/, '');
}
