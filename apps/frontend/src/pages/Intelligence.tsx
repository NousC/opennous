import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { RefreshCw, ChevronRight, Trash2, History, Info, Plus, ArrowLeft, FileText } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { PageHeader } from "@/components/ui/page-header";
import { AgentSetupHint } from "@/components/AgentSetupHint";

// Intelligence — your living ICP.
//
// The page answers one human question, top to bottom:
//   1. Who is my ideal customer?        → "Your ideal customer" (the Scorecard, as plain sentences)
//   2. How sure are you?                → "Confidence" (calibration, stated honestly)
//   3. What did you learn?              → "What I learned" (the loop's recent adjustments)
//   4. Who do I act on?                 → "Who to act on" (attention + top-scored open accounts)
//
// Everything underneath — observations, claims, the self-healing queue, worker
// runs — is real but it is *machinery*, not the answer. It lives in the
// "Under the hood" drawer for when you want proof the loop ran.
//
// Backed by /api/mind/substrate (the v2 substrate, stage by stage),
// /api/mind/scorecard (the model) and /api/mind/scorecard/runs (what changed).

const apiUrl = import.meta.env.VITE_API_URL ?? "";

interface Substrate {
  observations: { total: number; last_7d: number; by_source: { source: string; count: number }[] };
  claims: { total: number; freshness: Record<string, number>; epistemic: Record<string, number> };
  recompute: { pending: number };
  predictions: { total: number; open: number; resolved: number; won?: number; lost?: number; by_kind: Record<string, number> };
  calibration: {
    resolved: number;
    gap: number | null;
    high: { count: number; avg_outcome: number | null };
    low: { count: number; avg_outcome: number | null };
    trend: { week: string; n: number; gap: number | null }[];
  };
  top_signals: { key: string; label: string; weight: number; fires: number; hits: number; hit_rate: number; lift?: number | null; sample?: number }[];
  recent_predictions: {
    id: string; entity_id: string; name: string | null; company: string | null; email: string | null;
    score: number | null; fit: boolean | null;
    predicted_at: string; resolved_at: string | null;
    outcome_score: number | null; disposition: string | null; replied: boolean | null;
    fired: string[];
  }[];
  misses: Substrate["recent_predictions"];
  attention: {
    kind: string; entity_id: string; entity_name: string | null;
    what: string; suggested_action: string; age_days: number;
  }[];
}
interface Signal {
  id: string; key: string; label: string; weight: number; coverage: number; active: boolean;
}
interface IcpFact {
  id: string; category: string; content: string; created_at?: string | null;
  confidence?: number; subject?: string | null; reaffirmed_at?: string | null; source?: string;
  // The file this section was synced from (e.g. "context/icp.md"), when the ICP
  // lives in the user's own repo and Nous mirrors it. Present → read-only here.
  source_path?: string | null;
}

// A fact is worth revisiting if it was AI-drafted and never confirmed
// (confidence < 1), or if it has gone untouched for a while. Confirming resets
// the clock (reaffirmed_at) and raises confidence to 1.
const STALE_DAYS = 90;
function reviewReason(f: IcpFact): string | null {
  if (typeof f.confidence === "number" && f.confidence < 1) return "AI-drafted, not confirmed";
  const stamp = f.reaffirmed_at || f.created_at;
  if (stamp) {
    const days = Math.floor((Date.now() - new Date(stamp).getTime()) / 86400000);
    if (days >= STALE_DAYS) return `${days} days since last confirmed`;
  }
  return null;
}
interface ScorecardRun {
  id: string;
  target: string | null;
  steps: unknown;
  gap_before: number | null;
  gap_after: number | null;
  signal_count: number | null;
  note: string | null;
  created_at: string;
}
// A GTM fact that was superseded — the workspace sharpening its own profile.
interface ContextChange {
  category: string; from: string; to: string; at: string; source: string;
}
// The curated GTM context sections, in document order. The first six feed the
// ICP scoring model; "GTM Motion" and "Notes" are agent-readable context only.
// Curated (not open-ended) so the context reads as a tidy one-pager.
const ICP_CATEGORIES = ["ICP", "Market", "Product", "Pricing", "Competitors", "Positioning", "GTM Motion", "Notes"];

const fmtGap = (g: number | null | undefined) =>
  g == null ? "—" : `${g > 0 ? "+" : ""}${g.toFixed(2)}`;

// ─── Building blocks ─────────────────────────────────────────────────────────

function Card({ label, right, children }: {
  label: string; right?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-background overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 bg-muted/50 border-b border-border">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">{label}</span>
        {right}
      </div>
      {children}
    </div>
  );
}

