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
import { AccountTile } from "@/components/pipeline/DealBits";
import { avatarTint, initialsOf } from "@/components/ui/owner-filter";
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

/** "26 Oct, 08:11 PM": the table has no day headings, so each row carries its date. */
function rowWhen(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString([], { day: "numeric", month: "short" })}, ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

// The Events page draws the feed in the Accounts table's exact measures (components/ui/data-table):
// a 34px heading row in 11.5px light text, 42px rows, hairlines only, the hover band, the first
// column inset 20px. Its own rows, not DataTable, because a row opens in place to its JSON. An
// account's Events tab keeps the compact list above.
const COLS = { event: 180, account: 170, contacts: 90, when: 150 };
const cell = (i: number) => (i === 0 ? "pl-5 pr-3" : "px-3");
const HdrCell = ({ label, w, i, grow }: { label: string; w?: number; i: number; grow?: boolean }) => (
  <span className={cn("truncate text-[11.5px] font-normal text-muted-foreground/70", cell(i), grow ? "min-w-0 flex-1" : "flex-shrink-0")}
    style={w ? { width: w } : undefined}>{label}</span>
);

function EventTableRow({ e, open, onToggle, copied, onCopy }: {
  e: NousEvent; open: boolean; onToggle: () => void; copied: boolean; onCopy: (v: string) => void;
}) {
  const summary = eventSummary(e);
  const later = laterNote(e.later);
  const json = open ? JSON.stringify(e, null, 2) : "";
  const panel = `event-${e.id}`;
  const people = (e.people ?? []).filter((p) => p.name);
  return (
    <div className={cn("border-b border-hairline", open && "bg-hover")}>
      <div role="button" tabIndex={0} onClick={onToggle} aria-expanded={open} aria-controls={panel}
        onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); onToggle(); } }}
        className="flex h-[42px] w-full cursor-pointer items-center text-left text-[13px] tabular-nums transition-colors duration-fast hover:bg-hover">
        <div className={cn("flex flex-shrink-0 items-center gap-2.5", cell(0))} style={{ width: COLS.event }}>
          <span aria-hidden className={cn("h-1.5 w-1.5 flex-shrink-0 rounded-full", TONE_DOT[eventTone(e.type)])} />
          <span className="truncate text-foreground">{eventLabel(e.type)}</span>
        </div>
        <div className={cn("flex min-w-0 flex-1 items-center gap-2", cell(1))}>
          {summary ? <span className={cn("min-w-0 truncate text-ink-2", later && "text-muted-foreground/70")}>{summary}</span>
            : <span className="text-muted-foreground/40">—</span>}
          {later && <span title={e.later?.now?.text ?? e.later?.why ?? undefined} className="max-w-[45%] flex-shrink-0 truncate rounded-md bg-hover px-1.5 py-0.5 text-[12px] text-ink-2 max-sm:hidden">{later}</span>}
        </div>
        <div className={cn("flex min-w-0 flex-shrink-0 items-center", cell(2))} style={{ width: COLS.account }}>
          {e.account?.name ? (
            <Link to={`/accounts/${e.account.entity_id}`} onClick={(ev) => ev.stopPropagation()}
              className="flex min-w-0 items-center gap-2.5 underline-offset-2 hover:underline">
              <AccountTile name={e.account.name} domain={e.account.domain ?? null} size={20} />
              <span className="truncate text-foreground">{e.account.name}</span>
            </Link>
          ) : <span className="text-muted-foreground/40">—</span>}
        </div>
        {/* Contacts as the Accounts table draws them: up to three overlapping initials, then +N. */}
        <div className={cn("flex flex-shrink-0 items-center", cell(3))} style={{ width: COLS.contacts }}>
          {people.length ? (
            <>
              {people.slice(0, 3).map((p, i) => (
                <Link key={p.entity_id} to={`/people/${p.entity_id}`} onClick={(ev) => ev.stopPropagation()}
                  title={p.title ? `${p.name}, ${p.title}` : p.name ?? undefined} aria-label={p.name ?? undefined}
                  className={cn("relative flex size-5 items-center justify-center overflow-hidden rounded-full text-[8.5px] font-semibold shadow-[0_0_0_2px_hsl(var(--card))] transition-transform duration-fast hover:-translate-y-0.5", avatarTint(p.name ?? p.entity_id))}
                  style={{ marginLeft: i === 0 ? 0 : -5, zIndex: 10 - i }}>
                  {initialsOf(p.name ?? "") || "?"}
                </Link>
              ))}
              {people.length > 3 && (
                <span className="relative flex size-5 items-center justify-center rounded-full bg-muted text-[8.5px] font-semibold text-ink-2 shadow-[0_0_0_2px_hsl(var(--card))]" style={{ marginLeft: -5 }}>
                  +{people.length - 3}
                </span>
              )}
            </>
          ) : <span className="text-muted-foreground/40">—</span>}
        </div>
        <span title={new Date(e.occurred_at).toLocaleString()} className={cn("flex-shrink-0 truncate text-ink-2", cell(4))} style={{ width: COLS.when }}>
          {rowWhen(e.occurred_at)}
        </span>
      </div>
      {open && (
        <div id={panel} className="space-y-2 pb-4 pl-5 pr-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground/70">
            <span className="font-mono text-foreground/80">{e.type}</span>
            <span className="font-mono">{e.id}</span>
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

export function EventFeed({ type = null, since = null, accountId = null, showAccount = true, table = false, refreshKey = 0, onLoading }: {
  /** One event type, or a family like "signal.*". */
  type?: string | null;
  /** Only events from this ISO time on (the date range). */
  since?: string | null;
  /** Only this account's events (an account's Events tab). */
  accountId?: string | null;
  /** The account link on each row; off where the account is the page. */
  showAccount?: boolean;
  /** Draw as the Accounts table: column headings, one full-width row per event (the Events page). */
  table?: boolean;
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

  // The table pages itself in as you scroll: a marker under the last row loads the next page when
  // it comes into view. The button stays for keyboards and for a failed page.
  const sentinel = useRef<HTMLDivElement>(null);
  const moreRef = useRef(more);
  moreRef.current = more;
  useEffect(() => {
    const el = sentinel.current;
    if (!table || !el || !next || loading || moreFailed) return;
    const io = new IntersectionObserver((entries) => { if (entries[0]?.isIntersecting) moreRef.current(); }, { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [table, next, loading, moreFailed, events?.length]);

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
  if (table) {
    return (
      <div className="min-w-[820px]">
        <div className="sticky top-0 z-20 flex h-[34px] items-center whitespace-nowrap border-b border-hairline bg-card">
          <HdrCell label="Event" w={COLS.event} i={0} />
          <HdrCell label="Details" i={1} grow />
          <HdrCell label="Account" w={COLS.account} i={2} />
          <HdrCell label="Contacts" w={COLS.contacts} i={3} />
          <HdrCell label="Date" w={COLS.when} i={4} />
        </div>
        {events.map((e) => (
          <EventTableRow key={e.id} e={e} open={open === e.id} onToggle={() => setOpen((o) => (o === e.id ? null : e.id))}
            copied={copied === e.id} onCopy={(v) => copy(e.id, v)} />
        ))}
        <div ref={sentinel} aria-hidden className="h-px" />
        {next && (
          <div className="flex items-center gap-2 py-2 pl-4">
            <Button variant="ghost" size="sm" className="h-7 px-2 text-[12.5px] text-ink-2" onClick={more} disabled={loading}>Load more</Button>
            {moreFailed && <span className="text-[12px] text-risk">Could not load more. Try again.</span>}
          </div>
        )}
      </div>
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
