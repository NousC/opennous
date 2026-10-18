// The approval card — the only door between the agent and someone's inbox.
//
// The agent cannot send. It writes a draft; this is where a person reads it,
// edits it, and decides. Two design rules follow from that:
//
//   The message is EDITABLE in place. You should be able to fix one word without
//   going back to the agent, and what gets sent must be what you actually read —
//   not what the model wrote a minute ago.
//
//   The reason is shown next to the message. An approval you can't interrogate is
//   a rubber stamp, and a rubber stamp is not consent.
import { useRef, useState } from "react";
import { Loader2, Check } from "lucide-react";
import { ListTile } from "@/components/ui/list";
import { toolLogo } from "@/lib/toolLogo";
import { MailboxPicker } from "@/components/MailboxPicker";
import { cn } from "@/lib/utils";

export type PendingAction = {
  id: string;
  kind: "linkedin_message" | "linkedin_invite" | "email";
  recipient: string | null;
  linkedin_url: string | null;
  // Email-only: the subject line and the recipient address, both editable before send.
  subject?: string | null;
  recipient_email?: string | null;
  body: string;
  rationale: string | null;
  status: "pending" | "sent" | "rejected" | "failed";
  error?: string | null;
  /** The assistant message that proposed this draft. Every chat draft has one — the turn
   *  claims its own, and the existing rows were backfilled. Null means it came from
   *  somewhere with no thread at all (a routine), or a turn that died before writing its
   *  message. See the fallback in Home.tsx for why that case is handled by TIME. */
  message_id?: string | null;
  created_at?: string | null;
};

