// Sentry error reporting — error grouping/search/alerting on top of the opsAlert floor.
// Loaded via DYNAMIC import so @sentry/node (and its OpenTelemetry machinery) is only
// pulled in when SENTRY_DSN is set; with no DSN this is a pure no-op and the SDK never
// loads. Errors-only: tracesSampleRate 0, no performance/profiling overhead.

let Sentry = null;
let enabled = false;

export async function initSentry(service = 'api') {
  if (enabled || !process.env.SENTRY_DSN) return;
  try {
    Sentry = await import('@sentry/node');
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV || 'production',
      tracesSampleRate: 0,
      release: process.env.GIT_SHA || undefined,
      initialScope: { tags: { service } },
    });
    enabled = true;
    console.log(`[sentry] initialized for ${service}`);
  } catch (e) {
    console.warn('[sentry] init failed (continuing without it):', e?.message || e);
  }
}

export function captureException(err, context) {
  if (!enabled || !Sentry) return;
  try {
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)),
      context ? { extra: context } : undefined);
  } catch { /* never let error reporting throw */ }
}
