// Our side's words as their own facts (GET-1052): our replies, commitments and pitch lines are
// stored as note.* claims with metadata.side = 'ours' and an our-side category, and NO buyer reader
// sees them — not listNotes / listAccountNotes (the account page, get_account, deal health, the
// brief), not the Intel taxonomy, not the facts search, and not the insight engine (founder's call:
// not in Insights for now).
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/ourSideClaims.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OUR_SIDE, OUR_SIDE_CATEGORIES, OUR_SIDE_CATEGORY_KEYS, CLAIM_CATEGORY_KEYS, ACCOUNT_ROLLUP_CATEGORIES,
  isOurSideClaim, isOurSideCategory, normalizeOurSideCategory, normalizeClaimCategory, isIntelClaim,
  claimCategoryPromptBlock, claimCategoryLabel, ourSidePromptBlock,
} from '../dist/db/claimCategories.js';
import { listAccountNotes, listNotes } from '../dist/db/notes.js';
import { loadMembers } from '../dist/db/insightEngine.js';

test('the three our-side categories are their own group, outside the buyer taxonomy', () => {
  assert.deepEqual(OUR_SIDE_CATEGORY_KEYS, ['our_reply', 'our_commitment', 'pitch_line']);
  assert.ok(OUR_SIDE_CATEGORIES.every(c => c.group === 'our_side'));
  for (const k of OUR_SIDE_CATEGORY_KEYS) {
    assert.ok(!CLAIM_CATEGORY_KEYS.includes(k), `${k} is not a buyer category`);
    assert.ok(!ACCOUNT_ROLLUP_CATEGORIES.includes(k), `${k} never rolls up to the account as a deal fact`);
    // The buyer extractor's category list never offers it.
    assert.ok(!claimCategoryPromptBlock().includes(`- ${k} —`), `${k} is not in the buyer category block`);
    // Read back, it stays itself: as `general` our pitch would read as a buyer fact.
    assert.equal(normalizeClaimCategory(k), k);
  }
  assert.equal(claimCategoryLabel('our_reply'), 'Our reply');
  assert.match(ourSidePromptBlock(), /^- our_reply — /m);
  assert.match(ourSidePromptBlock(), /^- commitment — /m);
});

test('"commitment" outside the our_side home still means the buyer\'s buying signal', () => {
  // Why the stored key is our_commitment: a stored "commitment" would be normalised to buying_signal
  // by every reader that normalises a raw category, and advance the deal stage.
  assert.equal(normalizeClaimCategory('commitment'), 'buying_signal');
  assert.equal(normalizeOurSideCategory('commitment'), 'our_commitment');
  assert.equal(normalizeOurSideCategory('pitch'), 'pitch_line');
  assert.equal(normalizeOurSideCategory('our_reply'), 'our_reply');
  assert.equal(normalizeOurSideCategory('objection'), null);
  assert.equal(isOurSideCategory('commitment'), false);
});

test('isOurSideClaim answers on either mark; an our-side claim is never intel', () => {
  assert.equal(isOurSideClaim({ category: 'pitch_line', content: 'x', metadata: {} }), true);
  assert.equal(isOurSideClaim({ category: 'objection', content: 'x', metadata: { side: OUR_SIDE } }), true);
  assert.equal(isOurSideClaim({ category: 'objection', content: 'x', metadata: {} }), false);
  assert.equal(isOurSideClaim(null), false);
  assert.equal(isIntelClaim({ category: 'our_reply', content: 'Answered the price concern with the annual discount.', metadata: { side: OUR_SIDE } }), false);
  assert.equal(isIntelClaim({ category: 'objection', content: 'Ines Halloran finds the price high.', metadata: {} }), true);
});

// ── The readers ──────────────────────────────────────────────────────────────

