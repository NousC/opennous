// /knowledge with nothing open (GET-1082): the workspace's knowledge as a file explorer, full width,
// the same folders as the sidebar's tree. Name, type and date in columns; folders fold with the tree
// (one pref). A file OpenNous keeps has its on/off switch at the end of its row.
import { Fragment, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, FileText, Folder, Loader2, Plus, Upload } from 'lucide-react';
import { SWITCH } from '@/components/knowledge/LivingFilesGroup';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { usePref } from '@/hooks/usePref';
import { when } from '@/lib/format';
import { FOLDED_PREF, isFolded, knowledgeKey, knowledgeRequest, type KnowledgeRow } from '@/lib/knowledge';
import { cn } from '@/lib/utils';

export type ExplorerFolder = { name: string; rows: KnowledgeRow[]; action?: ReactNode };

const COLUMNS = 'grid grid-cols-[minmax(0,1fr)_44px] items-center gap-3 sm:grid-cols-[minmax(0,1fr)_130px_110px_44px]';

export function KnowledgeExplorer({ ws, token, folders, manage, note, onNew, onUpload }: {
  ws: string; token: string; folders: ExplorerFolder[]; manage: boolean; note?: { text: string; error?: boolean } | null; onNew: () => void; onUpload: () => void;
}) {
  const navigate = useNavigate();
  const cache = useQueryClient();
  const [folded, setFolded] = usePref<string[]>(FOLDED_PREF, [], isFolded);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(row: KnowledgeRow) {
    setBusy(row.key); setError(null);
    try {
      await knowledgeRequest(ws, token, `/living-files/${row.key}`, { method: 'POST', body: JSON.stringify({ enabled: !!row.off }) });
      await Promise.all([cache.invalidateQueries({ queryKey: ['living-files', ws] }), cache.invalidateQueries({ queryKey: knowledgeKey(ws) })]);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }

  return <div className="h-full overflow-y-auto bg-background">
    <div className="flex items-center justify-end gap-1 px-6 pt-3">
      <Button size="sm" variant="ghost" onClick={onUpload}><Upload />Upload</Button>
      <Button size="sm" variant="outline" onClick={onNew}><Plus />New file</Button>
    </div>
    {error && <p role="alert" className="px-6 pt-2 text-[12px] text-risk">{error}</p>}
    {note && <p role={note.error ? 'alert' : 'status'} className={cn('px-6 pt-2 text-[12px]', note.error ? 'text-risk' : 'text-muted-foreground')}>{note.text}</p>}
    <div className="px-6 pb-10 pt-2">
      <div className={cn(COLUMNS, 'border-b border-border/70 py-2 text-[11.5px] font-medium text-muted-foreground/70')}>
        <span>Name</span><span className="hidden sm:block">Type</span><span className="hidden sm:block">Updated</span><span />
      </div>
      {folders.map(f => {
        const open = !folded.includes(f.name);
        return <Fragment key={f.name}>
          <div className={cn(COLUMNS, 'border-b border-border/50 transition-colors duration-fast hover:bg-hover')}>
            <button type="button" aria-expanded={open} onClick={() => setFolded(open ? [...folded, f.name] : folded.filter(n => n !== f.name))}
              className="col-span-1 flex min-h-10 min-w-0 items-center gap-2 text-left sm:col-span-3">
              <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground/50 transition-transform duration-fast', open && 'rotate-90')} />
              <Folder className="h-4 w-4 shrink-0 text-muted-foreground/70" strokeWidth={1.75} />
              <span className="truncate text-[13.5px] font-medium text-foreground">{f.name}</span>
              <span className="text-[12px] tabular-nums text-muted-foreground/60">{f.rows.length}</span>
            </button>
            <span className="flex justify-end">{f.action}</span>
          </div>
          {open && f.rows.map(row => <div key={row.key} className={cn(COLUMNS, 'border-b border-border/50 transition-colors duration-fast hover:bg-hover')}>
            <button type="button" onClick={() => navigate(row.href)} className="flex min-h-10 min-w-0 items-center gap-2 pl-[22px] text-left">
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground/50" strokeWidth={1.75} />
              <span className={cn('truncate text-[13.5px]', row.off ? 'text-muted-foreground/60' : 'text-foreground')}>{row.title}</span>
              {row.error && <span aria-label="Update failed" title={row.error} className="h-1.5 w-1.5 shrink-0 rounded-full bg-risk" />}
            </button>
            <span className="hidden truncate text-[12.5px] text-muted-foreground sm:block">{row.type}</span>
            <span className="hidden truncate text-[12.5px] tabular-nums text-muted-foreground sm:block">{row.updated ? when(row.updated) : ''}</span>
            <span className="flex justify-end">
              {row.living && manage && (busy === row.key
                ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                : <Switch checked={!row.off} onCheckedChange={() => void toggle(row)} aria-label={`${row.title}: ${row.off ? 'off' : 'on'}`} className={SWITCH} />)}
            </span>
          </div>)}
        </Fragment>;
      })}
    </div>
  </div>;
}
