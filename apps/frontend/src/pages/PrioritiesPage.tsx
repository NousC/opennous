// The Inbox (GET-945): Priorities as a page, the Workspace plan's sidebar row. The same inbox the
// top bar's ⚑ used to drop down (components/priorities/PrioritiesInbox): After your meetings,
// From signals (GET-944) and Drafts to review on the left, the selected item
// read in place on the right. `?item=` opens on one item, e.g. a test run's Review (run:<id>).
import { useSearchParams } from "react-router-dom";
import { PrioritiesInbox } from "@/components/priorities/PrioritiesInbox";
import { usePriorities } from "@/components/shell/PrioritiesButton";

export default function PrioritiesPage() {
  const [params] = useSearchParams();
  const { data, loading, failed, ws, token, chipFor } = usePriorities({ open: true });
  return (
    <div className="h-full min-h-0 min-w-0 bg-background p-3 sm:p-4">
      <div className="h-full overflow-hidden rounded-2xl border border-border/70 bg-card">
        <PrioritiesInbox data={data} loading={loading} failed={failed} ws={ws} token={token}
          focus={params.get("item")} chipFor={chipFor} onClose={() => {}} />
      </div>
    </div>
  );
}