export function ApprovalCard({
  action, token, apiUrl, onDecided, labels, className, rejectReason,
}: {
  action: PendingAction;
  token: string;
  apiUrl: string;
  // Reports WHAT happened, so a caller can complete the underlying task on a send
  // but not on a discard. Optional param keeps existing callers working.
  onDecided: (outcome?: "sent" | "rejected") => void;
  /** The buttons' and the discarded line's words, where a surface names them its own way (the
   *  Priorities inbox: "Approve & send", "Skip"). Defaults are chat's. */
  labels?: { send?: string; discard?: string; discarded?: string };
  /** Why a discard happened, recorded with the rejection (e.g. "not_relevant", GET-944). */
  rejectReason?: string;
  /** Replaces the card's top margin (chat spaces it under the message). */
  className?: string;
}) {
  const [body, setBody] = useState(action.body);
  const [subject, setSubject] = useState(action.subject ?? "");
  const [to, setTo] = useState(action.recipient_email ?? "");
  const [from, setFrom] = useState<string | null>(null);
  const [busy, setBusy] = useState<"send" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(action.error ?? null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  const isEmail = action.kind === "email";
  const isInvite = action.kind === "linkedin_invite";
  const edited = body.trim() !== action.body.trim()
    || (isEmail && (subject.trim() !== (action.subject ?? "").trim() || to.trim() !== (action.recipient_email ?? "").trim()));

  const decide = async (what: "send" | "reject") => {
    setBusy(what);
    setError(null);
    try {
      const res = await fetch(`${apiUrl}/api/actions/${action.id}/${what === "send" ? "approve" : "reject"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: what === "send"
          ? JSON.stringify(isEmail ? { body, subject, to, ...(from ? { from } : {}) } : { body })
          : rejectReason ? JSON.stringify({ reason: rejectReason }) : undefined,
      });
      if (!res.ok && res.status !== 204) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.detail ?? d.error ?? `Failed (${res.status})`);
      }
      onDecided(what === "send" ? "sent" : "rejected");
    } catch (e) {
      // It did not send. Say so and leave the card exactly as it was, because the
      // one unacceptable outcome is someone believing a message went out when it
      // did not — and following up twice, or never.
      setError(`Nothing was sent. ${e instanceof Error ? e.message : "Something went wrong."}`);
    }
    setBusy(null);
  };

  // Already decided: a quiet line, not a card. It's history now.
  if (action.status === "sent") {
    const what = isEmail ? "Email sent" : isInvite ? "Connection request sent" : "Message sent";
    return (
      <p className="mt-3 flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <Check className="h-3.5 w-3.5 text-positive" />
        {what} to {isEmail ? (action.recipient_email || action.recipient) : action.recipient}
      </p>
    );
  }
  if (action.status === "rejected") {
    return (
      <p className="mt-3 text-[12px] text-muted-foreground/60">
        {labels?.discarded ?? "Draft discarded."}
      </p>
    );
  }

  const heading = isEmail ? "Draft email" : isInvite ? "Connection request" : "LinkedIn message";
  // We do not know the exact mailbox here, only the channel the approve route sends through:
  // the operator's own connected Gmail, or their LinkedIn.
  const sendsFrom = isEmail ? "Sends when you approve" : "Sends from your LinkedIn";

  return (
    <div className={cn("overflow-hidden rounded-2xl border border-border/70 bg-card", className ?? "mt-4")}>
      {/* Header — what this is, and that nothing has gone out yet. Leads with the tool it sends
          through (Gmail, LinkedIn) in the palette's 24px tile (GET-658, round 2). */}
      <div className="flex items-center gap-2.5 px-3.5 py-2.5">
        <ListTile>
          <img src={toolLogo(isEmail ? "gmail" : "linkedin") ?? ""} alt="" className="h-3.5 w-3.5 object-contain" />
        </ListTile>
        <span className="text-[13.5px] font-medium tracking-[-0.01em] text-foreground">{heading}</span>
        <span className="text-[11.5px] text-muted-foreground/60">
          {isInvite ? "300 characters max" : "Not sent yet"}
        </span>
        <button
          type="button"
          onClick={() => bodyRef.current?.focus()}
          className="ml-auto inline-flex h-[26px] items-center rounded-md px-2 text-[12px] text-ink-2 transition-colors duration-fast hover:bg-hover hover:text-foreground"
        >
          Edit
        </button>
      </div>

      {isEmail ? (
        <>
          {/* From (GET-745), then To and Subject, both editable in place. */}
          <MailboxPicker value={from} onChange={setFrom} className="border-t border-hairline px-3.5 py-2" />
          <label className="flex items-center gap-2.5 border-t border-hairline px-3.5 py-2 text-[12.5px]">
            <span className="w-[52px] shrink-0 text-[11.5px] text-muted-foreground/70">To</span>
            {action.recipient && action.recipient !== to && (
              <span className="shrink-0 text-foreground">{action.recipient}</span>
            )}
            <input
              value={to}
              onChange={e => setTo(e.target.value)}
              placeholder="name@company.com"
              className={cn(
                "min-w-0 flex-1 bg-transparent focus:outline-none",
                action.recipient && action.recipient !== to ? "text-muted-foreground" : "text-foreground",
              )}
            />
          </label>
          <label className="flex items-center gap-2.5 border-t border-hairline px-3.5 py-2 text-[12.5px]">
            <span className="w-[52px] shrink-0 text-[11.5px] text-muted-foreground/70">Subject</span>
            <input
              value={subject}
              onChange={e => setSubject(e.target.value)}
              placeholder="Subject"
              className="min-w-0 flex-1 bg-transparent text-foreground focus:outline-none"
            />
          </label>
          <textarea
            ref={bodyRef}
            value={body}
            onChange={e => setBody(e.target.value)}
            rows={Math.min(18, Math.max(5, body.split("\n").length + 2))}
            className="block w-full resize-none border-t border-hairline bg-transparent px-3.5 pb-3.5 pt-3 text-[13px] leading-[1.6] text-foreground focus:outline-none"
          />
        </>
      ) : (
        <>
          {action.recipient && (
            <div className="flex items-center gap-2.5 border-t border-hairline px-3.5 py-2 text-[12.5px]">
              <span className="w-[52px] shrink-0 text-[11.5px] text-muted-foreground/70">To</span>
              <span className="truncate text-foreground">{action.recipient}</span>
            </div>
          )}
          <textarea
            ref={bodyRef}
            value={body}
            onChange={e => setBody(e.target.value)}
            rows={Math.min(10, Math.max(3, body.split("\n").length + 1))}
            className="block w-full resize-none border-t border-hairline bg-transparent px-3.5 pb-3.5 pt-3 text-[13px] leading-[1.6] text-foreground focus:outline-none"
          />
        </>
      )}

      {error && (
        <p className="px-3.5 pb-2 text-[12px] text-risk">{error}</p>
      )}

      <div className="flex items-center gap-1.5 border-t border-hairline px-3.5 py-2.5">
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground/60">
          {sendsFrom}{edited ? " · edited, your version is what sends" : ""}
        </span>
        <button
          type="button"
          onClick={() => decide("reject")}
          disabled={!!busy}
          className="inline-flex h-[26px] items-center rounded-md px-2.5 text-[12px] text-ink-2 transition-colors duration-fast hover:bg-hover hover:text-foreground disabled:opacity-50"
        >
          {labels?.discard ?? "Discard"}
        </button>
        <button
          type="button"
          onClick={() => decide("send")}
          disabled={!!busy || !body.trim() || (isEmail && !to.includes("@"))}
          className="inline-flex h-[26px] items-center gap-1.5 rounded-[7px] bg-primary px-2.5 text-[12px] font-medium text-primary-foreground shadow-[0_1px_2px_rgba(20,20,18,0.18)] transition-colors duration-fast hover:bg-primary/90 disabled:opacity-40"
        >
          {busy === "send" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {labels?.send ?? `Send${isInvite ? " request" : ""}`}
        </button>
      </div>
    </div>
  );
}
