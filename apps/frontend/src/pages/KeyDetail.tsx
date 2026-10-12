// One API key (GET-630): who made it, when it was last used and by what, its calls over the last
// 14 days, which tools it calls, its recent requests, and rotate / revoke. Usage comes from the
// per-key endpoints (GET /api/keys/:id/usage and /requests, GET-623). When those can't answer,
// the summary still shows from the key list and the usage sections say so instead of guessing.

import * as React from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { createPortal } from "react-dom";
import { ChevronDown, KeyRound, Pencil, SquareTerminal } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { InlineEditInput } from "@/components/ui/inline-edit-input";
import { useTopBarCrumbs, useTopBarSlot } from "@/components/shell/topBar";
import { useApiTopBar, useInApiShell, useOpenConnect } from "@/components/shell/apiTopBarContext";
import {
  KeyApiError, RevokeKeyDialog, RotateKeyDialog, SecretOnce, lastUsedPhrase, revokedToast, rotatedMessage,
  useKeyApi, useSecretHandoff,
} from "@/components/keys/keyActions";
import {
  EXTEND_OPTIONS, accessLabel, canManageKey, errorRate, extendErrorMessage, extendedExpiry, isExpired, keyNameError, maskedKey,
  renameErrorMessage, statusTone, surfaceLabel,
  type ApiKeyRow, type KeyRequest, type KeyUsage,
} from "@/lib/apiKeys";
import { day, inDays, num, time, toDate, when } from "@/lib/format";
import { cn } from "@/lib/utils";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

/** The summary's facts, from the usage call when it answered, else from the key list. */
type Summary = {
  id: string; name: string; prefix: string | null; access: string; created_at: string;
  created_by: string | null; last_used_at: string | null; last_client: string | null;
  expires_at: string | null; revoked_at: string | null;
  /** May this viewer rotate/revoke it. The usage call only answers for keys the viewer may manage. */
  can_manage: boolean;
};

const fromRow = (k: ApiKeyRow): Summary => ({
  id: k.id, name: k.name, prefix: k.key_prefix ?? null, access: k.capability ?? "read_write",
  created_at: k.created_at, created_by: null, last_used_at: k.last_used_at ?? null, last_client: null,
  expires_at: k.expires_at ?? null, revoked_at: null, can_manage: canManageKey(k),
});

/** Member names by internal user id, for "Created … by Theo". Empty when the read fails. */
function useMemberNames(): Map<string, string> {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const teamId: string = userData?.team?.id ?? "";
  const [names, setNames] = React.useState(() => new Map<string, string>());
  React.useEffect(() => {
    if (!token || !teamId) return;
    let live = true;
    fetch(`${apiUrl}/api/teams/${teamId}/members`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : { members: [] }))
      .then((d) => {
        if (!live) return;
        const m = new Map<string, string>();
        for (const x of d.members ?? []) {
          const name = x.users?.name ?? x.name;
          if (x.user_id && name) m.set(x.user_id, String(name).split(" ")[0]);
        }
        setNames(m);
      })
      .catch(() => {});
    return () => { live = false; };
  }, [token, teamId]);
  return names;
}

const card = "min-w-0 rounded-xl border border-border bg-card";
const label = "text-[12px] text-muted-foreground";

const STATUS_TONE = {
  ok: "bg-positive/10 text-positive",
  warn: "bg-warning/10 text-warning",
  bad: "bg-risk/10 text-risk",
} as const;

/** "14:02:11" today, "2 Oct 14:02" before. */
function requestTime(at: string): string {
  const d = toDate(at);
  if (!d) return "";
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return `${time(d)}:${String(d.getSeconds()).padStart(2, "0")}`;
  return `${day(d)} ${time(d)}`;
}