// Sparkline for the calibration trend.
function Sparkline({ values, width = 96, height = 24 }: { values: (number | null)[]; width?: number; height?: number }) {
  const points = values.filter((v): v is number => v != null);
  if (points.length < 2) return <span className="text-muted-foreground/50 text-[11px]">no trend yet</span>;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const path = values
    .map((v, i) => {
      if (v == null) return null;
      const x = (i / (values.length - 1)) * width;
      const y = height - ((v - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .filter(Boolean)
    .join(" ");
  const last = points[points.length - 1];
  const colour = last > 0 ? "#15803d" : last < 0 ? "#b91c1c" : "#6b7280";
  return (
    <svg width={width} height={height} className="inline-block" style={{ verticalAlign: "middle" }}>
      <polyline points={path} fill="none" stroke={colour} strokeWidth="1.5" />
    </svg>
  );
}

// ─── The page ────────────────────────────────────────────────────────────────

// A standalone ICP record — the analyzed account's score trail, sourced from
// the ICP substrate (GET /api/mind/account/:id), independent of the CRM contact.
interface IcpRecordRow {
  id: string;
  score: number | null;
  fit: boolean | null;
  reason: string | null;
  scored_at: string;
  rescored?: boolean;
  resolved_at: string | null;
  disposition: string | null;
  outcome_score: number | null;
  learned: { status: "changed" | "no_change" | "pending"; at?: string; detail?: string | null } | null;
}
interface CompanyReport {
  what_they_do: string | null;
  industry: string | null;
  company_type: string | null;
  size_band: string | null;
  funding_stage: string | null;
  country: string | null;
  target_market: string | null;
  pricing_model: string | null;
  recently_funded: boolean | null;
  product: string[];
  tech: string[];
  hiring: string[];
  compliance: string[];
}
interface PipelineReport {
  n_touches: number; n_meetings: number; n_emails: number; n_linkedin: number; n_replies: number;
  first_touch_at: string; last_touch_at: string;
  lead_source: string | null; first_touch_type: string; stage: string | null;
}
interface IcpRecord {
  account: { entity_id: string; name: string | null; email: string | null; company: string | null };
  icp: { current: IcpRecordRow; history: IcpRecordRow[] } | null;
  company?: CompanyReport | null;
  pipeline?: PipelineReport | null;
}

// Full-page ICP account view — opened from the analyzed table. Mirrors the
// People detail layout (name on top, the ICP score, then tabs) but is its own
// thing in the Context page: what we captured about this account — the score
// trail, the company report (firmographics), and the pipeline report.
function IcpAccountView({ data, loading, fallbackName, onBack }: {
  data: IcpRecord | null; loading: boolean; fallbackName: string; onBack: () => void;
}) {
  const [tab, setTab] = useState<"trail" | "company" | "pipeline">("trail");
  const cur = data?.icp?.current ?? null;
  const sc = cur?.score ?? null;
  const col = sc == null ? "#9ca3af" : sc >= 70 ? "#15803d" : sc >= 40 ? "#b45309" : "#b91c1c";
  const fitLabel = sc == null ? "—" : sc >= 70 ? "Strong fit" : sc >= 40 ? "Potential fit" : "Weak fit";
  const company = data?.company ?? null;
  const pipeline = data?.pipeline ?? null;
  const fmt = (iso?: string | null) => (iso ? formatDistanceToNow(new Date(iso), { addSuffix: true }) : "—");
  const titleCase = (s?: string | null) => (s ? s.replace(/[_-]/g, " ").replace(/\b\w/g, c => c.toUpperCase()) : null);

  const outcomeOf = (d: string | null) =>
    d === "won" ? { t: "Closed-won", c: "#15803d", bg: "rgba(21,128,61,0.10)" }
    : d === "lost" ? { t: "Closed-lost", c: "#b45309", bg: "rgba(180,83,9,0.10)" }
    : d === "no_opportunity" ? { t: "No deal", c: "#64748b", bg: "rgba(100,116,139,0.10)" }
    : null;
  const learnNote = (h: IcpRecordRow): string | null => {
    if (h.disposition === "no_opportunity") return "Never entered a buying motion — excluded from learning.";
    const L = h.learned;
    if (!L || L.status === "pending") return "In the training set — the next learning run will use it.";
    if (L.status === "changed") return `Sharpened the model${L.at ? ` ${fmt(L.at)}` : ""}${L.detail ? ` — ${L.detail}` : ""}.`;
    return "In the training set — no model change that run.";
  };

  const Field = ({ label, value }: { label: string; value: string | null }) =>
    value ? (
      <div className="flex items-baseline gap-3 py-1.5 border-b border-border/40 last:border-0">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/55 w-32 flex-shrink-0">{label}</span>
        <span className="text-[13px] text-foreground/85">{value}</span>
      </div>
    ) : null;
  const Chips = ({ label, items }: { label: string; items: string[] }) =>
    items.length ? (
      <div className="py-2 border-b border-border/40 last:border-0">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/55 mb-1.5">{label}</div>
        <div className="flex flex-wrap gap-1.5">
          {items.map((it, i) => (
            <span key={i} className="text-[11.5px] px-1.5 py-[2px] rounded bg-muted text-foreground/75 capitalize">{it}</span>
          ))}
        </div>
      </div>
    ) : null;

  const TABS = [{ id: "trail", label: "Trail" }, { id: "company", label: "Company" }, { id: "pipeline", label: "Pipeline" }] as const;

  return (
    <div className="h-full bg-background flex flex-col">
      <div className="flex-shrink-0 px-8 pt-7">
        <div className="flex items-center gap-3 mb-1">
          <button onClick={onBack} className="inline-flex items-center justify-center h-8 w-8 rounded-lg border border-border text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors flex-shrink-0">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <h1 className="text-[20px] font-semibold tracking-tight text-foreground">{data?.account.name || fallbackName}</h1>
        </div>
        <div className="pl-11 mb-3 flex items-center gap-2 flex-wrap">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/55">ICP record</span>
          {data?.account.company && <span className="text-[13px] font-medium text-foreground/80">· {data.account.company}</span>}
          {data?.account.email && <span className="text-[13px] text-muted-foreground">· {data.account.email}</span>}
        </div>
        {cur && (
          <div className="pl-11 mb-4">
            <div className="flex items-baseline gap-2.5">
              <span className="text-[34px] font-semibold tabular-nums leading-none" style={{ color: col }}>{sc ?? "—"}</span>
              <span className="text-[13px] text-muted-foreground/80">/ 100 · {fitLabel}</span>
            </div>
            {cur.reason && (
              <p className="text-[12.5px] text-muted-foreground leading-relaxed mt-1.5 max-w-2xl">
                <span className="text-muted-foreground/60">Scored from: </span>{cur.reason}
              </p>
            )}
          </div>
        )}
        <div className="flex gap-6 border-b border-border">
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`pb-2.5 text-[13px] font-medium transition-colors flex-shrink-0 ${tab === t.id ? "text-foreground border-b-2 border-foreground -mb-px" : "text-muted-foreground/70 hover:text-foreground/80"}`}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-8 py-5">
        <div className="max-w-3xl">
          {loading ? (
            <div className="text-[13px] text-muted-foreground/60 py-12">Loading…</div>
          ) : tab === "trail" ? (
            !data?.icp ? (
              <p className="text-[13px] text-muted-foreground/70 py-12">Not scored yet — Nous scores this account once it has enough to go on.</p>
            ) : (
              <div className="space-y-0">
                {data.icp.history.map((h, i) => {
                  const oc = outcomeOf(h.disposition);
                  const isCurrent = i === 0;
                  const hcol = h.score == null ? "#9ca3af" : h.score >= 70 ? "#15803d" : h.score >= 40 ? "#b45309" : "#b91c1c";
                  return (
                    <div key={h.id} className="relative pl-5 pb-5 last:pb-0 border-l border-border/70 last:border-l-transparent">
                      <span className="absolute -left-[5px] top-1 h-2.5 w-2.5 rounded-full border-2 border-background" style={{ background: isCurrent ? col : "#cbd5e1" }} />
                      <div className="flex items-baseline gap-2 flex-wrap">
                        <span className="text-[13px] font-medium text-foreground">
                          {h.rescored ? "Re-scored" : "Scored"} <span className="tabular-nums font-semibold" style={{ color: hcol }}>{h.score ?? "—"}</span>
                        </span>
                        <span className="text-[12px] text-muted-foreground/60 tabular-nums">{fmt(h.scored_at)}</span>
                      </div>
                      {h.reason && i > 0 && <p className="text-[12px] text-muted-foreground/70 leading-snug mt-0.5">{h.reason}</p>}
                      {oc && (
                        <div className="mt-2 flex items-baseline gap-2 flex-wrap">
                          <span className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-[1px] rounded" style={{ color: oc.c, background: oc.bg }}>{oc.t}</span>
                          <span className="text-[12px] text-muted-foreground/70">{learnNote(h)}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )
          ) : tab === "company" ? (
            !company ? (
              <p className="text-[13px] text-muted-foreground/70 py-12">No company detail captured yet — it fills in from a closed-deal analysis or enrichment.</p>
            ) : (
              <div>
                {company.what_they_do && <p className="text-[14px] text-foreground/85 leading-relaxed mb-4">{company.what_they_do}</p>}
                <Field label="Type" value={titleCase(company.company_type)} />
                <Field label="Industry" value={titleCase(company.industry)} />
                <Field label="Size" value={company.size_band} />
                <Field label="Funding" value={titleCase(company.funding_stage)} />
                <Field label="Country" value={company.country} />
                <Field label="Market" value={titleCase(company.target_market)} />
                <Field label="Pricing" value={titleCase(company.pricing_model)} />
                <Field label="Recently funded" value={company.recently_funded ? "Yes" : null} />
                <Chips label="Product" items={company.product} />
                <Chips label="Tech" items={company.tech} />
                <Chips label="Hiring" items={company.hiring} />
                <Chips label="Compliance" items={company.compliance} />
              </div>
            )
          ) : (
            !pipeline ? (
              <p className="text-[13px] text-muted-foreground/70 py-12">No pipeline activity recorded yet for this account.</p>
            ) : (
              <div>
                <div className="grid grid-cols-3 sm:grid-cols-5 divide-x divide-border/60 rounded-xl border border-border mb-4">
                  {[
                    { label: "Touches", value: pipeline.n_touches },
                    { label: "Meetings", value: pipeline.n_meetings },
                    { label: "Emails", value: pipeline.n_emails },
                    { label: "LinkedIn", value: pipeline.n_linkedin },
                    { label: "Replies", value: pipeline.n_replies },
                  ].map(m => (
                    <div key={m.label} className="px-3 py-3">
                      <div className="text-[20px] font-semibold tabular-nums">{m.value}</div>
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground/55">{m.label}</div>
                    </div>
                  ))}
                </div>
                <Field label="Lead source" value={titleCase(pipeline.lead_source)} />
                <Field label="First touch" value={`${titleCase(pipeline.first_touch_type)} · ${fmt(pipeline.first_touch_at)}`} />
                <Field label="Last touch" value={fmt(pipeline.last_touch_at)} />
                <Field label="Stage reached" value={titleCase(pipeline.stage)} />
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}

export default function Intelligence() {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const workspaceId = userData?.workspace?.id ?? "";

  const [substrate, setSubstrate] = useState<Substrate | null>(null);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [runs, setRuns] = useState<ScorecardRun[]>([]);
  const [contextChanges, setContextChanges] = useState<ContextChange[]>([]);
  const [loading, setLoading] = useState(true);
  // The core fetches (scorecard signals + ICP facts) decide whether the ICP is
  // set up; `hasLoaded` gates the cold-start screen so it never shows mid-load.
  const [hasLoaded, setHasLoaded] = useState(false);
  // The heavy /substrate query (calibration + closed-deal counts) loads on its
  // own clock so the rest of the page never waits on it.
  const [substrateLoading, setSubstrateLoading] = useState(true);
  const [seeding, setSeeding] = useState(false);

  // ICP facts — workspace-level notes (asserted claims). Loaded only when the
  // Scorecard is empty so the user has an inline path to bootstrap one.
  const [icpFacts, setIcpFacts] = useState<IcpFact[]>([]);
  const [savingFact, setSavingFact] = useState(false);
  const [addSection, setAddSection] = useState<string | null>(null);
  const [sectionDraft, setSectionDraft] = useState("");

  // Playbooks — the policy files every agent reads before acting (voice, outreach,
  // icp, positioning). Each opens as a raw .md page; the badge says whether it's
  // mirrored from a Claude Code file or stored in Nous.
  const PB_ORDER = ["voice", "outreach", "icp", "positioning"];
  const [playbooks, setPlaybooks] = useState<any[]>([]);
  useEffect(() => {
    if (!token || !workspaceId) return;
    fetch(`${apiUrl}/api/playbooks?workspaceId=${workspaceId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.json() : null)).then(d => { if (d?.playbooks) setPlaybooks(d.playbooks); }).catch(() => {});
  }, [token, workspaceId]);

  // Collapsed by default — the page leads with the "getting smarter" story;
  // the full profile is one click away.
  const [contextOpen, setContextOpen] = useState(false);
  // The legend that explains predictions + the timeline chips.

  // Per-fact supersession history — which fact's timeline is expanded, + its rows.
  const [historyOpen, setHistoryOpen] = useState<string | null>(null);
  const [historyItems, setHistoryItems] = useState<{ id: string; content: string; created_at?: string | null; is_active?: boolean }[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Build-from-closed-deals (Step 5) — seed the model from real won/lost.
  const [cdOpen, setCdOpen] = useState(false);
  const [cdWon, setCdWon] = useState("");
  const [cdLost, setCdLost] = useState("");
  const [cdRunning, setCdRunning] = useState(false);
  const [cdResult, setCdResult] = useState<{ enriched: number; won: number; lost: number; mode?: string; linked?: { name: string; domain: string }[]; discovered: { label: string; weight: number; note: string }[] } | null>(null);


  // Model-evolution drawer — opened from the Signals metric. The signals ARE
  // the ICP model; the run history is how it sharpened over time.
  const [modelOpen, setModelOpen] = useState(false);
  const [modelRuns, setModelRuns] = useState<{ id: string; note: string | null; signal_count: number | null; gap_before: number | null; gap_after: number | null; created_at: string }[]>([]);
  const [modelRunsLoading, setModelRunsLoading] = useState(false);
  useEffect(() => {
    if (!modelOpen) return;
    setModelRunsLoading(true);
    fetch(`${apiUrl}/api/mind/scorecard/runs?workspaceId=${workspaceId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(d => setModelRuns(d?.runs ?? []))
      .catch(() => setModelRuns([]))
      .finally(() => setModelRunsLoading(false));
  }, [modelOpen, workspaceId, token]);

  // Standalone ICP record drawer — opened from the analyzed table.
  const [recordEntity, setRecordEntity] = useState<{ id: string; label: string } | null>(null);
  const [record, setRecord] = useState<IcpRecord | null>(null);
  const [recordLoading, setRecordLoading] = useState(false);
  useEffect(() => {
    if (!recordEntity) { setRecord(null); return; }
    setRecordLoading(true);
    fetch(`${apiUrl}/api/mind/account/${recordEntity.id}?workspaceId=${workspaceId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(d => setRecord(d ?? null))
      .catch(() => setRecord(null))
      .finally(() => setRecordLoading(false));
  }, [recordEntity, workspaceId, token]);

  // Inline editing of Scorecard signals (label / weight) + delete.
  const [editSig, setEditSig] = useState<{ id: string; field: "label" | "weight" } | null>(null);

  const load = useCallback(() => {
    if (!workspaceId || !token) return;
    const h = { Authorization: `Bearer ${token}` };
    setLoading(true);
    setSubstrateLoading(true);

    // ── Core (fast) — scorecard signals + ICP facts + runs + context changes.
    // These alone decide `hasModel` / `needsSetup`, so they must NOT wait on the
    // heavy substrate query. Each lands independently; the page flips out of the
    // cold-start "Set up your ICP" state as soon as they arrive.
    Promise.all([
      fetch(`${apiUrl}/api/mind/scorecard?workspaceId=${workspaceId}`, { headers: h }).then(r => (r.ok ? r.json() : null)),
      fetch(`${apiUrl}/api/workspace/memories?workspaceId=${workspaceId}&limit=80`, { headers: h }).then(r => (r.ok ? r.json() : null)),
      fetch(`${apiUrl}/api/mind/scorecard/runs?workspaceId=${workspaceId}`, { headers: h }).then(r => (r.ok ? r.json() : null)),
      fetch(`${apiUrl}/api/mind/context-changes?workspaceId=${workspaceId}`, { headers: h }).then(r => (r.ok ? r.json() : null)),
    ])
      .then(([sc, mem, scruns, ctxch]) => {
        if (sc) setSignals(sc.signals ?? []);
        if (mem) {
          const facts: IcpFact[] = (mem.memories ?? [])
            .filter((m: any) => ICP_CATEGORIES.includes(m.category))
            .map((m: any) => ({ id: m.id, category: m.category, content: m.content, created_at: m.created_at, confidence: m.confidence, subject: m.subject, reaffirmed_at: m.reaffirmed_at, source: m.source, source_path: m.metadata?.source_path ?? null }));
          setIcpFacts(facts);
        }
        if (scruns) setRuns(scruns.runs ?? []);
        if (ctxch) setContextChanges(ctxch.changes ?? []);
      })
      .finally(() => { setLoading(false); setHasLoaded(true); });

    // ── Heavy (slow) — calibration + closed-deal counts. Only the numeric metric
    // tiles and the calibration line depend on this; let it fill in late.
    fetch(`${apiUrl}/api/mind/substrate?workspaceId=${workspaceId}`, { headers: h })
      .then(r => (r.ok ? r.json() : null))
      .then(sub => { if (sub) setSubstrate(sub); })
      .catch(() => { /* ignore */ })
      .finally(() => setSubstrateLoading(false));
  }, [workspaceId, token]);

  useEffect(() => { load(); }, [load]);

  const submitSection = async (cat: string) => {
    if (!sectionDraft.trim() || savingFact) return;
    setSavingFact(true);
    try {
      await fetch(`${apiUrl}/api/workspace/memories`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ workspaceId, category: cat, content: sectionDraft.trim() }),
      });
      setSectionDraft("");
      load();
    } finally { setSavingFact(false); }
  };

  const removeIcpFact = async (id: string) => {
    try {
      await fetch(`${apiUrl}/api/workspace/memories/${id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ workspaceId }),
      });
      load();
    } catch { /* ignore */ }
  };

  // Confirm a fact — raise confidence to 1 and reset its staleness clock.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const confirmFact = async (id: string) => {
    setConfirmingId(id);
    try {
      await fetch(`${apiUrl}/api/workspace/memories/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ workspaceId, confidence: 1, reaffirm: true }),
      });
      await load();
    } finally { setConfirmingId(null); }
  };

  // Expand/collapse a fact's supersession timeline (active + superseded versions).
  const toggleHistory = async (fact: IcpFact) => {
    if (historyOpen === fact.id) { setHistoryOpen(null); return; }
    if (!fact.subject) return;
    setHistoryOpen(fact.id);
    setHistoryItems([]);
    setHistoryLoading(true);
    try {
      const r = await fetch(
        `${apiUrl}/api/workspace/memories/history?workspaceId=${workspaceId}&subject=${encodeURIComponent(fact.subject)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const d = await r.json();
      setHistoryItems((d.history ?? []).map((m: any) => ({ id: m.id, content: m.content, created_at: m.created_at, is_active: m.is_active })));
    } catch { /* ignore */ }
    finally { setHistoryLoading(false); }
  };

  const buildScorecard = async () => {
    if (seeding) return;
    setSeeding(true);
    try {
      await fetch(`${apiUrl}/api/mind/scorecard/seed`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ workspaceId }),
      });
      load();
    } finally { setSeeding(false); }
  };

  // Build the model from real closed deals — enrich + contrastive lift discovery.
  const parseDomains = (s: string) => s.split(/[\n,]+/).map(x => x.trim()).filter(Boolean);
  const runClosedDeals = async () => {
    if (cdRunning) return;
    const won = parseDomains(cdWon), lost = parseDomains(cdLost);
    if (won.length + lost.length < 1) { window.alert("Add at least one closed deal (a won or lost domain)."); return; }
    setCdRunning(true); setCdResult(null);
    try {
      const r = await fetch(`${apiUrl}/api/mind/closed-deals`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ workspaceId, won, lost }),
      });
      const d = await r.json();
      if (d.discovered) { setCdResult(d); load(); }
      else window.alert(d.detail || d.error || "Couldn't process the deals.");
    } catch { window.alert("Request failed."); }
    finally { setCdRunning(false); }
  };

  const patchSignal = async (id: string, body: { label?: string; weight?: number; active?: boolean }) => {
    setEditSig(null);
    await fetch(`${apiUrl}/api/mind/scorecard/signals/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ workspaceId, ...body }),
    });
    load();
  };
  const removeSignal = async (id: string) => {
    await fetch(`${apiUrl}/api/mind/scorecard/signals/${id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ workspaceId }),
    });
    load();
  };

  const active   = signals.filter(s => s.active);
  const positive = active.filter(s => s.weight > 0).sort((a, b) => b.weight - a.weight);
  const negative = active.filter(s => s.weight < 0).sort((a, b) => a.weight - b.weight);
  const hasModel = active.length > 0;

  // Has the playbook actually been built? Either the in-app wizard ran (facts
  // with source 'playbook') OR the agent wrote real GTM context across the
  // sections (source 'agent') — agent-operated onboarding is first-class and must
  // unlock the page. A lone onboarding-seeded ICP line (source 'onboarding') does
  // NOT count, so a bare new workspace stays on the cold-start screen: hence the
  // >= 2 threshold rather than "any built fact".
  const builtFacts = icpFacts.filter(f => f.source === "playbook" || f.source === "agent");
  const playbookDone = builtFacts.length >= 2;
  // Only conclude "not set up" once the core fetches have actually returned —
  // otherwise the empty initial state paints the cold-start "Set up your ICP"
  // screen for the seconds the load takes, even on a fully-configured workspace.
  const needsSetup = hasLoaded && !playbookDone && !hasModel;

  // Does the ICP live in the user's own repo? When any section was synced from a
  // file (sync_icp records source_path), the file is the source of truth and this
  // page is a READ-ONLY mirror — editing happens in their repo, not here. We show
  // provenance and drop the in-app edit controls so there's one place to author.
  const syncedPaths = [...new Set(icpFacts.map(f => f.source_path).filter((p): p is string => !!p))];
  const fileSynced = syncedPaths.length > 0;
  const icpPath = icpFacts.find(f => f.category === "ICP" && f.source_path)?.source_path
    ?? syncedPaths[0] ?? null;

  const gap = substrate?.calibration.gap ?? null;
  const resolved = substrate?.calibration.resolved ?? 0;
  const trendValues = substrate?.calibration.trend.map(t => t.gap) ?? [];

  // ── The confidence sentence ─────────────────────────────────────────────────
  // Turn the calibration numbers into one honest line a founder can read. The
  // model is well-calibrated when the accounts it scores high convert more
  // often than the ones it scores low — we say that as a multiple when we can.
  const hi = substrate?.calibration.high.avg_outcome ?? null;
  const lo = substrate?.calibration.low.avg_outcome ?? null;
  const confidence: { line: string; tone: "good" | "warn" | "neutral" } = (() => {
    if (!hasModel) return { line: "No model yet — build your Scorecard below to start scoring accounts.", tone: "neutral" };
    if (resolved === 0)
      return { line: `Still gathering evidence. ${substrate?.predictions.open ?? 0} predictions are open and waiting on outcomes.`, tone: "neutral" };
    if (hi != null && lo != null && lo > 0.01) {
      const mult = hi / lo;
      if (mult >= 1.15)
        return { line: `Accounts I score 70+ convert ${mult.toFixed(1)}× more often than the rest. The model is calling it right.`, tone: "good" };
      if (mult >= 0.95)
        return { line: `High and low-scored accounts are converting at about the same rate — the model isn't separating fit from non-fit yet.`, tone: "warn" };
      return { line: `Accounts I score low are converting more than the ones I score high — the model is miscalibrated and tonight's loop will adjust.`, tone: "warn" };
    }
    if (hi != null && hi > 0 && (lo == null || lo <= 0.01))
      return { line: `Accounts I score 70+ are converting; lower-scored ones haven't yet. Early but pointing the right way.`, tone: "good" };
    return { line: `${resolved} prediction${resolved === 1 ? "" : "s"} resolved so far — not enough yet to call the model's accuracy.`, tone: "neutral" };
  })();
  const confColor = confidence.tone === "good" ? "#15803d" : confidence.tone === "warn" ? "#b45309" : undefined;

  // The scoring model in one plain sentence — the transparency layer. The
  // weights/calibration live behind "see the model"; this is the gist.
  const fitSummary = positive.length
    ? `A strong fit looks like: ${positive.slice(0, 5).map(s => s.label).join("; ")}.`
    : null;

  const predictionsMade = (substrate?.predictions.open ?? 0) + resolved;

  // "Called it" — resolved predictions where the model scored a strong fit and
  // the account actually converted. The loop proven right by reality.
  const hits = (substrate?.recent_predictions ?? [])
    .filter(p => p.resolved_at && (p.score ?? 0) >= 70 && (p.outcome_score ?? 0) > 0);

  // Who taught a context change — turns "a fact changed" into "Claude learned
  // this from your work", which is the whole write-back loop made visible.
  const sourceWho = (s: string) => (s === "agent" ? "Claude" : s === "playbook" ? "site" : "you");

  // The timeline is for things the workspace LEARNED, not a copy of the context.
  // So we don't echo the static site/you facts here — only Claude's write-backs
  // (the system updating itself from your work) count as a "captured" learning.
  // Refinements, model changes, and outcomes are events regardless of source.
  const refinedContents = new Set(contextChanges.map(c => c.to));
  const captures = icpFacts.filter(f => f.source === "agent" && f.created_at && !refinedContents.has(f.content));

  // The "what it's learned" timeline — the page's heart. Knowledge captured,
  // then refined (you/Claude/site), the model sharpening, and predictions it
  // called right — all merged newest-first.
  type Learning = { id: string; kind: "model" | "context" | "outcome"; who?: string; text: string; sub?: string; at: string; delta?: number | null };
  const learnings: Learning[] = [
    ...runs.map(r => ({
      id: `run-${r.id}`, kind: "model" as const,
      text: r.note || "Sharpened the scoring model.",
      at: r.created_at,
      delta: (r.gap_after != null && r.gap_before != null) ? r.gap_after - r.gap_before : null,
    })),
    ...contextChanges.map((c, i) => ({
      id: `ctx-${i}`, kind: "context" as const, who: sourceWho(c.source),
      text: `${c.category} — ${c.to}`,
      sub: `was: ${c.from}`,
      at: c.at,
    })),
    ...hits.map(p => ({
      id: `hit-${p.id}`, kind: "outcome" as const,
      text: `Called it — ${p.name || p.email || "an account"} scored ${p.score} and converted`,
      at: p.resolved_at as string,
    })),
    ...captures.map(f => ({
      id: `cap-${f.id}`, kind: "context" as const, who: sourceWho(f.source ?? "manual"),
      text: `${f.category} — ${f.content}`,
      at: f.created_at as string,
    })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, 14);

  // "Sharpened" counts the times it got BETTER — refinements, model changes, and
  // calls it got right — not the initial captures.
  const sharpenedCount = runs.length + contextChanges.length + hits.length;

  // The chip on each learning — colour-codes who/what taught it.
  const learningChip = (l: Learning): { label: string; color: string; bg: string } => {
    if (l.kind === "outcome") return { label: "✓ called it", color: "#b45309", bg: "rgba(180,83,9,0.10)" };
    if (l.kind === "model") return { label: "model", color: "#15803d", bg: "rgba(21,128,61,0.08)" };
    const who = l.who ?? "you";
    if (who === "Claude") return { label: "Claude", color: "#6d28d9", bg: "rgba(109,40,217,0.08)" };
    if (who === "site") return { label: "site", color: "#a16207", bg: "rgba(161,98,7,0.08)" };
    return { label: "you", color: "#475569", bg: "rgba(71,85,105,0.08)" };
  };

  // "To get sharper, I need…" — turns the page into a loop the user feeds.
  const staleCount = icpFacts.filter(f => reviewReason(f)).length;
  const openPreds = substrate?.predictions.open ?? 0;
  const needs: string[] = [];
  if (!hasModel && icpFacts.length > 0) needs.push("build your scoring model");
  if (openPreds > 0) needs.push(`${openPreds} scored account${openPreds === 1 ? "" : "s"} waiting on an outcome`);
  if (staleCount > 0) needs.push(`confirm ${staleCount} belief${staleCount === 1 ? "" : "s"}`);

  // "Learning for N days" — a streak from the oldest fact still in the context.
  const oldestAt = icpFacts.reduce<string | null>(
    (min, f) => (f.created_at && (!min || f.created_at < min) ? f.created_at : min), null);
  const learningDays = oldestAt ? Math.max(1, Math.floor((Date.now() - new Date(oldestAt).getTime()) / 86400000)) : null;

  // One editable signal row (weight + label), reused inside "see the model".
  const renderSignal = (s: Signal, color: string) => {
    const editingW = editSig?.id === s.id && editSig.field === "weight";
    const editingL = editSig?.id === s.id && editSig.field === "label";
    return (
      <div key={s.id} className="flex items-baseline gap-3 py-1.5 group">
        {editingW ? (
          <input
            type="number" autoFocus defaultValue={s.weight} min={-10} max={10}
            onBlur={e => patchSignal(s.id, { weight: Number(e.target.value) })}
            onKeyDown={e => {
              if (e.key === "Enter") patchSignal(s.id, { weight: Number((e.target as HTMLInputElement).value) });
              if (e.key === "Escape") setEditSig(null);
            }}
            className="w-12 flex-shrink-0 rounded border border-border bg-background text-[12px] tabular-nums px-1 py-0.5 outline-none focus:border-foreground/40"
          />
        ) : (
          <button
            onClick={() => setEditSig({ id: s.id, field: "weight" })}
            title="Edit weight"
            className="text-[12px] font-semibold tabular-nums w-8 flex-shrink-0 text-left hover:underline"
            style={{ color }}
          >
            {s.weight > 0 ? "+" : ""}{s.weight}
          </button>
        )}
        {editingL ? (
          <input
            type="text" autoFocus defaultValue={s.label}
            onBlur={e => patchSignal(s.id, { label: e.target.value })}
            onKeyDown={e => {
              if (e.key === "Enter") patchSignal(s.id, { label: (e.target as HTMLInputElement).value });
              if (e.key === "Escape") setEditSig(null);
            }}
            className="flex-1 rounded border border-border bg-background text-[13px] px-1.5 py-0.5 outline-none focus:border-foreground/40"
          />
        ) : (
          <span
            onClick={() => setEditSig({ id: s.id, field: "label" })}
            className="text-[13px] text-foreground/85 leading-snug flex-1 cursor-pointer hover:text-foreground"
          >
            {s.label}
          </span>
        )}
        {(() => {
          // Lift: how much more accounts where this signal fires convert vs where
          // it doesn't, measured from resolved deals. Null until there's enough data.
          const t = (substrate?.top_signals ?? []).find(ts => ts.key === s.key);
          if (t?.lift == null) return null;
          const up = t.lift >= 1;
          return (
            <span
              className="flex-shrink-0 text-[11px] font-semibold tabular-nums px-1.5 py-[1px] rounded"
              style={up ? { color: "#15803d", background: "rgba(21,128,61,0.08)" } : { color: "#b45309", background: "rgba(180,83,9,0.08)" }}
              title={`accounts with this signal convert ${t.lift}× as often (from ${t.sample} resolved deals)`}
            >
              {t.lift}×{up ? " more" : ""}
            </span>
          );
        })()}
        <button
          onClick={() => removeSignal(s.id)}
          className="flex-shrink-0 h-5 w-5 grid place-items-center rounded text-muted-foreground/40 hover:text-red-500 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition-colors"
          aria-label="Remove signal"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    );
  };

  // An account was clicked in the analyzed table → show its full ICP record in
  // place of the dashboard (the app sidebar stays, like the People detail).
  if (recordEntity) {
    return (
      <IcpAccountView
        data={record}
        loading={recordLoading}
        fallbackName={recordEntity.label}
        onBack={() => setRecordEntity(null)}
      />
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="px-8 py-7 max-w-[1240px] mx-auto">
        <PageHeader
          title="ICP"
          actions={
            <div className="flex items-center gap-2">
              {!needsSetup && (
                <button
                  onClick={() => setCdOpen(true)}
                  title="Add closed-won / closed-lost deals to sharpen the model"
                  data-tour="add-deals"
                  className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-background border border-border text-foreground/80 text-[13px] font-semibold hover:bg-muted/50 transition-colors"
                >
                  <Plus className="h-3.5 w-3.5" /> Add deals
                </button>
              )}
              <button
                onClick={load}
                className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-background border border-border text-foreground/80 text-[13px] font-semibold hover:bg-muted/50 transition-colors"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
              </button>
            </div>
          }
        />

        {hasModel && (
          <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-border/70 rounded-xl border border-border mb-4 bg-background">
            {[
              { label: "Accounts analyzed", value: predictionsMade, pending: substrateLoading, color: undefined as string | undefined, info: "Accounts the ICP model has scored for fit (0–100)." },
              { label: "Closed-won", value: substrate?.predictions.won ?? 0, pending: substrateLoading, color: "#15803d", info: "Scored accounts that converted — the wins the model learns from." },
              { label: "Closed-lost", value: substrate?.predictions.lost ?? 0, pending: substrateLoading, color: "#b45309", info: "Scored accounts that entered a real buying motion but didn't close." },
              { label: "Signals", value: active.length, pending: false, color: undefined, info: "The weighted attributes the model scores fit on. Click to see how they evolved.", onClick: () => setModelOpen(true) },
            ].map(m => (
              <div
                key={m.label}
                onClick={(m as { onClick?: () => void }).onClick}
                className={`px-4 py-3.5 relative group/metric ${(m as { onClick?: () => void }).onClick ? "cursor-pointer hover:bg-muted/40 transition-colors" : ""}`}
              >
                <Info className="absolute top-2 right-2 h-3 w-3 text-muted-foreground/25 group-hover/metric:text-muted-foreground/60 transition-colors" />
                <span className="pointer-events-none absolute top-7 right-2 z-30 w-52 rounded-lg bg-foreground text-background text-[11px] leading-snug px-2.5 py-2 shadow-lg opacity-0 group-hover/metric:opacity-100 transition-opacity duration-150">
                  {m.info}
                </span>
                {m.pending
                  ? <div className="h-[22px] w-8 rounded bg-muted animate-pulse" />
                  : <div className="text-[22px] font-semibold tabular-nums leading-none" style={m.color ? { color: m.color } : undefined}>{m.value}</div>}
                <div className="text-[10.5px] font-medium text-muted-foreground/60 uppercase tracking-wide mt-1.5">{m.label}</div>
              </div>
            ))}
          </div>
        )}

        <div className="space-y-4">

          {/* What predicts a win — straight under the numbers, because it's the
              answer the numbers are asking about. The playbooks moved to their own
              page: prose the agent obeys is a different object from a model that
              scores fit, and mixing them was the confusion. */}
          {!needsSetup && hasModel && (
            <div className="rounded-xl border border-border bg-background overflow-hidden">
              <div className="flex items-center px-4 py-2.5 bg-muted/50 border-b border-border">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">What predicts a win</span>
              </div>
              <div className="px-4 py-4 grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wide mb-2" style={{ color: "#15803d" }}>Win drivers</div>
                  {positive.length === 0
                    ? <p className="text-[12.5px] text-muted-foreground/55">None yet — these are learned from won deals.</p>
                    : positive.map(s => renderSignal(s, "#15803d"))}
                </div>
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wide mb-2" style={{ color: "#b45309" }}>Loss drivers</div>
                  {negative.length === 0
                    ? <p className="text-[12.5px] text-muted-foreground/55">None yet — these are learned from lost deals.</p>
                    : negative.map(s => renderSignal(s, "#b45309"))}
                </div>
              </div>
              {/* Seed-estimate notice. The model can only LEARN weights once it has
                  wins to contrast against — losses alone can't compute lift. So gate
                  on wins, but tell the truth about what's recorded: "no outcomes at all"
                  vs "losses only" are different states and the old copy conflated them
                  (it said "no closed outcomes yet" even when N losses were imported). */}
              {(substrate?.predictions.won ?? 0) === 0 && (
                <div className="px-4 py-3 border-t border-border/60 bg-amber-500/[0.05] text-[12px] text-muted-foreground/80 leading-relaxed">
                  {(substrate?.predictions.lost ?? 0) > 0
                    ? <>
                        {substrate?.predictions.lost} closed-lost recorded, but no closed-won yet — so these weights
                        stay seed estimates until wins show what actually predicts revenue.{" "}
                        <button onClick={() => setCdOpen(true)} className="font-semibold text-foreground underline underline-offset-2 hover:text-foreground/80">Add your closed-won deals</button>.
                      </>
                    : <>
                        No closed outcomes yet, so these weights are seed estimates.{" "}
                        <button onClick={() => setCdOpen(true)} className="font-semibold text-foreground underline underline-offset-2 hover:text-foreground/80">Add your closed deals</button>{" "}
                        and the model learns what actually predicts revenue.
                      </>}
                </div>
              )}
            </div>
          )}

          {/* ─── Your context — only when NOT file-synced; the Playbooks page covers file-backed policies ─── */}
          {!fileSynced && (
          <div className="rounded-xl border border-border bg-background overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2.5 bg-muted/50 border-b border-border">
              {needsSetup ? (
                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">Your context</span>
              ) : fileSynced ? (
                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">ICP source</span>
              ) : (
                <button
                  onClick={() => setContextOpen(o => !o)}
                  className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70 hover:text-foreground transition-colors"
                >
                  <ChevronRight className={`h-3.5 w-3.5 transition-transform ${contextOpen ? "rotate-90" : ""}`} />
                  Your context
                </button>
              )}
            </div>
            {(needsSetup || contextOpen || fileSynced) && (
            <>
            {needsSetup ? (
              /* Cold start — setup is done by the agent, not here. Point them to it. */
              <div className="px-6 py-10 flex flex-col items-center text-center">
                <h3 className="text-[17px] font-semibold text-foreground">Set up your ICP</h3>
                <p className="text-[13px] text-muted-foreground mt-2 max-w-[460px] leading-relaxed">
                  Your agent builds this with you in Claude. It reads your site, drafts what
                  you sell and who you sell to, and writes your scoring model. This page is
                  where you watch it take shape.
                </p>
                <div className="mt-5 w-full max-w-[460px]">
                  <AgentSetupHint prompt="Set up my ICP" />
                </div>
              </div>
            ) : (
              /* Saved context. When synced from a repo file, show the sync notice
                 and fold the file-backed sections into it; any non-file sections
                 stay editable. Otherwise, the full editable context. */
              <div className="px-4 py-4 space-y-4">
                {fileSynced && (
                  <div className="rounded-lg border border-border bg-muted/30 p-4 flex items-start gap-3">
                    <Info className="h-4 w-4 mt-0.5 text-muted-foreground/70 flex-shrink-0" />
                    <div>
                      <div className="text-[13px] font-medium text-foreground">We sync to your ICP file in Claude Code</div>
                      <div className="text-[12px] text-muted-foreground mt-1 leading-relaxed">
                        Your ICP lives in{" "}
                        <code className="text-[11px] px-1 py-[1px] rounded bg-muted text-foreground/80">{icpPath}</code>{" "}
                        in your repo. Edit it there — Nous mirrors it and writes the learned model below back into the same file.
                      </div>
                    </div>
                  </div>
                )}
                {(() => {
                  if (fileSynced) return null;
                  const review = icpFacts
                    .map(f => ({ f, reason: reviewReason(f) }))
                    .filter((x): x is { f: IcpFact; reason: string } => x.reason !== null);
                  if (review.length === 0) return null;
                  return (
                    <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-3 space-y-2">
                      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-700/90">
                        <RefreshCw className="h-3 w-3" />
                        Worth revisiting · {review.length}
                      </div>
                      <p className="text-[11.5px] text-muted-foreground/80 leading-relaxed">
                        These are AI-drafted or have gone a while without a check. Confirm the ones still true so your context stays trustworthy.
                      </p>
                      <div className="space-y-1.5">
                        {review.map(({ f, reason }) => (
                          <div key={f.id} className="flex items-start gap-2">
                            <span className="text-[12px] text-foreground/80 leading-snug flex-1">
                              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/50 mr-1.5">{f.category}</span>
                              {f.content}
                              <span className="ml-1.5 text-[10px] text-amber-700/70">· {reason}</span>
                            </span>
                            <button
                              onClick={() => confirmFact(f.id)}
                              disabled={confirmingId === f.id}
                              className="flex-shrink-0 h-6 px-2 rounded-md border border-amber-600/30 text-[11px] font-semibold text-amber-800 hover:bg-amber-500/15 transition-colors disabled:opacity-40"
                            >
                              {confirmingId === f.id ? "…" : "Confirm"}
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}
                {/* Each section is a living field. Hover a section to reveal its
                    "+" — add a line straight into it, no dropdown. */}
                <div className="space-y-5">
                  {ICP_CATEGORIES.map(cat => {
                    const items = icpFacts.filter(f => f.category === cat);
                    // When the ICP is file-synced, the repo file is the source of truth —
                    // fold every section away and let the notice above stand alone. Nothing
                    // is editable here; it all lives in context/icp/icp.md.
                    if (fileSynced) return null;
                    const adding = addSection === cat;
                    const openAdd = () => { setAddSection(cat); setSectionDraft(""); };
                    const closeAdd = () => { setAddSection(null); setSectionDraft(""); };
                    return (
                      <div key={cat} className="group/section">
                        <div className="flex items-center justify-between mb-1.5 pb-1 border-b border-border/40">
                          <span className="text-[12px] font-semibold uppercase tracking-wider text-foreground/60">{cat}</span>
                          <button
                            onClick={() => (adding ? closeAdd() : openAdd())}
                            className={`flex-shrink-0 h-5 w-5 grid place-items-center rounded text-muted-foreground/40 hover:text-foreground hover:bg-muted transition-all ${adding ? "opacity-100" : "opacity-0 group-hover/section:opacity-100"}`}
                            aria-label={`Add to ${cat}`}
                            title={`Add to ${cat}`}
                          >
                            <Plus className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        <div className="space-y-1.5">
                          {items.map(f => {
                            const inferred = typeof f.confidence === "number" && f.confidence < 1;
                            return (
                            <div key={f.id}>
                              <div className="flex items-start gap-2 group">
                                <span className="text-[13px] text-foreground/85 leading-snug flex-1">
                                  {f.content}
                                  {inferred && (
                                    <span
                                      title="AI-drafted from your site — confirm or edit to make it yours"
                                      className="ml-1.5 align-middle text-[9px] font-semibold uppercase tracking-wide text-amber-700/80 bg-amber-500/10 rounded px-1 py-[1px]"
                                    >
                                      inferred
                                    </span>
                                  )}
                                </span>
                                {f.subject && (
                                  <button
                                    onClick={() => toggleHistory(f)}
                                    className="flex-shrink-0 h-5 w-5 grid place-items-center rounded text-muted-foreground/40 hover:text-foreground hover:bg-muted transition-colors"
                                    aria-label="History"
                                    title="See how this changed over time"
                                  >
                                    <History className="h-3.5 w-3.5" />
                                  </button>
                                )}
                                <button
                                  onClick={() => removeIcpFact(f.id)}
                                  className="flex-shrink-0 h-5 w-5 grid place-items-center rounded text-muted-foreground/50 hover:text-red-500 hover:bg-red-500/10 transition-colors"
                                  aria-label="Remove"
                                  title="Remove"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </div>
                              {historyOpen === f.id && (
                                <div className="mt-1 ml-1 pl-3 border-l-2 border-border/60 space-y-1">
                                  {historyLoading ? (
                                    <div className="text-[11px] text-muted-foreground/60 py-1">Loading history…</div>
                                  ) : historyItems.length <= 1 ? (
                                    <div className="text-[11px] text-muted-foreground/60 py-1">No earlier versions yet — this is the first.</div>
                                  ) : (
                                    historyItems.map(h => (
                                      <div key={h.id} className="text-[12px] leading-snug">
                                        <span className={h.is_active ? "text-foreground/80" : "text-muted-foreground/50 line-through"}>{h.content}</span>
                                        <span className="ml-1.5 text-[10px] text-muted-foreground/50">
                                          {h.is_active ? "current" : "superseded"}{h.created_at ? ` · ${new Date(h.created_at).toLocaleDateString()}` : ""}
                                        </span>
                                      </div>
                                    ))
                                  )}
                                </div>
                              )}
                            </div>
                            );
                          })}
                          {adding ? (
                            <input
                              type="text"
                              autoFocus
                              value={sectionDraft}
                              onChange={e => setSectionDraft(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === "Enter") submitSection(cat);
                                if (e.key === "Escape") closeAdd();
                              }}
                              onBlur={() => { if (!sectionDraft.trim()) closeAdd(); }}
                              placeholder={`Add to ${cat}…`}
                              className="w-full rounded-md border border-foreground/30 bg-background px-3 py-1.5 text-[13px] text-foreground placeholder:text-muted-foreground/60 outline-none focus:border-foreground/50"
                            />
                          ) : items.length === 0 ? (
                            <button
                              onClick={openAdd}
                              className="flex items-center gap-1 text-[12.5px] text-muted-foreground/40 hover:text-foreground/70 transition-colors"
                            >
                              <Plus className="h-3 w-3" /> add
                            </button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            </>
            )}
          </div>
          )}

          {/* ─── 2. How your workspace is getting smarter — the centerpiece. ───
               ─── The compounding story: the model AND the context sharpening ───
               ─── over time. This is the whole point of the page. ─── */}
          {/* Build CTA — only before a scoring model exists. */}
          {!needsSetup && !hasModel && icpFacts.length > 0 && (
            <div className="rounded-xl border border-border bg-background px-4 py-4 flex items-center gap-3 flex-wrap">
              <button
                onClick={buildScorecard}
                disabled={seeding}
                className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-primary text-primary-foreground text-[13px] font-semibold hover:bg-primary/90 transition-colors disabled:opacity-30"
              >
                {seeding ? "Building…" : "Build your scoring model"}
              </button>
              <span className="text-[12px] text-muted-foreground/70">Turn your context into a model that scores fit — then watch it sharpen from every outcome.</span>
            </div>
          )}

        </div>
      </div>


      {/* ─── Your ICP model — the signals ARE the model; the run history is
           how it sharpened over time. Opened from the Signals metric. ─── */}
      {modelOpen && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={() => setModelOpen(false)}>
          <div className="h-full w-full max-w-[480px] bg-background border-l border-border shadow-xl flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-border flex items-start justify-between gap-3">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/55">Your ICP model</div>
                <div className="text-[16px] font-semibold text-foreground">{active.length} signal{active.length === 1 ? "" : "s"}</div>
              </div>
              <button onClick={() => setModelOpen(false)} className="text-muted-foreground/60 hover:text-foreground text-[20px] leading-none flex-shrink-0" aria-label="Close">×</button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
              {/* The model now — what it scores on */}
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60 mb-2">What it scores on now</div>
                {active.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground/60">No signals yet.</p>
                ) : (
                  <div className="space-y-1">
                    {[...positive, ...negative].map(s => (
                      <div key={s.id} className="flex items-baseline gap-2.5 py-1 border-b border-border/40 last:border-0">
                        <span className="text-[12px] font-semibold tabular-nums w-8 flex-shrink-0 text-right" style={{ color: s.weight >= 0 ? "#15803d" : "#b45309" }}>{s.weight > 0 ? "+" : ""}{s.weight}</span>
                        <span className="text-[13px] text-foreground/85 flex-1">{s.label}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {/* How it evolved — the run history */}
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60 mb-2">How it evolved</div>
                {modelRunsLoading ? (
                  <p className="text-[13px] text-muted-foreground/60">Loading…</p>
                ) : modelRuns.length === 0 ? (
                  <p className="text-[12.5px] text-muted-foreground/65 leading-relaxed">No learning runs yet. The model sharpens once you've resolved enough deals (≈20) — each run that changes a signal shows up here with a date.</p>
                ) : (
                  <div className="space-y-0">
                    {modelRuns.map(r => {
                      const changed = typeof r.note === "string" && r.note.startsWith("kept");
                      const label = !r.note ? "Learning run"
                        : changed ? `Sharpened — ${r.note.replace(/^kept\s+\d+:\s*/, "")}`
                        : r.note.startsWith("no change") ? "Reviewed — no change" : r.note;
                      return (
                        <div key={r.id} className="relative pl-5 pb-4 last:pb-0 border-l border-border/70 last:border-l-transparent">
                          <span className="absolute -left-[5px] top-1 h-2.5 w-2.5 rounded-full border-2 border-background" style={{ background: changed ? "#15803d" : "#cbd5e1" }} />
                          <div className="flex items-baseline gap-2 flex-wrap">
                            <span className={`text-[12.5px] ${changed ? "font-medium text-foreground/85" : "text-muted-foreground/70"}`}>{label}</span>
                            <span className="text-[11px] text-muted-foreground/50 tabular-nums">{formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}</span>
                          </div>
                          {r.signal_count != null && <div className="text-[11px] text-muted-foreground/45 mt-0.5">{r.signal_count} active signal{r.signal_count === 1 ? "" : "s"}</div>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─── Build from closed deals — contrastive lift discovery ─── */}
      {cdOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !cdRunning && setCdOpen(false)}>
          <div className="bg-background border border-border rounded-2xl shadow-xl w-full max-w-[620px] max-h-[88vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-border flex items-center justify-between">
              <div className="text-[15px] font-semibold text-foreground">Build from your closed deals</div>
              <button onClick={() => !cdRunning && setCdOpen(false)} className="text-muted-foreground/60 hover:text-foreground text-[20px] leading-none" aria-label="Close">×</button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
              <p className="text-[12.5px] text-muted-foreground leading-relaxed">
                Paste the website domains of accounts you <b>won</b> and ones you <b>lost</b>. We read each site,
                extract signals, and surface what actually separates your winners — by lift, from your own
                outcomes. A few of each is enough to start.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] font-semibold uppercase tracking-wide text-[#15803d]">Closed-won domains</label>
                  <textarea value={cdWon} onChange={e => setCdWon(e.target.value)} rows={6}
                    placeholder={"acme.com\nglobex.com\n…"}
                    className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-[13px] outline-none focus:border-foreground/40 resize-y font-mono" />
                </div>
                <div>
                  <label className="text-[11px] font-semibold uppercase tracking-wide text-[#b45309]">Closed-lost domains</label>
                  <textarea value={cdLost} onChange={e => setCdLost(e.target.value)} rows={6}
                    placeholder={"initech.com\numbrella.com\n…"}
                    className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-[13px] outline-none focus:border-foreground/40 resize-y font-mono" />
                </div>
              </div>
              {cdResult && (cdResult.linked?.length ?? 0) > 0 && (
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/[0.06] px-3 py-2 text-[12px] text-emerald-800/90">
                  Recognized {cdResult.linked!.length} contact{cdResult.linked!.length === 1 ? "" : "s"} you already had — linked the deal to {cdResult.linked!.map(l => l.name).join(", ")} and resolved their record.
                </div>
              )}
              {cdResult && (
                <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70 mb-1.5">
                    {cdResult.discovered.length > 0
                      ? <>Signals added · {cdResult.discovered.length}{cdResult.mode === "winners" ? " (from your winners)" : " (by lift)"}</>
                      : <>Recorded {cdResult.won} won · {cdResult.lost} lost</>}
                  </div>
                  {cdResult.discovered.length === 0 ? (
                    <p className="text-[12px] text-muted-foreground/70">
                      Read {cdResult.enriched} site{cdResult.enriched === 1 ? "" : "s"} and recorded your deals — but found no clear signal to propose from them yet. Add a few more (especially winners) and run again.
                    </p>
                  ) : (
                    <>
                      <div className="space-y-1">
                        {cdResult.discovered.map((d, i) => (
                          <div key={i} className="flex items-baseline gap-2 text-[12.5px]">
                            <span className="font-semibold tabular-nums w-8" style={{ color: d.weight >= 0 ? "#15803d" : "#b45309" }}>{d.weight > 0 ? "+" : ""}{d.weight}</span>
                            <span className="flex-1 text-foreground/85">{d.label}</span>
                            <span className="text-[11px] text-muted-foreground/60">{d.note}</span>
                          </div>
                        ))}
                      </div>
                      {cdResult.mode === "winners" && (
                        <p className="text-[11px] text-muted-foreground/55 mt-2 leading-snug">A starting point from what your winners share — it sharpens into true win/loss lift as more deals close.</p>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
            <div className="px-6 py-4 border-t border-border flex items-center justify-between">
              <button onClick={() => { setCdOpen(false); setCdResult(null); setCdWon(""); setCdLost(""); }} className="text-[13px] font-semibold text-foreground/70 hover:text-foreground transition-colors">Close</button>
              {cdResult ? (
                <button onClick={() => { setCdOpen(false); setCdResult(null); setCdWon(""); setCdLost(""); load(); }}
                  className="h-9 px-5 rounded-lg bg-primary text-primary-foreground text-[13px] font-semibold hover:bg-primary/90 transition-colors">
                  Done
                </button>
              ) : (
                <button onClick={runClosedDeals} disabled={cdRunning}
                  className="h-9 px-5 rounded-lg bg-primary text-primary-foreground text-[13px] font-semibold hover:bg-primary/90 disabled:opacity-50 transition-colors">
                  {cdRunning ? "Reading sites & discovering…" : "Discover my signals"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
