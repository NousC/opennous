// Settings > Context (GET-875): the workspace context library. Knowledge is saved once and tagged
// to RevBoxes, so one file serves several boxes; a box's jobs read only the files tagged to it.
// One file can be the workspace's ICP: ICP scoring builds its scorecard from it. Built from the
// settings kit like General and Members; Settings.tsx wraps it in SectionShell. Below the library,
// each box's own instruction blocks, as before (they are edited on the box).
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, ChevronDown, FileText, Plus, Upload } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SettingsGroup, fieldCls } from '@/components/settings/SettingsKit';
import { revboxesRequest, CONTEXT_KIND_LABEL, type ContextLibraryData, type LibraryFile } from '@/lib/revboxes';

type Draft = { id: string | null; title: string; body: string; kind: 'reference' | 'instructions'; icp: boolean; shared: boolean; boxes: string[]; document: boolean };
const empty: Draft = { id: null, title: '', body: '', kind: 'reference', icp: false, shared: false, boxes: [], document: false };
const ICP_NOTE: Record<string, string> = {
  created: 'ICP scoring was built from this file.',
  exists: 'Saved as the workspace ICP. Current scores stay until you rebuild ICP scoring from this file.',
  saved: 'Saved. The workspace ICP now reads this text; rebuild ICP scoring to score with it.',
  no_icp_memory: 'Saved. Add text to this file to score from it.',
  not_available: 'Saved. ICP scoring is not available on this plan.',
  external_scorer: 'Saved. This workspace scores accounts with its own model.',
  translation_failed: 'Saved, but the scoring rules could not be built from this text. Try clearer criteria.',
  build_failed: 'Saved, but rebuilding ICP scoring failed. Try again.',
};

