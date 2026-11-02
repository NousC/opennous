// Settings > Team > one person (GET-1120): an admin's view of their agents, what those agents did and
// worked on, and the documents they can read. Usage only, no content. Reads /api/usage/team/:userId.
// Drawn like the app's list pages: a view tab per subject over a flat table, as Documents and Events.
import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { fieldCls } from "@/components/settings/SettingsKit";
import { Link } from "react-router-dom";
import { ViewTabs } from "@/components/ui/view-tabs";
import { cn } from "@/lib/utils";
import { PersonAvatar } from "@/components/ui/owner-filter";
import { freshAccessToken } from "@/lib/freshToken";
import { when } from "@/lib/format";
import { VISIBILITY_LABEL, type ContextVisibility } from "@/lib/knowledge";
import { aboutHref, aboutLabel, type About } from "@/lib/apiActivity";

const apiUrl = import.meta.env.VITE_API_URL ?? "";
const AGENT_LABEL: Record<string, string> = { "claude-code": "Claude Code", "claude-ai": "Claude", claude: "Claude", cursor: "Cursor", codex: "Codex", chatgpt: "ChatGPT", grok: "Grok Bot" };
export const agentLabel = (name: string) => AGENT_LABEL[name.toLowerCase()] ?? name;
/** A route as a person reads it. One we haven't named shows its last word. */
const TOOL_LABEL: Record<string, string> = {
  context: "Read an account", accounts: "Read an account", attention: "Checked the worklist", record: "Logged what happened", observations: "Logged what happened",
  deals: "Read deals", query: "Searched the graph", tasks: "Worked on tasks", insights: "Read insights", intelligence: "Read Intelligence",
  "company-documents": "Read a document", notes: "Added a note", score: "Scored an account", rules: "Changed a rule", enrich: "Enriched a record", "rev-plays": "Worked on RevPlays",
};
const toolLabel = (route: string) => { const part = route.replace(/^[A-Z]+\s+/, "").replace(/^\/v2\//, "").split("/")[0]; return TOOL_LABEL[part] ?? part.replace(/-/g, " "); };

type Detail = {
  last_active_at: string | null; calls_7d: number; calls_30d: number;
  agents: { name: string; last_at: string }[];
  tools: { route: string; calls: number }[];
  accounts: (NonNullable<About> & { at: string })[];
  calls: { id: string; at: string; route: string; target: string | null; about: About; status: number; client: string | null }[];
  documents: { id: string; title: string; folder: string; shared: ContextVisibility; updated_at: string }[];
  keys: { id: string; name: string; created_at: string; revoked: boolean; expires_at: string | null }[];
};

type Tab = "assigned" | "activity" | "agents" | "accounts" | "documents" | "access";
type Assignment = { id: string; kind: "skill" | "pin"; title: string; body: string; audience: string; target_user_id: string | null };
const KIND_LABEL = { skill: "Skill", pin: "Pin" };

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${apiUrl}${path}`, { ...init, headers: { "Content-Type": "application/json", Authorization: `Bearer ${(await freshAccessToken()) ?? ""}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail ?? body.error ?? "Something went wrong.");
  return body as T;
}
const COLUMNS = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 sm:grid-cols-[minmax(0,1fr)_180px_130px]";

/** The Documents table: a quiet header, then hairline rows. */
function Table({ head, rows, empty }: { head: [string, string, string]; rows: { key: string; name: ReactNode; type: ReactNode; when: ReactNode }[]; empty: string }) {
  return <>
    <div className={cn(COLUMNS, "border-b border-border/70 py-2 text-[11.5px] font-medium text-muted-foreground/70")}>
      <span>{head[0]}</span><span className="hidden sm:block">{head[1]}</span><span className="text-right sm:text-left">{head[2]}</span>
    </div>
    {rows.length ? rows.map((r) => (
      <div key={r.key} className={cn(COLUMNS, "min-h-10 border-b border-border/50 text-[13px] transition-colors duration-fast hover:bg-hover")}>
        <span className="min-w-0 truncate text-foreground">{r.name}</span>
        <span className="hidden truncate text-[12.5px] text-muted-foreground sm:block">{r.type}</span>
        <span className="text-right text-[12.5px] tabular-nums text-muted-foreground sm:text-left">{r.when}</span>
      </div>
    )) : <p className="py-10 text-center text-[13px] text-muted-foreground">{empty}</p>}
  </>;
}

