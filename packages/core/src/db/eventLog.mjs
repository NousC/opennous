// The event log (GET-939): every event that happened in a workspace, once, whether or not a webhook
// listens. emitEvent writes it; the Events page and GET /v2/events read it. A row's payload is the
// envelope a webhook receives (services/events.mjs), with the same id; the feed shows it through
// feedView, which leaves out what is private to one member.

/** How recent an event must be to be logged when it is first emitted: an import of old history must
 *  not land on top of the feed as news. Logged events are kept for good (GET-1032); pruneEventLog is
 *  no longer scheduled. */
export const EVENT_LOG_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;
export const EVENTS_PAGE_MAX = 100;
// Logged, and sent to a webhook that listens, but not on the feed. A next step agreed (before
// GET-967) is a task, never shown; people added is plumbing (GET-1014), shown only when asked for
// by its type or family, the way a scorer reading /v2/events?type=people.added does.
const NEVER_ON_FEED = ['signal.next_step'];
const OFF_FEED_UNLESS_ASKED = ['people.added'];

/** The types a read with this `type` filter leaves out. Pure. */
export function feedHiddenTypes(type = null) {
  const asked = (t) => !!type && (type === t || (type.endsWith('.*') && t.startsWith(type.slice(0, -1))));
  return [...NEVER_ON_FEED, ...OFF_FEED_UNLESS_ASKED.filter((t) => !asked(t))];
}

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
 * narrows to one account (or person); `since` / `until` bound when it happened (ISO, until is
 * exclusive); `excludeEntityIds` drops the accounts and people the feed must not show (the ones
 * marked personal, GET-1014); `startingAfter` is the last event id of the previous page.
 * Returns { events, has_more } — events are the payloads as a webhook receives them — or
 * { unknown_cursor: true } when startingAfter is not an event of this workspace.
 */
export async function listEvents(supabase, workspaceId, { type = null, entityId = null, since = null, until = null, excludeEntityIds = [], startingAfter = null, limit = 25 } = {}) {
  const n = Math.min(Math.max(Number(limit) || 25, 1), EVENTS_PAGE_MAX);
  let cursor = null;
  if (startingAfter) {
    const { data, error } = await supabase.from('event_log').select('id, created_at')
      .eq('workspace_id', workspaceId).eq('id', startingAfter).maybeSingle();
    if (error) throw error;
    if (!data) return { events: [], has_more: false, unknown_cursor: true };
    cursor = data;
  }
  let q = supabase.from('event_log').select('id, created_at, payload').eq('workspace_id', workspaceId)
    // Not news: a next step agreed logged before GET-967 is a task, and people landing in the
    // workspace (GET-1014) is plumbing, unless the reader asked for exactly that.
    .not('type', 'in', `(${feedHiddenTypes(type).join(',')})`);
  if (type?.endsWith('.*')) q = q.like('type', `${type.slice(0, -1)}%`);
  else if (type) q = q.eq('type', type);
  if (entityId) q = q.eq('entity_id', entityId);
  if (since) q = q.gte('occurred_at', since);
  if (until) q = q.lt('occurred_at', until);
  // A plain NOT IN would also drop the events with no entity (an insight), so those are kept by name.
  if (excludeEntityIds.length) q = q.or(`entity_id.is.null,entity_id.not.in.(${excludeEntityIds.join(',')})`);
  if (cursor) q = q.or(`created_at.lt."${cursor.created_at}",and(created_at.eq."${cursor.created_at}",id.lt.${cursor.id})`);
  const { data, error } = await q.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(n + 1);
  if (error) throw error;
  const rows = data ?? [];
  const page = rows.slice(0, n).map(r => r.payload);
  const later = await laterOfSignalEvents(supabase, workspaceId, page);
  return { events: page.map(e => withLater(feedView(e), later.get(e?.id))), has_more: rows.length > n };
}

/** The event with what became of its claim, when something did. Never changes the stored payload. */
const withLater = (e, later) => (later ? { ...e, later } : e);

/**
 * What became of each signal's claim since the event was sent (GET-1032). An event is history: it
 * stays on the feed as it happened, and a claim later replaced, settled or corrected adds a note
 * behind it instead of hiding it ("the CEO, name not yet known" → now: Andrew is the CEO). What a
 * webhook was sent stays as sent. One claims lookup per page (two when something replaced them); a
 * failed lookup adds no notes. Returns event id → { status, why, now }, where status is replaced
 * (a newer claim took its place), corrected (read again in context, GET-1034), settled (no longer
 * holds, nothing newer) or removed (the claim is gone), and `now` is the newer claim's chip and
 * sentence, when there is one.
 */
export async function laterOfSignalEvents(supabase, workspaceId, events) {
  const out = new Map();
  try {
    // account.expansion_requested names its signal row, not its claim.
    const viaSignal = events.filter(e => e?.type === 'account.expansion_requested' && e.data?.signal_id);
    const sigIds = [...new Set(viaSignal.map(e => e.data.signal_id))];
    const bySignal = new Map();
    if (sigIds.length) {
      const { data, error } = await supabase.from('account_signals').select('id, entity_id, claim_property')
        .eq('workspace_id', workspaceId).in('id', sigIds);
      if (error) throw error;
      for (const r of data ?? []) bySignal.set(r.id, r);
    }
    const keyOf = (e) => {
      if (e?.type === 'account.expansion_requested') {
        const s = bySignal.get(e.data?.signal_id);
        return s?.claim_property ? `${s.entity_id}|${s.claim_property}` : null;
      }
      return String(e?.type ?? '').startsWith('signal.') && e.data?.entity_id && String(e.data?.claim_property ?? '').startsWith('note.')
        ? `${e.data.entity_id}|${e.data.claim_property}` : null;
    };
    const keyed = events.map(e => [e, keyOf(e)]).filter(([, k]) => k);
    if (!keyed.length) return out;
    const props = [...new Set(keyed.map(([, k]) => k.split('|')[1]))];
    const { data, error } = await supabase.from('claims').select('entity_id, property, invalid_at, value')
      .eq('workspace_id', workspaceId).in('property', props);
    if (error) throw error;
    const byKey = new Map((data ?? []).map(c => [`${c.entity_id}|${c.property}`, c]));
    const nextIds = [...new Set((data ?? []).filter(c => c.invalid_at).map(c => c.value?.metadata?.superseded_by).filter(Boolean))];
    const next = new Map();
    if (nextIds.length) {
      const { data: rows, error: e2 } = await supabase.from('claims').select('id, value').eq('workspace_id', workspaceId).in('id', nextIds);
      if (e2) throw e2;
      for (const r of rows ?? []) next.set(r.id, r.value ?? {});
    }
    for (const [e, k] of keyed) {
      const c = byKey.get(k);
      if (!c) { out.set(e.id, { status: 'removed', why: null, now: null }); continue; }
      if (!c.invalid_at) continue;
      const meta = c.value?.metadata ?? {};
      const newer = meta.superseded_by ? next.get(meta.superseded_by) : null;
      const status = meta.superseded_reason === 'misread' ? 'corrected' : newer ? 'replaced' : 'settled';
      out.set(e.id, {
        status, why: meta.superseded_why ?? null,
        now: newer ? { label: newer.label ?? null, text: newer.content ?? null } : null,
      });
    }
  } catch (err) {
    console.warn('[event_log] claim check failed, no notes added:', err?.message ?? err);
    return new Map();
  }
  return out;
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
