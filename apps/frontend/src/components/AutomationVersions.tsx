// One automation's versions (GET-584) — the Versions tab of the editor. Every publish is a
// numbered version with who made it and what changed since the one before; any of them opens
// read-only and can be restored, which makes it the next version rather than rewriting history.
import { useCallback, useEffect, useState } from "react";
import { format } from "date-fns";
import { Loader2, RotateCcw } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StepMark, TriggerMark } from "@/components/AutomationMarks";
import { automationsFetch, fromSnapshot, type Automation, type Snapshot } from "@/lib/automations";
import { flowFromRow, stepTitle, triggerDef, type Flow, type Step } from "@/lib/flows";

type Version = { version: number; published_at: string; published_by: string | null; snapshot: Snapshot };

/** The settings a step shows when you read a version, in the order you would check them. */
function stepDetail(st: Step): [string, string][] {
  const c = st.config;
  const rows: [string, unknown][] = st.type === "agent"
    ? [["Job", c.job], ["Instructions", c.prompt], ["Anything to add", c.extra], ["Model", c.model]]
    : st.type === "email" || st.type === "gmail"
      ? [["To", c.to], ["Cc", c.cc], ["Subject", c.subject], ["Body", c.body], ["Attachment", st.type === "email" ? (c.attach === "none" ? "None" : "AI output as PDF") : null]]
      : st.type === "slack" ? [["Channel", c.channel], ["Message", c.text]]
      : st.type === "webhook" ? [["URL", c.url]]
      : [];
  return rows.filter(([, v]) => v != null && String(v).trim() !== "").map(([k, v]) => [k, String(v)]);
}

/** What changed from one version to the next, in words. */
function changes(prev: Flow | null, next: Flow, prevName: string | undefined, nextName: string | undefined): string[] {
  if (!prev) return ["First version"];
  const out: string[] = [];
  if (prevName !== nextName) out.push("Name");
  if (prev.trigger.kind !== next.trigger.kind || JSON.stringify(prev.trigger.config) !== JSON.stringify(next.trigger.config)) out.push("Trigger");
  const before = new Map(prev.steps.map(st => [st.id, st]));
  for (const st of next.steps) {
    const was = before.get(st.id);
    if (!was) out.push(`Added ${stepTitle(st)}`);
    else if (JSON.stringify(was.config) !== JSON.stringify(st.config)) out.push(stepTitle(st));
    before.delete(st.id);
  }
  for (const st of before.values()) out.push(`Removed ${stepTitle(st)}`);
  return out.length ? out : ["No visible change"];
}

