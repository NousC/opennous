import { useState, useEffect, useCallback } from "react";
import { useApiTopBar } from "@/components/shell/apiTopBarContext";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { ApiUsage } from "@/components/usage/ApiUsage";
import type { CreditDay } from "@/components/charts";
import type { BillingActions, BillingState } from "@/lib/billing";
import { cloud } from "@/lib/cloud";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

// Self-host has no bill: nothing to check out, no portal, no invoices (GET-754). Cloud's
// billing comes from the Workspace layer.
const noBilling = (): BillingActions => ({ invoices: [], action: null, subscribe: async () => {}, openPortal: async () => {} });
const useBilling = cloud.usage?.useBilling ?? noBilling;

/**
 * Billing, in one view.
 *
 * Two questions, one screen: how many credits are left, and what am I paying for. A credit
 * is one conversation read, so the balance IS the bill — there is no second meter to
 * reconcile it against, and nothing here should need scrolling to find.
 *
 * Invoices, cards and cancellation live in the Stripe portal. Re-drawing them here means
 * maintaining a worse copy of a page Stripe already keeps correct.
 */
export default function UsageBilling({ embedded = false }: { embedded?: boolean } = {}) {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const workspaceId = userData?.workspace?.id ?? "";

  const [state, setState] = useState<BillingState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creditDaily, setCreditDaily] = useState<CreditDay[] | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${apiUrl}/api/billing/state${workspaceId ? `?workspace_id=${encodeURIComponent(workspaceId)}` : ""}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "load_failed");
      setState(await r.json());
    } catch (e: any) {
      setError(e?.message || "Failed to load billing");
    } finally {
      setLoading(false);
    }
  }, [token, workspaceId]);

  useEffect(() => { load(); }, [load]);
  // The API plan's shared top bar carries the title and the refresh (GET-621).
  useApiTopBar({ onRefresh: load, refreshing: loading, enabled: !embedded });

  // Credits per day, counted the way billing counts them — one per conversation read — so the
  // bars add up to the number above them.
  // Over the billing period, counted like the meter (GET-733), so the bars add up to "324 of 960".
  const periodStart = state?.aiCredits?.periodStart ?? null;
  useEffect(() => {
    if (!token || !workspaceId || !state) return;
    let alive = true;
    const window = periodStart ? `since=${encodeURIComponent(periodStart)}` : "days=30";
    fetch(`${apiUrl}/api/usage/conversations?workspaceId=${encodeURIComponent(workspaceId)}&${window}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d) setCreditDaily(d.daily ?? []); })
      .catch(() => { /* the chart just doesn't render */ });
    return () => { alive = false; };
  }, [token, workspaceId, periodStart, !!state]);

  // Checkout, the Stripe portal and the invoices are the Workspace layer's (GET-754).
  const billing = useBilling({ token, workspaceId, reload: load });

  // A section of Settings (its old address /usage forwards there), and its own page on self-host.
  //
  // The two cards are the page and they fit without scrolling — that was the point. The
  // container still scrolls rather than clipping, because the invoice list sits under them
  // and a short window must not be able to hide a customer's bill.
  // Full width, like every page (GET-660); the top bar names it on every plan.
  const Shell = ({ children }: { children: React.ReactNode }) =>
    embedded ? <>{children}</> : (
      <div className="h-full overflow-y-auto bg-background">
        <div className="p-4 sm:p-5">{children}</div>
      </div>
    );

  if (loading) {
    return (
      <Shell>
        <div className="flex items-center gap-2 py-12 text-[13px] text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      </Shell>
    );
  }

  if (error || !state) {
    return (
      <Shell>
        <div className="rounded-xl border border-red-200 bg-red-50/60 p-5 text-[13px] text-red-800 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
          {error || "Failed to load billing."}
          <button onClick={load} className="ml-3 underline">Retry</button>
        </div>
      </Shell>
    );
  }

  if (state.billing_disabled) {
    return (
      <Shell>
        <div className="max-w-xl space-y-3 rounded-2xl border border-border bg-card p-6">
          <div className="text-[14px] text-foreground">
            {state.self_hosted
              ? "You're running Nous yourself. Nothing here is metered and there is no bill."
              : "Billing isn't configured on this deployment."}
          </div>
          <p className="text-[12.5px] leading-[1.6] text-muted-foreground">
            {state.self_hosted
              ? "Extraction runs on your own key, so you pay for your own model usage and there is no cap to hit."
              : "Nothing is metered and no plan is enforced."}
          </p>
        </div>
      </Shell>
    );
  }

  // The page (GET-633, board Usage): plan, meters, daily bars, per-key calls and invoices. On every
  // plan since GET-660 — Custom reads its quote into the same layout. Embedded in Settings it is the
  // same view in Settings' own column, without a scroller of its own.
  return (
    <div className={embedded ? "min-w-0" : "h-full min-w-0 overflow-y-auto bg-background"}>
      <ApiUsage
        state={state}
        invoices={billing.invoices}
        creditDaily={creditDaily}
        token={token}
        workspaceId={workspaceId}
        action={billing.action}
        onPortal={billing.openPortal}
        onSubscribe={(credits) => billing.subscribe("api", { credits })}
        onBackfillStarted={load}
      />
    </div>
  );
}
