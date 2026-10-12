// The Insights view of /graph (GET-841): what conversations taught us, and which accounts taught it.
//
// Claims are facts about a contact; insights are facts about us — our product, positioning, market
// and buyer. The nightly worker groups insights into themes; here each of the four categories is a
// hub (square), each theme hangs off its category, sized by how many separate calls raised it, and
// each theme links to the accounts whose people said it (drawn with their logo). So a theme several
// accounts share pulls those accounts together, which no record page can show. The panel reads the
// picked theme: its takeaway, the evidence in the speakers' words, and the accounts behind it.
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowUpRight, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { faviconUrl } from "@/lib/externalImages";
import { AccountLogo } from "@/components/pipeline/DealBits";
import { ForceCanvas, type CanvasLink, type CanvasNode } from "./ForceCanvas";
import { useContextGraph } from "./ContextGraph";
import { useGraphApi } from "./graphApi";

type Item = { id: string; statement: string; quote: string | null; speaker: string | null; speakerId: string | null; companyId?: string | null; date: string | null; occurred_at: string | null };
type Theme = { id: string; title: string; takeaway: string | null; category: string | null; categoryLabel: string | null; count: number; callCount: number; peopleCount: number; tier: "pattern" | "emerging"; lastSeen: string | null; items: Item[] };
type ThemesData = { themes: Theme[] };

const CATS: { id: string; label: string; color: string; blurb: string }[] = [
  { id: "buyer", label: "Buyer", color: "#2fa36b", blurb: "Who buys and why: the pain, the bottleneck, the trigger." },
  { id: "market", label: "Market", color: "#0891b2", blurb: "Where demand is, which segments, channels and competitors." },
  { id: "positioning", label: "Positioning", color: "#dd9a3e", blurb: "What language lands, what to lead with, what confuses." },
  { id: "product", label: "Product", color: "#7c5cf0", blurb: "What to build or change, from what people asked for." },
];
const CAT = new Map(CATS.map((c) => [c.id, c]));
const ACCOUNT = "#4a7fd4";

const daysSince = (iso: string | null) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 86_400_000)) : null; };
const ago = (d: number | null) => d == null ? null : d <= 0 ? "today" : d < 14 ? `${d}d ago` : d < 60 ? `${Math.round(d / 7)}w ago` : `${Math.round(d / 30)}mo ago`;

type Acc = { id: string; label: string; domain: string | null };
type Model = {
  themes: Theme[];
  /** theme id → the accounts whose people raised it */
  accountsOf: Map<string, Acc[]>;
  /** account id → the themes it raised */
  themesOf: Map<string, Theme[]>;
  accounts: Map<string, Acc>;
};

