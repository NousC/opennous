// A context file as a document (GET-895): a right-side sheet with the body rendered as markdown,
// instead of raw text in an expand/collapse row. Used by Settings > Context (library files and each
// box's read-only instruction blocks) and the RevBox page's Context card.
//
// The look (2026-10-28): a slim bar on top says what the file is (kind, who sees it, when it
// changed) and carries the verbs: History, Edit, and a ⋯ menu for the rest (Rebuild ICP scoring,
// Sharing, Delete…), so no row of buttons sits under the text. The document reads in one centred
// column under a real title; its YAML front matter is metadata and is not shown. History is its own
// view of the sheet, not a list at the bottom of the text. Edit turns the same column into the
// title and a plain writing surface (Write / Preview), with Cancel and Save in the bar.
//
// Quieter (2026-10-29): the bar is one line of plain text (kind, who sees it, when) with ghost
// verbs; no file icon, no black kind pill. Opening focuses the sheet, not its first button, so no
// focus ring greets you. A first heading that names the file more fully is the title (docHeading).
// The page behind stays readable: a light scrim, no blur.
import { useState, type ReactNode } from 'react';
import { ArrowLeft, History, Info, MoreHorizontal, Pencil } from 'lucide-react';
import { Prose } from '@/components/AgentMarkdown';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { when } from '@/lib/format';
import { docFormat, docHeading, isEmptyDoc, plainParagraphs, prettyJson, withoutFrontmatter } from '@/lib/contextDoc';
import { CONTEXT_KIND_LABEL, type ContextKind } from '@/lib/knowledge';

export type ContextDoc = {
  id: string; title: string; body: string;
  /** A library kind, or 'block' for a box's own instruction block. */
  kind?: ContextKind | 'block';
  linkedDocument?: boolean;
  tags?: { id: string; name: string }[]; hiddenBoxes?: number;
  visibility?: 'boxes' | 'workspace';
  updatedAt?: string | null;
  /** Where it comes from when that is not the library, e.g. the box a block belongs to. */
  source?: string;
};

/** One entry in the sheet's ⋯ menu. */
export type DocMenuItem = {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Why it is disabled, on hover. */
  hint?: string;
};

/** The body of a context file, rendered for reading: markdown, JSON or plain paragraphs. */
export function ContextDocBody({ text, title = '' }: { text: string; title?: string }) {
  const body = withoutFrontmatter(text);
  if (isEmptyDoc(body)) return <p className="text-[13px] text-muted-foreground/70">No content added yet.</p>;
  const format = docFormat(body);
  if (format === 'json') return <pre className="overflow-x-auto rounded-lg bg-muted px-3 py-2.5 font-mono text-[12px] leading-relaxed text-foreground">{prettyJson(body.trim())}</pre>;
  if (format === 'plain') return <div className="space-y-3 text-[14px] leading-[1.65] text-foreground">
    {plainParagraphs(body).map((p, i) => <p key={i} className="whitespace-pre-line break-words">{p}</p>)}
  </div>;
  // A wide table scrolls on its own at narrow widths instead of pushing the sheet sideways.
  return <div className="break-words [&_pre]:overflow-x-auto [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto">
    <Prose text={docHeading(body, title).body} doc />
  </div>;
}

const kindLabel = (k: ContextDoc['kind']) => (!k ? 'Reference' : k === 'block' ? 'Instructions' : CONTEXT_KIND_LABEL[k]);