export function TeamMember({ workspaceId, userId, name, email, avatar, role }: {
  workspaceId: string; userId: string; name: string; email: string; avatar?: string | null; role: string;
}) {
  const [tab, setTab] = useState<Tab>("assigned");
  const cache = useQueryClient();
  const [draft, setDraft] = useState<{ kind: "skill" | "pin"; title: string; body: string; everyone: boolean } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const assignedKey = ["team-member-assigned", workspaceId, userId];
  const assigned = useQuery({ queryKey: assignedKey, enabled: !!workspaceId, queryFn: () => api<{ assignments: Assignment[] }>(`/v2/assignments?workspaceId=${workspaceId}&user=${userId}`) });
  const list = assigned.data?.assignments ?? [];
  async function save() {
    if (!draft) return;
    setSaveError(null);
    try {
      await api(`/v2/assignments?workspaceId=${workspaceId}`, { method: "POST", body: JSON.stringify({ kind: draft.kind, title: draft.title, body: draft.body, ...(draft.everyone ? {} : { target_user_id: userId }) }) });
      setDraft(null);
      await cache.invalidateQueries({ queryKey: assignedKey });
    } catch (e) { setSaveError((e as Error).message); }
  }
  async function remove(a: Assignment) {
    if (!window.confirm(`Remove "${a.title}"?`)) return;
    await api(`/v2/assignments/${a.id}/remove?workspaceId=${workspaceId}`, { method: "POST", body: "{}" }).catch((e) => toast.error((e as Error).message));
    await cache.invalidateQueries({ queryKey: assignedKey });
  }
  const q = useQuery({
    queryKey: ["team-member", workspaceId, userId], enabled: !!workspaceId,
    queryFn: async (): Promise<Detail> => {
      const res = await fetch(`${apiUrl}/api/usage/team/${userId}?workspaceId=${workspaceId}`, { headers: { Authorization: `Bearer ${(await freshAccessToken()) ?? ""}` } });
      if (!res.ok) throw new Error(res.status === 404 ? "This person is no longer in the workspace." : "Could not load this person.");
      return res.json();
    },
  });
  const d = q.data;
  const facts = d ? [`Last active ${d.last_active_at ? when(d.last_active_at) : "never"}`, `${d.calls_7d} calls, 7 days`, `${d.calls_30d} calls, 30 days`] : [];
  return <div className="px-6 pb-10 pt-5">
    <div className="flex flex-wrap items-center gap-3">
      {avatar ? <img src={avatar} alt="" className="h-8 w-8 rounded-full object-cover" /> : <PersonAvatar person={{ id: userId, name: name || email }} size={32} />}
      <div className="min-w-0 flex-1"><div className="truncate text-[15px] font-medium text-foreground">{name || email}</div><div className="truncate text-[12px] text-muted-foreground">{[role, email].filter(Boolean).join(" · ")}</div></div>
      <div className="text-[12.5px] tabular-nums text-muted-foreground">{facts.join(" · ")}</div>
    </div>
    {q.error && <p role="alert" className="mt-6 text-[13px] text-risk">{(q.error as Error).message}</p>}
    {q.isLoading && <p className="mt-6 text-[13px] text-muted-foreground">Loading…</p>}
    {d && <>
      <ViewTabs<Tab> aria-label="About this person" className="mb-3 mt-5" value={tab} onChange={setTab} options={[
        { value: "assigned", label: "Assigned", count: list.length },
        { value: "activity", label: "Activity", count: d.calls.length },
        { value: "agents", label: "Agents", count: d.agents.length },
        { value: "accounts", label: "Worked on", count: d.accounts.length },
        { value: "documents", label: "Documents", count: d.documents.length },
        { value: "access", label: "Access", count: d.keys.length },
      ]} />
      {tab === "assigned" && <>
        <div className="mb-2 flex justify-end"><Button size="sm" variant="outline" onClick={() => setDraft({ kind: "skill", title: "", body: "", everyone: false })}><Plus />Assign</Button></div>
        <Table head={["Name", "Type", "For"]} empty="Nothing assigned" rows={list.map((a) => ({
          key: a.id, name: <button type="button" title="Remove" onClick={() => void remove(a)} className="truncate text-left hover:underline">{a.title}</button>, type: KIND_LABEL[a.kind], when: a.target_user_id ? "This person" : a.audience,
        }))} />
      </>}
      {tab === "activity" && <Table head={["Action", "Agent", "When"]} empty="Nothing yet" rows={d.calls.map((c) => ({
        key: c.id, name: [toolLabel(c.route), c.about?.name].filter(Boolean).join(" · "), type: c.client ? agentLabel(c.client.split("/")[0]) : "", when: when(c.at),
      }))} />}
      {tab === "agents" && <>
        <Table head={["Agent", "", "Last run"]} empty="Not connected" rows={d.agents.map((a) => ({ key: a.name, name: agentLabel(a.name), type: "", when: when(a.last_at) }))} />
        {d.tools.length > 0 && <div className="mt-6"><Table head={["Uses most", "", "Calls"]} empty="" rows={d.tools.map((t) => ({ key: t.route, name: toolLabel(t.route), type: "", when: t.calls }))} /></div>}
      </>}
      {tab === "accounts" && <Table head={["Name", "Type", "Last worked on"]} empty="Nothing yet" rows={d.accounts.map((a) => {
        const to = aboutHref(a);
        return { key: a.id, name: to ? <Link to={to} className="hover:underline">{aboutLabel(a, null)}</Link> : aboutLabel(a, null), type: a.type === "company" ? "Account" : a.type === "person" ? "Person" : "Deal", when: when(a.at) };
      })} />}
      {tab === "documents" && <Table head={["Name", "Folder", "Shared with"]} empty="No documents" rows={d.documents.map((f) => ({
        key: f.id, name: <Link to={`/knowledge?file=${f.id}`} className="hover:underline">{f.title}</Link>, type: f.folder, when: VISIBILITY_LABEL[f.shared],
      }))} />}
      {tab === "access" && <Table head={["Key", "Status", "Added"]} empty="No keys" rows={d.keys.map((k) => ({ key: k.id, name: k.name, type: k.revoked ? "Revoked" : "Active", when: when(k.created_at) }))} />}
    </>}
    <Dialog open={!!draft} onOpenChange={(o) => { if (!o) { setDraft(null); setSaveError(null); } }}>
      <DialogContent className="gap-0 sm:max-w-[520px]">
        <DialogHeader><DialogTitle className="text-[16px] font-medium">Assign</DialogTitle></DialogHeader>
        {draft && <div className="mt-4 space-y-4 text-[12px]">
          <div className="flex gap-1.5">{(["skill", "pin"] as const).map((k) => <button key={k} type="button" aria-pressed={draft.kind === k} onClick={() => setDraft({ ...draft, kind: k })} className={cn("rounded-lg border px-2.5 py-1 text-[12px]", draft.kind === k ? "border-foreground/40 bg-muted font-medium" : "border-border/70 text-muted-foreground")}>{KIND_LABEL[k]}</button>)}</div>
          <label className="block">Title<input aria-label="Title" className={cn(fieldCls, "mt-1.5 sm:w-full")} value={draft.title} maxLength={200} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label>
          <label className="block">Text<textarea aria-label="Text" rows={8} className="mt-1.5 w-full resize-y rounded-lg border border-border/70 bg-card px-2.5 py-2 text-[13px] outline-none focus:border-foreground/25" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} /></label>
          <div className="flex gap-1.5">{[[false, name || "This person"], [true, "Everyone"]].map(([v, l]) => <button key={String(v)} type="button" aria-pressed={draft.everyone === v} onClick={() => setDraft({ ...draft, everyone: v as boolean })} className={cn("rounded-lg border px-2.5 py-1 text-[12px]", draft.everyone === v ? "border-foreground/40 bg-muted font-medium" : "border-border/70 text-muted-foreground")}>{l as string}</button>)}</div>
          {saveError && <p role="alert" className="text-risk">{saveError}</p>}
          <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button><Button disabled={!draft.title.trim() || !draft.body.trim()} onClick={() => void save()}>Assign</Button></div>
        </div>}
      </DialogContent>
    </Dialog>
  </div>;
}

