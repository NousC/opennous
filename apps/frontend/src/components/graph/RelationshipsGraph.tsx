// The graph (GET-473, GET-815, GET-840, GET-841): what the workspace knows, laid out like the other pages.
//
// The toolbar picks where to start: Accounts, People or Deals open the same context graph from a
// different side (ContextGraph.tsx), with the record panel on the right; Insights is what those
// conversations taught us about our buyer, market, positioning and product (InsightsGraph.tsx).
// The tab is in the URL (?view=), as on Accounts.
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Search, X } from "lucide-react";
import { PageToolbar } from "@/components/ui/page-top-bar";
import { ViewTabs } from "@/components/ui/view-tabs";
import { ContextGraph, useContextGraph, type Lens } from "./ContextGraph";
import { InsightsGraph } from "./InsightsGraph";

type View = Lens | "insights";
const VIEWS: { id: View; label: string; param: string }[] = [
  { id: "account", label: "Accounts", param: "accounts" },
  { id: "person", label: "People", param: "people" },
  { id: "deal", label: "Deals", param: "deals" },
  { id: "insights", label: "Insights", param: "insights" },
];
// The Claims tab became Insights; an old link still lands somewhere.
const ALIASES: Record<string, string> = { claims: "insights" };

export function RelationshipsGraph() {
  const [params, setParams] = useSearchParams();
  const asked = params.get("view") ?? "";
  const view = VIEWS.find((v) => v.param === (ALIASES[asked] ?? asked))?.id ?? "account";
  const setView = (v: View) => {
    const next = new URLSearchParams(params);
    if (v === "account") next.delete("view"); else next.set("view", VIEWS.find((x) => x.id === v)!.param);
    setParams(next, { replace: true });
  };
  const [search, setSearch] = useState("");
  const { data } = useContextGraph();
  const count = (t: Lens) => data?.nodes.filter((n) => n.type === t).length;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <PageToolbar>
        <ViewTabs<View> aria-label="Graph views" value={view} onChange={setView}
          options={VIEWS.map((v) => ({ value: v.id, label: v.label, count: v.id === "insights" ? undefined : count(v.id) }))} />
        <div className="hidden flex-1 sm:block" />
        {(
          <label className="inline-flex h-7 w-full items-center gap-[7px] rounded-lg border border-border bg-card px-[9px] text-muted-foreground focus-within:border-foreground/30 sm:w-[200px]">
            <Search className="size-3.5 flex-shrink-0" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find in the graph" aria-label="Find in the graph"
              className="h-full w-full min-w-0 bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground" />
            {search && (
              <button type="button" onClick={() => setSearch("")} aria-label="Clear search" className="flex-shrink-0 hover:text-foreground">
                <X className="size-3.5" />
              </button>
            )}
          </label>
        )}
      </PageToolbar>
      <div className="relative flex min-h-0 flex-1 flex-col md:flex-row">
        {view === "insights"
          ? <InsightsGraph search={search} />
          : <ContextGraph key={view} lens={view} search={search} />}
      </div>
    </div>
  );
}