export function AutomationVersions({ automation, onRestored, onView }: {
  automation: Automation; onRestored: (row: Automation) => void;
  /** Open a version in the canvas (GET-739). Without it, View reads it in a dialog. */
  onView?: (v: { version: number; publishedAt: string; by: string | null; live: boolean; flow: Flow }) => void;
}) {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const workspaceId = userData?.workspace?.id ?? "";
  const [data, setData] = useState<{ live: number; has_draft: boolean; versions: Version[] } | null>(null);
  const [viewing, setViewing] = useState<Version | null>(null);
  const [confirm, setConfirm] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token || !workspaceId) return;
    const res = await automationsFetch(`/${automation.id}/versions?workspaceId=${workspaceId}`, token);
    const body = res.ok ? await res.json().catch(() => null) : null;
    setData(body ?? { live: automation.version ?? 1, has_draft: !!automation.draft, versions: [] });
  }, [token, workspaceId, automation.id, automation.version, automation.draft]);
  useEffect(() => { void load(); }, [load]);

  const restore = async (v: number) => {
    setBusy(v); setError(null);
    try {
      const res = await automationsFetch(`/${automation.id}/versions/${v}/restore?workspaceId=${workspaceId}`, token, { method: "POST" });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) { setError(out.message ?? out.error ?? "Could not restore that version."); return; }
      onRestored(out);
    } finally { setBusy(null); setConfirm(null); }
  };

  if (!data) return <div className="py-10 text-center text-[13px] text-muted-foreground">Loading…</div>;

  // Oldest first to work out what changed, shown newest first.
  const flows = [...data.versions].reverse().map(v => ({ v, flow: flowFromRow(fromSnapshot(v.snapshot, automation)) }));
  const rows = flows.map(({ v, flow }, i) => ({
    v, flow, changed: changes(i ? flows[i - 1].flow : null, flow, i ? flows[i - 1].v.snapshot.name : undefined, v.snapshot.name),
  })).reverse();

  return (
    <div className="h-full overflow-y-auto px-8 pb-28 pt-6">
      {data.has_draft && (
        <p className="mb-4 rounded-[10px] border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12.5px] text-foreground/85">
          You have unpublished changes in the editor. Restoring a version discards them.
        </p>
      )}
      {error && <p className="mb-4 text-[12.5px] text-foreground">{error}</p>}
      <div className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/70">
        {rows.map(({ v, flow, changed }) => {
          const isLive = v.version === data.live;
          return (
            <div key={v.version} className="flex items-center gap-4 px-5 py-3">
              <span className="w-10 flex-shrink-0 font-mono text-[12.5px] font-medium text-foreground">v{v.version}</span>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 truncate text-[13px] text-foreground">
                  {changed.join(" · ")}
                  {isLive && <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">Live</span>}
                </p>
                <p className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
                  {format(new Date(v.published_at), "MMM d, HH:mm")}{v.published_by ? ` · ${v.published_by}` : ""} · {flow.steps.length} step{flow.steps.length === 1 ? "" : "s"}
                </p>
              </div>
              <button onClick={() => (onView
                ? onView({ version: v.version, publishedAt: v.published_at, by: v.published_by, live: v.version === data.live, flow: flowFromRow(fromSnapshot(v.snapshot, automation)) })
                : setViewing(v))} className="h-7 rounded-md px-2.5 text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">View</button>
              {!isLive && (confirm === v.version ? (
                <span className="flex items-center gap-1">
                  <button onClick={() => setConfirm(null)} className="h-7 rounded-md px-2 text-[12px] text-muted-foreground hover:text-foreground">Cancel</button>
                  <button
                    onClick={() => void restore(v.version)}
                    disabled={busy !== null}
                    className="flex h-7 items-center gap-1 rounded-md bg-foreground px-2.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-40 dark:bg-white dark:text-background"
                  >
                    {busy === v.version && <Loader2 className="h-3 w-3 animate-spin" />}
                    Restore as v{data.live + 1}
                  </button>
                </span>
              ) : (
                <button onClick={() => setConfirm(v.version)} className="flex h-7 items-center gap-1 rounded-md px-2.5 text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
                  <RotateCcw className="h-3 w-3" /> Restore
                </button>
              ))}
            </div>
          );
        })}
        {!rows.length && <div className="px-5 py-12 text-center text-[13px] text-muted-foreground/60">No versions yet.</div>}
      </div>

      <Dialog open={!!viewing} onOpenChange={o => { if (!o) setViewing(null); }}>
        <DialogContent className="max-w-[640px] gap-0 p-0">
          {viewing && (() => {
            const flow = flowFromRow(fromSnapshot(viewing.snapshot, automation));
            return (<>
              <DialogHeader className="border-b border-border/60 px-6 py-4 text-left">
                <DialogTitle className="text-[15px] font-semibold">{viewing.snapshot.name ?? automation.name} · v{viewing.version}</DialogTitle>
                <DialogDescription className="text-[12.5px]">
                  {format(new Date(viewing.published_at), "MMM d, yyyy HH:mm")}{viewing.published_by ? ` · ${viewing.published_by}` : ""}
                  {viewing.version === data.live ? " · live now" : ""}
                </DialogDescription>
              </DialogHeader>
              <ol className="max-h-[65vh] space-y-4 overflow-y-auto px-6 py-5">
                <li className="flex items-center gap-2.5 text-[13px] text-foreground">
                  <TriggerMark when={flow.trigger.kind} tools={(flow.trigger.config.tools ?? []).map(t => ({ slug: t, label: t }))} />
                  {triggerDef(flow.trigger.kind)?.label ?? "No trigger"}
                </li>
                {flow.steps.map(st => (
                  <li key={st.id}>
                    <p className="flex items-center gap-2.5 text-[13px] text-foreground">
                      <StepMark type={st.type} model={st.config.model} />
                      {stepTitle(st)}
                    </p>
                    {stepDetail(st).length > 0 && (
                      <dl className="ml-[34px] mt-1.5 space-y-1">
                        {stepDetail(st).map(([k, val]) => (
                          <div key={k} className="text-[12px]">
                            <dt className="text-muted-foreground">{k}</dt>
                            <dd className={cn("whitespace-pre-wrap break-words text-foreground/85", k === "Body" || k === "Instructions" ? "rounded-md bg-foreground/[0.04] px-2 py-1.5" : "")}>{val}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </li>
                ))}
              </ol>
            </>);
          })()}
        </DialogContent>
      </Dialog>
    </div>
  );
}
