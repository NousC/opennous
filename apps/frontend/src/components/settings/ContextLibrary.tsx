// Settings > Context (GET-858): what every RevBox job may read, one card per RevBox: its
// instructions (voice, ICP, goals) and its reference files. Built from the settings kit like
// General and Members; Settings.tsx wraps it in SectionShell and the top bar names the section.
// Context is added on the RevBox itself, so each card's action opens the box.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, ChevronDown, FileText } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { SettingsGroup } from '@/components/settings/SettingsKit';
import { revboxesRequest, type ContextBlock, type ContextFile } from '@/lib/revboxes';

type Group = { id: string; name: string; shared: boolean; blocks: ContextBlock[]; context: ContextFile[] };
export function ContextLibrary() {
  const { session, userData } = useAuth();
  const ws = userData?.workspace?.id ?? '';
  const token = session?.access_token ?? '';
  const [open, setOpen] = useState<string | null>(null);
  const query = useQuery({ queryKey: ['revbox-context-library', ws], enabled: !!ws && !!token, queryFn: () => revboxesRequest<{ groups: Group[] }>(ws, token, '/context-library') });
  return <>
    {query.error && <SettingsGroup><p role="alert" className="px-2 py-2 text-[12.5px] text-risk">{query.error.message}</p></SettingsGroup>}
    {query.isLoading && <SettingsGroup><p className="px-2 py-2 text-[13px] text-muted-foreground/70">Loading…</p></SettingsGroup>}
    {query.data?.groups.length === 0 && <SettingsGroup title="Context"><p className="px-2 py-2 text-[13px] text-muted-foreground/70">Add context to a RevBox and it will appear here.</p></SettingsGroup>}
    {query.data?.groups.map(group => {
      const items = [...group.blocks.map(b => ({ ...b, kind: 'Instructions' })), ...group.context.map(c => ({ ...c, kind: c.document_id ? 'Linked document' : 'Reference file' }))];
      return <SettingsGroup key={group.id} title={`${group.name}${group.shared ? '' : ' · Private'}`}
        action={<Button asChild size="sm" variant="outline"><Link to={`/revboxes/${group.id}`}>Add context<ArrowUpRight /></Link></Button>}>
        {items.length ? items.map(item => <div key={item.id}>
          <button type="button" aria-expanded={open === item.id} onClick={() => setOpen(open === item.id ? null : item.id)} className="flex min-h-12 w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors duration-fast hover:bg-hover">
            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-1 flex-col gap-px"><span className="truncate text-[13px] text-foreground">{item.title}</span><span className="text-[11.5px] text-muted-foreground/70">{item.kind}</span></span>
            <ChevronDown className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform', open === item.id && 'rotate-180')} />
          </button>
          {open === item.id && <p className="whitespace-pre-wrap break-words px-8 pb-3 text-[12.5px] leading-relaxed text-ink-2">{item.body || 'No content added yet.'}</p>}
        </div>) : <p className="px-2 py-2 text-[13px] text-muted-foreground/70">No context added to this RevBox yet.</p>}
      </SettingsGroup>;
    })}
  </>;
}
