// Settings → Instance setup → "Backfill" (self-host, GET-848, GET-851). Self-host has no setup
// pop-up, so this is where an operator is walked through what fills the graph, in the order that
// works best: the CRM first (its records import when it connects, and conversations are filed onto
// its accounts), then email and meeting notes, then the revenue backfill, which reads their
// history with the install's own AI models. The CRM is recommended, not required: the backfill
// runs on email and meeting notes alone. What it reads is exactly BACKFILL_SOURCES; Granola is not
// among them, it syncs on its own. Everything is read live from
// /api/onboarding/checklist and /api/backfill/preview, the same reads the Cloud pop-up used.
import { useState } from "react";
import { Link } from "react-router-dom";
import { Check, Loader2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useOnboardingChecklist } from "@/hooks/useOnboardingChecklist";
import { useBackfillPreview, Bar } from "@/pages/GetStarted";
import { SettingsGroup } from "@/components/settings/SettingsKit";
import { backfillCount, providerPauseLine, toolName } from "@/lib/getStarted";
import { cn } from "@/lib/utils";

const apiUrl = import.meta.env.VITE_API_URL ?? "";
const num = (n: number) => n.toLocaleString("en-US");

// The tools the backfill reads history from (contactHistoryEnricher on the worker). Granola, Fellow
// and RingCentral are not among them: Granola syncs every 15 minutes, 90 days back, by itself.
const BACKFILL_SOURCES = new Set(["gmail", "gmail_oauth", "google_calendar", "fireflies", "fathom", "calendly", "cal_com", "slack", "linkedin", "instantly"]);

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
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  if (!c) return null;
  const crmName = c.crm.provider ? toolName(c.crm.provider) : "CRM";
  const sources = [...(c.mail.providers ?? []), ...(c.notes.providers ?? [])].map(toolName);
  const state = p?.state ?? (c.backfill.state === "running" ? "running" : c.backfill.state === "done" ? "done" : "none");
  const providerIds = [...(c.mail.providers ?? []), ...(c.notes.providers ?? [])];
  const readable = providerIds.filter((id) => BACKFILL_SOURCES.has(id));
  const granolaOnly = providerIds.includes("granola") && readable.length === 0;
  // A finished backfill and a new one waiting: a tool was connected since, and its history is unread.
  const newSource = !!p?.ran_before && (p?.state === "awaiting_confirmation" || p?.state === "over_allowance");
  const windowDays = p?.window_days ?? 90;
  const running = state === "running", done = state === "done" && !newSource;
  const paused = state === "paused_provider";
  const importState = c.crm.import?.state ?? (c.crm.imported ? "done" : "none");
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

  // Run the CRM import again after it failed or was interrupted (GET-853).
  const retryImport = async () => {
    setRetrying(true); setRetryError(null);
    try {
      const r = await fetch(`${apiUrl}/api/crm/import/retry`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.message || body?.error || "Couldn't restart the import.");
      reload();
    } catch (e) {
      setRetryError(e instanceof Error ? e.message : "Couldn't restart the import.");
    }
    setRetrying(false);
  };

  // Ask the worker to try the provider now rather than at its next 5-minute probe (GET-852).
  const resume = async () => {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`${apiUrl}/api/backfill/resume`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.message || body?.error || "Couldn't resume the backfill.");
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't resume the backfill.");
    }
    setBusy(false);
  };

  return (
    <SettingsGroup title="Backfill">
      <Step n={1} done={c.crm.done && importState !== "failed"} title={c.crm.done ? `${crmName} connected` : "Connect your CRM (recommended first)"}
        action={!c.crm.done ? <Link to="/company-sources" className={btn}>Connect</Link>
          : importState === "failed" && (
            <button type="button" className={btn} disabled={retrying} onClick={retryImport}>
              {retrying && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}Retry import
            </button>
          )}>
        {c.crm.done
          ? (importState === "failed" ? (
              <span className="block space-y-0.5">
                <span className="block text-destructive">The import didn't finish{c.crm.accounts ? ` (${num(c.crm.accounts)} accounts so far)` : ""}.</span>
                {c.crm.import?.error && <span className="block break-words">{c.crm.import.error}</span>}
                {retryError && <span className="block text-destructive">{retryError}</span>}
              </span>
            )
            : importState === "running" || !c.crm.imported ? (
              <span className="inline-flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" />
                Importing your accounts, deals and activity…{c.crm.accounts ? ` ${num(c.crm.accounts)} accounts so far.` : ""}
              </span>
            )
            : `${num(c.crm.accounts)} accounts imported.${c.crm.import?.partial ? " A few records didn't import; the nightly sync tries them again." : ""}`)
          : "HubSpot, Salesforce or Attio. Its records import when it connects (HubSpot: the last 12 months), so every conversation lands on the right account."}
      </Step>

      <Step n={2} done={c.mail.done && c.notes.done} title="Connect email and meeting notes"
        action={!(c.mail.done && c.notes.done) && <Link to="/integrations" className={btn}>Connect</Link>}>
        {sources.length ? `${sources.join(", ")} connected.` : "Gmail, and your notetaker: Fireflies, Granola or Fathom. Each person connects their own."}
        {providerIds.includes("granola") && <> Granola syncs by itself every 15 minutes, going back 90 days.</>}
      </Step>

      <Step n={3} done={done} title={newSource ? "Run the backfill for your new tool" : "Run the revenue backfill"}
        action={paused ? (
          <button type="button" className={btn} disabled={busy || p?.resume_requested} onClick={resume}>
            {(busy || p?.resume_requested) && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}Resume now
          </button>
        ) : !running && !done && !confirming && (
          <button type="button" className={primary} disabled={readable.length === 0} onClick={() => setConfirming(true)}>
            {newSource ? "Run again" : "Run backfill"}
          </button>
        )}>
        {done ? "Done. Your history is read and filed onto its accounts. Connect a new tool and this offers to read its history too."
          : paused ? (
            <div className="mt-1 space-y-1">
              <p className="text-foreground">Paused. {providerPauseLine(p?.provider_error)}</p>
              {p?.provider_error?.message && <p className="break-words font-mono text-[11px]">{p.provider_error.message}</p>}
              {error && <p className="text-destructive">{error}</p>}
            </div>
          )
          : running ? (
            <div className="mt-1.5 max-w-[360px] space-y-1.5">
              <Bar pct={pct} />
              <span>Reading your history… {of ? `${num(read)} of ${num(of)}` : `${num(read)} read`}</span>
            </div>
          )
          : readable.length === 0 ? (granolaOnly
            ? "Nothing for the backfill to read yet: Granola brings in its own meetings. Connect Gmail, Fireflies or Fathom to backfill their history."
            : "Connect Gmail, Fireflies or Fathom first: the backfill reads their history.")
          : confirming ? (
            <div className="mt-1.5 space-y-2 rounded-lg border border-border/70 bg-background p-3 text-[12.5px] text-foreground">
              <p>{found ? `Found ${found}.` : "Reads the history of your connected tools."}</p>
              <p className="text-muted-foreground">
                Email and calendar go back {windowDays} days; Fireflies and Fathom meetings as far back as they hold.
                {!c.crm.done && " Without a CRM, people and companies are created from the conversations themselves."}
              </p>
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
          : newSource ? `You connected ${readable.map(toolName).join(", ")} since the last backfill. Run it again to read the new history; what was already read is skipped.`
          : `Reads ${readable.map(toolName).join(", ")}: email and calendar from the last ${windowDays} days, meetings as far back as each tool holds.${c.crm.done ? "" : " Tip: connect your CRM first so every conversation lands on the right account."}`}
      </Step>
    </SettingsGroup>
  );
}
