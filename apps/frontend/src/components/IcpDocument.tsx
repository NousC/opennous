// The ICP page as a document (GET-1074). The ICP file is the source of WHO we target (its prose);
// the newest backtest on closed deals is the evidence of how well the score predicts revenue,
// with contact coverage controlled for. Same design as the Win/loss page (GET-1075): one column,
// four numbers, business headings, no helper text, closed deals as a table. The ICP file's learned
// block says the same in the same words (apps/api/src/lib/icpModel.mjs).
import { Fragment, lazy, Suspense, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Loader2, Search } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { Prose } from "@/components/AgentMarkdown";
import { AccountTile } from "@/components/pipeline/DealBits";
import { avatarTint, initialsOf } from "@/components/ui/owner-filter";
import { accountPath } from "@/components/record/listOrder";
import { when } from "@/lib/format";
import { cn } from "@/lib/utils";

const IcpModel = lazy(() => import("@/components/IcpModel"));

const apiUrl = import.meta.env.VITE_API_URL ?? "";
// The report palette (ReportBlocks): won is green, lost is red, nothing else wears them.
const WON = "#2E7D66", LOST = "#B95050", ACCENT = "#FF5C00";

type Tier = "tier_1" | "tier_2" | "tier_3" | "not_icp";
type Side = { won: number; lost: number; rate: number | null };
type Impact = "positive" | "none" | "negative" | "too_few" | "no_data";
type Backtest = {
  ran_at: string;
  coverage: { won: { total: number; scored: number }; lost: { total: number; scored: number } };
  tiers: { tier: Tier; label: string; won: number; lost: number; rate: number | null }[];
  strata: { label: string; fit: Side; rest: Side }[];
  accuracy: {
    key: "validated" | "weak" | "not_validated" | "insufficient"; label: string;
    win_rate: number | null; fit_rate: number | null; rest_rate: number | null;
    raw_ratio: number | null; controlled_ratio: number | null;
    median_contacts: { won: number | null; lost: number | null };
  };
  rules: { key: string; label: string; weight: number; fired_won: number; fired_lost: number; controlled_lift: number | null; impact: Impact }[];
  disqualifiers: { key: string; label: string; capped: number; won: number; status: "review" | "working" | "no_data"; feature: string | null }[];
  data_coverage: { key: string; label: string; share: number }[];
  recommendations: { text: string; meta: string }[];
  period: { from: string | null; to: string | null };
  deals: { id: string; entity_id: string; account: string | null; domain: string | null; contacts: string[]; contacts_total: number; outcome: "won" | "lost"; tier: Tier; score: number; matched: string[]; value_usd: number | null; closed_at: string }[];
};
type Page = {
  file: { id: string; title: string; updated_at: string | null; prose: string } | null;
  latest: { text: string; at: string } | null;
  backtest: Backtest | null;
};

const TIER_LABEL: Record<Tier, string> = { tier_1: "Tier 1", tier_2: "Tier 2", tier_3: "Tier 3", not_icp: "Not ICP" };
// Tier shades: darkest is the best fit; Not ICP wears the lost red.
const TIER_BAR: Record<Tier, string> = { tier_1: "hsl(var(--foreground))", tier_2: "#5d6270", tier_3: "#b9bcc4", not_icp: "hsl(var(--border))" };
const TIER_TAG: Record<Tier, { color: string; background: string }> = {
  tier_1: { color: WON, background: `${WON}14` },
  tier_2: { color: "hsl(var(--foreground))", background: "hsl(var(--muted))" },
  tier_3: { color: "hsl(var(--muted-foreground))", background: "hsl(var(--muted))" },
  not_icp: { color: LOST, background: `${LOST}14` },
};
const IMPACT: Record<Impact, { label: string; style?: React.CSSProperties; className?: string }> = {
  positive: { label: "Positive", style: { color: WON, background: `${WON}14` } },
  none: { label: "No impact", className: "bg-muted text-muted-foreground" },
  negative: { label: "Negative", style: { color: LOST, background: `${LOST}14` } },
  too_few: { label: "Too few deals", className: "bg-muted text-muted-foreground" },
  no_data: { label: "No data", className: "border border-dashed border-border text-muted-foreground/70" },
};
const ACCURACY_COLOR: Record<Backtest["accuracy"]["key"], string | undefined> = { validated: WON, weak: ACCENT, not_validated: ACCENT, insufficient: undefined };

