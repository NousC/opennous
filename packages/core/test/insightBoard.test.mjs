// The Insights board: every insight under exactly one button, tagged from the workspace's own list,
// tied to its account. These are the rules that keep the page explainable.
//
// Run: node --test packages/core/test/insightBoard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INSIGHT_SUBTYPES, BOARD_LANES, laneOfSubtype, isInsightSubtype, rowNeedsSummary,
  parseSortAnswer, parseRowSummary, parseTagList, observationRefPattern, buildSortPrompt,
} from '../dist/db/insightBoard.js';
import { insightItemDedupKey } from '../dist/db/insights.js';

test('ten buttons, each in exactly one lane, and every lane has at least two', () => {
  assert.equal(INSIGHT_SUBTYPES.length, 10);
  assert.equal(new Set(INSIGHT_SUBTYPES.map((s) => s.key)).size, 10);
  for (const lane of BOARD_LANES) {
    assert.ok(INSIGHT_SUBTYPES.filter((s) => s.lane === lane.key).length >= 2, lane.key);
  }
  assert.equal(laneOfSubtype('training'), 'success');
  assert.equal(laneOfSubtype('pricing'), 'sales');
  assert.equal(laneOfSubtype('nope'), null);
  assert.equal(isInsightSubtype('bug'), true);
  assert.equal(isInsightSubtype('issue'), false);
});

test('the migration and the code agree on the ten keys', async () => {
  const { readFileSync } = await import('node:fs');
  const sql = readFileSync(new URL('../../../supabase/migrations/2026_09_24_insight_board.sql', import.meta.url), 'utf8');
  for (const s of INSIGHT_SUBTYPES) assert.ok(sql.includes(`'${s.key}'`), `migration is missing ${s.key}`);
  for (const l of BOARD_LANES) assert.ok(sql.includes(`'${l.key}'`), `migration is missing lane ${l.key}`);
});

test('a sort answer keeps only real buttons and tags that are on the list', () => {
  const answer = JSON.stringify({ items: [
    { i: 0, b: 'bug', tags: ['kiosk mode', 'Made Up Tag'], new_tag: null },
    { i: 1, b: 'product issue', tags: ['Kiosk mode'] },          // not a button: left unplaced
    { i: 1, b: 'training', tags: [] , new_tag: 'Rep training' },
    { i: 0, b: 'feature', tags: ['CRM integration'] },         // a second answer for 0 is ignored
    { i: 9, b: 'bug', tags: [] },                              // outside the batch
  ] });
  const out = parseSortAnswer(`Here you go:\n${answer}`, 3, ['Kiosk mode', 'CRM integration']);
  assert.deepEqual(out[0], { subtype: 'bug', tags: ['Kiosk mode'], newTag: null });
  assert.deepEqual(out[1], { subtype: 'training', tags: [], newTag: 'Rep training' });
  assert.equal(out[2], null, 'a statement the model skipped stays unplaced, never guessed');
  assert.equal(parseSortAnswer('not json', 3, []), null, 'unreadable is null, not "nothing found"');
});

test('a row summary cannot put one statement into two problems, and drops out-of-range numbers', () => {
  const s = parseRowSummary(JSON.stringify({
    headline: 'Kiosk mode freezes at sign-in in the store.',
    problems: [
      { title: 'Sign-in freezes', detail: 'x', items: [0, 1, 7] },
      { title: 'Provisioning is manual', detail: 'y', items: [1, 2] },
      { title: 'Empty', detail: 'z', items: [0] },
    ],
    receipts: [2, 2, 0, 5],
  }), 3);
  assert.deepEqual(s.problems.map((p) => p.items), [[0, 1], [2]]);
  assert.deepEqual(s.receipts, [2, 0]);
  assert.equal(parseRowSummary('{"problems":[]}', 3), null, 'no headline, no summary');
});

test('a tag list drops blanks and case-duplicates', () => {
  const t = parseTagList('{"tags":[{"name":"Kiosk mode","definition":"d","aliases":["kiosk"]},{"name":"kiosk MODE"},{"name":"  "}]}');
  assert.deepEqual(t.map((x) => x.name), ['Kiosk mode']);
});

test('summaries are rewritten when the story changes, not on every insight', () => {
  assert.equal(rowNeedsSummary(0, 3), true);
  assert.equal(rowNeedsSummary(10, 11), false);
  assert.equal(rowNeedsSummary(10, 13), true);
  assert.equal(rowNeedsSummary(40, 44), false, 'four more on forty is not a new story');
});

test("a Fellow insight finds its call's per-attendee observations", () => {
  assert.deepEqual(observationRefPattern('source://fellow/Zm4KpTq7Rw'),
    { eq: 'source://fellow/Zm4KpTq7Rw', like: 'source://fellow/%Zm4KpTq7Rw%' });
  // Fireflies action items wrap the id twice over; the pattern must still reach them.
  const { like } = observationRefPattern('source://fireflies/01HX7JK2LM4NP6TV8ST0UV2WXY');
  const re = new RegExp('^' + like.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/%/g, '.*') + '$');
  assert.ok(re.test('source://fireflies/action_item_fireflies_01HX7JK2LM4NP6TV8ST0UV2WXY_10'));
  assert.ok(!re.test('source://fathom/action_item_fireflies_01HX7JK2LM4NP6TV8ST0UV2WXY_10'), 'never another tool');
  assert.deepEqual(observationRefPattern('not a ref'), { eq: 'not a ref', like: null });
});

test('the same sentence from two different calls is two insights; the same call twice is one', () => {
  const a = insightItemDedupKey('external', 'product', 'Kiosk mode freezes at sign-in', 'source://fellow/A');
  const b = insightItemDedupKey('external', 'product', 'Kiosk mode freezes at sign-in', 'source://fellow/B');
  const a2 = insightItemDedupKey('external', 'product', 'Kiosk mode freezes at sign-in', 'source://fellow/A');
  assert.notEqual(a, b);
  assert.equal(a, a2);
  // Rows written before refs existed keep the key they were stored under.
  assert.equal(insightItemDedupKey('external', 'product', 'x y z'), insightItemDedupKey('external', 'product', 'x y z', null));
});

test('the sort prompt offers every button and the tag list', () => {
  const p = buildSortPrompt([{ statement: 'Kiosk freezes', quote: 'it just sits on the spinner' }], [{ name: 'Kiosk mode', definition: 'in-store tablets', aliases: ['kiosk'] }]);
  for (const s of INSIGHT_SUBTYPES) assert.ok(p.includes(`- ${s.key} (`), s.key);
  assert.ok(p.includes('- Kiosk mode: in-store tablets (also: kiosk)'));
});
