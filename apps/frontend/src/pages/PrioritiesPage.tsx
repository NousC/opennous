// The Inbox (GET-945): Priorities as a page, the Workspace plan's sidebar row and, since 2026-10-29,
// the API plan's top-row icon beside Home. The same inbox the top bar's ⚑ used to drop down
// (components/priorities/PrioritiesInbox): the list on the left, the selected item read in place on
// the right. `?item=` opens on one item, e.g. a test run's Review (run:<id>).
//
// Laid out like Workflows (2026-10-29): the page's toolbar with its tabs on the right, then the two
// panes edge to edge (it was a card inside the shell's card). The tabs, `?tab=`:
//   Post-meetings · Follow-ups (signals, drafts to review, runs to review) · Results (what the workflows wrote).
import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { PrioritiesInbox } from "@/components/priorities/PrioritiesInbox";
import { usePriorities } from "@/components/shell/PrioritiesButton";
import { buildItems, isInboxTab, openCount, tabOf, TABS, type InboxTab } from "@/components/priorities/inboxModel";
import { PageToolbar } from "@/components/ui/page-top-bar";
import { ViewTabs } from "@/components/ui/view-tabs";

/** The tab an `?item=` key lives in: a meeting's id, act:/run: a draft or review, out: a run. */
const tabOfKey = (key: string): InboxTab => (key.startsWith("out:") ? "workflows" : key.startsWith("act:") || key.startsWith("run:") ? "act" : "meetings");

export default function PrioritiesPage() {
  const [params, setParams] = useSearchParams();
  const { data, loading, failed, ws, token, chipFor, outcomesLoading } = usePriorities({ open: true });
  const items = useMemo(() => buildItems(data), [data]);
  const counts = useMemo(() => ({
    meetings: openCount(items.filter((i) => tabOf(i) === "meetings")),
    act: openCount(items.filter((i) => tabOf(i) === "act")),
  }), [items]);
  const focus = params.get("item");
  const asked = params.get("tab");
  // Asked for, or the tab the linked item is in; otherwise the first with something waiting.
  const tab: InboxTab = isInboxTab(asked) ? asked : focus ? tabOfKey(focus)
    : counts.meetings ? "meetings" : counts.act ? "act" : "meetings";
  const onTab = (next: InboxTab) => setParams((p) => { const q = new URLSearchParams(p); q.set("tab", next); q.delete("item"); return q; }, { replace: true });

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col text-[13px]">
      <PageToolbar>
        <span className="flex-1" />
        <ViewTabs<InboxTab> aria-label="Inbox views" value={tab} onChange={onTab}
          options={TABS.map(({ tab: value, label }) => ({ value, label, count: value === "workflows" ? undefined : counts[value] || undefined }))} />
      </PageToolbar>
      <div className="min-h-0 flex-1">
        <PrioritiesInbox key={tab} tab={tab} data={data} ws={ws} token={token} chipFor={chipFor} onClose={() => {}}
          focus={focus} failed={failed} loading={tab === "workflows" ? outcomesLoading || (!data && loading) : loading} />
      </div>
    </div>
  );
}
