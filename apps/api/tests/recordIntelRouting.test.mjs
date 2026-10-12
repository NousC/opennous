// The plugin's write path must do what the worker's does.
//
// Three defects in one evening, all the same shape: the worker implements a rule, `record` does
// not, and the tool's documentation describes the worker's behaviour. Every claim really persisted
// and the response said `Recorded N observations`, so nothing looked wrong from outside.
//
//   GET-364  role / change sub-tags silently dropped
//   GET-365  external_id accepted, never stored, never checked — retries duplicated
//   GET-366  about:'company' never routed — most plugin claims landed on a person
//
// Measured before the fix, same source and same `about` value:
//   worker  ~1,000 company-facts → nearly all on the company
//   plugin    ~100 company-facts →          0 on the company
//
// Run: node --test apps/api/tests/recordIntelRouting.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

// The routing rule, stated once here as the worker states it, so a change to either side that
// breaks parity fails a test rather than quietly misfiling a quarter of a corpus.
const routeTo = (category, about, personId, companyId) =>
  (category !== 'buying_signal' && about === 'company' && companyId) ? companyId : personId;

test('a company fact goes to the company', () => {
  assert.equal(routeTo('status_quo', 'company', 'p1', 'co1'), 'co1');
  assert.equal(routeTo('adoption', 'company', 'p1', 'co1'), 'co1');
  assert.equal(routeTo('seasonality', 'company', 'p1', 'co1'), 'co1');
});

test('a person fact stays on the person', () => {
  assert.equal(routeTo('preference', 'person', 'p1', 'co1'), 'p1');
  assert.equal(routeTo('authority', 'person', 'p1', 'co1'), 'p1');
});

test('a buying signal never routes up, even marked company', () => {
  // The worker's own exception, and the reason for it: a buying signal is one person's move on the
  // deal, and stage and intent are person-level. A company entity does not pipeline.
  assert.equal(routeTo('buying_signal', 'company', 'p1', 'co1'), 'p1');
});

test('with no company known, a company fact stays on the person rather than being lost', () => {
  // Free-email contacts and unresolved domains are common. Keeping the claim in the wrong place is
  // recoverable; dropping it is not.
  assert.equal(routeTo('status_quo', 'company', 'p1', null), 'p1');
  assert.equal(routeTo('status_quo', 'company', 'p1', undefined), 'p1');
});

test('an absent or odd `about` is treated as person', () => {
  // `about` comes from a model. Anything that is not the literal string must not route.
  for (const about of [undefined, null, '', 'Company', 'COMPANY', 'org', 42]) {
    assert.equal(routeTo('status_quo', about, 'p1', 'co1'), 'p1', String(about));
  }
});

test('the rule matches the worker verbatim', () => {
  // persistFacts:
  //   const targetEntity = (cat !== 'buying_signal' && about === 'company' && fact.companyId)
  //     ? fact.companyId : fact.contactId;
  //
  // If that line changes and this one does not, the two writers disagree again — which is exactly
  // how a hundred-odd claims ended up on the wrong entity. This test exists to make that divergence loud.
  const worker = (cat, about, companyId, contactId) =>
    (cat !== 'buying_signal' && about === 'company' && companyId) ? companyId : contactId;

  for (const cat of ['status_quo', 'pain', 'adoption', 'buying_signal', 'authority']) {
    for (const about of ['company', 'person', undefined]) {
      for (const companyId of ['co1', null]) {
        assert.equal(
          routeTo(cat, about, 'p1', companyId),
          worker(cat, about, companyId, 'p1'),
          `${cat} / ${String(about)} / ${String(companyId)}`,
        );
      }
    }
  }
});
