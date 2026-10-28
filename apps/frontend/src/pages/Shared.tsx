import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { UsersRound, Building2, User as UserIcon } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { relTime } from "@/components/mind/shared";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

type Sharer = { name: string | null; email: string | null; profile_picture_url: string | null };
type Share = {
  entity_id: string;
  entity_kind: "company" | "person";
  entity_name: string | null;
  created_at: string;
  sharer: Sharer | null;
};

const initial = (n?: string | null, e?: string | null) => (n?.trim()?.[0] ?? e?.trim()?.[0] ?? "?").toUpperCase();

// Shared with me — the accounts and people teammates have shared with you.
export default function Shared() {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const workspaceId = userData?.workspace?.id ?? "";
  const navigate = useNavigate();
  const [shares, setShares] = useState<Share[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!workspaceId || !token) return;
    let alive = true;
    fetch(`${apiUrl}/api/shares/with-me?workspaceId=${workspaceId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (alive) setShares(d?.shares ?? []); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [workspaceId, token]);

  const open = (s: Share) => navigate(s.entity_kind === "company" ? `/accounts/${s.entity_id}` : `/contacts/${s.entity_id}`);

  if (!loading && shares.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-8 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-border bg-card">
          <UsersRound className="h-5 w-5 text-muted-foreground" strokeWidth={1.75} />
        </div>
        <h1 className="mt-5 text-[19px] font-semibold tracking-tight text-foreground">Shared with me</h1>
        <p className="mt-1.5 max-w-sm text-[13.5px] leading-relaxed text-muted-foreground">
          Accounts and people your teammates share will show up here. Nothing shared with you yet.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex-shrink-0 px-8 pt-6 pb-3">
        <h1 className="text-[17px] font-semibold tracking-tight text-foreground">Shared with me</h1>
      </div>
      <div className="flex min-h-0 flex-1 flex-col px-8 pb-6">
        <div className="min-h-0 flex-1 overflow-y-auto rounded-2xl border border-border/70 bg-background">
          <div className="sticky top-0 z-10 flex items-center border-b border-border/60 bg-background px-4 py-2.5">
            <span className="min-w-0 flex-1 text-[12px] font-medium text-muted-foreground/70">Record</span>
            <span className="flex-shrink-0 text-[12px] font-medium text-muted-foreground/70" style={{ width: 200 }}>Shared by</span>
            <span className="flex-shrink-0 text-[12px] font-medium text-muted-foreground/70" style={{ width: 110 }}>When</span>
          </div>
          {loading && shares.length === 0 && <div className="py-12 text-center text-[13px] text-muted-foreground/70">Loading…</div>}
          {shares.map(s => (
            <button key={`${s.entity_kind}-${s.entity_id}`} onClick={() => open(s)}
              className="flex w-full items-center border-b border-border/45 px-4 py-3 text-left transition-colors last:border-0 hover:bg-muted/40">
              <div className="flex min-w-0 flex-1 items-center gap-2.5">
                <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground/60">
                  {s.entity_kind === "company" ? <Building2 className="h-3.5 w-3.5" /> : <UserIcon className="h-3.5 w-3.5" />}
                </span>
                <span className="truncate text-[13px] font-medium text-foreground">{s.entity_name || "Untitled"}</span>
              </div>
              <div className="flex flex-shrink-0 items-center gap-2 pr-2" style={{ width: 200 }}>
                {s.sharer?.profile_picture_url
                  ? <img src={s.sharer.profile_picture_url} alt="" className="h-5 w-5 rounded-full object-cover" />
                  : <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground/80">{initial(s.sharer?.name, s.sharer?.email)}</span>}
                <span className="truncate text-[12.5px] text-muted-foreground">{s.sharer?.name || s.sharer?.email || "A teammate"}</span>
              </div>
              <span className="flex-shrink-0 text-[12.5px] text-muted-foreground/60" style={{ width: 110 }}>{relTime(s.created_at)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
