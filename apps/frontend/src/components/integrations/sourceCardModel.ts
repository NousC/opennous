// The API plan's source cards (GET-631): what each card says, from the connection as the API
// returns it. Pure, so the rules are pinned by tests/sourceCardModel.test.ts.

export type SourceStatusKind = "live" | "syncing" | "warn";
export type SourceStatus = { kind: SourceStatusKind; label: string };

export type CardConn = {
  name?: string | null;
  is_verified?: boolean;
  scope?: "personal" | "company";
  owner_name?: string | null;
  is_mine?: boolean;
  provider?: { display_name?: string | null } | null;
  /**
   * How far a running backfill has got for this source (GET /api/workflow-providers/connections
   * ?include=progress). Null, or absent, when nothing measurable is running.
   */
  sync_progress?: SyncProgress | null;
};

/** The API's sync_progress: a percent with the counts behind it, and what is being done. */
export type SyncProgress = { percent: number; done: number; total: number; label?: string | null };

/** The percent to show, or null when the connection is not mid-sync. 100 is done, not syncing. */
export function syncPercent(p: SyncProgress | null | undefined): number | null {
  const n = p?.percent;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n >= 100) return null;
  return Math.floor(n);
}

/** Live (green) · Syncing n% · Needs attention (amber). Only from what the connection reports. */
export function sourceStatus(c: Pick<CardConn, "is_verified" | "sync_progress">): SourceStatus {
  if (!c.is_verified) return { kind: "warn", label: "Needs attention" };
  const p = syncPercent(c.sync_progress);
  if (p !== null) return { kind: "syncing", label: `Syncing ${p}%` };
  return { kind: "live", label: "Live" };
}

/** Whether any card is mid-sync, which is what keeps the page polling. */
export function anySyncing(conns: Pick<CardConn, "is_verified" | "sync_progress">[]): boolean {
  return conns.some((c) => sourceStatus(c).kind === "syncing");
}

/** The bar's tooltip: "Importing history · 1,204 of 3,412". */
export function progressTitle(p: SyncProgress | null | undefined): string | undefined {
  if (!p || syncPercent(p) === null) return undefined;
  const counts = p.total > 0 ? `${p.done.toLocaleString("en-US")} of ${p.total.toLocaleString("en-US")}` : null;
  return [p.label, counts].filter(Boolean).join(" · ") || undefined;
}

/** "just now", "4m ago", "3h ago", "2d ago", else a short date. */
export function shortAgo(iso: string | null | undefined, now: number = Date.now()): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * The card's foot: when it last brought something in. A source that has never brought anything
 * in says when it was connected instead, so the label is never a guess.
 */
export function syncedLabel(lastSyncedAt: string | null | undefined, connectedAt: string | null | undefined, now: number = Date.now()): string {
  const synced = shortAgo(lastSyncedAt, now);
  if (synced) return `Synced ${synced}`;
  const connected = shortAgo(connectedAt, now);
  return connected ? `Connected ${connected}` : "Not synced yet";
}

/**
 * The line under the name: the connection's own name when it differs from the tool's, and who
 * connected a shared one. Failing both, who it is for.
 */
export function accountLine(c: CardConn, workspaceName?: string | null): string {
  const display = c.provider?.display_name ?? "";
  const parts = [
    c.name && c.name !== display ? c.name : null,
    c.scope === "company" && (c.is_mine || c.owner_name) ? `connected by ${c.is_mine ? "you" : c.owner_name}` : null,
  ].filter(Boolean) as string[];
  if (parts.length) return parts.join(" · ");
  return c.scope === "personal" ? "Only you" : workspaceName ? `Everyone in ${workspaceName}` : "Everyone in the workspace";
}
