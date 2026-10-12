// API keys: the shapes the keys page and the key detail page read, and the small rules they
// share (GET-629, GET-630, GET-639). Pure and import-free so tests/apiKeys.test.ts can pin it.

export type Capability = "read_write" | "read_only";

/** A row of GET /api/workspace/api-keys. key_prefix arrives once its migration is applied. */
export interface ApiKeyRow {
  id: string;
  name: string;
  created_at: string;
  last_used_at?: string | null;
  capability?: Capability | null;
  expires_at?: string | null;
  scope?: string | null;
  key_prefix?: string | null;
  /** Server-computed: may this viewer rotate or revoke the key (admin, the key's person, or its minter). */
  can_manage?: boolean;
}

/** Rotate/Revoke show only when the server says the viewer may; the API enforces it too (403). */
export function canManageKey(row: Pick<ApiKeyRow, "can_manage"> | null | undefined): boolean {
  return row?.can_manage !== false;
}

/** GET /api/keys/:id/usage (C1, GET-623). */
export interface KeyUsage {
  key: {
    id: string; name: string; prefix: string | null; access: Capability; scope: string;
    created_at: string; created_by: string | null; last_used_at: string | null;
    last_client: string | null; expires_at: string | null; revoked_at: string | null;
  };
  per_day: { day: string; calls: number }[];
  by_route: { route: string; surface: string; calls: number }[];
  totals: { calls_7d: number; errors_7d: number };
  /** Keys this one replaced by rotation; their calls are folded into the history above. */
  rotated_from?: string[];
}

/** One row of GET /api/keys/:id/requests. */
export interface KeyRequest {
  at: string; surface: string; route: string; target: string | null;
  status: number; latency_ms: number | null; client: string | null;
}

export interface KeyRequestsPage { requests: KeyRequest[]; next_before: string | null }

export const ACCESS_OPTIONS: { value: Capability; label: string }[] = [
  { value: "read_write", label: "Read & write" },
  { value: "read_only", label: "Read-only" },
];

/** Expiry choices on create; 0 is "never". The API takes expires_in_days. */
export const EXPIRY_OPTIONS: { days: number; label: string }[] = [
  { days: 0, label: "No expiry" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "1 year" },
];

export function accessLabel(c: Capability | string | null | undefined): string {
  return c === "read_only" ? "Read-only" : "Read & write";
}

/** The non-secret handle the API stores: the first 9 characters ("pk_3f9a1c"). */
export function prefixOf(secret: string): string {
  return secret.slice(0, 9);
}

/** What the Key column shows: the stored prefix, masked, or "pk_…" when there is none. */
export function maskedKey(prefix: string | null | undefined): string {
  return prefix ? `${prefix}••••••••` : "pk_…";
}

const DAY = 86_400_000;

/** Whole days until `expires_at` (negative once past). Null when the key never expires. */
export function daysLeft(expiresAt: string | null | undefined, now: number = Date.now()): number | null {
  if (!expiresAt) return null;
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - now) / DAY);
}

export function isExpired(expiresAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!expiresAt) return false;
  const t = Date.parse(expiresAt);
  return !Number.isNaN(t) && t <= now;
}

/** Keys that still work but stop within `withinDays`, soonest first. */
export function expiringSoon<T extends { expires_at?: string | null }>(keys: T[], now: number = Date.now(), withinDays = 7): T[] {
  return keys
    .filter((k) => {
      if (!k.expires_at || isExpired(k.expires_at, now)) return false;
      return Date.parse(k.expires_at) - now <= withinDays * DAY;
    })
    .sort((a, b) => Date.parse(a.expires_at!) - Date.parse(b.expires_at!));
}

/** "expires in 6 days" / "expires today" / "expires tomorrow". */
export function expiresInLabel(expiresAt: string, now: number = Date.now()): string {
  const d = daysLeft(expiresAt, now) ?? 0;
  if (d <= 0) return "expires today";
  if (d === 1) return "expires tomorrow";
  return `expires in ${d} days`;
}

export const DEFAULT_KEY_LIFETIME_DAYS = 90;

/** A key's original lifetime in whole days (rounded up), or 90 when it can't be told. */
export function lifetimeDays(createdAt: string | null | undefined, expiresAt: string | null | undefined): number {
  const c = Date.parse(String(createdAt ?? ""));
  const e = Date.parse(String(expiresAt ?? ""));
  const d = Math.ceil((e - c) / DAY);
  return Number.isFinite(d) && d > 0 ? d : DEFAULT_KEY_LIFETIME_DAYS;
}

