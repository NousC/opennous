// A context file as a document (GET-895): a right-side sheet with the title, kind, tags and the body
// rendered as markdown, instead of raw text in an expand/collapse row. Used by Settings > Context
// (library files and each box's read-only instruction blocks) and the RevBox page's Context card.
// Edit switches the same sheet to a markdown editor (Write / Preview) with Save and Cancel; the
// caller decides who may edit and how a save is sent.
import { useState, type ReactNode } from 'react';
import { FileText, Pencil } from 'lucide-react';
import { Prose } from '@/components/AgentMarkdown';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { when } from '@/lib/format';
import { docFormat, isEmptyDoc, plainParagraphs, prettyJson, withoutRepeatedTitle } from '@/lib/contextDoc';
import { CONTEXT_KIND_LABEL, type ContextKind } from '@/lib/revboxes';

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

/** The body of a context file, rendered for reading: markdown, JSON or plain paragraphs. */
export function ContextDocBody({ text, title = '' }: { text: string; title?: string }) {
  if (isEmptyDoc(text)) return <p className="text-[13px] text-muted-foreground/70">No content added yet.</p>;
  const format = docFormat(text);
  if (format === 'json') return <pre className="overflow-x-auto rounded-lg bg-muted px-3 py-2.5 font-mono text-[12px] leading-relaxed text-foreground">{prettyJson(text.trim())}</pre>;
  if (format === 'plain') return <div className="space-y-3 text-[14px] leading-[1.6] text-foreground">
    {plainParagraphs(text).map((p, i) => <p key={i} className="whitespace-pre-line break-words">{p}</p>)}
  </div>;
  // A wide table scrolls on its own at narrow widths instead of pushing the sheet sideways.
  return <div className="break-words [&_pre]:overflow-x-auto [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto">
    <Prose text={withoutRepeatedTitle(text, title)} doc />
  </div>;
}

const kindLabel = (k: ContextDoc['kind']) => (!k ? 'Reference' : k === 'block' ? 'Instructions' : CONTEXT_KIND_LABEL[k]);

export function ContextDocSheet({ doc, onClose, canEdit = false, busy = false, onSave, actions, footnote }: {
  doc: ContextDoc | null;
  onClose: () => void;
  canEdit?: boolean;
  busy?: boolean;
  /** Resolves true when saved; the sheet then returns to the reading view. */
  onSave?: (next: { title: string; body: string }) => Promise<boolean>;
  /** Extra buttons beside Edit in the reading view (Mark as ICP, Delete, Open box…). */
  actions?: ReactNode;
  footnote?: ReactNode;
}) {
  const [dirty, setDirty] = useState(false);
  const close = () => { if (dirty && !window.confirm('Discard your changes?')) return; setDirty(false); onClose(); };
  return <Sheet open={!!doc} onOpenChange={o => { if (!o) close(); }}>
    <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-[680px]">
      {doc && <DocView key={doc.id} doc={doc} canEdit={canEdit && !!onSave && !doc.linkedDocument} busy={busy} onSave={onSave} actions={actions} footnote={footnote} onDirty={setDirty} />}
    </SheetContent>
  </Sheet>;
}

