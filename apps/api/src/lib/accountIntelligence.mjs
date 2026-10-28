// What the workspace has learned, for one account (GET-1042): the Intelligence an agent reads
// before it writes, says or decides something about it. Shared by POST /v2/context (which the MCP's
// get_context renders) and the in-app agent, so both read the same sections for the same account.
//
// The reader is @nous/core's intelligenceFor: null on an install with no Intelligence, and never
// throws. This only finds the account, and the cut the task wants.
import { intelligenceFor } from '@nous/core';

/** The intents that end in words for the buyer: they get the draft cut. Pure. */
export function intelligencePurpose(intent) {
  return intent === 'draft_email' || intent === 'follow_up' ? 'draft' : 'brief';
}

/**
 * The account an entity is: a company is its own, a person is their current company (works_at).
 * `entity` is { id, type }, or an id (its type is then read). → company id | null
 */
export async function accountOf(sb, ws, entity) {
  const e = typeof entity === 'string'
    ? (await sb.from('entities').select('id, type').eq('workspace_id', ws).eq('id', entity).maybeSingle()).data
    : entity;
  if (!e?.id) return null;
  if (e.type === 'company') return e.id;
  if (e.type !== 'person') return null;
  const { data } = await sb.from('relationships').select('to_entity_id')
    .eq('workspace_id', ws).eq('from_entity_id', e.id).eq('type', 'works_at').is('valid_to', null).limit(1);
  return data?.[0]?.to_entity_id ?? null;
}

/** → { text, used } for the entity's account, or null (no account, or no Intelligence). */
export async function accountIntelligence(sb, ws, entity, { intent = 'account_review', budget = 3500 } = {}) {
  const companyId = await accountOf(sb, ws, entity).catch(() => null);
  if (!companyId) return null;
  const out = await intelligenceFor(sb, ws, { companyId, purpose: intelligencePurpose(intent), budget });
  return out ? { text: out.text, used: out.used ?? [] } : null;
}
