// The Intelligence files, read for the next action (GET-1042): which sections an account gets, the
// ids on its points, and that a reader without Intelligence is a reader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readIntelligence, sectionsOf, pickSections, wordsOf } from '../dist/context/intelligence.mjs';
import { intelligenceFor, intelligenceRefs, registerIntelligenceSource } from '../dist/intelligenceContext.mjs';

const WS = 'w1';
const ACME = 'c1';

const objectionsDoc = {
  sections: [
    { id: 'preamble', heading: '', level: 0, blocks: [{ id: 'bpre', text: '# Objection playbook' }] },
    { id: 'eu-data-hosting', heading: 'EU data hosting', level: 2, blocks: [
      { id: 'b11111111', text: 'Raised by 4 accounts. Our answer: Frankfurt region, signed DPA. Moved 2 deals.' },
    ] },
    { id: 'price-too-high', heading: 'Price too high', level: 2, blocks: [
      { id: 'b22222222', text: 'Answered with the per-seat breakdown; worked when the champion owned budget.' },
    ] },
  ],
};
const winLossBody = '# Win/loss\n\n## Why we win\n\nFounders who sell themselves close in two calls.\n\n## Why we lose\n\nNo CRM owner on their side.\n';

/** A Supabase stand-in: each table is rows, and the query methods filter them. */
function fakeDb(tables) {
  return {
    from(name) {
      let rows = [...(tables[name] ?? [])];
      const q = {
        select() { return q; },
        eq(col, v) { rows = rows.filter(r => pick(r, col) === v); return q; },
        in(col, vs) { rows = rows.filter(r => vs.includes(pick(r, col))); return q; },
        is(col, v) { rows = rows.filter(r => (r[col] ?? null) === v); return q; },
        like(col, pat) { const p = pat.replace('%', ''); rows = rows.filter(r => String(r[col]).startsWith(p)); return q; },
        limit() { return q; },
        maybeSingle() { return Promise.resolve({ data: rows[0] ?? null, error: null }); },
        then(res, rej) { return Promise.resolve({ data: rows, error: null }).then(res, rej); },
      };
      return q;
    },
  };
}
function pick(r, col) {
  const m = col.match(/^value->>(\w+)$/);
  return m ? r.value?.[m[1]] : r[col];
}

function world({ claims = [], icpBody = null } = {}) {
  return fakeDb({
    workspace_living_files: [
      { workspace_id: WS, key: 'objections', enabled: true, file_id: 'f-obj', doc: objectionsDoc },
      { workspace_id: WS, key: 'win_loss', enabled: true, file_id: 'f-wl', doc: null },
      { workspace_id: WS, key: 'battlecards', enabled: false, file_id: 'f-bc', doc: null },
    ],
    workspace_context_files: [
      { workspace_id: WS, id: 'f-obj', kind: 'reference', body: null },
      { workspace_id: WS, id: 'f-wl', kind: 'reference', body: winLossBody },
      ...(icpBody ? [{ workspace_id: WS, id: 'f-icp', kind: 'icp', body: icpBody }] : []),
    ],
    relationships: [{ workspace_id: WS, type: 'works_at', from_entity_id: 'p1', to_entity_id: ACME, valid_to: null }],
    claims,
    market_entities: [],
  });
}
const objection = (content, status = 'open', entity = 'p1') =>
  ({ workspace_id: WS, entity_id: entity, property: 'note.objection', invalid_at: null, value: { category: 'objection', content, metadata: { status } } });

test('an account gets the playbook sections for its open objections, with their ids', async () => {
  const out = await readIntelligence(world({ claims: [objection('They need EU data hosting before security signs off')] }), WS, { companyId: ACME });
  assert.match(out.text, /EU data hosting/);
  assert.match(out.text, /\[objections:b11111111\]/);
  assert.doesNotMatch(out.text, /Price too high/, 'a section nothing on the account raised is left out');
  assert.match(out.text, /Why we win/, 'win/loss is read from the top for every account');
  assert.deepEqual(out.used.find(u => u.key === 'objections'), { key: 'objections', section: 'eu-data-hosting', blocks: ['b11111111'] });
});

test('a resolved objection and our own side pick nothing', async () => {
  const ours = { ...objection('Price too high for the team'), value: { category: 'objection', content: 'Price too high', metadata: { side: 'ours' } } };
  const out = await readIntelligence(world({ claims: [objection('EU data hosting', 'resolved'), ours] }), WS, { companyId: ACME });
  assert.doesNotMatch(out.text, /\[objections:/);
});

test('a file that is off is never read', async () => {
  const out = await readIntelligence(world(), WS, {});
  assert.doesNotMatch(out.text, /Battlecards/);
  assert.match(out.text, /Price too high/, 'without an account the files are read whole');
});

test('the learned ICP block comes with it, without its markers', async () => {
  const icpBody = 'Our buyers are founders.\n\n<!-- nous:icp start -->\nA CRM owner on their side predicts a win.\n<!-- nous:icp end -->\n';
  const out = await readIntelligence(world({ icpBody }), WS, {});
  assert.match(out.text, /CRM owner on their side predicts a win/);
  assert.doesNotMatch(out.text, /nous:icp/);
  assert.doesNotMatch(out.text, /Our buyers are founders/, 'the ICP prose is the workspace\'s own words, read elsewhere');
});

test('the budget holds', async () => {
  const out = await readIntelligence(world(), WS, { budget: 600 });
  assert.ok(out.text.length <= 800, `${out.text.length} chars`);
});

test('a hand-edited body wins, keeping the ids of unchanged blocks', () => {
  const body = '# Objection playbook\n\n## EU data hosting\n\nRaised by 4 accounts. Our answer: Frankfurt region, signed DPA. Moved 2 deals.\n\nNew: the SOC 2 letter closes it.\n';
  const s = sectionsOf(objectionsDoc, body).find(x => x.heading === 'EU data hosting');
  assert.equal(s.blocks[0].id, 'b11111111');
  assert.match(s.blocks[1].id, /^h[0-9a-f]{8}$/);
  assert.equal(sectionsOf(objectionsDoc, body).find(x => x.heading === 'EU data hosting').blocks[1].id, s.blocks[1].id, 'the same text, the same id');
});

test('sections are matched on meaning words, not on filler', () => {
  const sections = sectionsOf(objectionsDoc, null);
  assert.deepEqual(pickSections(sections, [wordsOf('they would want this with some more')]), []);
  assert.equal(pickSections(sections, [wordsOf('pricing is fine but the price is too high')])[0].heading, 'Price too high');
});

test('the public hook: nothing registered, nothing read; a failing source is no Intelligence', async () => {
  registerIntelligenceSource(null);
  assert.equal(await intelligenceFor({}, WS, {}), null);
  registerIntelligenceSource(async () => { throw new Error('down'); });
  assert.equal(await intelligenceFor({}, WS, {}), null);
  registerIntelligenceSource(async () => ({ text: 'x [objections:b1] y [icp:learned]', used: [] }));
  const out = await intelligenceFor({}, WS, {});
  assert.deepEqual(intelligenceRefs(out.text), ['objections:b1', 'icp:learned']);
  registerIntelligenceSource(readIntelligence);
});