export function InsightsGraph({ search }: { search: string }) {
  const q = useGraphApi<ThemesData>("insight-themes", "/api/insights/themes?source=external");
  const ctx = useContextGraph();
  const [focus, setFocus] = useState<string | null>(null);
  const [centerOn, setCenterOn] = useState<{ id: string } | null>(null);
  const pick = (id: string | null) => { setFocus(id); if (id) setCenterOn({ id }); };

  // Who said it → where they work, from the context graph, so a theme lands on accounts.
  const model = useMemo<Model | null>(() => {
    if (!q.data) return null;
    const g = ctx.data;
    const accounts = new Map<string, Acc>();
    for (const n of g?.nodes ?? []) if (n.type === "account") accounts.set(n.id, { id: n.id, label: n.label, domain: n.domain ?? null });
    const worksAt = new Map((g?.edges ?? []).filter((e) => e.type === "works_at").map((e) => [e.s, e.t]));
    const themes = q.data.themes.filter((t) => t.category && CAT.has(t.category));
    const accountsOf = new Map<string, Acc[]>();
    const themesOf = new Map<string, Theme[]>();
    for (const t of themes) {
      // Where the speaker works, else the account the insight was filed under.
      const ids = new Set(t.items.map((i) => (i.speakerId ? worksAt.get(i.speakerId) : undefined) ?? i.companyId ?? undefined).filter((x): x is string => !!x && accounts.has(x)));
      accountsOf.set(t.id, [...ids].map((id) => accounts.get(id)!));
      for (const id of ids) themesOf.set(id, [...(themesOf.get(id) ?? []), t]);
    }
    return { themes, accountsOf, themesOf, accounts };
  }, [q.data, ctx.data]);

  const { nodes, links } = useMemo(() => {
    const nodes: CanvasNode[] = [], links: CanvasLink[] = [];
    if (!model) return { nodes, links };
    for (const c of CATS) {
      if (!model.themes.some((t) => t.category === c.id)) continue;
      nodes.push({ id: `cat:${c.id}`, label: c.label, color: c.color, shape: "square", size: 6, hub: true, charge: -260, tip: `${c.label} · ${c.blurb}` });
    }
    for (const t of model.themes) {
      const c = CAT.get(t.category!)!;
      nodes.push({
        id: t.id, label: t.title, color: c.color, size: 2.6 + Math.min(4, Math.sqrt(Math.max(1, t.callCount)) * 1.2),
        hub: t.callCount >= 2 || (model.accountsOf.get(t.id)?.length ?? 0) >= 2, charge: -90,
        faint: t.tier === "emerging", tip: `${c.label} · ${t.title} · ${t.callCount} ${t.callCount === 1 ? "call" : "calls"}`,
        keywords: [t.takeaway, ...t.items.map((i) => i.speaker)].filter(Boolean).join(" "),
      });
      links.push({ source: t.id, target: `cat:${c.id}`, distance: 40, strength: 0.5 });
      for (const a of model.accountsOf.get(t.id) ?? []) links.push({ source: t.id, target: a.id, distance: 46, strength: 0.25 });
    }
    for (const [id, ts] of model.themesOf) {
      const a = model.accounts.get(id)!;
      nodes.push({ id, label: a.label, color: ACCOUNT, size: 2.6, hub: ts.length >= 3, charge: -40, image: faviconUrl(a.domain), tip: `Account · ${a.label} · ${ts.length} ${ts.length === 1 ? "theme" : "themes"}`, keywords: a.domain ?? "" });
    }
    return { nodes, links };
  }, [model]);

  // 402: not in the plan; 403: turned off; 404: a build without the Insights API.
  const forbidden = q.error && /graph_(402|403|404)/.test(String(q.error.message));
  const theme = focus ? model?.themes.find((t) => t.id === focus) ?? null : null;
  const cat = focus?.startsWith("cat:") ? CAT.get(focus.slice(4)) ?? null : null;
  const account = focus && model?.themesOf.has(focus) ? model.accounts.get(focus) ?? null : null;

  return (
    <>
      <div className="relative min-h-0 min-w-0 flex-1">
        {q.isLoading ? <p className="p-6 text-[13px] text-muted-foreground">Loading…</p>
          : forbidden ? <p className="p-6 text-[13px] text-muted-foreground">Insights are not turned on for this workspace.</p>
          : q.error ? <p className="p-6 text-[13px] text-muted-foreground">Could not load the insights.</p>
          : !nodes.length ? <p className="p-6 text-[13px] text-muted-foreground">No insights yet. They are drawn from calls each night.</p>
          : <ForceCanvas nodes={nodes} links={links} query={search} selected={focus} onClick={setFocus} onBackground={() => setFocus(null)} centerOn={centerOn} />}
      </div>
      <aside className="flex h-[45%] w-full flex-shrink-0 flex-col overflow-hidden border-t border-hairline bg-background md:h-auto md:w-[360px] md:border-l md:border-t-0">
        {model && (theme ? <ThemePanel key={theme.id} theme={theme} accounts={model.accountsOf.get(theme.id) ?? []} setFocus={pick} />
          : account ? <AccountPanel key={account.id} account={account} themes={model.themesOf.get(account.id) ?? []} setFocus={pick} />
          : <CategoryList model={model} only={cat?.id ?? null} search={search} setFocus={pick} />)}
      </aside>
    </>
  );
}

function Close({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label="Close" className="rounded-md p-1 text-muted-foreground hover:bg-hover hover:text-foreground">
      <X className="size-3.5" />
    </button>
  );
}

