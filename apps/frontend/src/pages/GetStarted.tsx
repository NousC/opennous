// Get started — the API plan's onboarding (GET-517, GET-549), as a two-pane stepper (GET-622).
// Opened from the top bar's Get started button (or ?getstarted=1). The rail on the left lists the
// steps, each ticked off from what is actually true of the workspace (/api/onboarding/checklist),
// not from a click we remember; the pane on the right is the selected step:
//
//   1. Connect your CRM             — the 12-month import starts the moment it connects
//   2. Email and meeting notes      — personal: each person connects their own
//   3. Run your backfill            — PAY FIRST: unpaid → plan → Stripe → back here, and it starts
//   4. Connect your agent           — a key, a client, and the key's first call
//
// An invited member has no CRM step (GET-571). The dialog is LOCKED until the backfill is running:
// no click-out, no close. A workspace that has not paid and not read anything has nothing to look
// at behind it. After that it closes freely, and once every step is done the button is gone.
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Check, Loader2, Settings2, X } from "lucide-react";
import { usePlan } from "@/hooks/usePlan";
import { ClientLogo } from "@/components/connect/shared";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";
import { CONTACT_URL } from "@/config/contact";
import { SELF_SERVE_TIERS } from "@/config/plans";
import { MCP_URL, apiBaseUrl } from "@/config/agentEndpoints";
import { useOnboardingChecklist, type OnboardingChecklist } from "@/hooks/useOnboardingChecklist";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { CodeSnippet, useChosenKey, useWorkspaceKeys } from "@/components/connect/shared";
import { KEY_PLACEHOLDER, keyStatus, mcpSteps, restLookup } from "@/lib/connectSnippets";
import {
  CRMS, MAIL, NOTES, backfillCount, backfillDeferred, planFit, setupLocked, setupSteps, stepStatus, toolName,
  type BackfillPreview, type StepKey, notInCrmLine,
} from "@/lib/getStarted";

export type { BackfillPreview } from "@/lib/getStarted";

const Integrations = lazy(() => import("@/pages/Integrations"));

const apiUrl = import.meta.env.VITE_API_URL ?? "";
// Bundled logos (public/provider-logos), not a favicon service: they show on every install,
// self-host included, and tell no third party which tools a workspace uses.
const LOGO: Record<string, string> = {
  hubspot: "hubspot.svg", salesforce: "salesforce.svg", attio: "attio.svg", gmail_oauth: "gmail.svg", gmail: "gmail.svg",
  fireflies: "fireflies.svg", granola: "granola.svg", fathom: "fathom.svg",
};

const num = (n: number) => n.toLocaleString("en-US");

