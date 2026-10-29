// Intelligence (GET-1039; named so in GET-1044, was "Living files") in Settings > Knowledge: context
// OpenNous writes and keeps current, so it compounds. Each is turned on here by an owner or admin, then lives in the library like any file
// (versions, repo sync). A gallery since GET-1076 (the Library below stays a list): a card per file,
// its title, what it is about, when it last changed, and a switch. Open source since 2026-10-29 (the
// API's /api/context/living-files). Where Settings has a page for a card (Cloud: ?page=icp | win-loss,
// GET-1074, GET-1075, listed in `pages`) it opens in place; otherwise the card opens the file.
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';
import { when } from '@/lib/format';
import { knowledgeKey, knowledgeRequest } from '@/lib/knowledge';

// GET-1055: how far behind an enabled file is: items newer than the last one it read, cited items
// since retired, and the points resting on them. null when the API could not read it.
type Behind = { new: number; retracted: number; points: number };
type LivingFile = { key: string; title: string; about: string; enabled: boolean; file_id: string | null; last_run_at?: string | null; last_error?: string | null; behind?: Behind | null };

/** The ICP heads the group (GET-1044): the workspace writes who it sells to, OpenNous adds what closed deals taught. */
type IcpFile = { id: string; updated_at?: string | null };

// The Workflows list's switch, so an on/off reads the same in both places.
const SWITCH = 'h-[18px] w-[30px] border-0 data-[state=unchecked]:bg-border [&>span]:size-3.5 [&>span]:translate-x-0.5 [&>span]:shadow-[0_1px_2px_rgba(0,0,0,.2)] [&>span]:data-[state=checked]:translate-x-[14px]';

export function LivingFilesGroup({ ws, token, onOpen, icp, onAddIcp, pages = [] }: {
  ws: string; token: string; onOpen: (fileId: string) => void; icp: IcpFile | null; onAddIcp?: () => void; pages?: readonly string[];
}) {
  const cache = useQueryClient();
  const [, setParams] = useSearchParams();
  const openPage = (page: string) => setParams(p => { const n = new URLSearchParams(p); n.set('page', page); n.delete('file'); return n; });
  const key = ['living-files', ws];
  const q = useQuery({ queryKey: key, enabled: !!ws && !!token, queryFn: () => knowledgeRequest<{ files: LivingFile[]; can_manage: boolean }>(ws, token, '/living-files') });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!q.data) return null;
  const manage = q.data.can_manage;

  async function toggle(f: LivingFile) {
    setBusy(f.key); setError(null);
    try {
      await knowledgeRequest(ws, token, `/living-files/${f.key}`, { method: 'POST', body: JSON.stringify({ enabled: !f.enabled }) });
      await Promise.all([cache.invalidateQueries({ queryKey: key }), cache.invalidateQueries({ queryKey: knowledgeKey(ws) })]);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }

  const pageOf: Record<string, string> = { win_loss: 'win-loss' };
  const hasPage = (page: string | undefined) => !!page && pages.includes(page);
  return <section className="mb-5">
    <h2 className="section-title px-2 pb-2">Intelligence</h2>
    {error && <p role="alert" className="px-2 pb-2 text-[12px] text-risk">{error}</p>}
    <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
      <Card title="ICP" about="Who you sell to, and how well the score predicts revenue." meta={icp?.updated_at ? when(icp.updated_at) : null}
        onOpen={icp ? () => (hasPage('icp') ? openPage('icp') : onOpen(icp.id)) : undefined}>
        {!icp && onAddIcp && <Button size="sm" variant="outline" onClick={onAddIcp}>Write it</Button>}
      </Card>
      {q.data.files.map(f => <Card key={f.key} title={f.title} about={f.about} error={f.last_error}
        meta={f.enabled ? (f.last_run_at ? when(f.last_run_at) : null) : 'Off'}
        onOpen={f.enabled && f.file_id ? () => (hasPage(pageOf[f.key]) ? openPage(pageOf[f.key]) : onOpen(f.file_id!)) : undefined}>
        {manage && (busy === f.key
          ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          : <Switch checked={f.enabled} onCheckedChange={() => void toggle(f)} aria-label={`${f.title}: ${f.enabled ? 'on' : 'off'}`} className={SWITCH} />)}
      </Card>)}
    </div>
  </section>;
}

// One card: the whole card opens the file or page; the control in its corner works on its own.
function Card({ title, about, meta, error, onOpen, children }: {
  title: string; about?: string; meta?: string | null; error?: string | null; onOpen?: () => void; children?: React.ReactNode;
}) {
  return <div className={cn('relative flex min-h-[112px] flex-col rounded-2xl border border-border/70 bg-card p-3.5', onOpen && 'transition-colors duration-fast hover:bg-hover')}>
    {onOpen && <button type="button" onClick={onOpen} aria-label={`Open ${title}`} className="absolute inset-0 rounded-2xl" />}
    <div className="flex items-start justify-between gap-3">
      <span className="text-[13.5px] font-medium text-foreground">{title}</span>
      {children && <span className="relative z-10 flex shrink-0 items-center">{children}</span>}
    </div>
    {about && <p className="mt-1 line-clamp-2 text-[12.5px] text-muted-foreground">{about}</p>}
    {error && <p className="mt-1 text-[12px] text-risk">{error}</p>}
    {meta && <span className="mt-auto pt-2 text-[12px] tabular-nums text-muted-foreground/70">{meta}</span>}
  </div>;
}
