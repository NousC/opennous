import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Search, Home, Columns3, Building2, CheckSquare, HeartHandshake, BarChart3, Lightbulb, Zap, Settings as SettingsIcon,
} from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { usePlan } from "@/hooks/usePlan";
import { isApiTier } from "@/config/plans";
import { useDealPages } from "@/hooks/useDealPages";
import { dealOrAccountPath } from "@/lib/dealPages";
import type { DealsPayload, PipelineDeal } from "@/components/pipeline/dealModel";
import { fetchPipelineDeals, pipelineDealsKey, readRememberedCountry } from "@/components/pipeline/usePipelineData";
import { faviconUrl } from "@/lib/externalImages";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

interface Item {
  id: string;
  label: string;
  sublabel?: string;
  group: string;
  icon?: React.ElementType;
  badge?: string;
  domain?: string | null;   // company → favicon logo
  photo?: string | null;    // person → profile photo
  action: () => void;
}

// The pages, in the sidebar's order. `workspace` marks the ones the API plan does not have (the
// app doing the work for you), so the palette never offers a jump to a page the rail hides.
const NAV_ITEMS = [
  { id: "home",        label: "Home",        sublabel: "What needs you today",          icon: Home,           path: "/" },
  { id: "pipeline",    label: "Pipeline",    sublabel: "Your deals, stage by stage",    icon: Columns3,       path: "/pipeline",    workspace: true },
  { id: "accounts",    label: "Accounts",    sublabel: "Every company you work",        icon: Building2,      path: "/accounts" },
  { id: "tasks",       label: "Tasks",       sublabel: "What you owe",                  icon: CheckSquare,    path: "/tasks",       workspace: true },
  { id: "customers",   label: "Customers",   sublabel: "Who is paying, who is at risk", icon: HeartHandshake, path: "/customers",   workspace: true },
  { id: "reports",     label: "Reports",     sublabel: "How the work is going",         icon: BarChart3,      path: "/reporting",   workspace: true },
  { id: "insights",    label: "Insights",    sublabel: "What buyers are telling you",   icon: Lightbulb,      path: "/insights",    workspace: true },
  { id: "automations", label: "Workflows", sublabel: "What runs on its own",          icon: Zap,            path: "/workflows", workspace: true },
  { id: "settings",    label: "Settings",    sublabel: "Workspace and billing",         icon: SettingsIcon,   path: "/settings" },
];

const NO_DEALS: PipelineDeal[] = [];

// The little square beside each result: a nav icon, a person's photo, a company's
// favicon logo, or — when none resolves — the initial letter.
function ResultAvatar({ item }: { item: Item }) {
  const [broken, setBroken] = useState(false);
  if (item.icon) {
    return (
      <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md border border-border/60 bg-background text-muted-foreground/70">
        <item.icon className="h-[13px] w-[13px]" strokeWidth={1.75} />
      </span>
    );
  }
  const isPerson = item.group === "People";
  const src = !broken
    ? (item.photo || faviconUrl(item.domain))
    : null;
  if (src) {
    return (
      <img
        src={src}
        alt=""
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
        className={`h-6 w-6 flex-shrink-0 ${isPerson ? "rounded-full object-cover" : "rounded-md border border-border/60 bg-white object-contain"}`}
      />
    );
  }
  return (
    <span className={`flex h-6 w-6 flex-shrink-0 items-center justify-center bg-muted text-[11px] font-semibold text-muted-foreground/80 ${isPerson ? "rounded-full" : "rounded-md"}`}>
      {item.badge}
    </span>
  );
}

