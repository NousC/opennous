import { useState, useEffect, useCallback } from "react";
import { Check } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

type Member = { user_id: string; name: string | null; email: string | null; avatar: string | null; shared: boolean };

const initial = (n?: string | null, e?: string | null) => (n?.trim()?.[0] ?? e?.trim()?.[0] ?? "?").toUpperCase();

// Share an account/person with a teammate — a small popover that lists the team and
// toggles a share per person. Shared records land on the teammate's "Shared with me".
export default function ShareMenu({ entityId, entityKind, entityName }: {
  entityId: string;
  entityKind: "company" | "person";
  entityName?: string;
}) {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const workspaceId = userData?.workspace?.id ?? "";
  const q = `?workspaceId=${workspaceId}`;
  const [open, setOpen] = useState(false);
  const [team, setTeam] = useState<Member[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    if (!entityId || !workspaceId || !token) return;
    setLoading(true);
    fetch(`${apiUrl}/api/shares${q}&entityId=${encodeURIComponent(entityId)}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.json() : null))
      .then(d => setTeam(d?.team ?? []))
      .finally(() => setLoading(false));
  }, [entityId, workspaceId, token]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (open) load(); }, [open, load]);

  const toggle = async (m: Member) => {
    const nowShared = !m.shared;
    setTeam(t => t.map(x => x.user_id === m.user_id ? { ...x, shared: nowShared } : x));   // optimistic
    try {
      if (nowShared) {
        await fetch(`${apiUrl}/api/shares${q}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ entityId, entityKind, entityName, userId: m.user_id }),
        });
      } else {
        await fetch(`${apiUrl}/api/shares${q}&entityId=${encodeURIComponent(entityId)}&userId=${m.user_id}`, {
          method: "DELETE", headers: { Authorization: `Bearer ${token}` },
        });
      }
    } catch {
      setTeam(t => t.map(x => x.user_id === m.user_id ? { ...x, shared: !nowShared } : x));   // revert
    }
  };

  const sharedCount = team.filter(m => m.shared).length;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        title="Share with a teammate"
        aria-label="Share"
        className="inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2 text-[12.5px] font-medium text-ink-2 transition-colors duration-fast hover:bg-hover hover:text-foreground"
      >
        Share
        {sharedCount > 0 && <span className="font-normal tabular-nums text-muted-foreground">{sharedCount}</span>}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-9 z-40 w-72 rounded-xl border border-border bg-background p-1.5 shadow-xl">
            <div className="px-2.5 py-2 text-[11px] font-medium text-muted-foreground/60">Share with a teammate</div>
            {loading && team.length === 0 && <div className="px-2.5 py-3 text-[12px] text-muted-foreground/50">Loading…</div>}
            {!loading && team.length === 0 && <div className="px-2.5 py-3 text-[12px] text-muted-foreground/50">No teammates to share with yet.</div>}
            {team.map(m => (
              <button key={m.user_id} onClick={() => toggle(m)}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-muted/50">
                {m.avatar
                  ? <img src={m.avatar} alt="" className="h-6 w-6 flex-shrink-0 rounded-full object-cover" />
                  : <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground/80">{initial(m.name, m.email)}</span>}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-foreground">{m.name || m.email || "Teammate"}</span>
                  {m.name && m.email && <span className="block truncate text-[11.5px] text-muted-foreground/55">{m.email}</span>}
                </span>
                {m.shared && <Check className="h-4 w-4 flex-shrink-0 text-emerald-600" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
