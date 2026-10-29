// Intelligence freshness (GET-1055): "behind by N", count + trend + quote under every point, and a
// retraction pass when a cited item is retired.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);
const { trendOf, evidenceOf, evidenceLine, stampDoc, stripDoc, stripEvidence, resolveRefs, restrictRetraction, checkCited, behindOf, buildRetractionPrompt, carryCites } = await import('../src/lib/livingEvidence.mjs');
const { parseDoc, renderDoc, parseOps, applyOps } = await import('../src/lib/livingDoc.mjs');
const { seedBody, runLivingFile, listLivingFiles } = await import('../src/lib/livingFiles.mjs');

// The same in-memory PostgREST stand-in as livingFiles.test.mjs ('value->>category' reads a JSON field).
const get = (r, k) => (k.includes('->>') ? r[k.split('->>')[0]]?.[k.split('->>')[1]] : r[k]);
function db(seed) {
  const tables = { workspace_context_file_versions: [], workspace_context_repos: [], ...structuredClone(seed) };
  class Q {
    constructor(t) { this.t = t; this.f = []; this.lim = Infinity; }
    select() { return this; } order() { return this; } limit(n) { this.lim = n; return this; }
    eq(k, v) { this.f.push(r => get(r, k) === v); return this; }
    is(k, v) { this.f.push(r => (r[k] ?? null) === v); return this; }
    in(k, vs) { this.f.push(r => vs.includes(r[k])); return this; }
    gt(k, v) { this.f.push(r => String(get(r, k)) > String(v)); return this; }
    lte(k, v) { this.f.push(r => String(get(r, k)) <= String(v)); return this; }
    like(k, p) { const re = new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`); this.f.push(r => re.test(r[k] ?? '')); return this; }
    insert(v) { this.op = 'insert'; this.v = v; return this; }
    update(v) { this.op = 'update'; this.v = v; return this; }
    run(one) {
      const all = (tables[this.t] ??= []);
      let rows = all.filter(r => this.f.every(f => f(r))).slice(0, this.lim);
      if (this.op === 'insert') { const r = { id: `${this.t}-${all.length + 1}`, created_at: new Date(Date.now() + all.length).toISOString(), ...this.v }; all.push(r); rows = [r]; }
      if (this.op === 'update') rows.forEach(r => Object.assign(r, this.v));
      return { data: structuredClone(one ? rows[0] ?? null : rows), error: null };
    }
    maybeSingle() { return Promise.resolve(this.run(true)); } single() { return this.maybeSingle(); }
    then(a, b) { return Promise.resolve(this.run(false)).then(a, b); }
  }
  return { tables, from: t => new Q(t) };
}
const reply = (x) => ({ model: 'm', usage: {}, content: [{ type: 'text', text: typeof x === 'string' ? x : JSON.stringify(x) }] });
function seq(...replies) {
  const calls = [];
  const fn = async (o) => { calls.push(o.messages); if (calls.length > replies.length) throw new Error('called too often'); return reply(replies[calls.length - 1]); };
  fn.calls = calls;
  return fn;
}

const NOW = new Date('2026-10-27T12:00:00Z');
const ago = (d) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

test('trend: stale, new, strengthening, weakening, steady over the 30- and 90-day windows', () => {
  // [ages in days, trend]. Past 30 days vs the 60 before: ratio = (r/30)/(p/60) = 2r/p.
  const table = [
    [[], 'stale'],
    [[100, 200], 'stale'],                        // none in the last 90 days
    [[1, 5, 29], 'new'],                          // all within 30
    [[1, 2, 3, 40], 'strengthening'],             // 2*3/1 = 6
    [[5, 120], 'strengthening'],                  // recent, the rest older than 90: no prior density
    [[40, 50, 60], 'weakening'],                  // none recent: 0
    [[10, 40, 50, 60, 70, 80], 'weakening'],      // 2*1/5 = 0.4
    [[10, 40, 50, 60, 70], 'steady'],             // 2*1/4 = 0.5, not below
    [[1, 2, 3, 40, 50, 60, 70], 'steady'],        // 2*3/4 = 1.5, not above
    [[10, 40, 50], 'steady'],                     // 2*1/2 = 1
  ];
  for (const [ages, want] of table) assert.equal(trendOf(ages.map(ago), NOW), want, `${ages.join(',')} -> ${want}`);
});

test('the evidence line: count, trend, newest date and one exact quote, the newest that has one', () => {
  const sources = { c1: { at: ago(2), quote: null }, c2: { at: ago(10), quote: 'We cannot   justify\nthe seat price.' }, c3: { at: ago(40), quote: 'Too pricey.' } };
  const ev = evidenceOf(['c1', 'c2', 'c3', 'c9'], sources, NOW);
  assert.deepEqual(ev, { n: 3, trend: 'strengthening', last: '2026-10-25', quote: 'We cannot justify the seat price.' }, 'an unknown id is not counted; whitespace in the quote is collapsed');
  assert.equal(evidenceLine(ev), '> ×3, strengthening, last 2026-10-25 · "We cannot justify the seat price."');
  assert.equal(evidenceOf(['c9'], sources, NOW), null);
  assert.match(evidenceLine(evidenceOf(['c1'], { c1: { at: ago(1), quote: 'x'.repeat(300) } }, NOW)), /"x{159}…"$/);
});

test('stamping is byte-stable: the same numbers write the same bytes, new numbers rewrite only that line', () => {
  const doc = parseDoc('# Objection playbook\n\n## Price\n\n- Too pricey for the team (Brindle, Atlas).\n\n- A point with nothing behind it.\n');
  const price = doc.sections[1];
  price.blocks[0].cites = ['c1', 'c2'];
  const sources = { c1: { at: ago(3), quote: 'Too pricey.' }, c2: { at: ago(45), quote: null } };
  const once = stampDoc(doc, sources, NOW);
  assert.equal(renderDoc(once), '# Objection playbook\n\n## Price\n\n- Too pricey for the team (Brindle, Atlas).\n> ×2, strengthening, last 2026-10-24 · "Too pricey."\n\n- A point with nothing behind it.\n');
  assert.equal(renderDoc(stampDoc(once, sources, NOW)), renderDoc(once), 'restamping changes nothing');
  assert.equal(renderDoc(stampDoc(carryCites(parseDoc(renderDoc(once), once), once), sources, NOW)), renderDoc(once), 'the line stays in its block through a re-parse');
  assert.equal(stripDoc(once).sections[1].blocks[0].text, '- Too pricey for the team (Brindle, Atlas).', 'the model never sees the line');
  assert.equal(stripEvidence('- a\n> ×9, new, last 2026-01-01'), '- a');
  const more = { ...sources, c3: { at: ago(1), quote: 'Still too pricey.' } };
  const grown = stampDoc({ sections: once.sections.map(s => ({ ...s, blocks: s.blocks.map(b => (b.cites ? { ...b, cites: [...b.cites, 'c3'] } : b)) })) }, more, NOW);
  assert.equal(renderDoc(grown), renderDoc(once).replace('> ×2, strengthening, last 2026-10-24 · "Too pricey."', '> ×3, strengthening, last 2026-10-26 · "Still too pricey."'));
});

test('based_on: item numbers are allowed on the ops that write text, mapped to ids, and kept as cites', () => {
  assert.equal(parseOps(JSON.stringify({ operations: [{ op: 'append_block', section_id: 's', text: 'x', based_on: [1, '2'] }] })).ops.length, 1);
  assert.deepEqual(parseOps(JSON.stringify({ operations: [{ op: 'remove_block', section_id: 's', block_id: 'b', based_on: [1] }] })).errors, ['operations[0] (remove_block) has a key it does not take: based_on']);
  assert.match(parseOps(JSON.stringify({ operations: [{ op: 'append_block', section_id: 's', text: 'x', based_on: ['one'] }] })).errors[0], /numbers of the new items/);
  assert.deepEqual(resolveRefs([{ op: 'append_block', section_id: 's', text: 'x', based_on: [1, 3, 9] }, { op: 'append_block', section_id: 's', text: 'y', based_on: [2] }], ['c1', null, 'c3']),
    [{ op: 'append_block', section_id: 's', text: 'x', based_on: ['c1', 'c3'] }, { op: 'append_block', section_id: 's', text: 'y' }], 'an unknown number or an item with no id is dropped');
  const doc = parseDoc('# F\n\n## Price\n\n- Too pricey (Brindle).\n');
  const b = doc.sections[1].blocks[0];
  b.cites = ['c1'];
  const add = applyOps(doc, [{ op: 'append_block', section_id: 'price', text: '- New (Atlas).', based_on: ['c2'] }]).doc.sections[1].blocks;
  assert.deepEqual(add.map(x => x.cites), [['c1'], ['c2']]);
  const rep = applyOps(doc, [{ op: 'replace_block', section_id: 'price', block_id: b.id, text: '- Too pricey (Brindle, Atlas).', based_on: ['c2'] }]).doc.sections[1].blocks[0];
  assert.deepEqual([rep.id, rep.cites], [b.id, ['c1', 'c2']], 'a replace adds to the cites');
  const count = applyOps(doc, [{ op: 'replace_block', section_id: 'price', block_id: b.id, text: '- Too pricey (Brindle).', based_on: ['c3'] }]);
  assert.equal(count.applied.length, 1, 'the same text with a new item behind it counts the item');
  assert.deepEqual(count.doc.sections[1].blocks[0].cites, ['c1', 'c3']);
  assert.equal(applyOps(doc, [{ op: 'replace_block', section_id: 'price', block_id: b.id, text: '- Too pricey (Brindle).', based_on: ['c1'] }]).skipped[0].no_change, true, 'an item already counted changes nothing');
  assert.deepEqual(doc.sections[1].blocks[0].cites, ['c1'], 'the input doc is never touched');
  assert.deepEqual(carryCites(parseDoc('# F\n\n## Price\n\n- Too pricey (Brindle).\n'), doc).sections[1].blocks[0].cites, ['c1'], 'cites survive a re-parse by id');
});

test('a retraction pass may only remove or replace, and only the blocks resting on a retired item', () => {
  const ops = [
    { op: 'remove_block', section_id: 's', block_id: 'b1' },
    { op: 'replace_block', section_id: 's', block_id: 'b2', text: 'kept part', based_on: [1] },
    { op: 'append_block', section_id: 's', text: 'new' },
    { op: 'remove_section', section_id: 's' },
    { op: 'remove_block', section_id: 's', block_id: 'b3' },
  ];
  const { ops: ok, refused } = restrictRetraction(ops, new Set(['b1', 'b2']));
  assert.deepEqual(ok, [{ op: 'remove_block', section_id: 's', block_id: 'b1' }, { op: 'replace_block', section_id: 's', block_id: 'b2', text: 'kept part' }], 'never with based_on');
  assert.deepEqual(refused.map(r => r.reason), ['append_block is not allowed in a retraction pass', 'remove_section is not allowed in a retraction pass', 'block b3 does not rest on a retired item']);
  assert.equal(restrictRetraction(ops, null).ops.length, 3, 'no scope: any block, still only the two ops');
  const p = buildRetractionPrompt({ topic: 'an objection playbook.', doc: parseDoc('# F\n\n- x\n'), retired: [{ id: 'c1', label: 'Brindle says it is too pricey.', why: 'misread' }], affected: [{ section_id: 'f', block_id: 'b1', retired: ['c1'], supported: ['c2'] }], supported: [{ id: 'c2', label: 'Atlas says it is too pricey.' }] });
  assert.match(p, /R1\. Brindle says it is too pricey\. · retired: misread/);
  assert.match(p, /block b1 in section f: rests on R1; still supported by S1/);
  assert.match(p, /A restated fact was not retracted/);
  assert.match(p, /When in doubt, keep it/);
  assert.doesNotMatch(p, /"op": "append_block"/);
});

const WS = 'ws1';
const claim = (id, o) => ({ id, workspace_id: WS, entity_id: 'p1', property: `note.${id}`, invalid_at: null, ...o, value: { category: 'objection', ...o.value } });

test('retracted detection: misread, contradicted and deleted are retracted; updated follows its live successor; resolved stays', async () => {
  const sb = db({ claims: [
    claim('c1', { valid_from: ago(5), value: { content: 'live' } }),
    claim('c2', { valid_from: ago(5), invalid_at: ago(1), value: { content: 'misread one', metadata: { superseded_reason: 'misread', superseded_why: 'it was about a reseller' } } }),
    claim('c3', { valid_from: ago(9), invalid_at: ago(1), value: { content: 'old wording', metadata: { superseded_reason: 'updated', superseded_by: 'c4' } } }),
    claim('c4', { valid_from: ago(1), value: { content: 'new wording', metadata: { quote: 'the new words' } } }),
    claim('c5', { valid_from: ago(5), invalid_at: ago(1), value: { content: 'answered', metadata: { superseded_reason: 'resolved' } } }),
    claim('c6', { valid_from: ago(5), invalid_at: ago(1), value: { content: 'updated into nothing', metadata: { superseded_reason: 'updated', superseded_by: null } } }),
  ] });
  const out = await checkCited(sb, WS, 'objections', ['c1', 'c2', 'c3', 'c5', 'c6', 'c7']);
  assert.deepEqual([...out.retracted.keys()].sort(), ['c2', 'c6', 'c7']);
  assert.deepEqual(out.retracted.get('c2'), { label: 'misread one', why: 'it was about a reseller' });
  assert.equal(out.retracted.get('c7').why, 'deleted');
  assert.deepEqual([...out.remap], [['c3', 'c4']], 'a restated fact was not retracted');
  assert.equal(out.sources.c4.quote, 'the new words');
  const deals = db({ deal_outcomes: [{ id: 'o1', deal_id: 'd1', workspace_id: WS, outcome: 'won' }, { id: 'o2', workspace_id: WS, outcome: 'no_decision' }] });
  const d = await checkCited(deals, WS, 'win_loss', ['o1', 'd1', 'o2', 'o3']);
  assert.deepEqual([...d.retracted.keys()], ['o2', 'o3'], 'a close reversed or removed; a GET-1054 deal_id still matches');
});

// An objection playbook with one point resting on two claims, the watermark at the newest one read.
const objSeed = () => {
  const doc = parseDoc(`${seedBody('objections').replace('_No objections read yet._\n', '')}## Price\n\n- Too pricey for a team this size (Brindle, Atlas): 2 accounts.\n`);
  doc.sections[1].blocks[0].cites = ['c1', 'c2'];
  const sources = { c1: { at: ago(20), quote: 'We cannot justify it.', label: 'Brindle says the price is too high.' }, c2: { at: ago(10), quote: null, label: 'Atlas says the price is too high.' } };
  const stamped = stampDoc(doc, sources, NOW);
  return {
    workspaces: [{ id: WS, name: 'Lanternly' }],
    workspace_living_files: [{ workspace_id: WS, key: 'objections', file_id: 'f3', enabled: true, cursor_at: ago(10), last_run_at: ago(0.5), doc: { sections: stamped.sections, rebuilt_at: ago(1), sources } }],
    workspace_context_files: [{ id: 'f3', workspace_id: WS, title: 'Objection playbook', kind: 'reference', body: renderDoc(stamped), visibility: 'workspace' }],
    entity_list_rows: [{ workspace_id: WS, entity_id: 'p1', kind: 'person', name: 'Ines Okafor', company_id: 'a1', company_name: 'Brindle' }],
    deal_outcomes: [],
    claims: [
      claim('c1', { valid_from: ago(20), value: { content: 'Brindle says the price is too high.', metadata: { quote: 'We cannot justify it.' } } }),
      claim('c2', { valid_from: ago(10), value: { content: 'Atlas says the price is too high.' } }),
    ],
  };
};
const priceBlock = (sb) => sb.tables.workspace_living_files[0].doc.sections.find(s => s.heading === 'Price').blocks[0];

test('the card: behind by N new items since the watermark, and the points resting on a retired fact', async () => {
  const sb = db(objSeed());
  assert.deepEqual((await listLivingFiles(sb, WS)).find(f => f.key === 'objections').behind, { new: 0, retracted: 0, points: 0 });
  sb.tables.claims.push(claim('c3', { valid_from: ago(2), value: { content: 'Brindle again: too pricey.' } }), claim('c4', { valid_from: ago(1), value: { content: 'Atlas: no budget.' } }),
    { ...claim('c5', { valid_from: ago(1), value: { content: 'not an objection' } }), value: { category: 'pain', content: 'x' } });
  Object.assign(sb.tables.claims[1], { invalid_at: ago(0.1), value: { ...sb.tables.claims[1].value, metadata: { superseded_reason: 'misread' } } });
  const list = await listLivingFiles(sb, WS);
  const f = list.find(x => x.key === 'objections');
  assert.deepEqual(f.behind, { new: 2, retracted: 1, points: 1 }, 'two objections newer than the watermark; one cited claim since retired, under one point');
  assert.deepEqual(Object.keys(f).sort(), ['about', 'behind', 'cursor_at', 'enabled', 'file_id', 'key', 'last_error', 'last_run_at', 'title'], 'the doc is not sent to the card');
  assert.equal(list.find(x => x.key === 'win_loss').behind, undefined, 'a file that is off says nothing about being behind');
  assert.deepEqual(await behindOf(sb, WS, { key: 'win_loss', cursor_at: ago(30), doc: null }), { new: 0, retracted: 0, points: 0 });
});

test('a pass cites the items it used: code writes count, trend and quote under the point; a no-op pass makes no version', async () => {
  const sb = db(objSeed());
  sb.tables.claims.push(claim('c3', { valid_from: ago(2), value: { content: 'Brindle again: too pricey for the team.', metadata: { quote: 'Still too much per seat.' } } }));
  const id = priceBlock(sb).id;
  const model = seq({ operations: [{ op: 'replace_block', section_id: 'price', block_id: id, text: '- Too pricey for a team this size (Brindle twice, Atlas): 2 accounts.', based_on: [1] }] });
  const out = await runLivingFile(sb, sb.tables.workspace_living_files[0], { model, now: NOW });
  assert.equal(out.status, 'updated');
  const prompt = model.calls[0][0].content;
  assert.doesNotMatch(prompt, /"text": "[^"]*> ×/, 'the model is shown the doc without evidence lines');
  assert.match(prompt, /"based_on": \[1, 2\]/);
  const body = sb.tables.workspace_context_files[0].body;
  assert.match(body, /- Too pricey for a team this size \(Brindle twice, Atlas\): 2 accounts\.\n> ×3, new, last 2026-10-25 · "Still too much per seat\."\n$/);
  assert.deepEqual(priceBlock(sb).cites, ['c1', 'c2', 'c3']);
  assert.equal(sb.tables.workspace_living_files[0].doc.sources.c3.quote, 'Still too much per seat.');
  assert.equal(renderDoc(sb.tables.workspace_living_files[0].doc), body);
  assert.equal(sb.tables.workspace_context_file_versions.length, 1);
  // The next pass, a new item already reflected: the model says so; nothing is written.
  sb.tables.claims.push(claim('c4', { valid_from: ago(1), value: { content: 'Same as before.' } }));
  const quiet = seq({ operations: [] });
  assert.equal((await runLivingFile(sb, sb.tables.workspace_living_files[0], { model: quiet, now: NOW })).status, 'unchanged');
  assert.equal(sb.tables.workspace_context_files[0].body, body, 'byte-identical');
  assert.equal(sb.tables.workspace_context_file_versions.length, 1, 'no version, so no commit');
});

test('a cited claim retired as a misread: the retraction pass runs first, removes or trims only, then the normal pass', async () => {
  const sb = db(objSeed());
  Object.assign(sb.tables.claims[1], { invalid_at: ago(0.1), value: { ...sb.tables.claims[1].value, metadata: { superseded_reason: 'misread', superseded_why: 'Atlas was talking about a reseller' } } });
  const id = priceBlock(sb).id;
  const model = seq({ operations: [
    { op: 'replace_block', section_id: 'price', block_id: id, text: '- Too pricey for a team this size (Brindle): 1 account, an example.' },
    { op: 'append_block', section_id: 'price', text: '- Sneaked in.' },
  ] });
  const out = await runLivingFile(sb, sb.tables.workspace_living_files[0], { model, now: NOW });
  assert.equal(out.status, 'updated');
  assert.equal(model.calls.length, 1, 'no new items: the retraction pass only');
  const prompt = model.calls[0][0].content;
  assert.match(prompt, /R1\. Atlas says the price is too high\. · retired: Atlas was talking about a reseller/);
  assert.match(prompt, new RegExp(`block ${id} in section price: rests on R1; still supported by S1`));
  assert.match(prompt, /S1\. Brindle says the price is too high\./);
  const body = sb.tables.workspace_context_files[0].body;
  assert.match(body, /- Too pricey for a team this size \(Brindle\): 1 account, an example\.\n> ×1, new, last 2026-10-07 · "We cannot justify it\."\n$/);
  assert.doesNotMatch(body, /Sneaked in/, 'an append is refused in a retraction pass');
  assert.equal(sb.tables.workspace_context_file_versions[0].changelog, 'Retired facts: 1 updated under Price');
  assert.equal(sb.tables.workspace_living_files[0].cursor_at, ago(10), 'the watermark does not move: nothing new was read');
  assert.deepEqual(priceBlock(sb).cites, ['c1']);
  assert.deepEqual(sb.tables.workspace_living_files[0].doc.cleared, ['c2']);
  // Handled once: the next pass has nothing to do and makes no call.
  assert.equal((await runLivingFile(sb, sb.tables.workspace_living_files[0], { model: async () => { throw new Error('no call'); }, now: NOW })).status, 'nothing_new');
  assert.deepEqual((await listLivingFiles(sb, WS)).find(f => f.key === 'objections').behind, { new: 0, retracted: 0, points: 0 });
});

test('a retired claim restated by a live one is not retracted: no retraction pass, the cite moves', async () => {
  const sb = db(objSeed());
  Object.assign(sb.tables.claims[1], { invalid_at: ago(0.1), value: { ...sb.tables.claims[1].value, metadata: { superseded_reason: 'updated', superseded_by: 'c9' } } });
  sb.tables.claims.push(claim('c9', { valid_from: ago(10), value: { content: 'Atlas says the price is too high for the team.' } }));
  assert.deepEqual((await listLivingFiles(sb, WS)).find(f => f.key === 'objections').behind, { new: 0, retracted: 0, points: 0 });
  assert.equal((await runLivingFile(sb, sb.tables.workspace_living_files[0], { model: async () => { throw new Error('no call'); }, now: NOW })).status, 'nothing_new');
});

test('win/loss: evidence over the close dates, quoted from the deal\'s top note', async () => {
  const body = seedBody('win_loss');
  const sb = db({
    workspaces: [{ id: WS, name: 'Lanternly' }],
    workspace_living_files: [{ workspace_id: WS, key: 'win_loss', file_id: 'f1', enabled: true, cursor_at: ago(30) }],
    workspace_context_files: [{ id: 'f1', workspace_id: WS, title: 'Win/loss', kind: 'reference', body, visibility: 'workspace' }],
    deal_outcomes: [
      { id: 'o1', deal_id: 'd1', workspace_id: WS, entity_id: 'a1', outcome: 'lost', closed_at: ago(7) },
      { id: 'o2', deal_id: 'd2', workspace_id: WS, entity_id: 'a2', outcome: 'lost', closed_at: ago(3) },
    ],
    entity_list_rows: [{ workspace_id: WS, entity_id: 'a1', name: 'Brindle' }, { workspace_id: WS, entity_id: 'a2', name: 'Atlas Freight' }, { workspace_id: WS, entity_id: 'p2', kind: 'person', company_id: 'a2', name: 'Ruairi' }],
    claims: [
      { id: 'n1', workspace_id: WS, entity_id: 'a1', property: 'note.1', invalid_at: null, valid_from: ago(8), value: { category: 'competitor', content: 'Brindle chose Brightlist on price.', metadata: { quote: 'Brightlist is half the price.' } } },
      { id: 'n2', workspace_id: WS, entity_id: 'p2', property: 'note.2', invalid_at: null, valid_from: ago(4), value: { category: 'budget', content: 'No budget this year.', metadata: { quote: 'Finance froze it.' } } },
      { id: 'n3', workspace_id: WS, entity_id: 'p2', property: 'note.3', invalid_at: null, valid_from: ago(3.5), value: { category: 'tech_stack', content: 'Uses HubSpot.', metadata: { quote: 'not a reason' } } },
    ],
  });
  assert.equal((await listLivingFiles(sb, WS))[0].behind.new, 2, 'two closes since the watermark');
  const why = parseDoc(body).sections.find(s => s.heading === 'Why we lose').blocks[0].id;
  const model = seq({ operations: [{ op: 'replace_block', section_id: 'why-we-lose', block_id: why, text: '- Price and budget (Brindle, Atlas Freight): 2 deals.', based_on: [1, 2] }] });
  assert.equal((await runLivingFile(sb, sb.tables.workspace_living_files[0], { model, now: NOW })).status, 'updated');
  assert.match(sb.tables.workspace_context_files[0].body, /- Price and budget \(Brindle, Atlas Freight\): 2 deals\.\n> ×2, new, last 2026-10-24 · "Finance froze it\."/);
  assert.equal((await listLivingFiles(sb, WS))[0].behind.new, 0, 'caught up');
  // The Atlas close is reversed: one point rests on it.
  sb.tables.deal_outcomes[1].outcome = 'no_decision';
  assert.deepEqual((await listLivingFiles(sb, WS))[0].behind, { new: 0, retracted: 1, points: 1 });
});