/** The Team page's log (GET-1122): what went out, with a way back for anything assigned. */
export function TeamChanges({ workspaceId }: { workspaceId: string }) {
  const cache = useQueryClient();
  const key = ["team-changes", workspaceId];
  const q = useQuery({ queryKey: key, enabled: !!workspaceId, queryFn: () => api<{ changes: { id: string; action: string; subject: string; audience: string | null; assignment_id: string | null; rolled_back_at: string | null; created_at: string }[] }>(`/v2/changes?workspaceId=${workspaceId}`) });
  const undo = async (id: string) => { await api(`/v2/changes/${id}/rollback?workspaceId=${workspaceId}`, { method: "POST", body: "{}" }).catch((e) => toast.error((e as Error).message)); await cache.invalidateQueries({ queryKey: key }); };
  const words = (a: string) => a.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  const rows = (q.data?.changes ?? []).slice(0, 15).map((c) => ({
    key: c.id, name: `${words(c.action)}: ${c.subject}`, type: c.audience ?? "",
    when: c.rolled_back_at ? "Rolled back" : c.assignment_id && !c.action.startsWith("rolled") ? <button type="button" className="hover:text-foreground hover:underline" onClick={() => void undo(c.id)}>{when(c.created_at)} · Undo</button> : when(c.created_at),
  }));
  return rows.length ? <div className="mt-6"><Table head={["Changes", "Reached", "When"]} empty="" rows={rows} /></div> : null;
}
