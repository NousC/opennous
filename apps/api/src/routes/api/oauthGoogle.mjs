/**
 * Gmail + Google Calendar with the install's own Google OAuth app (GET-765, self-host).
 *
 *   GET /api/oauth/google/mode?workspace_id=                 → { mode: 'native' | 'composio' }
 *   GET /api/oauth/google/:product/authorize?workspace_id=   → { authUrl }   (product: gmail | calendar)
 *   GET /api/oauth/google/callback                           ← Google's redirect (no session):
 *                                                               parks the code, saves nothing
 *   POST /api/oauth/google/complete?workspace_id=  { code }  → the opener, with ITS session,
 *                                                               finishes: exchange, checks, save
 *
 * Restored from the route retired in 6bb69320 and re-homed for what changed since: one row per
 * product (Gmail and Calendar are separate providers now, as they are under Composio), rows
 * marked managed_by 'google_oauth' so the worker reads them with these tokens, PKCE, and a
 * connect that hands off to the same backfill the Composio connect fires. On Cloud the mode is
 * always 'composio' and authorize refuses, so nothing here runs there.
 *
 * Why two steps: the callback carries no session, so finishing there would file whoever's Google
 * account consented under whoever started the flow — member B could send their consent link to
 * admin A and read A's mail. The completion code reaches only a same-origin opener
 * (oauth-callback.html posts it to its own origin), and /complete saves only for the member and
 * workspace that started the flow.
 *
 * The redirect URI is https://<API_DOMAIN>/api/oauth/google/callback (GOOGLE_OAUTH_REDIRECT_URI,
 * or derived from API_DOMAIN), registered on the Google OAuth client.
 */

import { Router } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { getSupabaseClient } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { maskEmail } from '../../lib/redact.mjs';
import { auditLog } from '../../lib/audit.mjs';
import { ingestOnConnect } from '../../lib/connectIngest.mjs';
import { workerBaseUrl } from '../../providers/webhooks.mjs';
import {
  connectMode, googleProviderName, createOAuthState, consumeOAuthState, buildAuthUrl,
  exchangeCode, fetchGoogleEmail, saveNativeGoogleConnection, parkCompletion, takeCompletion,
  grantedRequiredScope, GOOGLE_PRODUCTS, discardCompletion,
} from '../../providers/googleNative.mjs';

export const oauthGoogleRouter = Router();

const appUrl = () => (process.env.APP_URL || (process.env.APP_DOMAIN ? `https://${process.env.APP_DOMAIN}` : '')).replace(/\/+$/, '');

/** Where the popup lands: the frontend page that posts { type: 'oauth-callback' } to its opener. */
export function callbackRedirect(params) {
  const q = new URLSearchParams(params);
  return `${appUrl()}/oauth-callback.html?${q}`;
}

oauthGoogleRouter.get('/mode', verifySupabaseAuth, async (req, res) => {
  try {
    const mode = await connectMode(getSupabaseClient(), req.workspaceId);
    return res.json({ mode });
  } catch (err) {
    console.error('[GET /api/oauth/google/mode]', err?.message || err);
    return res.json({ mode: 'composio' });
  }
});

oauthGoogleRouter.get('/:product/authorize', verifySupabaseAuth, async (req, res) => {
  const provider = googleProviderName(req.params.product);
  if (!provider) return res.status(404).json({ error: 'unknown_product' });
  const workspaceId = req.workspaceId;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id_required' });

  const mode = await connectMode(getSupabaseClient(), workspaceId);
  if (mode !== 'native') {
    return res.status(409).json({
      error: 'google_oauth_not_available',
      message: 'Gmail and Google Calendar connect through Composio on this workspace.',
    });
  }
  // Gmail and Calendar are personal sources: every member connects their own (sourceScope.mjs).
  const { state, challenge } = createOAuthState({ workspaceId, userId: req.internalUserId, provider });
  return res.json({ authUrl: buildAuthUrl({ provider, state, challenge }) });
});

