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
import { useState } from "react";
import { Linkedin, UserPlus, Loader2, Check, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type PendingAction = {
  id: string;
  kind: "linkedin_message" | "linkedin_invite";
  recipient: string | null;
  linkedin_url: string | null;
  body: string;
  rationale: string | null;
  status: "pending" | "sent" | "rejected" | "failed";
  error?: string | null;
};

export function ApprovalCard({
  action, token, apiUrl, onDecided,
}: {
  action: PendingAction;
  token: string;
  apiUrl: string;
  onDecided: () => void;
}) {
  const [body, setBody] = useState(action.body);
  const [busy, setBusy] = useState<"send" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(action.error ?? null);

  const isInvite = action.kind === "linkedin_invite";
  const Icon = isInvite ? UserPlus : Linkedin;
  const edited = body.trim() !== action.body.trim();

  const decide = async (what: "send" | "reject") => {
    setBusy(what);
    setError(null);
    try {
      const res = await fetch(`${apiUrl}/api/actions/${action.id}/${what === "send" ? "approve" : "reject"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: what === "send" ? JSON.stringify({ body }) : undefined,
      });
      if (!res.ok && res.status !== 204) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.detail ?? d.error ?? `Failed (${res.status})`);
      }
      onDecided();
    } catch (e) {
      // It did not send. Say so and leave the card exactly as it was, because the
      // one unacceptable outcome is someone believing a message went out when it
      // did not — and following up twice, or never.
      setError(e instanceof Error ? e.message : "Something went wrong");
    }
    setBusy(null);
  };

  // Already decided: a quiet line, not a card. It's history now.
  if (action.status === "sent") {
    return (
      <p className="mt-3 flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <Check className="h-3.5 w-3.5 text-emerald-600" />
        {isInvite ? "Connection request sent" : "Message sent"} to {action.recipient}
      </p>
    );
  }
  if (action.status === "rejected") {
    return (
      <p className="mt-3 text-[12px] text-muted-foreground/60">
        Draft discarded.
      </p>
    );
  }

  return (
    <div className="mt-4 rounded-xl border border-border overflow-hidden">
      <div className="flex items-center gap-2 px-3.5 py-2 bg-muted/50 border-b border-border">
        <Icon className="h-3.5 w-3.5 text-[#0A66C2]" />
        <span className="text-[12px] font-medium text-foreground">
          {isInvite ? "Connection request" : "LinkedIn message"} to {action.recipient ?? "them"}
        </span>
        <span className="ml-auto text-[11px] text-muted-foreground/60">
          {isInvite ? "300 characters max" : "Not sent yet"}
        </span>
      </div>

      {/* Why. Read this first, judge the message against it. */}
      {action.rationale && (
        <p className="px-3.5 pt-2.5 text-[12px] text-muted-foreground/70 leading-relaxed">
          {action.rationale}
        </p>
      )}

      <textarea
        value={body}
        onChange={e => setBody(e.target.value)}
        rows={Math.min(10, Math.max(3, body.split("\n").length + 1))}
        className="w-full resize-none bg-transparent px-3.5 py-2.5 text-[13px] leading-relaxed text-foreground focus:outline-none"
      />

      {error && (
        <p className="px-3.5 pb-2 text-[12px] text-red-600">{error}</p>
      )}

      <div className="flex items-center gap-2 px-3.5 py-2.5 border-t border-border/60">
        <button
          onClick={() => decide("send")}
          disabled={!!busy || !body.trim()}
          className={cn(
            "inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12.5px] font-medium transition-opacity",
            "bg-foreground text-background disabled:opacity-40",
          )}
        >
          {busy === "send" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          Send{isInvite ? " request" : ""}
        </button>
        <button
          onClick={() => decide("reject")}
          disabled={!!busy}
          className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-[12.5px] text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="h-3.5 w-3.5" /> Discard
        </button>
        {edited && (
          <span className="ml-auto text-[11px] text-muted-foreground/50">Edited — your version is what sends</span>
        )}
      </div>
    </div>
  );
}
