// The backfill, top right next to Get started (GET-549): a thin bar and a percentage while it
// reads, "History in" for a day after. Click it for the detail — the bar, what has been read, and
// the backfill credits spent against the plan's allowance.
import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Bar, useBackfillPreview } from "@/pages/GetStarted";

const apiUrl = import.meta.env.VITE_API_URL ?? "";
const num = (n: number) => n.toLocaleString("en-US");

export function BackfillProgressButton() {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const workspaceId = userData?.workspace?.id ?? "";
  const { p } = useBackfillPreview(15_000);
  const [open, setOpen] = useState(false);
  const [credits, setCredits] = useState<{ used: number; allowance: number | null } | null>(null);

  // The credits come from the billing state, which already counts the backfill apart (GET-515).
  useEffect(() => {
    if (!open || !token) return;
    fetch(`${apiUrl}/api/billing/state${workspaceId ? `?workspace_id=${encodeURIComponent(workspaceId)}` : ""}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null)).then((d) => setCredits(d?.aiCredits?.backfill ?? null)).catch(() => {});
  }, [open, token, workspaceId, p?.progress?.read]);

  if (!p || (p.state !== "running" && p.state !== "done")) return null;
  // "History in" is a moment, not a fixture: gone 30 minutes after this person's backfill finished (GET-571).
  if (p.state === "done" && (!p.finished_at || Date.now() - Date.parse(p.finished_at) > 30 * 60_000)) return null;
  const pct = p.state === "done" ? 100 : p.progress?.pct ?? 0;

  return (
    <>
      <button onClick={() => setOpen(true)}
        className="inline-flex h-8 items-center gap-2 rounded-full border border-border bg-background px-3.5 text-[12.5px] text-foreground shadow-sm transition-colors hover:bg-muted/40">
        {p.state === "done" ? (
          <><Check className="h-3.5 w-3.5 text-emerald-600" /> History in</>
        ) : (
          <>
            Backfill
            <span className="block h-1 w-14 overflow-hidden rounded-full bg-muted">
              <span className="block h-full rounded-full bg-foreground/80 transition-all duration-700" style={{ width: `${Math.max(4, pct)}%` }} />
            </span>
            <span className="tabular-nums text-muted-foreground">{pct}%</span>
          </>
        )}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[380px] gap-0 p-5">
          <DialogTitle className="text-[15px] font-semibold tracking-tight">Backfill</DialogTitle>
          <div className="mt-4 mb-2 flex items-baseline justify-between text-[13px]">
            <span className="text-muted-foreground">
              {p.state === "done" ? "Done" : p.progress?.phase === "reading" ? "Reading" : "Pulling in history"} · last {p.window_days === 30 ? "30 days" : "3 months"}
            </span>
            <span className="tabular-nums text-foreground">{pct}%</span>
          </div>
          <Bar pct={pct} />
          <dl className="mt-5 space-y-2 text-[13px]">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Conversations read</dt>
              <dd className="tabular-nums text-foreground">
                {num(p.progress?.read ?? 0)}{p.progress?.to_read ? <span className="text-muted-foreground"> of {num(p.progress.to_read)}</span> : null}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Backfill credits used</dt>
              <dd className="tabular-nums text-foreground">
                {credits ? <>{num(credits.used)}{credits.allowance != null && <span className="text-muted-foreground"> of {num(credits.allowance)}</span>}</> : "—"}
              </dd>
            </div>
          </dl>
        </DialogContent>
      </Dialog>
    </>
  );
}