export function ContextDocSheet({ doc, onClose, canEdit = false, busy = false, onSave, actions, menu, about, note, history }: {
  doc: ContextDoc | null;
  onClose: () => void;
  canEdit?: boolean;
  busy?: boolean;
  /** Resolves true when saved; the sheet then returns to the reading view. */
  onSave?: (next: { title: string; body: string }) => Promise<boolean>;
  /** Buttons in the bar beside Edit (Open RevBox, Open in library…). */
  actions?: ReactNode;
  /** The ⋯ menu: everything else you can do to the file. */
  menu?: DocMenuItem[];
  /** What this kind of file is for, behind the ⓘ next to its kind. */
  about?: ReactNode;
  /** The outcome of the last action (saved, rebuilt, failed), under the bar. */
  note?: { text: string; error?: boolean } | null;
  /** The file's versions (GET-1038), the History view. */
  history?: ReactNode;
}) {
  const [dirty, setDirty] = useState(false);
  const close = () => { if (dirty && !window.confirm('Discard your changes?')) return; setDirty(false); onClose(); };
  return <Sheet open={!!doc} onOpenChange={o => { if (!o) close(); }}>
    <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 outline-none sm:max-w-[760px]" overlayClassName="bg-black/10 backdrop-blur-0"
      onOpenAutoFocus={e => { e.preventDefault(); (e.currentTarget as HTMLElement | null)?.focus(); }}>
      {doc && <DocView key={doc.id} doc={doc} canEdit={canEdit && !!onSave && !doc.linkedDocument} busy={busy} onSave={onSave}
        actions={actions} menu={menu} about={about} note={note} history={history} onDirty={setDirty} />}
    </SheetContent>
  </Sheet>;
}

