// The context graph (GET-815, GET-840, GET-841). Accounts (drawn with their logo), people and deals
// are typed nodes; what links them is a typed line, with nothing in the middle.
//
// The graph is for picking; the record panel on the right is where the reading happens. A lens
// (Accounts, People, Deals) decides which nodes lead (labelled, larger) and what the panel lists
// before anything is picked. Click a node and the rest dims to its neighbours, and the panel shows
// that record: a summary line, what to watch, and every claim we hold with how sure we are of it
// and how old it is. Pains, objections and goals are claims, so they are read here, not drawn.
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowUpRight, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { faviconUrl } from "@/lib/externalImages";
import { AccountLogo } from "@/components/pipeline/DealBits";
import { ForceCanvas, type CanvasLink, type CanvasNode } from "./ForceCanvas";
import { useGraphApi } from "./graphApi";
import { useDealPages } from "@/hooks/useDealPages";

export type Lens = "account" | "person" | "deal";
type NodeType = Lens;
type GNode = { id: string; type: NodeType; label: string; domain?: string | null; sub?: string | null; status?: string | null; icp?: number | null; days?: number | null; people?: number; dm?: boolean; value?: number | null; count?: number };
type GEdge = { s: string; t: string; type: "works_at" | "knows" | "shares" | "deal_of" | "on_deal" };
type Graph = { nodes: GNode[]; edges: GEdge[] };
type Claim = { id: string; account: string; cat: string; text: string; person: string | null; pid?: string | null; conf?: number | null; at: string | null; source: string | null };
type ClaimsData = { claims: Claim[] };

const TYPES: Record<NodeType, { label: string; plural: string; color: string }> = {
  account: { label: "Account", plural: "Accounts", color: "#4a7fd4" },
  person: { label: "Person", plural: "People", color: "#9aa0ad" },
  deal: { label: "Deal", plural: "Deals", color: "#2fa36b" },
};
// Kinds of claim, most decisive first: why they buy, why they won't, what they do today.
const CLAIM_KINDS: { id: string; label: string; color: string }[] = [
  { id: "pain", label: "Pain", color: "#d4574c" },
  { id: "objection", label: "Objection", color: "#c2410c" },
  { id: "goal", label: "Goal", color: "#2aa8a0" },
  { id: "buying_signal", label: "Buying signal", color: "#2fa36b" },
  { id: "status_quo", label: "Current tools", color: "#7c5cf0" },
  { id: "competitor", label: "Competitor", color: "#0891b2" },
  { id: "budget", label: "Budget", color: "#c9a227" },
  { id: "timeline", label: "Timeline", color: "#4a7fd4" },
  { id: "authority", label: "Who decides", color: "#9a86c9" },
  { id: "preference", label: "Preference", color: "#dd9a3e" },
  { id: "discovery", label: "Discovery", color: "#8fa3b8" },
  { id: "relationship", label: "Relationship", color: "#d38bb4" },
];
const EDGE_WORDS: Record<GEdge["type"], string> = { works_at: "works at", knows: "knows", shares: "uses", deal_of: "deal", on_deal: "on deal" };
const KIND = new Map(CLAIM_KINDS.map((k) => [k.id, k]));
// On a deal with nobody named yet, the account's claims that bear on closing it.
const DEAL_KINDS = new Set(["objection", "budget", "timeline", "authority", "buying_signal", "competitor"]);

/** The graph's source: the workspace by default, or one object's accounts (GET-858). */
export type GraphSource = { path: string; key: string };
const WORKSPACE: GraphSource = { path: "/api/graph/context", key: "context" };

export function useContextGraph(source: GraphSource = WORKSPACE) {
  return useGraphApi<Graph>(source.key, source.path);
}

