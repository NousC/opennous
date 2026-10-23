// Claims about us (GET-969). The claim read sorted product feedback and market views out and threw
// them away, and a second read of the same transcript re-derived them. Now the one read keeps them,
// through the same quote check, with the fields an insight is counted on, and never on the account.
//
// Run: node --test apps/worker/tests/aboutUsClaims.test.mjs   (after tsc -p packages/core)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeFacts, splitAboutUs, markAboutUs, buildActivitySignalsPrompt, buildMeetingSignalsPrompt } from '../src/signals/index.mjs';
import { aboutUsRow, normalizeAboutUsKind, withoutRepeatedPoints, saveAboutUsClaims, featureRequestedEvent, featureRequestsFor, TRIGGER_EVENTS } from '@nous/core';

const text = r => (typeof r === 'string' ? r : r.prompt);

test('both prompts keep what they say about us, with a kind and the counting fields', () => {
  for (const p of [
    text(buildActivitySignalsPrompt({ contactName: 'Dana Reyes', type: 'meeting_held', summary: 't' })),
    buildMeetingSignalsPrompt({ roster: '1. Dana Reyes', transcript: 't', maxFacts: 8 }),
  ]) {
    assert.match(p, /WHAT THEY SAY ABOUT US IS KEPT TOO/);
    for (const f of ['"kind"', '"what"', '"use_case"', '"product_area"', '"asked_by"', '"job"']) assert.ok(p.includes(f), `${f} is asked for`);
    assert.match(p, /YOUR reading, not their words/);
  }
});

test('product feedback and market views come back as claims about us, low ones too; the account gets none of them', () => {
  const { claims, aboutUs, routed } = routeFacts([
    { home: 'claim', importance: 'high', content: 'Dana Reyes is moving support to Zendesk', category: 'tech_stack', what: 'stray' },
    { home: 'our_product', importance: 'low', content: 'Dana Reyes wants a date filter on the inbox', quote: 'a date filter', kind: 'feature', what: 'Date filter', product_area: 'Inbox' },
    { home: 'market', importance: 'medium', content: 'Dana Reyes thinks agents overclaim', quote: 'agents overclaim', kind: 'buyers' },
  ]);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].what, undefined, 'a claim about them never carries the about-us fields');
  assert.deepEqual(aboutUs.map(f => [f.home, f.kind, f.what ?? null]), [['our_product', 'feature', 'Date filter'], ['market', 'buyers', null]]);
  assert.equal(aboutUs[0].importance, undefined);
  assert.deepEqual(routed, { our_product: 1, market: 1, low_importance: 0 });
});

test('after grounding, a claim about us with no checked quote is dropped; a claim about them stays', () => {
  const { claims, aboutUs } = splitAboutUs([
    { content: 'a claim about them', quote: null },
    markAboutUs({ content: 'wants a date filter', quote: 'a date filter', kind: 'feature' }),
    markAboutUs({ content: 'made-up feedback', quote: null, kind: 'feature' }),
  ]);
  assert.deepEqual(claims.map(c => c.content), ['a claim about them']);
  assert.deepEqual(aboutUs.map(c => c.content), ['wants a date filter']);
  assert.equal(Object.getOwnPropertySymbols(aboutUs[0]).length, 0, 'the mark does not travel on');
});

test('kinds: the board ten plus praise; an unknown one falls back by home', () => {
  assert.equal(normalizeAboutUsKind('Feature request'), 'feature');
  assert.equal(normalizeAboutUsKind('competitor'), 'partners');
  assert.equal(normalizeAboutUsKind('praise'), 'praise');
  assert.equal(normalizeAboutUsKind('???'), 'feature');
  assert.equal(normalizeAboutUsKind(null, 'market'), 'buyers');
});

test('a row needs a sentence and a checked quote; the job stays apart from their words', () => {
  assert.equal(aboutUsRow('ws', { content: 'x', quote: null }), null);
  assert.equal(aboutUsRow('ws', { content: '', quote: 'y' }), null);
  const r = aboutUsRow('ws', { content: 'Wants a date filter', quote: 'a date filter', home: 'our_product', kind: 'request', job: 'Find last week\'s replies fast', companyId: 'co-1' },
    { sourceRef: 'source://granola/m1', sourceSystem: 'granola', occurredAt: '2026-10-01T10:00:00Z' });
  assert.equal(r.kind, 'feature');
  assert.equal(r.job, 'Find last week\'s replies fast');
  assert.equal(r.quote, 'a date filter');
  assert.equal(r.company_id, 'co-1');
  assert.equal(r.origin, 'claim_read');
});

test('a rewording of a point already filed from the same source, in the same kind, is not filed again', () => {
  const rows = [{ kind: 'feature' }, { kind: 'feature' }, { kind: 'bug' }, { kind: 'feature' }];
  const vecs = [[1, 0], [0.99, 0.05], [1, 0], [0, 1]];
  const kept = withoutRepeatedPoints(rows, vecs, [{ kind: 'feature', vec: [0, 1] }]);
  assert.deepEqual(kept.map(k => rows.indexOf(k.row)), [0, 2], 'the second repeats the first; the bug is another kind; the last repeats one on file');
});

test('a missing table or a failed write never throws: the account keeps its claims', async () => {
  const sb = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ limit: async () => ({ data: null, error: { code: '42P01', message: 'relation "public.about_us_claims" does not exist' } }) }) }) }) }) };
  assert.equal(await saveAboutUsClaims(sb, 'ws', [{ content: 'x', quote: 'y' }], { sourceRef: 'source://granola/m1' }), 0);
});

