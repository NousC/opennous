// Settings › Repo (GET-668): the GitHub repo Nous files account and people evidence into, drawn in
// the search palette's language like the rest of the interface. Quiet cards, inset rows, a 24px
// tile per row, the connect form in the shared popup, the disconnect question in the shared alert.
import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, FileText, FolderGit2, Github, RefreshCw, Users } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ListCard, ListEmpty, ListGroup, ListHeader, ListMeta, ListRow, ListText, ListTile } from "@/components/ui/list";
import { when } from "@/lib/format";
import { cn } from "@/lib/utils";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

type Source = {
  source_type: string; connected: boolean; repo: string | null; branch: string | null; base_path: string | null;
  last_synced_at: string | null; auto_sync?: boolean; sync_mode?: "webhook" | "poll"; last_synced_via?: string | null;
  local_label?: string | null; folder_map?: Record<string, string>;
};
type Filed = { id: string; source: string; event_type: string; summary: string; occurred_at: string };

export function RepositoriesPane({ token, workspaceId, embedded }: { token: string; workspaceId: string; fullWidth?: boolean; embedded?: boolean }) {
  const q = `?workspaceId=${workspaceId}`;
  const [source, setSource] = useState<Source | null>(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ repo: "", branch: "", token: "" });
  const [busy, setBusy] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [activity, setActivity] = useState<Filed[]>([]);
  const isLocal = source?.source_type === "local";
  const connected = !!source?.connected;

  const loadSource = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const r = await fetch(`${apiUrl}/api/personal/source${q}`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setSource((await r.json()).source);
    } finally { setLoading(false); }
  }, [token, q]);
  useEffect(() => { loadSource(); }, [loadSource]);

  // While connected, what Nous is filing into the repo, polled while the page is open.
  useEffect(() => {
    if (!connected || !token) return;
    let stop = false;
    const load = async () => {
      try {
        const r = await fetch(`${apiUrl}/api/workspace/system-log?workspace_id=${workspaceId}&days=30&limit=20`, { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) return;
        const d = await r.json();
        if (!stop) setActivity(Array.isArray(d?.events) ? d.events : []);
      } catch { /* the feed is best-effort */ }
    };
    load();
    const iv = setInterval(load, 15000);
    return () => { stop = true; clearInterval(iv); };
  }, [connected, token, workspaceId]);

  const connect = async () => {
    if (!form.repo.trim() || !form.token.trim()) { toast.error("Repo and token are required"); return; }
    setBusy(true);
    try {
      const r = await fetch(`${apiUrl}/api/personal/source/github${q}`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(form),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        setForm({ repo: "", branch: "", token: "" });
        setConnectOpen(false);
        await loadSource();
        if (d.warning) toast.error(`Connected, but couldn't read the repo: ${d.warning}`);
        else toast.success("Repo connected");
      } else toast.error(d.detail || "Couldn't connect");
    } finally { setBusy(false); }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await fetch(`${apiUrl}/api/personal/source${q}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
      await loadSource();
      toast.success("Repo disconnected. Your files stay in Nous and in the repo.");
    } finally { setBusy(false); setConfirmOpen(false); }
  };

  const folder = (source?.base_path || "nous").replace(/\/+$/, "");
  const repoUrl = source?.repo ? `https://github.com/${source.repo}${source.branch ? `/tree/${source.branch}/${folder}` : ""}` : null;
  const syncLabel = source?.sync_mode === "webhook" ? "On every push" : source?.sync_mode === "poll" ? "Every few minutes" : source?.auto_sync === false ? "Manual" : "Automatic";

  const body = loading ? (
    <ListCard><ListEmpty>Loading…</ListEmpty></ListCard>
  ) : connected ? (
    <div className="flex flex-col gap-4">
      <ListCard aria-label="Connected repo">
        <ListRow className="hover:bg-transparent">
          <ListTile className="text-foreground"><Github className="h-3.5 w-3.5" strokeWidth={1.8} /></ListTile>
          <ListText title={<span className="font-mono text-[12.5px]">{source?.repo}</span>} sub={source?.branch ?? undefined} />
          <span className="inline-flex flex-shrink-0 items-center gap-1.5 text-[12px] text-positive">
            <span className="h-1.5 w-1.5 rounded-full bg-positive" />Connected
          </span>
          {repoUrl && (
            <a href={repoUrl} target="_blank" rel="noreferrer"
              className="inline-flex flex-shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-[12px] text-ink-2 transition-colors duration-fast hover:bg-hover hover:text-foreground">
              GitHub<ArrowUpRight className="h-3 w-3" strokeWidth={1.8} />
            </a>
          )}
          <button type="button" onClick={() => setConfirmOpen(true)} disabled={busy}
            className="flex-shrink-0 rounded-md px-2 py-0.5 text-[12px] text-ink-2 transition-colors duration-fast hover:bg-hover hover:text-foreground">
            Disconnect
          </button>
        </ListRow>
        <div className="mx-2 my-1 border-t border-hairline" />
        <Detail icon={FolderGit2} label="Folder" value={<span className="font-mono text-[12.5px]">{folder}/</span>} />
        <Detail icon={RefreshCw} label="Sync" value={syncLabel} />
        <Detail icon={FileText} label="Last synced" value={source?.last_synced_at ? when(source.last_synced_at) : "Not yet"} />
      </ListCard>

      <ListCard aria-label="Recent activity">
        <ListHeader title="Recent activity" count={activity.length || null} />
        {activity.length === 0 ? (
          <ListEmpty>Nothing filed yet</ListEmpty>
        ) : (
          activity.map((e) => (
            <ListRow key={e.id} title={e.event_type}>
              <ListTile><FileText className="h-3.5 w-3.5" strokeWidth={1.75} /></ListTile>
              <ListText title={e.summary || e.event_type} />
              <ListMeta>{when(e.occurred_at)}</ListMeta>
            </ListRow>
          ))
        )}
      </ListCard>
    </div>
  ) : (
    <ListCard aria-label="GitHub repo">
      <ListRow className="hover:bg-transparent">
        <ListTile className="text-foreground"><Github className="h-3.5 w-3.5" strokeWidth={1.8} /></ListTile>
        <ListText title="GitHub repository" sub="Your account and people evidence, as markdown" />
        <Button size="sm" onClick={() => setConnectOpen(true)}>Connect</Button>
      </ListRow>
      <ListGroup>What Nous writes</ListGroup>
      <ListRow className="hover:bg-transparent">
        <ListTile><FileText className="h-3.5 w-3.5" strokeWidth={1.75} /></ListTile>
        <ListText title={<span className="font-mono text-[12.5px]">nous/accounts/</span>} sub="Every email and meeting, per account" />
      </ListRow>
      <ListRow className="hover:bg-transparent">
        <ListTile><Users className="h-3.5 w-3.5" strokeWidth={1.75} /></ListTile>
        <ListText title={<span className="font-mono text-[12.5px]">nous/people/</span>} sub="The same, per person" />
      </ListRow>
      <p className="px-2 pb-1 pt-2 text-[11.5px] text-muted-foreground/70">Nous only writes inside nous/. The rest of the repo is yours.</p>
      {isLocal && <p className="px-2 pb-1 text-[11.5px] text-warning">You sync a local folder from the CLI. Connecting a repo switches your source.</p>}
    </ListCard>
  );

  return (
    <div className={cn(!embedded && "px-4 py-6 sm:px-8")}>
      {body}

      {/* Connect: the shared popup, the search palette's look. */}
      <Dialog open={connectOpen} onOpenChange={(o) => { if (!busy) setConnectOpen(o); }}>
        <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[480px]">
          <DialogHeader className="border-b border-hairline px-5 py-3.5 text-left">
            <DialogTitle className="flex items-center gap-2"><Github className="h-4 w-4" strokeWidth={1.8} />Connect a GitHub repo</DialogTitle>
            <DialogDescription className="sr-only">Repository, optional branch, and a fine-grained token with contents read and write.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 px-5 py-4">
            <Field id="repo-name" label="Repository">
              <Input id="repo-name" autoFocus value={form.repo} onChange={(e) => setForm({ ...form, repo: e.target.value })}
                placeholder="owner/name" className="h-9 rounded-lg bg-card font-mono text-[12.5px]" />
            </Field>
            <Field id="repo-branch" label="Branch" hint="optional">
              <Input id="repo-branch" value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })}
                placeholder="default branch" className="h-9 rounded-lg bg-card font-mono text-[12.5px]" />
            </Field>
            <Field id="repo-token" label="Fine-grained token">
              <Input id="repo-token" type="password" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })}
                placeholder="github_pat_…" className="h-9 rounded-lg bg-card font-mono text-[12.5px]" />
              <p className="mt-1.5 text-[11.5px] text-muted-foreground/70">
                Contents: read and write, on this repo only. Stored encrypted.{" "}
                <a href="https://github.com/settings/tokens?type=beta" target="_blank" rel="noopener noreferrer" className="text-ink-2 underline underline-offset-2 hover:text-foreground">Create one</a>
              </p>
            </Field>
          </div>
          <DialogFooter className="flex items-center gap-2 border-t border-hairline px-5 py-3 sm:justify-end">
            <Button variant="ghost" onClick={() => setConnectOpen(false)} disabled={busy}>Cancel</Button>
            <Button onClick={connect} disabled={busy || !form.repo.trim() || !form.token.trim()}>{busy ? "Connecting…" : "Connect"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Disconnect: the shared alert instead of the browser's confirm. */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent className="sm:max-w-[420px]">
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {source?.repo ?? "this repo"}?</AlertDialogTitle>
            <AlertDialogDescription>New emails and meetings stop being written to it. Existing files stay, in the repo and in Nous.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); void disconnect(); }} disabled={busy}>Disconnect</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Detail({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: React.ReactNode }) {
  return (
    <div className="flex min-h-9 items-center gap-2.5 px-2">
      <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center text-muted-foreground/60"><Icon className="h-3.5 w-3.5" strokeWidth={1.75} /></span>
      <span className="w-28 flex-shrink-0 text-[12.5px] text-muted-foreground/80">{label}</span>
      <span className="min-w-0 truncate text-[13px] text-foreground">{value}</span>
    </div>
  );
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-[12px] font-medium text-ink-2">
        {label}{hint && <span className="font-normal text-muted-foreground/60"> {hint}</span>}
      </label>
      {children}
    </div>
  );
}
