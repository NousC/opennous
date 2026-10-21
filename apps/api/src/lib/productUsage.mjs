// Product usage on the account page (GET-751): what the PostHog usage pull recorded on an account.
//
// The pull writes PostHog's own product.* facts on every account, and the account-health cs.*
// copies only where no CRM writes them. The card reads product.* (falling back to cs.* for a
// pull from before the copies existed) and shows only when a product.* fact exists: the account
// has product usage from PostHog, not just a CRM field.

export const PRODUCT_USAGE_PROPERTIES = [
  'cs.active_users_30d', 'cs.total_users', 'cs.usage_30d', 'cs.last_used_at',
  'product.active_users_30d', 'product.total_users', 'product.usage_30d', 'product.last_used_at',
  'product.active_users_7d', 'product.active_users_prev_30d', 'product.usage_prev_30d', 'product.key_events',
];

const unwrap = (v) => (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v ? v.value : v);
const n = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** Which of these people use the product (GET-751): a current `product.user` claim of true. */
export async function productUsersAmong(supabase, workspaceId, ids) {
  const out = new Set();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await supabase.from('claims').select('entity_id, value')
      .eq('workspace_id', workspaceId).eq('property', 'product.user').is('invalid_at', null).in('entity_id', ids.slice(i, i + 200));
    for (const r of data ?? []) if (unwrap(r.value) === true) out.add(r.entity_id);
  }
  return out;
}

/** A person's product usage for their record, or null when PostHog has nothing on them. */
export function personProductUsage(rows) {
  const c = Object.fromEntries((rows ?? []).map(r => [r.property, unwrap(r.value)]));
  if (!('product.user' in c) && !('product.last_seen_at' in c)) return null;
  return {
    user: c['product.user'] === true,
    last_seen_at: c['product.last_seen_at'] || null,
    active_days_30d: n(c['product.active_days_30d']),
    events_30d: n(c['product.events_30d']),
  };
}

export const PERSON_USAGE_PROPERTIES = ['product.user', 'product.last_seen_at', 'product.active_days_30d', 'product.events_30d'];

/** The claims as the card's numbers, or null when PostHog never wrote usage for this account. */
export function productUsageFromClaims(rows) {
  const c = Object.fromEntries((rows ?? []).map(r => [r.property, unwrap(r.value)]));
  if (!Object.keys(c).some(k => k.startsWith('product.'))) return null;
  const keyEvents = c['product.key_events'] && typeof c['product.key_events'] === 'object' ? c['product.key_events'] : {};
  const updated = (rows ?? []).map(r => r.computed_at).filter(Boolean).sort().at(-1) ?? null;
  return {
    active_users_30d: n(c['product.active_users_30d'] ?? c['cs.active_users_30d']),
    active_users_7d: n(c['product.active_users_7d']),
    active_users_prev_30d: n(c['product.active_users_prev_30d']),
    total_users: n(c['product.total_users'] ?? c['cs.total_users']),
    usage_30d: n(c['product.usage_30d'] ?? c['cs.usage_30d']),
    usage_prev_30d: n(c['product.usage_prev_30d']),
    last_used_at: c['product.last_used_at'] || c['cs.last_used_at'] || null,
    key_events: Object.entries(keyEvents).map(([name, s]) => ({
      name, count_30d: n(s?.count30d) ?? 0, users_30d: n(s?.users30d) ?? 0, first_seen: s?.firstSeen ?? null,
    })),
    updated_at: updated,
  };
}