export function ContextLibrary() {
  const { session, userData } = useAuth();
  const ws = userData?.workspace?.id ?? '';
  const token = session?.access_token ?? '';
  const cache = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const uploader = useRef<HTMLInputElement>(null);
  const key = ['revbox-context-library', ws];
  const query = useQuery({ queryKey: key, enabled: !!ws && !!token, queryFn: () => revboxesRequest<ContextLibraryData>(ws, token, '/context-library') });
  const data = query.data;
  const taggable = (data?.boxes ?? []).filter(b => b.access !== 'viewer');

  async function call<T>(path: string, method: string, body?: unknown): Promise<T | null> {
    setBusy(true); setNote(null);
    try {
      const out = await revboxesRequest<T>(ws, token, path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
      await Promise.all([cache.invalidateQueries({ queryKey: key }), cache.invalidateQueries({ queryKey: ['revbox', ws] })]);
      return out;
    } catch (e) { setNote({ text: (e as Error).message, error: true }); return null; } finally { setBusy(false); }
  }
  const icpNote = (out: { icp?: { status: string } } | null) => { if (out?.icp) setNote({ text: ICP_NOTE[out.icp.status] ?? 'Saved.' }); };

  async function save() {
    if (!draft) return;
    const payload = { title: draft.title, ...(draft.document ? {} : { body: draft.body }), kind: draft.icp ? 'icp' : draft.kind, ...(draft.icp ? {} : { visibility: draft.shared ? 'workspace' : 'boxes' }), revbox_ids: draft.boxes };
    const out = draft.id ? await call<{ file: LibraryFile; icp?: { status: string } }>(`/context-files/${draft.id}`, 'PATCH', payload)
      : await call<{ file: LibraryFile; icp?: { status: string } }>('/context-files', 'POST', payload);
    if (out) { setDraft(null); setOpen(out.file.id); icpNote(out); }
  }
  async function upload(file: File | undefined) {
    if (!file) return;
    if (file.size > 262144) { setNote({ text: 'Upload text up to 256 KB.', error: true }); return; }
    setDraft({ ...empty, title: file.name, body: await file.text() });
  }
  const edit = (f: LibraryFile) => setDraft({ id: f.id, title: f.title, body: f.body, kind: f.kind === 'icp' ? 'reference' : f.kind, icp: f.kind === 'icp', shared: f.visibility === 'workspace', boxes: f.boxes.map(b => b.id), document: !!f.document_id });

  return <>
    {query.error && <SettingsGroup><p role="alert" className="px-2 py-2 text-[12.5px] text-risk">{query.error.message}</p></SettingsGroup>}
    {query.isLoading && <SettingsGroup><p className="px-2 py-2 text-[13px] text-muted-foreground/70">Loading…</p></SettingsGroup>}
    {data && <SettingsGroup title="Library" action={<div className="flex gap-1.5">
      <Button size="sm" variant="outline" onClick={() => uploader.current?.click()}><Upload />Upload</Button>
      <Button size="sm" variant="outline" onClick={() => setDraft({ ...empty })}><Plus />Add knowledge</Button>
      <input ref={uploader} type="file" hidden accept=".md,.markdown,.txt,.csv,.json,text/*,application/json" onChange={e => { void upload(e.target.files?.[0]); e.target.value = ''; }} />
    </div>}>
      <p className="px-2 pb-1 text-[11.5px] text-muted-foreground/70">Save context once and tag it to the RevBoxes that should use it. Each box's jobs read only the files tagged to it.</p>
      {note && <p role={note.error ? 'alert' : 'status'} className={cn('px-2 py-1.5 text-[12px]', note.error ? 'text-risk' : 'text-muted-foreground')}>{note.text}</p>}
      {data.files.length === 0 && <p className="px-2 py-2 text-[13px] text-muted-foreground/70">No context yet. Add knowledge or upload a file.</p>}
      {data.files.map(f => <div key={f.id}>
        <button type="button" aria-expanded={open === f.id} onClick={() => setOpen(open === f.id ? null : f.id)} className="flex min-h-12 w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors duration-fast hover:bg-hover">
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex min-w-0 items-center gap-2"><span className="truncate text-[13px] text-foreground">{f.title}</span>
              <span className={cn('shrink-0 rounded-md px-1.5 py-px text-[10.5px] font-medium', f.kind === 'icp' ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground')}>{CONTEXT_KIND_LABEL[f.kind]}</span></span>
            <span className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground/80">
              {f.boxes.map(b => <span key={b.id} className="rounded-md border border-border/70 px-1.5 py-px">{b.name}</span>)}
              {f.hidden_boxes > 0 && <span className="rounded-md border border-dashed border-border/70 px-1.5 py-px">{f.hidden_boxes} private RevBox{f.hidden_boxes === 1 ? '' : 'es'}</span>}
              {!f.boxes.length && !f.hidden_boxes && <span>Not tagged to a RevBox</span>}
              <span className="text-muted-foreground/60">· {f.visibility === 'workspace' ? 'Workspace' : 'Tagged boxes only'}{f.document_id ? ' · Linked document' : ''}</span>
            </span>
          </span>
          <ChevronDown className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform', open === f.id && 'rotate-180')} />
        </button>
        {open === f.id && <div className="px-8 pb-3">
          <p className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-ink-2">{f.body || 'No content added yet.'}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {f.can_edit && <Button size="sm" variant="outline" disabled={busy} onClick={() => edit(f)}>Edit</Button>}
            {data.is_admin && f.kind !== 'icp' && <Button size="sm" variant="outline" disabled={busy || (!!data.icp_file_id && data.icp_file_id !== f.id)} title={data.icp_file_id ? 'Unmark the current ICP file first.' : undefined} onClick={() => void call<{ icp?: { status: string } }>(`/context-files/${f.id}`, 'PATCH', { kind: 'icp' }).then(icpNote)}>Mark as ICP</Button>}
            {data.is_admin && f.kind === 'icp' && <>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void call<{ icp: { status: string } }>(`/context-files/${f.id}/icp-rebuild`, 'POST').then(icpNote)}>Rebuild ICP scoring from this file</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void call(`/context-files/${f.id}`, 'PATCH', { kind: 'reference' })}>Unmark ICP</Button>
            </>}
            {f.can_edit && <Button size="sm" variant="ghost" className="text-risk" disabled={busy} onClick={() => { if (window.confirm(`Delete "${f.title}" from every RevBox?`)) void call(`/context-files/${f.id}`, 'DELETE'); }}>Delete</Button>}
          </div>
          {f.kind === 'icp' && <p className="mt-2 text-[11.5px] text-muted-foreground/70">This is the workspace ICP: agents and ICP scoring read it. Rebuilding replaces the scoring rules; existing scores update as accounts change.</p>}
        </div>}
      </div>)}
    </SettingsGroup>}

    {data?.boxes.filter(b => b.blocks.length).map(box => <SettingsGroup key={box.id} title={`${box.name} · instructions${box.shared ? '' : ' · Private'}`}
      action={<Button asChild size="sm" variant="outline"><Link to={`/revboxes/${box.id}`}>Open<ArrowUpRight /></Link></Button>}>
      {box.blocks.map(b => <div key={b.id}>
        <button type="button" aria-expanded={open === b.id} onClick={() => setOpen(open === b.id ? null : b.id)} className="flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors duration-fast hover:bg-hover">
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{b.title}</span>
          <ChevronDown className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform', open === b.id && 'rotate-180')} />
        </button>
        {open === b.id && <p className="whitespace-pre-wrap break-words px-8 pb-3 text-[12.5px] leading-relaxed text-ink-2">{b.body || 'No content added yet.'}</p>}
      </div>)}
    </SettingsGroup>)}

    <Dialog open={!!draft} onOpenChange={o => { if (!o) setDraft(null); }}>
      <DialogContent className="max-h-[85vh] gap-0 overflow-y-auto sm:max-w-[560px]">
        <DialogHeader><DialogTitle className="text-[16px] font-medium">{draft?.id ? 'Edit context' : 'Add knowledge'}</DialogTitle>
          <DialogDescription className="mt-1 text-[12px]">Saved to the workspace library. Tag the RevBoxes whose jobs should use it.</DialogDescription></DialogHeader>
        {draft && <div className="mt-4 space-y-4">
          <label className="block text-[12px]">Title<input aria-label="Context title" className={cn(fieldCls, 'mt-1.5 sm:w-full')} value={draft.title} maxLength={200} onChange={e => setDraft({ ...draft, title: e.target.value })} /></label>
          {draft.document ? <p className="text-[12px] text-muted-foreground">This file is a linked document. Edit its text in the document itself.</p>
            : <label className="block text-[12px]">Text<textarea aria-label="Context text" rows={8} className="mt-1.5 w-full resize-y rounded-lg border border-border/70 bg-card px-2.5 py-2 text-[13px] outline-none focus:border-foreground/25" value={draft.body} onChange={e => setDraft({ ...draft, body: e.target.value })} placeholder="Paste or write what your jobs should know." /></label>}
          <fieldset className="text-[12px]"><legend className="mb-1.5">Kind</legend><div className="flex flex-wrap gap-1.5">
            {(['reference', 'instructions'] as const).map(k => <button key={k} type="button" aria-pressed={!draft.icp && draft.kind === k} onClick={() => setDraft({ ...draft, kind: k, icp: false })} className={cn('rounded-lg border px-2.5 py-1 text-[12px]', !draft.icp && draft.kind === k ? 'border-foreground/40 bg-muted font-medium' : 'border-border/70 text-muted-foreground')}>{CONTEXT_KIND_LABEL[k]}</button>)}
            {(data?.is_admin || draft.icp) && <button type="button" aria-pressed={draft.icp} disabled={!data?.is_admin || (!!data?.icp_file_id && data.icp_file_id !== draft.id)} onClick={() => setDraft({ ...draft, icp: !draft.icp })} className={cn('rounded-lg border px-2.5 py-1 text-[12px] disabled:opacity-50', draft.icp ? 'border-foreground/40 bg-muted font-medium' : 'border-border/70 text-muted-foreground')}>ICP</button>}
          </div>{draft.icp && <p className="mt-1.5 text-[11.5px] text-muted-foreground/80">The workspace ICP: shared with everyone, and ICP scoring builds its rules from it.</p>}</fieldset>
          {!draft.icp && <label className="flex items-center gap-2 text-[12px]"><input type="checkbox" checked={draft.shared} onChange={e => setDraft({ ...draft, shared: e.target.checked })} />Everyone in the workspace can see it<span className="text-muted-foreground/70">(otherwise only people in its RevBoxes)</span></label>}
          <fieldset className="text-[12px]"><legend className="mb-1.5">Tagged to</legend>
            {taggable.length ? <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-xl border border-border/70 p-1">{taggable.map(b => <label key={b.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-muted"><input type="checkbox" checked={draft.boxes.includes(b.id)} onChange={e => setDraft({ ...draft, boxes: e.target.checked ? [...draft.boxes, b.id] : draft.boxes.filter(x => x !== b.id) })} /><span className="flex-1 truncate">{b.name}</span>{!b.shared && <span className="text-[10.5px] text-muted-foreground">Private</span>}</label>)}</div>
              : <p className="text-muted-foreground">No RevBoxes you can edit yet.</p>}
          </fieldset>
          <div className="flex justify-end gap-2 pt-1"><Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button><Button disabled={busy || !draft.title.trim()} onClick={() => void save()}>{draft.id ? 'Save' : 'Add'}</Button></div>
        </div>}
      </DialogContent>
    </Dialog>
  </>;
}
