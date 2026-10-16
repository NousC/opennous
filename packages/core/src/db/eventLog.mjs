// The event log (GET-939): every event that happened in a workspace, once, whether or not a webhook
// listens. emitEvent writes it; the Events page and GET /v2/events read it. A row's payload is the
// envelope a webhook receives (services/events.mjs), with the same id; the feed shows it through
// feedView, which leaves out what is private to one member.

/** Kept this long, like Stripe's events. */
export const EVENT_LOG_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;
export const EVENTS_PAGE_MAX = 100;

/**
 * The logged event with this identity (`<type>:<dedupeKey>`), or null. Throws on a read error.
 * Only the id unless `withPayload`: the body is read only when there is someone to send it to.
 */
export async function loggedEvent(supabase, workspaceId, externalId, { withPayload = false } = {}) {
  const { data, error } = await supabase.from('event_log').select(withPayload ? 'id, payload' : 'id')
    .eq('workspace_id', workspaceId).eq('external_id', externalId).maybeSingle();
  if (error) throw error;
  return data ?? null;
}

// What a webhook carries that the shared feed must not. A reply's subject, snippet and sender come
// from ONE member's mailbox (GET-244 gates mail content to its mailbox owners), and an approval's
// preview can hold a drafted email. A webhook is a destination someone chose; the feed is every
// member's, 30 days back, so these stay out of it. The event, its account and ids stay.
const FEED_REDACT = {
  'conversation.reply_received': ['subject', 'snippet', 'from'],
};
const FEED_KEEP = {
  'automation.approval_requested': ['run_id', 'automation'],
};

/** An event as the shared feed shows it: the webhook body minus what is private to one member. Pure. */
export function feedView(event) {
  if (!event || typeof event !== 'object') return event;
  const data = event.data && typeof event.data === 'object' ? event.data : {};
  const drop = FEED_REDACT[event.type];
  const keep = FEED_KEEP[event.type];
  if (!drop && !keep) return event;
  const out = keep
    ? Object.fromEntries(Object.entries(data).filter(([k]) => keep.includes(k)))
    : Object.fromEntries(Object.entries(data).filter(([k]) => !drop.includes(k)));
  return { ...event, data: out };
}

/** Log one event. A second write of the same identity is a no-op. Best-effort: false on failure. */
export async function logEvent(supabase, { workspaceId, type, externalId, entityId = null, occurredAt, payload }) {
  const { error } = await supabase.from('event_log').upsert({
    id: payload.id, workspace_id: workspaceId, type, external_id: externalId,
    entity_id: entityId, occurred_at: occurredAt, payload,
  }, { onConflict: 'workspace_id,external_id', ignoreDuplicates: true });
  if (error) { console.warn(`[event_log] ${type} not logged:`, error.message); return false; }
  return true;
}

/**
 * A page of the feed, newest first. `type` is one event type or a family (`signal.*`); `entityId`
 * narrows to one account (or person); `startingAfter` is the last event id of the previous page.
 * Returns { events, has_more } — events are the payloads as a webhook receives them — or
 * { unknown_cursor: true } when startingAfter is not an event of this workspace.
 */
export async function listEvents(supabase, workspaceId, { type = null, entityId = null, startingAfter = null, limit = 25 } = {}) {
  const n = Math.min(Math.max(Number(limit) || 25, 1), EVENTS_PAGE_MAX);
  let cursor = null;
  if (startingAfter) {
    const { data, error } = await supabase.from('event_log').select('id, created_at')
      .eq('workspace_id', workspaceId).eq('id', startingAfter).maybeSingle();
    if (error) throw error;
    if (!data) return { events: [], has_more: false, unknown_cursor: true };
    cursor = data;
  }
  let q = supabase.from('event_log').select('id, created_at, payload').eq('workspace_id', workspaceId);
  if (type?.endsWith('.*')) q = q.like('type', `${type.slice(0, -1)}%`);
  else if (type) q = q.eq('type', type);
  if (entityId) q = q.eq('entity_id', entityId);
  if (cursor) q = q.or(`created_at.lt."${cursor.created_at}",and(created_at.eq."${cursor.created_at}",id.lt.${cursor.id})`);
  const { data, error } = await q.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(n + 1);
  if (error) throw error;
  const rows = data ?? [];
  return { events: rows.slice(0, n).map(r => feedView(r.payload)), has_more: rows.length > n };
}

/** One event by id, as a webhook receives it, or null. */
export async function getLoggedEvent(supabase, workspaceId, id) {
  const { data, error } = await supabase.from('event_log').select('payload')
    .eq('workspace_id', workspaceId).eq('id', id).maybeSingle();
  if (error) throw error;
  return data?.payload ? feedView(data.payload) : null;
}

/** Drop events older than the retention. Daily, from the worker. Rows removed, or null on failure. */
export async function pruneEventLog(supabase, now = Date.now()) {
  const cutoff = new Date(now - EVENT_LOG_RETENTION_DAYS * DAY_MS).toISOString();
  const { error, count } = await supabase.from('event_log').delete({ count: 'exact' }).lt('created_at', cutoff);
  if (error) { console.warn('[event_log] prune failed:', error.message); return null; }
  return count ?? 0;
}