function ThemeRow({ t, setFocus }: { t: Theme; setFocus: (id: string) => void }) {
  return (
    <button type="button" onClick={() => setFocus(t.id)} className="flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-hover">
      <span className="mt-[6px] h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ background: CAT.get(t.category!)?.color }} />
      <span className="min-w-0 flex-1 text-[13px] leading-snug text-foreground">{t.title}</span>
      <span className="flex-shrink-0 pt-px text-[11.5px] tabular-nums text-muted-foreground">{t.callCount} {t.callCount === 1 ? "call" : "calls"}</span>
    </button>
  );
}

/** Nothing picked (or a category picked): the themes, by category, most-raised first. */
function CategoryList({ model, only, search, setFocus }: { model: Model; only: string | null; search: string; setFocus: (id: string | null) => void }) {
  const s = search.trim().toLowerCase();
  const cats = CATS.filter((c) => !only || c.id === only).map((c) => ({
    c, themes: model.themes.filter((t) => t.category === c.id && (!s || t.title.toLowerCase().includes(s) || (t.takeaway ?? "").toLowerCase().includes(s)))
      .sort((a, b) => b.callCount - a.callCount || b.count - a.count),
  })).filter((x) => x.themes.length);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-start gap-2 px-4 pb-2 pt-4">
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-medium text-foreground">{only ? CAT.get(only)!.label : "Insights"} <span className="font-normal tabular-nums text-muted-foreground">{cats.reduce((n, x) => n + x.themes.length, 0)}</span></div>
          <p className="pt-0.5 text-[12px] text-muted-foreground">{only ? CAT.get(only)!.blurb : "What conversations taught us about our buyer, market, positioning and product. Pick a theme to see who said it."}</p>
        </div>
        {only && <Close onClick={() => setFocus(null)} />}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {cats.map(({ c, themes }) => (
          <div key={c.id} className="pb-2">
            {!only && (
              <button type="button" onClick={() => setFocus(`cat:${c.id}`)} className="flex w-full items-center gap-1.5 px-2 pb-0.5 pt-2 text-left text-[11.5px] font-medium text-muted-foreground hover:text-foreground">
                <span className="h-2 w-2 rounded-[2px]" style={{ background: c.color }} />{c.label}<span className="font-normal tabular-nums">{themes.length}</span>
              </button>
            )}
            {themes.slice(0, only ? 200 : 8).map((t) => <ThemeRow key={t.id} t={t} setFocus={setFocus} />)}
            {!only && themes.length > 8 && (
              <button type="button" onClick={() => setFocus(`cat:${c.id}`)} className="px-2 text-[11.5px] text-muted-foreground hover:text-foreground">Show all {themes.length}</button>
            )}
          </div>
        ))}
        {!cats.length && <p className="px-2 pt-2 text-[12.5px] text-muted-foreground">Nothing matches.</p>}
      </div>
    </div>
  );
}

