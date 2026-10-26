// The Webhooks page's outbound half (GET-632, redesigned as expandable rows in GET-675). Outbound
// endpoints are trigger_subscriptions (/api/triggers): one compact row each (destination, health,
// event count, enabled switch, actions) that opens in place to its full destination, its events
// and its recent deliveries with Resend (C2, GET-624). The signing secret is never listed: it shows
// once, with Copy, right after the endpoint is created or an admin rotates it. The tools card
// (your tools pushing into Nous) is passed in by the page, which already owns that data.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Copy, Github, MoreHorizontal, Plus, Webhook } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/sonner";
import { useApiTopBar } from "@/components/shell/apiTopBarContext";
import { useAuth } from "@/contexts/AuthContext";
import { isWorkspaceAdmin } from "@/lib/roles";
import { NewEndpointDialog, eventDef, type EditableEndpoint } from "@/components/webhooks/NewEndpointDialog";
import { ListAction, ListCard, ListEmpty, ListGroup, ListHeader, ListText, ListTile, listRowClass } from "@/components/ui/list";
import { day, time } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  deliveryStatus, formatDuration, isFailing, resendMessage, successLabel, testSendMessage,
  type Delivery, type DeliveryStats, type DeliveryTone,
} from "@/lib/webhookDeliveries";

const apiUrl = import.meta.env.VITE_API_URL ?? "";
const EVENT_REFERENCE_URL = "https://docs.opennous.cloud/public-api/webhooks/events";
const DELIVERIES_SHOWN = 10;

/** The board's small 28×16 switch, on the shared primitive. */
const smallSwitchCls =
  "h-4 w-7 border-0 px-0.5 [&>span]:h-3 [&>span]:w-3 [&>span]:shadow-none [&>span]:data-[state=checked]:translate-x-3";

type Endpoint = {
  id: string;
  name: string;
  url: string | null;
  /** GET-670: a URL, or a GitHub repo whose Actions run on each event. Absent on older API builds. */
  destination?: { type: "url"; url: string } | { type: "github"; repo: string } | { type: "slack"; hint?: string } | { type: "claude"; url: string; task?: string | null };
  /** "after_call" when the Settings → Automations toggle owns it (GET-672). */
  managed_by?: string | null;
  events: string[];
  active: boolean;
  created_at: string;
};

// Toast once per endpoint per session, not on every refresh.
const toastedFailing = new Set<string>();

const TONE: Record<DeliveryTone, string> = {
  ok: "text-positive",
  error: "text-risk",
  timeout: "text-warning",
};

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (value: string, key: string) => {
    navigator.clipboard?.writeText(value).catch(() => {});
    setCopied(key);
    setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
  };
  return { copied, copy };
}

/** A read-only mono value with Copy, inside an opened row: a URL, a repo, a one-time secret. */
export function CopyField({ id, label, value, copied, onCopy, copyLabel, children }: {
  id: string; label: string; value: string; copied: boolean; onCopy: () => void; copyLabel: string; children?: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1 block text-[11.5px] text-muted-foreground/70">{label}</label>
      <div className="flex h-8 min-w-0 items-center gap-1 rounded-lg bg-hover pl-2.5 pr-1">
        <input id={id} readOnly value={value} onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 border-0 bg-transparent font-mono text-[12px] text-foreground outline-none" />
        <Button variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-[12px] text-ink-2 [&_svg]:size-3.5" aria-label={copyLabel} onClick={onCopy}>
          {copied ? <><Check className="text-positive" />Copied</> : <><Copy />Copy</>}
        </Button>
        {children}
      </div>
    </div>
  );
}

function whenSent(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  return d.toDateString() === today.toDateString() ? time(d) : `${day(d)} ${time(d)}`;
}

/** "hooks.n8n.cloud/webhook/nous" — host and path, no scheme or query. */
function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
}

// Automation tools people point endpoints at, by host, so the row leads with their logo.
const HOST_LOGOS: [needle: string, logo: string][] = [
  ["n8n", "n8n.svg"], ["zapier", "zapier.svg"], ["slack", "slack.svg"], ["airtable", "airtable.svg"],
  ["hubspot", "hubspot.svg"], ["clickup", "clickup.svg"], ["notion", "notion.svg"],
];

