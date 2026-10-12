// Minimal operator alerting — so a human finds out when something breaks instead of
// hearing it from a customer. No new dependency: POSTs to a Slack incoming webhook
// (OPS_ALERT_SLACK_WEBHOOK) when set, else just logs. Best-effort and throttled so a
// storm of the same error can't spam the channel. Full error grouping/APM (Sentry) is
// a follow-up; this is the "page a human on the catastrophic cases" floor.

const WEBHOOK = () => process.env.OPS_ALERT_SLACK_WEBHOOK || '';
const THROTTLE_MS = 5 * 60 * 1000;
const lastSent = new Map(); // key -> ts

/**
 * opsAlert(title, detail?, opts?) — fire-and-forget. Dedups by title within a 5-min
 * window. level is cosmetic (info | warn | error). Never throws.
 */
export async function opsAlert(title, detail = '', { level = 'error', key } = {}) {
  const throttleKey = key || title;
  const now = Date.now();
  const prev = lastSent.get(throttleKey);
  if (prev && now - prev < THROTTLE_MS) return;
  lastSent.set(throttleKey, now);

  const tag = level === 'error' ? '🔴' : level === 'warn' ? '🟠' : 'ℹ️';
  const line = `[opsAlert:${level}] ${title}${detail ? ` — ${detail}` : ''}`;
  // Always log — docker logs is the fallback channel when no webhook is set.
  (level === 'error' ? console.error : console.warn)(line);

  const url = WEBHOOK();
  if (!url) return;
  try {
    const env = process.env.NODE_ENV === 'production' ? 'prod' : (process.env.NODE_ENV || 'dev');
    const text = `${tag} *Nous ${env}* — ${title}${detail ? `\n\`\`\`${String(detail).slice(0, 1500)}\`\`\`` : ''}`;
    // 3s timeout so a slow/hung Slack can't wedge a request or crash handler.
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: ctrl.signal,
    }).catch(() => {});
    clearTimeout(t);
  } catch { /* never let alerting break the caller */ }
}
