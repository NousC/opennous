// "Needs attention" could not see the customer.
//
// buildPortfolio computed attention bands from deal health, days quiet, open objections,
// competitors and re-engagement flags — every one of them a sales signal. It could tell you a deal
// had gone quiet. It could not tell you the customer said they were frustrated, that their champion
// had left, or that you had promised them something on Tuesday and not done it.
//
// Two attention systems that disagree is worse than one that is incomplete, so this extends the one
// that exists rather than adding a second. These tests pin what the new fields count, and — as much
// — what they deliberately do not.
//
// Run: node --test apps/api/tests/portfolioAttention.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPortfolio, PORTFOLIO_METRIC_DEFS } from '../src/lib/portfolio.mjs';

const DAY = 86_400_000;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();

/** A Supabase stub that answers each table from a fixture. */
function db(fx) {
  const make = (table) => {
    const q = {
      select: () => q, eq: () => q, in: () => q, is: () => q, like: () => q,
      gte: () => q, not: () => q, or: () => q,
      limit: () => Promise.resolve({ data: fx[table] ?? [], error: null }),
      then: (res) => res({ data: fx[table] ?? [], error: null }),
    };
    return q;
  };
  return { from: make };
}

const BASE = {
  contacts: [{ id: 'p1', company_id: 'c1', pipeline_stage: 'evaluating', last_activity_at: ago(3) }],
  companies: [{ id: 'c1', name: 'Acme', domain: 'acme.com', deal_health_score: 85, icp_score: 70 }],
  flags: [], observations: [], claims: [],
};

const acct = async (fx) => (await buildPortfolio(db({ ...BASE, ...fx }), 'ws')).accounts[0];

test('a live churn risk is counted, and a healthy deal score no longer hides it', async () => {
  const a = await acct({
    claims: [{ entity_id: 'c1', value: { category: 'risk_signal', content: 'They are frustrated', metadata: { severity: 'at_risk', occurred_at: ago(10) } } }],
  });
  assert.equal(a.open_risks, 1);
  assert.equal(a.health, 85, 'deal health is untouched — this is a second reading, not a replacement');
});

test('a risk outside its window is history, not attention', async () => {
  // 120 days, the same window accountHealthState uses. A list carrying January's churn scare in
  // June is a list people stop reading.
  const a = await acct({
    claims: [{ entity_id: 'c1', value: { category: 'risk_signal', content: 'Old scare', metadata: { severity: 'at_risk', occurred_at: ago(200) } } }],
  });
  assert.equal(a.open_risks, 0);
});

test('the category counts, not the tag: a Noema-extracted cancellation with no tag is a risk', async () => {
  // GET-402. A risk Noema pulls out of a Gmail thread carries `severity` and no `signal_type`;
  // a pre-GET-401 row in a workspace the backfill has not reached carries the tag and category
  // `pain`. The list reads the category, so the first counts and the second no longer does — the
  // backfill is what moves it, and it says so when run.
  const a = await acct({
    claims: [
      { entity_id: 'c1', value: { category: 'risk_signal', content: 'Moving to another vendor at renewal', metadata: { severity: 'stated_churn', occurred_at: ago(3) } } },
      { entity_id: 'c1', value: { category: 'pain', content: 'Old shape', metadata: { signal_type: 'health_risk', occurred_at: ago(3) } } },
    ],
  });
  assert.equal(a.open_risks, 1);
});

test('a departure counts; a new hire and a reorg do not', async () => {
  const claim = (change) => ({ entity_id: 'c1', value: { category: 'staff_change', content: 'x', metadata: { change, occurred_at: ago(5) } } });
  assert.equal((await acct({ claims: [claim('left')] })).departures, 1);
  for (const c of ['joined', 'moved', 'reorg']) {
    assert.equal((await acct({ claims: [claim(c)] })).departures, 0, `${c} is not churn`);
  }
});

test('what WE owe is counted; what THEY owe is not our follow-up', async () => {
  const a = await acct({
    observations: [
      { entity_id: 'c1', value: { status: 'open', owner_kind: 'user', title: 'Send the CSV mapping fix' } },
      { entity_id: 'c1', value: { status: 'open', owner_kind: 'prospect', title: 'Send us credentials' } },
      { entity_id: 'c1', value: { status: 'done', owner_kind: 'user', title: 'Already sent' } },
    ],
  });
  assert.equal(a.commitments_owed, 1);
});

