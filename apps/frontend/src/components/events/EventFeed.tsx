// The event feed (GET-939): the Events page's list, and an account's Events tab. Each row says what
// happened and when, links to the account, and opens in place to the JSON a webhook receives.
// Reads GET /v2/events (signed in). New events arrive on top every 30 seconds; what was paged in
// stays put.
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Check, Copy } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { ListEmpty, listRowClass } from "@/components/ui/list";
import { cn } from "@/lib/utils";
import { TONE_DOT, eventDay, eventLabel, eventSummary, eventTone, eventsUrl, filterLabel, laterNote, mergeNewer, needsSubscription, type EventsPage, type NousEvent } from "@/lib/events";

const apiUrl = import.meta.env.VITE_API_URL ?? "";
const PAGE = 25;

function EventRow({ e, open, onToggle, showAccount, copied, onCopy }: {
  e: NousEvent; open: boolean; onToggle: () => void; showAccount: boolean;
  copied: boolean; onCopy: (v: string) => void;
}) {
  const summary = eventSummary(e);
  // An event is history and stays as it happened; what became of its claim since is a note behind it.
  const later = laterNote(e.later);
  const json = open ? JSON.stringify(e, null, 2) : "";
  const panel = `event-${e.id}`;
  return (
    <div className={cn("rounded-lg", open && "bg-hover/60")}>
      <div className="flex min-h-10 items-center gap-2 pr-2">
        <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={panel}
          className={cn(listRowClass, "min-w-0 flex-1 gap-2", open && "hover:bg-transparent")}>
          <span aria-hidden className={cn("h-1.5 w-1.5 flex-shrink-0 rounded-full", TONE_DOT[eventTone(e.type)])} />
          <span className="flex-shrink-0 text-[13px] text-foreground">{eventLabel(e.type)}</span>
          {summary && <span className={cn("min-w-0 truncate text-[12.5px] text-muted-foreground/80", later && "flex-shrink text-muted-foreground/60")}>{summary}</span>}
          {later && <span title={e.later?.now?.text ?? e.later?.why ?? undefined} className="max-w-[45%] flex-shrink-0 truncate rounded-md bg-hover px-1.5 py-0.5 text-[12px] text-ink-2 max-sm:hidden">{later}</span>}
        </button>
        {showAccount && e.account?.name && (
          <Link to={`/accounts/${e.account.entity_id}`}
            className="hidden max-w-[200px] flex-shrink-0 truncate rounded-md px-1.5 py-0.5 text-[12.5px] text-ink-2 underline-offset-2 hover:text-foreground hover:underline sm:inline">
            {e.account.name}
          </Link>
        )}
        <span title={new Date(e.occurred_at).toLocaleString()} className="w-[76px] flex-shrink-0 text-right text-[12px] tabular-nums text-muted-foreground/70">{new Date(e.occurred_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
      </div>
      {open && (
        <div id={panel} className="space-y-2 px-2 pb-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground/70">
            <span className="font-mono text-foreground/80">{e.type}</span>
            <span className="font-mono">{e.id}</span>
            <span>{new Date(e.occurred_at).toLocaleString()}</span>
            <span className="flex-1" />
            <Button variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-[12px] text-ink-2 [&_svg]:size-3.5" onClick={() => onCopy(json)}>
              {copied ? <><Check className="text-positive" />Copied</> : <><Copy />Copy JSON</>}
            </Button>
          </div>
          <pre className="max-h-[420px] overflow-auto rounded-lg border border-border/60 bg-card p-3 font-mono text-[11.5px] leading-relaxed text-foreground">{json}</pre>
        </div>
      )}
    </div>
  );
}

export function EventFeed({ type = null, since = null, accountId = null, showAccount = true, refreshKey = 0, onLoading }: {
  /** One event type, or a family like "signal.*". */
  type?: string | null;
  /** Only events from this ISO time on (the date range). */
  since?: string | null;
  /** Only this account's events (an account's Events tab). */
  accountId?: string | null;
  /** The account link on each row; off where the account is the page. */
  showAccount?: boolean;
  /** Bumped by the page's Refresh. */
  refreshKey?: number;
  onLoading?: (loading: boolean) => void;
}) {
  const { session, userData } = useAuth();
  const workspaceId = userData?.workspace?.id ?? "";
  // The session token rotates every minute; read it through a ref so a rotation is not a reload.
  const tokenRef = useRef(session?.access_token ?? "");
  tokenRef.current = session?.access_token ?? "";
  const signedIn = !!session?.access_token;

  const [events, setEvents] = useState<NousEvent[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  // Each new filter starts a new generation; a response from an older one is dropped.
  const gen = useRef(0);
  const loadingRef = useRef(onLoading);
  loadingRef.current = onLoading;
  const busy = (v: boolean) => { setLoading(v); loadingRef.current?.(v); };

  const fetchPage = useCallback(async (after: string | null): Promise<EventsPage | null> => {
    const token = tokenRef.current;
    if (!token || !workspaceId) return null;
    const res = await fetch(eventsUrl(apiUrl, workspaceId, { type, since, account: accountId, after, limit: PAGE }), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(String(res.status));
    return res.json();
  }, [workspaceId, type, since, accountId]);

  const load = useCallback(async () => {
    const mine = ++gen.current;
    busy(true);
    try {
      const page = await fetchPage(null);
      if (mine !== gen.current || !page) return;
      setEvents(page.data); setNext(page.has_more ? page.next_starting_after : null); setFailed(false); setMoreFailed(false);
    } catch { if (mine === gen.current) { setFailed(true); setEvents((v) => v ?? []); } }
    finally { if (mine === gen.current) busy(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchPage]);

  // New events go on top; what was paged in, and an open row, stay where they are.
  const poll = useCallback(async () => {
    const mine = gen.current;
    try {
      const page = await fetchPage(null);
      if (mine !== gen.current || !page) return;
      setEvents((v) => (v ? mergeNewer(v, page.data) : page.data));
    } catch { /* the next poll tries again */ }
  }, [fetchPage]);

  const more = async () => {
    if (!next) return;
    const mine = gen.current;
    busy(true);
    try {
      const page = await fetchPage(next);
      if (mine !== gen.current || !page) return;
      setEvents((v) => { const have = new Set((v ?? []).map((e) => e.id)); return [...(v ?? []), ...page.data.filter((e) => !have.has(e.id))]; });
      setNext(page.has_more ? page.next_starting_after : null); setMoreFailed(false);
    } catch { if (mine === gen.current) setMoreFailed(true); }
    finally { if (mine === gen.current) busy(false); }
  };

  useEffect(() => { if (!signedIn) return; setEvents(null); setOpen(null); load(); }, [load, signedIn]);
  useEffect(() => { if (refreshKey) load(); }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const id = setInterval(poll, 30000);
    return () => clearInterval(id);
  }, [poll]);

  const copy = (id: string, value: string) => {
    navigator.clipboard?.writeText(value).catch(() => {});
    setCopied(id);
    setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
  };

  if (events === null) {
    return <div className="space-y-1 p-1">{[0, 1, 2, 3].map((i) => <div key={i} className="h-10 animate-pulse rounded-lg bg-muted/40" />)}</div>;
  }
  if (events.length === 0) {
    return (
      <ListEmpty>
        {failed ? "Events could not be loaded. Try again in a moment."
          : needsSubscription(type) ? `${filterLabel(type)} are computed once a webhook subscribes to them. Add one under Endpoints, top right.`
          : type && since ? "No events of this kind in this range."
          : since ? "No events in this range."
          : type ? "No events of this kind yet."
          : accountId ? "No events on this account yet. Signals from its calls and email appear here as they are read."
          : "No events yet. Signals from your calls and email appear here as they are read."}
      </ListEmpty>
    );
  }
  return (
    <div>
      {/* Under a heading per day, so a row's time is just the time. */}
      {events.map((e, i) => {
        const day = eventDay(e.occurred_at);
        const first = i === 0 || eventDay(events[i - 1].occurred_at) !== day;
        return (
          <div key={e.id}>
            {first && <div className={cn("px-2 pb-1 text-[11.5px] font-medium text-muted-foreground/70", i === 0 ? "pt-1" : "pt-4")}>{day}</div>}
            <EventRow e={e} open={open === e.id} onToggle={() => setOpen((o) => (o === e.id ? null : e.id))}
              showAccount={showAccount} copied={copied === e.id} onCopy={(v) => copy(e.id, v)} />
          </div>
        );
      })}
      {next && (
        <div className="flex items-center gap-2 px-2 pt-1">
          <Button variant="ghost" size="sm" className="h-7 px-2 text-[12.5px] text-ink-2" onClick={more} disabled={loading}>Load more</Button>
          {moreFailed && <span className="text-[12px] text-risk">Could not load more. Try again.</span>}
        </div>
      )}
    </div>
  );
}
