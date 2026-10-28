import { useEffect, useRef, useState } from "react";
import { Plus, X, Check, Pencil, Sparkles } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { useAuth } from "@/contexts/AuthContext";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

const apiUrl = import.meta.env.VITE_API_URL ?? "";
const ACCENT = "#FF5C00";

// Ideal Customer Profile — a VIEW of the model, not a form. At a glance: who's a
// fit, what the pain is, where every scored account falls on Fit × Intent, and how
// won/lost deals are sharpening it. Editing the definition is tucked behind a
// toggle. See product/icp-model-layered-redesign.md.

// ── types ──────────────────────────────────────────────────────────────────────
type Layer = "fit" | "pain" | "intent" | "ability";
type Sig = { id?: string; key: string; label: string; weight: number; layer?: Layer; rule?: { feature?: string; disqualify?: boolean }; active: boolean; added_in?: string | null; manual?: boolean };
// Provenance shown on the ICP page: what the operator defined (their ICP doc or a
// criterion they typed here) vs what the learning loop discovered from closed deals.
type Origin = "you" | "agent";
const originOf = (s: Sig): Origin => (s.added_in ? "agent" : "you");
type TopSig = { key: string; label: string; weight: number; lift: number | null; fires: number };
type Cohort = { count: number; avg_outcome: number | null };
type PatternSig = { key: string; label: string; count: number; share: number };
type DealPatterns = { won: { total: number; signals: PatternSig[] }; lost: { total: number; signals: PatternSig[] } };
type Substrate = {
  predictions: { total: number; open: number; won: number; lost: number; resolved: number; fit: number };
  calibration: { gap: number | null; resolved: number; high?: Cohort; low?: Cohort; trend?: { week: string; n: number; gap: number | null }[] };
  top_signals: TopSig[];
  deal_patterns?: DealPatterns;
};
type Acct = { id: string; name: string | null; company?: string | null; fit: number; intent: number; tier: string | null };

const LAYER_TITLE: Record<Layer, string> = { fit: "Who's a fit", pain: "What's the pain", intent: "Signals of timing", ability: "Ability to buy" };

// which quadrant an account sits in
type Quad = "work" | "research" | "nurture" | "pass";
const quadOf = (a: Acct): Quad => (a.fit >= 70 ? (a.intent >= 50 ? "work" : "research") : (a.intent >= 50 ? "nurture" : "pass"));
const QUAD_LABEL: Record<Quad, string> = { work: "Work now", research: "Research", nurture: "Nurture", pass: "Pass" };

