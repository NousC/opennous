// The outbound-webhook delivery log as the API-plan Webhooks page shows it (GET-632).
//
// Reads the shapes C2 (GET-624) serves: GET /api/triggers/:id/deliveries, /:id/stats and
// POST /api/triggers/deliveries/:id/resend. Pure, so tests/webhookDeliveries.test.ts pins it.

/** One attempt, as GET /api/triggers/:id/deliveries returns it. */
export type Delivery = {
  id: string;
  subscription_id: string;
  event: string;
  event_id: string | null;
  attempt: number;
  status_code: number | null;
  ok: boolean;
  error: string | null;
  duration_ms: number;
  created_at: string;
  resent_from: string | null;
};

/** GET /api/triggers/:id/stats. success_rate_7d is null when nothing was sent. */
export type DeliveryStats = {
  success_rate_7d: number | null;
  deliveries_7d: number;
  failures_7d: number;
  last_delivery_at: string | null;
};

export type DeliveryTone = "ok" | "error" | "timeout";

/** The status pill: the HTTP code when there is one, "Timeout" or "Failed" when there isn't. */
export function deliveryStatus(d: Pick<Delivery, "ok" | "status_code" | "error">): { tone: DeliveryTone; label: string } {
  if (d.status_code == null) {
    return d.error === "timeout" ? { tone: "timeout", label: "Timeout" } : { tone: "error", label: "Failed" };
  }
  const ok = d.ok || (d.status_code >= 200 && d.status_code < 300);
  return { tone: ok ? "ok" : "error", label: String(d.status_code) };
}

/** "184 ms", "1.2 s". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")} s`;
}

/** "99.2% delivered · 7 days", or null when there were no deliveries to rate. */
export function successLabel(stats: DeliveryStats | null | undefined): string | null {
  if (!stats || stats.success_rate_7d == null) return null;
  const pct = Math.round(stats.success_rate_7d * 1000) / 10;
  return `${pct}% delivered · 7 days`;
}

/**
 * An endpoint is failing when it has had at least three failed attempts in the last week and the
 * most recent attempt failed too: a receiver that broke and stays broken. Three blips across a
 * thousand good deliveries, with the latest one landing, is not worth a banner.
 */
export const FAILING_THRESHOLD = 3;
export function isFailing(stats: DeliveryStats | null | undefined, recent: Delivery[] | null | undefined): boolean {
  if (!stats || stats.failures_7d < FAILING_THRESHOLD) return false;
  const latest = recent?.[0];
  return latest ? deliveryStatus(latest).tone !== "ok" : true;
}

/** whsec_••••••••3f9a: the prefix and the last four, never the middle. */
export function maskSecret(secret: string | null | undefined): string {
  if (!secret) return "";
  const m = /^([a-z]+_)?(.*)$/i.exec(secret);
  const prefix = m?.[1] ?? "";
  const body = m?.[2] ?? secret;
  const tail = body.length > 8 ? body.slice(-4) : "";
  return `${prefix}${"•".repeat(20)}${tail}`;
}

/** What to say after a Resend, from the HTTP status and body the API returned. */
export function resendMessage(status: number, body: { error?: string; result?: { ok?: boolean; status_code?: number | null; error?: string | null } } | null): { ok: boolean; message: string } {
  if (status === 410 || body?.error === "payload_gone") {
    return { ok: false, message: "This event is older than the log keeps, so it can't be sent again." };
  }
  if (status === 409 || body?.error === "subscription_inactive") {
    return { ok: false, message: "This endpoint is turned off. Enable it to resend." };
  }
  if (status === 404) return { ok: false, message: "That delivery no longer exists." };
  if (status === 429 || body?.error === "rate_limited") return { ok: false, message: "Too many resends to this endpoint. Try again in a minute." };
  if (status < 200 || status >= 300 || !body?.result) return { ok: false, message: "Couldn't resend. Try again." };
  const r = body.result;
  if (r.ok) return { ok: true, message: `Resent · ${r.status_code ?? "ok"}` };
  return { ok: false, message: r.status_code ? `Resent, the endpoint answered ${r.status_code}` : `Resent, ${r.error === "timeout" ? "the endpoint timed out" : "the request failed"}` };
}

/**
 * What to say after Send test, from POST /api/triggers/:id/test. The test is sent while you wait,
 * so the toast carries the receiver's status line ("503 Service Unavailable"), never its body.
 */
export function testSendMessage(status: number, body: { error?: string; result?: { ok?: boolean; status_code?: number | null; error?: string | null; duration_ms?: number | null } } | null): { ok: boolean; message: string } {
  if (status === 409 || body?.error === "subscription_inactive") {
    return { ok: false, message: "This endpoint is turned off. Enable it to send a test." };
  }
  if (status === 404) return { ok: false, message: "That endpoint no longer exists." };
  if (status === 429 || body?.error === "rate_limited") return { ok: false, message: "Too many test sends to this endpoint. Try again in a minute." };
  if (status < 200 || status >= 300 || !body?.result) return { ok: false, message: "Couldn't send a test. Try again." };
  const r = body.result;
  const took = r.duration_ms != null ? ` · ${formatDuration(r.duration_ms)}` : "";
  if (r.ok) return { ok: true, message: `Test delivered · ${r.status_code ?? "ok"}${took}` };
  if (r.error === "timeout") return { ok: false, message: "Test sent, the endpoint timed out" };
  if (r.error === "redirect not followed") return { ok: false, message: `Test sent, the endpoint redirected${r.status_code ? ` (${r.status_code})` : ""}. Redirects aren't followed.` };
  if (r.status_code) return { ok: false, message: `Test sent, the endpoint answered ${r.error && r.error.startsWith(String(r.status_code)) ? r.error : r.status_code}` };
  return { ok: false, message: "Test sent, the request failed" };
}
