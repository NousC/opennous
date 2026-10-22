// "How to win this deal", the top of the deal page (GET-793). The account has its AI Overview; a
// deal had only tiles. Four to six sentences from the worker (signals/dealOverview.mjs): where it
// stands, what is in the way, what they need to see from us, the next moves. Written the first
// time the page opens a deal without one, and again on refresh; never on a timer.
import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { ListCard } from "@/components/ui/list";
import { when as fmtWhen } from "@/lib/format";
import { cn } from "@/lib/utils";
import { H3 } from "@/components/record/OverviewParts";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

export function DealOverviewCard({ accountId, dealId, initial }: {
  accountId: string;
  dealId: string;
  initial: { text: string; at: string | null } | null | undefined;
}) {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const wsId = (userData as { workspace?: { id?: string } } | null)?.workspace?.id ?? "";
  const [ov, setOv] = useState(initial ?? null);
  const [state, setState] = useState<"idle" | "working" | "failed" | "empty">("idle");
  const asked = useRef<string | null>(null);

  const write = async () => {
    if (!token || !wsId || !accountId) return;
    setState("working");
    try {
      const r = await fetch(`${apiUrl}/api/companies/${accountId}/deals/${encodeURIComponent(dealId)}/overview?workspaceId=${wsId}`, {
        method: "POST", headers: { Authorization: `Bearer ${token}` },
      });
      const d = r.ok ? await r.json() : null;
      if (d?.overview) { setOv({ text: d.overview, at: d.generated_at ?? new Date().toISOString() }); setState("idle"); }
      else setState(r.ok ? "empty" : "failed");
    } catch { setState("failed"); }
  };

  // A new deal on the page: show what it carries, and write one once when it has none.
  useEffect(() => {
    setOv(initial ?? null);
    setState("idle");
    if (!initial && asked.current !== `${accountId}:${dealId}`) { asked.current = `${accountId}:${dealId}`; void write(); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, dealId]);

  return (
    <ListCard className="min-w-0">
      <div className="flex min-h-8 min-w-0 items-center gap-2 px-2 pb-1 pt-0.5">
        <H3>How to win this deal</H3>
        {ov?.at && <span className="truncate text-[12px] text-muted-foreground/60">Updated {fmtWhen(ov.at)}</span>}
        <span className="flex-1" />
        <button type="button" onClick={() => void write()} disabled={state === "working"} title="Rewrite from the latest facts and activity"
          className="rounded-md p-1.5 text-muted-foreground/70 transition-colors duration-fast hover:bg-hover hover:text-foreground disabled:opacity-60">
          <RefreshCw className={cn("h-3.5 w-3.5", state === "working" && "animate-spin")} />
        </button>
      </div>
      <div className="px-2 pb-2">
        {ov?.text
          ? <p className="text-[13.5px] leading-relaxed text-foreground/90 [overflow-wrap:anywhere]">{ov.text}</p>
          : state === "working"
            ? <p className="text-[13px] text-muted-foreground">Writing it from this deal's calls, email and facts. This takes about half a minute the first time.</p>
            : state === "empty"
              ? <p className="text-[13px] text-muted-foreground">Not enough on this deal yet. It's written from its calls, email and facts.</p>
              : <p className="text-[13px] text-muted-foreground">Couldn't write it just now. Press refresh to try again.</p>}
        {ov?.text && state === "failed" && <p className="mt-1 text-[12px] text-muted-foreground">Couldn't rewrite it just now.</p>}
      </div>
    </ListCard>
  );
}