function DocView({ doc, canEdit, busy, onSave, actions, footnote, onDirty }: {
  doc: ContextDoc; canEdit: boolean; busy: boolean;
  onSave?: (next: { title: string; body: string }) => Promise<boolean>;
  actions?: ReactNode; footnote?: ReactNode; onDirty: (d: boolean) => void;
}) {
  const [draft, setDraft] = useState<{ title: string; body: string } | null>(null);
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const editing = !!draft;
  const set = (next: { title: string; body: string } | null) => { setDraft(next); onDirty(!!next && (next.title !== doc.title || next.body !== doc.body)); };
  async function save() {
    if (!draft || !onSave) return;
    if (await onSave({ title: draft.title.trim(), body: draft.body })) set(null);
  }
  const meta = [
    doc.source,
    doc.visibility === 'workspace' ? 'Workspace' : doc.visibility === 'boxes' ? 'Tagged boxes only' : null,
    doc.linkedDocument ? 'Linked document' : null,
    doc.updatedAt ? `Updated ${when(doc.updatedAt)}` : null,
  ].filter(Boolean).join(' · ');

  return <>
    <header className="shrink-0 border-b border-border/60 px-6 pb-4 pt-5 pr-12 sm:px-8">
      <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
        <FileText className="h-3.5 w-3.5 shrink-0" />
        <span className={cn('shrink-0 rounded-md px-1.5 py-px text-[10.5px] font-medium', doc.kind === 'icp' ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground')}>{kindLabel(doc.kind)}</span>
        {meta && <span className="min-w-0 truncate">{meta}</span>}
      </div>
      {editing
        ? <input aria-label="Context title" autoFocus className="mt-2.5 w-full rounded-md bg-transparent text-[20px] font-semibold leading-snug tracking-[-0.015em] text-foreground outline-none placeholder:text-muted-foreground/60 focus:bg-muted/40" value={draft.title} maxLength={200} placeholder="Title" onChange={e => set({ ...draft, title: e.target.value })} />
        : <SheetTitle className="mt-2.5 break-words text-[20px] font-semibold leading-snug tracking-[-0.015em]">{doc.title}</SheetTitle>}
      {editing && <SheetTitle className="sr-only">{doc.title}</SheetTitle>}
      <SheetDescription className="sr-only">{kindLabel(doc.kind)} context{meta ? `. ${meta}` : ''}</SheetDescription>
      {(!!doc.tags?.length || !!doc.hiddenBoxes) && <div className="mt-3 flex flex-wrap gap-1 text-[11px] text-muted-foreground/90">
        {doc.tags?.map(t => <span key={t.id} className="rounded-md border border-border/70 px-1.5 py-px">{t.name}</span>)}
        {!!doc.hiddenBoxes && <span className="rounded-md border border-dashed border-border/70 px-1.5 py-px">{doc.hiddenBoxes} private RevBox{doc.hiddenBoxes === 1 ? '' : 'es'}</span>}
      </div>}
    </header>

    {editing ? <>
      <div className="flex shrink-0 items-center justify-between gap-3 px-6 pt-3 sm:px-8">
        <div role="tablist" className="flex w-fit gap-1 rounded-lg bg-muted/70 p-1">
          {(['write', 'preview'] as const).map(t => <button key={t} role="tab" type="button" aria-selected={tab === t} onClick={() => setTab(t)} className={cn('rounded-md px-3 py-1 text-[12px]', tab === t ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground')}>{t === 'write' ? 'Write' : 'Preview'}</button>)}
        </div>
        <span className="hidden text-[11px] text-muted-foreground/70 sm:inline">Markdown: ## heading, - list, 1. steps, | table |, **bold**</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4 sm:px-8">
        {tab === 'write'
          ? <textarea aria-label="Context text" className="h-full min-h-[50vh] w-full resize-none rounded-lg border border-border/70 bg-background px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-foreground outline-none focus:border-foreground/30" value={draft.body} onChange={e => set({ ...draft, body: e.target.value })} placeholder="Write what your jobs should know. Markdown works: headings, lists, tables." />
          : <ContextDocBody text={draft.body} title={draft.title} />}
      </div>
      {footnote && <div className="shrink-0 px-6 pb-2 text-[11.5px] text-muted-foreground/80 sm:px-8">{footnote}</div>}
    </> : <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6 sm:px-8">
      <article className="max-w-[68ch]"><ContextDocBody text={doc.body} title={doc.title} /></article>
      {footnote && <div className="mt-6 max-w-[68ch] text-[11.5px] text-muted-foreground/80">{footnote}</div>}
    </div>}

    {(editing || canEdit || actions) && <footer className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 border-t border-border/60 px-6 py-3 sm:px-8">
      {editing ? <>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => set(null)}>Cancel</Button>
        <Button size="sm" disabled={busy || !draft.title.trim()} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</Button>
      </> : <>
        {actions}
        {canEdit && <Button size="sm" variant="outline" disabled={busy} onClick={() => { setTab('write'); set({ title: doc.title, body: doc.body }); }}><Pencil />Edit</Button>}
      </>}
    </footer>}
  </>;
}