function EndpointTile({ ep }: { ep: Endpoint }) {
  const [broken, setBroken] = useState(false);
  if (ep.destination?.type === "slack") {
    return <ListTile><img src="/provider-logos/slack.svg" alt="" className="h-3.5 w-3.5 object-contain" /></ListTile>;
  }
  if (ep.destination?.type === "github") {
    return <ListTile className="text-foreground"><Github className="h-3.5 w-3.5" strokeWidth={1.8} /></ListTile>;
  }
  if (ep.destination?.type === "claude") {
    return <ListTile><img src="/provider-logos/claude.svg" alt="" className="h-3.5 w-3.5 object-contain" /></ListTile>;
  }
  let host = "";
  try { host = new URL(ep.url ?? "").host.toLowerCase(); } catch { /* not a URL */ }
  const logo = HOST_LOGOS.find(([needle]) => host.includes(needle))?.[1];
  return (
    <ListTile>
      {logo && !broken
        ? <img src={`/provider-logos/${logo}`} alt="" className="h-3.5 w-3.5 object-contain" onError={() => setBroken(true)} />
        : <Webhook className="h-3.5 w-3.5" strokeWidth={1.75} />}
    </ListTile>
  );
}

function EndpointRow({
  ep, token, workspaceId, refreshKey, open, onOpenChange, secret, canRotate, onSecretDone,
  onToggle, onEdit, onRotate, onDelete, onFailing,
}: {
  ep: Endpoint; token: string; workspaceId: string; refreshKey: number;
  open: boolean; onOpenChange: (open: boolean) => void;
  /** A secret just issued for this endpoint (create or rotate), shown once until dismissed. */
  secret: string | null; canRotate: boolean; onSecretDone: () => void;
  onToggle: (active: boolean) => void; onEdit: () => void; onRotate: () => void; onDelete: () => void;
  onFailing: (id: string, failing: boolean, stats: DeliveryStats | null) => void;
}) {
  const [stats, setStats] = useState<DeliveryStats | null>(null);
  const [rows, setRows] = useState<Delivery[] | null>(null);
  const [resending, setResending] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const { copied, copy } = useCopy();
  const isGithub = ep.destination?.type === "github";
  // Owned by the "After every call" toggle: switched on and off in Settings → Automations.
  const managed = !!ep.managed_by;
  const isSlack = ep.destination?.type === "slack";
  // A Claude scheduled task (GET-1035): fired with its own token, so no signing secret applies.
  const isClaude = ep.destination?.type === "claude";
  // A Slack incoming webhook is never sent back whole (GET-941): the row shows its start.
  const target = ep.destination?.type === "github" ? ep.destination.repo
    : ep.destination?.type === "slack" ? (ep.destination.hint ?? "Slack")
    : ep.destination?.type === "claude" ? (ep.destination.task ? `Claude task ${ep.destination.task}` : "Claude task")
    : (ep.url ?? "");
  const qs = `workspace_id=${encodeURIComponent(workspaceId)}`;
  const onFailingRef = useRef(onFailing);
  onFailingRef.current = onFailing;
  const panelId = `wh-ep-${ep.id}`;

  const loadLog = useCallback(async () => {
    if (!token || !workspaceId) return;
    const h = { Authorization: `Bearer ${token}` };
    // Either call can 404/500 while the delivery log is new (the migration may not be applied
    // yet): the row then shows no rate and an empty log rather than an error.
    const [s, d] = await Promise.all([
      fetch(`${apiUrl}/api/triggers/${ep.id}/stats?${qs}`, { headers: h })
        .then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`${apiUrl}/api/triggers/${ep.id}/deliveries?limit=${DELIVERIES_SHOWN}&${qs}`, { headers: h })
        .then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    const st = s && typeof s.deliveries_7d === "number" ? (s as DeliveryStats) : null;
    const list = Array.isArray(d?.deliveries) ? (d.deliveries as Delivery[]) : [];
    setStats(st);
    setRows(list);
    onFailingRef.current(ep.id, ep.active && isFailing(st, list), st);
  }, [token, workspaceId, ep.id, ep.active, qs]);

  useEffect(() => { loadLog(); }, [loadLog, refreshKey]);

  const resend = async (row: Delivery) => {
    setResending(row.id);
    try {
      const r = await fetch(`${apiUrl}/api/triggers/deliveries/${row.id}/resend?${qs}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId }),
      });
      const body = await r.json().catch(() => null);
      const out = resendMessage(r.status, body);
      if (out.ok) toast.success(out.message);
      else toast.error(out.message);
      await loadLog();
    } catch {
      toast.error("Couldn't resend. Try again.");
    } finally {
      setResending(null);
    }
  };

  // Send test: one webhook.test event, sent while you wait through the same signed send as real
  // events, then this row's log and rate reload so the attempt shows at the top.
  const sendTest = async () => {
    setTesting(true);
    try {
      const r = await fetch(`${apiUrl}/api/triggers/${ep.id}/test?${qs}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId }),
      });
      const body = await r.json().catch(() => null);
      const out = testSendMessage(r.status, body);
      if (out.ok) toast.success(out.message);
      else toast.error(out.message);
      await loadLog();
      onOpenChange(true);
    } catch {
      toast.error("Couldn't send a test. Try again.");
    } finally {
      setTesting(false);
    }
  };

  const rate = successLabel(stats);
  const failing = ep.active && isFailing(stats, rows);
  const health = !ep.active
    ? { label: "Paused", cls: "text-muted-foreground/70" }
    : failing
    ? { label: "Failing", cls: "text-risk" }
    : rate
    ? { label: <>{rate.replace(/ delivered · 7 days$/, "")}<span className="max-sm:hidden"> delivered</span></>, cls: "text-positive" }
    : stats
    ? { label: "No deliveries yet", cls: "text-muted-foreground/70" }
    : null;
  const toggleOpen = () => onOpenChange(!open);

  return (
    <div className={cn("rounded-lg transition-colors duration-fast", open && "bg-hover/40")}>
      {/* The row opens on a click anywhere outside its own controls; the name is the keyboard target. */}
      <div className={cn(listRowClass, "cursor-pointer", open && "hover:bg-transparent")} onClick={toggleOpen}>
        <EndpointTile ep={ep} />
        <button type="button" aria-expanded={open} aria-controls={panelId}
          onClick={(e) => { e.stopPropagation(); toggleOpen(); }}
          className="flex min-w-0 flex-1 items-baseline gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <ListText
            titleClassName="sm:flex-shrink-0 sm:max-w-[60%]"
            title={ep.name}
            sub={<span className="max-sm:hidden">{managed ? "From Workflows · " : ""}{isGithub || isSlack || isClaude ? (isSlack ? `Slack · ${target}` : target) : shortUrl(target)}</span>}
          />
        </button>
        {health && (
          <span title={failing && stats ? `${stats.failures_7d} failed deliveries in the last 7 days, including the latest` : rate ?? undefined}
            className={cn("flex-shrink-0 whitespace-nowrap text-[12px] tabular-nums", health.cls)}>
            {health.label}
          </span>
        )}
        <span className="hidden w-[66px] flex-shrink-0 text-right text-[12px] tabular-nums text-muted-foreground/70 sm:inline">
          {ep.events.length} {ep.events.length === 1 ? "event" : "events"}
        </span>
        <span className="flex flex-shrink-0 items-center" onClick={(e) => e.stopPropagation()}>
          <Switch aria-label={`${ep.name} enabled`} className={smallSwitchCls} checked={ep.active} onCheckedChange={onToggle} disabled={managed}
            title={managed ? "Turned on and off in Settings → Workflows" : undefined} />
        </span>
        <span className="flex flex-shrink-0 items-center" onClick={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" aria-label={`${ep.name} actions`}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onSelect={sendTest} disabled={testing || !ep.active}>
                {testing ? "Sending…" : ep.active ? "Send test" : "Send test (enable first)"}
              </DropdownMenuItem>
              {!managed && <DropdownMenuItem onSelect={onEdit}>Edit</DropdownMenuItem>}
              {!managed && canRotate && !isGithub && !isClaude && <DropdownMenuItem onSelect={onRotate}>Rotate signing secret</DropdownMenuItem>}
              {!managed && <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onDelete} className="text-risk focus:text-risk">Delete</DropdownMenuItem>
              </>}
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
        <ChevronDown aria-hidden className={cn("h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/50 transition-transform duration-fast max-sm:hidden", open && "rotate-180")} />
      </div>

      {open && (
        <div id={panelId} className="space-y-4 pb-3 pl-2 pr-2 pt-1 sm:pl-[42px]">
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(280px,100%),1fr))]">
            <CopyField id={`wh-url-${ep.id}`} label={isGithub ? "GitHub repo" : isSlack ? "Slack webhook (shown shortened)" : isClaude ? "Claude task" : "Endpoint URL"} value={target}
              copied={copied === "url"} onCopy={() => copy(target, "url")} copyLabel={isGithub ? "Copy repo" : "Copy endpoint URL"} />
            {secret && !isSlack && !isClaude && (
              <CopyField id={`wh-sec-${ep.id}`} label="Signing secret · shown once" value={secret}
                copied={copied === "secret"} onCopy={() => copy(secret, "secret")} copyLabel="Copy signing secret">
                <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[12px]" onClick={onSecretDone}>Done</Button>
              </CopyField>
            )}
          </div>

          <div className="flex flex-wrap gap-1">
            {ep.events.map((ev) => {
              const def = eventDef(ev);
              return (
                <span key={ev} title={def ? `${def.label}. ${def.description}` : undefined}
                  className="inline-flex h-5 items-center whitespace-nowrap rounded-md bg-hover px-[7px] font-mono text-[11px] text-ink-2">
                  {ev}
                </span>
              );
            })}
          </div>

          <div className="-mx-2">
            <ListGroup className="pt-0">Recent deliveries</ListGroup>
            {rows === null ? (
              <div className="mx-2 h-20 animate-pulse rounded-lg bg-muted/40" />
            ) : rows.length === 0 ? (
              <ListEmpty className="text-[12.5px]">No deliveries yet.</ListEmpty>
            ) : (
              rows.map((r) => {
                const st = deliveryStatus(r);
                return (
                  <div key={r.id} className="group flex min-h-9 items-center gap-3 rounded-lg px-2 py-1 transition-colors duration-fast hover:bg-hover">
                    <span className="flex-shrink-0 whitespace-nowrap text-[12px] tabular-nums text-muted-foreground/70 sm:w-[84px]">{whenSent(r.created_at)}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground" title={r.event_id ?? undefined}>{r.event}</span>
                    <span className={cn("flex-shrink-0 text-[12px] tabular-nums sm:w-[58px]", TONE[st.tone])} title={r.error ?? undefined}>{st.label}</span>
                    <span className="hidden w-[68px] flex-shrink-0 text-[12px] tabular-nums text-muted-foreground/70 sm:inline">Attempt {r.attempt}</span>
                    <span className="hidden w-[52px] flex-shrink-0 text-right text-[12px] tabular-nums text-muted-foreground/70 sm:inline">{formatDuration(r.duration_ms)}</span>
                    <ListAction onClick={() => resend(r)} disabled={resending === r.id}
                      className={cn("w-[64px] text-right max-sm:w-auto max-sm:opacity-100", resending === r.id && "opacity-100")}>
                      {resending === r.id ? "Sending…" : "Resend"}
                    </ListAction>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function ApiWebhooks({
  token, workspaceId, inbound, onRefreshInbound, only = null, bare = false,
}: {
  token: string; workspaceId: string; inbound: ReactNode; onRefreshInbound: () => void;
  /** One side only, without the tabs: "out" on the Events page's Endpoints tab, "in" on Webhooks. */
  only?: "out" | "in" | null;
  /** Inside another page: no page frame, and the page keeps the top bar's refresh. */
  bare?: boolean;
}) {
  const [endpoints, setEndpoints] = useState<Endpoint[] | null>(null);
  // Two directions, one tab each: what we send out (Endpoints) and what your tools send in (Incoming).
  const [tabSide, setSide] = useState<"out" | "in">("out");
  const side = only ?? tabSide;
  const [availableEvents, setAvailableEvents] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<EditableEndpoint | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [failing, setFailing] = useState<Record<string, number>>({});
  // Several rows can be open at once. A failing endpoint opens itself, once, so its log is in view.
  const [open, setOpen] = useState<Set<string>>(new Set());
  const autoOpened = useRef(new Set<string>());
  // The one secret on screen: just created or just rotated. Never refetched — the list has none.
  const [fresh, setFresh] = useState<{ id: string; secret: string } | null>(null);
  const { userData } = useAuth();
  const canRotate = isWorkspaceAdmin(userData);
  const qs = `workspace_id=${encodeURIComponent(workspaceId)}`;

  const setRowOpen = useCallback((id: string, isOpen: boolean) => {
    setOpen((cur) => {
      if (cur.has(id) === isOpen) return cur;
      const next = new Set(cur);
      if (isOpen) next.add(id); else next.delete(id);
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    if (!token || !workspaceId) return;
    setLoading(true);
    try {
      const r = await fetch(`${apiUrl}/api/triggers?${qs}`, { headers: { Authorization: `Bearer ${token}` } });
      const data = r.ok ? await r.json() : null;
      setEndpoints(data?.triggers ?? []);
      setAvailableEvents(new Set(data?.available_events ?? []));
    } catch {
      setEndpoints([]);
    } finally {
      setLoading(false);
    }
  }, [token, workspaceId, qs]);
  useEffect(() => { load(); }, [load]);

  const refresh = useCallback(() => {
    load();
    setRefreshKey((k) => k + 1);
    onRefreshInbound();
  }, [load, onRefreshInbound]);
  useApiTopBar({ onRefresh: refresh, refreshing: loading, enabled: !bare });

  const patch = async (id: string, body: Record<string, unknown>) => {
    const r = await fetch(`${apiUrl}/api/triggers/${id}?${qs}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: workspaceId, ...body }),
    });
    if (!r.ok) throw new Error("update_failed");
    return r.json().catch(() => ({}));
  };

  const setActive = async (id: string, active: boolean) => {
    setEndpoints((list) => list?.map((e) => (e.id === id ? { ...e, active } : e)) ?? list);
    try {
      await patch(id, { active });
    } catch {
      setEndpoints((list) => list?.map((e) => (e.id === id ? { ...e, active: !active } : e)) ?? list);
      toast.error("Couldn't update the endpoint.");
    }
  };

  const rotate = async (id: string) => {
    if (!confirm("Rotate the signing secret? The current secret stops working immediately.")) return;
    try {
      const out = await patch(id, { rotate_secret: true });
      if (typeof out?.signing_secret === "string") {
        setFresh({ id, secret: out.signing_secret });
        setRowOpen(id, true);
      }
      toast.success("Signing secret rotated", { description: "Copy the new secret now. It won't be shown again." });
      await load();
    } catch {
      toast.error("Couldn't rotate the secret.");
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this endpoint? Events not yet delivered to it are dropped.")) return;
    const r = await fetch(`${apiUrl}/api/triggers/${id}?${qs}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok && r.status !== 204) { toast.error("Couldn't delete the endpoint."); return; }
    setEndpoints((list) => list?.filter((e) => e.id !== id) ?? list);
  };

  const onFailing = useCallback((id: string, isBad: boolean, stats: DeliveryStats | null) => {
    if (isBad && !autoOpened.current.has(id)) {
      autoOpened.current.add(id);
      setRowOpen(id, true);
    }
    setFailing((cur) => {
      const has = id in cur;
      if (isBad === has && (!isBad || cur[id] === stats?.failures_7d)) return cur;
      const next = { ...cur };
      if (isBad) next[id] = stats?.failures_7d ?? 0; else delete next[id];
      return next;
    });
  }, [setRowOpen]);

  const failingList = useMemo(
    () => (endpoints ?? []).filter((e) => e.id in failing).map((e) => ({ ...e, failures: failing[e.id] })),
    [endpoints, failing],
  );

  useEffect(() => {
    for (const e of failingList) {
      if (toastedFailing.has(e.id)) continue;
      toastedFailing.add(e.id);
      toast.error(`Webhook failing: ${e.name}`, { description: `${e.failures} failed deliveries in the last 7 days.` });
    }
  }, [failingList]);

  return (
    <div className={bare ? "min-w-0" : "h-full min-w-0 overflow-y-auto bg-background"}>
      <div className={cn("flex w-full min-w-0 flex-col gap-4", !bare && "p-4 sm:p-5")}>
        {!only && <div role="tablist" aria-label="Webhook direction" className="flex items-center gap-1">
          {([["out", "Endpoints", "Where OpenNous sends your events"], ["in", "Incoming", "Your tools sending data into OpenNous"]] as const).map(([id, label, hint]) => (
            <button key={id} type="button" role="tab" aria-selected={side === id} title={hint} onClick={() => setSide(id)}
              className={cn("h-7 rounded-md px-2.5 text-[13px] transition-colors duration-fast",
                side === id ? "bg-hover text-foreground" : "text-ink-2 hover:bg-hover hover:text-foreground")}>
              {label}
            </button>
          ))}
        </div>}
        {side === "out" && <ListCard>
          <ListHeader
            title="Endpoints"
            count={endpoints === null ? null : endpoints.length}
            className="flex-wrap items-center gap-y-1"
            right={
              <span className="ml-auto flex items-center gap-1">
                <Button variant="ghost" size="sm" className="h-7 px-2 text-[12.5px] text-ink-2" asChild>
                  <a href={EVENT_REFERENCE_URL} target="_blank" rel="noreferrer">Event reference</a>
                </Button>
                <Button size="sm" className="h-7 px-2.5 text-[12.5px]" onClick={() => setAdding(true)} disabled={!workspaceId}>
                  <Plus className="!size-[13px]" />Add endpoint
                </Button>
              </span>
            }
          />
          {endpoints === null ? (
            <div className="space-y-1 p-1">{[0, 1].map((i) => <div key={i} className="h-10 animate-pulse rounded-lg bg-muted/40" />)}</div>
          ) : endpoints.length === 0 ? (
            <ListEmpty>No endpoints yet.</ListEmpty>
          ) : (
            endpoints.map((ep) => (
              <EndpointRow
                key={ep.id}
                ep={ep}
                token={token}
                workspaceId={workspaceId}
                refreshKey={refreshKey}
                open={open.has(ep.id)}
                onOpenChange={(v) => setRowOpen(ep.id, v)}
                secret={fresh?.id === ep.id ? fresh.secret : null}
                canRotate={canRotate}
                onSecretDone={() => setFresh(null)}
                onToggle={(v) => setActive(ep.id, v)}
                onEdit={() => setEditing({ id: ep.id, name: ep.name, url: ep.url, destination: ep.destination, events: ep.events })}
                onRotate={() => rotate(ep.id)}
                onDelete={() => remove(ep.id)}
                onFailing={onFailing}
              />
            ))
          )}
        </ListCard>}

        {side === "in" && inbound}
      </div>

      <NewEndpointDialog
        open={adding}
        onOpenChange={setAdding}
        token={token}
        workspaceId={workspaceId}
        availableEvents={availableEvents}
        onCreated={(created) => {
          if (created?.id && created.signing_secret) {
            setFresh({ id: created.id, secret: created.signing_secret });
            setRowOpen(created.id, true);
          }
          load();
        }}
      />
      <NewEndpointDialog
        open={editing != null}
        onOpenChange={(v) => { if (!v) setEditing(null); }}
        token={token}
        workspaceId={workspaceId}
        availableEvents={availableEvents}
        editing={editing}
        title="Edit endpoint"
        submitLabel="Save"
        onCreated={() => { setEditing(null); load(); setRefreshKey((k) => k + 1); }}
      />
    </div>
  );
}
