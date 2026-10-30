// One run, step by step (GET-721). Opened from Run history: each step with what it did, the output
// it wrote (the call summary, the follow-up email), where it failed and why, what it waits for, and
// what it cost. A failed step opens in the editor on that very step.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, Clock, Loader2, X, Minus } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { automationsFetch } from "@/lib/automations";
import { when as ago } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";

export type RunOutput =
  | { kind: "email"; id: string; title: string | null; subject: string | null; body: string }
  | { kind: "brief"; id: string; title: string | null; headline: string | null; text: string; sections: string[] };
type RunStep = { step: number; id: string | null; type: string | null; name: string; status: string; detail: string | null; output: RunOutput | null; credits?: number };
type RunDetail = {
  id: string; status: string; error: string | null; started_at: string; credits: number;
  automation: { id: string; name: string; trigger: string | null };
  steps: RunStep[]; waiting: { step: string; rows: { label: string; value: string }[] } | null;
};

const ICON: Record<string, { icon: typeof Check; tone: string }> = {
  ok: { icon: Check, tone: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" },
  failed: { icon: X, tone: "bg-red-500/10 text-red-600 dark:text-red-400" },
  waiting: { icon: Clock, tone: "bg-amber-500/10 text-amber-600 dark:text-amber-400" },
  stopped: { icon: Minus, tone: "bg-foreground/[0.06] text-muted-foreground" },
};

/** An output as a person reads it: the email, or the brief, folded to a few lines until opened. */
export function OutputView({ output }: { output: RunOutput }) {
  const [open, setOpen] = useState(false);
  const text = output.kind === "email" ? output.body : output.text;
  const long = text.length > 420;
  return (
    <div className="mt-2 rounded-[10px] bg-foreground/[0.035] px-3 py-2.5">
      {output.kind === "email"
        ? <p className="mb-1.5 text-[12.5px] font-medium text-foreground">{output.subject ?? "Email"}</p>
        : output.headline ? <p className="mb-1.5 text-[12.5px] font-medium text-foreground">{output.headline}</p> : null}
      <p className={cn("whitespace-pre-line text-[12.5px] leading-relaxed text-foreground/80", !open && long && "line-clamp-6")}>{text || "(empty)"}</p>
      {long && (
        <button onClick={() => setOpen(v => !v)} className="mt-1 text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
          {open ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  );
}

export function AutomationRunDetail({ runId, onClose, onOpenApprovals }: { runId: string | null; onClose: () => void; onOpenApprovals?: () => void }) {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const workspaceId = userData?.workspace?.id ?? "";
  const navigate = useNavigate();
  const [run, setRun] = useState<RunDetail | null>(null);
  // A run that can't be read says so, instead of a spinner that never ends.
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setRun(null); setFailed(null);
    if (!runId || !token || !workspaceId) return;
    let alive = true;
    automationsFetch(`/runs/${runId}?workspaceId=${workspaceId}`, token, { signal: AbortSignal.timeout(20_000) })
      .then(async r => {
        const b = await r.json().catch(() => null);
        if (!alive) return;
        if (r.ok && b?.automation) setRun(b);
        else setFailed(r.status === 404 ? "This run isn't there any more." : `Couldn't open this run (${b?.error ?? r.status}).`);
      })
      .catch(e => { if (alive) setFailed(e?.name === "TimeoutError" ? "Opening this run took too long." : "Couldn't reach OpenNous to open this run."); });
    return () => { alive = false; };
  }, [runId, token, workspaceId, attempt]);

  return (
    <Sheet open={!!runId} onOpenChange={o => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-[560px]">
        {!run && failed ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2 text-[12.5px] text-muted-foreground">
            {failed}
            <button type="button" onClick={() => setAttempt(n => n + 1)} className="text-foreground underline-offset-2 hover:underline">Try again</button>
          </div>
        ) : !run ? (
          <div className="flex h-40 items-center justify-center"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
        ) : (<>
          <SheetHeader className="text-left">
            <SheetTitle className="text-[15px]">{run.automation.name}</SheetTitle>
            <SheetDescription className="text-[12.5px]">
              {ago(run.started_at)} · {run.status === "ok" ? "Done" : run.status === "error" ? "Failed" : run.status === "awaiting_approval" ? "Waiting for approval" : run.status === "rejected" ? "Skipped" : run.status}
              {run.credits ? ` · ${run.credits} credit${run.credits === 1 ? "" : "s"}` : ""}
            </SheetDescription>
          </SheetHeader>
          <ol className="mt-5 space-y-4">
            {run.steps.map((s, i) => {
              const ic = ICON[s.status] ?? ICON.stopped;
              const Icon = ic.icon;
              return (
                <li key={`${s.step}-${i}`} className="flex gap-3">
                  <span className={cn("mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full", ic.tone)}>
                    <Icon className="h-3.5 w-3.5" strokeWidth={2.2} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-baseline gap-2 text-[13px]">
                      <span className="font-medium text-foreground">Step {s.step} · {s.name}</span>
                      {!!s.credits && <span className="ml-auto text-[11.5px] tabular-nums text-muted-foreground">{s.credits} credit{s.credits === 1 ? "" : "s"}</span>}
                    </p>
                    {s.detail && <p className={cn("mt-0.5 text-[12.5px]", s.status === "failed" ? "text-red-600 dark:text-red-400" : "text-muted-foreground")}>{s.detail}</p>}
                    {s.output && <OutputView output={s.output} />}
                    {s.status === "failed" && s.id && (
                      <button onClick={() => navigate(`/rev-plays/${run.automation.id}?step=${s.id}`)}
                        className="mt-1.5 text-[12px] text-foreground underline-offset-2 hover:underline">Open this step in the editor</button>
                    )}
                    {s.status === "waiting" && onOpenApprovals && (
                      <button onClick={() => { onClose(); onOpenApprovals(); }}
                        className="mt-1.5 text-[12px] text-foreground underline-offset-2 hover:underline">Review in Approvals</button>
                    )}
                  </div>
                </li>
              );
            })}
            {!run.steps.length && <p className="text-[12.5px] text-muted-foreground">{run.error ?? "This run has no step record. Runs from before today only kept their result."}</p>}
          </ol>
        </>)}
      </SheetContent>
    </Sheet>
  );
}