const CO = 'co-brindle', INES = 'p-ines';
const claim = (id, entity_id, category, content, metadata = {}, valid_from = '2026-10-20T10:00:00Z') => ({
  id, workspace_id: 'ws', entity_id, property: `note.${id}`,
  value: { category, content, source: 'signal_extraction', metadata },
  confidence: 1, valid_from, computed_at: valid_from, invalid_at: null, supporting_observation_ids: [], embedding: null,
});
const ours = { side: OUR_SIDE, about: 'company', quote: 'q', speaker: 'Theo Bramwell' };
const ROWS = [
  claim('b1', CO, 'objection', 'Brindle finds the per-seat price high.', { about: 'company', status: 'open' }),
  claim('b2', INES, 'objection', 'Ines Halloran doubts the HubSpot sync.', { status: 'open' }),
  claim('o1', CO, 'our_reply', 'Answered the price concern with the annual discount.', { ...ours, answers: 'Per-seat price' }),
  claim('o2', CO, 'our_commitment', 'Promised to send the security doc by Friday, October 23, 2026.', { ...ours, fact_kind: 'event', occurred_start: '2026-10-23' }),
  claim('o3', CO, 'pitch_line', 'Framed the product as replacing two tools.', ours),
  // Belt and braces: the side flag alone keeps it out, whatever category it carries.
  claim('o4', INES, 'objection', 'Our guess that Ines would find $700 expensive.', { ...ours }),
];

function fakeSupabase(rows = ROWS) {
  return {
    from(table) {
      const f = [];
      const val = (r, col) => {
        if (col === 'value->>category') return r.value?.category;
        if (col === 'value->>source') return r.value?.source;
        const m = col.match(/^value->metadata->>(\w+)$/);
        if (m) return r.value?.metadata?.[m[1]] ?? null;
        return r[col];
      };
      const q = {
        select() { return q; },
        eq(col, v) { f.push(r => val(r, col) === v); return q; },
        not(col, op, v) { f.push(r => (op === 'is' ? val(r, col) !== v : val(r, col) !== v)); return q; },
        like(col, pat) { const p = pat.replace('%', ''); f.push(r => String(val(r, col)).startsWith(p)); return q; },
        gte(col, v) { f.push(r => String(val(r, col)) >= v); return q; },
        lt(col, v) { f.push(r => String(val(r, col)) < v); return q; },
        is(col, v) { f.push(r => (val(r, col) ?? null) === v); return q; },
        in(col, vs) { f.push(r => vs.includes(val(r, col))); return q; },
        or() { return q; },
        order() { return q; },
        range() { return q; },
        limit() { return q; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        then(res, rej) {
          const data = table === 'claims' ? rows.filter(r => f.every(fn => fn(r))) : [];
          return Promise.resolve({ data, error: null }).then(res, rej);
        },
      };
      return q;
    },
  };
}

test('listNotes drops our side by default; the Intelligence files opt in', async () => {
  const buyer = await listNotes(fakeSupabase(), 'ws', { entityIds: [CO, INES] });
  assert.deepEqual(buyer.map(n => n.id).sort(), ['b1', 'b2']);
  const all = await listNotes(fakeSupabase(), 'ws', { entityIds: [CO, INES], includeOurSide: true });
  assert.deepEqual(all.map(n => n.id).sort(), ['b1', 'b2', 'o1', 'o2', 'o3', 'o4']);
  const reply = all.find(n => n.id === 'o1');
  assert.equal(reply.category, 'our_reply', 'read back as its own category, not general');
  assert.equal(reply.intel, false);
});

test('the account record (deal health, get_account, the brief) never reads our side as a buyer fact', async () => {
  const notes = await listAccountNotes(fakeSupabase(), 'ws', CO, [INES]);
  assert.deepEqual(notes.map(n => n.id).sort(), ['b1', 'b2']);
});

test('the insight engine counts the buyer\'s objections and never ours', async () => {
  const members = await loadMembers(fakeSupabase(), 'ws');
  const ids = members.filter(m => m.table === 'claims').map(m => m.id).sort();
  assert.deepEqual(ids, ['b1', 'b2']);
});
