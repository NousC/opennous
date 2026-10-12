// Bookkeeping on the note shelf is not intel (GET-417).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isIntelClaim } from '../dist/db/claimCategories.js';

test('a fact is intel; documents, health summaries and speaker-link notes are not', () => {
  assert.equal(isIntelClaim({ category: 'pain', content: 'x', metadata: { quote: 'y' } }), true);
  assert.equal(isIntelClaim({ category: 'general', metadata: { doc_type: 'meeting_notes' } }), false);
  assert.equal(isIntelClaim({ category: 'adoption', metadata: { signal_type: 'health_adoption' } }), false);
  assert.equal(isIntelClaim({ category: 'status_quo', metadata: { summary: true } }), false);
  assert.equal(isIntelClaim({ category: 'general', metadata: { flag: 'speaker_name_link' } }), false);
  assert.equal(isIntelClaim({ category: 'risk_signal', metadata: { signal_type: 'health_risk', quote: 'q' } }), true, 'a risk from the health read IS a fact');
  assert.equal(isIntelClaim(null), true);
});
