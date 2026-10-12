// Priorities (GET-598): everything that needs you, behind one icon in the top bar on every page.
// It used to be a section on Home (GET-477) and came back here with the interface refresh.
//
// Since GET-678 it opens an inbox: a wide two-pane panel dropping from the ⚑ button, the list
// grouped by what each item is on the left and the selected item read in place on the right
// (components/priorities/PrioritiesInbox). Since GET-681 it holds two things: "After your
// meetings", the wrap-up cards waiting from Home's read (/api/home, the Workspace layer's — GET-754),
// and "To approve", the drafts
// waiting on your approval (/api/actions). The count on the button is meetings plus drafts still open.
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Flag } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";
import { useBookScope } from "@/hooks/useBookScope";
import { freshAccessToken } from "@/lib/freshToken";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PrioritiesInbox } from "@/components/priorities/PrioritiesInbox";
import { buildItems, openCount, type InboxRead } from "@/components/priorities/inboxModel";
import { usePendingDrafts } from "@/components/priorities/drafts";
import { automationsFetch } from "@/lib/automations";
import { approvalWhat, type Approval } from "@/components/AutomationApprovals";
import { cloud } from "@/lib/cloud";

const NO_MEETINGS: InboxRead = {};

/** Dispatch on window to open Priorities from anywhere (a test run's "Review"). */
export const OPEN_PRIORITIES = "open-priorities";

export function PrioritiesButton() {
  const { userData, session } = useAuth();
  const ws = (userData as { workspace?: { id?: string } })?.workspace?.id ?? "";
  const [scope] = useBookScope();
  const [open, setOpen] = useState(false);

  // "After your meetings" is Home's read, the Workspace layer's (GET-754). Without it there is no
  // such read, and Priorities holds only what waits on your approval.
  const meetings = cloud.shell?.priorities?.meetings;
  const home = useQuery({
    queryKey: ["home", ws, scope],
    enabled: !!ws && !!meetings,
    staleTime: 5 * 60_000,
    queryFn: (): Promise<InboxRead> => meetings!({ ws, scope, token: session?.access_token }),
  });
  const homeData: InboxRead | undefined = meetings ? home.data : NO_MEETINGS;

  // The drafts are their own read: a failure there leaves Priorities as Home has it.
  const drafts = usePendingDrafts(ws, session?.access_token);
  // Automation runs waiting on a review (GET-737): on this plan they are Priorities', not a tab's.
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
  const data = useMemo<InboxRead | undefined>(() => (homeData ? {
    ...homeData, actions: drafts.data ?? [],
    runs: (runs.data ?? []).map(a => ({ ...a, what: approvalWhat(a) })),
  } : undefined), [homeData, drafts.data, runs.data]);
  // "Review" on a test run opens this panel (GET-737).
  // A run named in the event opens selected (GET-739).
  const [focus, setFocus] = useState<string | null>(null);
  useEffect(() => {
    const open = (e: Event) => {
      const runId = (e as CustomEvent<{ runId?: string | null } | undefined>).detail?.runId ?? null;
      setFocus(runId ? `run:${runId}` : null);
      void runs.refetch(); setOpen(true);
    };
    window.addEventListener(OPEN_PRIORITIES, open);
    return () => window.removeEventListener(OPEN_PRIORITIES, open);
  }, [runs]);
  const count = useMemo(() => openCount(buildItems(data)), [data]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={count ? `Priorities, ${count}` : "Priorities"}
              className={cn(
                "inline-flex h-7 items-center justify-center gap-1.5 rounded-lg border border-border/70 bg-card text-muted-foreground/70 transition-colors duration-fast hover:bg-hover hover:text-foreground data-[state=open]:bg-hover",
                count > 0 ? "pl-2 pr-2.5" : "w-7",
              )}
            >
              <Flag className="h-[14px] w-[14px]" strokeWidth={1.75} />
              {/* The count sits in the button as plain text, not a floating badge (polish pass). */}
              {count > 0 && <span className="text-[12.5px] tabular-nums text-foreground">{count}</span>}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Priorities</TooltipContent>
      </Tooltip>
      {/* The inbox (GET-678): anchored under the button at the top right, the ⌘K palette's card
          (16px radius, the modal shadow); on a phone it is a full-width sheet. */}
      <PopoverContent align="end" sideOffset={8} collisionPadding={8}
        onOpenAutoFocus={(e) => e.preventDefault()}
        // Esc in a field (the email, a task being renamed) leaves the field, not the panel.
        onEscapeKeyDown={(e) => {
          const t = document.activeElement as HTMLElement | null;
          if (t?.closest("input, textarea, select, [contenteditable='true']")) { e.preventDefault(); t.blur(); }
        }}
        className="h-[min(80vh,680px)] w-[940px] max-w-[calc(100vw-16px)] overflow-hidden rounded-2xl p-0 shadow-modal max-md:h-[calc(100dvh-64px)]">
        <PrioritiesInbox data={data} loading={!!meetings && home.isLoading} failed={!!meetings && home.isError} ws={ws} token={session?.access_token} focus={focus}
          onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}