export function CommandPalette() {
  const { session, userData } = useAuth();
  const navigate  = useNavigate();
  const [open,    setOpen]    = useState(false);
  const [query,   setQuery]   = useState("");
  const [results, setResults] = useState<Item[]>([]);
  const [idx,     setIdx]     = useState(0);
  const [companies, setCompanies] = useState<any[]>([]);
  const inputRef  = useRef<HTMLInputElement>(null);
  const searchRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { plan, selfHosted } = usePlan();
  const api = isApiTier(plan);
  // A deal opens as its page on the workspace plans on Cloud; elsewhere its account (GET-1008).
  const dealPages = useDealPages();
  const queryClient = useQueryClient();
  const workspaceId = userData?.workspace?.id ?? "";
  const token = session?.access_token ?? "";

  // Deals to search, filtered here like the companies beside them. The whole team's list (the
  // server still limits it to what this viewer may see), fetched the first time somebody types and
  // shared with the Pipeline page's "Anyone" view through the same cache key.
  const country = workspaceId ? readRememberedCountry(workspaceId) : undefined;
  const { data: teamDeals } = useQuery<DealsPayload>({
    queryKey: pipelineDealsKey(workspaceId, "team", country),
    enabled: open && !!query.trim() && !!token && !!workspaceId,
    staleTime: 5 * 60_000,
    queryFn: () => fetchPipelineDeals(token, workspaceId, "team", country),
  });
  // Plus anything the Pipeline page already loaded under another owner or market, so a deal on
  // screen a moment ago is findable before the team list arrives.
  const deals = useMemo(() => {
    if (!open || !workspaceId) return NO_DEALS;
    const byId = new Map<string, PipelineDeal>();
    for (const d of teamDeals?.deals ?? []) byId.set(d.id, d);
    for (const [, data] of queryClient.getQueriesData<DealsPayload>({ queryKey: ["pipeline-deals", workspaceId] })) {
      for (const d of data?.deals ?? []) if (!byId.has(d.id)) byId.set(d.id, d);
    }
    return [...byId.values()];
  }, [open, workspaceId, teamDeals, queryClient]);

  // ⌘K / Ctrl+K toggle + a custom event so the sidebar Search box can open it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") { e.preventDefault(); setOpen(o => !o); }
      if (e.key === "Escape") setOpen(false);
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("open-command-palette", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("open-command-palette", onOpen);
    };
  }, []);

  // Focus on open + pull the company list once (small; filtered client-side).
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIdx(0);
    setTimeout(() => inputRef.current?.focus(), 50);
    const workspaceId = userData?.workspace?.id;
    const token = session?.access_token;
    if (workspaceId && token && companies.length === 0) {
      fetch(`${apiUrl}/api/companies/list?workspaceId=${workspaceId}`, { headers: { Authorization: `Bearer ${token}` } })
        .then(r => (r.ok ? r.json() : null))
        .then(d => { if (d) setCompanies(d.companies ?? d ?? []); })
        .catch(() => {});
    }
  }, [open, session, userData, companies.length]);

  const buildResults = useCallback((q: string, contacts: any[]) => {
    const lq = q.toLowerCase();
    const go = (path: string) => { navigate(path); setOpen(false); };

    const companyItems: Item[] = (q ? companies.filter((c: any) =>
      (c.name ?? "").toLowerCase().includes(lq) || (c.domain ?? "").toLowerCase().includes(lq)) : []
    ).slice(0, 6).map((c: any) => ({
      id: `co-${c.id}`, label: c.name || c.domain || "—", sublabel: c.domain ?? undefined,
      group: "Companies", badge: (c.name || c.domain || "?").charAt(0).toUpperCase(),
      domain: c.domain ?? null,
      action: () => go(`/accounts/${c.id}`),
    }));

    // Open deals first (the ones you are likely to be looking for), then the most recently worked.
    const dealItems: Item[] = (q ? deals.filter((d) =>
      `${d.name ?? ""} ${d.company_name ?? ""}`.toLowerCase().includes(lq)) : []
    ).sort((a, b) => Number(b.status === "open") - Number(a.status === "open")
      || String(b.last_activity_at ?? "").localeCompare(String(a.last_activity_at ?? "")))
    .slice(0, 6).map((d) => ({
      id: `de-${d.id}`, label: d.name || "Untitled deal",
      sublabel: [d.company_name, d.status === "won" ? "Won" : d.status === "lost" ? "Lost" : d.stage?.trim()].filter(Boolean).join(" · ") || undefined,
      group: "Deals", badge: (d.company_name || d.name || "?").charAt(0).toUpperCase(),
      domain: d.company_domain ?? null,
      action: () => go(dealOrAccountPath(dealPages, d.company_id, d.id)),
    }));

    const contactItems: Item[] = contacts.map((c: any) => ({
      id: `pe-${c.id}`,
      label: [c.first_name, c.last_name].filter(Boolean).join(" ") || c.email || "—",
      sublabel: c.job_title ?? c.email ?? undefined,
      group: "People", badge: ([c.first_name, c.last_name].filter(Boolean).join(" ") || c.email || "?").charAt(0).toUpperCase(),
      photo: c.photo_url ?? null,
      action: () => go(`/people/${c.id}`),
    }));

    const navItems: Item[] = NAV_ITEMS
      .filter(n => (!api || !n.workspace) && !(selfHosted && n.id === "insights"))
      .filter(n => !q || n.label.toLowerCase().includes(lq) || (n.sublabel ?? "").toLowerCase().includes(lq))
      .map(n => ({ id: n.id, label: n.label, sublabel: n.sublabel, group: "Go to", icon: n.icon, action: () => go(n.path) }));

    const all = [...companyItems, ...dealItems, ...contactItems, ...navItems];
    setResults(all);
    setIdx(0);
  }, [navigate, companies, deals, api, dealPages]);

  useEffect(() => {
    if (!open) return;
    if (searchRef.current) clearTimeout(searchRef.current);
    if (!query.trim()) { buildResults("", []); return; }
    searchRef.current = setTimeout(async () => {
      let contacts: any[] = [];
      try {
        const workspaceId = userData?.workspace?.id;
        const token = session?.access_token;
        if (workspaceId && token) {
          const res = await fetch(
            `${apiUrl}/api/contacts?workspaceId=${workspaceId}&search=${encodeURIComponent(query)}&limit=6`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          if (res.ok) { const data = await res.json(); contacts = data.contacts ?? []; }
        }
      } catch { /* silent */ }
      buildResults(query, contacts);
    }, 160);
  }, [query, open, buildResults, session, userData]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setIdx(i => Math.min(i + 1, results.length - 1)); }
    if (e.key === "ArrowUp")   { e.preventDefault(); setIdx(i => Math.max(i - 1, 0)); }
    if (e.key === "Enter")     { e.preventDefault(); results[idx]?.action(); }
    if (e.key === "Escape")    { setOpen(false); }
  };

  if (!open) return null;

  const groups: Record<string, Item[]> = {};
  for (const item of results) { (groups[item.group] ??= []).push(item); }
  let flatIdx = 0;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/25 px-4 pt-[16vh] backdrop-blur-[2px]"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-[600px] overflow-hidden rounded-2xl border border-border/70 bg-card shadow-modal"
        onClick={e => e.stopPropagation()}
      >
        {/* Input */}
        <div className="flex items-center gap-2.5 px-3.5 py-3">
          <Search className="h-[16px] w-[16px] flex-shrink-0 text-muted-foreground/50" strokeWidth={1.75} />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search people, companies, deals, or jump to a page"
            className="flex-1 bg-transparent text-[14px] text-foreground placeholder:text-muted-foreground/45 outline-none"
          />
          <kbd className="flex-shrink-0 rounded-md border border-border px-1.5 py-0.5 text-[10.5px] font-medium text-muted-foreground/50">ESC</kbd>
        </div>

        {/* Results */}
        {results.length > 0 && (
          <div className="max-h-[420px] overflow-y-auto border-t border-border/50 px-2 py-2">
            {Object.entries(groups).map(([group, items]) => (
              <div key={group} className="mb-1 last:mb-0">
                <div className="px-2 pb-1 pt-2 text-[11px] font-medium text-muted-foreground/50">{group}</div>
                {items.map(item => {
                  const isSelected = flatIdx++ === idx;
                  return (
                    <button
                      key={item.id}
                      className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors ${
                        isSelected ? "bg-muted" : "hover:bg-muted/50"
                      }`}
                      onClick={item.action}
                      onMouseEnter={() => setIdx(results.indexOf(item))}
                    >
                      <ResultAvatar item={item} />
                      <span className="flex min-w-0 flex-1 items-baseline gap-2">
                        <span className="truncate text-[13px] text-foreground">{item.label}</span>
                        {item.sublabel && <span className="truncate text-[11.5px] text-muted-foreground/55">{item.sublabel}</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}
        {query && results.length === 0 && (
          <div className="border-t border-border/50 px-4 py-8 text-center text-[13px] text-muted-foreground/50">No results</div>
        )}
      </div>
    </div>
  );
}
