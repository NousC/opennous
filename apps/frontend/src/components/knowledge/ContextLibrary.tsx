// Settings > Knowledge (GET-875; "Context" until GET-1076): the workspace context library, open source
// since 2026-10-29 (it was Cloud's, cloud/settings). Knowledge is saved once; on Cloud a file can be
// tagged to RevBoxes, so one file serves several boxes and a box's jobs read only the files tagged to
// it. With RevBoxes off the rail (GET-1043) the rows show only who can see a file (GET-1044).
// The company repo bar on top (GET-1037) is open source too. Cloud adds its parts through the registry
// (cloud.knowledge): the Intelligence group, which holds the ICP file, and rebuilding ICP scoring.
// Without them the ICP file is listed with the other files.
// One file can be the workspace's ICP: ICP scoring builds its scorecard from it. Built from the
// settings kit like General and Members; Settings.tsx wraps it in SectionShell. Below the library,
// each box's own instruction blocks, as before (they are edited on the box).
// Marking a file ICP (or rebuilding from it) on a workspace that scores its own accounts asks first
// (GET-878): the API answers icp_scorer_switch_required, a small dialog confirms, and the request is
// sent again with confirm_scorer_switch; Nous then scores the workspace from the file.
// A row opens the file as a document (GET-895): ContextDocSheet renders its markdown and edits it in
// place; "Tags & sharing" opens the full dialog below. ?file=<id> opens a file on arrival (the box
// page links here to edit one). One file can be the About us file (GET-1036): who we are and what we
// have, read wherever the system needs to know what we sell. Like the ICP file: one, shared, admins.
import { useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, Plus, Upload } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SettingsGroup, fieldCls } from '@/components/settings/SettingsKit';
import { ContextDocSheet, type DocMenuItem } from '@/components/knowledge/ContextDocSheet';
import { ContextHistory } from '@/components/knowledge/ContextHistory';
import { ContextRow } from '@/components/knowledge/ContextRow';
import { ContextRepoBar } from '@/components/knowledge/ContextRepoBar';
import { cloud } from '@/lib/cloud';
import { when } from '@/lib/format';
import { knowledgeKey, knowledgeRequest, CONTEXT_KIND_LABEL, type ContextLibraryData, type LibraryFile } from '@/lib/knowledge';

type Draft = { id: string | null; title: string; body: string; kind: 'reference' | 'instructions'; icp: boolean; about: boolean; shared: boolean; boxes: string[]; document: boolean };
const empty: Draft = { id: null, title: '', body: '', kind: 'reference', icp: false, about: false, shared: false, boxes: [], document: false };
const MARKED = new Set(['icp', 'about']);
type IcpOutcome = { status: string; signals?: number; message?: string; scorer_switched?: boolean };
type IcpReply = { icp?: IcpOutcome };
const ICP_SWITCH = 'icp_scorer_switch_required';
const ICP_NOTE: Record<string, string> = {
  created: 'ICP scoring was built from this file.',
  exists: 'Saved as the workspace ICP. Current scores stay until you rebuild ICP scoring from this file.',
  saved: 'Saved. The workspace ICP now reads this text; rebuild ICP scoring to score with it.',
  no_icp_memory: 'Saved. Add text to this file to score from it.',
  not_available: 'Saved. ICP scoring is not available on this build.',
  external_scorer: 'Saved. This workspace scores accounts with its own model.',
  translation_failed: 'Saved, but the scoring rules could not be built from this text. Try clearer criteria.',
  build_failed: 'Saved, but rebuilding ICP scoring failed. Try again.',
};
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
/** The plain outcome of marking or rebuilding, e.g. "Scoring rebuilt from this file: 20 signals". */
function icpOutcome(icp: IcpOutcome, rebuilt: boolean): string {
  if (icp.status === 'created') {
    const built = `${rebuilt || icp.scorer_switched ? 'Scoring rebuilt' : 'ICP scoring built'} from this file: ${plural(icp.signals ?? 0, 'signal')}.`;
    return icp.scorer_switched ? `Nous now scores this workspace's accounts from this file. ${built}` : built;
  }
  return icp.message ?? ICP_NOTE[icp.status] ?? 'Saved.';
}

