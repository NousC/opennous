// From: which mailbox a draft goes out from, on every draft card (GET-745). Your own connected
// Gmail accounts; the first is the default. One mailbox reads as plain text, more as a dropdown.
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

export type Mailbox = { id: string; kind: "gmail"; email: string | null };

/** The mailboxes you can send from, shared across every card on the page. */
export function useMailboxes() {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const ws = userData?.workspace?.id ?? "";
  return useQuery({
    queryKey: ["send-mailboxes", ws],
    enabled: !!token && !!ws,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<{ mailboxes: Mailbox[]; default_id: string | null }> => {
      const r = await fetch(`${apiUrl}/api/actions/mailboxes?workspaceId=${encodeURIComponent(ws)}`, { headers: { Authorization: `Bearer ${token}` } });
      return r.ok ? r.json() : { mailboxes: [], default_id: null };
    },
  });
}

/**
 * The From row. `value` is a mailbox id; `prefer` is an address to start on when the draft already
 * says where it is (an automation's draft in a given Gmail). Picks the default once the list loads.
 */
export function MailboxPicker({ value, onChange, prefer = null, disabled = false, className }: {
  value: string | null; onChange: (id: string | null) => void; prefer?: string | null; disabled?: boolean; className?: string;
}) {
  const { data } = useMailboxes();
  const list = data?.mailboxes ?? [];
  useEffect(() => {
    if (value || !list.length) return;
    const match = prefer ? list.find((m) => (m.email ?? "").toLowerCase() === prefer.toLowerCase()) : null;
    onChange(match?.id ?? data?.default_id ?? list[0].id);
  }, [value, list, prefer, data?.default_id, onChange]);
  const current = list.find((m) => m.id === value) ?? null;
  return (
    <div className={cn("flex items-center gap-2.5 text-[12.5px]", className)}>
      <span className="w-[52px] shrink-0 text-[11.5px] text-muted-foreground/70">From</span>
      {!data ? (
        <span className="text-muted-foreground/60">…</span>
      ) : !list.length ? (
        <span className="text-muted-foreground">{prefer ?? "No Gmail connected"}</span>
      ) : list.length === 1 || disabled ? (
        <span className="truncate text-foreground">{current?.email ?? prefer ?? list[0].email}</span>
      ) : (
        <span className="relative inline-flex min-w-0 items-center">
          <select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} aria-label="Send from"
            className="min-w-0 cursor-pointer appearance-none truncate rounded-md bg-transparent py-0.5 pl-0 pr-5 text-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-border">
            {list.map((m) => <option key={m.id} value={m.id}>{m.email ?? "Gmail"}</option>)}
          </select>
          <ChevronDown className="pointer-events-none absolute right-0 h-3 w-3 text-muted-foreground" />
        </span>
      )}
    </div>
  );
}
