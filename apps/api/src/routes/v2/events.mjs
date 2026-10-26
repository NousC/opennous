import { Router } from 'express';
import { getSupabaseClient, listEvents, getLoggedEvent, getPersonalEntityIds, TRIGGER_EVENTS, EVENTS_PAGE_MAX, EVENT_API_VERSION } from '@nous/core';

export const eventsV2Router = Router();

// /v2/events — every event that happened in the workspace, the way Stripe lists its events
// (GET-939). The same bodies a webhook receives (services/events.mjs), with the same ids, kept 30
// days, whether or not anything was subscribed. Pull them on a cron or from an agent; subscribe
// with /v2/webhooks to have them pushed.
//
//   GET /v2/events                 newest first
//       ?type=deal.won | signal.*  one type, or a family
//       &account=<entity id>       one account (or person)
//       &since=<ISO time>          happened at or after (GET-1014)
//       &until=<ISO time>          happened before
//       &starting_after=<event id> the last id of the page you have
//       &limit=25                  1–100
//   GET /v2/events/:id             one event
//
// Read as the whole team, like a webhook: any key or signed-in member of the workspace. An account
// or person marked personal is not on it (GET-1014), and people.added only when asked for by type.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FAMILIES = [...new Set(TRIGGER_EVENTS.map((t) => t.split('.')[0]))];
const QUERY_FIELDS = new Set(['type', 'account', 'since', 'until', 'starting_after', 'limit', 'workspaceId', 'workspace_id']);

/** An ISO time from a query value, or undefined when absent, or null when it is not a time. */
function isoTime(v) {
  if (v == null || v === '') return undefined;
  const t = new Date(String(v));
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

/** A request's query as listEvents' filters, or the reason it cannot be one. Pure. */
export function parseEventsQuery(query = {}) {
  for (const k of Object.keys(query)) if (!QUERY_FIELDS.has(k)) return { ok: false, error: 'unknown_parameter', parameter: k };
  const type = typeof query.type === 'string' && query.type.trim() ? query.type.trim() : null;
  if (type) {
    const family = type.endsWith('.*') ? type.slice(0, -2) : null;
    if (family ? !FAMILIES.includes(family) : !TRIGGER_EVENTS.includes(type)) {
      return { ok: false, error: 'unknown_event_type', available: [...FAMILIES.map((f) => `${f}.*`), ...TRIGGER_EVENTS] };
    }
  }
  const account = query.account ?? null;
  if (account != null && !UUID.test(String(account))) return { ok: false, error: 'invalid_account', message: 'account is an entity id.' };
  const after = query.starting_after ?? null;
  if (after != null && !UUID.test(String(after))) return { ok: false, error: 'invalid_cursor', message: 'starting_after is an event id.' };
  const since = isoTime(query.since);
  const until = isoTime(query.until);
  if (since === null || until === null) return { ok: false, error: 'invalid_time', message: 'since and until are ISO times, like 2026-10-01T00:00:00Z.' };
  let limit = 25;
  if (query.limit != null) {
    limit = Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > EVENTS_PAGE_MAX) return { ok: false, error: 'invalid_limit', message: `limit is 1 to ${EVENTS_PAGE_MAX}.` };
  }
  return { ok: true, filters: { type, entityId: account, ...(since && { since }), ...(until && { until }), startingAfter: after, limit } };
}

// A signed-in user names the workspace (?workspaceId=, checked for membership by the auth); a key
// carries its own. Without one there is no feed to read.
eventsV2Router.use((req, res, next) => (req.workspaceId ? next() : res.status(400).json({ error: 'workspace_required' })));

eventsV2Router.get('/', async (req, res) => {
  try {
    const parsed = parseEventsQuery(req.query);
    if (!parsed.ok) return res.status(400).json(parsed);
    const supabase = getSupabaseClient();
    const personal = await getPersonalEntityIds(supabase, req.workspaceId);
    const page = await listEvents(supabase, req.workspaceId, { ...parsed.filters, excludeEntityIds: [...personal] });
    if (page.unknown_cursor) return res.status(400).json({ error: 'invalid_cursor', message: 'starting_after is not an event in this workspace.' });
    const last = page.events.at(-1);
    return res.json({
      object: 'list',
      api_version: EVENT_API_VERSION,
      data: page.events,
      has_more: page.has_more,
      next_starting_after: page.has_more && last ? last.id : null,
    });
  } catch (err) {
    console.error('[GET /v2/events]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

eventsV2Router.get('/:id', async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'event_not_found' });
    const event = await getLoggedEvent(getSupabaseClient(), req.workspaceId, req.params.id);
    if (!event) return res.status(404).json({ error: 'event_not_found' });
    return res.json(event);
  } catch (err) {
    console.error('[GET /v2/events/:id]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