export function useBackfillPreview(pollMs: number) {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const workspaceId = userData?.workspace?.id ?? "";
  const [p, setP] = useState<BackfillPreview | null>(null);
  const load = useCallback(() => {
    if (!token || !workspaceId) return;
    fetch(`${apiUrl}/api/backfill/preview?workspaceId=${encodeURIComponent(workspaceId)}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null)).then((d) => d && setP(d)).catch(() => {});
  }, [token, workspaceId]);
  useEffect(() => {
    load();
    if (!pollMs) return;
    const t = setInterval(load, pollMs);
    return () => clearInterval(t);
  }, [load, pollMs]);
  return { p, load, token, workspaceId };
}

function found(p: BackfillPreview | null): string {
  const c = p?.estimate?.conversations ?? {};
  const parts = [
    c.meeting ? `${num(c.meeting)} meeting${c.meeting === 1 ? "" : "s"}` : null,
    c.call ? `${num(c.call)} call${c.call === 1 ? "" : "s"}` : null,
    c.email_thread ? `${num(c.email_thread)} email thread${c.email_thread === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "Your history";
}

export function Bar({ pct }: { pct: number }) {
  return (
    <div className="h-1 overflow-hidden rounded-full bg-muted">
      <div className="h-full rounded-full bg-foreground/80 transition-all duration-700" style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
    </div>
  );
}

const btn = "inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-[9px] px-[13px] text-[12.5px] font-medium transition-opacity disabled:opacity-50";
const primary = cn(btn, "bg-foreground text-background shadow-[0_1px_2px_rgba(20,20,18,0.2)] hover:opacity-90");
const ghost = cn(btn, "text-ink-2 hover:text-foreground");
const linkCls = "text-[12px] text-muted-foreground underline decoration-border underline-offset-2 transition-colors hover:text-foreground";

/** A tool's logo, in the 28px tile the board uses. */
function Logo({ id }: { id: string }) {
  const file = LOGO[id];
  return (
    <span className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-lg border border-hairline bg-card">
      {file
        ? <img src={`/provider-logos/${file}`} alt="" className="h-4 w-4 object-contain" />
        : <span className="text-[12px] font-semibold text-ink-2">{toolName(id).charAt(0)}</span>}
    </span>
  );
}

/** One tool as a row: logo, name, a grey line, and Connected or a Connect button. */
function ToolRow({ id, sub, connected, onConnect }: { id: string; sub: string; connected: boolean; onConnect?: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-hairline bg-card px-3.5 py-3">
      <Logo id={id} />
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{toolName(id)}</span>
        <span className="block truncate text-[12px] text-muted-foreground">{sub}</span>
      </span>
      {connected ? (
        <span className="inline-flex items-center gap-[5px] text-[12px] font-medium text-positive">
          <Check className="h-[13px] w-[13px]" strokeWidth={2.4} />Connected
        </span>
      ) : (
        <button type="button" onClick={onConnect}
          className="inline-flex h-7 items-center rounded-lg border border-border bg-card px-2.5 text-[12.5px] font-medium shadow-[0_1px_0_rgba(20,20,18,0.04)] transition-colors hover:bg-hover">
          Connect
        </button>
      )}
    </div>
  );
}

/**
 * The backfill step. Unpaid: what we found, the five bundles, and Continue to payment — the yes is
 * recorded first, so the backfill starts the moment Stripe says paid. Paid: Run backfill. Running:
 * how many conversations are read, and the bar.
 */
function BackfillStep({ c, paid, p, load, token, workspaceId, onChange }: {
  c: OnboardingChecklist; paid: boolean; p: BackfillPreview | null; load: () => void;
  token: string; workspaceId: string; onChange: () => void;
}) {
  const [credits, setCredits] = useState(SELF_SERVE_TIERS[0].credits);
  const [picked, setPicked] = useState(false);
  // Start on the recommended bundle once the estimate arrives, unless they already chose one.
  const recCredits = p?.estimate?.monthly
    ? (SELF_SERVE_TIERS.find((t) => t.credits >= p.estimate!.monthly!.credits) ?? SELF_SERVE_TIERS[SELF_SERVE_TIERS.length - 1]).credits
    : null;
  useEffect(() => { if (recCredits && !picked) setCredits(recCredits); }, [recCredits, picked]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async (win?: "last_30_days") => {
    const r = await fetch(`${apiUrl}/api/backfill/confirm`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, ...(win ? { window: win } : {}) }),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  const run = async (win?: "last_30_days") => {
    setBusy(true); setError(null);
    try {
      const r = await confirm(win);
      if (r.status === 402) {
        // Not paying: the yes is now on the job. Buy the bundle and come back to a running backfill.
        const s = await fetch(`${apiUrl}/api/billing/subscribe`, {
          method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ plan: "api", credits, return_to: "onboarding", workspace_id: workspaceId || undefined }),
        });
        const d = await s.json().catch(() => ({}));
        if (d.url) { window.location.href = d.url; return; }
        if (d.updated) { load(); onChange(); setBusy(false); return; }
        throw new Error(d.error || "Couldn't open checkout.");
      }
      if (r.status >= 400) throw new Error(r.body?.message || "Couldn't start the backfill.");
      load(); onChange();
    } catch (e) {
      setError((e instanceof Error && e.message) || "Something went wrong.");
    }
    setBusy(false);
  };

  // Back from Checkout: the webhook starts it. If the plan is live and it is still waiting (the
  // webhook has not landed yet), say yes again — the confirm is idempotent.
  useEffect(() => {
    if (!paid || !p) return;
    if (p.plan_live && (p.state === "awaiting_confirmation" || p.state === "over_allowance")) {
      confirm(p.state === "over_allowance" ? "last_30_days" : undefined).then(() => { load(); onChange(); }).catch(() => {});
    }
  }, [paid, p?.plan_live, p?.state]); // eslint-disable-line react-hooks/exhaustive-deps

  if (c.backfill.state === "none" || !p || p.state === "none") {
    return <p className="text-[13px] text-muted-foreground">Connect your tools first.</p>;
  }

  // THE PLAN AGAINST A MONTH LIKE THEIR LAST ONE (GET-682), said wherever they are in the step.
  const fit = planFit(p?.estimate?.monthly?.credits, p?.plan_credits, SELF_SERVE_TIERS);
  const upgrade = async (to: number) => {
    setBusy(true); setError(null);
    try {
      const s = await fetch(`${apiUrl}/api/billing/subscribe`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ plan: "api", credits: to, return_to: "onboarding", workspace_id: workspaceId || undefined }),
      });
      const d = await s.json().catch(() => ({}));
      if (d.url) { window.location.href = d.url; return; }
      if (!d.updated) throw new Error(d.error || "Couldn't change the plan.");
      load(); onChange();
    } catch (e) { setError((e instanceof Error && e.message) || "Something went wrong."); }
    setBusy(false);
  };
  const fitNote = fit && (
    <div className="space-y-2 rounded-lg border border-amber-300/60 bg-amber-50/60 px-3 py-2.5 text-[12.5px] text-foreground dark:border-amber-500/30 dark:bg-amber-950/20">
      <p>From your last 30 days you'll use about {num(fit.monthly)} credits a month. Your plan has {num(fit.plan)}, so reading stops before the month ends. {num(fit.rec.credits)} covers it.</p>
      <button disabled={busy} onClick={() => void upgrade(fit.rec.credits)} className="font-medium underline underline-offset-2 disabled:opacity-50">
        Move to {num(fit.rec.credits)} credits · ${fit.rec.priceUsd} a month
      </button>
    </div>
  );

  if (p.state === "running" || p.state === "done") {
    const b = backfillCount(p);
    return (
      <div className="space-y-3">
      <div className="rounded-[14px] border border-hairline p-[18px]">
        <div className="flex items-baseline gap-2">
          <span className="text-[28px] font-medium tabular-nums tracking-[-0.03em]">{num(b.read)}</span>
          <span className="text-[12px] tabular-nums text-muted-foreground">{b.of != null ? `of ${num(b.of)} conversations` : "conversations read"}</span>
          <span className="flex-1" />
          <span className="text-[12px] tabular-nums text-muted-foreground">{b.pct}%</span>
        </div>
        <div className="mt-3 h-1.5 overflow-hidden rounded-[3px] bg-muted">
          <span className="block h-full rounded-[3px] bg-foreground transition-all duration-700" style={{ width: `${Math.max(2, b.pct)}%` }} />
        </div>
      </div>
      {fitNote}
      {error && <p className="text-[12px] text-risk">{error}</p>}
      </div>
    );
  }

  if (paid && (p.plan_live || p.start_on_payment)) {
    return <div className="flex items-center gap-2 text-[13px] text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Paid. Starting your backfill…</div>;
  }

  // Started free (GET-682): the history waits for the upgrade, and the upgrade is right here.
  const deferred = backfillDeferred(c);
  // Started free and nothing else to decide yet? Free reads from today; say so, offer the upgrade.
  const startFree = async () => {
    setBusy(true); setError(null);
    try { await confirm(); load(); onChange(); }   // a 402 here parks the job for the upgrade
    catch (e) { setError((e instanceof Error && e.message) || "Something went wrong."); }
    setBusy(false);
  };

  if (p.state === "needs_support") {
    return (
      <div className="space-y-3">
        <p className="text-[13px] text-foreground">{found(p)} from the last 3 months. More than onboarding reads on its own.</p>
        <a href={CONTACT_URL} target="_blank" rel="noreferrer" className={primary}>Contact us</a>
      </div>
    );
  }

  const short = p.state === "over_allowance";
  const est = short ? p.estimate_30?.credits ?? 0 : p.estimate?.credits ?? 0;
  const conv = p.estimate?.conversations ?? {};
  // What we found, as numbers (GET-549) — the CRM's accounts and people, and the conversations in
  // the window, counted at the source before anything is read.
  const stats: [string, number][] = [
    ["Accounts", c.crm.accounts],
    ["People", p.accounts ?? 0],
    ["Emails", conv.email_thread ?? 0],
    ["Meetings", conv.meeting ?? 0],
    ...(conv.call ? [["Calls", conv.call] as [string, number]] : []),
  ];
  // The plan a month like their last one needs: the smallest bundle that covers it.
  const monthly = p.estimate?.monthly ?? null;
  const rec = monthly ? (SELF_SERVE_TIERS.find((t) => t.credits >= monthly.credits) ?? SELF_SERVE_TIERS[SELF_SERVE_TIERS.length - 1]) : null;
  const monthConv = monthly ? Object.entries(monthly.counts ?? {}).filter(([k]) => k !== "note").reduce((a, [, b]) => a + (Number(b) || 0), 0) : 0;
  return (
    <div className="space-y-4">
      <div className={cn("grid grid-cols-3 gap-2", stats.length === 5 ? "sm:grid-cols-5" : "sm:grid-cols-4")}>
        {stats.map(([label, n]) => (
          <div key={label} className="rounded-lg border border-hairline bg-card px-2.5 py-2">
            <div className="text-[16px] font-semibold tabular-nums text-foreground">{num(n)}</div>
            <div className="text-[11.5px] text-muted-foreground">{label}</div>
          </div>
        ))}
      </div>
      {notInCrmLine(p.estimate?.discovered) && (
        <p className="text-[12.5px] text-muted-foreground">{notInCrmLine(p.estimate?.discovered)}</p>
      )}
      {/* The backfill credits, said plainly (GET-682): what it needs, what is left, what we do. */}
      {short ? (
        <p className="text-[12.5px] text-foreground">
          Your last 3 months need {num(p.estimate?.credits ?? 0)} backfill credits and {num(p.estimate?.allowance ?? 0)} are left, so we read the last 30 days ({num(est)} credits). <a href={CONTACT_URL} target="_blank" rel="noreferrer" className="underline underline-offset-2">Talk to us</a> for all 3 months.
        </p>
      ) : (
        <p className="text-[12.5px] text-muted-foreground">
          Last 3 months · reading it uses {num(est)}{p.estimate?.allowance != null && <> of {num(p.estimate.allowance)}</>} free backfill credits.
        </p>
      )}
      {p.plan_live && fitNote}
      {deferred && (
        <p className="text-[12.5px] text-foreground">
          You're on Free: 500 credits a month, read from today. Your last 3 months are read the moment you upgrade.
        </p>
      )}
      {!p.plan_live && (
        <div className="space-y-1">
          {rec && !deferred && (
            <p className="mb-2 text-[12.5px] text-foreground">
              The backfill is free. From your last 30 days (~{num(monthConv)} conversations, about {num(monthly!.credits)} credits a month) we recommend {num(rec.credits)}.
            </p>
          )}
          <div className="mb-1.5 text-[12px] text-muted-foreground">Credits a month</div>
          {SELF_SERVE_TIERS.map((t) => (
            <button key={t.credits} onClick={() => { setPicked(true); setCredits(t.credits); }}
              className={cn("flex w-full items-center justify-between rounded-lg border px-3 py-1.5 text-[12.5px] tabular-nums transition-colors",
                credits === t.credits ? "border-foreground/40 bg-muted/50 text-foreground" : "border-border text-muted-foreground hover:text-foreground",
                rec?.credits === t.credits && "ring-2 ring-emerald-500/60")}>
              <span className="flex items-center gap-2">{num(t.credits)}{rec?.credits === t.credits && <span className="rounded-full bg-emerald-50 px-1.5 text-[11px] text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">Recommended</span>}</span>
              <span>${t.priceUsd} / month</span>
            </button>
          ))}
          {/* Picked a bundle smaller than their month: say so before they pay for it. */}
          {monthly && credits < monthly.credits && rec && rec.credits !== credits && (
            <p className="pt-1.5 text-[12.5px] text-amber-700 dark:text-amber-400">
              From your last 30 days you'll use about {num(monthly.credits)} credits a month. {num(credits)} runs out before the month ends; {num(rec.credits)} covers it.
            </p>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button disabled={busy} onClick={() => run(short ? "last_30_days" : undefined)} className={primary}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {p.plan_live ? (short ? "Read the last 30 days" : "Run backfill") : deferred ? "Upgrade and read it now" : "Continue to payment"}
        </button>
        {/* FREEMIUM (GET-682): pay now and read the history, or start free and read from today. */}
        {!p.plan_live && p.on_free && !deferred && (
          <button disabled={busy} onClick={() => void startFree()}
            className="text-[12.5px] text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-50">
            Start free instead
          </button>
        )}
      </div>
      {!p.plan_live && p.on_free && !deferred && (
        <p className="text-[12px] text-muted-foreground">Free: 500 credits a month, read from today. The backfill runs when you upgrade.</p>
      )}
      {error && <p className="text-[12px] text-risk">{error}</p>}
    </div>
  );
}

// ── Connect your agent ───────────────────────────────────────────────────────

type AgentClient = "claude" | "cursor" | "codex" | "api";
const CLIENTS: { id: AgentClient; label: string }[] = [
  { id: "claude", label: "Claude Code" },
  { id: "cursor", label: "Cursor" },
  { id: "codex",  label: "Codex" },
  { id: "api",    label: "REST API" },
];

/** The command for a client, from the same snippets the Connect dialogs use, and the line under
 *  it. A key made in this dialog goes into the command in place of the pk_… placeholder. */
function agentSnippet(client: AgentClient, key: string | null): { code: string; hint: string } {
  if (client === "api") {
    const code = restLookup("curl", apiBaseUrl());
    return { code: key ? `export NOUS_API_KEY=${key}\n${code}` : code, hint: "Your key as a Bearer token" };
  }
  const steps = mcpSteps(client, MCP_URL);
  const first = steps.find((s) => s.code) ?? steps[0];
  const next = steps.find((s) => s !== first);
  const code = first.code ?? "";
  return { code: key ? code.split(KEY_PLACEHOLDER).join(key) : code, hint: next?.label ?? first.label };
}

function AgentStep({ newKey, client, setClient, locked, onManage }: {
  newKey: string | null; client: AgentClient; setClient: (c: AgentClient) => void; locked: boolean; onManage: () => void;
}) {
  const s = agentSnippet(client, newKey);
  return (
    <div>
      <div role="radiogroup" aria-label="Client" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {CLIENTS.map((c) => {
          const on = c.id === client;
          return (
            <button key={c.id} type="button" role="radio" aria-checked={on} onClick={() => setClient(c.id)}
              className={cn(
                "flex min-w-0 flex-col items-start gap-2.5 rounded-xl border bg-card p-3 text-left transition-colors duration-fast",
                on ? "border-foreground/25 bg-hover" : "border-border hover:border-foreground/20",
              )}>
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-card shadow-[inset_0_0_0_1px_hsl(var(--border)/0.7)]"><ClientLogo id={c.id} size={16} /></span>
              <span className="text-[12.5px] font-medium">{c.label}</span>
            </button>
          );
        })}
      </div>
      <CodeSnippet code={s.code} className="mt-4" />
      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
        <span>{s.hint}</span>
        {newKey && <span className="text-foreground">Key copied · shown once</span>}
        {!locked && <button type="button" onClick={onManage} className={linkCls}>Manage keys</button>}
      </div>
    </div>
  );
}

// ── The dialog ───────────────────────────────────────────────────────────────

const HEAD: Record<StepKey, { title: string; sub: string }> = {
  crm: { title: "Connect your CRM", sub: "Your accounts, deals and activity from the last 12 months." },
  tools: { title: "Connect your email and meeting notes", sub: "What was said: threads and calls with your accounts." },
  backfill: { title: "Run your backfill", sub: "Nous reads your past conversations so the record starts full." },
  agent: { title: "Connect your agent", sub: "Work your accounts from Claude Code, any MCP client, or your own code." },
};

function GetStartedPanel({ c, paid, locked, open, onConnect, onClose, onChange }: {
  c: OnboardingChecklist; paid: boolean; locked: boolean; open: boolean;
  onConnect: (id: string) => void; onClose: () => void; onChange: () => void;
}) {
  const navigate = useNavigate();
  const { userData } = useAuth();
  const { p, load, token, workspaceId } = useBackfillPreview(paid ? 3_000 : 10_000);
  // The live line on the agent step polls the keys the way the Connect over MCP dialog does.
  const { data: keys, refetch: refetchKeys } = useWorkspaceKeys(open ? 5_000 : false);
  const { key: watched, setKey: watchKey } = useChosenKey(keys);
  const [client, setClient] = useState<AgentClient>("claude");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);

  const steps = setupSteps(c);
  const doneCount = steps.filter((s) => s.done).length;
  const firstOpen = steps.find((s) => !s.done)?.key ?? "agent";
  const [sel, setSel] = useState<StepKey>(paid ? "backfill" : firstOpen);
  // Move on by itself when the open step gets done (a connect landing, a payment arriving).
  const [lastFirst, setLastFirst] = useState(firstOpen);
  useEffect(() => { if (firstOpen !== lastFirst) { setLastFirst(firstOpen); setSel(firstOpen); } }, [firstOpen, lastFirst]);
  const idx = Math.max(0, steps.findIndex((s) => s.key === sel));
  const step = steps[idx];
  // On a phone the rail is a strip that scrolls sideways: keep the selected step in view.
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    // Scroll the strip only (scrollIntoView would scroll the page behind the dialog too).
    const nav = navRef.current;
    const on = nav?.querySelector<HTMLElement>('[aria-current="step"]');
    if (!nav || !on || nav.scrollWidth <= nav.clientWidth) return;
    nav.scrollLeft = Math.max(0, on.offsetLeft - nav.offsetLeft - 8);
  }, [sel]);

  // Made right here, shown once, and on the clipboard (GET-549, GET-622).
  const createKey = async () => {
    setCreating(true); setKeyError(null);
    try {
      const r = await fetch(`${apiUrl}/api/workspace/api-keys`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Get started", workspace_id: workspaceId, capability: "read_write" }),
      });
      const d = await r.json().catch(() => ({}));
      if (!d.key) throw new Error(d.error || "Couldn't create a key.");
      setNewKey(d.key);
      const newId = d.id ?? d.api_key?.id ?? d.apiKey?.id;
      if (newId) watchKey(newId);
      try { await navigator.clipboard.writeText(d.key); toast.success("Key copied"); } catch { /* it is in the command anyway */ }
      refetchKeys(); onChange();
    } catch (e) {
      setKeyError((e instanceof Error && e.message) || "Couldn't create a key.");
    }
    setCreating(false);
  };

  const toIntegrations = locked ? null : () => { onClose(); navigate("/integrations"); };
  const status = keyStatus(watched?.last_used_at);
  const connected = status.connected || c.api_key.used;

  const body: Record<StepKey, React.ReactNode> = {
    crm: c.crm.done ? (
      <>
        <ToolRow id={c.crm.provider ?? "crm"} connected
          sub={c.crm.imported ? `${num(c.crm.accounts)} accounts imported` : "Importing"} />
        {toIntegrations && <div className="mt-2.5"><button type="button" onClick={toIntegrations} className={linkCls}>Use a different CRM</button></div>}
      </>
    ) : (
      <div className="flex flex-col gap-2">
        {CRMS.map(([id]) => <ToolRow key={id} id={id} sub="CRM" connected={false} onConnect={() => onConnect(id)} />)}
      </div>
    ),
    tools: (
      <>
        <div className="flex flex-col gap-2">
          {(c.mail.providers ?? []).map((id) => <ToolRow key={`m-${id}`} id={id} sub="Email" connected />)}
          {(c.notes.providers ?? []).map((id) => <ToolRow key={`n-${id}`} id={id} sub="Meeting notes" connected />)}
          {!c.mail.done && MAIL.map(([id]) => <ToolRow key={id} id={id} sub="Email" connected={false} onConnect={() => onConnect(id)} />)}
          {!c.notes.done && NOTES.map(([id]) => <ToolRow key={id} id={id} sub="Meeting notes" connected={false} onConnect={() => onConnect(id)} />)}
        </div>
        {toIntegrations && c.mail.done && c.notes.done && (
          <div className="mt-2.5"><button type="button" onClick={toIntegrations} className={linkCls}>Add another</button></div>
        )}
      </>
    ),
    backfill: <BackfillStep c={c} paid={paid} p={p} load={load} token={token} workspaceId={workspaceId} onChange={onChange} />,
    agent: (
      <>
        <AgentStep newKey={newKey} client={client} setClient={setClient} locked={locked}
          onManage={() => { onClose(); navigate("/keys"); }} />
        {keyError && <p className="mt-2 text-[12px] text-risk">{keyError}</p>}
      </>
    ),
  };

  const wsName = userData?.workspace?.name ?? "";
  return (
    <div className="flex h-full min-h-0 flex-col sm:flex-row">
      {/* The rail. On a phone it folds into a strip across the top. */}
      <aside className="flex flex-none flex-col border-b border-hairline bg-muted/50 px-3.5 pb-3 pt-4 sm:w-[260px] sm:border-b-0 sm:border-r sm:pb-[18px] sm:pt-[22px]">
        <div className="flex items-center gap-[9px] px-2">
          <span aria-hidden className="inline-flex h-6 w-6 flex-none items-center justify-center rounded-[7px] bg-[#FF5C00] text-[12px] font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.28),0_1px_2px_rgba(255,92,0,0.3)]">
            {(wsName.trim().charAt(0) || "N").toUpperCase()}
          </span>
          <DialogTitle className="flex-1 text-[14px] font-semibold leading-none tracking-[-0.01em]">Set up Nous</DialogTitle>
          {!locked && (
            <button type="button" onClick={onClose} aria-label="Close" className="inline-flex h-7 w-7 items-center justify-center rounded-[7px] text-muted-foreground hover:bg-hover hover:text-foreground sm:hidden">
              <X className="h-[15px] w-[15px]" strokeWidth={1.7} />
            </button>
          )}
        </div>
        <DialogDescription className="sr-only">The steps to set up your workspace.</DialogDescription>
        <div className="px-2 pb-3 pt-3 sm:pb-[18px] sm:pt-3.5">
          <div className="flex gap-1">
            {steps.map((s) => <span key={s.key} className={cn("h-1 flex-1 rounded-sm", s.done ? "bg-foreground" : "bg-border")} />)}
          </div>
          <div className="mt-2 text-[12px] tabular-nums text-muted-foreground">{doneCount} of {steps.length} done</div>
        </div>
        <nav ref={navRef} aria-label="Setup steps" className="-mx-1 flex gap-0.5 overflow-x-auto px-1 sm:mx-0 sm:flex-col sm:overflow-visible sm:px-0">
          {steps.map((s, i) => {
            const on = s.key === sel;
            return (
              <button key={s.key} type="button" aria-current={on ? "step" : undefined} onClick={() => setSel(s.key)}
                className={cn(
                  "flex flex-none items-start gap-[11px] rounded-[10px] px-2.5 py-[9px] text-left transition-colors sm:w-full",
                  on ? "bg-card shadow-[0_0_0_1px_hsl(var(--border)),0_1px_2px_rgba(20,20,18,0.05),0_4px_10px_-6px_rgba(20,20,18,0.12)]" : "hover:bg-hover",
                )}>
                <span className={cn(
                  "inline-flex h-5 w-5 flex-none items-center justify-center rounded-full text-[10.5px] font-semibold",
                  s.done ? "bg-foreground text-background" : on ? "border-[1.5px] border-foreground bg-card text-foreground" : "border-[1.5px] border-border bg-card text-muted-foreground",
                )}>
                  {s.done ? <Check className="h-2.5 w-2.5" strokeWidth={3.4} /> : i + 1}
                </span>
                <span className="flex min-w-0 flex-col leading-[1.3]">
                  <span className="whitespace-nowrap text-[13px] font-medium">{s.title}</span>
                  <span className="hidden truncate text-[11.5px] text-muted-foreground sm:block">{stepStatus(s.key, c, p)}</span>
                </span>
              </button>
            );
          })}
        </nav>
        <span className="hidden flex-1 sm:block" />
        {!locked && (
          <button type="button" onClick={onClose} className="hidden px-2 text-left text-[12px] text-muted-foreground hover:text-foreground sm:block">Finish later</button>
        )}
      </aside>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="hidden h-10 justify-end px-3 pt-3 sm:flex">
          {!locked && (
            <button type="button" onClick={onClose} aria-label="Close" className="inline-flex h-7 w-7 items-center justify-center rounded-[7px] text-muted-foreground hover:bg-hover hover:text-foreground">
              <X className="h-[15px] w-[15px]" strokeWidth={1.7} />
            </button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-5 text-[13px] sm:px-9 sm:pt-0">
          <div className="text-[12px] text-muted-foreground">Step {idx + 1}</div>
          <h3 className="mb-1.5 mt-1 text-[20px] font-semibold tracking-[-0.02em]">{HEAD[step.key].title}</h3>
          <p className="mb-[22px] text-[13px] text-muted-foreground">{HEAD[step.key].sub}</p>
          {body[step.key]}
        </div>
        <div className="flex flex-none items-center gap-2.5 border-t border-hairline px-5 py-4 sm:pl-9 sm:pr-5">
          {step.key === "agent" && (
            <span className="inline-flex min-w-0 items-center gap-[9px] text-[12px] text-muted-foreground" aria-live="polite">
              <span aria-hidden className={cn("h-2 w-2 flex-none rounded-full",
                connected ? "bg-positive shadow-[0_0_0_3px_hsl(var(--positive)/0.18)]" : "animate-pulse bg-warning-dot shadow-[0_0_0_3px_hsl(var(--warning-dot)/0.18)]")} />
              <span className="truncate">{status.connected ? status.text : connected ? "Connected" : "Waiting for the first call"}</span>
            </span>
          )}
          <span className="flex-1" />
          <button type="button" className={ghost} disabled={idx === 0} onClick={() => setSel(steps[Math.max(0, idx - 1)].key)}>Back</button>
          {step.key === "agent" ? (
            <button type="button" className={primary} disabled={creating} onClick={createKey}>
              {creating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Create an API key
            </button>
          ) : (
            <button type="button" className={primary} onClick={() => setSel(steps[Math.min(steps.length - 1, idx + 1)].key)}>Continue</button>
          )}
        </div>
      </section>
    </div>
  );
}

/**
 * Get started, as a button and a dialog (GET-517, GET-549, GET-622). Locked open until the
 * backfill runs; after that it opens once a session until every step is done, and then the
 * button is gone. `segments` (the API-plan top bar, GET-621): one small bar per step.
 */
export function GetStartedButton({ variant = "pill" }: { variant?: "pill" | "segments" } = {}) {
  // A self-hosted install has no Get started: no plan to buy, and what decides whether it works
  // (an AI key, the OAuth apps, email) is the operator's nous.env, which Instance setup reads.
  // So the same spot opens that page instead, and nothing pops up on first visit (GET-837).
  const { selfHosted } = usePlan();
  if (selfHosted) return <InstanceSetupButton />;
  return <CloudGetStartedButton variant={variant} />;
}

function InstanceSetupButton() {
  const navigate = useNavigate();
  return (
    <button onClick={() => navigate("/settings?section=instance")}
      className="inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-border bg-card px-2 text-[12.5px] font-medium text-foreground shadow-[0_1px_0_rgba(20,20,18,0.04)] transition-colors duration-fast hover:bg-hover sm:px-2.5">
      <Settings2 className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
      <span className="hidden sm:inline">Instance setup</span>
    </button>
  );
}

function CloudGetStartedButton({ variant }: { variant: "pill" | "segments" }) {
  const { checklist: c, loaded, complete, reload } = useOnboardingChecklist(5_000);
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState(false);
  const [paid, setPaid] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);
  const locked = !!c && setupLocked(c);

  useEffect(() => {
    if (!loaded || complete) return;
    const asked = params.get("getstarted") === "1";
    if (params.get("paid") === "1") setPaid(true);
    let seen = false;
    try { seen = sessionStorage.getItem("getstarted.shown") === "1"; } catch { /* private mode */ }
    if (asked || !seen || locked) {
      setOpen(true);
      try { sessionStorage.setItem("getstarted.shown", "1"); } catch { /* ignore */ }
      if (asked) { params.delete("getstarted"); params.delete("paid"); setParams(params, { replace: true }); }
    }
  }, [loaded, complete, locked]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!loaded || complete || !c) return null;
  const marks = setupSteps(c).map((s) => s.done);
  const done = marks.filter(Boolean).length;

  return (
    <>
      {variant === "segments" ? (
        <button onClick={() => setOpen(true)} aria-label={`Get started, ${done} of ${marks.length} done`}
          className="inline-flex h-7 shrink-0 items-center gap-[7px] whitespace-nowrap rounded-lg border border-border bg-card px-2 text-[12.5px] font-medium text-foreground shadow-[0_1px_0_rgba(20,20,18,0.04)] transition-colors duration-fast hover:bg-hover sm:px-2.5">
          <span className="inline-flex gap-0.5" aria-hidden>
            {marks.map((m, i) => <span key={i} className={`h-1 w-2 rounded-[2px] ${m ? "bg-foreground" : "bg-border"}`} />)}
          </span>
          <span className="hidden sm:inline">Get started</span>
        </button>
      ) : (
        <button onClick={() => setOpen(true)}
          className="inline-flex h-8 items-center gap-2 rounded-full border border-border bg-background px-3.5 text-[12.5px] font-medium text-foreground shadow-sm transition-colors hover:bg-muted/40">
          Get started <span className="tabular-nums text-muted-foreground">{done}/{marks.length}</span>
        </button>
      )}
      <Dialog open={open && !connecting} onOpenChange={(o) => { if (!o && locked) return; setOpen(o); }}>
        <DialogContent hideCloseButton
          className="flex h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] sm:h-[min(580px,calc(100dvh-2rem))] max-w-[860px] flex-col gap-0 overflow-hidden rounded-2xl border-0 outline-none bg-card p-0 shadow-[0_0_0_1px_rgba(20,20,18,0.08),0_32px_80px_-16px_rgba(20,20,18,0.40),0_10px_20px_-10px_rgba(20,20,18,0.14)] sm:rounded-2xl"
          // Focus the dialog itself on open, not the first step in the rail, which would read as selected.
          onOpenAutoFocus={(e) => { e.preventDefault(); (e.currentTarget as HTMLElement | null)?.focus(); }}
          onPointerDownOutside={(e) => { if (locked) e.preventDefault(); }}
          onEscapeKeyDown={(e) => { if (locked) e.preventDefault(); }}>
          <GetStartedPanel c={c} paid={paid} locked={locked} open={open && !connecting} onConnect={(id) => setConnecting(id)}
            onClose={() => { if (!locked) setOpen(false); }} onChange={reload} />
        </DialogContent>
      </Dialog>
      {/* The real connect flow opens its own dialog; ours steps aside and comes back after. */}
      {connecting && (
        <Suspense fallback={null}>
          <Integrations embedded chromeless connectProvider={connecting} onClose={() => { reload(); setTimeout(() => setConnecting(null), 350); }} />
        </Suspense>
      )}
    </>
  );
}
