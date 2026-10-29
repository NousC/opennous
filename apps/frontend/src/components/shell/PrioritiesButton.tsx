// Priorities (GET-598): everything that needs you. Since GET-945 it is the Inbox page (pages/
// PrioritiesPage, the sidebar's Inbox on the Workspace plan); this button opens it from any page.
// Before, it opened the same inbox as a panel under the button.
// It used to be a section on Home (GET-477) and came back here with the interface refresh.
//
// Since GET-678 it opens an inbox: a wide two-pane panel dropping from the ⚑ button, the list
// grouped by what each item is on the left and the selected item read in place on the right
// (components/priorities/PrioritiesInbox). Since GET-681 it holds two things: "After your
// meetings", the wrap-up cards waiting from Home's read (/api/home, the Workspace layer's — GET-754),
// and "To approve", the drafts
// waiting on your approval (/api/actions). The count on the button is meetings plus drafts still open.
import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Flag } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";
import { useBookScope } from "@/hooks/useBookScope";
import { freshAccessToken } from "@/lib/freshToken";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { buildItems, openCount, type InboxOutcome, type InboxRead } from "@/components/priorities/inboxModel";
import { usePendingDrafts } from "@/components/priorities/drafts";
import { automationsFetch } from "@/lib/automations";
import { approvalWhat, type Approval } from "@/components/AutomationApprovals";
import { cloud, type ItemChip } from "@/lib/cloud";

const noChip = (): ItemChip | null => null;

const NO_MEETINGS: InboxRead = {};

/** Dispatch on window to open Priorities from anywhere (a test run's "Review"). */
export const OPEN_PRIORITIES = "open-priorities";

/**
 * Everything Priorities holds, for the top bar's button and the Inbox page (GET-945): Home's
 * meeting read (the Workspace layer's), the drafts waiting on you and the automation runs waiting
 * on a review, shaped for PrioritiesInbox, with the open count.
 */
export function usePriorities({ open }: { open: boolean }) {
  const { userData, session } = useAuth();
  const ws = (userData as { workspace?: { id?: string } })?.workspace?.id ?? "";
  const [scope] = useBookScope();
  const meetings = cloud.shell?.priorities?.meetings;
  const home = useQuery({
    queryKey: ["home", ws, scope],
    enabled: !!ws && !!meetings,
    staleTime: 5 * 60_000,
    queryFn: (): Promise<InboxRead> => meetings!({ ws, scope, token: session?.access_token }),
  });
  const homeData: InboxRead | undefined = meetings ? home.data : NO_MEETINGS;
  const drafts = usePendingDrafts(ws, session?.access_token);
  const runs = useQuery({
    queryKey: ["automation-approvals", ws],
    enabled: !!ws && !!session?.access_token,
    staleTime: 60_000,
    queryFn: async (): Promise<Approval[]> => {
      const token = (await freshAccessToken()) ?? session?.access_token ?? "";
      const r = await automationsFetch(`/approvals?workspaceId=${ws}`, token);
      return r.ok ? ((await r.json())?.approvals ?? []) : [];
    },
  });
  // The Inbox page's Results tab (2026-10-29): what the workflows finished in the last 14 days.
  // Read only while the page is open; the ⚑ count never includes them.
  const outcomes = useQuery({
    queryKey: ["inbox-outcomes", ws],
    enabled: open && !!ws && !!session?.access_token,
    staleTime: 60_000,
    queryFn: async (): Promise<InboxOutcome[]> => {
      const token = (await freshAccessToken()) ?? session?.access_token ?? "";
      const r = await automationsFetch(`/runs?${new URLSearchParams({ workspaceId: ws, days: "14", status: "ok" })}`, token);
      return r.ok ? ((await r.json())?.runs ?? []) : [];
    },
  });
  const chipFor = cloud.shell?.priorities?.useItemChip?.({ ws, token: session?.access_token ?? "", open }) ?? noChip;
  const data = useMemo<InboxRead | undefined>(() => (homeData ? {
    ...homeData, actions: drafts.data ?? [],
    runs: (runs.data ?? []).map(a => ({ ...a, what: approvalWhat(a) })),
    outcomes: outcomes.data ?? [],
  } : undefined), [homeData, drafts.data, runs.data, outcomes.data]);
  const count = useMemo(() => openCount(buildItems(data)), [data]);
  return {
    ws, token: session?.access_token, data, count, chipFor, refetchRuns: runs.refetch,
    loading: !!meetings && home.isLoading, failed: !!meetings && home.isError,
    outcomesLoading: outcomes.isLoading,
  };
}

export function PrioritiesButton() {
  // On the Workspace plan Priorities is a page, the sidebar's Inbox (GET-945): the button opens it,
  // and "Review" on a test run opens it on that run.
  const navigate = useNavigate();
  const { count } = usePriorities({ open: false });
  useEffect(() => {
    const go = (e: Event) => {
      const runId = (e as CustomEvent<{ runId?: string | null } | undefined>).detail?.runId ?? null;
      navigate(runId ? `/inbox?item=${encodeURIComponent(`run:${runId}`)}` : "/inbox");
    };
    window.addEventListener(OPEN_PRIORITIES, go);
    return () => window.removeEventListener(OPEN_PRIORITIES, go);
  }, [navigate]);
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => navigate("/inbox")}
          aria-label={count ? `Inbox, ${count}` : "Inbox"}
          className={cn(
            "inline-flex h-7 items-center justify-center gap-1.5 rounded-lg border border-border/70 bg-card text-muted-foreground/70 transition-colors duration-fast hover:bg-hover hover:text-foreground",
            count > 0 ? "pl-2 pr-2.5" : "w-7",
          )}
        >
          <Flag className="h-[14px] w-[14px]" strokeWidth={1.75} />
          {/* The count sits in the button as plain text, not a floating badge (polish pass). */}
          {count > 0 && <span className="text-[12.5px] tabular-nums text-foreground">{count}</span>}
        </button>
      </TooltipTrigger>
      <TooltipContent>Inbox</TooltipContent>
    </Tooltip>
  );
}
