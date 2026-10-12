// One automation's runs (GET-523) — the Runs tab of the editor. What fired, when, what it
// produced and whether it worked: the same table as History, narrowed to this automation, with
// its own numbers on top, in the same cards.
import { AutomationRunDetail } from "@/components/AutomationRunDetail";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { automationsFetch, type Run } from "@/lib/automations";
import { num } from "@/lib/format";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { StatStrip } from "@/components/ui/stat-strip";
import { SegmentedControl } from "@/components/ui/view-tabs";
import { runColumns } from "@/components/automationRunColumns";
import { STRIP_FOLD } from "@/components/reports/parts";

const WINDOWS: [string, number | null][] = [["7d", 7], ["30d", 30], ["90d", 90], ["All", null]];

export function AutomationRuns({ automationId }: { automationId: string }) {
  const navigate = useNavigate();
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const workspaceId = userData?.workspace?.id ?? "";
  const [days, setDays] = useState<number | null>(30);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [stats, setStats] = useState<{ runs: number; reports: number; failed: number } | null>(null);

  useEffect(() => {
    if (!token || !workspaceId) return;
    let alive = true;
    setRuns(null);
    (async () => {
      const q = new URLSearchParams({ workspaceId, routines: automationId });
      if (days != null) q.set("days", String(days));
      const res = await automationsFetch(`/runs?${q}`, token);
      const body = res.ok ? await res.json().catch(() => ({})) : {};
      if (!alive) return;
      setRuns(Array.isArray(body.runs) ? body.runs : []);
      setStats(body.stats ?? null);
    })();
    return () => { alive = false; };
  }, [token, workspaceId, automationId, days]);

  // History's columns without the Automation one, plus the version that ran.
  const columns = runColumns(navigate, { version: true });
  return (
    <div className="h-full overflow-y-auto px-6 pb-28 pt-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <StatStrip className={`max-w-[760px] flex-1 ${STRIP_FOLD}`} stats={[
          { label: "Runs", value: stats ? num(stats.runs) : "—" },
          { label: "Reports created", value: stats ? num(stats.reports) : "—" },
          { label: "Failed", value: stats ? num(stats.failed) : "—", tone: stats?.failed ? "risk" : undefined },
        ]} />
        <SegmentedControl<string> aria-label="Window" value={String(days)} onChange={(v) => setDays(v === "null" ? null : Number(v))}
          options={WINDOWS.map(([label, v]) => ({ value: String(v), label }))} />
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card [&_tbody_tr:last-child_td]:border-b-0">
        <AutomationRunDetail runId={openRun} onClose={() => setOpenRun(null)} />
        <DataTable aria-label="Runs" columns={columns} rows={runs ?? []} rowKey={(r) => r.id} loading={runs === null} minWidth={720} onRowClick={(r) => setOpenRun(r.id)}
          empty={<EmptyState bordered={false} title={days == null ? "It hasn't run yet." : `Nothing in the last ${days} days.`} />} />
      </div>
    </div>
  );
}