test('overdue is a subset of owed, by the stated date', async () => {
  const a = await acct({
    observations: [
      { entity_id: 'c1', value: { status: 'open', owner_kind: 'user', title: 'Late', due_at: ago(2) } },
      { entity_id: 'c1', value: { status: 'open', owner_kind: 'user', title: 'Not yet', due_at: new Date(Date.now() + 5 * DAY).toISOString() } },
      { entity_id: 'c1', value: { status: 'open', owner_kind: 'user', title: 'No date' } },
    ],
  });
  assert.equal(a.commitments_owed, 3);
  assert.equal(a.commitments_overdue, 1, 'no due date is not overdue — it is undated, and inventing a deadline is worse than none');
});

test('every new field is defined for the model that reads it', async () => {
  // The portfolio ships its own semantic layer so the agent reasons correctly. A field with no
  // definition is a number the model will interpret however it likes.
  for (const k of ['open_risks', 'departures', 'commitments_owed', 'commitments_overdue']) {
    assert.ok(PORTFOLIO_METRIC_DEFS[k], `${k} has no definition`);
  }
});

test('a promise made on three calls is one repeated commitment, not three', async () => {
  // Counting rows would make one unkept promise look like three problems, and sort the account
  // above one that genuinely has three.
  const a = await acct({
    observations: [
      { entity_id: 'c1', value: { status: 'done', owner_kind: 'user', title: 'Send the CSV mapping fix', recorded_at: ago(90) } },
      { entity_id: 'c1', value: { status: 'open', owner_kind: 'user', title: 'Send over the CSV mapping fix', recorded_at: ago(40) } },
      { entity_id: 'c1', value: { status: 'open', owner_kind: 'user', title: 'Sending the CSV mapping fix to them', recorded_at: ago(5) } },
    ],
  });
  assert.equal(a.commitments_repeated, 1);
  assert.equal(a.commitments_owed, 2, 'owed still counts the open rows — the two measures answer different questions');
});

test('recurrence counts closed promises too; owed deliberately does not', async () => {
  // A promise we marked done and then made again is the worst version of this. If recurrence
  // only read open rows it would miss exactly that, which is when it matters most.
  const a = await acct({
    observations: [
      { entity_id: 'c1', value: { status: 'done', owner_kind: 'user', title: 'Fix the mobile layout', recorded_at: ago(120) } },
      { entity_id: 'c1', value: { status: 'done', owner_kind: 'user', title: 'Fix the mobile layout', recorded_at: ago(20) } },
    ],
  });
  assert.equal(a.commitments_repeated, 1);
  assert.equal(a.commitments_owed, 0, 'nothing is outstanding, and yet we promised the same thing twice');
});

test('a promise repeated sorts above one that is merely late', async () => {
  // Late is a scheduling problem. Said-again is the customer telling you a second time that you
  // did not do the thing.
  const { accounts } = await buildPortfolio(db({
    ...BASE,
    contacts: [
      { id: 'p1', company_id: 'c1', pipeline_stage: 'evaluating', last_activity_at: ago(3) },
      { id: 'p2', company_id: 'c2', pipeline_stage: 'evaluating', last_activity_at: ago(3) },
    ],
    companies: [
      { id: 'c1', name: 'Repeater', domain: 'a.com', deal_health_score: 85 },
      { id: 'c2', name: 'Merely late', domain: 'b.com', deal_health_score: 85 },
    ],
    observations: [
      { entity_id: 'c1', value: { status: 'open', owner_kind: 'user', title: 'Send the CSV mapping fix', recorded_at: ago(60) } },
      { entity_id: 'c1', value: { status: 'open', owner_kind: 'user', title: 'Send the CSV mapping fix again', recorded_at: ago(5) } },
      { entity_id: 'c2', value: { status: 'open', owner_kind: 'user', title: 'Send the pricing sheet', due_at: ago(30), recorded_at: ago(40) } },
    ],
  }), 'ws');
  assert.equal(accounts[0].name, 'Repeater');
});

test('commitments_repeated is defined for the model that reads it', async () => {
  assert.ok(PORTFOLIO_METRIC_DEFS.commitments_repeated);
});