function DocView({ doc, canEdit, busy, onSave, actions, menu, about, note, history, onDirty }: {
  doc: ContextDoc; canEdit: boolean; busy: boolean;
  onSave?: (next: { title: string; body: string }) => Promise<boolean>;
  actions?: ReactNode; menu?: DocMenuItem[]; about?: ReactNode; note?: { text: string; error?: boolean } | null;
  history?: ReactNode; onDirty: (d: boolean) => void;
}) {
  const [draft, setDraft] = useState<{ title: string; body: string } | null>(null);
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const [view, setView] = useState<'doc' | 'history'>('doc');
  const editing = !!draft;
  const set = (next: { title: string; body: string } | null) => { setDraft(next); onDirty(!!next && (next.title !== doc.title || next.body !== doc.body)); };
  async function save() {
    if (!draft || !onSave) return;
    if (await onSave({ title: draft.title.trim(), body: draft.body })) set(null);
  }
  const meta = [
    doc.source,
    doc.visibility === 'workspace' ? 'Workspace' : doc.visibility === 'boxes' ? 'Private' : null,
    doc.linkedDocument ? 'Linked document' : null,
    doc.updatedAt ? `Updated ${when(doc.updatedAt)}` : null,
  ].filter(Boolean).join(' · ');
  const items = menu ?? [];
  const safe = items.filter(m => !m.danger);
  const danger = items.filter(m => m.danger);
  const shown = docHeading(withoutFrontmatter(doc.body), doc.title).title;

  return <>
    {/* THE BAR — what the file is on the left, the verbs on the right; the sheet's ✕ sits after them. */}
    <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border/60 pl-5 pr-12 sm:pl-6">
      {view === 'history' && !editing ? (
        <button type="button" onClick={() => setView('doc')} className="-ml-1.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12.5px] text-ink-2 transition-colors hover:bg-hover hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" />{shown}
        </button>
      ) : (
        <span className="flex min-w-0 items-center text-[12.5px] text-muted-foreground">
          <span className="shrink-0 font-medium text-ink-2">{kindLabel(doc.kind)}</span>
          {about && <Popover>
            <PopoverTrigger asChild>
              <button type="button" aria-label="What this file is for" className="ml-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:text-foreground">
                <Info className="h-3.5 w-3.5" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" sideOffset={6} className="w-[320px] rounded-[12px] p-3 text-[12px] leading-relaxed text-ink-2">{about}</PopoverContent>
          </Popover>}
          {meta && <span className={cn('hidden min-w-0 truncate sm:inline', !about && 'ml-1.5')}><span aria-hidden className="mr-1.5">·</span>{meta}</span>}
        </span>
      )}
      <span className="flex-1" />
      {editing ? <>
        <div role="tablist" aria-label="Edit mode" className="mr-1 flex gap-0.5 rounded-lg bg-muted/70 p-0.5">
          {(['write', 'preview'] as const).map(t => <button key={t} role="tab" type="button" aria-selected={tab === t} onClick={() => setTab(t)}
            className={cn('rounded-md px-2.5 py-0.5 text-[12px]', tab === t ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>{t === 'write' ? 'Write' : 'Preview'}</button>)}
        </div>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => set(null)}>Cancel</Button>
        <Button size="sm" disabled={busy || !draft.title.trim()} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</Button>
      </> : <>
        {actions}
        {history && view === 'doc' && <Button size="sm" variant="ghost" className="text-ink-2" onClick={() => setView('history')}><History />History</Button>}
        {canEdit && <Button size="sm" variant="ghost" className="text-ink-2" disabled={busy} onClick={() => { setView('doc'); setTab('write'); set({ title: doc.title, body: doc.body }); }}><Pencil />Edit</Button>}
        {items.length > 0 && <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label="More actions" disabled={busy}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-hover hover:text-foreground disabled:opacity-50">
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={6} className="min-w-[200px]">
            {safe.map(m => <DropdownMenuItem key={m.label} disabled={m.disabled} title={m.hint} onSelect={m.onSelect} className="text-[12.5px]">{m.label}</DropdownMenuItem>)}
            {safe.length > 0 && danger.length > 0 && <DropdownMenuSeparator />}
            {danger.map(m => <DropdownMenuItem key={m.label} disabled={m.disabled} title={m.hint} onSelect={m.onSelect} className="text-[12.5px] text-risk focus:text-risk">{m.label}</DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>}
      </>}
    </header>

    {note && <p role={note.error ? 'alert' : 'status'} className={cn('shrink-0 border-b border-border/60 px-5 py-2 text-[12px]', note.error ? 'bg-risk/5 text-risk' : 'bg-muted/40 text-ink-2')}>{note.text}</p>}

    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className={cn('mx-auto w-full max-w-[640px] px-6 pb-20 sm:px-10', editing ? 'flex min-h-full flex-col pt-8' : 'pt-12')}>
        {editing
          ? <input aria-label="Context title" autoFocus className="w-full bg-transparent text-[24px] font-semibold leading-tight tracking-[-0.015em] text-foreground outline-none placeholder:text-muted-foreground/50" value={draft.title} maxLength={200} placeholder="Untitled" onChange={e => set({ ...draft, title: e.target.value })} />
          : <SheetTitle className="break-words text-[24px] font-semibold leading-tight tracking-[-0.015em] [text-wrap:balance]">{view === 'history' ? 'History' : shown}</SheetTitle>}
        {editing && <SheetTitle className="sr-only">{doc.title}</SheetTitle>}
        <SheetDescription className="sr-only">{kindLabel(doc.kind)} context{meta ? `. ${meta}` : ''}</SheetDescription>
        {!editing && view === 'doc' && (!!doc.tags?.length || !!doc.hiddenBoxes) && <p className="mt-2 text-[12.5px] text-muted-foreground">
          {[...(doc.tags ?? []).map(t => t.name), doc.hiddenBoxes ? `${doc.hiddenBoxes} private RevBox${doc.hiddenBoxes === 1 ? '' : 'es'}` : null].filter(Boolean).join(' · ')}
        </p>}

        {editing ? (
          tab === 'write'
            ? <textarea aria-label="Context text" className="mt-5 min-h-[55vh] w-full flex-1 resize-none bg-transparent font-mono text-[13px] leading-[1.7] text-foreground outline-none placeholder:text-muted-foreground/50" value={draft.body} onChange={e => set({ ...draft, body: e.target.value })} placeholder="Write what your jobs should know. Markdown works: ## headings, - lists, | tables |, **bold**." />
            : <div className="mt-8"><ContextDocBody text={draft.body} title={draft.title} /></div>
        ) : view === 'history' ? (
          <div className="mt-8">{history}</div>
        ) : (
          <article className="mt-8 [text-wrap:pretty]"><ContextDocBody text={doc.body} title={doc.title} /></article>
        )}
      </div>
    </div>
  </>;
}
