// A departure is a risk, and it is the only risk that arrives without a health read.
//
// `staff_change` was promoted from `general` on 2026-09-18 (GET-327) after two weeks of mining,
// across several accounts. It is the only category in the taxonomy that changes state rather
// than describing it — a departure ends the authority claim it contradicts, a new hire is training
// demand, a reorganisation resets who talks to whom.
//
// These tests pin the half that has teeth: what a departure does to an account's standing, and —
// just as important — what the other three changes must NOT do.
//
// Run: node --test packages/core/test/staffChange.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAccountHealth } from '../dist/services/accountHealthState.js';
import { CLAIM_CATEGORIES, normalizeClaimCategory, claimCategoryPromptBlock } from '../dist/db/claimCategories.js';

const AT = new Date('2026-09-18T00:00:00Z');
const recently = '2026-09-01T10:00:00Z';
const longAgo = '2026-01-05T10:00:00Z';

/** A claims table holding exactly these rows. */
function db(rows) {
  const q = {
    select: () => q, eq: () => q, like: () => q, is: () => q,
    limit: () => Promise.resolve({ data: rows, error: null }),
  };
  return { from: () => q };
}

const claim = (category, change, content, at) => ({
  value: { category, content, metadata: { change, occurred_at: at, quote: 'he is moving on in May' } },
  last_observed_at: at,
});

test('a departure puts the account at risk, and says why', async () => {
  const health = await getAccountHealth(
    db([claim('staff_change', 'left', 'Torvald left the dealership; he was the digital inventory manager.', recently)]),
    'ws', 'acct', { now: AT },
  );
  assert.equal(health.standing, 'at_risk');
  assert.equal(health.risks.length, 1);
  assert.match(health.risks[0].text, /Torvald left/);
});

test('a new hire, a move, a reorg and a long absence are NOT risks', async () => {
  // Training demand and a reset relationship are real, and neither is churn. Counting them would
  // turn every growing account red within a week and make standing worthless. `away` joins them:
  // a rep needs to know Marigold is back in April 2027, and an account is not at risk because
  // somebody had a baby.
  for (const change of ['joined', 'moved', 'reorg', 'away']) {
    const health = await getAccountHealth(
      db([claim('staff_change', change, `Somebody ${change} at the dealership.`, recently)]),
      'ws', 'acct', { now: AT },
    );
    assert.equal(health.standing, 'neutral', `${change} must not read as risk`);
    assert.equal(health.risks.length, 0);
  }
});

test('a departure decays like any other risk', async () => {
  // It does not un-happen, but its risk fades as the relationship re-forms. Eight months on, a
  // CS lead seeing it on today's list stops trusting the list.
  const health = await getAccountHealth(
    db([claim('staff_change', 'left', 'Ingram left the store.', longAgo)]),
    'ws', 'acct', { now: AT },
  );
  assert.equal(health.standing, 'neutral');
  assert.equal(health.staleCount, 1);
});

test('a staff_change with no change label is not acted on', async () => {
  // The label is what a rule can act on. Prose is not: "Torvald left", "we lost Torvald" and "Torvald is
  // no longer with us" are one fact and three strings.
  const health = await getAccountHealth(
    db([claim('staff_change', null, 'Something happened with Torvald.', recently)]),
    'ws', 'acct', { now: AT },
  );
  assert.equal(health.standing, 'neutral');
});

test('an open departure outranks an expansion signal', async () => {
  const health = await getAccountHealth(
    db([
      claim('staff_change', 'left', 'Their champion left.', recently),
      { value: { category: 'buying_signal', content: 'Asked about adding the Westgate store.', metadata: { signal_type: 'health_expansion', occurred_at: recently } }, last_observed_at: recently },
    ]),
    'ws', 'acct', { now: AT },
  );
  assert.equal(health.standing, 'at_risk', 'a second site does not offset the person who chose us leaving');
});

test('the category is in the taxonomy and reaches the extractor prompt', async () => {
  // The prompt block is generated from the taxonomy, so a category that is not in the list is a
  // category the model is never asked for — the quiet way a promotion does nothing.
  assert.ok(CLAIM_CATEGORIES.some(c => c.key === 'staff_change'));
  assert.equal(normalizeClaimCategory('staff_change'), 'staff_change');
  assert.match(claimCategoryPromptBlock(), /staff_change/);
});
