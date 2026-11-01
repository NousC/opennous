// Settings → General: the Sync done pop-up, reopened (GET-1087). The top bar owns the pop-up, so
// this only asks for it. Shown once a sync has finished.
import { useSearchParams } from "react-router-dom";
import { useOnboardingChecklist } from "@/hooks/useOnboardingChecklist";

export function SyncDoneRow() {
  const { checklist: c } = useOnboardingChecklist();
  const [params, setParams] = useSearchParams();
  if (c?.sync?.state !== "done") return null;
  return (
    <div className="mb-3 flex items-center gap-3 rounded-xl border border-hairline bg-card px-3.5 py-3 text-[13px]">
      <span className="min-w-0 flex-1 font-medium">History synced</span>
      <button type="button" className="inline-flex h-7 items-center rounded-lg border border-border bg-card px-2.5 text-[12.5px] font-medium transition-colors hover:bg-hover"
        onClick={() => { params.set("syncdone", "1"); setParams(params, { replace: true }); }}>
        Read your history
      </button>
    </div>
  );
}
