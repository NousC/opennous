import { CustomSignals } from '@/components/revboxes/CustomSignals';
import { RevBoxResults } from '@/components/revboxes/RevBoxResults';
import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowUpRight, Boxes, Check, ChevronDown, ChevronRight, Clock3, FileText, Flag, Globe2, LockKeyhole, Network, Plus, Save, Settings2, ShieldCheck, Sparkles, Trash2, Upload, Users, Webhook, Zap } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { JobBuilder } from '@/components/revboxes/JobBuilder';
import { RevBoxJobs, jobRows, type JobRow } from '@/components/revboxes/RevBoxJobs';
import { DeliveryDialogBody, DeliveryList, JobStepDialog, unfinished } from '@/components/revboxes/BoxDelivery';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { PersonAvatar } from '@/components/ui/owner-filter';
import { AccountLogo } from '@/components/pipeline/DealBits';
import { Switch } from '@/components/ui/switch';
import { useAutosavedRevbox } from '@/components/revboxes/useAutosavedRevbox';
import { when } from '@/lib/format';
import { cn } from '@/lib/utils';
import { revboxesRequest, SCOPE_LABELS, BUILTIN_JOBS, type RevBox, type BoxDetail, type BoxPerson, type Catalog, type ContextFile, type JobDelivery } from '@/lib/revboxes';

const field = 'w-full rounded-lg border border-border bg-background px-3 py-2 text-[13px] text-foreground outline-none focus:border-foreground/35 focus:ring-2 focus:ring-foreground/5 disabled:opacity-60';
const small = 'text-[12px] text-muted-foreground';
const toolNames: Record<string, string> = { granola: 'Granola', fireflies: 'Fireflies', fathom: 'Fathom', hubspot: 'HubSpot', attio: 'Attio', gmail: 'Gmail', slack: 'Slack', instantly: 'Instantly' };

export default function RevBoxes() {
  const { id } = useParams();
  const { session, userData } = useAuth();
  const workspaceId = userData?.workspace?.id ?? '';
  const token = session?.access_token ?? '';
  if (!token || !workspaceId) return <div className="p-8 text-muted-foreground">Loading workspace…</div>;
  return id ? <RevBoxDetail key={`${workspaceId}:${id}`} id={id} ws={workspaceId} token={token} userId={userData?.user?.id} /> : <Navigate to="/" replace />;
}

