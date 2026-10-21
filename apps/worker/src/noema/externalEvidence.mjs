// Positive evidence acceptance shared by conversation adapters. Unknown authors and
// quotes found only in our side's messages never become customer findings.
import { groundQuote, normalizeForMatch } from './grounding.mjs';

export function externalEvidence(items, messages, { contactId = null } = {}) {
  const eligible = (messages ?? []).filter(m => m.side === 'external' && m.contactId && m.authorId && m.id && m.text);
  return (items ?? []).flatMap(item => {
    if (!item || typeof item.quote !== 'string') return [];
    const matches = eligible.filter(m => (!contactId || m.contactId === contactId)
      && groundQuote(item.quote, m.text)
      && (!item.speaker || normalizeForMatch(item.speaker) === normalizeForMatch(m.speaker)));
    // An identical quote from two different people is not enough to assign a speaker.
    if (!matches.length || new Set(matches.map(m => m.contactId)).size !== 1) return [];
    const first = matches[0];
    return [{ ...item, quote: groundQuote(item.quote, first.text), speaker: first.speaker,
      contactId: first.contactId, companyId: first.companyId ?? null,
      evidenceMessageIds: matches.map(m => m.id),
      ...(first.activityId ? { activityId: first.activityId, sourceActivityIds: matches.map(m => m.activityId).filter(Boolean) } : {}),
      saidAt: first.occurredAt ?? null }];
  });
}
