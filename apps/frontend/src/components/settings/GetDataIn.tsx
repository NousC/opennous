// Settings → Instance setup → "Backfill" (self-host, GET-848). Self-host has no setup
// pop-up, so this is where an operator is walked through the three things that fill the graph, in
// the order that works: the CRM first (its 12-month import starts when it connects, and every
// conversation is filed onto its accounts), then email and meeting notes, then the revenue
// backfill, which reads the history with the install's own AI models. Everything is read live from
// /api/onboarding/checklist and /api/backfill/preview, the same reads the Cloud pop-up used.
import { useState } from "react";
import { Link } from "react-router-dom";
import { Check, Loader2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useOnboardingChecklist } from "@/hooks/useOnboardingChecklist";
import { useBackfillPreview, Bar } from "@/pages/GetStarted";
import { SettingsGroup } from "@/components/settings/SettingsKit";
import { backfillCount, toolName } from "@/lib/getStarted";
import { cn } from "@/lib/utils";

const apiUrl = import.meta.env.VITE_API_URL ?? "";
const num = (n: number) => n.toLocaleString("en-US");

type Job = { tier: string; model: string; route: "anthropic" | "openai_compatible" };

/** "312 meetings, 1,840 email threads and 40 calls", from the preview's counts. */
function foundLine(conv: Record<string, number> | undefined): string | null {
  const c = conv ?? {};
  const parts = [
    c.meeting ? `${num(c.meeting)} meeting${c.meeting === 1 ? "" : "s"}` : null,
    c.email_thread ? `${num(c.email_thread)} email thread${c.email_thread === 1 ? "" : "s"}` : null,
    c.call ? `${num(c.call)} call${c.call === 1 ? "" : "s"}` : null,
  ].filter(Boolean) as string[];
  if (!parts.length) return null;
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** "DeepSeek v4.1 Flash and GLM 5.2 on OpenRouter", from the jobs Instance setup reads. */
function modelsLine(jobs: Job[], providerLabel: string): string {
  const pretty = (m: string) => m.replace(/^[a-z0-9-]+\//, "");
  const reading = jobs.find((j) => j.tier === "extraction"), writing = jobs.find((j) => j.tier === "writing");
  const names = [...new Set([reading?.model, writing?.model].filter(Boolean) as string[])].map(pretty);
  const where = [reading, writing].some((j) => j?.route === "openai_compatible") ? ` on ${providerLabel}` : " on Anthropic";
  return `${names.join(" and ")}${where}`;
}

function Step({ n, done, title, children, action }: { n: number; done: boolean; title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-lg px-2 py-2.5">
      <span className={cn(
        "mt-px inline-flex h-5 w-5 flex-none items-center justify-center rounded-full text-[11px] font-medium",
        done ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" : "border border-border text-muted-foreground",
      )}>
        {done ? <Check className="h-3 w-3" strokeWidth={2.6} /> : n}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-foreground">{title}</p>
        {children && <div className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">{children}</div>}
      </div>
      {action && <div className="flex-none">{action}</div>}
    </div>
  );
}

const btn = "inline-flex h-7 items-center rounded-lg border border-border bg-card px-2.5 text-[12.5px] font-medium text-foreground hover:bg-hover";
const primary = "inline-flex h-7 items-center gap-1.5 rounded-lg bg-foreground px-3 text-[12.5px] font-medium text-background hover:opacity-90 disabled:opacity-50";

export function GetDataIn({ jobs, providerLabel }: { jobs: Job[]; providerLabel: string }) {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const workspaceId = (userData as { workspace?: { id?: string } } | null)?.workspace?.id ?? "";
  const { checklist: c, reload } = useOnboardingChecklist(5_000);
  const { p, load } = useBackfillPreview(5_000);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!c) return null;
  const crmName = c.crm.provider ? toolName(c.crm.provider) : "CRM";
  const sources = [...(c.mail.providers ?? []), ...(c.notes.providers ?? [])].map(toolName);
  const state = p?.state ?? (c.backfill.state === "running" ? "running" : c.backfill.state === "done" ? "done" : "none");
  const running = state === "running", done = state === "done";
  const hasSources = c.crm.done || sources.length > 0;
  const found = foundLine(p?.estimate?.conversations);
  const { read, of, pct } = backfillCount(p);

  const start = async () => {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`${apiUrl}/api/backfill/confirm`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.message || body?.error || "Couldn't start the backfill.");
      setConfirming(false); load(); reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start the backfill.");
    }
    setBusy(false);
  };

  return (
    <SettingsGroup title="Backfill">
      <Step n={1} done={c.crm.done} title={c.crm.done ? `${crmName} connected` : "Connect your CRM"}
        action={!c.crm.done && <Link to="/company-sources" className={btn}>Connect</Link>}>
        {c.crm.done
          ? (c.crm.imported ? `${num(c.crm.accounts)} accounts imported from the last 12 months.` : <span className="inline-flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" />Importing your accounts, deals and activity…</span>)
          : "HubSpot, Salesforce or Attio. Its last 12 months import the moment it connects, and every conversation is filed onto its accounts."}
      </Step>

      <Step n={2} done={c.mail.done && c.notes.done} title="Connect email and meeting notes"
        action={!(c.mail.done && c.notes.done) && <Link to="/integrations" className={btn}>Connect</Link>}>
        {sources.length ? `${sources.join(", ")} connected.` : "Gmail, and your notetaker: Fireflies, Granola or Fathom. Each person connects their own."}
      </Step>

      <Step n={3} done={done} title="Run the revenue backfill"
        action={!running && !done && !confirming && (
          <button type="button" className={primary} disabled={!c.crm.done || !hasSources} onClick={() => setConfirming(true)}>Run backfill</button>
        )}>
        {done ? "Done. Your history is read and filed onto its accounts."
          : running ? (
            <div className="mt-1.5 max-w-[360px] space-y-1.5">
              <Bar pct={pct} />
              <span>Reading your history… {of ? `${num(read)} of ${num(of)}` : `${num(read)} read`}</span>
            </div>
          )
          : !c.crm.done ? "Connect your CRM first: the backfill files every conversation onto its account."
          : confirming ? (
            <div className="mt-1.5 space-y-2 rounded-lg border border-border/70 bg-background p-3 text-[12.5px] text-foreground">
              <p>{found ? `Found ${found} from the last 12 months.` : "Reads the last 12 months from your connected tools."}</p>
              <p className="text-muted-foreground">
                This reads each one with your AI models ({modelsLine(jobs, providerLabel)}). Make sure your provider account has enough credit.
              </p>
              {error && <p className="text-destructive">{error}</p>}
              <div className="flex gap-2 pt-0.5">
                <button type="button" className={primary} disabled={busy} onClick={start}>
                  {busy && <Loader2 className="h-3 w-3 animate-spin" />}Start backfill
                </button>
                <button type="button" className={btn} disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
              </div>
            </div>
          )
          : "Reads the last 12 months of email, meetings and calls, and fills every account with what was said."}
      </Step>
    </SettingsGroup>
  );
}
