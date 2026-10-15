// A model provider failure, told to the person in words they can act on and to ops once per
// incident (GET-885).
//
// On 2026-10-15 the Job Builder's model account ran out of credit. The user saw "The job builder
// hit an error. Try again." (trying again could not help) and nobody on our side was told. Now:
//
//   billing / auth   "<subject> isn't available right now. We've been alerted and are fixing it."
//                    + an error-level ops alert
//   rate_limit       "The AI model is busy. Try again in a minute." + a warn-level ops alert
//   other            null: the caller keeps its own generic message (and its own logging)
//
// The alert is one structured log line, `[provider-alert] <provider> <kind> feature=… status=…
// type=… <provider's message, key-like strings removed>`, plus opsAlert (Slack when
// OPS_ALERT_SLACK_WEBHOOK is set). One per provider+kind per 15 minutes: a burst of failing chats
// is one incident. Provider internals and keys never reach the user.
import { classifyProviderError, providerErrorSummary } from '@nous/core';
import { opsAlert } from './opsAlert.mjs';
import { isSelfHosted } from './plans.mjs';

export const ALERT_WINDOW_MS = 15 * 60 * 1000;

/** -> alert({ provider, kind, feature, err }): true when it alerted, false when throttled or nothing to say. */
export function makeProviderAlert({ send = opsAlert, log = console.error, now = Date.now, windowMs = ALERT_WINDOW_MS } = {}) {
  const last = new Map();
  return function alert({ provider = 'unknown', kind, feature = null, err = null } = {}) {
    if (kind !== 'billing' && kind !== 'auth' && kind !== 'rate_limit') return false;
    const key = `provider:${provider}:${kind}`;
    const t = now();
    const prev = last.get(key);
    if (prev != null && t - prev < windowMs) return false;
    last.set(key, t);
    const { status, type } = classifyProviderError(err);
    const said = providerErrorSummary(err);
    try {
      log(`[provider-alert] ${provider} ${kind} feature=${feature ?? '-'} status=${status ?? '-'} type=${type ?? '-'} ${said}`.trim());
      const what = kind === 'billing' ? 'out of credit' : kind === 'auth' ? 'key rejected' : 'rate limited or overloaded';
      void Promise.resolve(send(`Model provider ${provider}: ${what} (${kind})`, `feature=${feature ?? '-'} status=${status ?? '-'} ${said}`.trim(), {
        level: kind === 'rate_limit' ? 'warn' : 'error', key,
      })).catch(() => {});
    } catch { /* alerting never breaks the caller */ }
    return true;
  };
}

export const providerAlert = makeProviderAlert();

/**
 * Classify a failed model call, alert ops when it is a provider incident, and return what the
 * user should see -> { kind, code, message }, or null when it is not a provider failure we can
 * name (the caller keeps its generic message). `subject` names the model in the sentence.
 */
export function providerFailure(err, { provider = 'unknown', feature = null, subject = 'The AI model', alert = providerAlert, selfHosted = isSelfHosted() } = {}) {
  const { kind } = classifyProviderError(err);
  if (kind === 'other') return null;
  try { alert({ provider, kind, feature, err }); } catch { /* never mask the failure */ }
  if (kind === 'rate_limit') return { kind, code: 'model_busy', message: 'The AI model is busy. Try again in a minute.' };
  // Self-host runs on the operator's own keys (GET-905): nobody else is alerted, so say what to fix.
  if (selfHosted) return { kind, code: 'model_unavailable', message: kind === 'billing'
    ? `${subject} isn't available: its provider account is out of credit. Top it up, or set another key in nous.env (Settings → Instance setup).`
    : `${subject} isn't available: its API key was rejected. Check the key in nous.env (Settings → Instance setup).` };
  return { kind, code: 'model_unavailable', message: `${subject} isn't available right now. We've been alerted and are fixing it.` };
}

/** What to tell the person when no model key is set at all. Shared by the Job Builder. */
export function noProviderMessage(subject = 'The AI model', { selfHosted = isSelfHosted() } = {}) {
  return selfHosted
    ? `${subject} has no model key. Set OPENROUTER_API_KEY or ANTHROPIC_API_KEY in nous.env and restart (Settings → Instance setup).`
    : `${subject} isn't available right now. We've been alerted and are fixing it.`;
}