function RevBoxDetail({ id, ws, token, userId }: { id: string; ws: string; token: string; userId: string }) {
  // A box just created from the sidebar opens with its name empty and focused (GET-868): the name is
  // the first thing to set. Leaving it empty keeps "Untitled RevBox".
  const [params, setParams] = useSearchParams();
  const naming = params.get('new') === '1';
  const endNaming = () => { if (naming) { const next = new URLSearchParams(params); next.delete('new'); setParams(next, { replace: true }); } };
  const cache = useQueryClient();
  const detail = useQuery({ queryKey: ['revbox', ws, id], queryFn: () => revboxesRequest<BoxDetail>(ws, token, `/${id}`) });
  const catalog = useQuery({ queryKey: ['revbox-catalog', ws], queryFn: () => revboxesRequest<Catalog>(ws, token, '/catalog') });
  const { box, change, save, dirty, saving, saveError } = useAutosavedRevbox(detail.data?.box, ws, token, id);
  const [acting,setActing]=useState(false);
  const [notice,setNotice]=useState('');
  const [webhookKey,setWebhookKey]=useState<string|null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'jobs' | 'results'>('jobs');
  // A job's own delivery target, edited from the Delivery rail (GET-872).
  const [jobStep, setJobStep] = useState<JobDelivery | null>(null);
  // The Job Builder (GET-868) replaces the jobs list while it is open: null = closed, job = null
  // for a new job, else Edit on that job.
  const [builder, setBuilder] = useState<{ job: { id: string; name: string } | null } | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'members' | 'context' | 'accounts' | 'block' | 'delivery' | null>(null);
  const [contextTab, setContextTab] = useState<'context' | 'signals'>('context');
  const [blockId, setBlockId] = useState<string | null>(null);
  const [deliveryId, setDeliveryId] = useState<string | null>(null);
  const [file, setFile] = useState<ContextFile | null>(null);
  const [accountSearch, setAccountSearch] = useState('');
  const uploader = useRef<HTMLInputElement>(null);
  const accounts = useQuery({ queryKey: ['revbox-accounts', ws, id, detail.data?.box.revision], queryFn: () => revboxesRequest<{ accounts: Catalog['accounts'] }>(ws, token, `/${id}/accounts`), enabled: !!detail.data });
  const runCounts=useQuery({queryKey:['revbox-results',ws,id],queryFn:()=>revboxesRequest<{results:{job_id:string;state:string;created_at:string;result:{kind:string}|null}[]}>(ws,token,`/${id}/results`),enabled:!!detail.data,refetchInterval:10000});
  const editable = box?.access !== 'viewer';
  const owner = catalog.data?.members.find(m => m.id === box?.owner_id);
  // The Owners rail's people with their photos (GET-872); the catalog's names when an older server sends none.
  const people: BoxPerson[] = detail.data?.people ?? (box ? [{ id: box.owner_id, role: 'owner' as const, name: owner?.name ?? null, email: null, avatar_url: null }, ...(box.members ?? []).map(m => ({ id: m.user_id, role: m.role, name: catalog.data?.members.find(u => u.id === m.user_id)?.name ?? null, email: null, avatar_url: null }))] : []);
  const builtins = detail.data?.builtin_jobs ?? [];
  const taken = new Map((detail.data?.builtin_taken ?? []).map(t => [t.key, t]));
  const addable = BUILTIN_JOBS.filter(b => !builtins.some(x => x.key === b.key));
  const rows = jobRows(detail.data?.jobs ?? [], detail.data?.routines);
  async function jobAction(row: JobRow, path: string, method: string, body?: object) { setBusy(row.id); try { await action(`/jobs/${row.id}${path}`, method, body); if (path === '/enabled') setFresh(f => f === row.id ? null : f); } finally { setBusy(null); } }
  // Everything a job change shows: the box detail (jobs, and job_deliveries for the Delivery rail),
  // the sidebar list, the context library and the Results tab. Refetched now, not on the next load.
  async function reload() { await Promise.all([cache.invalidateQueries({ queryKey: ['revbox', ws, id] }), cache.invalidateQueries({ queryKey: ['revboxes', ws] }), cache.invalidateQueries({ queryKey: ['revbox-context-library', ws] }), cache.invalidateQueries({ queryKey: ['revbox-results', ws, id] })]); }
  async function action(path: string, method: string, body?: object) {
    setError('');setActing(true);
    try { if (dirty) await save(); await revboxesRequest(ws, token, `/${id}${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) }); await reload(); if(path.endsWith('/run')){setNotice('Run queued. Open Results to follow its progress.');await cache.invalidateQueries({queryKey:['revbox-results',ws,id]});} }
    catch (e) { setError(message(e)); }finally{setActing(false);}
  }
  // Built-in jobs are listed on the box (GET-872): a separate save, so a clash (409, it is in
  // another box) shows as an error instead of blocking the autosave.
  async function setBuiltins(keys: string[]) {
    setError('');
    try {
      const saved = dirty ? await save() : null;
      await revboxesRequest(ws, token, `/${id}`, { method: 'PATCH', body: JSON.stringify({ builtin_jobs: keys, revision: saved?.revision ?? box!.revision }) });
      await reload();
    } catch (e) { setError(message(e)); }
  }
  async function upload(files: FileList | null) {
    if (!files?.[0]) return;
    const f = files[0];
    if (f.size > 262144 || !/\.(md|txt|csv|json)$/i.test(f.name)) { setError('Choose a Markdown, text, CSV or JSON reference up to 256 KB.'); return; }
    await action('/context', 'POST', { title: f.name, body: await f.text() });
    if (uploader.current) uploader.current.value = '';
  }
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  if (detail.isLoading || !box) return detail.error ? <div className="p-8"><ErrorLine text={message(detail.error)} /><Link to="/revboxes" className={small}>Back to RevBoxes</Link></div> : <p className="p-8 text-[13px] text-muted-foreground">Loading RevBox…</p>;
  return <div className="flex h-full min-h-0 flex-col bg-background">
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-6 text-[12px] text-muted-foreground"><Link to="/">Nous</Link><ChevronRight className="h-3 w-3" /><span>RevBoxes</span><ChevronRight className="h-3 w-3" /><span className="truncate font-medium text-foreground">{box.name}</span></div>
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto xl:flex-row xl:overflow-hidden">
      <main className="flex min-h-[450px] min-w-0 flex-1 flex-col xl:overflow-hidden">
        <header className="px-6 pb-5 pt-8 md:px-10 md:pt-10">
          <div className="flex items-start justify-between gap-4"><input aria-label="RevBox name" autoFocus={naming} placeholder="Name this RevBox" value={naming && box.name === 'Untitled RevBox' ? '' : box.name} maxLength={120} disabled={!editable} onChange={e => change({ name: e.target.value })} onBlur={e => { if (!e.currentTarget.value.trim()) change({ name: 'Untitled RevBox' }); endNaming(); void save().catch(() => {}); }} onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }} className="min-w-0 flex-1 bg-transparent text-[28px] font-semibold tracking-tight outline-none placeholder:text-muted-foreground/50" /><span aria-live="polite" className="mt-2 text-[10px] text-muted-foreground">{saving ? 'Saving…' : dirty ? 'Unsaved' : ''}</span></div>
          <div className="mt-3 flex flex-wrap gap-2 text-[11px]"><span className="flex items-center gap-1.5 rounded-md bg-muted/70 px-2 py-1">{box.shared ? <Users className="h-3 w-3" /> : <LockKeyhole className="h-3 w-3" />}{box.shared ? 'Shared' : 'Private'}</span><span className="flex items-center gap-1.5 rounded-md bg-muted/70 px-2 py-1"><span className="h-1.5 w-1.5 rounded-full bg-amber-600" />Created by {owner?.name ?? 'you'}</span><span className="flex items-center gap-1.5 rounded-md bg-muted/70 px-2 py-1"><Clock3 className="h-3 w-3" />Updated {when(box.updated_at)}</span></div>
          {notice&&<p role="status" className="mt-3 text-[12px] text-muted-foreground">{notice}</p>}
          {(error || saveError || catalog.error || accounts.error) && <div className="mt-3"><ErrorLine text={error || saveError || message(catalog.error || accounts.error)} /></div>}
        </header>
        <div className="flex items-center justify-between px-6 pb-3 md:px-10"><div className="flex gap-5">{(['jobs', 'results'] as const).map(t => <button key={t} onClick={() => setTab(t)} className={cn('py-1 text-[13px]', tab === t ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}>{t === 'jobs' ? 'Jobs' : 'Results'}</button>)}</div><div className="flex items-center gap-2">{builder && tab === 'jobs' && <button className="text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setBuilder(null)}>Back to jobs</button>}{editable && !builder && <div className="flex"><Button variant="outline" size="sm" className="rounded-r-none" onClick={() => { setTab('jobs'); setFresh(null); setNotice(''); setBuilder({ job: null }); }}><Plus />New job</Button>
            <DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline" size="sm" aria-label="More ways to add a job" className="-ml-px rounded-l-none px-1.5"><ChevronDown /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72">
                <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">Add built-in job · run by OpenNous</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {addable.length ? addable.map(b => { const other = taken.get(b.key); return <DropdownMenuItem key={b.key} disabled={!!other} onSelect={() => { setTab('jobs'); void setBuiltins([...builtins.map(x => x.key), b.key]); }} className="flex-col items-start gap-0.5">
                  <span className="text-[12.5px]">{b.name} <span className="text-muted-foreground">· {b.cadence}</span></span>
                  <span className="text-[11px] leading-snug text-muted-foreground">{other ? `Already in ${other.box_name ? `“${other.box_name}”` : 'another RevBox'}` : b.does}</span>
                </DropdownMenuItem>; }) : <p className="px-2 py-1.5 text-[11.5px] text-muted-foreground">Every built-in job is in this box.</p>}
              </DropdownMenuContent></DropdownMenu></div>}</div></div>
        <div className="flex min-h-0 flex-1 flex-col">{tab === 'results' ? <div className="min-h-0 flex-1 overflow-y-auto px-6 py-3 md:px-10"><RevBoxResults ws={ws} token={token} boxId={id} editable={editable} jobs={rows} /></div> : <>
          {builder
            ? <JobBuilder key={builder.job?.id ?? 'new'} workspaceId={ws} token={token} boxId={id} job={builder.job} destinations={box.delivery} editable={editable}
                onClose={() => setBuilder(null)}
                onApproved={async ({ routine, enabled, reason }) => { setBuilder(null); setFresh(routine.id); setNotice(enabled === false ? `${routine.name} was saved but is off: ${reason ?? 'it could not be switched on.'}` : `${routine.name} is on.`); await reload(); }} />
            : <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-1 md:px-10"><RevBoxJobs rows={rows} runs={runCounts.data?.results ?? []} editable={editable} busy={busy} fresh={fresh}
                onNew={() => setBuilder({ job: null })}
                onToggle={row => void jobAction(row, '/enabled', 'PUT', { enabled: !row.enabled })}
                onChange={row => setBuilder({ job: { id: row.id, name: row.name } })}
                onWebhookKey={row => void revboxesRequest<{ key: string }>(ws, token, `/${id}/jobs/${row.id}/webhook-key`, { method: 'POST' }).then(r => setWebhookKey(r.key)).catch(e => setError(message(e)))}
                builtins={builtins} onRemoveBuiltin={key => void setBuiltins(builtins.map(b => b.key).filter(k => k !== key))} /></div>}
        </>}</div>
      </main>
      <aside className="shrink-0 space-y-4 border-t border-border px-5 py-7 xl:w-[350px] xl:overflow-y-auto xl:border-l xl:border-t-0 xl:py-10">
        <RailSection title="Context" sub="What every job here should know." icon={FileText} action={editable && <button aria-label="Configure context" onClick={() => { setContextTab('context'); setDialog('context'); }} className="rounded p-1 hover:bg-muted"><Plus className="h-4 w-4" /></button>}>

          {box.blocks.map(b => <div key={b.id} className="group mb-1 flex items-center gap-2 rounded-lg px-2 py-2.5 hover:bg-muted/50"><FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /><button onClick={() => { setBlockId(b.id); setDialog('block'); }} className="min-w-0 flex-1 truncate text-left text-[12px]">{b.title}</button>{editable && <button aria-label={`Remove ${b.title}`} onClick={() => change({blocks:box.blocks.filter(x=>x.id!==b.id)})} className="text-muted-foreground hover:text-risk"><Trash2 className="h-3 w-3" /></button>}</div>)}
          {detail.data?.context.map(c => <div key={c.id} className="group mb-1 flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-muted"><FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /><button onClick={() => setFile(c)} className="min-w-0 flex-1 truncate text-left text-[12px]">{c.title}</button>{editable && <button aria-label={`Remove ${c.title}`} onClick={() => void action(`/context/${c.id}`, 'DELETE')} className="text-muted-foreground hover:text-risk"><Trash2 className="h-3 w-3" /></button>}</div>)}
          {editable && <Button variant="ghost" size="sm" className="mt-2 w-full justify-start text-muted-foreground" onClick={() => uploader.current?.click()}><Upload />Upload a reference</Button>}
          <input ref={uploader} type="file" className="hidden" accept=".md,.txt,.csv,.json" onChange={e => void upload(e.target.files)} />
        </RailSection>
        <RailSection title="Accounts" sub="The accounts this box works on." icon={Globe2}>
          <div className="space-y-1"><Link to={`/accounts?revbox=${id}`} onClick={e => { if (dirty) { e.preventDefault(); void save().then(() => window.location.assign(`/accounts?revbox=${id}`)).catch(() => {}); } }} className="flex items-center gap-2 rounded-lg px-1 py-2.5 text-[12px] hover:bg-muted/50"><span className="flex-1">{SCOPE_LABELS[box.scope.mode]}</span><span className="text-[11px] text-muted-foreground">{accounts.data?.accounts.length ?? '…'} accounts</span><ArrowUpRight className="h-3 w-3 text-muted-foreground" /></Link><Link to={`/graph?revbox=${id}`} onClick={e => { if (dirty) { e.preventDefault(); void save().then(() => window.location.assign(`/graph?revbox=${id}`)).catch(() => {}); } }} className="flex items-center gap-2 rounded-lg px-1 py-2.5 text-[12px] hover:bg-muted/50"><span className="flex-1">Account graph</span><ArrowUpRight className="h-3 w-3 text-muted-foreground" /></Link></div>
          <RunAccounts boxId={id} detail={detail.data} />
        </RailSection>
        <RailSection title="Delivery" sub="Where finished work goes." icon={ArrowUpRight} action={editable && <button aria-label="Add delivery destination" className="rounded p-1 hover:bg-muted" onClick={() => { setDeliveryId(null); setDialog('delivery'); }}><Plus className="h-4 w-4" /></button>}>
          {/* The box's own destinations, then where its jobs deliver on their own (GET-868, read-only: Edit on the job). */}
          <DeliveryList delivery={box.delivery} jobDeliveries={detail.data?.job_deliveries ?? []} editable={editable}
            onOpen={deliveryId => { setDeliveryId(deliveryId); setDialog('delivery'); }}
            onRemove={deliveryId => change({ delivery: box.delivery.filter(x => x.id !== deliveryId) })}
            onOpenJob={job => { setTab('jobs'); setFresh(null); setBuilder({ job }); }}
            onOpenJobStep={editable ? setJobStep : undefined} />
        </RailSection>
        <RailSection title="Owners" icon={Users} action={box.access === "owner" && <button aria-label="Add RevBox member" onClick={() => setDialog("members")} className="rounded p-1 hover:bg-muted"><Plus className="h-4 w-4" /></button>}>
          {people.map(p => <MemberLine key={p.id} id={p.id} avatar={p.avatar_url} name={p.name ?? (p.role === 'owner' ? 'Creator' : 'Member')} sub={p.role === 'owner' ? 'Owner' : p.role === 'editor' ? 'Editor' : 'Viewer'} />)}
          <label className="mt-3 flex items-center justify-between border-t border-border pt-3 text-[12px]">Shared with team<Switch aria-label="Share RevBox with team" checked={box.shared} disabled={box.access !== 'owner'} onCheckedChange={shared => change({ shared })} /></label>
        </RailSection>
      </aside>
    </div>
    <Dialog open={dialog !== null} onOpenChange={open => { if (!open) setDialog(null); }}><DialogContent className="max-h-[85vh] gap-0 overflow-hidden p-0 sm:max-w-[560px]"><div className="px-6 pb-4 pt-5"><DialogHeader><DialogTitle className="text-[16px] font-medium">{dialog === 'members' ? 'RevBox members' : dialog === 'context' ? (contextTab === 'signals' ? 'Workspace signals' : 'Context') : dialog === 'block' ? 'Edit context' : dialog === 'delivery' ? (deliveryId ? 'Edit destination' : 'Add destination') : 'Account scope'}</DialogTitle><DialogDescription className="mt-1 text-[12px]">{dialog === 'members' ? 'Choose who can work in this RevBox.' : dialog === 'context' ? (contextTab === 'signals' ? 'Create reusable signal rules for this workspace.' : 'Add instructions and references for this RevBox.') : dialog === 'block' ? 'Changes save automatically.' : dialog === 'delivery' ? 'New destinations apply to this box’s jobs.' : 'Jobs use this account scope.'}</DialogDescription></DialogHeader>{dialog === 'context' && <div className="mt-4 flex w-fit gap-1 rounded-lg bg-muted/70 p-1"><button onClick={() => setContextTab('context')} className={cn('rounded-md px-3 py-1.5 text-[12px]', contextTab === 'context' ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground')}>Context</button><button onClick={() => setContextTab('signals')} className={cn('rounded-md px-3 py-1.5 text-[12px]', contextTab === 'signals' ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground')}>Signals</button></div>}</div><div className="max-h-[calc(85vh-140px)] overflow-y-auto border-y border-border/60 px-6 py-5">
      {dialog === 'block' && box.blocks.filter(b => b.id === blockId).map(b => <div key={b.id} className="space-y-4"><label className="block text-[12px]">Title<input aria-label="Context block title" disabled={!editable} className={cn(field,'mt-2')} value={b.title} onChange={e=>change({blocks:box.blocks.map(x=>x.id===b.id?{...x,title:e.target.value}:x)})} /></label><label className="block text-[12px]">Instructions<textarea aria-label={`${b.title} context`} disabled={!editable} className={cn(field,'mt-2 resize-y')} rows={7} value={b.body} onChange={e=>change({blocks:box.blocks.map(x=>x.id===b.id?{...x,body:e.target.value}:x)})} /></label></div>)}
      {dialog === 'members' && <div className="space-y-3">{catalog.data?.members.map(m => { const membership = box.members?.find(u => u.user_id === m.id); return <div key={m.id} className="flex items-center gap-3"><MemberLine id={m.id} avatar={people.find(p => p.id === m.id)?.avatar_url ?? null} name={m.name} sub={m.email} />{m.id === box.owner_id ? <span className={small}>Owner</span> : <select aria-label={`Access for ${m.name}`} className="rounded border border-border bg-background px-2 py-1.5 text-[12px]" disabled={box.access !== 'owner'} value={membership?.role ?? ''} onChange={e => void action(`/members/${m.id}`, 'PUT', { role: e.target.value || null })}><option value="">{box.shared ? 'Team viewer' : 'Not invited'}</option><option value="viewer">Viewer</option><option value="editor">Editor</option></select>}</div>; })}</div>}
      {dialog === 'delivery' && <DeliveryDialogBody box={box} deliveryId={deliveryId} editable={editable} change={change} onCreated={setDeliveryId} />}
      {dialog === 'context' && contextTab === 'context' && <div><label className="mb-5 block text-[12px] font-medium">Objective<textarea aria-label="RevBox objective" className={cn(field, "mt-2 font-normal")} rows={2} value={box.objective} onChange={e => change({objective:e.target.value})} placeholder="What should this RevBox accomplish?" /></label><div className="mb-5"><div className="mb-2 flex items-center justify-between"><p className="text-[11px] font-medium text-muted-foreground">Instructions</p><span className="text-[10px] text-muted-foreground">Add a reusable block</span></div><div className="flex flex-wrap gap-2">{['Goals & KPIs', 'ICP', 'Email voice', 'Output format', 'Reference notes', 'Custom instructions'].map(title => <Button key={title} size="sm" variant="outline" className="h-8 rounded-lg text-[11px]" onClick={() => { const newId=crypto.randomUUID(); change({ blocks: [...box.blocks, { id:newId, title, body: '' }] }); setBlockId(newId); setDialog('block'); }}><Plus className="h-3 w-3" />{title}</Button>)}</div></div><p className="mb-2 text-[11px] font-medium text-muted-foreground">Attached context</p><div className="mb-3 space-y-1">{box.blocks.map(b => <div key={b.id} className="flex items-center gap-2 rounded-lg border border-border/70 px-3 py-2"><FileText className="h-4 w-4 shrink-0 text-muted-foreground"/><button onClick={()=>{setBlockId(b.id);setDialog('block');}} className="min-w-0 flex-1 truncate text-left text-[12px]">{b.title}</button><button aria-label={`Remove ${b.title}`} onClick={()=>change({blocks:box.blocks.filter(x=>x.id!==b.id)})} className="text-muted-foreground hover:text-risk"><Trash2 className="h-3.5 w-3.5"/></button></div>)}{detail.data?.context.map(c=><div key={c.id} className="flex items-center gap-2 rounded-lg border border-border/70 px-3 py-2"><FileText className="h-4 w-4 shrink-0 text-muted-foreground"/><span className="min-w-0 flex-1 truncate text-[12px]">{c.title}</span><button aria-label={`Remove ${c.title}`} onClick={()=>void action(`/context/${c.id}`,'DELETE')} className="text-muted-foreground hover:text-risk"><Trash2 className="h-3.5 w-3.5"/></button></div>)}</div><p className="mb-2 text-[11px] font-medium text-muted-foreground">Add from your library</p><div className="max-h-40 space-y-1 overflow-y-auto rounded-xl border border-border/70 p-1">{catalog.data?.documents.length ? catalog.data.documents.map(d => { const attached = detail.data?.context.some(c => c.document_id === d.id); return <button key={d.id} disabled={attached || !editable} onClick={() => void action('/context', 'POST', { document_id: d.id }).then(() => setDialog(null))} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] hover:bg-muted disabled:opacity-50"><FileText className="h-4 w-4 shrink-0 text-muted-foreground"/><span className="flex-1 truncate">{d.title}</span>{attached ? <Check className="h-3.5 w-3.5"/> : <Plus className="h-3.5 w-3.5"/>}</button>; }) : <p className="px-2 py-3 text-[11px] text-muted-foreground">No documents in your library yet.</p>}</div><Button variant="outline" className="mt-3 w-full rounded-xl" onClick={() => { setDialog(null); uploader.current?.click(); }}><Upload/>Upload reference</Button><p className="mt-2 text-center text-[10px] text-muted-foreground">Markdown, text, CSV or JSON · up to 256 KB</p></div>}
      {dialog === 'context' && contextTab === 'signals' && <CustomSignals ws={ws} token={token} boxId={id} userId={userId} />}
      {dialog === 'accounts' && <div className="space-y-4"><label className="block text-[12px]">Filter<select className={cn(field, 'mt-2')} aria-label="Account filter" value={box.scope.mode} onChange={e => change({ scope: { ...box.scope, mode: e.target.value as RevBox['scope']['mode'] } })}>{Object.entries(SCOPE_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>{box.scope.mode === 'icp' && <label className="block text-[12px]">Minimum ICP score<input aria-label="Minimum ICP score" type="number" min={0} max={100} className={cn(field, 'mt-2')} value={box.scope.min_icp} onChange={e => change({ scope: { ...box.scope, min_icp: Number(e.target.value) } })} /></label>}{box.scope.mode === 'selected' && <><input aria-label="Find accounts to add" className={field} placeholder="Find an account…" value={accountSearch} onChange={e => setAccountSearch(e.target.value)} /><div className="max-h-64 space-y-1 overflow-y-auto">{catalog.data?.accounts.filter(a => `${a.name} ${a.domain ?? ''}`.toLowerCase().includes(accountSearch.toLowerCase())).map(a => <label key={a.id} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted"><input type="checkbox" checked={box.scope.account_ids.includes(a.id)} onChange={e => change({ scope: { ...box.scope, account_ids: e.target.checked ? [...box.scope.account_ids, a.id] : box.scope.account_ids.filter(x => x !== a.id) } })} /><span className="flex-1 text-[13px]">{a.name}</span><span className="text-[11px] text-muted-foreground">{a.domain}</span></label>)}</div></>}<Button className="w-full" disabled={saving} onClick={() => void save().then(() => setDialog(null)).catch(() => {})}>Save account scope</Button></div>}
    </div><div className="flex items-center justify-end gap-2 px-6 py-4">{dialog==='delivery'&&deliveryId&&<Button variant="destructive" className="mr-auto" onClick={()=>{change({delivery:box.delivery.filter(d=>d.id!==deliveryId)});setDialog(null);}}>Remove</Button>}<Button variant="outline" onClick={()=>{{const d=dialog==='delivery'&&deliveryId?box.delivery.find(x=>x.id===deliveryId):null;if(d&&unfinished(d))change({delivery:box.delivery.filter(x=>x.id!==deliveryId)});}setDialog(null);}}>Cancel</Button><Button onClick={()=>{ if(dialog==='accounts') void save().catch(()=>{}); setDialog(null); }}>{dialog==='accounts'?'Save':'Done'}</Button></div></DialogContent></Dialog>
    <JobStepDialog ws={ws} token={token} boxId={id} row={jobStep} onClose={() => setJobStep(null)}
      onSaved={job_deliveries => { cache.setQueryData<BoxDetail>(['revbox', ws, id], old => old ? { ...old, job_deliveries } : old); setJobStep(null); setNotice('Saved. The job delivers there from its next run.'); void reload(); }}
      onChat={job => { setJobStep(null); setTab('jobs'); setFresh(null); setBuilder({ job }); }} />
    <Dialog open={!!webhookKey} onOpenChange={open=>{if(!open)setWebhookKey(null);}}><DialogContent><DialogHeader><DialogTitle>Webhook trigger</DialogTitle><DialogDescription>Save this key now. Send POST requests to /hooks/revboxes with x-revbox-key and a unique Idempotency-Key header for each event.</DialogDescription></DialogHeader><input aria-label="Webhook secret" readOnly value={webhookKey??''} className={field} /></DialogContent></Dialog>
    <Dialog open={!!file} onOpenChange={open => { if (!open) setFile(null); }}><DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>{file?.title}</DialogTitle><DialogDescription>{file?.document_id ? 'Linked document' : 'Uploaded reference'}</DialogDescription></DialogHeader><pre className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-muted-foreground">{file?.body || 'This document has no text content.'}</pre></DialogContent></Dialog>
  </div>;
}

/** A right-rail card: title, an optional one-line muted explanation under it, the action top-right. */
function RailSection({ title, sub, icon: Icon, action, children }: { title: string; sub?: string; icon: typeof FileText; action?: React.ReactNode; children: React.ReactNode }) { return <section className="rounded-2xl border border-border/80 bg-background p-5"><div className="mb-3 flex items-start gap-2"><div className="min-w-0 flex-1"><h3 className="text-[13px] font-medium">{title}</h3>{sub && <p className="mt-0.5 text-[12px] text-muted-foreground">{sub}</p>}</div>{action}</div>{children}</section>; }
/** A person with their profile photo, as members show everywhere else; initials when there is none or it fails to load. */
function MemberLine({ id, avatar, name, sub }: { id: string; avatar: string | null; name: string; sub: string }) { return <div className="flex min-w-0 flex-1 items-center gap-2.5 py-1.5"><Face id={id} avatar={avatar} name={name} /><span className="min-w-0 flex-1"><span className="block truncate text-[12px]">{name}</span><span className="block truncate text-[10px] text-muted-foreground">{sub}</span></span></div>; }
function Face({ id, avatar, name }: { id: string; avatar: string | null; name: string }) {
  const [broken, setBroken] = useState(false);
  return avatar && !broken ? <img src={avatar} alt="" aria-hidden onError={() => setBroken(true)} className="h-7 w-7 shrink-0 rounded-full object-cover" /> : <PersonAvatar person={{ id, name }} size={28} />;
}
/**
 * The accounts the box's jobs touched in their last 30 days of runs (GET-872), top 8 with logos and
 * "+N more" to the graph of them. When the runs name no account at all (a job reading data that is
 * not account-linked, e.g. a HubSpot custom object grouped by company name), it says so instead of 0.
 */
function RunAccounts({ boxId, detail }: { boxId: string; detail?: BoxDetail }) {
  if (!detail || detail.run_accounts === undefined) return null;
  const list = detail.run_accounts ?? [];
  const total = detail.run_accounts_total ?? list.length;
  const runs = detail.run_accounts_runs ?? 0;
  const graph = `/graph?revbox=${boxId}&source=runs`;
  return <div className="mt-2 border-t border-border/70 pt-3">
    <p className="mb-1.5 flex items-baseline justify-between px-1 text-[11px] font-medium text-muted-foreground"><span>Accounts in recent runs</span>{total > 0 && <span className="font-normal tabular-nums">{total} · 30 days</span>}</p>
    {list.length ? <>
      {list.slice(0, 8).map(a => <Link key={a.id} to={`/accounts/${a.id}`} className="flex items-center gap-2 rounded-lg px-1 py-1.5 text-[12px] hover:bg-muted/50"><AccountLogo name={a.name} domain={a.domain} size={16} /><span className="min-w-0 flex-1 truncate">{a.name}</span><span className="text-[10.5px] tabular-nums text-muted-foreground">{a.runs} {a.runs === 1 ? 'run' : 'runs'}</span></Link>)}
      {total > 8 && <Link to={graph} className="mt-0.5 flex items-center gap-1 px-1 py-1 text-[11.5px] text-muted-foreground hover:text-foreground">+{total - 8} more<ArrowUpRight className="h-3 w-3" /></Link>}
    </> : <p className="px-1 text-[11.5px] leading-snug text-muted-foreground">{!runs ? 'No runs in the last 30 days.' : detail.run_accounts_linked ? 'None of the accounts in recent runs are visible to you.' : 'This box’s jobs don’t link runs to accounts yet.'}</p>}
  </div>;
}
function ErrorLine({ text }: { text: string }) { return <p role="alert" className="rounded-lg border border-risk/20 bg-risk/5 px-3 py-2 text-[12px] text-risk">{text}</p>; }
function message(e: unknown): string { return e instanceof Error ? e.message : 'Something went wrong. Please try again.'; }