/**
 * Google's redirect. Checks the state and parks Google's code under a one-time completion code;
 * saves nothing. Errors go to the frontend's oauth-callback.html as before. Success returns the
 * hand-off page below, served from THIS origin, so the completion code is never in a URL.
 */
export function parkGoogleCallback({ query }) {
  const { code, state, error: oauthError } = query || {};
  if (oauthError) return { redirect: callbackRedirect({ oauth_error: String(oauthError) }) };
  if (!code || !state) return { redirect: callbackRedirect({ oauth_error: 'missing_code_or_state' }) };
  const pending = consumeOAuthState(String(state));
  if (!pending) return { redirect: callbackRedirect({ oauth_error: 'invalid_state' }) };
  const completion = parkCompletion(pending, String(code));
  const nonce = crypto.randomBytes(16).toString('base64');
  return { html: handoffPage({ code: completion, provider: pending.provider, appOrigin: originOf(appUrl()), nonce }), nonce, completion };
}

const originOf = (url) => { try { return new URL(url).origin; } catch { return null; } };
const HANDOFF_WAIT_MS = 4000;

/**
 * The popup's last page. It hands the completion code to the app window that opened it — posted
 * to the app's origin only, so no other page can receive it — and waits for that window to say
 * it got it. No opener (a forwarded link opened in a plain tab), a foreign opener, or no answer
 * in time: the page burns the code (POST /discard) so it can never be redeemed. The URL is
 * stripped of Google's query either way.
 */