const ago = (d: number | null | undefined) => d == null ? null : d <= 0 ? "today" : d < 14 ? `${d}d ago` : d < 60 ? `${Math.round(d / 7)}w ago` : `${Math.round(d / 30)}mo ago`;
const daysSince = (iso: string | null) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 86_400_000)) : null; };
const money = (v: number | null | undefined) => v == null ? null : v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(1)}M` : v >= 1000 ? `$${Math.round(v / 1000)}K` : `$${Math.round(v)}`;
const initials = (s: string) => s.split(/[\s·.@-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";

function toCanvas(n: GNode, degree: number, lens: Lens, social: boolean): CanvasNode {
  const t = TYPES[n.type];
  const lead = n.type === lens;
  const size = n.type === "account" ? (lead ? 3.6 + ((n.icp ?? 0) / 100) * 3.2 : 3) : n.type === "deal" ? (lead ? 3.6 : 2.6)
    : lead ? 2.8 : 1.9;
  const hub = lens === "account" ? n.type === "account" && (degree >= 2 || (n.icp ?? 0) >= 70)
    : lens === "person" ? n.type === "person" && (social || !!n.dm)
    : n.type === "deal";
  return {
    id: n.id, label: n.label, color: t.color, size, hub,
    shape: n.type === "deal" ? "square" : "circle",
    charge: n.type === "person" ? (lead ? -60 : -26) : -90 - Math.min(160, degree * 12),
    faint: n.days != null && n.days > 75,
    ring: n.dm ? "#e0a03a" : null,
    tip: [t.label, n.label, n.sub, n.icp != null ? `ICP ${Math.round(n.icp)}` : null, ago(n.days)].filter(Boolean).join(" · "),
    keywords: [n.sub, n.domain].filter(Boolean).join(" "),
    image: n.type === "account" ? faviconUrl(n.domain) : null,
  };
}
const toLinks = (edges: GEdge[]): CanvasLink[] => edges.map((e) => ({
  source: e.s, target: e.t,
  distance: e.type === "works_at" ? 18 : e.type === "on_deal" || e.type === "deal_of" ? 26 : e.type === "knows" ? 40 : 70,
  strength: e.type === "works_at" ? 0.7 : e.type === "shares" ? 0.08 : 0.3,
  color: e.type === "knows" ? "rgba(224,90,140,0.45)" : undefined,
}));

export function ContextGraph({ lens, search, source }: { lens: Lens; search: string; source?: GraphSource }) {
  const q = useContextGraph(source);
  const claimsQ = useGraphApi<ClaimsData>("claims", "/api/graph/claims");
  const [focus, setFocus] = useState<string | null>(null);
  const [centerOn, setCenterOn] = useState<{ id: string } | null>(null);
  // Picked in the panel (not on the canvas): also pan the canvas to it.
  const pick = (id: string | null) => { setFocus(id); if (id) setCenterOn({ id }); };

  const { nodes, links } = useMemo(() => {
    const g = q.data;
    if (!g) return { nodes: [] as CanvasNode[], links: [] as CanvasLink[] };
    let keep = new Set(g.nodes.filter((n) => TYPES[n.type]).map((n) => n.id));
    // Deals: the deals, their accounts and the people on them, which is the buying committee view.
    if (lens === "deal") {
      const deals = new Set(g.nodes.filter((n) => n.type === "deal").map((n) => n.id));
      const near = new Set(deals);
      for (const e of g.edges) if ((e.type === "deal_of" || e.type === "on_deal") && (deals.has(e.s) || deals.has(e.t))) { near.add(e.s); near.add(e.t); }
      keep = new Set([...keep].filter((id) => near.has(id)));
    }
    let edges = g.edges.filter((e) => keep.has(e.s) && keep.has(e.t));
    // Every account and deal is drawn, however small its group: hiding the pairs hid most of the
    // book (GET-844). A person tied to nothing is the only thing left out of the
    // Accounts and Deals views; the People view draws everyone.
    if (lens !== "person") {
      const linked = new Set(edges.flatMap((e) => [e.s, e.t]));
      const typeOf = new Map(g.nodes.map((n) => [n.id, n.type]));
      keep = new Set([...keep].filter((id) => linked.has(id) || typeOf.get(id) !== "person"));
      edges = edges.filter((e) => keep.has(e.s) && keep.has(e.t));
    }
    const degree = new Map<string, number>();
    const social = new Set<string>();
    for (const e of edges) {
      degree.set(e.s, (degree.get(e.s) ?? 0) + 1); degree.set(e.t, (degree.get(e.t) ?? 0) + 1);
      if (e.type === "knows" || e.type === "on_deal") { social.add(e.s); social.add(e.t); }
    }
    return {
      nodes: g.nodes.filter((n) => keep.has(n.id)).map((n) => toCanvas(n, degree.get(n.id) ?? 0, lens, social.has(n.id))),
      links: toLinks(edges),
    };
  }, [q.data, lens]);
  const node = focus ? q.data?.nodes.find((n) => n.id === focus) ?? null : null;


  return (
    <>
      <div className="relative min-h-0 min-w-0 flex-1">
        {q.isLoading ? <p className="p-6 text-[13px] text-muted-foreground">Loading…</p>
          : q.error ? <p className="p-6 text-[13px] text-muted-foreground">Could not load the graph.</p>
          : <ForceCanvas nodes={nodes} links={links} query={search} selected={focus} onClick={setFocus} onBackground={() => setFocus(null)} centerOn={centerOn} />}
      </div>
      {/* Beside the graph on a wide screen; under it on a phone. */}
      <aside className="flex h-[45%] w-full flex-shrink-0 flex-col overflow-hidden border-t border-hairline bg-background md:h-auto md:w-[360px] md:border-l md:border-t-0">
        {q.data && (node
          ? <RecordPanel key={node.id} node={node} graph={q.data} claims={claimsQ.data?.claims ?? []} claimsLoading={claimsQ.isLoading} setFocus={pick} />
          : <ListPanel lens={lens} graph={q.data} search={search} setFocus={pick} />)}
      </aside>
    </>
  );
}


/** Nothing picked: the lens's records, the ones worth opening first at the top. */
function ListPanel({ lens, graph, search, setFocus }: { lens: Lens; graph: Graph; search: string; setFocus: (id: string) => void }) {
  const s = search.trim().toLowerCase();
  const rows = useMemo(() => graph.nodes
    .filter((n) => n.type === lens && (!s || n.label.toLowerCase().includes(s) || (n.sub ?? "").toLowerCase().includes(s)))
    .sort(lens === "account" ? (a, b) => (b.icp ?? -1) - (a.icp ?? -1) || (a.days ?? 1e9) - (b.days ?? 1e9)
      : lens === "deal" ? (a, b) => (b.value ?? -1) - (a.value ?? -1) || (a.days ?? 1e9) - (b.days ?? 1e9)
      : (a, b) => (a.days ?? 1e9) - (b.days ?? 1e9)), [graph, lens, s]);
  const t = TYPES[lens];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-4 pb-2 pt-4">
        <div className="text-[13.5px] font-medium text-foreground">{t.plural} <span className="font-normal tabular-nums text-muted-foreground">{rows.length}</span></div>
        <p className="pt-0.5 text-[12px] text-muted-foreground">
          {lens === "account" ? "Best fit first. Pick one to see who we know there and what they told us."
            : lens === "deal" ? "Largest first. Pick one to see the buying committee and what to watch."
            : "Most recent first. Pick one to see their account, deals and claims."}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {rows.slice(0, 80).map((n) => (
          <button key={n.id} type="button" onClick={() => setFocus(n.id)}
            className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-hover">
            {n.type === "account" ? <AccountLogo name={n.label} domain={n.domain ?? null} size={18} />
              : <span className={cn("h-2 w-2 flex-shrink-0", n.type === "deal" ? "rounded-[2px]" : "rounded-full")} style={{ background: t.color }} />}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] text-foreground">{n.label}</span>
              {n.sub && <span className="block truncate text-[11.5px] text-muted-foreground">{n.sub}</span>}
            </span>
            <span className="flex-shrink-0 text-[11.5px] tabular-nums text-muted-foreground">
              {lens === "account" ? (n.icp != null ? `ICP ${Math.round(n.icp)}` : ago(n.days)) : lens === "deal" ? (money(n.value) ?? ago(n.days)) : ago(n.days)}
            </span>
          </button>
        ))}
        {rows.length > 80 && <p className="px-2 pt-2 text-[11.5px] text-muted-foreground">{rows.length - 80} more. Search to narrow.</p>}
        {!rows.length && <p className="px-2 pt-2 text-[12.5px] text-muted-foreground">Nothing matches.</p>}
      </div>
    </div>
  );
}

/** One record: who or what it is, a summary line, what to watch, its claims and what it links to. */
function RecordPanel({ node, graph, claims, claimsLoading, setFocus }: {
  node: GNode; graph: Graph; claims: Claim[]; claimsLoading: boolean; setFocus: (id: string | null) => void;
}) {
  const navigate = useNavigate();
  const dealPages = useDealPages();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const t = TYPES[node.type];

  const m = useMemo(() => {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const links = graph.edges.filter((e) => e.s === node.id || e.t === node.id)
      .map((e) => ({ n: byId.get(e.s === node.id ? e.t : e.s), how: e.type })).filter((x): x is { n: GNode; how: GEdge["type"] } => !!x.n);
    const of = (type: NodeType) => links.filter((l) => l.n.type === type).map((l) => l.n);
    const people = of("person"), deals = of("deal"), accounts = of("account");
    const account = node.type === "account" ? node : accounts[0] ?? null;
    // Where a person works, as the graph draws it, so a claim sits under the account the person is
    // shown at even when the claims feed placed it by another route.
    const worksAt = new Map(graph.edges.filter((e) => e.type === "works_at").map((e) => [e.s, e.t]));
    const accountOf = (c: Claim) => (c.pid ? worksAt.get(c.pid) ?? c.account : c.account);
    let mine: Claim[];
    if (node.type === "account") mine = claims.filter((c) => accountOf(c) === node.id);
    else if (node.type === "person") mine = claims.filter((c) => c.pid === node.id || (!c.pid && c.account === node.id));
    else if (node.type === "deal") {
      // Claims on the deal itself, then what its people and its account said that bears on closing.
      const onDeal = new Set(people.map((p) => p.id));
      mine = claims.filter((c) => c.account === node.id
        || (DEAL_KINDS.has(c.cat) && ((c.pid && onDeal.has(c.pid)) || (account && !c.pid && c.account === account.id))));
    } else mine = [];
    mine = mine.filter((c) => KIND.has(c.cat));
    // The same company recorded as two accounts (one from the CRM, one from a call that never
    // resolved to it): say so, so the split people and deals are not read as the whole account.
    const key = (s: string) => s.toLowerCase().replace(/\b(inc|llc|ltd|gmbh|corp|co)\b\.?/g, "").replace(/[^a-z0-9]/g, "");
    const named = (n: GNode) => n.label !== "Unnamed account" && key(n.label).length > 1;
    const twins = node.type === "account" && named(node) ? graph.nodes.filter((n) => n.type === "account" && n.id !== node.id && named(n) && key(n.label) === key(node.label)) : [];
    const staffOf = (id: string) => graph.edges.filter((e) => e.type === "works_at" && e.t === id).map((e) => byId.get(e.s)?.label).filter(Boolean) as string[];
    const groups = new Map<NodeType, { n: GNode; how: GEdge["type"] }[]>();
    for (const l of links) groups.set(l.n.type, [...(groups.get(l.n.type) ?? []), l]);
    return { people, deals, accounts, account, mine, groups, twins: twins.map((n) => ({ n, staff: staffOf(n.id) })) };
  }, [graph, node, claims]);

  const byKind = CLAIM_KINDS.map((k) => ({ k, items: m.mine.filter((c) => c.cat === k.id) })).filter((g) => g.items.length);
  const objections = m.mine.filter((c) => c.cat === "objection");
  const openDeals = m.deals.filter((d) => !/won|lost|closed/i.test(d.status ?? d.sub ?? ""));
  const sources = new Set(m.mine.map((c) => c.source).filter(Boolean));
  const newest = m.mine.reduce<number | null>((best, c) => { const d = daysSince(c.at); return d == null ? best : best == null ? d : Math.min(best, d); }, null);

  // The summary line and the watch list are worked out from the record, not written by a model,
  // so every word on them can be checked against what sits below.
  const summary = node.type === "account"
    ? openDeals.length ? `${openDeals.length} open ${openDeals.length === 1 ? "deal" : "deals"}${openDeals.some((d) => d.value) ? ` worth ${money(openDeals.reduce((s, d) => s + (d.value ?? 0), 0))}` : ""}, ${m.people.length} ${m.people.length === 1 ? "person" : "people"} known.`
      : `${m.people.length} ${m.people.length === 1 ? "person" : "people"} known, no open deal.`
    : node.type === "deal" ? `${node.sub ?? "No stage"}${node.value ? `, ${money(node.value)}` : ""}${m.account ? ` at ${m.account.label}` : ""}, ${m.people.length} ${m.people.length === 1 ? "person" : "people"} on it.`
    : [node.sub, m.account ? `at ${m.account.label}` : null].filter(Boolean).join(" ") || "Nothing on their role yet.";
  const watch: string[] = [];
  if (node.type === "account" || node.type === "deal") {
    if (m.people.length && !m.people.some((p) => p.dm)) watch.push(node.type === "deal" ? "No decision maker on the deal." : "No decision maker known yet.");
    if (node.type === "deal" && !m.people.length) watch.push("Nobody is on this deal yet. Add the buying committee.");
  }
  if ((node.type === "account" || node.type === "person") && node.days != null && node.days > 30) watch.push(`No touch since ${ago(node.days)}.`);
  if (node.type === "deal" && node.days != null && node.days > 21) watch.push(`No activity on the deal since ${ago(node.days)}.`);
  if (node.type === "account") for (const d of openDeals) if (d.days != null && d.days > 21) watch.push(`${d.label} has had no activity since ${ago(d.days)}.`);
  if (objections.length) watch.push(`${objections.length} ${objections.length === 1 ? "objection" : "objections"} raised. Latest: “${objections[0]!.text.slice(0, 110)}${objections[0]!.text.length > 110 ? "…" : ""}”`);

  const stats: { label: string; value: string }[] = node.type === "account"
    ? [{ label: "ICP fit", value: node.icp != null ? String(Math.round(node.icp)) : "—" }, { label: "People", value: String(m.people.length) }, { label: "Last touch", value: ago(node.days) ?? "—" }]
    : node.type === "person" ? [{ label: "Deals", value: String(m.deals.length) }, { label: "Claims", value: String(m.mine.length) }, { label: "Last touch", value: ago(node.days) ?? "—" }]
    : [{ label: "Value", value: money(node.value) ?? "—" }, { label: "Stage", value: node.sub ?? "—" }, { label: "Last touch", value: ago(node.days) ?? "—" }];

  const dealAccount = node.type === "deal" ? m.account : null;
  const href = node.type === "account" ? `/accounts/${node.id}` : node.type === "person" ? `/contacts/${node.id}`
    // An account's own (implied) deal opens as /deals/account, as on the account page. Only where
    // deals have pages (the workspace plans on Cloud, GET-1008); elsewhere a deal does not open.
    : node.type === "deal" && dealAccount && dealPages ? `/accounts/${dealAccount.id}/deals/${node.id.startsWith("implied:") ? "account" : node.id}` : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex items-start gap-3 px-4 pb-3 pt-4">
        {node.type === "account" || (node.type === "deal" && m.account)
          ? <AccountLogo name={(node.type === "account" ? node : m.account)!.label} domain={(node.type === "account" ? node : m.account)!.domain ?? null} size={40} className="rounded-[10px]" />
          : <span className="flex size-10 flex-shrink-0 items-center justify-center rounded-[10px] border border-border bg-muted text-[13px] font-semibold" style={{ color: t.color }}>
              {initials(node.label)}
            </span>}
        <div className="min-w-0 flex-1">
          {href ? (
            <button type="button" onClick={() => navigate(href)} className="group flex max-w-full items-center gap-1 text-left" title={`Open ${t.label.toLowerCase()}`}>
              <span className="truncate text-[15px] font-medium tracking-[-0.01em] text-foreground">{node.label}</span>
              <ArrowUpRight className="size-3.5 flex-shrink-0 text-muted-foreground group-hover:text-foreground" />
            </button>
          ) : <span className="block truncate text-[15px] font-medium tracking-[-0.01em] text-foreground">{node.label}</span>}
          <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <span className={cn("h-1.5 w-1.5", node.type === "deal" ? "rounded-[1.5px]" : "rounded-full")} style={{ background: t.color }} />
            {[t.label, node.type === "account" ? null : m.account && node.type !== "deal" ? m.account.label : null, node.dm ? "Decision maker" : null].filter(Boolean).join(" · ")}
          </span>
        </div>
        <button type="button" onClick={() => setFocus(null)} aria-label="Close" className="rounded-md p-1 text-muted-foreground hover:bg-hover hover:text-foreground">
          <X className="size-3.5" />
        </button>
      </div>

      <div className="mx-4 grid border-y border-hairline" style={{ gridTemplateColumns: `repeat(${stats.length}, minmax(0, 1fr))` }}>
        {stats.map((s, i) => (
          <div key={s.label} className={cn("min-w-0 py-2.5", i > 0 && "border-l border-hairline pl-3")}>
            <div className="text-[11px] text-muted-foreground">{s.label}</div>
            <div className="truncate pt-0.5 text-[14px] font-medium tabular-nums text-foreground">{s.value}</div>
          </div>
        ))}
      </div>

      <div className="px-4 pt-3.5">
        <p className="text-[14px] font-medium leading-snug text-foreground">{summary}</p>
        {watch.length > 0 && (
          <div className="mt-2.5 rounded-lg bg-[hsl(var(--warning-dot)/0.08)] px-3 py-2">
            <div className="text-[11px] font-medium text-warning">Watch</div>
            <ul className="space-y-1 pt-0.5">
              {watch.map((w) => <li key={w} className="text-[12.5px] leading-snug text-foreground/85">{w}</li>)}
            </ul>
          </div>
        )}
        {m.twins.map(({ n, staff }) => (
          <button key={n.id} type="button" onClick={() => setFocus(n.id)}
            className="mt-2 block w-full rounded-lg border border-border px-3 py-2 text-left transition-colors hover:bg-hover">
            <span className="block text-[11px] font-medium text-muted-foreground">Recorded twice</span>
            <span className="block text-[12.5px] leading-snug text-foreground/85">
              A second {n.label} account holds {staff.length ? staff.slice(0, 3).join(", ") : "other records"}. Probably the same company, so people and deals are split between the two.
            </span>
          </button>
        ))}
      </div>

      {(
        <div className="px-4 pt-4">
          <div className="pb-1 text-[11.5px] font-medium text-muted-foreground">What we know</div>
          {claimsLoading ? <p className="py-1 text-[12.5px] text-muted-foreground">Loading claims…</p>
            : !byKind.length ? <p className="py-1 text-[12.5px] text-muted-foreground">No claims yet. They come from calls, emails and messages.</p>
            : byKind.map(({ k, items }) => {
              const all = open.has(k.id);
              return (
                <div key={k.id} className="pt-2">
                  <div className="flex items-center gap-1.5 text-[12px] font-medium text-foreground">
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: k.color }} />{k.label}
                    <span className="font-normal tabular-nums text-muted-foreground">{items.length}</span>
                  </div>
                  <ul>
                    {(all ? items : items.slice(0, 3)).map((c) => (
                      <li key={c.id} className="border-l border-hairline py-1 pl-3 ml-[2px]">
                        <p className="text-[12.5px] leading-snug text-foreground/90">{c.text}</p>
                        <p className="pt-0.5 text-[11px] text-muted-foreground">
                          {[node.type !== "person" ? c.person : null, c.conf != null ? `${Math.round(c.conf * 100)}% sure` : null, ago(daysSince(c.at)), c.source].filter(Boolean).join(" · ")}
                        </p>
                      </li>
                    ))}
                  </ul>
                  {items.length > 3 && (
                    <button type="button" onClick={() => setOpen((s) => { const n = new Set(s); if (all) n.delete(k.id); else n.add(k.id); return n; })}
                      className="ml-3 pt-0.5 text-[11.5px] text-muted-foreground hover:text-foreground">
                      {all ? "Show fewer" : `Show all ${items.length}`}
                    </button>
                  )}
                </div>
              );
            })}
        </div>
      )}

      <div className="px-2 pt-4">
        {[...m.groups.entries()].map(([type, items]) => (
          <div key={type} className="pb-2">
            <span className="block px-2 pb-0.5 text-[11.5px] font-medium text-muted-foreground">{TYPES[type]?.plural ?? type} <span className="font-normal tabular-nums">{items.length}</span></span>
            {items.slice(0, 30).map(({ n, how }) => (
              <button key={n.id} type="button" onClick={() => setFocus(n.id)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left transition-colors hover:bg-hover">
                <span className={cn("h-1.5 w-1.5 flex-shrink-0", n.type === "deal" ? "rounded-[1.5px]" : "rounded-full")} style={{ background: TYPES[n.type]?.color }} />
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground/85">{n.label}</span>
                {n.dm && <span className="text-[10.5px] text-[#c98a1e]">DM</span>}
                <span className="text-[11px] text-muted-foreground">{EDGE_WORDS[how]}</span>
              </button>
            ))}
            {items.length > 30 && <span className="block px-2 text-[11px] text-muted-foreground">{items.length - 30} more</span>}
          </div>
        ))}
      </div>

      {m.mine.length > 0 && (
        <p className="mt-auto border-t border-hairline px-4 py-2.5 text-[11.5px] text-muted-foreground">
          {m.mine.length} {m.mine.length === 1 ? "claim" : "claims"} · {sources.size} {sources.size === 1 ? "source" : "sources"}{newest != null ? ` · newest ${ago(newest)}` : ""}
        </p>
      )}
    </div>
  );
}