export default function IcpModel() {
  const { userData, session } = useAuth();
  const token = session?.access_token;
  const workspaceId = userData?.workspace?.id ?? "";

  const [sub, setSub] = useState<Substrate | null>(null);
  const [sigs, setSigs] = useState<Sig[]>([]);
  const [accts, setAccts] = useState<Acct[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = async () => {
    if (!token || !workspaceId) return;
    const auth = { headers: { Authorization: `Bearer ${token}` } };
    const q = `workspaceId=${encodeURIComponent(workspaceId)}`;
    const get = (p: string) => fetch(`${apiUrl}/api/mind/${p}?${q}`, auth).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    // View essentials first (fast) — render the page as soon as these land.
    const [sc, m] = await Promise.all([get("scorecard"), get("icp-map")]);
    if (sc?.signals) setSigs(sc.signals.filter((x: Sig) => x.active));
    if (m?.accounts) setAccts(m.accounts);
    setLoading(false);
    // Learning data is heavier — let it fill in without blocking the page.
    get("substrate").then((s) => s && setSub(s));
  };
  useEffect(() => { reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [token, workspaceId]);

  // ── criterion CRUD (the 4-column editable model) ──────────────────────────────
  const authJson = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const addSignal = async (layer: Layer, label: string, disqualify: boolean) => {
    if (!token || !workspaceId) return;
    await fetch(`${apiUrl}/api/mind/scorecard/signals`, {
      method: "POST", headers: authJson,
      body: JSON.stringify({ workspaceId, layer, label, disqualify }),
    });
    reload();
  };
  const renameSignal = async (id: string, label: string) => {
    if (!token || !workspaceId || !id) return;
    await fetch(`${apiUrl}/api/mind/scorecard/signals/${id}`, {
      method: "PATCH", headers: authJson,
      body: JSON.stringify({ workspaceId, label }),
    });
    reload();
  };
  const deleteSignal = async (id: string) => {
    if (!token || !workspaceId || !id) return;
    await fetch(`${apiUrl}/api/mind/scorecard/signals/${id}`, {
      method: "DELETE", headers: authJson,
      body: JSON.stringify({ workspaceId }),
    });
    reload();
  };

  const won = sub?.predictions.won ?? 0, lost = sub?.predictions.lost ?? 0;
  const scored = sub?.predictions.total ?? accts.length;
  const winRate = won + lost > 0 ? Math.round((won / (won + lost)) * 100) : null;

  return (
    <div className="flex h-full">
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[1180px] px-8 py-5">
        <div className="mb-1 flex items-center justify-between gap-3">
          <h1 className="text-[16px] font-semibold tracking-tight text-foreground">ICP</h1>
          <Dialog>
            <DialogTrigger asChild>
              <button title="Sharpen from closed deals" className="flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-border/70 px-2.5 py-1 text-[11.5px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                <Plus className="h-3.5 w-3.5" strokeWidth={2} /> Closed deals
              </button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-md">
              <DialogHeader><DialogTitle>Sharpen from closed deals</DialogTitle></DialogHeader>
              <ClosedDealsForm token={token!} workspaceId={workspaceId} onDone={reload} />
            </DialogContent>
          </Dialog>
        </div>

        {loading ? (
          <div className="mt-8 text-[13px] text-muted-foreground">Loading…</div>
        ) : (
          <div className="mt-3 space-y-3.5">
            {/* metrics on top — scored · won · lost · win rate */}
            <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
              <Kpi label="Scored" value={scored.toLocaleString()} sub="accounts scored" />
              <Kpi label="Won" value={won.toLocaleString()} sub="closed-won" valueColor="#059669" />
              <Kpi label="Lost" value={lost.toLocaleString()} sub="closed-lost" valueColor="#dc2626" />
              <Kpi label="Win rate" value={winRate != null ? `${winRate}%` : "—"} sub={won + lost > 0 ? `of ${won + lost} closed` : "no deals yet"} valueColor={ACCENT} />
            </div>

            {/* the 4-column editable ICP model */}
            <LayerColumns sigs={sigs} onAdd={addSignal} onRename={renameSignal} onDelete={deleteSignal} />

            {/* the pattern of a win vs the pattern of a loss */}
            <div className="grid gap-2.5 lg:grid-cols-2">
              <DealPattern kind="won" data={sub?.deal_patterns?.won} loading={!sub} />
              <DealPattern kind="lost" data={sub?.deal_patterns?.lost} loading={!sub} />
            </div>
          </div>
        )}
      </div>
      </div>
    </div>
    </div>
  );
}

// ── the 4-column editable ICP model ───────────────────────────────────────────────
// Fit · Pain · Intent · Ability, side by side — the four things an account is scored
// against. Each column lists its criteria as rows, tagged by who put them there (You vs
// the Agent's learning loop), and each column has its own [+ add] so an operator can
// define their ICP directly. Columns stay short: the first few show inline, the rest
// live behind "see more" so a column never grows without bound.
// See product/icp-model-layered-redesign.md.
const VISIBLE = 4;

function LayerColumns({ sigs, onAdd, onRename, onDelete }: {
  sigs: Sig[];
  onAdd: (layer: Layer, label: string, disqualify: boolean) => void;
  onRename: (id: string, label: string) => void;
  onDelete: (id: string) => void;
}) {
  const LAYERS: Layer[] = ["fit", "pain", "intent", "ability"];
  const byLayer = (L: Layer) => sigs.filter((s) => (s.layer ?? "fit") === L)
    .sort((a, b) => Number(originOf(a) === "agent") - Number(originOf(b) === "agent") || b.weight - a.weight);
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      {LAYERS.map((L) => (
        <LayerColumn key={L} layer={L} rows={byLayer(L)} onAdd={onAdd} onRename={onRename} onDelete={onDelete} />
      ))}
    </div>
  );
}

function LayerColumn({ layer, rows, onAdd, onRename, onDelete }: {
  layer: Layer; rows: Sig[];
  onAdd: (layer: Layer, label: string, disqualify: boolean) => void;
  onRename: (id: string, label: string) => void;
  onDelete: (id: string) => void;
}) {
  const [addingInline, setAddingInline] = useState(false);
  const shown = rows.slice(0, VISIBLE);
  const extra = rows.length - shown.length;
  return (
    <section className="flex flex-col rounded-2xl border border-border/70 bg-card">
      <div className="flex items-baseline justify-between gap-2 border-b border-border/60 px-3.5 py-2">
        <h2 className="section-title">{LAYER_TITLE[layer]}</h2>
        <span className="text-[10.5px] tabular-nums text-muted-foreground/45">{rows.length}</span>
      </div>

      <div className="flex-1 space-y-0.5 p-2">
        {rows.length === 0 && !addingInline && (
          <p className="px-1.5 py-2 text-[11.5px] text-muted-foreground/40">Nothing here yet.</p>
        )}
        {shown.map((s) => (
          <CriterionRow key={s.id ?? s.key} sig={s} onRename={onRename} onDelete={onDelete} />
        ))}

        {extra > 0 && (
          <Dialog>
            <DialogTrigger asChild>
              <button className="w-full rounded-lg px-1.5 py-1 text-left text-[11.5px] font-medium text-muted-foreground/70 transition-colors hover:bg-muted/40 hover:text-foreground">
                See all {rows.length} →
              </button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-md">
              <DialogHeader><DialogTitle>{LAYER_TITLE[layer]}</DialogTitle></DialogHeader>
              <div className="-mx-1 max-h-[60vh] space-y-1 overflow-y-auto px-1">
                {rows.map((s) => (
                  <CriterionRow key={s.id ?? s.key} sig={s} onRename={onRename} onDelete={onDelete} />
                ))}
              </div>
              <div className="border-t border-border/60 pt-2">
                <AddCriterion layer={layer} onAdd={onAdd} />
              </div>
            </DialogContent>
          </Dialog>
        )}

        <AddCriterion layer={layer} onAdd={onAdd} open={addingInline} onOpenChange={setAddingInline} />
      </div>
    </section>
  );
}

// The inline "add criterion" affordance — a quiet button that expands into a one-line
// input with an optional Disqualifier toggle. Used both in a column and in the see-more
// popup, so it owns its own draft state.
function AddCriterion({ layer, onAdd, open, onOpenChange }: {
  layer: Layer;
  onAdd: (layer: Layer, label: string, disqualify: boolean) => void;
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
}) {
  const [selfOpen, setSelfOpen] = useState(false);
  const adding = open ?? selfOpen;
  const setAdding = onOpenChange ?? setSelfOpen;
  const [draft, setDraft] = useState("");
  const [disq, setDisq] = useState(false);
  const close = () => { setDraft(""); setDisq(false); setAdding(false); };
  const commit = () => { const label = draft.trim(); if (label) onAdd(layer, label, disq); close(); };
  const placeholder = layer === "fit" ? "e.g. Series B–C SaaS" : layer === "pain" ? "e.g. fragmented GTM data" : layer === "intent" ? "e.g. hiring RevOps" : "e.g. budget owner engaged";

  if (!adding) {
    return (
      <button onClick={() => setAdding(true)} className="flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-[11.5px] text-muted-foreground/70 transition-colors hover:bg-muted/40 hover:text-foreground">
        <Plus className="h-3.5 w-3.5" strokeWidth={2} /> Add criterion
      </button>
    );
  }
  return (
    <div className="rounded-lg border border-border bg-background p-2">
      <input
        autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") close(); }}
        placeholder={placeholder}
        className="w-full bg-transparent text-[12.5px] text-foreground placeholder:text-muted-foreground/40 focus:outline-none"
      />
      <div className="mt-2 flex items-center justify-between">
        <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground/70">
          <input type="checkbox" checked={disq} onChange={(e) => setDisq(e.target.checked)} className="h-3 w-3 accent-red-500" />
          Disqualifier
        </label>
        <div className="flex items-center gap-1">
          <button onClick={close} className="rounded-md px-2 py-1 text-[11.5px] text-muted-foreground hover:text-foreground">Cancel</button>
          <button onClick={commit} disabled={!draft.trim()} className="rounded-md px-2 py-1 text-[11.5px] font-medium text-white transition-opacity disabled:opacity-40" style={{ background: ACCENT }}>Add</button>
        </div>
      </div>
    </div>
  );
}

// One criterion row — its label, a You/Agent provenance mark, and (on hover) edit + delete.
// Learned (Agent) rows are read-only here: the loop owns them; you tune them via closed deals.
function CriterionRow({ sig, onRename, onDelete }: { sig: Sig; onRename: (id: string, label: string) => void; onDelete: (id: string) => void }) {
  const origin = originOf(sig);
  const isYou = origin === "you";
  const disq = sig.weight < 0 || sig.rule?.disqualify === true;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(sig.label);
  const canEdit = isYou && !!sig.id;

  if (editing) {
    return (
      <div className="flex items-center gap-1 rounded-lg border border-border bg-background px-2 py-1.5">
        <input
          autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && draft.trim()) { onRename(sig.id!, draft.trim()); setEditing(false); } if (e.key === "Escape") { setDraft(sig.label); setEditing(false); } }}
          className="min-w-0 flex-1 bg-transparent text-[12.5px] text-foreground focus:outline-none"
        />
        <button onClick={() => { if (draft.trim()) { onRename(sig.id!, draft.trim()); setEditing(false); } }} className="flex-shrink-0 text-emerald-500 hover:text-emerald-600"><Check className="h-3.5 w-3.5" /></button>
        <button onClick={() => { setDraft(sig.label); setEditing(false); }} className="flex-shrink-0 text-muted-foreground/50 hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
      </div>
    );
  }
  return (
    <div className="group flex items-center gap-2 rounded-lg px-1.5 py-1 transition-colors hover:bg-muted/40">
      <span
        className="mt-[3px] h-1.5 w-1.5 flex-shrink-0 self-start rounded-full"
        style={{ background: isYou ? ACCENT : "hsl(var(--muted-foreground) / 0.4)" }}
        title={isYou ? "You defined this" : "Your agent learned this"}
      />
      <span className={`min-w-0 flex-1 text-[12.5px] leading-snug ${disq ? "text-red-500/80 line-through decoration-red-500/30" : "text-foreground/85"}`}>{sig.label}</span>
      {!isYou && <Sparkles className="h-3 w-3 flex-shrink-0 self-start text-muted-foreground/40" title="Your agent learned this" />}
      {canEdit && (
        <span className="flex flex-shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <button onClick={() => setEditing(true)} className="text-muted-foreground/50 hover:text-foreground"><Pencil className="h-3 w-3" /></button>
          <button onClick={() => onDelete(sig.id!)} className="text-muted-foreground/50 hover:text-red-500"><X className="h-3.5 w-3.5" /></button>
        </span>
      )}
    </div>
  );
}

