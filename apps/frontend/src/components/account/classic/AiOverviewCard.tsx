// The account's AI Overview: one written summary, three to five sentences (GET-792, GET-797).
//
// It used to open into "What we know / What they want / Key concerns" lists under a two-line
// clamp. The summary now carries all of that in one paragraph, shown whole; the facts behind it
// live on the Intel tab. The refresh rewrites it from the latest facts.
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { CARD, updatedAgo } from "./parts";

export function AiOverviewCard({ summary, at, state, onRefresh }: {
  summary: string | null;
  at: string | null;
  state: "idle" | "working" | "failed";
  onRefresh: () => void;
}) {
  const when = updatedAgo(at);
  const body = state === "working" && !summary
    ? <p className="text-[13.5px] leading-relaxed text-muted-foreground">Writing the summary from the latest calls and activity…</p>
    : summary
      ? <p className="text-[13.5px] leading-relaxed text-foreground/90 [overflow-wrap:anywhere]">{summary}</p>
      : <p className="text-[13.5px] leading-relaxed text-muted-foreground">No summary yet. It's written from your calls and activity on this account. Press refresh to write one now.</p>;

  return (
    <div className={cn(CARD, "min-w-0")}>
      <div className="flex items-center gap-2 px-5 pb-2 pt-4">
        <span className="text-[14px] font-semibold text-foreground">AI Overview</span>
        {when && <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground/70">· {when}</span>}
        <button onClick={onRefresh} disabled={state === "working"} title="Rewrite the summary from this account's latest facts"
          className="ml-auto flex-shrink-0 rounded-md p-1.5 text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground disabled:opacity-60">
          <RefreshCw className={cn("h-3.5 w-3.5", state === "working" && "animate-spin")} />
        </button>
      </div>
      <div className="px-5 pb-5">
        {body}
        {state === "failed" && <p className="mt-1 text-[12px] text-muted-foreground">Couldn't write the summary just now. Try again in a minute.</p>}
      </div>
    </div>
  );
}
