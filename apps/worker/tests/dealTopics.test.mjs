// A newer statement retires the one it replaces even when they are filed under different deal
// topics (found re-sorting a real account, 2026-10-08): "ready to present it to the other
// stakeholders" (buying_signal, on the person) never met "needs another couple of months"
// (timeline), "not there yet" (objection) or "still deciding internally" (blocker), because the
// merge compared a new fact only with live facts of its own category on its own record.
//
// Run: node --test apps/worker/tests/dealTopics.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relatedCategories, pickTopicCandidates, buildMergePrompt } from '../src/signals/index.mjs';

test('the deal topics meet each other; other categories only meet themselves', () => {
  for (const k of ['buying_signal', 'timeline', 'objection', 'blocker', 'budget', 'requirement']) {
    assert.deepEqual([...relatedCategories(k)].sort(), ['blocker', 'budget', 'buying_signal', 'objection', 'requirement', 'timeline']);
  }
  assert.deepEqual(relatedCategories('tech_stack'), ['tech_stack']);
  assert.deepEqual(relatedCategories('pain'), ['pain']);
});

const note = (id, category, said_at, entity_id = 'p-dana') => ({ id, category, content: `${id} content`, said_at, entity_id, intel: true, metadata: {} });

test('candidates come from the person AND the company, across the deal topics, newest first, capped', () => {
  const notes = [
    note('timeline-sep29', 'timeline', '2026-09-29T15:00:00Z', 'co-acme'),
    note('objection-sep29', 'objection', '2026-09-29T15:00:00Z', 'p-dana'),
    note('blocker-sep29', 'blocker', '2026-09-29T15:00:00Z', 'co-acme'),
    note('stack', 'tech_stack', '2026-10-01T00:00:00Z', 'co-acme'),
    note('doc', 'blocker', '2026-10-01T00:00:00Z', 'co-acme'),
  ];
  notes[4].metadata = { doc_type: 'meeting_notes' };
  const got = pickTopicCandidates(notes, 'buying_signal', 8).map(c => c.id);
  assert.deepEqual(got.sort(), ['blocker-sep29', 'objection-sep29', 'timeline-sep29']);
  const many = Array.from({ length: 20 }, (_, i) => note(`t${i}`, 'timeline', `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00Z`));
  const capped = pickTopicCandidates(many, 'objection', 8);
  assert.equal(capped.length, 8);
  assert.equal(capped[0].id, 't19', 'newest first');
});

test('the merge prompt shows a cross-topic replacement as the example', () => {
  const p = buildMergePrompt([{ fact: 'x', category: 'buying_signal', saidAt: '2026-10-07T00:00:00Z', candidates: [{ id: 'a', content: 'y', said_at: '2026-09-29T00:00:00Z', category: 'timeline' }] }]);
  assert.match(p, /different topic/i);
  assert.match(p, /ready to take it to the other stakeholders/i);
});
