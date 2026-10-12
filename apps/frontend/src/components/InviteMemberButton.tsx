// Invite teammates, from the sidebar foot (GET-571; redesigned in GET-600, interface refresh).
// A member joins the workspace's records — the CRM is already in — and onboards their own email
// and meeting notes; their backfill draws on the workspace's backfill credits. Founders and admins
// only: the server refuses everyone else anyway.
//
// Several addresses at once (type, paste a list, Enter or comma to add), Member or Admin, then one
// send. Each address is its own POST, so one bad address never sinks the rest; the result lists
// who was invited and who wasn't, with the invite link when no email went out.
import { useRef, useState } from "react";
import { Check, Copy, UserPlus, X } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { RAIL_STROKE, railIcon, railIdle, railLabel, railRow } from "@/components/shell/rail";

const apiUrl = import.meta.env.VITE_API_URL ?? "";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
type Role = "member" | "admin";
type Result = { email: string; ok: boolean; link: string | null; error?: string };

/** The team this session is acting in — the same read Settings and ShareBar do. */
function activeTeamId(userData: unknown): string | null {
  const u = userData as { teams?: { id?: string }[]; team?: { id?: string } } | null;
  return u?.team?.id ?? u?.teams?.[0]?.id ?? null;
}

const ROLES: { value: Role; label: string; body: string }[] = [
  { value: "member", label: "Member", body: "Works accounts, deals and tasks" },
  { value: "admin", label: "Admin", body: "Also manages members, billing and integrations" },
];

