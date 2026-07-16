// Op logger — fire-and-forget middleware that records every /v2/* call into
// workspace_system_log so it shows up in the Live Op Log on the Ops page.
//
// Why: the v2 endpoints are the agent surface (MCP, SDK, direct HTTP). The
// Ops page reads from workspace_system_log; without this nothing the agent
// does is visible. Every other Nous capability (Attio sync, LinkedIn webhook,
// Gmail poller, etc.) already inserts a row — this brings agent ops into the
// same stream.
//
// Source detection rides the X-Nous-Client header that our MCP + SDK set
// (mcp / sdk / agent). curl / unknown clients fall back to 'api'.

import { getSupabaseClient } from '@nous/core';
import { useCaseForOp } from '../lib/useCases.mjs';

function detectSource(req) {
  const client = (req.get('X-Nous-Client') || '').toLowerCase();
  if (client === 'mcp' || client === 'sdk' || client === 'agent') return client;
  const ua = (req.get('User-Agent') || '').toLowerCase();
  if (ua.includes('python'))    return 'sdk';   // requests, httpx
  if (ua.includes('node-fetch') || ua.includes('axios')) return 'sdk';
  return 'api';
}

// Map { req.method + base path } → human op name shown in the Op Log row.
// Anything missing falls back to a generic "v2.<segment>".
const PATH_LABELS = {
  'POST /v2/context':         'v2.context',
  'GET /v2/accounts':         'v2.account.get',
  'POST /v2/accounts/merge':  'v2.account.merge',
  'POST /v2/observations':    'v2.observations.write',
  'POST /v2/query':           'v2.query',
  'GET /v2/attention':        'v2.attention',
  'POST /v2/verify':          'v2.verify',
  'POST /v2/dedup':           'v2.dedup',
  'GET /v2/workspace/facts':  'v2.workspace.facts',
  'GET /v2/workspace/status': 'v2.workspace.status',
  'POST /v2/workspace/onboarding': 'v2.workspace.onboarding',
  'POST /v2/workspace/scoring-model': 'v2.workspace.scoring_model',
  'POST /v2/workspace/integrations': 'v2.workspace.integration',
  'POST /v2/workspace/crm-sync': 'v2.workspace.crm_sync',
  'GET /v2/workspace/triggers': 'v2.workspace.triggers',
  'POST /v2/workspace/triggers': 'v2.workspace.trigger',
  'POST /v2/workspace/closed-deals': 'v2.workspace.closed_deals',
};

function labelFor(req) {
  // Strip any trailing identifier from a path like /v2/accounts/sarah@acme.com
  // so the lookup matches the route, not the value.
  const base = req.baseUrl + (req.route?.path && req.route.path !== '/'
    ? req.route.path.replace(/\/:[^/]+/g, '')
    : '');
  const key = `${req.method} ${base}`;
  if (PATH_LABELS[key]) return PATH_LABELS[key];
  // Fallback: collapse to /v2/<segment>
  const seg = base.split('/').filter(Boolean)[1] || 'unknown';
  return `v2.${seg}`;
}

