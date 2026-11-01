// Sync done (GET-1087): what landed, then how to read the history. Opens by itself once; Settings
// reopens it. A is the person's own Claude or ChatGPT plan, B is a one-off payment at the exact,
// counted price. The plan line is one quiet line so it never competes with either.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { contactUrl } from "@/config/contact";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { CodeSnippet } from "@/components/connect/shared";
import type { SyncStatus } from "@/hooks/useOnboardingChecklist";
import { SYNC_DAYS, planFitLine, type PlanFit } from "@/lib/getStarted";

const apiUrl = import.meta.env.VITE_API_URL ?? "";
const num = (n: number) => n.toLocaleString("en-US");
type Quote = { conversations: number; credits: number; usd: number; basis?: string };

export function SyncDoneDialog({ open, onClose, sync, token, workspaceId }: {
  open: boolean; onClose: () => void; sync: SyncStatus | null | undefined; token: string; workspaceId: string;
}) {
  const [days, setDays] = useState<number>(90);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoted, setQuoted] = useState(false);
  const [fit, setFit] = useState<PlanFit | null>(null);
  const [busy, setBusy] = useState(false);
  const headers = { Authorization: `Bearer ${token}` };
  const qs = workspaceId ? `workspace_id=${encodeURIComponent(workspaceId)}` : "";

  useEffect(() => {
    if (!open || !token) return;
    let alive = true;
    setQuote(null); setQuoted(false);
    fetch(`${apiUrl}/api/billing/backfill-quote?days=${days}${qs ? `&${qs}` : ""}`, { headers })
      .then((r) => (r.ok ? r.json() : null)).then((d) => { if (alive) { setQuote(d); setQuoted(true); } })
      .catch(() => { if (alive) setQuoted(true); });
    return () => { alive = false; };
  }, [open, days, token]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open || !token) return;
    let alive = true;
    fetch(`${apiUrl}/api/billing/plan-fit${qs ? `?${qs}` : ""}`, { headers })
      .then((r) => (r.ok ? r.json() : null)).then((d) => { if (alive) setFit(d); }).catch(() => {});
    return () => { alive = false; };
  }, [open, token]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = async (path: string, body: object, what: string) => {
    setBusy(true);
    try {
      const r = await fetch(`${apiUrl}${path}`, {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, workspace_id: workspaceId || undefined }),
      });
      const d = await r.json().catch(() => ({}));
      if (d.url) { window.location.href = d.url; return; }
      // Already subscribed: the size changed in place, there is no checkout to open.
      if (d.updated) { toast.success("Plan updated."); onClose(); setBusy(false); return; }
      throw new Error(d.message || d.error || what);
    } catch (e) {
      toast.error((e instanceof Error && e.message) || what);
    }
    setBusy(false);
  };

  const c = sync?.counts;
  const stats: [string, number][] = [["Accounts", c?.accounts ?? 0], ["People", c?.people ?? 0], ["Conversations", c?.conversations ?? 0]];
  const line = planFitLine(fit);
  const option = "rounded-xl border border-hairline bg-card p-3.5";

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-[480px] gap-0 rounded-2xl p-5 sm:p-6">
        <DialogTitle className="text-[18px] font-semibold tracking-[-0.02em]">Sync done</DialogTitle>
        <DialogDescription className="mt-1 text-[13px] text-muted-foreground">Read your history for signals.</DialogDescription>

        <div className="mt-4 grid grid-cols-3 gap-2">
          {stats.map(([label, n]) => (
            <div key={label} className="rounded-lg border border-hairline bg-card px-2.5 py-2">
              <div className="text-[16px] font-semibold tabular-nums">{num(n)}</div>
              <div className="text-[11.5px] text-muted-foreground">{label}</div>
            </div>
          ))}
        </div>

        {line && (
          <p className="mt-2.5 text-[12px] text-muted-foreground">
            {line.lead}{" "}
            {line.credits == null
              ? <a href={contactUrl()} target="_blank" rel="noreferrer" className="underline decoration-border underline-offset-2 hover:text-foreground">{line.rec}</a>
              : <button type="button" disabled={busy} className="underline decoration-border underline-offset-2 hover:text-foreground disabled:opacity-50"
                  onClick={() => void go("/api/billing/subscribe", { plan: "api", credits: line.credits, return_to: "onboarding" }, "Couldn't open checkout.")}>{line.rec}</button>}
          </p>
        )}

        <div className="mt-4 flex flex-col gap-2.5">
          <div className={option}>
            <div className="text-[13px] font-medium">Use your own plan</div>
            <CodeSnippet code="nous backfill" className="mt-2.5" />
          </div>

          <div className={option}>
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1 text-[13px] font-medium">Run it for me</div>
              <div role="radiogroup" aria-label="How far back" className="inline-flex gap-0.5 rounded-lg bg-muted p-0.5">
                {SYNC_DAYS.map((d) => (
                  <button key={d} type="button" role="radio" aria-checked={d === days} onClick={() => setDays(d)}
                    className={cn("h-6 rounded-md px-2 text-[12px] font-medium tabular-nums transition-colors",
                      d === days ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
                    {d}d
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-2.5 flex items-center gap-3">
              <div className="min-w-0 flex-1 text-[12.5px] tabular-nums text-muted-foreground">
                {quote ? `${num(quote.conversations)} conversations · $${num(quote.usd)}` : quoted ? "Price unavailable" : "Counting…"}
              </div>
              <button type="button" disabled={busy || !quote} onClick={() => void go("/api/billing/backfill-checkout", { days }, "Couldn't open checkout.")}
                className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-[9px] bg-foreground px-[13px] text-[12.5px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50">
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Run it for me
              </button>
            </div>
          </div>
        </div>

        <button type="button" onClick={onClose} className="mt-3 self-start text-[12px] text-muted-foreground hover:text-foreground">Not now</button>
      </DialogContent>
    </Dialog>
  );
}
