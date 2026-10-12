// Share and Invite, on anything you can send somebody (GET-426).
//
// Two different acts wearing one control before this: Share was a dark pill that did
// nothing and Invite was a button on Home that navigated to Settings. They are the two ways
// a thing leaves your hands — give this page to someone who already has an account, or give
// someone an account — so they sit together and each does its own job in place.
//
// The invite uses the SAME endpoint the members page uses. A second invite path is a second
// set of rules about roles and seats, and those two drift.
import { useEffect, useState } from "react";
import { Check, Link2, Loader2, Lock, UserPlus } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

/** The team this session is acting in — the same read Settings does. */
function activeTeamId(userData: unknown): string | null {
  const u = userData as { teams?: { id?: string }[]; team?: { id?: string } } | null;
  return u?.team?.id ?? u?.teams?.[0]?.id ?? null;
}

/**
 * Invite somebody, on its own.
 *
 * Home has no page to share — you are looking at a feed, and "copy link" there means the
 * address of the list, which nobody sends anyone. So Home gets this and a report gets the
 * pair: the control follows what there actually is to hand over.
 */
export function InviteButton({ className = "" }: { className?: string }) {
  return <ShareBar className={className} showCopy={false} />;
}

export function ShareBar({ className = "", showCopy = true }: { className?: string; showCopy?: boolean }) {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const teamId = activeTeamId(userData);

  const [copied, setCopied] = useState(false);
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  const copyLink = async () => {
    try { await navigator.clipboard.writeText(window.location.href); setCopied(true); }
    catch { /* a clipboard the browser refuses is not worth an error state */ }
  };

  const invite = async () => {
    const e = email.trim();
    if (!e || !teamId) return;
    setSending(true); setError(null);
    try {
      const res = await fetch(`${apiUrl}/api/teams/${teamId}/invitations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ email: e, role: "member" }),
      });
      const body = await res.json().catch(() => ({}));
      // The server's refusal is the message — it knows about seats, duplicates and roles.
      if (!res.ok) setError(body.message ?? body.error ?? "Could not send that.");
      else { setSent(e); setEmail(""); }
    } finally { setSending(false); }
  };

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Popover onOpenChange={o => { if (!o) { setSent(null); setError(null); } }}>
        <PopoverTrigger asChild>
          {/* Dark on a report, because there it is the one control that sends the page
              somewhere else. Quiet on Home, where nothing is being handed over yet. */}
          <button className={cn(
            "flex h-[30px] items-center gap-1.5 rounded-full px-3.5 text-[13px] transition-colors",
            showCopy
              ? "bg-foreground text-white font-medium hover:opacity-90 dark:bg-white dark:text-background"
              : "border border-border bg-background text-foreground shadow-sm hover:bg-accent",
          )}>
            {showCopy ? <Lock className="h-[13px] w-[13px]" strokeWidth={2.2} /> : <UserPlus className="h-[13px] w-[13px]" strokeWidth={1.75} />}
            {showCopy ? "Share" : "Invite"}
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[300px] p-3">
          <p className="text-[12.5px] text-muted-foreground">
            Anyone in this workspace can open it. To give somebody access, invite them.
          </p>
          <div className="mt-2.5 flex items-center gap-1.5">
            <input
              value={email}
              onChange={e => setEmail(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") void invite(); }}
              placeholder="name@company.com"
              className="h-[30px] min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 text-[13px] text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <button
              onClick={() => void invite()}
              disabled={sending || !email.trim()}
              className="flex h-[30px] flex-shrink-0 items-center gap-1.5 rounded-md bg-foreground px-3 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40 dark:bg-white dark:text-background"
            >
              {sending ? <Loader2 className="h-3 w-3 animate-spin" /> : <UserPlus className="h-[13px] w-[13px]" strokeWidth={2} />}
              Invite
            </button>
          </div>
          {sent && <p className="mt-2 text-[12px] text-muted-foreground">Invited {sent}.</p>}
          {error && <p className="mt-2 text-[12px] text-foreground">{error}</p>}
        </PopoverContent>
      </Popover>

      {showCopy && (
      <button
        onClick={copyLink}
        title={copied ? "Link copied" : "Copy link"}
        aria-label={copied ? "Link copied" : "Copy link"}
        className={cn(
          "flex h-[30px] w-[34px] items-center justify-center rounded-[10px] bg-foreground text-white transition-opacity hover:opacity-90 dark:bg-white dark:text-background",
          copied && "text-emerald-300 dark:text-emerald-600",
        )}
      >
        {copied ? <Check className="h-[15px] w-[15px]" strokeWidth={2.5} /> : <Link2 className="h-[15px] w-[15px]" strokeWidth={2} />}
      </button>
      )}
    </div>
  );
}
