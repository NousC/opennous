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
  'GET /v2/deals':            'v2.deals',
  'GET /v2/accounts/outlook': 'v2.account.outlook',
  'GET /v2/people':           'v2.people.get',
  'GET /v2/pipelines':        'v2.pipelines',
  // Organization, usage, workflows (public API)
  'GET /v2/members':             'v2.members',
  'POST /v2/members':            'v2.members.invite',
  'DELETE /v2/members':          'v2.members.remove',
  'GET /v2/brain':               'v2.brain',
  'GET /v2/brain/search':        'v2.brain.search',
  'GET /v2/brain/page':          'v2.brain.page',
  'PUT /v2/brain/page':          'v2.brain.page.write',
  'GET /v2/intelligence':        'v2.intelligence',
  'GET /v2/icp':                 'v2.icp',
  'PUT /v2/icp':                 'v2.icp.set',
  'POST /v2/icp/closed-deals':   'v2.icp.closed_deals',
  'GET /v2/usage':               'v2.usage',
  'GET /v2/usage/breakdown':     'v2.usage.breakdown',
  'GET /v2/workflows':           'v2.workflows',
  'GET /v2/workflows/triggers':  'v2.workflows.triggers',
  'POST /v2/workflows':          'v2.workflows.create',
  'PATCH /v2/workflows':         'v2.workflows.update',
  'DELETE /v2/workflows':        'v2.workflows.delete',
  'POST /v2/workflows/duplicate': 'v2.workflows.duplicate',
  'POST /v2/workflows/run':      'v2.workflows.run',
  'GET /v2/workflows/runs':      'v2.workflows.runs',
};

// The LIST read on a router whose '/:id' read shares the same key above (params are stripped).
const LIST_LABELS = {
  'GET /v2/accounts': 'v2.account.list',
  'GET /v2/deals':    'v2.deals.list',
  'GET /v2/people':   'v2.people.list',
};

function labelFor(req) {
  // Strip any trailing identifier from a path like /v2/accounts/sarah@acme.com
  // so the lookup matches the route, not the value.
  const base = req.baseUrl + (req.route?.path && req.route.path !== '/'
    ? req.route.path.replace(/\/:[^/]+/g, '')
    : '');
  const key = `${req.method} ${base}`;
  if (req.route?.path === '/' && LIST_LABELS[key]) return LIST_LABELS[key];
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

// " · key=value · …" for the filters a list call actually used, in a fixed order.
function listBits(q, keys) {
  const bits = keys.filter((k) => q[k] != null && q[k] !== '').map((k) => `${k}=${trunc(q[k], 24)}`);
  return bits.length ? ` · ${bits.join(' · ')}` : '';
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
      if (req.params?.id) return `get_account · ${trunc(req.params.id)}`;
      return `list_accounts${listBits(q, ['search', 'stage', 'owner', 'country', 'icp_fit', 'min_icp_score', 'has_open_deal', 'include', 'sort'])}`;
    }
    case 'GET /v2/accounts/outlook': {
      const bits = [req.params?.id ? trunc(req.params.id) : 'ranked'];
      if (q.within_days) bits.push(`within ${q.within_days}d`);
      return `account_outlook · ${bits.join(' · ')}`;
    }
    case 'GET /v2/people': {
      if (req.params?.id) return `get_person · ${trunc(req.params.id)}`;
      return `list_people${listBits(q, ['search', 'account', 'pipeline_stage', 'icp_fit', 'min_icp_score', 'include', 'sort'])}`;
    }
    case 'GET /v2/pipelines': {
      return 'list_pipelines';
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
    case 'GET /v2/deals': {
      if (q.within_days != null && !req.params?.id) return `account_outlook · ranked · within ${q.within_days}d`;
      if (req.params?.id) return `get_deal · ${trunc(req.params.id)}`;
      return `list_deals${listBits(q, ['account', 'status', 'stage', 'pipeline', 'owner', 'closing_within_days', 'min_amount', 'implied', 'sort'])}`;
    }
    case 'GET /v2/insights': {
      const bits = [q.lane, q.subtype, q.focus ? `focus=${trunc(q.focus)}` : null, q.since ? `since ${trunc(q.since, 10)}` : null].filter(Boolean);
      return `get_insights${bits.length ? ` · ${bits.join(' · ')}` : ''}`;
    }
    case 'POST /v2/insights': {
      const n = Array.isArray(body.insights) ? body.insights.length : 0;
      return `record_insight · ${n} insight${n === 1 ? '' : 's'}`;
    }
    case 'POST /v2/people/enrich': {
      return `enrich_person · ${trunc(req.params?.id)}${body.force ? ' · force' : ''}`;
    }
    case 'GET /v2/members':     return 'list_members';
    case 'POST /v2/members':    return `invite_member · ${trunc(body.email)}${body.role ? ` · ${body.role}` : ''}`;
    case 'DELETE /v2/members':  return `remove_member · ${trunc(req.params?.id, 16)}`;
    case 'GET /v2/brain':       return 'brain';
    case 'GET /v2/brain/search': return `brain_search · ${trunc(q.q)}`;
    case 'GET /v2/brain/page':  return `read_page · ${trunc(q.path)}`;
    case 'PUT /v2/brain/page':  return `save_page · ${trunc(body.path)}`;
    case 'GET /v2/intelligence': return 'read_intelligence';
    case 'GET /v2/icp':         return 'get_icp';
    case 'PUT /v2/icp':         return 'set_icp';
    case 'POST /v2/icp/closed-deals': {
      const w = Array.isArray(body.won) ? body.won.length : 0;
      const l = Array.isArray(body.lost) ? body.lost.length : 0;
      return `train_icp_model · ${w} won · ${l} lost`;
    }
    case 'GET /v2/usage':       return 'usage';
    case 'GET /v2/usage/breakdown': return `usage_breakdown · by ${trunc(q.by ?? 'source', 12)}`;
    case 'GET /v2/workflows':   return req.params?.id ? `get_workflow · ${trunc(req.params.id, 16)}` : 'list_workflows';
    case 'GET /v2/workflows/triggers': return 'workflow_triggers';
    case 'POST /v2/workflows':  return `create_workflow · ${trunc(body.name ?? body.trigger?.type, 32)}`;
    case 'PATCH /v2/workflows': {
      const what = ['name', 'trigger', 'steps', 'enabled'].filter(k => body[k] !== undefined);
      return `update_workflow · ${trunc(req.params?.id, 16)}${what.length ? ` · ${what.join(', ')}` : ''}`;
    }
    case 'DELETE /v2/workflows': return `delete_workflow · ${trunc(req.params?.id, 16)}`;
    case 'POST /v2/workflows/duplicate': return `duplicate_workflow · ${trunc(req.params?.id, 16)}`;
    case 'POST /v2/workflows/run': return `run_workflow · ${trunc(req.params?.id, 16)}`;
    case 'GET /v2/workflows/runs': return `workflow_runs · ${trunc(req.params?.id, 16)}`;
    default:
      return `${req.method} ${req.originalUrl.split('?')[0]}`;
  }
}