export function handoffPage({ code, provider, appOrigin, nonce }) {
  const data = JSON.stringify({ code, provider, appOrigin, waitMs: HANDOFF_WAIT_MS }).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Connecting Google</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f5f5}p{background:#fff;padding:2rem;border-radius:8px;max-width:28rem;text-align:center}</style>
</head><body><p id="m">Finishing the Google connection…</p>
<script nonce="${nonce}">
(function () {
  var d = ${data};
  try { history.replaceState(null, '', location.pathname); } catch (e) {}
  var done = false;
  function say(t) { var m = document.getElementById('m'); if (m) m.textContent = t; }
  function burn() {
    if (done) return; done = true;
    try {
      fetch('discard', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: d.code }), keepalive: true, credentials: 'omit' });
    } catch (e) {}
    say('This sign-in could not be finished here, so it was cancelled. Start the connection again from OpenNous.');
  }
  window.addEventListener('message', function (e) {
    if (e.origin !== d.appOrigin || !e.data || e.data.type !== 'google-oauth-ack' || e.data.code !== d.code) return;
    done = true; say('Connected. You can close this window.'); setTimeout(function () { window.close(); }, 300);
  });
  if (window.opener && d.appOrigin) {
    try { window.opener.postMessage({ type: 'oauth-callback', success: true, completionCode: d.code, provider: d.provider }, d.appOrigin); } catch (e) {}
    setTimeout(burn, d.waitMs);
  } else {
    burn();
  }
})();
</script></body></html>`;
}

const COMPLETE_ERRORS = {
  invalid_completion: [400, 'This sign-in expired or was already used. Start the connection again.'],
  not_your_connection: [403, 'This sign-in was started by a different member or workspace.'],
  scope_not_granted: [400, 'Google did not grant the access OpenNous needs. Connect again and leave the read permission ticked.'],
  connected_by_another_member: [409, 'This Google account is already connected by another member of the workspace.'],
};

/**
 * The opener finishes the flow with its own session. Exchanges the code (PKCE), refuses a grant
 * without the product's read scope, refuses to take over another member's row, then saves.
 * Returns { status, body }. Separated from Express so tests drive it with a fake database and a
 * mocked Google.
 */
export async function completeGoogleConnection({
  code, userId, workspaceId, supabase, fetchImpl = globalThis.fetch, env = process.env, afterConnect = startIngest,
}) {
  const fail = (key, extra) => {
    const [status, message] = COMPLETE_ERRORS[key] || [500, 'The Google connection failed.'];
    return { status, body: { ok: false, error: key, message: extra || message } };
  };
  const taken = takeCompletion(code, { userId, workspaceId });
  if (taken.error) return fail(taken.error);
  const pending = taken.data;
  try {
    const tokens = await exchangeCode({ code: pending.googleCode, verifier: pending.verifier, env, fetchImpl });
    if (!grantedRequiredScope(pending.provider, tokens.scope)) {
      console.warn(`[GOOGLE_OAUTH] ${pending.provider}: ${GOOGLE_PRODUCTS[pending.provider].required} not granted — not saved`);
      return fail('scope_not_granted');
    }
    const email = await fetchGoogleEmail(tokens.access_token, { fetchImpl });
    const connection = await saveNativeGoogleConnection(supabase, {
      workspaceId: pending.workspaceId, userId: pending.userId, provider: pending.provider, email, tokens,
    });
    await afterConnect({ supabase, connection, provider: pending.provider, userId: pending.userId });
    console.log(`[GOOGLE_OAUTH] connected ${pending.provider} ${maskEmail(email)} connection=${connection.id}`);
    return { status: 200, body: { ok: true, connection_id: connection.id, provider: pending.provider } };
  } catch (err) {
    if (err?.code === 'connected_by_another_member') return fail('connected_by_another_member');
    console.error('[GOOGLE_OAUTH_COMPLETE]', err?.message || err);
    return { status: 502, body: { ok: false, error: 'callback_failed', message: 'Google did not complete the connection. Try again.' } };
  }
}

/**
 * What a Composio connect does once the account is live (finalizeComposioConnection), for a native
 * one: the worker backfills this mailbox or calendar through its scans, and the connect-time
 * ingest runs. Both fire-and-forget; neither may fail the connect.
 */
async function startIngest({ supabase, connection, provider, userId }) {
  if (process.env.WORKER_SECRET) {
    const base = (process.env.NOUS_WORKER_URL || workerBaseUrl()).replace(/\/+$/, '');
    fetch(`${base}/internal/google/backfill`, {
      method: 'POST',
      headers: { 'x-worker-secret': process.env.WORKER_SECRET, 'content-type': 'application/json' },
      body: JSON.stringify({ connectionId: connection.id }),
    }).catch((err) => console.warn('[GOOGLE_OAUTH backfill]', err?.message || err));
  }
  ingestOnConnect(connection.workspace_id, provider, { supabase, userId })
    .catch((e) => console.error('[GOOGLE_OAUTH] ingest failed:', e?.message || e));
  auditLog({
    actor_user_id: userId ?? null,
    action: 'integration.connect',
    target_type: 'connection',
    target_id: connection.id,
    target_workspace_id: connection.workspace_id,
    metadata: { provider, managed_by: connection.managed_by },
  });
}

oauthGoogleRouter.get('/callback', (req, res) => {
  const out = parkGoogleCallback({ query: req.query });
  if (out.redirect) return res.redirect(out.redirect);
  res.set({
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${out.nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'`,
  });
  return res.type('html').send(out.html);
});

// Burning a code needs nothing but the code: whoever holds it may cancel it. Unauthenticated
// (the hand-off page has no session), so it is rate-limited like the other public routes.
const discardLimiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false, message: { error: 'rate_limited' } });
oauthGoogleRouter.post('/discard', discardLimiter, (req, res) => {
  discardCompletion(req.body?.code);
  return res.status(204).end();
});

oauthGoogleRouter.post('/complete', verifySupabaseAuth, async (req, res) => {
  const { status, body } = await completeGoogleConnection({
    code: req.body?.code, userId: req.internalUserId, workspaceId: req.workspaceId, supabase: getSupabaseClient(),
  });
  return res.status(status).json(body);
});
