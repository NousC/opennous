// The run table's columns (GET-616), shared by Automations' Run history and one automation's Runs
// tab in the editor: when it ran, what fired it, what it produced, and how it went.
import { format } from "date-fns";
import type { Column } from "@/components/ui/data-table";
import { cn } from "@/lib/utils";
import { runError, type Run } from "@/lib/automations";
import { triggerDef } from "@/lib/flows";

const RUN_LABEL: Record<string, string> = { ok: "Done", error: "Failed", running: "Running", awaiting_approval: "Needs approval", waiting: "Waiting", skipped: "Skipped", rejected: "Skipped" };
const RUN_DOT: Record<string, string> = {
  ok: "bg-positive", error: "bg-risk", running: "bg-warning-dot", waiting: "bg-warning-dot", awaiting_approval: "bg-warning-dot",
};

/** A run's status as a dot and a word. */
function runStatus(status: string) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-ink-2">
      <span className={cn("size-1.5 shrink-0 rounded-full", RUN_DOT[status] ?? "bg-muted-foreground/40")} />
      {RUN_LABEL[status] ?? status}
    </span>
  );
}

/** The run table's columns, shared by History and an automation's own Runs tab. */
export function runColumns(navigate: (to: string) => void, opts: { automation?: boolean; version?: boolean } = {}): Column<Run>[] {
  const cols: Column<Run>[] = [
    { key: "time", header: "Time", width: "128px", cell: (r) => <span className="text-xs text-muted-foreground">{format(new Date(r.started_at), "d MMM, HH:mm")}</span> },
  ];
  if (opts.version) cols.push({ key: "version", header: "Version", width: "72px", cell: (r) => <span className="text-xs text-muted-foreground">{r.version ? `v${r.version}` : "—"}</span> });
  if (opts.automation) cols.push({
    key: "automation", header: "Workflow", width: "26%",
    cell: (r) => r.routine_id && r.automation !== "Deleted workflow"
      ? <button type="button" onClick={(e) => { e.stopPropagation(); navigate(`/workflows/${r.routine_id}`); }} className="block max-w-full truncate text-left hover:underline">{r.automation}</button>
      : <span className="block truncate text-muted-foreground">{r.automation}</span>,
  });
  cols.push(
    { key: "trigger", header: "Trigger", width: "20%", cell: (r) => <span className="block truncate text-ink-2">{r.when ? (triggerDef(r.when)?.label ?? r.when) : "—"}</span> },
    {
      key: "output", header: "Output",
      cell: (r) => (
        <span className={cn("block max-w-[420px] truncate", r.status === "error" ? "text-risk" : "text-muted-foreground")} title={r.error ?? undefined}>
          {/* A failed run says which step and why ("Step 3 · HubSpot · Update the deal: no open deal
              on this account in HubSpot"); a run that stopped on purpose says where (GET-710). */}
          {r.status === "awaiting_approval" ? "Waiting for your approval, in Approvals"
            : r.status === "rejected" ? (r.error ?? "Skipped")
            : r.status === "error" ? runError(r.error)
            : r.error && /^Step \d+ · /.test(r.error) ? r.error
            : r.document_id ? (
              <a href={`/pages/${r.document_id}`} onClick={(e) => { e.preventDefault(); navigate(`/pages/${r.document_id}`); }}
                className="text-foreground underline-offset-2 hover:underline">
                {r.document_title ?? "Report"}
              </a>
            ) : ""}
        </span>
      ),
    },
    {
      // What it cost (GET-714): the run's credits, each step's share on hover.
      key: "credits", header: "Credits", width: "80px",
      cell: (r) => (
        <span className="text-xs tabular-nums text-muted-foreground"
          title={(r.credit_steps ?? []).map(x => `Step ${x.step}: ${x.credits} credit${x.credits === 1 ? "" : "s"}`).join("\n") || undefined}>
          {r.credits ? r.credits : "—"}
        </span>
      ),
    },
    { key: "status", header: "Status", width: "128px", cell: (r) => runStatus(r.status) },
  );
  return cols;
}