/**
 * The expires_in_days a rotate sends; 0 means no expiry, and only a key that never expired
 * gets 0. A key with time left keeps its remaining lifetime (rotating a 30-day key doesn't make
 * it permanent). One that has expired, or has less than a day left, gets its original lifetime
 * again (expires_at − created_at, default 90): rotating is how you renew an expiring key.
 */
export function rotateExpiryDays(
  key: { expires_at?: string | null; created_at?: string | null },
  now: number = Date.now(),
): number {
  if (!key.expires_at) return 0;
  const t = Date.parse(key.expires_at);
  if (Number.isNaN(t)) return 0;
  if (t - now < DAY) return lifetimeDays(key.created_at, key.expires_at);
  return Math.ceil((t - now) / DAY);
}

export type StatusTone = "ok" | "warn" | "bad";

/** 2xx ok, 4xx warn (the caller's mistake or a limit), 5xx and anything else bad. */
export function statusTone(status: number): StatusTone {
  if (status >= 200 && status < 300) return "ok";
  if (status >= 400 && status < 500) return "warn";
  return "bad";
}

export function surfaceLabel(surface: string | null | undefined): string {
  return String(surface ?? "").toLowerCase() === "mcp" ? "MCP" : "REST";
}

/** Error share of the last 7 days, "0.4%", or null when there were no calls. */
export function errorRate(totals: { calls_7d: number; errors_7d: number } | null | undefined): string | null {
  if (!totals || !totals.calls_7d) return null;
  const pct = (totals.errors_7d / totals.calls_7d) * 100;
  if (pct === 0) return "0%";
  if (pct < 0.1) return "<0.1%";
  return `${pct < 10 ? pct.toFixed(1).replace(/\.0$/, "") : Math.round(pct)}%`;
}

/** True when the revoke confirm's typed text matches the key's name (trimmed, exact case). */
export function revokeConfirmed(typed: string, name: string): boolean {
  return typed.trim() === name.trim() && name.trim().length > 0;
}

/** The extend choices (POST /api/workspace/api-keys/:id/extend takes exactly these days). */
export const EXTEND_OPTIONS: { days: number; label: string }[] = [
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "1 year" },
];

/**
 * The expiry an extend gives, as the API computes it: max(now, current expiry) + days. A live key
 * keeps the time it had; an expired one starts again from today. Null for a key with no expiry.
 */
export function extendedExpiry(expiresAt: string | null | undefined, days: number, now: number = Date.now()): string | null {
  if (!expiresAt) return null;
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return null;
  return new Date(Math.max(now, t) + days * DAY).toISOString();
}

/** The toast for an extend the API refused. */
export function extendErrorMessage(code: string | null | undefined): string {
  if (code === "key_revoked") return "That key was revoked, so it can't be extended.";
  if (code === "no_expiry") return "That key never expires.";
  return "Couldn't extend the key. Its expiry is unchanged.";
}

/** How long the API lets a revoke be undone (POST /api/workspace/api-keys/:id/restore). */
export const UNDO_REVOKE_MS = 10 * 60_000;

/** How long the revoke toast stays up with its Undo: well inside the API's window. */
export const UNDO_TOAST_MS = 10_000;

/** The toast for an undo the API refused. */
export function restoreErrorMessage(code: string | null | undefined): string {
  if (code === "undo_window_passed") return "Too late to undo. Create a new key instead.";
  if (code === "key_expired") return "That key has expired, so it stays revoked.";
  if (code === "key_rotated") return "That key was replaced by a rotation, so it stays revoked.";
  if (code === "name_taken") return "Another key has that name now. Rename it, then undo.";
  return "Couldn't undo. The key stays revoked.";
}

/** Same rule as the API (PATCH /api/workspace/api-keys/:id): trimmed, 1 to 60 characters. */
export const KEY_NAME_MAX = 60;

/** Why a name can't be saved, or null when it can. */
export function keyNameError(name: string): string | null {
  const n = name.trim();
  if (!n) return "Name can't be empty";
  if (n.length > KEY_NAME_MAX) return `Name is ${KEY_NAME_MAX} characters at most`;
  return null;
}

/** The toast for a rename the API refused. */
export function renameErrorMessage(code: string | null | undefined): string {
  if (code === "name_taken") return "Another key already has that name.";
  if (code === "name_too_long" || code === "name_required") return `Use 1 to ${KEY_NAME_MAX} characters.`;
  return "Couldn't rename the key. The old name stays.";
}

/**
 * Put a new secret on the clipboard. Resolves false when the browser refuses (no permission,
 * insecure context, no clipboard API), so the caller can show the secret once instead.
 */
export async function writeSecret(secret: string): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(secret);
    return true;
  } catch {
    return false;
  }
}
