// The backfill, before it runs: what we found in the connected tools, what reading it costs in
// backfill credits, and the yes (GET-515). Used on the billing page and in onboarding.
//
// Three answers, from /api/backfill/preview:
//   within the allowance      "We found … Reading it uses about X of your Y backfill credits." [Run]
//   over it, 30 days fits     the same sentence, and the smaller offer: [Read the last 30 days]
//   over even that            "Your history is bigger than onboarding reads on its own." [Contact us]
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";
import { CONTACT_URL } from "@/config/contact";
import { notInCrmLine } from "@/lib/getStarted";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

type Estimate = { credits: number; allowance: number | null; basis: string; window_days: number | null; conversations: Record<string, number>; discovered?: { people: number; accounts: number } | null };
type Preview = {
  state: "none" | "awaiting_confirmation" | "over_allowance" | "needs_support" | "running" | "done";
  /** A backfill already ran in this workspace (GET-733). */
  ran_before?: boolean;
  accounts?: number;
  window_days?: number;
  estimate?: Estimate | null;
  estimate_30?: Estimate | null;
};

const num = (n: number) => n.toLocaleString("en-US");

function found(e: Estimate | null | undefined): string {
  if (!e) return "your history";
  const c = e.conversations ?? {};
  const parts = [
    c.meeting ? `${num(c.meeting)} meeting${c.meeting === 1 ? "" : "s"}` : null,
    c.call ? `${num(c.call)} call${c.call === 1 ? "" : "s"}` : null,
    c.email_thread ? `${num(c.email_thread)} email thread${c.email_thread === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "your history";
}

export function BackfillCard({ className, onStarted, hideIfRan = false }: { className?: string; onStarted?: () => void; hideIfRan?: boolean }) {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const workspaceId = userData?.workspace?.id ?? "";
  const [p, setP] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!token || !workspaceId) return;
    fetch(`${apiUrl}/api/backfill/preview?workspaceId=${encodeURIComponent(workspaceId)}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null)).then((d) => setP(d)).catch(() => setP(null));
  }, [token, workspaceId]);
  useEffect(() => { load(); }, [load]);

  const start = async (window?: "last_30_days") => {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`${apiUrl}/api/backfill/confirm`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, ...(window ? { window } : {}) }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.message || "Couldn't start the backfill.");
      load(); onStarted?.();
    } catch (e: any) {
      setError(e?.message || "Couldn't start the backfill.");
    } finally {
      setBusy(false);
    }
  };

  // Running or done: the header pill is the live view, and the credits row below says what it spent.
  if (!p || p.state === "none" || p.state === "done" || p.state === "running") return null;
  if (hideIfRan && p.ran_before) return null;
  const e = p.estimate;
  const allowance = e?.allowance ?? null;

  return (
    <div className={cn("rounded-2xl border border-border bg-card p-6", className)}>
      <div className="text-[12px] text-muted-foreground">Backfill</div>
      {p.state === "running" ? (
        <p className="mt-1.5 text-[14px] text-foreground">Reading {found(e)} from the last {p.window_days === 30 ? "30 days" : "3 months"}. Accounts fill in as it goes.</p>
      ) : p.state === "needs_support" ? (
        <>
          <p className="mt-1.5 text-[14px] text-foreground">
            We found {found(e)} from the last 3 months. That's more than onboarding reads on its own.
          </p>
          <a href={CONTACT_URL} target="_blank" rel="noreferrer" className="mt-4 inline-flex h-9 items-center rounded-lg bg-foreground px-4 text-[13px] font-medium text-background">Contact us</a>
        </>
      ) : (
        <>
          <p className="mt-1.5 text-[14px] text-foreground">
            We found {found(e)} from the last 3 months. Reading it uses about <span className="font-semibold">{num(e?.credits ?? 0)}</span>
            {allowance != null && <> of your <span className="font-semibold">{num(allowance)}</span></>} backfill credits.
          </p>
          {notInCrmLine(e?.discovered) && <p className="mt-1 text-[12.5px] text-muted-foreground">{notInCrmLine(e?.discovered)}</p>}
          <p className="mt-1 text-[12.5px] text-muted-foreground">Backfill credits are included in your plan and don't count against your monthly credits.</p>
          {p.state === "over_allowance" ? (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button disabled={busy} onClick={() => start("last_30_days")}
                className="inline-flex h-9 items-center rounded-lg bg-foreground px-4 text-[13px] font-medium text-background disabled:opacity-60">
                Read the last 30 days{p.estimate_30 ? ` · ${num(p.estimate_30.credits)} credits` : ""}
              </button>
              <a href={CONTACT_URL} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center rounded-lg border border-border px-4 text-[13px] text-foreground">Contact us for all 3 months</a>
            </div>
          ) : (
            <button disabled={busy} onClick={() => start()}
              className="mt-4 inline-flex h-9 items-center rounded-lg bg-foreground px-4 text-[13px] font-medium text-background disabled:opacity-60">
              Run backfill
            </button>
          )}
        </>
      )}
      {error && <p className="mt-2 text-[12px] text-red-600">{error}</p>}
    </div>
  );
}