// A clean headline metric — big number, quiet label. Minimal card.
function Kpi({ label, value, sub, valueColor }: { label: string; value: string; sub?: string; accent?: boolean; valueColor?: string }) {
  return (
    <div className="rounded-xl border border-border/60 bg-card px-3.5 py-2.5">
      <div className="text-[11px] font-medium text-muted-foreground/55">{label}</div>
      <div className="mt-1 text-[21px] font-semibold leading-none tabular-nums tracking-tight" style={{ color: valueColor ?? "hsl(var(--foreground))" }}>{value}</div>
      {sub && <div className="mt-1 text-[10.5px] text-muted-foreground/50">{sub}</div>}
    </div>
  );
}

// The definition — who you sell to, read plainly. The active scoring signals grouped by the
// layer they answer (who's a fit, the pain, timing, ability to buy), each as clean chips.
function DefinitionCards({ sigs }: { sigs: Sig[] }) {
  const LAYERS: Layer[] = ["fit", "pain", "intent", "ability"];
  const byLayer = (L: Layer) => sigs.filter((s) => (s.layer ?? "fit") === L).sort((a, b) => b.weight - a.weight);
  const present = LAYERS.filter((L) => byLayer(L).length > 0);
  if (present.length === 0) {
    return (
      <section className="rounded-2xl border border-dashed border-border/70 bg-card px-5 py-8 text-center">
        <p className="text-[13.5px] font-medium text-foreground">Your ICP isn't defined yet</p>
        <p className="mt-1 text-[12.5px] text-muted-foreground/70">Use “Edit definition” to describe who you sell to — the personas, the signals of fit, and the disqualifiers.</p>
      </section>
    );
  }
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {present.map((L) => (
        <section key={L} className="rounded-2xl border border-border/70 bg-card p-5">
          <div className="flex items-baseline justify-between">
            <h2 className="section-title">{LAYER_TITLE[L]}</h2>
            <span className="text-[11px] tabular-nums text-muted-foreground/45">{byLayer(L).length}</span>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {byLayer(L).map((s) => (
              <span key={s.key} className="rounded-full border border-border/70 bg-muted/30 px-2.5 py-1 text-[12px] text-foreground/80">{s.label}</span>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

// ── the two bar charts: the pattern of a win vs the pattern of a loss ─────────────
// Each closed-deal cohort profiled by the signals that fired across it. A bar per
// signal, its length = share of that cohort's deals carrying it. Side by side, the
// contrast is the read: what your winners share, and what your losses share.
function DealPattern({ kind, data, loading }: { kind: "won" | "lost"; data?: { total: number; signals: PatternSig[] }; loading?: boolean }) {
  const won = kind === "won";
  const color = won ? "#059669" : "#dc2626";
  const title = won ? "Closed won" : "Closed lost";
  const blurb = won ? "the signals your winners share" : "the signals your losses share";
  const rows = data?.signals ?? [];
  const maxShare = Math.max(1, ...rows.map((r) => r.share));
  return (
    <section className="flex flex-col overflow-hidden rounded-2xl border border-border/70 bg-card p-4">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="section-title">{title}</h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground/50">{blurb}</p>
        </div>
        <span className="flex-shrink-0 tabular-nums text-[12px] font-semibold" style={{ color }}>{data?.total ?? 0} deals</span>
      </div>

      <div className="mt-3.5 flex-1">
        {loading ? (
          <div className="flex h-[132px] items-center justify-center text-[12px] text-muted-foreground/40">Reading outcomes…</div>
        ) : !data || data.total === 0 ? (
          <div className="flex h-[132px] flex-col items-center justify-center gap-1 text-center">
            <span className="text-[12.5px] font-medium text-muted-foreground/55">No {won ? "won" : "lost"} deals yet</span>
            <span className="text-[11px] text-muted-foreground/40">Add closed deals to see the pattern.</span>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex h-[132px] items-center justify-center text-center text-[12px] text-muted-foreground/45">No signal fired across these deals yet.</div>
        ) : (
          <div className="space-y-2.5">
            {rows.slice(0, 5).map((s) => (
              <div key={s.key}>
                <div className="mb-1 flex items-baseline justify-between gap-3">
                  <span className="truncate text-[12px] leading-snug text-foreground/85">{s.label}</span>
                  <span className="flex-shrink-0 text-[11px] font-semibold tabular-nums" style={{ color }}>{s.share}%</span>
                </div>
                <span className="block h-2.5 w-full overflow-hidden rounded-full bg-muted/40">
                  <span className="block h-full rounded-full transition-all duration-500" style={{ width: `${Math.max(4, (s.share / maxShare) * 100)}%`, background: `linear-gradient(90deg, ${color}bb, ${color})` }} />
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

// ── the ICP score, made transparent — the four categories an account is scored on ─
const CATS: { layer: Layer; label: string; blurb: string }[] = [
  { layer: "fit", label: "Demographics", blurb: "who they are" },
  { layer: "pain", label: "Pain", blurb: "the problem they have" },
  { layer: "intent", label: "Intent", blurb: "the timing" },
  { layer: "ability", label: "Ability", blurb: "can they buy" },
];

function IcpComposition({ sigs }: { sigs: Sig[] }) {
  const byLayer = (L: Layer) => sigs.filter((s) => (s.layer ?? "fit") === L).sort((a, b) => b.weight - a.weight);
  const weightOf = (L: Layer) => byLayer(L).reduce((a, s) => a + (s.weight || 0), 0);
  const total = CATS.reduce((a, c) => a + weightOf(c.layer), 0) || 1;
  const maxW = Math.max(0.0001, ...CATS.map((c) => weightOf(c.layer)));
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {CATS.map((c) => {
        const sig = byLayer(c.layer);
        const w = weightOf(c.layer);
        const share = Math.round((w / total) * 100);
        return (
          <section key={c.layer} className="rounded-2xl border border-border/70 bg-card p-5">
            <div className="flex items-baseline justify-between gap-2">
              <div>
                <h3 className="section-title">{c.label}</h3>
                <p className="text-[11px] text-muted-foreground/50">{c.blurb}</p>
              </div>
              <span className="flex-shrink-0 text-[15px] font-semibold tabular-nums" style={{ color: ACCENT }}>{share}%</span>
            </div>
            <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-muted/40">
              <span className="block h-full rounded-full" style={{ width: `${Math.max(3, (w / maxW) * 100)}%`, background: ACCENT }} />
            </div>
            {sig.length > 0 ? (
              <div className="mt-3.5 flex flex-wrap gap-1.5">
                {sig.map((s) => (
                  <span key={s.key} className="rounded-full border border-border/60 bg-muted/25 px-2.5 py-1 text-[11.5px] text-foreground/75">{s.label}</span>
                ))}
              </div>
            ) : (
              <p className="mt-3.5 text-[11.5px] text-muted-foreground/40">Not defined yet.</p>
            )}
          </section>
        );
      })}
    </div>
  );
}

// ── the accuracy read: does high fit actually convert better than low fit? ────────
// The whole promise of an ICP is that it separates winners from losers. The calibration
// gap = avg outcome among score≥70 minus avg outcome among score<70. Positive and growing
// = the model is earning its score. Flat/negative = the definition needs sharpening.
type Verdict = { short: string; long: string; color: string };
function accuracyVerdict(gap: number | null, resolved: number): Verdict {
  if (gap == null || resolved < 4) return { short: "Learning", long: "not enough closed deals yet", color: "#6b7280" };
  if (gap >= 0.2) return { short: "Sharp", long: "fit accounts convert far better", color: "#059669" };
  if (gap >= 0.05) return { short: "Working", long: "fit accounts convert better", color: "#0284c7" };
  if (gap >= -0.02) return { short: "Flat", long: "fit barely separates outcomes", color: "#b45309" };
  return { short: "Off", long: "fit accounts convert worse — re-tune", color: "#dc2626" };
}

function AccuracyPanel({ sub, verdict }: { sub: Substrate | null; verdict: Verdict }) {
  if (!sub) return <div className="text-[12.5px] text-muted-foreground/45">Reading outcomes…</div>;
  const hi = sub.calibration.high, lo = sub.calibration.low;
  const hiPct = hi?.avg_outcome != null ? Math.round(hi.avg_outcome * 100) : null;
  const loPct = lo?.avg_outcome != null ? Math.round(lo.avg_outcome * 100) : null;
  const gap = sub.calibration.gap;
  const gapPts = gap != null ? `${gap >= 0 ? "+" : ""}${Math.round(gap * 100)}` : null;
  const trend = (sub.calibration.trend ?? []).filter((t) => t.gap != null);
  const dir = trend.length >= 2 && trend[trend.length - 1].gap! !== trend[0].gap!
    ? (trend[trend.length - 1].gap! > trend[0].gap! ? "widening" : "narrowing") : "flat";

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-2.5">
        <span className="text-[26px] font-semibold leading-none tabular-nums" style={{ color: verdict.color }}>{verdict.short}</span>
        {gapPts != null && <span className="text-[12px] text-muted-foreground/60">{gapPts} pt separation between fit and non-fit</span>}
      </div>
      {/* high-fit vs low-fit conversion, side by side */}
      <div className="space-y-2.5">
        <CompareBar label="ICP-fit (score ≥ 70)" pct={hiPct} count={hi?.count} color={ACCENT} />
        <CompareBar label="Below fit (score < 70)" pct={loPct} count={lo?.count} color="#94a3b8" />
      </div>
      {/* calibration trend — is the gap widening? */}
      {trend.length >= 2 && (
        <div className="border-t border-border/50 pt-3.5">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11px] font-semibold text-muted-foreground/55">Separation over time</span>
            <span className="text-[11px] tabular-nums" style={{ color: verdict.color }}>{dir}</span>
          </div>
          <Sparkline points={trend.map((t) => t.gap as number)} color={verdict.color} />
        </div>
      )}
    </div>
  );
}
function CompareBar({ label, pct, count, color }: { label: string; pct: number | null; count?: number; color: string }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[12px]">
        <span className="text-foreground">{label}{count != null && <span className="text-muted-foreground/50"> · {count}</span>}</span>
        <span className="tabular-nums font-semibold" style={{ color: pct != null ? color : undefined }}>{pct != null ? `${pct}%` : "—"}</span>
      </div>
      <span className="block h-2.5 w-full overflow-hidden rounded-full bg-muted/60">
        <span className="block h-full rounded-full transition-all" style={{ width: `${Math.max(2, pct ?? 0)}%`, background: color, opacity: 0.9 }} />
      </span>
    </div>
  );
}
function Sparkline({ points, color }: { points: number[]; color: string }) {
  if (points.length < 2) return null;
  const W = 300, H = 40, pad = 3;
  const lo = Math.min(0, ...points), hi = Math.max(0.01, ...points);
  const x = (i: number) => pad + (i / (points.length - 1)) * (W - pad * 2);
  const y = (v: number) => pad + (1 - (v - lo) / (hi - lo)) * (H - pad * 2);
  const d = points.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const zeroY = y(0);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 44 }} preserveAspectRatio="none">
      <line x1={0} y1={zeroY} x2={W} y2={zeroY} className="stroke-border" strokeWidth={1} strokeDasharray="3 3" />
      <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <circle cx={x(points.length - 1)} cy={y(points[points.length - 1])} r={2.5} fill={color} />
    </svg>
  );
}

function WhoCloses({ sub }: { sub: Substrate | null }) {
  if (!sub) return <div className="text-[12.5px] text-muted-foreground/45">Reading outcomes…</div>;
  const drivers = (sub.top_signals ?? []).filter((t) => t.lift != null).sort((a, b) => b.lift! - a.lift!).slice(0, 6);
  if (drivers.length === 0) {
    return <div className="text-[12px] leading-relaxed text-muted-foreground/50">No signal has separated your wins from losses yet. Add closed deals so the model can learn what your winners have in common.</div>;
  }
  const maxLift = Math.max(...drivers.map((d) => d.lift!));
  return (
    <div className="space-y-1.5">
      {drivers.map((d) => (
        <div key={d.key} className="flex items-center gap-2">
          <span className="w-44 flex-shrink-0 truncate text-[12px] text-foreground">{d.label}</span>
          <span className="h-2 flex-1 rounded-full bg-muted/60">
            <span className="block h-full rounded-full" style={{ width: `${Math.max(6, (d.lift! / maxLift) * 100)}%`, background: ACCENT, opacity: 0.85 }} />
          </span>
          <span className="flex-shrink-0 text-[11px] tabular-nums text-muted-foreground/70">{d.lift}×</span>
        </div>
      ))}
    </div>
  );
}

// ── the Fit × Intent quadrant (hand-rolled SVG, minimal) ─────────────────────────
function FitIntentMap({ accounts }: { accounts: Acct[] }) {
  const navigate = useNavigate();
  const [hover, setHover] = useState<Acct | null>(null);
  const W = 980, H = 460, m = { l: 30, r: 26, t: 30, b: 34 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const px = (fit: number) => m.l + (Math.max(0, Math.min(100, fit)) / 100) * pw;
  const py = (intent: number) => m.t + (1 - Math.max(0, Math.min(100, intent)) / 100) * ph;
  const vx = px(70), hy = py(50);
  const x1 = m.l + pw, y1 = m.t + ph;
  const counts = accounts.reduce((a, c) => { a[quadOf(c)]++; return a; }, { work: 0, research: 0, nurture: 0, pass: 0 } as Record<Quad, number>);
  const total = accounts.length || 1;
  const pctOf = (n: number) => Math.round((n / total) * 100);

  if (accounts.length === 0) {
    return <div className="flex h-[240px] items-center justify-center rounded-xl border border-dashed border-border text-[12.5px] text-muted-foreground">No scored accounts yet — enrich a lead list to fill the map.</div>;
  }

  const quads = [
    { k: "work", x: vx, y: m.t, w: x1 - vx, h: hy - m.t, fill: ACCENT, op: 0.06 },
    { k: "nurture", x: m.l, y: m.t, w: vx - m.l, h: hy - m.t, fill: "#64748b", op: 0.02 },
    { k: "research", x: vx, y: hy, w: x1 - vx, h: y1 - hy, fill: "#64748b", op: 0.03 },
    { k: "pass", x: m.l, y: hy, w: vx - m.l, h: y1 - hy, fill: "#64748b", op: 0.012 },
  ];
  const hx = hover ? px(hover.fit) : 0, hyp = hover ? py(hover.intent) : 0;

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full select-none" style={{ maxHeight: 500 }}>
        {/* quadrant tints */}
        {quads.map((q) => <rect key={q.k} x={q.x} y={q.y} width={q.w} height={q.h} rx="4" fill={q.fill} fillOpacity={q.op} />)}
        {/* soft frame + threshold dividers */}
        <rect x={m.l} y={m.t} width={pw} height={ph} rx="12" className="fill-none stroke-border/70" strokeWidth="1" />
        <line x1={vx} y1={m.t + 6} x2={vx} y2={y1 - 6} className="stroke-border" strokeWidth="1" strokeDasharray="2 4" strokeOpacity={0.7} />
        <line x1={m.l + 6} y1={hy} x2={x1 - 6} y2={hy} className="stroke-border" strokeWidth="1" strokeDasharray="2 4" strokeOpacity={0.7} />
        {/* quadrant labels — name + count + share, tucked into each corner */}
        <QLabel x={vx + 12} y={m.t + 18} anchor="start" accent>Work now</QLabel>
        <QCount x={vx + 12} y={m.t + 36} anchor="start">{counts.work} · {pctOf(counts.work)}%</QCount>
        <QLabel x={x1 - 12} y={y1 - 24} anchor="end">Research</QLabel>
        <QCount x={x1 - 12} y={y1 - 8} anchor="end">{counts.research} · {pctOf(counts.research)}%</QCount>
        <QLabel x={m.l + 12} y={m.t + 18} anchor="start">Nurture</QLabel>
        <QCount x={m.l + 12} y={m.t + 36} anchor="start">{counts.nurture} · {pctOf(counts.nurture)}%</QCount>
        <QLabel x={m.l + 12} y={y1 - 24} anchor="start">Pass</QLabel>
        <QCount x={m.l + 12} y={y1 - 8} anchor="start">{counts.pass} · {pctOf(counts.pass)}%</QCount>
        {/* hover crosshair */}
        {hover && <>
          <line x1={hx} y1={hyp} x2={hx} y2={y1} className="stroke-border" strokeWidth="1" strokeDasharray="2 3" strokeOpacity={0.6} />
          <line x1={m.l} y1={hyp} x2={hx} y2={hyp} className="stroke-border" strokeWidth="1" strokeDasharray="2 3" strokeOpacity={0.6} />
        </>}
        {/* dots */}
        {accounts.map((a) => {
          const work = quadOf(a) === "work";
          const on = hover?.id === a.id;
          return <circle key={a.id} cx={px(a.fit)} cy={py(a.intent)} r={on ? 6 : work ? 4.5 : 3.5}
            fill={work ? ACCENT : "#94a3b8"} fillOpacity={on ? 1 : work ? 0.92 : 0.48}
            stroke="hsl(var(--card))" strokeWidth={1} style={{ cursor: "pointer", transition: "r 0.1s" }}
            onMouseEnter={() => setHover(a)} onMouseLeave={() => setHover((h) => (h?.id === a.id ? null : h))}
            onClick={() => navigate(`/contacts/${a.id}`)} />;
        })}
        {hover && <circle cx={hx} cy={hyp} r="10" fill="none" stroke={ACCENT} strokeWidth="1.25" strokeOpacity="0.5" className="pointer-events-none" />}
        {hover && <MapTooltip x={hx} y={hyp} a={hover} W={W} />}
        {/* axis titles */}
        <text x={m.l + pw / 2} y={H - 4} textAnchor="middle" className="fill-muted-foreground/70" fontSize="10.5" fontWeight={500}>Fit →</text>
        <text x={12} y={m.t + ph / 2} textAnchor="middle" transform={`rotate(-90 12 ${m.t + ph / 2})`} className="fill-muted-foreground/70" fontSize="10.5" fontWeight={500}>Intent →</text>
      </svg>
      <div className="mt-1 flex items-center gap-4 px-1 text-[11px] text-muted-foreground/60">
        <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full" style={{ background: ACCENT }} /> Work now — high fit &amp; intent</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full bg-[#94a3b8]" /> Everyone else</span>
        <span className="ml-auto tabular-nums">{accounts.length} accounts</span>
      </div>
    </div>
  );
}

// ── the book by quadrant — a clean metric column beside the map (no icons) ────────
const quadCounts = (accts: Acct[]) =>
  accts.reduce((a, c) => { a[quadOf(c)]++; return a; }, { work: 0, research: 0, nurture: 0, pass: 0 } as Record<Quad, number>);

function QuadrantMetrics({ accounts }: { accounts: Acct[] }) {
  const counts = quadCounts(accounts);
  const total = accounts.length || 1;
  const rows = [
    { k: "work", label: "Work now", sub: "high fit · high intent", accent: true },
    { k: "research", label: "Research", sub: "high fit · low intent" },
    { k: "nurture", label: "Nurture", sub: "low fit · high intent" },
    { k: "pass", label: "Pass", sub: "low fit · low intent" },
  ] as const;
  if (accounts.length === 0) {
    return <div className="py-6 text-center text-[12px] text-muted-foreground/50">No scored accounts yet.</div>;
  }
  return (
    <div className="divide-y divide-border/50">
      {rows.map((r) => (
        <div key={r.k} className="flex items-center justify-between py-3 first:pt-0 last:pb-0">
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-foreground">{r.label}</div>
            <div className="text-[11px] text-muted-foreground/55">{r.sub}</div>
          </div>
          <div className="flex items-baseline gap-1.5 tabular-nums">
            <span className="text-[20px] font-semibold" style={{ color: r.accent ? ACCENT : "hsl(var(--foreground))" }}>{counts[r.k]}</span>
            <span className="text-[11px] text-muted-foreground/45">{Math.round((counts[r.k] / total) * 100)}%</span>
          </div>
        </div>
      ))}
    </div>
  );
}
function QLabel({ x, y, anchor, accent, children }: { x: number; y: number; anchor: "start" | "end"; accent?: boolean; children: React.ReactNode }) {
  return <text x={x} y={y} textAnchor={anchor} fontSize="11.5" fontWeight={600} className={accent ? "" : "fill-muted-foreground/70"} fill={accent ? ACCENT : undefined}>{children}</text>;
}
function QCount({ x, y, anchor, children }: { x: number; y: number; anchor: "start" | "end"; children: React.ReactNode }) {
  return <text x={x} y={y} textAnchor={anchor} fontSize="10" fontWeight={500} className="fill-muted-foreground/45 tabular-nums">{children}</text>;
}
function MapTooltip({ x, y, a, W }: { x: number; y: number; a: Acct; W: number }) {
  const name = (a.name || "Unknown").slice(0, 26);
  const sub = `${a.company ? a.company.slice(0, 22) + " · " : ""}Fit ${a.fit} · Intent ${a.intent}`;
  const tw = 180, th = 42;
  let tx = x + 14, ty = y - th - 10;
  if (tx + tw > W - 4) tx = x - tw - 14;
  if (ty < 18) ty = y + 14;
  return (
    <g className="pointer-events-none">
      <rect x={tx} y={ty} width={tw} height={th} rx="7" className="fill-background stroke-border" strokeWidth="1" style={{ filter: "drop-shadow(0 6px 14px rgba(0,0,0,0.12))" }} />
      <text x={tx + 11} y={ty + 17} fontSize="11.5" fontWeight={600} className="fill-foreground">{name}</text>
      <text x={tx + 11} y={ty + 31} fontSize="9.5" className="fill-muted-foreground">{sub}</text>
    </g>
  );
}

// Paste closed-won / closed-lost domains → enrich + contrastive lift + re-weight.
// This is the manual path into the learning loop (POST /api/mind/closed-deals).
function ClosedDealsForm({ token, workspaceId, onDone }: { token: string; workspaceId: string; onDone: () => void }) {
  const [won, setWon] = useState("");
  const [lost, setLost] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ enriched?: number; linked?: unknown[]; discovered?: { label: string }[] } | null>(null);

  const run = async () => {
    const w = s2a(won.replace(/[\n\r]+/g, ","));
    const l = s2a(lost.replace(/[\n\r]+/g, ","));
    if (!w.length && !l.length) { setErr("Add at least one domain."); return; }
    setBusy(true); setErr(null); setResult(null);
    try {
      const r = await fetch(`${apiUrl}/api/mind/closed-deals`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, won: w, lost: l }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) setErr(d.detail || d.error || "Couldn't run the analysis.");
      else { setResult(d); onDone(); }
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div>
      <p className="mb-2.5 text-[11.5px] leading-snug text-muted-foreground/70">Paste the domains of deals you won and lost. Nous enriches each, finds what separates winners from losers, and re-weights the model.</p>
      <div className="space-y-2">
        <DomainInput label="Won" color="#059669" value={won} onChange={setWon} placeholder="acme.example, globex.example" />
        <DomainInput label="Lost" color="#dc2626" value={lost} onChange={setLost} placeholder="tinyco.example, misfit.example" />
      </div>
      <div className="mt-2.5 flex items-center gap-3">
        <button onClick={run} disabled={busy} className="rounded-lg px-3 py-[7px] text-[12.5px] font-medium text-white transition-opacity disabled:opacity-50" style={{ background: ACCENT }}>{busy ? "Analyzing…" : "Run analysis"}</button>
        {err && <span className="text-[12px] text-red-500">{err}</span>}
      </div>
      {result && (
        <div className="mt-3 rounded-lg border border-border bg-muted/20 p-3 text-[12px] leading-relaxed text-muted-foreground">
          Enriched {result.enriched ?? 0}, linked {result.linked?.length ?? 0} account(s).{" "}
          {result.discovered?.length
            ? <>Discovered {result.discovered.length} new signal(s): <span className="text-foreground">{result.discovered.map((x) => x.label).join(", ")}</span>.</>
            : <>No new signal separated them yet — add more deals on both sides.</>}
        </div>
      )}
    </div>
  );
}
function DomainInput({ label, color, value, onChange, placeholder }: { label: string; color: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-1.5 w-10 flex-shrink-0 text-[11px] font-semibold" style={{ color }}>{label}</span>
      <textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} rows={2}
        className="flex-1 resize-none rounded-md border border-border bg-background px-2.5 py-1.5 text-[12.5px] text-foreground focus:outline-none focus:ring-1 focus:ring-ring/40" />
    </div>
  );
}

// ── primitives (match the app: soft 2xl cards, muted labels, tabular nums) ───────
function Panel({ title, note, action, className, children }: { title: string; note?: string; action?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return (
    <section className={`overflow-hidden rounded-2xl border border-border/70 bg-card ${className || ""}`}>
      <div className="flex items-center justify-between gap-3 px-5 pt-4">
        <h2 className="section-title">{title}</h2>
        {action ? action : note ? <span className="text-[11.5px] text-muted-foreground/55">{note}</span> : null}
      </div>
      <div className="px-5 pb-5 pt-4">{children}</div>
    </section>
  );
}
// ── the definition editor (tucked; edits the YAML dials, auto-saves) ─────────────
type EPersona = { id?: string; reason: string; weight: number; role_any: string };
type ETerm = { weight: number; any: string };
type EBand = { weight: number; min: number; max: number };
type ESignal = { reason: string; weight: number; any: string; layer?: Layer };
type EDisq = { reason: string; any: string };
type EModel = { base: number; personas: EPersona[]; firmographics: { location: ETerm[]; size: EBand[]; type: ETerm[] }; signals: ESignal[]; disqualifiers: EDisq[]; _raw: any };

const a2s = (a: unknown) => (Array.isArray(a) ? a.join(", ") : "");
const s2a = (s: string) => String(s || "").split(",").map((t) => t.trim()).filter(Boolean);
const nz = (v: unknown, d = 0) => (typeof v === "number" && !Number.isNaN(v) ? v : d);
const PAIN_KW = ["fragment", "manual", "sprawl", "disconnect", "data foundation", "single source", "scattered", "stitch", "silo", "not in market", "happy with", "no need", "data pain"];
const sigLayer = (s: ESignal): Layer => (s.layer === "pain" || s.layer === "intent" || s.layer === "ability" ? s.layer : (PAIN_KW.some((k) => `${s.reason} ${s.any}`.toLowerCase().includes(k)) ? "pain" : "intent"));

function DefinitionEditor({ token, workspaceId, onSaved }: { token: string; workspaceId: string; onSaved: () => void }) {
  const [m, setM] = useState<EModel | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    (async () => {
      const r = await fetch(`${apiUrl}/api/mind/icp-model?workspaceId=${encodeURIComponent(workspaceId)}`, { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json().catch(() => ({}));
      const y = (() => { try { return parseYaml(d.yaml ?? "") || {}; } catch { return {}; } })();
      const fg = y.firmographics || {};
      setM({
        base: nz(y.base, 40),
        personas: (y.personas || []).map((p: any) => ({ id: p.id, reason: p.reason || p.id || "", weight: nz(p.weight), role_any: a2s(p.role_any) })),
        firmographics: {
          location: (fg.location || []).map((t: any) => ({ weight: nz(t.weight), any: a2s(t.any) })),
          size: (fg.size || []).map((b: any) => ({ weight: nz(b.weight), min: nz(b.min), max: nz(b.max) })),
          type: (fg.type || []).map((t: any) => ({ weight: nz(t.weight), any: a2s(t.any) })),
        },
        signals: (y.signals || []).map((s: any) => ({ reason: s.reason || "", weight: nz(s.weight), any: a2s(s.any), layer: s.layer })),
        disqualifiers: (y.disqualifiers || []).map((d2: any) => ({ reason: d2.reason || "", any: a2s(d2.any) })),
        _raw: y,
      });
    })();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [token, workspaceId]);

  const save = async (mm: EModel) => {
    setStatus("saving");
    const yaml = stringifyYaml({
      ...mm._raw, base: mm.base,
      personas: mm.personas.map((p) => ({ ...(p.id ? { id: p.id } : {}), weight: p.weight, reason: p.reason, role_any: s2a(p.role_any) })),
      firmographics: {
        location: mm.firmographics.location.map((t) => ({ weight: t.weight, any: s2a(t.any) })),
        size: mm.firmographics.size.map((b) => ({ weight: b.weight, min: b.min, max: b.max })),
        type: mm.firmographics.type.map((t) => ({ weight: t.weight, any: s2a(t.any) })),
      },
      signals: mm.signals.map((s) => ({ weight: s.weight, reason: s.reason, any: s2a(s.any), layer: sigLayer(s) })),
      disqualifiers: mm.disqualifiers.map((d) => ({ reason: d.reason, any: s2a(d.any) })),
    }, { lineWidth: 0 });
    const r = await fetch(`${apiUrl}/api/mind/icp-model`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId, yaml }) });
    if (r.ok) { setStatus("saved"); onSaved(); } else setStatus("error");
  };
  const patch = (mm: EModel) => { dirty.current = true; setM(mm); clearTimeout(timer.current); timer.current = setTimeout(() => save(mm), 900); };
  if (!m) return null;

  const sigByLayer = (L: Layer) => m.signals.map((s, i) => ({ s, i })).filter(({ s }) => sigLayer(s) === L);
  const addSig = (L: Layer) => patch({ ...m, signals: [...m.signals, { reason: "", weight: L === "pain" ? 10 : 8, any: "", layer: L }] });

  return (
    <section className="rounded-2xl border border-border/70 bg-muted/10 p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="section-title">Edit definition</h2>
        <span className="text-[11px] text-muted-foreground">{status === "saving" ? "Saving…" : status === "error" ? <span className="text-red-500">Couldn't save</span> : status === "saved" ? "Saved" : ""}</span>
      </div>

      <ERow title="Personas (Fit)" onAdd={() => patch({ ...m, personas: [...m.personas, { reason: "", weight: 20, role_any: "" }] })}>
        {m.personas.map((p, i) => (
          <div key={i} className="flex items-center gap-2">
            <Inp value={p.reason} placeholder="Persona" onChange={(v) => patch({ ...m, personas: m.personas.map((x, j) => j === i ? { ...x, reason: v } : x) })} flex />
            <Inp value={p.role_any} placeholder="title keywords" onChange={(v) => patch({ ...m, personas: m.personas.map((x, j) => j === i ? { ...x, role_any: v } : x) })} flex />
            <Wt value={p.weight} onChange={(v) => patch({ ...m, personas: m.personas.map((x, j) => j === i ? { ...x, weight: v } : x) })} />
            <Del onClick={() => patch({ ...m, personas: m.personas.filter((_, j) => j !== i) })} />
          </div>
        ))}
      </ERow>

      {(["pain", "intent", "ability"] as Layer[]).map((L) => (
        <ERow key={L} title={`${LAYER_TITLE[L]} signals`} onAdd={() => addSig(L)}>
          {sigByLayer(L).map(({ s, i }) => (
            <div key={i} className="flex items-center gap-2">
              <Inp value={s.reason} placeholder="What they're doing" onChange={(v) => patch({ ...m, signals: m.signals.map((x, j) => j === i ? { ...x, reason: v } : x) })} flex />
              <Inp value={s.any} placeholder="match terms" onChange={(v) => patch({ ...m, signals: m.signals.map((x, j) => j === i ? { ...x, any: v } : x) })} flex />
              <Wt value={s.weight} onChange={(v) => patch({ ...m, signals: m.signals.map((x, j) => j === i ? { ...x, weight: v } : x) })} />
              <Del onClick={() => patch({ ...m, signals: m.signals.filter((_, j) => j !== i) })} />
            </div>
          ))}
        </ERow>
      ))}

      <ERow title="Never a fit" onAdd={() => patch({ ...m, disqualifiers: [...m.disqualifiers, { reason: "", any: "" }] })}>
        {m.disqualifiers.map((d, i) => (
          <div key={i} className="flex items-center gap-2">
            <Inp value={d.reason} placeholder="Why disqualified" onChange={(v) => patch({ ...m, disqualifiers: m.disqualifiers.map((x, j) => j === i ? { ...x, reason: v } : x) })} flex />
            <Inp value={d.any} placeholder="match terms" onChange={(v) => patch({ ...m, disqualifiers: m.disqualifiers.map((x, j) => j === i ? { ...x, any: v } : x) })} flex />
            <Del onClick={() => patch({ ...m, disqualifiers: m.disqualifiers.filter((_, j) => j !== i) })} />
          </div>
        ))}
      </ERow>
    </section>
  );
}
function ERow({ title, onAdd, children }: { title: string; onAdd: () => void; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold text-muted-foreground/55">{title}</span>
        <button onClick={onAdd} className="text-[12px] text-muted-foreground hover:text-foreground"><span style={{ color: ACCENT }}>+</span> Add</button>
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}
function Inp({ value, onChange, placeholder, flex }: { value: string; onChange: (v: string) => void; placeholder?: string; flex?: boolean }) {
  return <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={`${flex ? "flex-1 min-w-0" : "w-full"} h-8 rounded-md border border-border bg-background px-2.5 text-[12.5px] text-foreground focus:outline-none focus:ring-1 focus:ring-ring/40`} />;
}
function Wt({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return <input type="number" value={Number.isFinite(value) ? value : 0} onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))} className="h-8 w-14 flex-shrink-0 rounded-md border border-border bg-background px-2 text-[12.5px] tabular-nums text-foreground focus:outline-none focus:ring-1 focus:ring-ring/40" />;
}
function Del({ onClick }: { onClick: () => void }) {
  return <button onClick={onClick} className="flex-shrink-0 text-[12px] text-muted-foreground/50 hover:text-red-500">×</button>;
}
