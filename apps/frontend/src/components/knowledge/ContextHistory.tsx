// A context file's versions (GET-1038), the file sheet's History view (2026-10-28; was a list under its text): when, who (a person, OpenNous,
// or an edit from the company repo) and what changed. A version opens to its text; Restore puts it
// back as a new version, so the text it replaces is kept too.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { when } from '@/lib/format';
import { ContextDocBody } from '@/components/knowledge/ContextDocSheet';
import { knowledgeRequest, type ContextVersion } from '@/lib/knowledge';

export function ContextHistory({ ws, token, fileId, updatedAt, canRestore, busy, onRestore }: {
  ws: string; token: string; fileId: string;
  /** Refetch when the file changes. */
  updatedAt?: string | null;
  canRestore: boolean; busy: boolean;
  onRestore: (versionId: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['context-versions', ws, fileId, updatedAt ?? null],
    enabled: !!ws && !!token,
    queryFn: () => knowledgeRequest<{ versions: ContextVersion[] }>(ws, token, `/files/${fileId}/versions`),
  });
  const versions = q.data?.versions ?? [];
  return <section aria-label="History">
    {q.isLoading && <p className="text-[12px] text-muted-foreground/70">Loading…</p>}
    {!q.isLoading && !versions.length && <p className="text-[12.5px] text-muted-foreground/70">No earlier versions yet.</p>}
    <ol className="-mx-2 space-y-0.5">
      {versions.map((v, i) => <li key={v.id} className={cn('rounded-lg', open === v.id && 'bg-hover/60')}>
        <button type="button" aria-expanded={open === v.id} onClick={() => setOpen(open === v.id ? null : v.id)}
          className="flex min-h-10 w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[13px] hover:bg-hover">
          <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-transform', open === v.id && 'rotate-90')} />
          <span className="min-w-0 flex-1 truncate text-foreground">{v.changelog ?? (i === versions.length - 1 ? 'Created' : 'Edited')}</span>
          {i === 0 && <span className="shrink-0 text-[12px] font-medium text-ink-2">Current</span>}
          <span className="shrink-0 text-[12px] text-muted-foreground/80">{v.author}</span>
          <span title={new Date(v.created_at).toLocaleString()} className="w-[72px] shrink-0 text-right text-[12px] tabular-nums text-muted-foreground/70">{when(v.created_at)}</span>
        </button>
        {open === v.id && <div className="space-y-3 px-2 pb-3 pl-7">
          <div className="max-h-[420px] overflow-y-auto rounded-xl border border-border/60 bg-card px-5 py-4"><ContextDocBody text={v.body} title={v.title} /></div>
          {canRestore && i > 0 && v.changelog !== 'Deleted' && <Button size="sm" variant="outline" disabled={busy} onClick={() => onRestore(v.id)}>Restore this version</Button>}
        </div>}
      </li>)}
    </ol>
  </section>;
}
