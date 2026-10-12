// Sentry error reporting for the worker — see apps/api/src/lib/sentry.mjs. Dynamic import
// so @sentry/node only loads when SENTRY_DSN is set; no DSN = pure no-op. Errors only.
// (Duplicated per-app intentionally, like opsAlert, to avoid cross-package imports.)

let Sentry = null;
let enabled = false;

export async function initSentry(service = 'worker') {
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
