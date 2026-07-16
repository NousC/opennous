import { useState, useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

type ReportRow = {
  id: string;
  lead_list_id: string | null;
  provider: string | null;
  title: string;
  period_from: string | null;
  period_to: string | null;
  metrics_json: { totals?: Record<string, number> } | null;
  generated_at: string;
};

export default function Reports() {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const workspaceId = userData?.workspace?.id ?? "";
  const [reports, setReports] = useState<ReportRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token || !workspaceId) return;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`${apiUrl}/api/reports?workspaceId=${workspaceId}`, { headers: { Authorization: `Bearer ${token}` } });
        const d = await res.json();
        setReports(d.reports || []);
      } catch { /* ignore */ } finally { setLoading(false); }
    })();
  }, [token, workspaceId]);

  return (
    <div className="flex flex-col h-full bg-background">
      <div className="px-8 pt-7 pb-4">
        <h1 className="text-[20px] font-semibold tracking-tight text-foreground">Reports</h1>
      </div>
      <div className="flex-1 overflow-auto px-8 pb-8">
        {loading ? (
          <div className="text-[13px] text-muted-foreground py-8">Loading…</div>
        ) : reports.length === 0 ? (
          <div className="text-[13px] text-muted-foreground/70 py-12">
            No reports yet. They generate automatically each week per active campaign (a lead list pushed to a sequencer).
          </div>
        ) : (
          <div className="divide-y divide-border/60 border-y border-border/60">
            {reports.map(r => (
              <button
                key={r.id}
                onClick={() => window.open(`/report/${r.id}`, "_blank")}
                title="Open report in a new tab"
                className="w-full text-left flex items-center gap-4 px-1 py-3.5 hover:bg-muted/40 transition-colors"
              >
                <span className="text-[14px] font-medium text-foreground/90 flex-1 truncate">{r.title}</span>
                {r.metrics_json?.totals && (
                  <span className="text-[12px] text-muted-foreground hidden sm:inline">
                    {r.metrics_json.totals.reached ?? "—"} reached · {r.metrics_json.totals.replied ?? "—"} replied
                  </span>
                )}
                <span className="text-[12px] text-muted-foreground/70 flex-shrink-0 w-20 text-right">
                  {new Date(r.generated_at).toLocaleDateString()}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