const pct = (r: number | null | undefined) => (r == null ? "—" : `${Math.round(r * 1000) / 10}%`);
const num = (n: number) => n.toLocaleString("en-US");
// Ratios are capped at 10 when the other side has no wins (core RATIO_CAP): read as "10× or more".
const times = (x: number) => (x >= 10 ? "10×+" : `${x}×`);
const money = (n: number | null | undefined) => {
  if (!n) return null;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 2).replace(/\.?0+$/, "")}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${Math.round(n)}`;
};
const shortDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: new Date(iso).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
const fileLink = (id: string | null | undefined) => (id ? `/settings?section=context&file=${id}` : "/settings?section=context");

// `embedded`: drawn inside Settings > Knowledge (GET-1076), which scrolls and pads the page itself.
export default function IcpDocument({ embedded = false }: { embedded?: boolean } = {}) {
  const { session, userData } = useAuth();
  const ws = userData?.workspace?.id ?? "";
  const token = session?.access_token ?? "";
  const [criteria, setCriteria] = useState(false);
  const q = useQuery({
    queryKey: ["icp-page", ws], enabled: !!ws && !!token,
    queryFn: async (): Promise<Page> => {
      const r = await fetch(`${apiUrl}/api/mind/icp-page?workspaceId=${encodeURIComponent(ws)}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error("Couldn't load the ICP");
      return r.json();
    },
  });

  if (criteria) {
    return <div className="flex h-full flex-col bg-background">
      <div className="mx-auto w-full max-w-[1180px] px-8 pt-4">
        <button type="button" onClick={() => setCriteria(false)} className="inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" /> ICP
        </button>
      </div>
      <div className="min-h-0 flex-1"><Suspense fallback={null}><IcpModel /></Suspense></div>
    </div>;
  }

  const data = q.data;
  if (!data) {
    return <div className="flex h-full items-center justify-center bg-background">
      {q.error ? <p className="text-[13px] text-muted-foreground">{(q.error as Error).message}</p> : <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
    </div>;
  }
  const bt = data.backtest;

  return (
    <div className={embedded ? "" : "h-full overflow-y-auto bg-background"}>
      <div className={embedded ? "pb-12" : "mx-auto max-w-[880px] px-4 pb-20 pt-6 sm:px-6"}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 pb-3">
          <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
            <span className="rounded-md bg-muted px-2 py-0.5 text-[11.5px]">Auto-updated</span>
            {bt ? <span>{when(bt.ran_at)}</span> : data.file?.updated_at && <span>{when(data.file.updated_at)}</span>}
          </div>
          <div className="flex gap-1.5">
            <button type="button" onClick={() => setCriteria(true)} className="rounded-lg border border-border bg-card px-3 py-1 text-[12.5px] text-foreground hover:bg-muted/50">Criteria</button>
            <Link to={fileLink(data.file?.id)} className="rounded-lg border border-border bg-card px-3 py-1 text-[12.5px] text-foreground hover:bg-muted/50">History</Link>
            <Link to={fileLink(data.file?.id)} className="rounded-lg border border-border bg-card px-3 py-1 text-[12.5px] text-foreground hover:bg-muted/50">Edit</Link>
          </div>
        </div>

        <h1 className="mt-7 text-[30px] font-semibold tracking-[-0.02em] text-foreground">Ideal Customer Profile</h1>
        {data.latest && <p className="mt-2 flex items-baseline gap-2 text-[13px] text-muted-foreground">
          <span className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full bg-[#FF5C00]" />
          <span><span className="font-medium text-foreground">Latest:</span> {data.latest.text}</span>
        </p>}

        {bt && <Metrics bt={bt} />}

        <H2>ICP definition</H2>
        {data.file?.prose
          ? <Definition prose={data.file.prose} />
          : <p className="text-[13px] text-muted-foreground">No ICP yet. <Link to={fileLink(null)} className="text-foreground underline underline-offset-2">Write one</Link></p>}

        {bt ? <Evidence bt={bt} /> : <p className="mt-11 text-[13px] text-muted-foreground/70">No closed deals analyzed yet</p>}
      </div>
    </div>
  );
}

// The ICP file's own words, shortened to a preview: the page is the evidence, the file is one click away.
function Definition({ prose }: { prose: string }) {
  const [all, setAll] = useState(false);
  const long = prose.length > 900;
  return <div>
    <div className={cn("relative text-[14px] text-foreground", long && !all && "max-h-[260px] overflow-hidden")}>
      <Prose text={prose} doc />
      {long && !all && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-background to-transparent" />}
    </div>
    {long && <button type="button" onClick={() => setAll(v => !v)} className="mt-2 text-[12.5px] text-muted-foreground hover:text-foreground">{all ? "Show less" : "Show all"}</button>}
  </div>;
}

const H2 = ({ children, id }: { children: React.ReactNode; id?: string }) =>
  <h2 id={id} className="mb-2 mt-11 text-[19px] font-semibold tracking-[-0.01em] text-foreground">{children}</h2>;

function Metrics({ bt }: { bt: Backtest }) {
  const cell = "py-3.5 pr-4 [&+&]:border-l [&+&]:border-border/60 [&+&]:pl-4";
  const a = bt.accuracy;
  const won = bt.coverage.won.scored, scored = won + bt.coverage.lost.scored;
  const closed = bt.coverage.won.total + bt.coverage.lost.total;
  const total = bt.tiers.reduce((s, t) => s + t.won + t.lost, 0);
  return <>
    <div className="mt-7 grid grid-cols-2 border-y border-border/60 tabular-nums sm:grid-cols-4">
      <div className={cell}><div className="text-[12px] text-muted-foreground">Deals analyzed</div><div className="mt-0.5 text-[23px] font-medium">{num(scored)}</div>
        {closed > scored ? <div className="text-[12px] text-muted-foreground/70">of {num(closed)} closed</div>
          : bt.period.from && <div className="text-[12px] text-muted-foreground/70">Since {bt.period.from.slice(0, 4)}</div>}</div>
      <div className={cell}><div className="text-[12px] text-muted-foreground">Win rate</div><div className="mt-0.5 text-[23px] font-medium">{pct(a.win_rate)}</div>
        <div className="text-[12px] text-muted-foreground/70">{num(won)} won</div></div>
      <div className={cell}><div className="text-[12px] text-muted-foreground">ICP win rate</div><div className="mt-0.5 text-[23px] font-medium" style={{ color: WON }}>{pct(a.fit_rate)}</div>
        <div className="text-[12px] text-muted-foreground/70">vs {pct(a.rest_rate)} non-ICP</div></div>
      <div className={cell}><div className="text-[12px] text-muted-foreground">Score accuracy</div><div className="mt-0.5 text-[23px] font-medium" style={{ color: ACCURACY_COLOR[a.key] }}>{a.label}</div></div>
    </div>
    {total > 0 && <>
      <div className="mt-4 flex h-1.5 gap-0.5 overflow-hidden rounded-full">
        {bt.tiers.map(t => <span key={t.tier} style={{ width: `${((t.won + t.lost) / total) * 100}%`, background: TIER_BAR[t.tier] }} />)}
      </div>
      <div className="mt-1.5 flex flex-wrap justify-between gap-2 text-[12px] tabular-nums text-muted-foreground">
        {bt.tiers.map(t => <span key={t.tier}>{t.label} · {num(t.won + t.lost)}</span>)}
      </div>
    </>}
  </>;
}

function Evidence({ bt }: { bt: Backtest }) {
  const a = bt.accuracy;
  const strata = bt.strata.filter(s => s.fit.rate != null || s.rest.rate != null);
  return <>
    <H2>Score accuracy</H2>
    {strata.length > 0 ? <Strata rows={strata} />
      : <p className="text-[13px] text-muted-foreground">No closed deal has a job title or firmographics on file yet</p>}
    {a.raw_ratio != null && a.controlled_ratio != null && <div className="mt-6 rounded-xl bg-[#FF5C00]/[0.07] px-4 py-3.5 text-[14px] text-foreground">
      <span className="font-semibold">{finding(a.raw_ratio, a.controlled_ratio)}</span>
      {a.median_contacts.won != null && a.median_contacts.lost != null && <span> Won accounts: median {a.median_contacts.won} contacts vs {a.median_contacts.lost}.</span>}
    </div>}

    <H2>Win rate by tier</H2>
    <Table head={["Tier", "Deals", "Win rate", "Won / lost"]} right={[1, 2]}>
      {bt.tiers.map(t => <tr key={t.tier} className="border-b border-border/45">
        <td className="py-2.5 pr-3 text-foreground">{t.label}</td>
        <td className="py-2.5 pr-3 text-right">{num(t.won + t.lost)}</td>
        <td className="py-2.5 pr-3 text-right">{pct(t.rate)}</td>
        <td className="py-2.5"><WonLost won={t.won} lost={t.lost} /></td>
      </tr>)}
    </Table>

    {bt.rules.length > 0 && <>
      <H2>Scoring criteria</H2>
      <Table head={["Criterion", "Weight", "Deals", "Impact"]} right={[1, 2]}>
        {bt.rules.map(c => {
          const n = c.fired_won + c.fired_lost, im = IMPACT[c.impact];
          const x = (c.impact === "positive" || c.impact === "negative") && c.controlled_lift != null ? ` · ${times(c.controlled_lift)}` : "";
          return <tr key={c.key} className="border-b border-border/45">
            <td className="py-2.5 pr-3 text-foreground">{c.label}</td>
            <td className="py-2.5 pr-3 text-right">{c.weight > 0 ? `+${c.weight}` : c.weight}</td>
            <td className="py-2.5 pr-3 text-right text-muted-foreground">{n ? num(n) : <span className="text-muted-foreground/40">—</span>}</td>
            <td className="py-2.5"><span className={cn("whitespace-nowrap rounded-md px-2 py-0.5 text-[12px]", im.className)} style={im.style}>{im.label}{x}</span></td>
          </tr>;
        })}
      </Table>
    </>}

    {bt.disqualifiers.length > 0 && <>
      <H2>Disqualifiers</H2>
      <Table head={["Disqualifier", "Deals capped", "Status"]} right={[1]}>
        {bt.disqualifiers.map(d => <tr key={d.key} className="border-b border-border/45">
          <td className="py-2.5 pr-3 text-foreground">{d.label}</td>
          <td className="py-2.5 pr-3 text-right">{d.capped ? num(d.capped) : <span className="text-muted-foreground/40">—</span>}</td>
          <td className="py-2.5">{d.status === "review"
            ? <span className="whitespace-nowrap rounded-md bg-[#FF5C00]/10 px-2 py-0.5 text-[12px] text-[#E0662B]">Review · {d.won} won</span>
            : <span className={cn("whitespace-nowrap rounded-md px-2 py-0.5 text-[12px]", d.status === "no_data" ? IMPACT.no_data.className : "bg-muted text-muted-foreground")}>{d.status === "no_data" ? "No data" : "Working"}</span>}</td>
        </tr>)}
      </Table>
    </>}

    {bt.data_coverage.length > 0 && <>
      <H2>Data coverage</H2>
      <div className="flex flex-col">
        {bt.data_coverage.map(c => <div key={c.key} className="grid grid-cols-[1fr_auto] gap-x-4 border-b border-border/45 py-3">
          <span className="text-[14px] font-medium text-foreground">{c.label}</span>
          <span className="text-[12px] tabular-nums text-muted-foreground">{Math.round(c.share * 100)}%</span>
          <span className="col-span-2 mb-0.5 mt-2 h-[3px] overflow-hidden rounded-full bg-border/70">
            <span className="block h-full rounded-full bg-foreground" style={{ width: `${c.share * 100}%` }} />
          </span>
        </div>)}
      </div>
    </>}

    {bt.recommendations.length > 0 && <>
      <H2>Recommendations</H2>
      <div className="flex flex-col">
        {bt.recommendations.map(r => <div key={r.text} className="flex items-baseline justify-between gap-4 border-b border-border/45 py-3">
          <span className="text-[14px] font-medium text-foreground">{r.text}</span>
          <span className="whitespace-nowrap text-[12px] text-muted-foreground">{r.meta}</span>
        </div>)}
      </div>
    </>}

    <ClosedDeals bt={bt} />
  </>;
}

function finding(raw: number, controlled: number) {
  if (controlled <= 1.1) return `${times(raw)} ICP lift disappears at equal contact coverage.`;
  if (controlled < raw - 0.2) return `${times(raw)} ICP lift drops to ${times(controlled)} at equal contact coverage.`;
  return `${times(raw)} ICP lift holds at equal contact coverage.`;
}

function Table({ head, right, children }: { head: string[]; right: number[]; children: React.ReactNode }) {
  return <div className="overflow-x-auto">
    <table className="w-full min-w-[480px] border-collapse text-[13.5px] tabular-nums">
      <thead><tr className="border-b border-border/60 text-left text-[12px] text-muted-foreground">
        {head.map((h, i) => <th key={h} className={cn("py-2 pr-3 font-normal", right.includes(i) && "text-right")}>{h}</th>)}
      </tr></thead>
      <tbody>{children}</tbody>
    </table>
  </div>;
}

function WonLost({ won, lost }: { won: number; lost: number }) {
  const n = won + lost;
  return <><span className="inline-flex h-1.5 w-24 gap-px overflow-hidden rounded-full bg-border align-middle">
    {n > 0 && <><span style={{ width: `${(won / n) * 100}%`, background: WON }} /><span className="flex-1" style={{ background: LOST }} /></>}
  </span><span className="ml-2 text-[12px] text-muted-foreground">{num(won)}/{num(lost)}</span></>;
}

function Strata({ rows }: { rows: Backtest["strata"] }) {
  const max = Math.max(0.01, ...rows.flatMap(r => [r.fit.rate ?? 0, r.rest.rate ?? 0]));
  return <>
    <div className="mb-2.5 flex gap-4 text-[12px] text-muted-foreground">
      <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-[3px]" style={{ background: WON }} />ICP</span>
      <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-[3px] bg-[#b9bcc4]" />Non-ICP</span>
    </div>
    <div className="grid grid-cols-[96px_1fr] items-center gap-x-3.5 gap-y-2.5 text-[13px] tabular-nums sm:grid-cols-[120px_1fr]">
      {rows.map(r => <Fragment key={r.label}>
        <span className="text-foreground">{r.label}</span>
        <span className="relative h-[18px]">
          {r.fit.rate != null && <span className="absolute left-0 top-px h-[7px] rounded-[3px] opacity-85" style={{ width: `${(r.fit.rate / max) * 72}%`, background: WON }} />}
          {r.rest.rate != null && <span className="absolute left-0 top-[10px] h-[7px] rounded-[3px] bg-[#b9bcc4] opacity-85" style={{ width: `${(r.rest.rate / max) * 72}%` }} />}
          <span className="absolute top-0 whitespace-nowrap text-[11px] text-muted-foreground" style={{ left: `calc(${(Math.max(r.fit.rate ?? 0, r.rest.rate ?? 0) / max) * 72}% + 8px)` }}>
            {[r.fit.rate != null && `${pct(r.fit.rate)} ICP`, r.rest.rate != null && `${pct(r.rest.rate)} non-ICP`].filter(Boolean).join(" · ")}
          </span>
        </span>
      </Fragment>)}
    </div>
  </>;
}

function Contacts({ names, total }: { names: string[]; total: number }) {
  if (!names.length) return <span className="text-muted-foreground/40">—</span>;
  const extra = Math.max(0, total - names.length);
  return <div className="flex items-center">
    {names.map((n, i) => <span key={`${n}-${i}`} title={n} className={cn("relative flex size-5 items-center justify-center rounded-full text-[8.5px] font-semibold shadow-[0_0_0_2px_hsl(var(--card))]", avatarTint(n))}
      style={{ marginLeft: i === 0 ? 0 : -5, zIndex: 10 - i }}>{initialsOf(n) || "?"}</span>)}
    {extra > 0 && <span className="relative flex size-5 items-center justify-center rounded-full bg-muted text-[8.5px] font-semibold text-ink-2 shadow-[0_0_0_2px_hsl(var(--card))]" style={{ marginLeft: -5 }}>+{extra}</span>}
  </div>;
}

function ClosedDeals({ bt }: { bt: Backtest }) {
  const navigate = useNavigate();
  const [outcome, setOutcome] = useState<"all" | "won" | "lost">("all");
  const [search, setSearch] = useState("");
  const rows = bt.deals.filter(d => (outcome === "all" || d.outcome === outcome)
    && (!search || `${d.account ?? ""} ${d.domain ?? ""}`.toLowerCase().includes(search.toLowerCase())));
  const total = bt.coverage.won.scored + bt.coverage.lost.scored;

  return <>
    <H2>Closed deals</H2>
    <div className="mb-2.5 flex flex-wrap items-center justify-end gap-2">
      <label className="inline-flex h-7 w-full items-center gap-[7px] rounded-lg border border-border bg-card px-[9px] text-muted-foreground focus-within:border-foreground/30 sm:w-[200px]">
        <Search className="size-3.5 flex-shrink-0" />
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search deals" aria-label="Search deals"
          className="h-full w-full min-w-0 bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground" />
      </label>
      <div role="group" aria-label="Outcome" className="inline-flex h-7 items-center rounded-lg border border-border bg-card p-[2px]">
        {(["all", "won", "lost"] as const).map(o => <button key={o} type="button" aria-pressed={outcome === o} onClick={() => setOutcome(o)}
          className={cn("h-full rounded-md px-2.5 text-[12px] capitalize", outcome === o ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}>{o}</button>)}
      </div>
    </div>
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <div className="min-w-[760px]">
        <div className="flex items-center border-b border-border/60 px-4 py-2.5 text-[12px] font-medium text-muted-foreground/70">
          <span className="min-w-0 flex-1 pr-3">Company</span>
          <span className="w-[80px] shrink-0">Contacts</span>
          <span className="w-[70px] shrink-0">Outcome</span>
          <span className="w-[300px] shrink-0">ICP fit</span>
          <span className="w-[70px] shrink-0 text-right">Value</span>
          <span className="w-[70px] shrink-0 text-right">Closed</span>
        </div>
        {!rows.length && <div className="py-12 text-center text-[13px] text-muted-foreground/70">No closed deals</div>}
        {rows.map(d => {
          const color = d.outcome === "won" ? WON : LOST;
          return <div key={d.id} role="link" tabIndex={0} onClick={() => navigate(accountPath(d.entity_id))}
            onKeyDown={e => { if (e.key === "Enter") navigate(accountPath(d.entity_id)); }}
            className="flex w-full cursor-pointer items-center border-b border-border/45 px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-muted/40">
            <div className="flex min-w-0 flex-1 items-center gap-2 pr-3">
              <AccountTile name={d.account} domain={d.domain} size={20} />
              <span className="truncate text-[13px] font-medium text-foreground">{d.account ?? "—"}</span>
              {d.domain && <span className="truncate text-[12px] text-muted-foreground/70">{d.domain}</span>}
            </div>
            <div className="w-[80px] shrink-0"><Contacts names={d.contacts} total={d.contacts_total} /></div>
            <div className="w-[70px] shrink-0">
              <span className="inline-flex items-center gap-1.5 text-[12.5px]" style={{ color }}><span className="size-1.5 rounded-full" style={{ background: color }} />{d.outcome === "won" ? "Won" : "Lost"}</span>
            </div>
            <div className="flex w-[300px] shrink-0 items-center gap-2 pr-3">
              <span className="shrink-0 rounded-md px-2 py-0.5 text-[12px]" style={TIER_TAG[d.tier]}>{TIER_LABEL[d.tier]}</span>
              <span className="truncate text-[12.5px] text-muted-foreground">{d.matched.length ? d.matched.join(" · ") : "No criteria matched"}</span>
            </div>
            <div className="w-[70px] shrink-0 text-right text-[13px] tabular-nums text-foreground/90">{money(d.value_usd) ?? <span className="text-muted-foreground/40">—</span>}</div>
            <div className="w-[70px] shrink-0 text-right text-[12.5px] tabular-nums text-muted-foreground">{shortDate(d.closed_at)}</div>
          </div>;
        })}
      </div>
    </div>
    <div className="px-1 pt-3 text-[12.5px] text-muted-foreground/70">Showing {rows.length} of {num(total)}</div>
  </>;
}