test('history: an insight item becomes a claim about us with its kind and its board tag as `what`', async () => {
  const { rowFromItem } = await import('../scripts/backfillAboutUsClaims.mjs');
  const base = { id: 'i1', workspace_id: 'ws', statement: 'Wants Slack alerts', quote: null, created_at: '2026-10-01T00:00:00Z' };
  assert.equal(rowFromItem({ ...base, category: 'product', subtype: null, sorted_at: '2026-10-02' }), null, 'the board sorted it out');
  const r = rowFromItem({ ...base, category: 'product', subtype: 'feature', company_id: 'co-1' }, 'Slack');
  assert.deepEqual([r.kind, r.home, r.what, r.origin, r.legacy_item_id, r.company_id], ['feature', 'our_product', 'Slack', 'insight_read', 'i1', 'co-1']);
  assert.equal(rowFromItem({ ...base, category: 'product', kind: 'bug' }).kind, 'bug', 'unsorted: its own kind');
  assert.deepEqual([rowFromItem({ ...base, category: 'market' }).kind, rowFromItem({ ...base, category: 'market' }).home], ['partners', 'market']);
});

test('history: words stay private unless the source is known to be shared', async () => {
  const { rowFromItem } = await import('../scripts/backfillAboutUsClaims.mjs');
  const base = { id: 'i1', workspace_id: 'ws', category: 'product', statement: 'Wants Slack alerts', quote: 'q', created_at: '2026-10-01T00:00:00Z' };
  const priv = (it) => rowFromItem({ ...base, ...it }).quote_private;
  assert.equal(priv({ source_system: 'fellow', source_ref: 'source://fellow/m1' }), false, 'a meeting');
  assert.equal(priv({ source_system: 'gmail', source_ref: 'source://gmail/t1' }), true, 'a mailbox');
  assert.equal(priv({ source_system: null, source_ref: null }), true, 'unknown source');
  assert.equal(priv({ source_system: 'slack', source_ref: 'source://slack/T1/C123/hour-1/f1' }), false, 'a channel');
  assert.equal(priv({ source_system: 'slack', source_ref: 'source://slack/T1/D123/hour-1/f1' }), true, 'a DM');
  assert.equal(priv({ source_system: 'slack', source_ref: 'source://slack/T1/G123/hour-1/f1' }), true, 'a group DM');
});

test('a LinkedIn DM thread is private and has an identity, and our own "You:" lines are not theirs', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/signals/index.mjs', import.meta.url), 'utf8');
  const call = src.slice(src.indexOf("type:       'conversation_thread'"), src.indexOf("type:       'conversation_thread'") + 600);
  assert.match(call, /quotePrivate: true/);
  assert.match(call, /aboutUsRef: `thread:\/\//);
  assert.match(call, /ourNames: \['You'\]/);
});

// Feature requests: an event when one is heard, and a list on the account and the person.
const featureRow = (extra = {}) => ({ id: 'auc-1', kind: 'feature', company_id: 'co-1', contact_id: 'p-1', what: 'Built-in call recording',
  content: 'Dana Reyes wants us to record their sales calls ourselves', quote: 'do your own recorder', quote_private: false,
  speaker: 'Dana Reyes', use_case: 'drop their other recorders', source_ref: 'source://slack/c1', source_system: 'slack', occurred_at: '2026-10-22T18:00:00Z', ...extra });

test('a feature heard is a signal.feature_requested event, once per row, on the account and the person', () => {
  assert.ok(TRIGGER_EVENTS.includes('signal.feature_requested'), 'a webhook can subscribe to it');
  const ev = featureRequestedEvent(featureRow());
  assert.deepEqual([ev.type, ev.accountId, ev.personId, ev.dedupeKey, ev.occurredAt], ['signal.feature_requested', 'co-1', 'p-1', 'auc-1', '2026-10-22T18:00:00Z']);
  assert.equal(ev.data.title, 'Built-in call recording');
  assert.equal(ev.data.quote, 'do your own recorder');
  // Words from a private message stay out of the event; other kinds and rows on nobody fire nothing.
  assert.equal(featureRequestedEvent(featureRow({ quote_private: true })).data.quote, null);
  assert.equal(featureRequestedEvent(featureRow({ kind: 'bug' })), null);
  assert.equal(featureRequestedEvent(featureRow({ company_id: null, contact_id: null })), null);
});

test('the account lists its feature requests newest first, without the words of a private message', async () => {
  const calls = [];
  const rows = [featureRow(), featureRow({ id: 'auc-2', quote_private: true, quote: 'secret words' })];
  const q = { select: (...a) => { calls.push(['select', ...a]); return q; }, eq: (...a) => { calls.push(['eq', ...a]); return q; },
    is: (...a) => { calls.push(['is', ...a]); return q; }, order: () => q, limit: async () => ({ data: rows, error: null }) };
  const out = await featureRequestsFor({ from: () => q }, 'ws', { companyId: 'co-1' });
  assert.deepEqual(out.map(r => [r.id, r.quote]), [['auc-1', 'do your own recorder'], ['auc-2', null]]);
  assert.ok(calls.some(c => c[0] === 'eq' && c[1] === 'kind' && c[2] === 'feature'));
  assert.ok(calls.some(c => c[0] === 'eq' && c[1] === 'company_id' && c[2] === 'co-1'));
  assert.ok(calls.some(c => c[0] === 'is' && c[1] === 'retired_at'));
  assert.deepEqual(await featureRequestsFor({ from: () => q }, 'ws', {}), []);
});
