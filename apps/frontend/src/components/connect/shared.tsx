// The pieces both Connect agent dialogs share (GET-626, GET-627): the workspace's keys, the key
// picker, a copyable code block, and the dialog's head and foot.

import * as React from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Check, Code2, KeyRound, Plus, X } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { DialogClose, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

export type WorkspaceKey = { id: string; name: string; created_at: string; last_used_at?: string | null };

/** The workspace's live keys, from the same endpoint the API keys page reads. Polls while
 *  `pollMs` is set, so a key's first call shows up without reopening the dialog. */
export function useWorkspaceKeys(pollMs: number | false = false) {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const workspaceId = userData?.workspace?.id ?? "";
  return useQuery<WorkspaceKey[]>({
    queryKey: ["workspace-api-keys", workspaceId],
    queryFn: async () => {
      const r = await fetch(`${apiUrl}/api/workspace/api-keys?workspace_id=${encodeURIComponent(workspaceId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) return [];
      const d = await r.json();
      return (d.api_keys ?? d.apiKeys ?? []) as WorkspaceKey[];
    },
    enabled: !!token && !!workspaceId,
    refetchInterval: pollMs,
  });
}

/** Which key the dialog is about. Starts on the most recently used one, else the newest. */
export function useChosenKey(keys: WorkspaceKey[] | undefined) {
  const [chosen, setChosen] = React.useState<string | null>(null);
  const list = keys ?? [];
  const fallback = React.useMemo(() => {
    const used = list.filter((k) => k.last_used_at).sort((a, b) => String(b.last_used_at).localeCompare(String(a.last_used_at)));
    return (used[0] ?? list[0])?.id ?? null;
  }, [list]);
  const id = chosen && list.some((k) => k.id === chosen) ? chosen : fallback;
  return { key: list.find((k) => k.id === id) ?? null, setKey: setChosen };
}

export const fieldLabel = "mb-1.5 block text-[12px] font-medium text-ink-2";

export function KeyPicker({ keys, value, onChange, onNew, compact = false }: {
  keys: WorkspaceKey[]; value: string | null; onChange: (id: string) => void; onNew: () => void; compact?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      {keys.length ? (
        <Select value={value ?? undefined} onValueChange={onChange}>
          <SelectTrigger aria-label="Choose API key" className="h-8 min-w-0 flex-1 gap-2 rounded-lg border-border bg-card px-2.5 text-[12.5px] focus:ring-1 focus:ring-offset-0">
            <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={1.8} />
            <span className="min-w-0 flex-1 truncate text-left"><SelectValue placeholder="Choose a key" /></span>
          </SelectTrigger>
          <SelectContent>
            {keys.map((k) => (
              <SelectItem key={k.id} value={k.id} className="text-[12.5px]">{k.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <span className="flex h-8 min-w-0 flex-1 items-center rounded-lg border border-dashed border-border px-2.5 text-[12.5px] text-muted-foreground">No keys yet</span>
      )}
      <Link to="/keys" onClick={onNew}
        className="inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-lg px-1.5 text-[12.5px] font-medium text-ink-2 transition-colors duration-fast hover:text-foreground">
        {compact ? "New" : "New key"}
      </Link>
    </div>
  );
}

export function CodeSnippet({ code, className }: { code: string; className?: string }) {
  const [copied, setCopied] = React.useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    }).catch(() => {});
  };
  return (
    <div className={cn("relative rounded-[9px] bg-[#1A1A18] py-2.5 pl-3 pr-16 text-[#E9E8E4]", className)}>
      <pre className="m-0 whitespace-pre-wrap break-all font-mono text-[11.5px] leading-[1.6]">{code}</pre>
      <button type="button" onClick={copy}
        className="absolute right-[7px] top-[7px] inline-flex h-6 items-center gap-1 rounded-md bg-white/[0.12] px-2 text-[11.5px] font-medium text-white transition-colors hover:bg-white/20">
        {copied ? <><Check className="h-3 w-3" strokeWidth={2.2} />Copied</> : "Copy"}
      </button>
    </div>
  );
}

export function ConnectHead({ icon: Icon, title }: { icon: React.ElementType; title: string }) {
  return (
    <div className="flex items-center gap-2.5 border-b border-hairline py-3.5 pl-5 pr-4">
      <span className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-[7px] bg-muted text-ink-2">
        <Icon className="h-4 w-4" strokeWidth={1.7} />
      </span>
      <DialogTitle className="flex-1 text-[14px] font-semibold leading-none tracking-normal">{title}</DialogTitle>
      <DialogClose aria-label="Close" className="inline-flex h-7 w-7 items-center justify-center rounded-[7px] text-muted-foreground transition-colors hover:bg-hover hover:text-foreground">
        <X className="h-4 w-4" strokeWidth={1.7} />
      </DialogClose>
    </div>
  );
}

export function ConnectFoot({ docsHref, docsLabel }: { docsHref: string; docsLabel: string }) {
  return (
    <div className="flex items-center gap-2 border-t border-hairline bg-muted/40 py-3 pl-5 pr-4">
      <a href={docsHref} target="_blank" rel="noreferrer"
        className="inline-flex h-[30px] items-center gap-1.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:text-foreground">
        {docsLabel}<ArrowUpRight className="h-3 w-3" strokeWidth={1.8} />
      </a>
      <span className="flex-1" />
      <DialogClose className="inline-flex h-[30px] items-center rounded-lg bg-foreground px-3 text-[12.5px] font-medium text-background shadow-[0_1px_2px_rgba(20,20,18,0.18)] transition-opacity hover:opacity-90">
        Done
      </DialogClose>
    </div>
  );
}

/** The real logo of a client or platform you connect Nous to (GET-661): Claude Code, Cursor, Codex,
 *  n8n, Zapier. "api" and "other" have no brand, so they get one quiet icon. */
const CLIENT_LOGO: Record<string, string> = {
  claude: "/provider-logos/claude.svg",
  cursor: "/provider-logos/cursor.svg",
  codex: "/provider-logos/codex.png",
  n8n: "/provider-logos/n8n.svg",
  zapier: "/provider-logos/zapier.svg",
};
export function ClientLogo({ id, size = 16, className }: { id: string; size?: number; className?: string }) {
  const src = CLIENT_LOGO[id];
  if (src) return <img src={src} alt="" width={size} height={size} className={cn("shrink-0 object-contain", className)} style={{ width: size, height: size }} />;
  const Icon = id === "api" ? Code2 : Plus;
  return <Icon className={cn("shrink-0 text-muted-foreground", className)} style={{ width: size * 0.85, height: size * 0.85 }} strokeWidth={1.8} />;
}