export default function KeyDetail() {
  const { id = "" } = useParams();
  const api = useKeyApi();
  const navigate = useNavigate();
  const inShell = useInApiShell();
  const openConnect = useOpenConnect();
  const handoff = useSecretHandoff();
  const names = useMemberNames();

  const [summary, setSummary] = React.useState<Summary | null>(null);
  const [usage, setUsage] = React.useState<KeyUsage | null>(null);
  // "missing": neither the usage call nor the key list knows this key. "unavailable": the key
  // exists but its usage could not be read.
  const [state, setState] = React.useState<"loading" | "ready" | "missing" | "unavailable">("loading");
  const [requests, setRequests] = React.useState<KeyRequest[]>([]);
  const [nextBefore, setNextBefore] = React.useState<string | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [rotating, setRotating] = React.useState(false);
  const [revoking, setRevoking] = React.useState(false);
  const [unshown, setUnshown] = React.useState<string | null>(null);
  const [editingName, setEditingName] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!api.ready || !id) return;
    setState((s) => (s === "ready" ? s : "loading"));
    const [u, r, list] = await Promise.allSettled([api.usage(id), api.requests(id), api.list()]);
    const row = list.status === "fulfilled" ? list.value.find((k) => k.id === id) ?? null : null;
    if (u.status === "fulfilled") {
      setUsage(u.value);
      // /api/keys/:id/usage answers only for keys the viewer may see, which are the keys they
      // may manage (the same rule server-side), so the actions show.
      setSummary({ ...u.value.key, can_manage: row ? canManageKey(row) : true });
      setState("ready");
    } else {
      setUsage(null);
      setSummary(row ? fromRow(row) : null);
      const notFound = u.reason instanceof KeyApiError && u.reason.status === 404;
      setState(row ? "unavailable" : notFound || list.status === "fulfilled" ? "missing" : "unavailable");
    }
    if (r.status === "fulfilled") { setRequests(r.value.requests); setNextBefore(r.value.next_before); }
    else { setRequests([]); setNextBefore(null); }
  }, [api, id]);

  React.useEffect(() => { void load(); }, [load]);

  // Rename in place (E1), optimistic: the title changes at once and goes back if the API refuses.
  const rename = async (next: string) => {
    if (!summary) return;
    const prev = summary.name;
    setEditingName(false);
    setSummary((s) => (s ? { ...s, name: next } : s));
    try {
      await api.rename(summary.id, next);
      toast("Key renamed", { description: `${prev} is now ${next}` });
    } catch (e) {
      setSummary((s) => (s && s.name === next ? { ...s, name: prev } : s));
      toast.error(renameErrorMessage(e instanceof KeyApiError ? e.code : null));
    }
  };
  // Extend the expiry (E3), optimistic with rollback.
  const extend = async (days: number) => {
    if (!summary) return;
    const prev = summary.expires_at;
    const guess = extendedExpiry(prev, days);
    setSummary((s) => (s ? { ...s, expires_at: guess } : s));
    try {
      const out = await api.extend(summary.id, days);
      setSummary((s) => (s ? { ...s, expires_at: out.expires_at } : s));
      toast("Key extended", { description: `${summary.name} now expires ${day(out.expires_at)}` });
    } catch (e) {
      setSummary((s) => (s && s.expires_at === guess ? { ...s, expires_at: prev } : s));
      toast.error(extendErrorMessage(e instanceof KeyApiError ? e.code : null));
    }
  };

  const canRename = !!summary && summary.can_manage && !summary.revoked_at && state !== "missing";

  useApiTopBar({
    title: summary?.name ?? null, onRefresh: load, refreshing: state === "loading",
    rename: canRename ? {
      editing: editingName, onEdit: () => setEditingName(true), onSave: (n) => void rename(n),
      onCancel: () => setEditingName(false), validate: keyNameError,
    } : null,
  });

  // Outside the API plan's bar (GET-660) the app's top bar carries the same thing: API keys / name,
  // and the name renames in place from there.
  useTopBarCrumbs(inShell ? null : editingName ? [{ label: "API keys", href: "/keys" }] : [{ label: "API keys", href: "/keys" }, { label: summary?.name ?? "Key" }]);
  const topBarSlot = useTopBarSlot();
  const renameInBar = !inShell && canRename && topBarSlot ? createPortal(
    editingName && summary ? (
      <span className="flex min-w-0 items-center gap-2">
        <span aria-hidden className="text-muted-foreground/30">/</span>
        <InlineEditInput
          value={summary.name} label="Name" validate={keyNameError} maxLength={80}
          onSave={(n) => void rename(n)} onCancel={() => setEditingName(false)}
          className="w-[40vw] sm:w-[280px]"
        />
      </span>
    ) : (
      <button type="button" onClick={() => setEditingName(true)} title="Rename" aria-label="Rename"
        className="-ml-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 outline-none transition-colors duration-fast hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <Pencil className="h-3 w-3" strokeWidth={1.8} />
      </button>
    ),
    topBarSlot,
  ) : null;

  const loadMore = async () => {
    if (!nextBefore || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.requests(id, nextBefore);
      setRequests((rs) => [...rs, ...page.requests]);
      setNextBefore(page.next_before);
    } catch {
      toast.error("Couldn't load more requests.");
    } finally {
      setLoadingMore(false);
    }
  };

  const rotate = async () => {
    if (!summary) return;
    try {
      const created = await api.rotate({ id: summary.id, expires_at: summary.expires_at, created_at: summary.created_at });
      setRotating(false);
      setUnshown(null);
      await handoff(created.key, rotatedMessage(summary.name), setUnshown);
      // The old key is revoked; the new one carries its name, access and the rest of its life.
      navigate(`/keys/${created.id}`, { replace: true });
    } catch {
      toast.error("Couldn't rotate the key. The current one still works.");
    }
  };

  const revoke = async () => {
    if (!summary) return;
    try {
      await api.revoke(summary.id);
      setRevoking(false);
      // Back to the list; the toast (and its Undo) comes along.
      revokedToast(summary.name, { id: summary.id, restore: api.restore });
      navigate("/keys");
    } catch {
      toast.error("Couldn't revoke the key. It still works.");
    }
  };

  const perDay = usage?.per_day ?? [];
  const total = perDay.reduce((n, d) => n + d.calls, 0);
  const noCalls = state === "ready" && total === 0 && requests.length === 0;
  const rate = errorRate(usage?.totals);
  const peak = Math.max(1, ...perDay.map((d) => d.calls));
  const topTool = Math.max(1, ...(usage?.by_route ?? []).map((t) => t.calls));
  const createdBy = summary?.created_by ? names.get(summary.created_by) : undefined;
  const revoked = !!summary?.revoked_at;

  const content = (
    <div className="flex w-full flex-col gap-4 p-4 sm:p-5">
      {state === "loading" && !summary ? (
        <div className={cn(card, "h-[76px] animate-pulse bg-muted/40")} />
      ) : state === "missing" || !summary ? (
        <EmptyState
          icon={<KeyRound strokeWidth={1.7} />}
          title="This key doesn't exist or was revoked"
          action={<Button variant="outline" asChild><Link to="/keys">All keys</Link></Button>}
        />
      ) : (
        <>
          {revoked && (
            <p className="rounded-[10px] border border-risk/25 bg-risk/[0.06] px-3 py-2.5 text-[13px] text-risk">
              Revoked {day(summary.revoked_at)}. Requests with this key return 401.
            </p>
          )}

          <div className={cn(card, "grid grid-cols-2 lg:grid-cols-4")}>
            <Cell label="Access">
              <span className="flex flex-wrap items-center gap-2">
                <span className="inline-flex h-5 items-center rounded-md bg-muted px-[7px] text-[11.5px] text-ink-2">{accessLabel(summary.access)}</span>
                <span className="font-mono text-[12px] text-ink-2">{maskedKey(summary.prefix)}</span>
              </span>
            </Cell>
            <Cell label="Created">
              {day(summary.created_at)}
              {createdBy && <span className="text-muted-foreground"> by {createdBy}</span>}
            </Cell>
            <Cell label="Last used">
              {summary.last_used_at ? when(summary.last_used_at) : "Never"}
              {summary.last_client && <span className="text-muted-foreground"> · {summary.last_client}</span>}
            </Cell>
            <Cell label="Expires">
              {summary.expires_at ? (
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span>
                    {day(summary.expires_at)}
                    <span className={cn(isExpired(summary.expires_at) ? "text-risk" : "text-muted-foreground")}> · {inDays(summary.expires_at)}</span>
                  </span>
                  {summary.can_manage && !revoked && (
                    <DropdownMenu modal={false}>
                      <DropdownMenuTrigger asChild>
                        <button type="button" aria-label="Extend expiry"
                          className="inline-flex h-[22px] items-center gap-1 rounded-md border border-border bg-card px-1.5 text-[12px] font-medium text-ink-2 transition-colors hover:bg-hover hover:text-foreground">
                          Extend<ChevronDown className="h-3 w-3" strokeWidth={2} />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="w-36 rounded-[10px] p-1">
                        {EXTEND_OPTIONS.map((o) => (
                          <DropdownMenuItem key={o.days} className="text-[12.5px]" onSelect={() => void extend(o.days)}>{o.label}</DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </span>
              ) : "Never"}
            </Cell>
          </div>

          {state === "unavailable" ? (
            <EmptyState title="Usage for this key isn't available right now" />
          ) : noCalls ? (
            <EmptyState
              icon={<SquareTerminal strokeWidth={1.7} />}
              title="No calls yet — connect an agent"
              action={openConnect && !revoked ? <Button onClick={() => openConnect("mcp")}>Connect agent</Button> : undefined}
            />
          ) : (
            <>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <section className={cn(card, "p-4")}>
                  <div className="mb-3.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <h3 className="section-title m-0 flex-1 whitespace-nowrap">Calls, last 14 days</h3>
                    <span className="text-[20px] font-medium tabular-nums tracking-[-0.02em]">{num(total)}</span>
                    {rate && <span className={label}>{rate} errors this week</span>}
                  </div>
                  <div className="flex h-[140px] items-end gap-1 border-b border-border sm:gap-1.5" role="img" aria-label={`Calls per day, last 14 days, ${num(total)} in all`}>
                    {perDay.map((d, i) => (
                      <div key={d.day} className="flex h-full flex-1 flex-col items-center justify-end gap-1" title={`${day(d.day)}: ${num(d.calls)}`}>
                        <span className="hidden text-[10px] tabular-nums text-muted-foreground sm:block">{d.calls || ""}</span>
                        <span
                          className={cn("block w-full max-w-[28px] rounded-t-[3px] bg-foreground", i === perDay.length - 1 ? "opacity-100" : "opacity-[0.18]")}
                          style={{ height: Math.max(2, Math.round((d.calls / peak) * 110)) }}
                        />
                      </div>
                    ))}
                  </div>
                  <div className="mt-1.5 flex gap-1 sm:gap-1.5">
                    {perDay.map((d) => (
                      <span key={d.day} className="flex-1 text-center text-[10.5px] tabular-nums text-muted-foreground">{Number(d.day.slice(8, 10))}</span>
                    ))}
                  </div>
                </section>

                <section className={cn(card, "p-4")}>
                  <h3 className="section-title m-0 mb-3">By tool</h3>
                  {usage?.by_route.length ? (
                    <div className="flex flex-col gap-3">
                      {usage.by_route.map((t) => (
                        <div key={`${t.surface}:${t.route}`} className="flex flex-col gap-[5px]">
                          <div className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{t.route}</span>
                            <span className="text-[13px] tabular-nums">{num(t.calls)}</span>
                          </div>
                          <span className="block h-1 overflow-hidden rounded-sm bg-muted">
                            <span className="block h-1 rounded-sm bg-foreground" style={{ width: `${Math.round((t.calls / topTool) * 100)}%` }} />
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[12.5px] text-muted-foreground">No calls in the last 14 days</p>
                  )}
                </section>
              </div>

              <section className={cn(card, "overflow-hidden")}>
                <div className="flex items-center px-4 pb-2.5 pt-3.5">
                  <h3 className="section-title m-0 flex-1">Recent requests</h3>
                  <Link to={inShell ? "/" : "/activity"} className="text-[12px] font-medium text-foreground hover:underline">All activity</Link>
                </div>
                {requests.length ? (
                  <div className="relative overflow-x-auto">
                    <table className="w-full min-w-[720px] border-collapse text-[13px]">
                      <thead>
                        <tr className="border-b border-border text-left text-[12px] text-muted-foreground">
                          <th className="h-[34px] whitespace-nowrap px-3 pl-4 font-medium">Time</th>
                          <th className="h-[34px] whitespace-nowrap px-3 font-medium">Surface</th>
                          <th className="h-[34px] whitespace-nowrap px-3 font-medium">Route</th>
                          <th className="h-[34px] whitespace-nowrap px-3 font-medium">Target</th>
                          <th className="h-[34px] whitespace-nowrap px-3 font-medium">Status</th>
                          <th className="h-[34px] whitespace-nowrap px-3 pr-4 text-right font-medium">Latency</th>
                        </tr>
                      </thead>
                      <tbody>
                        {requests.map((r, i) => (
                          <tr key={`${r.at}-${i}`} className="border-b border-hairline last:border-b-0">
                            <td className="h-10 whitespace-nowrap px-3 pl-4 font-mono text-[12px] text-muted-foreground">{requestTime(r.at)}</td>
                            <td className="h-10 whitespace-nowrap px-3">
                              <span className="inline-flex h-[18px] items-center rounded-[5px] bg-muted px-1.5 text-[11px] font-medium text-ink-2">{surfaceLabel(r.surface)}</span>
                            </td>
                            <td className="h-10 whitespace-nowrap px-3 font-mono text-[12px]">{r.route}</td>
                            <td className="h-10 max-w-[280px] truncate whitespace-nowrap px-3">{r.target ?? ""}</td>
                            <td className="h-10 whitespace-nowrap px-3">
                              <span className={cn("inline-flex h-[18px] items-center rounded-[5px] px-1.5 text-[11px] font-medium tabular-nums", STATUS_TONE[statusTone(r.status)])}>{r.status}</span>
                            </td>
                            <td className="h-10 whitespace-nowrap px-3 pr-4 text-right tabular-nums text-muted-foreground">
                              {r.latency_ms != null ? `${num(r.latency_ms)} ms` : ""}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="px-4 pb-4 text-[12.5px] text-muted-foreground">No requests logged yet</p>
                )}
                {nextBefore && (
                  <div className="border-t border-hairline px-4 py-2.5">
                    <Button variant="ghost" size="sm" onClick={loadMore} disabled={loadingMore}>
                      {loadingMore ? "Loading…" : "Load more"}
                    </Button>
                  </div>
                )}
              </section>
            </>
          )}

          {!revoked && summary.can_manage && (
            <section className={card}>
              {unshown && (
                <div className="border-b border-hairline px-4 py-3.5">
                  <SecretOnce secret={unshown} onDone={() => setUnshown(null)} />
                </div>
              )}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-hairline px-4 py-3.5">
                <div className="min-w-[200px] flex-1">
                  <div className="font-medium">Rotate key</div>
                  <div className={label}>Issues a new secret with the same name and access. This one stops working immediately.</div>
                </div>
                <Button variant="outline" onClick={() => setRotating(true)}>Rotate key</Button>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5">
                <div className="min-w-[200px] flex-1">
                  <div className="font-medium">Revoke key</div>
                  <div className={label}>
                    {summary.last_client ? `${summary.last_client} loses access at once.` : "Anything using it loses access at once."}
                  </div>
                </div>
                <Button variant="destructive" onClick={() => setRevoking(true)}>Revoke key</Button>
              </div>
            </section>
          )}

          <RotateKeyDialog keyName={summary.name} open={rotating} onOpenChange={setRotating} onConfirm={rotate} />
          <RevokeKeyDialog
            keyName={summary.name}
            lastUsed={summary.last_used_at ? lastUsedPhrase(summary.last_used_at) : null}
            open={revoking} onOpenChange={setRevoking} onConfirm={revoke}
          />
        </>
      )}
    </div>
  );

  return (
    <div className="h-full overflow-y-auto bg-background text-[13px]">
      {content}
      {renameInBar}
    </div>
  );
}

function Cell({ label: l, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 border-hairline px-4 py-3.5 [&:nth-child(n+3)]:border-t lg:[&:nth-child(n+3)]:border-t-0 [&:nth-child(even)]:border-l lg:[&:not(:first-child)]:border-l">
      <span className={label}>{l}</span>
      <span className="min-w-0 text-[13px]">{children}</span>
    </div>
  );
}
