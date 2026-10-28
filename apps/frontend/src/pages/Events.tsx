// Events (GET-939): every event in the workspace as it happens, the way Stripe shows its events.
// The list is the shared feed (components/events/EventFeed); the toolbar's Filter (right) picks one
// family or one type at a time, the way GET /v2/events takes it, and the calendar beside it a date
// range (GET-1014).
import { useMemo, useState } from "react";
import { CalendarDays, Check, Filter } from "lucide-react";
import { useApiTopBar } from "@/components/shell/ApiTopBar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { PageToolbar } from "@/components/ui/page-top-bar";
import { ViewTabs } from "@/components/ui/view-tabs";
import { EventFeed } from "@/components/events/EventFeed";
import { ApiWebhooks } from "@/components/webhooks/ApiWebhooks";
import { useAuth } from "@/contexts/AuthContext";
import { EVENT_FILTER_GROUPS, EVENT_RANGES, TONE_DOT, eventLabel, eventTone, filterLabel, rangeSince } from "@/lib/events";

function Opt({ on, onClick, children, dot }: { on: boolean; onClick: () => void; children: React.ReactNode; dot?: string }) {
  return (
    <button type="button" role="option" aria-selected={on} onClick={onClick}
      className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors duration-fast hover:bg-hover",
        on ? "bg-hover text-foreground" : "text-foreground/90")}>
      {dot !== undefined && <span aria-hidden className={cn("h-1.5 w-1.5 flex-shrink-0 rounded-full", dot)} />}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {on && <Check className="h-3.5 w-3.5 flex-shrink-0 text-foreground" />}
    </button>
  );
}

export default function Events() {
  const { session, userData } = useAuth();
  // Events: what happened. Endpoints: where it is sent (GET-941), the same list the Webhooks page had.
  const [view, setView] = useState<"events" | "endpoints">("events");
  const [type, setType] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [loading, setLoading] = useState(false);
  useApiTopBar({ onRefresh: () => setRefreshKey((k) => k + 1), refreshing: loading });
  const [filterOpen, setFilterOpen] = useState(false);
  const [range, setRange] = useState("any");
  const [rangeOpen, setRangeOpen] = useState(false);
  // Fixed when the range is picked, so the feed's polls do not reload it every render.
  const since = useMemo(() => rangeSince(range), [range, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const rangeLabel = EVENT_RANGES.find((r) => r.id === range)?.label ?? "Any time";
  const pick = (t: string | null) => { setType(t); setFilterOpen(false); setQuery(""); };

  // The filter: a search on top, then each group's "All …" and its types with their dots.
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const groups = EVENT_FILTER_GROUPS
    .map((g) => ({ ...g, types: g.types.filter((t) => !q || eventLabel(t).toLowerCase().includes(q) || t.includes(q)) }))
    .filter((g) => !q || g.types.length || g.label.toLowerCase().includes(q));
  const filter = (
    <div role="listbox" aria-label="Event type">
      <div className="border-b border-hairline p-1.5">
        <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find an event type"
          className="h-8 w-full rounded-md bg-hover px-2.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground/70" />
      </div>
      <div className="max-h-[360px] overflow-y-auto p-1">
        {!q && <Opt on={type === null} onClick={() => pick(null)}>All events</Opt>}
        {groups.map((g) => (
          <div key={g.family} className="pt-1">
            <div className="px-2 pb-0.5 pt-1.5 text-[11px] font-medium text-muted-foreground/70">{g.label}</div>
            {!q && g.types.length > 1 && <Opt on={type === g.family} onClick={() => pick(g.family)}>{`All ${g.label.toLowerCase()}`}</Opt>}
            {g.types.map((t) => (
              <Opt key={t} dot={TONE_DOT[eventTone(t)]} on={type === t} onClick={() => pick(t)}>{eventLabel(t)}</Opt>
            ))}
          </div>
        ))}
        {groups.length === 0 && <p className="px-2 py-2 text-[13px] text-muted-foreground/70">No event type matches.</p>}
      </div>
    </div>
  );

  const iconBtn = "relative inline-flex h-7 w-7 items-center justify-center rounded-lg border border-border bg-card shadow-[0_1px_0_rgba(20,20,18,0.04)] transition-colors duration-fast hover:bg-hover hover:text-foreground";

  // The Accounts page's shape: one toolbar under the top bar (what is shown on the left; Events or
  // Endpoints, the date range and the filter on the right), then the list straight under it, with
  // no card around it and no gap above.
  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background">
      <PageToolbar>
        {/* What is shown, only once something narrows it; unfiltered, the table speaks for itself. */}
        {view === "events" && (type || range !== "any") && (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[13px] text-foreground">{range === "any" ? filterLabel(type) : `${filterLabel(type)} · ${rangeLabel.toLowerCase()}`}</span>
            <button type="button" onClick={() => { setType(null); setRange("any"); }}
              className="rounded-md px-1.5 py-0.5 text-[12.5px] text-ink-2 hover:bg-hover hover:text-foreground">Clear</button>
          </span>
        )}
        <div className="flex-1" />
        <ViewTabs<"events" | "endpoints"> aria-label="Events or endpoints" value={view} onChange={setView}
          options={[{ value: "events", label: "Events" }, { value: "endpoints", label: "Endpoints" }]} />
        {view === "events" && (
          <>
            <Popover open={rangeOpen} onOpenChange={setRangeOpen}>
              <PopoverTrigger asChild>
                <button type="button" title="Date range" aria-label={range === "any" ? "Date range" : `Date range, ${rangeLabel}`}
                  className={cn(iconBtn, range !== "any" ? "text-foreground" : "text-ink-2")}>
                  <CalendarDays className="h-3.5 w-3.5" strokeWidth={1.8} />
                  {range !== "any" && <span aria-hidden className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border-2 border-card bg-foreground" />}
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-[180px] p-1">
                <div role="listbox" aria-label="Date range">
                  {EVENT_RANGES.map((r) => (
                    <Opt key={r.id} on={range === r.id} onClick={() => { setRange(r.id); setRangeOpen(false); }}>{r.label}</Opt>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
            <Popover open={filterOpen} onOpenChange={setFilterOpen}>
              <PopoverTrigger asChild>
                <button type="button" title="Filter" aria-label={type ? "Filter, 1 on" : "Filter"}
                  className={cn(iconBtn, type ? "text-foreground" : "text-ink-2")}>
                  <Filter className="h-3.5 w-3.5" strokeWidth={1.8} />
                  {type && <span aria-hidden className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border-2 border-card bg-foreground" />}
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-[260px] p-0">{filter}</PopoverContent>
            </Popover>
          </>
        )}
      </PageToolbar>
      {/* One scroller both ways, so the table's heading row stays pinned while it scrolls. */}
      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        {view === "endpoints" ? (
          <div className="p-4 sm:p-5">
            <ApiWebhooks token={session?.access_token ?? ""} workspaceId={userData?.workspace?.id ?? ""}
              only="out" bare inbound={null} onRefreshInbound={() => {}} />
          </div>
        ) : (
          <EventFeed table type={type} since={since} refreshKey={refreshKey} onLoading={setLoading} />
        )}
      </div>
    </div>
  );
}