export function InviteMemberButton({ collapsed = false, className = "" }: { collapsed?: boolean; className?: string }) {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const teamId = activeTeamId(userData);
  const u = userData as { is_founder?: boolean; workspace_role?: string } | null;
  const isAdmin = !!u?.is_founder || ["founder", "owner", "admin"].includes(String(u?.workspace_role ?? "").toLowerCase());

  const [open, setOpen] = useState(false);
  const [emails, setEmails] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  if (!isAdmin || !teamId) return null;

  const reset = () => { setEmails([]); setDraft(""); setRole("member"); setResults(null); };
  /** Add whatever is typed or pasted: split on commas, semicolons, spaces and new lines. */
  const commit = (text: string) => {
    const parts = text.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (parts.length) setEmails((prev) => [...prev, ...parts.filter((p) => !prev.includes(p))]);
    setDraft("");
  };
  const valid = emails.filter((e) => EMAIL.test(e));
  const invalid = emails.filter((e) => !EMAIL.test(e));

  const send = async () => {
    const pending = draft.trim() ? [...emails, ...draft.split(/[\s,;]+/).filter(Boolean)] : emails;
    const list = [...new Set(pending.map((e) => e.toLowerCase()))].filter((e) => EMAIL.test(e));
    if (!list.length || sending) return;
    setSending(true);
    const out = await Promise.all(list.map(async (email): Promise<Result> => {
      try {
        const res = await fetch(`${apiUrl}/api/teams/${teamId}/invitations`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ email, role }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) return { email, ok: false, link: null, error: body.message ?? body.error ?? "Could not send that." };
        return { email, ok: true, link: body.emailSent ? null : body.inviteLink ?? null };
      } catch {
        return { email, ok: false, link: null, error: "Could not reach the server." };
      }
    }));
    setSending(false);
    setResults(out);
    const sent = out.filter((r) => r.ok);
    if (sent.length) toast(sent.length === 1 ? `Invited ${sent[0].email}` : `${sent.length} invites sent`);
  };

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(text); toast("Invite link copied"); setTimeout(() => setCopied(null), 1500); } catch { /* ignore */ }
  };

  const n = valid.length + (draft.trim() && EMAIL.test(draft.trim()) ? 1 : 0);

  return (
    <>
      <button onClick={() => setOpen(true)} aria-label="Invite teammates"
        className={cn(
          railRow, railIdle, "text-[13px]", railLabel,
          collapsed ? "justify-center px-0 py-[7px]" : "gap-2.5 px-2 py-[6px]",
          className,
        )}>
        <UserPlus className={cn("h-[15px] w-[15px] flex-shrink-0", railIcon)} strokeWidth={RAIL_STROKE} />
        {!collapsed && <span>Invite teammates</span>}
      </button>
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
        <DialogContent className="max-w-[520px] gap-0 overflow-hidden p-0 outline-none">
          {/* The ⌘K palette's dialog language (GET-658, round 2): a quiet title, small light labels,
              the role as two palette rows rather than two bordered cards. */}
          <div className="flex items-center px-5 pb-1 pt-4">
            <DialogTitle className="text-[13.5px] font-medium tracking-[-0.01em]">Invite teammates</DialogTitle>
          </div>

          {results ? (
            <div className="flex flex-col px-3 py-3">
              {results.map((r) => (
                <div key={r.email} className="flex min-h-10 items-center gap-2.5 rounded-lg px-2 text-[13px]">
                  <span className={cn("flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full text-white", r.ok ? "bg-positive" : "bg-risk")}>
                    {r.ok ? <Check className="h-2.5 w-2.5" strokeWidth={3.5} /> : <X className="h-2.5 w-2.5" strokeWidth={3.5} />}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{r.email}</span>
                  {r.ok && r.link && (
                    <Button variant="outline" size="sm" onClick={() => void copy(r.link!)}>
                      {copied === r.link ? <Check /> : <Copy />} Copy invite link
                    </Button>
                  )}
                  {r.ok && !r.link && <span className="text-[12px] text-muted-foreground/70">Email sent</span>}
                  {!r.ok && <span className="text-[12px] text-risk">{r.error}</span>}
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-4 px-5 pb-5 pt-3">
              <div>
                <label htmlFor="invite-emails" className="mb-1.5 block text-[11px] font-medium text-muted-foreground/60">Email addresses</label>
                <div
                  onClick={() => input.current?.focus()}
                  className="flex min-h-[84px] cursor-text flex-wrap content-start gap-1.5 rounded-lg border border-border/70 bg-card p-2 transition-colors duration-fast focus-within:border-foreground/25"
                >
                  {emails.map((e) => (
                    <span key={e} className={cn("inline-flex h-6 items-center gap-1.5 rounded-[7px] px-2 text-[12.5px]", EMAIL.test(e) ? "bg-muted" : "bg-risk/10 text-risk")}>
                      {e}
                      <button type="button" aria-label={`Remove ${e}`} onClick={(ev) => { ev.stopPropagation(); setEmails((p) => p.filter((x) => x !== e)); }}
                        className="text-muted-foreground hover:text-foreground">
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                  <input
                    id="invite-emails"
                    ref={input}
                    autoFocus
                    value={draft}
                    onChange={(e) => (/[\s,;]$/.test(e.target.value) ? commit(e.target.value) : setDraft(e.target.value))}
                    onPaste={(e) => { e.preventDefault(); commit(draft + " " + e.clipboardData.getData("text")); }}
                    onBlur={() => { if (draft.trim()) commit(draft); }}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void send(); return; }
                      if (e.key === "Enter" && draft.trim()) { e.preventDefault(); commit(draft); }
                      if (e.key === "Backspace" && !draft && emails.length) setEmails((p) => p.slice(0, -1));
                    }}
                    placeholder={emails.length ? "Add more" : "name@company.com, separated by commas"}
                    className="h-6 min-w-[180px] flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/45"
                  />
                </div>
                {invalid.length > 0 && (
                  <p className="mt-1.5 text-[12px] text-risk">
                    {invalid.length === 1 ? `${invalid[0]} isn't an email address.` : `${invalid.length} entries aren't email addresses.`}
                  </p>
                )}
              </div>

              <div role="radiogroup" aria-label="Role">
                <span className="mb-1 block text-[11px] font-medium text-muted-foreground/60">Role</span>
                <div className="-mx-2 flex flex-col">
                  {ROLES.map((r) => {
                    const on = role === r.value;
                    return (
                      <button key={r.value} type="button" role="radio" aria-checked={on} onClick={() => setRole(r.value)}
                        className={cn("flex min-h-10 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-fast",
                          on ? "bg-muted" : "hover:bg-muted/50")}>
                        <span className={cn("h-[14px] w-[14px] flex-shrink-0 rounded-full", on ? "border-[4.5px] border-foreground" : "border-[1.5px] border-input")} />
                        <span className="flex min-w-0 flex-1 items-baseline gap-2">
                          <span className="text-[13px] text-foreground">{r.label}</span>
                          <span className="truncate text-[11.5px] text-muted-foreground/70">{r.body}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-border/50 px-5 py-3">
            {results ? (
              <>
                <Button variant="ghost" onClick={() => setOpen(false)}>Done</Button>
                <Button variant="outline" onClick={reset}>Invite more</Button>
              </>
            ) : (
              <>
                <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button onClick={() => void send()} disabled={!n || sending}>
                  {sending ? "Sending…" : n > 1 ? `Send ${n} invites` : "Send invite"}
                  <span className="ml-0.5 font-mono text-[10px] text-primary-foreground/60">⌘↵</span>
                </Button>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
