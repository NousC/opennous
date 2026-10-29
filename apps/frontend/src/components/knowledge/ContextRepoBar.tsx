// The company repo behind Settings > Knowledge (GET-1037), on top of the library. Open source since
// 2026-10-29: the API's /api/context/repo routes. Connected: the repo,
// branch and folder, when it last synced and how, Sync now and Disconnect. Not connected: an owner or
// admin connects it with a fine-grained token (Contents read/write on that one repo; Webhooks too for
// instant sync, else it is read every hour). Every file shared with the workspace then syncs both
// ways as <folder>/<file>.md (Playbooks by default: the playbooks get better over time), and each version is a commit by whoever wrote it.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Github, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { SettingsGroup, fieldCls } from '@/components/settings/SettingsKit';
import { knowledgeKey, knowledgeRequest } from '@/lib/knowledge';

type ContextRepo = {
  repo: string; branch: string; base_path: string; auto_sync: boolean; webhook: boolean;
  sync_status: string; last_error: string | null; last_synced_at: string | null; last_synced_via: string | null; connected_at: string;
};
const TOKEN_HELP = 'https://github.com/settings/personal-access-tokens/new';

export function ContextRepoBar({ ws, token }: { ws: string; token: string }) {
  const cache = useQueryClient();
  const key = ['context-repo', ws];
  const q = useQuery({ queryKey: key, enabled: !!ws && !!token, queryFn: () => knowledgeRequest<{ repo: ContextRepo | null; can_manage: boolean }>(ws, token, '/repo') });
  const [form, setForm] = useState<{ repo: string; token: string; branch: string; base_path: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);

  async function send(path: string, method: string, body?: unknown, done?: (out: Record<string, unknown>) => void) {
    setBusy(true); setNote(null);
    try {
      const out = await knowledgeRequest<Record<string, unknown>>(ws, token, path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
      await Promise.all([cache.invalidateQueries({ queryKey: key }), cache.invalidateQueries({ queryKey: knowledgeKey(ws) })]);
      done?.(out);
    } catch (e) { setNote({ text: (e as Error).message, error: true }); }
    finally { setBusy(false); }
  }

  const repo = q.data?.repo ?? null;
  const manage = !!q.data?.can_manage;
  if (q.isLoading || (!repo && !manage)) return null;

  // Connected (2026-10-29): the mark, the repo as a link, Sync now; Disconnect stays quiet until
  // you point at it.
  if (repo) return <SettingsGroup>
    <div className="flex min-h-11 flex-wrap items-center gap-3 px-2">
      <Github className="h-4 w-4 shrink-0 text-foreground" />
      <span className="min-w-0 flex-1">
        <a href={`https://github.com/${repo.repo}/tree/${repo.branch}/${repo.base_path}`} target="_blank" rel="noreferrer" className="group inline-flex items-center gap-1 text-[13.5px] text-foreground">
          <span className="group-hover:underline">{repo.repo}</span><span className="text-muted-foreground">/{repo.base_path}</span><ExternalLink className="h-3 w-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        </a>
        {/* Just the repo (2026-10-28): when it last synced, how and on which branch is noise here.
            A failed sync still says so, since that one needs you. */}
        {repo.sync_status === 'error' && <span className="block text-[11.5px] text-risk">Sync failed: {repo.last_error ?? 'unknown error'}</span>}
      </span>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void send('/repo/sync', 'POST', undefined, out => { const p = out.pulled as Record<string, number> | undefined; setNote({ text: p ? `Synced: ${p.pulled} updated from the repo, ${p.created} new, ${p.pushed_back} kept from the app.` : 'Synced.' }); })}><RefreshCw />Sync now</Button>
      {manage && <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-risk" disabled={busy} onClick={() => { if (window.confirm(`Disconnect ${repo.repo}? The files stay in both places as they are.`)) void send('/repo', 'DELETE'); }}>Disconnect</Button>}
    </div>
    {note && <p role={note.error ? 'alert' : 'status'} className={cn('px-2 pb-1.5 text-[12px]', note.error ? 'text-risk' : 'text-muted-foreground')}>{note.text}</p>}
  </SettingsGroup>;

  return <SettingsGroup>
    {!form ? <div className="flex flex-wrap items-center gap-3 px-2 py-2">
      <Github className="h-4 w-4 shrink-0 text-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] text-foreground">Keep your context in your own repo</span>
        <span className="block text-[11.5px] text-muted-foreground/80">Every shared file syncs both ways as markdown, and each change is a commit by whoever made it.</span>
      </span>
      <Button size="sm" variant="outline" onClick={() => setForm({ repo: '', token: '', branch: '', base_path: 'Playbooks' })}>Connect repo</Button>
    </div> : <div className="space-y-3 px-2 py-2">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-[12px]">Repository<input aria-label="Repository" autoFocus className={cn(fieldCls, 'mt-1.5 sm:w-full')} placeholder="owner/name" value={form.repo} onChange={e => setForm({ ...form, repo: e.target.value })} /></label>
        <label className="block text-[12px]">Folder in the repo<input aria-label="Folder in the repo" className={cn(fieldCls, 'mt-1.5 sm:w-full')} placeholder="Playbooks" value={form.base_path} onChange={e => setForm({ ...form, base_path: e.target.value })} />
          <span className="mt-1 block text-[11px] text-muted-foreground/70">Files sync as {(form.base_path.trim() || 'Playbooks').replace(/^\/+|\/+$/g, '')}/&lt;file&gt;.md</span></label>
        <label className="block text-[12px]">Branch<input aria-label="Branch" className={cn(fieldCls, 'mt-1.5 sm:w-full')} placeholder="the default branch" value={form.branch} onChange={e => setForm({ ...form, branch: e.target.value })} /></label>
        <label className="block text-[12px]"><span className="flex items-center justify-between">Token<a href={TOKEN_HELP} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">Create one <ExternalLink className="h-3 w-3" /></a></span>
          <input aria-label="Token" type="password" autoComplete="off" className={cn(fieldCls, 'mt-1.5 sm:w-full')} placeholder="github_pat_…" value={form.token} onChange={e => setForm({ ...form, token: e.target.value })} /></label>
      </div>
      <p className="text-[11.5px] text-muted-foreground/80">A fine-grained token for this one repo with Contents: read and write. Add Webhooks: read and write for instant sync; without it, the repo is checked every hour. Sync now reads it any time. Stored encrypted, never shown again.</p>
      {note && <p role="alert" className="text-[12px] text-risk">{note.text}</p>}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setForm(null); setNote(null); }}>Cancel</Button>
        <Button size="sm" disabled={busy || !/^[^/\s]+\/[^/\s]+$/.test(form.repo.trim().replace(/^https?:\/\/github\.com\//, '')) || form.token.trim().length < 20}
          onClick={() => void send('/repo', 'POST', { repo: form.repo.trim(), token: form.token.trim(), branch: form.branch.trim() || null, base_path: form.base_path.trim() || 'Playbooks' }, () => setForm(null))}>
          {busy ? 'Connecting…' : 'Connect'}
        </Button>
      </div>
    </div>}
  </SettingsGroup>;
}