export function ContextLibrary() {
  const { session, userData } = useAuth();
  const ws = userData?.workspace?.id ?? '';
  const token = session?.access_token ?? '';
  const cache = useQueryClient();
  const [params] = useSearchParams();
  const [open, setOpen] = useState<string | null>(() => params.get('file'));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const [switchAsk, setSwitchAsk] = useState<{ text: string; confirm: () => void } | null>(null);
  const uploader = useRef<HTMLInputElement>(null);
  const key = knowledgeKey(ws);
  const query = useQuery({ queryKey: key, enabled: !!ws && !!token, queryFn: () => knowledgeRequest<ContextLibraryData>(ws, token, '/library') });
  const { Intelligence, rebuildIcp } = cloud.knowledge ?? {};
  const data = query.data;
  const taggable = (data?.boxes ?? []).filter(b => b.access !== 'viewer');

  /** A request to /api/context, as icpCall sends it: the body, with confirm_scorer_switch when asked. */
  const requestTo = <T,>(path: string, method: string) => (body?: unknown) => knowledgeRequest<T>(ws, token, path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  const call = <T,>(path: string, method: string, body?: unknown) => run<T>(() => requestTo<T>(path, method)(body));
  async function run<T>(send: () => Promise<T>, onSwitch?: (text: string) => void): Promise<T | null> {
    setBusy(true); setNote(null);
    try {
      const out = await send();
      await Promise.all([cache.invalidateQueries({ queryKey: key }), cache.invalidateQueries({ queryKey: ['revbox', ws] })]);
      return out;
    } catch (e) {
      if (onSwitch && (e as { code?: string }).code === ICP_SWITCH) onSwitch((e as Error).message);
      else setNote({ text: (e as Error).message, error: true });
      return null;
    } finally { setBusy(false); }
  }
  /** Mark or rebuild: asks before Nous takes over scoring from an external scorer, then retries confirmed. */
  async function icpCall<T extends IcpReply>(send: (body?: Record<string, unknown>) => Promise<T>, body: Record<string, unknown> | undefined, opts: { rebuilt?: boolean; done?: (out: T) => void } = {}, confirmed = false): Promise<boolean> {
    const out = await run<T>(() => send(confirmed ? { ...(body ?? {}), confirm_scorer_switch: true } : body),
      confirmed ? undefined : text => setSwitchAsk({ text, confirm: () => void icpCall(send, body, opts, true) }));
    if (!out) return false;
    opts.done?.(out);
    if (out.icp) setNote({ text: icpOutcome(out.icp, !!opts.rebuilt) });
    return true;
  }

  async function save() {
    if (!draft) return;
    const markedKind = draft.icp ? 'icp' : draft.about ? 'about' : null;
    const payload = { title: draft.title, ...(draft.document ? {} : { body: draft.body }), kind: markedKind ?? draft.kind, ...(markedKind ? {} : { visibility: draft.shared ? 'workspace' : 'boxes' }), revbox_ids: draft.boxes };
    await icpCall<{ file: LibraryFile } & IcpReply>(requestTo(draft.id ? `/files/${draft.id}` : '/files', draft.id ? 'PATCH' : 'POST'), payload,
      { done: out => { setDraft(null); setOpen(out.file.id); } });
  }
  async function upload(file: File | undefined) {
    if (!file) return;
    if (file.size > 262144) { setNote({ text: 'Upload text up to 256 KB.', error: true }); return; }
    setDraft({ ...empty, title: file.name, body: await file.text() });
  }
  const edit = (f: LibraryFile) => setDraft({ id: f.id, title: f.title, body: f.body, kind: f.kind === 'icp' || f.kind === 'about' ? 'reference' : f.kind, icp: f.kind === 'icp', about: f.kind === 'about', shared: f.visibility === 'workspace', boxes: f.boxes.map(b => b.id), document: !!f.document_id });

  const openFile = data?.files.find(f => f.id === open);
  // The ICP lives in Intelligence, not the library (GET-1044), where there is an Intelligence group.
  const icpFile = data?.files.find(f => f.kind === 'icp');
  const libraryFiles = (data?.files ?? []).filter(f => !Intelligence || f.kind !== 'icp');
  const openBlock = openFile ? undefined : data?.boxes.flatMap(box => box.blocks.map(b => ({ box, b }))).find(x => x.b.id === open);
  // The file's actions, in its sheet's ⋯ menu (2026-10-28; was a row of buttons under the text).
  // "Sharing" is the full dialog (kind, sharing, tags, text); the sheet closes first so the two
  // never stack, and a save reopens it.
  const fileMenu = (f: LibraryFile): DocMenuItem[] => {
    const admin = !!data?.is_admin;
    const items: DocMenuItem[] = [];
    // Rebuilding ICP scoring is Cloud's (the learned scorer); without it the ICP file is still the ICP.
    if (admin && f.kind === 'icp' && rebuildIcp) items.push({ label: 'Rebuild ICP scoring', onSelect: () => void icpCall<IcpReply>(b => rebuildIcp(ws, token, f.id, b), undefined, { rebuilt: true }) });
    if (admin && f.kind === 'icp') items.push({ label: 'Unmark as ICP', onSelect: () => void call(`/files/${f.id}`, 'PATCH', { kind: 'reference' }) });
    if (admin && f.kind === 'about') items.push({ label: 'Unmark as About us', onSelect: () => void call(`/files/${f.id}`, 'PATCH', { kind: 'reference' }) });
    if (admin && !MARKED.has(f.kind)) items.push(
      { label: 'Mark as ICP', disabled: !!data?.icp_file_id && data.icp_file_id !== f.id, hint: data?.icp_file_id ? 'Unmark the current ICP file first.' : undefined, onSelect: () => void icpCall<IcpReply>(requestTo(`/files/${f.id}`, 'PATCH'), { kind: 'icp' }) },
      { label: 'Mark as About us', disabled: !!data?.about_file_id && data.about_file_id !== f.id, hint: data?.about_file_id ? 'Unmark the current About us file first.' : undefined, onSelect: () => void call(`/files/${f.id}`, 'PATCH', { kind: 'about' }) },
    );
    if (f.can_edit && (!MARKED.has(f.kind) || admin)) items.push({ label: taggable.length ? 'Tags & sharing' : 'Sharing', onSelect: () => { setOpen(null); edit(f); } });
    if (f.can_edit) items.push({ label: 'Delete', danger: true, onSelect: () => { if (window.confirm(`Delete "${f.title}"?`)) void call(`/files/${f.id}`, 'DELETE').then(out => { if (out !== null) setOpen(null); }); } });
    return items;
  };

  return <>
    <ContextRepoBar ws={ws} token={token} />
    {/* Intelligence first (GET-1044): the ICP and the files OpenNous keeps current. */}
    {Intelligence && <Intelligence ws={ws} token={token} onOpen={id => { setNote(null); setOpen(id); }}
      icp={icpFile ?? null} onAddIcp={data?.is_admin ? () => setDraft({ ...empty, title: 'ICP', icp: true }) : undefined} />}
    {query.error && <SettingsGroup><p role="alert" className="px-2 py-2 text-[12.5px] text-risk">{query.error.message}</p></SettingsGroup>}
    {query.isLoading && <SettingsGroup><p className="px-2 py-2 text-[13px] text-muted-foreground/70">Loading…</p></SettingsGroup>}
    {data && <SettingsGroup title="Library" action={<div className="flex gap-1">
      <Button size="sm" variant="ghost" onClick={() => uploader.current?.click()}><Upload />Upload</Button>
      <Button size="sm" variant="outline" onClick={() => setDraft({ ...empty })}><Plus />New file</Button>
      <input ref={uploader} type="file" hidden accept=".md,.markdown,.txt,.csv,.json,text/*,application/json" onChange={e => { void upload(e.target.files?.[0]); e.target.value = ''; }} />
    </div>}>
      {note && !openFile && <p role={note.error ? 'alert' : 'status'} className={cn('px-2 py-1.5 text-[12px]', note.error ? 'text-risk' : 'text-muted-foreground')}>{note.text}</p>}
      {libraryFiles.length === 0 && <p className="px-2 py-2 text-[13px] text-muted-foreground">No files yet. Write one or upload a markdown file.</p>}
      {/* A row is the title, then its kind (unless plain reference), Private (when it is) and the
          date, quietly on the right (2026-10-29; was an icon, a pill and a second line).
          RevBoxes are off the rail (GET-1043): a file shows who can see it, not its box tags (GET-1044). */}
      {libraryFiles.map(f => <ContextRow key={f.id} title={f.title} onOpen={() => { setNote(null); setOpen(f.id); }}
        meta={[f.kind !== 'reference' && CONTEXT_KIND_LABEL[f.kind], f.visibility !== 'workspace' && 'Private', f.document_id && 'Linked', f.updated_at && when(f.updated_at)]} />)}
    </SettingsGroup>}

    {data?.boxes.filter(b => b.blocks.length).map(box => <SettingsGroup key={box.id} title={`${box.name} instructions`}
      action={<Button asChild size="sm" variant="ghost"><Link to={`/revboxes/${box.id}`}>Open RevBox<ArrowUpRight /></Link></Button>}>
      {box.blocks.map(b => <ContextRow key={b.id} title={b.title} meta={[!box.shared && 'Private']} onOpen={() => setOpen(b.id)} />)}
    </SettingsGroup>)}

    {openFile ? <ContextDocSheet
      doc={{ id: openFile.id, title: openFile.title, body: openFile.body, kind: openFile.kind, linkedDocument: !!openFile.document_id, tags: openFile.boxes, hiddenBoxes: openFile.hidden_boxes, visibility: openFile.visibility, updatedAt: openFile.updated_at }}
      onClose={() => setOpen(null)} busy={busy}
      // The ICP and About us files are admin-only to edit, even for their creator (the API enforces it too).
      canEdit={openFile.can_edit && (!MARKED.has(openFile.kind) || !!data?.is_admin)}
      onSave={next => icpCall<{ file: LibraryFile } & IcpReply>(requestTo(`/files/${openFile.id}`, 'PATCH'), next)}
      menu={fileMenu(openFile)}
      note={note}
      history={<ContextHistory ws={ws} token={token} fileId={openFile.id} updatedAt={openFile.updated_at} busy={busy}
        canRestore={openFile.can_edit && !openFile.document_id && (!MARKED.has(openFile.kind) || !!data?.is_admin)}
        onRestore={vid => void call(`/files/${openFile.id}/versions/${vid}/restore`, 'POST').then(out => { if (out) setNote({ text: 'Restored. The text it replaced is kept in the history.' }); })} />}
      about={(openFile.kind === 'icp' || openFile.kind === 'about' || openFile.document_id) && <div className="space-y-2">
        {openFile.kind === 'icp' && <p>This is the workspace ICP: agents and ICP scoring read it. Rebuilding replaces the scoring rules; existing scores update as accounts change. As deals close, OpenNous writes what predicts a win at the end, between its markers; the rest is yours.</p>}
        {openFile.kind === 'about' && <p>This is the workspace About us: who you are and what you have. Nous reads it to tell a feature request from something you already offer, a competitor from a tool in their stack, and to write insights about your company.</p>}
        {openFile.document_id && <p>This file is a linked document. Edit its text in the document itself.</p>}
      </div>}
    /> : <ContextDocSheet
      doc={openBlock ? { id: openBlock.b.id, title: openBlock.b.title, body: openBlock.b.body, kind: 'block', source: openBlock.box.name } : null}
      onClose={() => setOpen(null)}
      actions={openBlock && <Button asChild size="sm" variant="outline"><Link to={`/revboxes/${openBlock.box.id}`}>Open RevBox<ArrowUpRight /></Link></Button>}
      about={openBlock && 'Instruction blocks belong to their RevBox and are edited there.'}
    />}

    <Dialog open={!!draft} onOpenChange={o => { if (!o) setDraft(null); }}>
      <DialogContent className="max-h-[85vh] gap-0 overflow-y-auto sm:max-w-[560px]">
        <DialogHeader><DialogTitle className="text-[16px] font-medium">{draft?.id ? 'Edit context' : 'New file'}</DialogTitle>
          <DialogDescription className="mt-1 text-[12px]">Saved to the workspace library.</DialogDescription></DialogHeader>
        {draft && <div className="mt-4 space-y-4">
          <label className="block text-[12px]">Title<input aria-label="Context title" className={cn(fieldCls, 'mt-1.5 sm:w-full')} value={draft.title} maxLength={200} onChange={e => setDraft({ ...draft, title: e.target.value })} /></label>
          {draft.document ? <p className="text-[12px] text-muted-foreground">This file is a linked document. Edit its text in the document itself.</p>
            : <label className="block text-[12px]">Text<textarea aria-label="Context text" rows={8} className="mt-1.5 w-full resize-y rounded-lg border border-border/70 bg-card px-2.5 py-2 text-[13px] outline-none focus:border-foreground/25" value={draft.body} onChange={e => setDraft({ ...draft, body: e.target.value })} placeholder="Paste or write what your jobs should know." /></label>}
          <fieldset className="text-[12px]"><legend className="mb-1.5">Kind</legend><div className="flex flex-wrap gap-1.5">
            {(['reference', 'instructions'] as const).map(k => <button key={k} type="button" aria-pressed={!draft.icp && !draft.about && draft.kind === k} onClick={() => setDraft({ ...draft, kind: k, icp: false, about: false })} className={cn('rounded-lg border px-2.5 py-1 text-[12px]', !draft.icp && !draft.about && draft.kind === k ? 'border-foreground/40 bg-muted font-medium' : 'border-border/70 text-muted-foreground')}>{CONTEXT_KIND_LABEL[k]}</button>)}
            {(data?.is_admin || draft.icp) && <button type="button" aria-pressed={draft.icp} disabled={!data?.is_admin || (!!data?.icp_file_id && data.icp_file_id !== draft.id)} onClick={() => setDraft({ ...draft, icp: !draft.icp, about: false })} className={cn('rounded-lg border px-2.5 py-1 text-[12px] disabled:opacity-50', draft.icp ? 'border-foreground/40 bg-muted font-medium' : 'border-border/70 text-muted-foreground')}>ICP</button>}
            {(data?.is_admin || draft.about) && <button type="button" aria-pressed={draft.about} disabled={!data?.is_admin || (!!data?.about_file_id && data.about_file_id !== draft.id)} onClick={() => setDraft({ ...draft, about: !draft.about, icp: false })} className={cn('rounded-lg border px-2.5 py-1 text-[12px] disabled:opacity-50', draft.about ? 'border-foreground/40 bg-muted font-medium' : 'border-border/70 text-muted-foreground')}>About us</button>}
          </div>{draft.icp && <p className="mt-1.5 text-[11.5px] text-muted-foreground/80">The workspace ICP: shared with everyone, and ICP scoring builds its rules from it.</p>}
          {draft.about && <p className="mt-1.5 text-[11.5px] text-muted-foreground/80">Who you are and what you have: shared with everyone, and read wherever Nous needs to know what you sell.</p>}</fieldset>
          {!draft.icp && !draft.about && <label className="flex items-center gap-2 text-[12px]"><input type="checkbox" checked={draft.shared} onChange={e => setDraft({ ...draft, shared: e.target.checked })} />Everyone in the workspace can see it<span className="text-muted-foreground/70">(otherwise only you)</span></label>}
          {/* Box tags only where a workspace still has RevBoxes (GET-1044). */}
          {taggable.length > 0 && <fieldset className="text-[12px]"><legend className="mb-1.5">Tagged to</legend>
            <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-xl border border-border/70 p-1">{taggable.map(b => <label key={b.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-muted"><input type="checkbox" checked={draft.boxes.includes(b.id)} onChange={e => setDraft({ ...draft, boxes: e.target.checked ? [...draft.boxes, b.id] : draft.boxes.filter(x => x !== b.id) })} /><span className="flex-1 truncate">{b.name}</span>{!b.shared && <span className="text-[10.5px] text-muted-foreground">Private</span>}</label>)}</div>
          </fieldset>}
          <div className="flex justify-end gap-2 pt-1"><Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button><Button disabled={busy || !draft.title.trim()} onClick={() => void save()}>{draft.id ? 'Save' : 'Add'}</Button></div>
        </div>}
      </DialogContent>
    </Dialog>

    <Dialog open={!!switchAsk} onOpenChange={o => { if (!o) setSwitchAsk(null); }}>
      <DialogContent className="gap-0 sm:max-w-[420px]">
        <DialogHeader><DialogTitle className="text-[16px] font-medium">Score accounts from this file?</DialogTitle>
          <DialogDescription className="mt-1 text-[12.5px] leading-relaxed">{switchAsk?.text}</DialogDescription></DialogHeader>
        <div className="flex justify-end gap-2 pt-5"><Button variant="ghost" onClick={() => setSwitchAsk(null)}>Cancel</Button>
          <Button disabled={busy} onClick={() => { const go = switchAsk?.confirm; setSwitchAsk(null); go?.(); }}>Use this file for scoring</Button></div>
      </DialogContent>
    </Dialog>
  </>;
}