function ThemePanel({ theme, accounts, setFocus }: { theme: Theme; accounts: Acc[]; setFocus: (id: string | null) => void }) {
  const [all, setAll] = useState(false);
  const c = CAT.get(theme.category!)!;
  const items = [...theme.items].sort((a, b) => String(b.occurred_at ?? "").localeCompare(String(a.occurred_at ?? "")));
  const stats = [
    { label: "Calls", value: String(theme.callCount) },
    { label: "People", value: String(theme.peopleCount || new Set(theme.items.map((i) => i.speakerId ?? i.speaker).filter(Boolean)).size) },
    { label: "Accounts", value: String(accounts.length) },
  ];
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex items-start gap-3 px-4 pb-3 pt-4">
        <div className="min-w-0 flex-1">
          <button type="button" onClick={() => setFocus(`cat:${c.id}`)} className="flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground">
            <span className="h-2 w-2 rounded-[2px]" style={{ background: c.color }} />{c.label}
            <span>· {theme.tier === "pattern" ? "Pattern" : "Emerging"}</span>
          </button>
          <p className="pt-1 text-[15px] font-medium leading-snug tracking-[-0.01em] text-foreground">{theme.title}</p>
        </div>
        <Close onClick={() => setFocus(null)} />
      </div>
      <div className="mx-4 grid grid-cols-3 border-y border-hairline">
        {stats.map((s, i) => (
          <div key={s.label} className={cn("min-w-0 py-2.5", i > 0 && "border-l border-hairline pl-3")}>
            <div className="text-[11px] text-muted-foreground">{s.label}</div>
            <div className="truncate pt-0.5 text-[14px] font-medium tabular-nums text-foreground">{s.value}</div>
          </div>
        ))}
      </div>
      {theme.takeaway && <p className="px-4 pt-3.5 text-[13.5px] leading-relaxed text-foreground/90">{theme.takeaway}</p>}

      {accounts.length > 0 && (
        <div className="px-2 pt-4">
          <span className="block px-2 pb-0.5 text-[11.5px] font-medium text-muted-foreground">Raised by <span className="font-normal tabular-nums">{accounts.length}</span></span>
          {accounts.map((a) => (
            <button key={a.id} type="button" onClick={() => setFocus(a.id)} className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1 text-left transition-colors hover:bg-hover">
              <AccountLogo name={a.label} domain={a.domain} size={18} />
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground/85">{a.label}</span>
            </button>
          ))}
        </div>
      )}

      <div className="px-4 pb-4 pt-4">
        <div className="pb-1 text-[11.5px] font-medium text-muted-foreground">In their words <span className="font-normal tabular-nums">{items.length}</span></div>
        <ul>
          {(all ? items : items.slice(0, 5)).map((i) => (
            <li key={i.id} className="ml-[2px] border-l border-hairline py-1.5 pl-3">
              <p className="text-[12.5px] leading-snug text-foreground/90">{i.statement}</p>
              {i.quote && <p className="pt-1 text-[12px] italic leading-snug text-muted-foreground">“{i.quote}”</p>}
              <p className="pt-0.5 text-[11px] text-muted-foreground">{[i.speaker, ago(daysSince(i.occurred_at)) ?? i.date].filter(Boolean).join(" · ")}</p>
            </li>
          ))}
        </ul>
        {items.length > 5 && (
          <button type="button" onClick={() => setAll((v) => !v)} className="ml-3 pt-0.5 text-[11.5px] text-muted-foreground hover:text-foreground">
            {all ? "Show fewer" : `Show all ${items.length}`}
          </button>
        )}
      </div>
    </div>
  );
}

function AccountPanel({ account, themes, setFocus }: { account: Acc; themes: Theme[]; setFocus: (id: string | null) => void }) {
  const navigate = useNavigate();
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex items-start gap-3 px-4 pb-3 pt-4">
        <AccountLogo name={account.label} domain={account.domain} size={40} className="rounded-[10px]" />
        <div className="min-w-0 flex-1">
          <button type="button" onClick={() => navigate(`/accounts/${account.id}`)} className="group flex max-w-full items-center gap-1 text-left" title="Open account">
            <span className="truncate text-[15px] font-medium tracking-[-0.01em] text-foreground">{account.label}</span>
            <ArrowUpRight className="size-3.5 flex-shrink-0 text-muted-foreground group-hover:text-foreground" />
          </button>
          <span className="block text-[12px] text-muted-foreground">Raised {themes.length} {themes.length === 1 ? "theme" : "themes"}</span>
        </div>
        <Close onClick={() => setFocus(null)} />
      </div>
      <div className="px-2 pb-3">
        {CATS.map((c) => {
          const ts = themes.filter((t) => t.category === c.id);
          if (!ts.length) return null;
          return (
            <div key={c.id} className="pb-2">
              <span className="flex items-center gap-1.5 px-2 pb-0.5 pt-2 text-[11.5px] font-medium text-muted-foreground">
                <span className="h-2 w-2 rounded-[2px]" style={{ background: c.color }} />{c.label}
              </span>
              {ts.map((t) => <ThemeRow key={t.id} t={t} setFocus={setFocus} />)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