// What a READ returned — the result shape. Counts the known array fields in a v2
// response body so the Retrievals log can say "get_context → 6 facts, 2 docs" instead
// of just "v2.context". Generic: it reads the response shape, not the endpoint, so new
// read endpoints get a shape for free. Returns null for writes / empty responses.
const SHAPE_FIELDS = [
  ['facts', 'facts'], ['claims', 'claims'], ['documents', 'docs'], ['timeline', 'events'],
  ['stakeholders', 'people'], ['results', 'results'], ['entities', 'entities'],
  ['rows', 'rows'], ['observations', 'obs'], ['candidates', 'candidates'], ['insights', 'insights'],
  ['accounts', 'accounts'], ['deals', 'deals'], ['people', 'people'], ['pipelines', 'pipelines'],
  ['members', 'members'], ['workflows', 'workflows'], ['runs', 'runs'], ['pages', 'pages'],
];
function resultShape(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const shape = {};
  for (const [key, label] of SHAPE_FIELDS) if (Array.isArray(body[key])) shape[label] = body[key].length;
  return Object.keys(shape).length ? shape : null;
}
const shapeSummary = (shape) => shape ? Object.entries(shape).map(([k, v]) => `${v} ${k}`).join(', ') : '';

function summarize(req, status, ms, shape) {
  const ok   = status < 400;
  const mark = ok ? '✓' : '✗';
  const detail = describeCall(req);
  const ret = ok && shape ? ` → ${shapeSummary(shape)}` : '';
  // Success: ✓ {detail}{ → returned} · 248ms     (status code redundant — the ✓ says it)
  // Failure: ✗ {detail} · 404 · 248ms   (status code matters when it failed)
  return ok
    ? `${mark} ${detail}${ret} · ${ms}ms`
    : `${mark} ${detail} · ${status} · ${ms}ms`;
}

/**
 * Wraps an express router/handler so every response — success or failure —
 * appends a row to workspace_system_log. Non-blocking: the insert is fired
 * after res.finish so it never sits in the request path.
 */
export function logV2Op(req, res, next) {
  const start = Date.now();

  // Snoop the response body so we can record WHAT a read returned (its result shape).
  // Wrap res.json (the v2 handlers all respond with it); call the original untouched.
  let responseBody = null;
  const origJson = res.json.bind(res);
  res.json = (body) => { responseBody = body; return origJson(body); };

  res.on('finish', () => {
    const workspaceId = req.workspaceId;
    if (!workspaceId) return; // unauthenticated call (verifyApiKey rejected) — skip

    const duration_ms = Date.now() - start;
    const source = detectSource(req);
    const event_type = labelFor(req);
    const shape = res.statusCode < 400 ? resultShape(responseBody) : null;
    // Owner-scoped reads may have filtered cross-owner rows before returning — the
    // honest "allowed vs redacted" signal without counting every dropped row.
    const scoped = req.viewerScope === 'member';
    const summary = summarize(req, res.statusCode, duration_ms, shape);

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
          // Retrieval detail — what the read actually returned, and whether it was
          // owner-scoped (so the Retrievals log shows result shape + allowed-vs-redacted).
          ...(shape ? { result: shape } : {}),
          scoped,
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