// Truncate user-supplied strings for the one-line summary view. We want the
// gist — "sarah@acme.com" not the full URL-encoded LinkedIn slug — without
// blowing up the Op Log row.
function trunc(s, n = 40) {
  if (s == null) return '?';
  const str = String(s);
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

// Pull the verb-level description from the call shape — for /v2/query, peek
// at the scope to tell the user WHAT was queried instead of just "query".
// This is what makes the Op Log read like a trail of intentions, not just
// a sequence of HTTP requests.
function describeCall(req) {
  const body = req.body || {};
  const q    = req.query || {};
  const route = (req.baseUrl || '') + (req.route?.path && req.route.path !== '/'
    ? req.route.path.replace(/\/:[^/]+/g, '')
    : '');

  switch (`${req.method} ${route}`) {
    case 'POST /v2/context': {
      const bits = [`focus=${trunc(body.focus)}`];
      if (body.intent) bits.push(`intent=${body.intent}`);
      return `get_context · ${bits.join(' · ')}`;
    }
    case 'GET /v2/accounts': {
      return `get_account · ${trunc(req.params?.id)}`;
    }
    case 'POST /v2/observations': {
      const n = Array.isArray(body.observations) ? body.observations.length : 0;
      const props = (body.observations || []).map(o => o.property).filter(Boolean).slice(0, 2).join(', ');
      return `record · ${n} obs${props ? ` (${props}${n > 2 ? '…' : ''})` : ''} · focus=${trunc(body.focus)}`;
    }
    case 'POST /v2/query': {
      const scope = body.scope || {};
      const bits  = [];
      if (scope.kind)       bits.push(scope.kind);
      if (scope.property)   bits.push(scope.property);
      if (scope.source)     bits.push(`src=${scope.source}`);
      if (scope.entity_id)  bits.push(`entity=${trunc(scope.entity_id, 16)}`);
      if (scope.since_days) bits.push(`${scope.since_days}d`);
      if (body.return === 'entities') bits.push('→entities');
      if (body.without)     bits.push('-without');
      return `query · ${bits.length ? bits.join(' ') : 'all'}`;
    }
    case 'GET /v2/attention': {
      return `attention${q.limit ? ` · limit=${q.limit}` : ''}`;
    }
    case 'POST /v2/verify': {
      return `verify · ${trunc(body.focus)}.${body.property || '?'}`;
    }
    case 'POST /v2/dedup': {
      const e  = Array.isArray(body.emails)        ? body.emails.length        : 0;
      const li = Array.isArray(body.linkedin_urls) ? body.linkedin_urls.length : 0;
      const parts = [];
      if (e)  parts.push(`${e} emails`);
      if (li) parts.push(`${li} linkedin`);
      return `dedup · ${parts.join(' + ') || '0 identifiers'}`;
    }
    case 'GET /v2/workspace/facts': {
      return `workspace_facts${q.categories ? ` · ${q.categories}` : ''}`;
    }
    case 'GET /v2/workspace/status': {
      return 'get_workspace_status';
    }
    case 'POST /v2/workspace/onboarding': {
      const bits = [];
      if (body.name)          bits.push(`name=${trunc(body.name, 24)}`);
      if (body.website)       bits.push(`site=${trunc(body.website, 24)}`);
      if (body.business_type) bits.push(body.business_type);
      if (body.icp)           bits.push('icp');
      return `set_workspace_profile${bits.length ? ` · ${bits.join(' · ')}` : ''}`;
    }
    case 'POST /v2/workspace/scoring-model': {
      return `build_icp_model${body.force ? ' · rebuild' : ''}`;
    }
    case 'POST /v2/workspace/integrations': {
      return `connect_integration · ${trunc(body.provider, 24)}`;
    }
    case 'POST /v2/workspace/crm-sync': {
      return `configure_crm_sync · ${trunc(body.provider, 24)}`;
    }
    case 'POST /v2/workspace/triggers': {
      const n = Array.isArray(body.events) ? body.events.length : 0;
      return `set_trigger · ${n} event${n === 1 ? '' : 's'}`;
    }
    case 'GET /v2/workspace/triggers': {
      return 'list_triggers';
    }
    case 'POST /v2/workspace/closed-deals': {
      const w = Array.isArray(body.won) ? body.won.length : 0;
      const l = Array.isArray(body.lost) ? body.lost.length : 0;
      return `train_icp_model · ${w} won · ${l} lost`;
    }
    default:
      return `${req.method} ${req.originalUrl.split('?')[0]}`;
  }
}

function summarize(req, status, ms) {
  const ok   = status < 400;
  const mark = ok ? '✓' : '✗';
  const detail = describeCall(req);
  // Success: ✓ {detail} · 248ms     (status code redundant — the ✓ says it)
  // Failure: ✗ {detail} · 404 · 248ms   (status code matters when it failed)
  return ok
    ? `${mark} ${detail} · ${ms}ms`
    : `${mark} ${detail} · ${status} · ${ms}ms`;
}

/**
 * Wraps an express router/handler so every response — success or failure —
 * appends a row to workspace_system_log. Non-blocking: the insert is fired
 * after res.finish so it never sits in the request path.
 */
export function logV2Op(req, res, next) {
  const start = Date.now();

  res.on('finish', () => {
    const workspaceId = req.workspaceId;
    if (!workspaceId) return; // unauthenticated call (verifyApiKey rejected) — skip

    const duration_ms = Date.now() - start;
    const source = detectSource(req);
    const event_type = labelFor(req);
    const summary = summarize(req, res.statusCode, duration_ms);

    try {
      const supabase = getSupabaseClient();
      // Fire-and-forget. Any failure here is invisible by design — we'd rather
      // miss a log row than 500 an agent call because of a logging hiccup.
      supabase.from('workspace_system_log').insert({
        workspace_id: workspaceId,
        // Who ran this. An API key carries its owner; a session carries the
        // logged-in user. Both already land on req.memberUserId — we just never
        // wrote it down, which is why "who on my team is actually using this"
        // was unanswerable. Null for workspace-scoped keys with no owner.
        user_id: req.memberUserId ?? null,
        source,
        event_type,
        // What the op was FOR. For agent traffic the verb is the intent — an
        // agent calling v2.leads is building a list — so no model is needed.
        use_case: useCaseForOp(event_type),
        summary,
        metadata: {
          method:      req.method,
          path:        req.originalUrl,
          status:      res.statusCode,
          duration_ms,
          client:      req.get('X-Nous-Client') || null,
          user_agent:  req.get('User-Agent') || null,
        },
      }).then(() => {}, (err) => {
        console.error('[opLogger] insert failed:', err?.message);
      });
    } catch (err) {
      console.error('[opLogger] threw:', err?.message);
    }
  });

  next();
}
