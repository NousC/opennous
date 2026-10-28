// Settings > Workspace > Agent activity (GET-898, renamed GET-900), shaped from GET
// /api/usage/activity and /api/usage/activity/calls. Pure (the fetch helper takes its token
// source and fetch as arguments), so tests/apiActivity.test.ts pins it. A missing number is a
// dash, never a zero we did not count.

export type ActivityWindow = "24h" | "7d" | "30d" | "90d";
export const ACTIVITY_WINDOWS: { value: ActivityWindow; label: string }[] = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
];

export type Surface = "mcp" | "rest";
export type About = { id: string; type: "company" | "person" | "deal"; name: string | null } | null;
type Rated = { calls: number; errors: number; error_rate: number | null; last_at: string | null };

export type Activity = {
  window: ActivityWindow;
  since: string;
  bucket: "hour" | "day";
  totals: {
    calls: number; mcp: number; rest: number; errors: number; error_rate: number | null;
    p50_ms: number | null; p95_ms: number | null; keys: number; clients: number; targets: number;
  };
  series: { bucket: string; calls: number; mcp: number; rest: number; errors: number }[];
  by_route: (Rated & { surface: Surface; route: string; p95_ms: number | null })[];
  by_target: (Rated & { target: string; about: About })[];
  by_key: (Rated & { api_key_id: string; name: string | null; revoked: boolean })[];
  by_client: (Rated & { client: string | null })[];
};

export type Call = {
  id: string; at: string; surface: Surface; route: string; target: string | null; about: About;
  status: number; latency_ms: number; client: string | null; key: { id: string; name: string | null };
};
export type CallsPage = { calls: Call[]; next_before: string | null };

export type CallFilters = {
  surface?: Surface | null; route?: string | null; status?: "ok" | "error" | null;
  key?: string | null; client?: string | null; q?: string | null;
};

/** The client filter's value for calls that named no client ("Unknown" in the list). */
export const UNKNOWN_CLIENT = "(unknown)";

/** The calls endpoint's query string for a window, filters and a cursor. Empty filters are left out. */
export function callsQuery(window: ActivityWindow, f: CallFilters = {}, before?: string | null, limit = 50): string {
  const p = new URLSearchParams({ window, limit: String(limit) });
  if (f.surface) p.set("surface", f.surface);
  if (f.route) p.set("route", f.route);
  if (f.status) p.set("status", f.status);
  if (f.key) p.set("key", f.key);
  if (f.client) p.set("client", f.client);
  const q = f.q?.trim();
  if (q) p.set("q", q);
  if (before) p.set("before", before);
  return p.toString();
}

/** 0.0213 → "2.1%", 0 → "0%", 1 → "100%", null → "—". */
export function pct(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return "—";
  if (rate === 0) return "0%";
  const v = rate * 100;
  if (v < 0.1) return "<0.1%";
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10}%`;
}

/** 120 → "120 ms", 1840 → "1.8 s", null → "—". */
export function ms(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v < 1000) return `${Math.round(v)} ms`;
  return `${Math.round(v / 100) / 10} s`;
}

export const surfaceLabel = (s: Surface) => (s === "mcp" ? "MCP" : "REST");

/** Where an "about" goes: a company to its account, a person to their page. A deal has no page of its own here. */
export function aboutHref(a: About): string | null {
  if (!a) return null;
  if (a.type === "company") return `/accounts/${a.id}`;
  if (a.type === "person") return `/contacts/${a.id}`;
  return null;
}

/** The about column: the entity's name, else the raw target, else a dash. */
export function aboutLabel(a: About, target: string | null): string {
  return a?.name || target || "—";
}

/** The client column. Nothing on record reads as such, not as a blank. */
export function clientLabel(c: string | null | undefined): string {
  return c?.trim() ? c : "Unknown";
}

/** The key column: its name, or a short id when the key has no name (or is gone). */
export function keyLabel(name: string | null | undefined, id: string): string {
  return name?.trim() ? name : `Key ${id.slice(0, 8)}`;
}

export const isError = (status: number) => status >= 400;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A chart bucket's label: "15:00" for an hour (UTC, as bucketed), "15 Oct" for a day. */
export function bucketLabel(bucket: string, hourly: boolean): string {
  if (hourly) return `${bucket.slice(11, 13)}:00`;
  const [, m, d] = bucket.split("-").map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]}`;
}

/** The header's latency note: "p95 1.8 s", or nothing to say. */
export function latencyNote(t: Activity["totals"] | null | undefined): string {
  return t?.p95_ms == null ? "" : `p95 ${ms(t.p95_ms)}`;
}

/** The MCP · REST split under the total. */
export function splitNote(t: Activity["totals"] | null | undefined): string {
  if (!t) return "";
  return `${t.mcp.toLocaleString("en-US")} MCP · ${t.rest.toLocaleString("en-US")} REST`;
}

// ── Fetching ─────────────────────────────────────────────────────────────────

/** A non-2xx answer: the HTTP status and the API's error code. Status 0 is a network failure. */
export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export type TokenSource = (opts?: { force?: boolean }) => Promise<string | null>;

/**
 * GET an activity endpoint as the signed-in user. The token is minted per request (never one
 * captured at mount: session tokens live about a minute, and a token kept in React state goes
 * stale in a background tab, so the API answers 401 invalid_token). On a 401 it forces a new token
 * and tries once more. Anything else non-2xx throws HttpError(status, error code).
 */
export async function activityGet<T>(
  url: string,
  getToken: TokenSource,
  doFetch: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<T> {
  const call = async (token: string | null) => {
    try {
      return await doFetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    } catch {
      throw new HttpError(0, "network_error");
    }
  };
  let r = await call(await getToken());
  if (r.status === 401) r = await call(await getToken({ force: true }));
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new HttpError(r.status, (body as { error?: string })?.error ?? `http_${r.status}`);
  }
  return r.json() as Promise<T>;
}

/** The muted diagnosis line under a load error: "401 · sign in again", "500 · internal_error". */
export function errorNote(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.status === 0) return "No connection to the API";
    if (err.status === 401) return "401 · sign in again";
    return `${err.status} · ${err.code}`;
  }
  return err instanceof Error && err.message ? err.message : "Unknown error";
}

export const isSignedOut = (err: unknown) => err instanceof HttpError && err.status === 401;
