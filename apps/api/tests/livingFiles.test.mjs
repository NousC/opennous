// Living context files (GET-1039): win/loss folds in every deal that closes, as a version by OpenNous
// with a one-line changelog, from the cursor forward.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);
const { seedBody, buildWinLossPrompt, parseWinLoss, runWinLoss, runLivingFile, listLivingFiles, setLivingFile, runLivingFiles, refreshIcpLearned, itemsBlock, currentDoc, rebuildDue } = await import('../src/lib/livingFiles.mjs');
const { parseDoc, renderDoc } = await import('../src/lib/livingDoc.mjs');

// 'value->>category' reads a JSON field, like PostgREST.
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
      if (this.op === 'insert') { const r = { id: `${this.t}-${all.length + 1}`, ...this.v }; all.push(r); rows = [r]; }
      if (this.op === 'update') rows.forEach(r => Object.assign(r, this.v));
      return { data: structuredClone(one ? rows[0] ?? null : rows), error: null };
    }
    maybeSingle() { return Promise.resolve(this.run(true)); } single() { return this.maybeSingle(); }
    then(a, b) { return Promise.resolve(this.run(false)).then(a, b); }
  }
  return { tables, from: t => new Q(t) };
}

const WS = 'ws1';
const seed = () => ({
  workspaces: [{ id: WS, name: 'Lanternly' }],
  workspace_living_files: [{ workspace_id: WS, key: 'win_loss', file_id: 'f1', enabled: true, cursor_at: '2026-10-01T00:00:00Z' }],
  workspace_context_files: [{ id: 'f1', workspace_id: WS, title: 'Win/loss', kind: 'reference', body: seedBody('win_loss'), visibility: 'workspace' }],
  deal_outcomes: [
    { id: 'o1', deal_id: 'd1', workspace_id: WS, entity_id: 'a1', outcome: 'lost', closed_at: '2026-10-20T00:00:00Z', value_usd: 4500 },
    { id: 'o2', deal_id: 'd2', workspace_id: WS, entity_id: 'a2', outcome: 'won', closed_at: '2026-10-22T00:00:00Z', value_usd: 900 },
    { id: 'o3', deal_id: 'd3', workspace_id: WS, entity_id: 'a3', outcome: 'won', closed_at: '2026-09-01T00:00:00Z' },
  ],
  entity_list_rows: [{ workspace_id: WS, entity_id: 'a1', name: 'Brindle', industry: 'Software' }, { workspace_id: WS, entity_id: 'a2', name: 'Atlas Freight', industry: 'Logistics' }],
  claims: [
    { workspace_id: WS, entity_id: 'a1', property: 'note.1', value: { category: 'competitor', content: 'Brindle chose Brightlist on price.' }, valid_from: '2026-10-18' },
    { workspace_id: WS, entity_id: 'a1', property: 'note.2', value: { category: 'tech_stack', content: 'Uses HubSpot.' }, valid_from: '2026-10-17' },
    { workspace_id: WS, entity_id: 'a2', property: 'note.3', value: { category: 'buying_signal', content: 'Atlas wanted the API for their own agents.' }, valid_from: '2026-10-21' },
  ],
});

test('a living file starts as a readable skeleton', () => {
  assert.match(seedBody('win_loss'), /^# Win\/loss\n/);
  assert.match(seedBody('win_loss'), /## Why we lose/);
});

test('the prompt holds the file, each close with its reasons, and asks for a changelog', () => {
  const p = buildWinLossPrompt({ current: '# Win/loss\nold', company: 'Lanternly', deals: [
    { outcome: 'lost', account: 'Brindle', closed_at: '2026-10-20T00:00:00Z', value: 4500, segment: 'Software', notes: [{ category: 'competitor', content: 'Chose Brightlist on price.' }] },
    { outcome: 'won', account: 'Atlas', closed_at: '2026-10-22T00:00:00Z', notes: [] },
  ] });
  assert.match(p, /Lanternly's win\/loss file/);
  assert.match(p, /1\. LOST · Brindle · closed 2026-10-20 · \$4,500 · Software\n   - \[competitor\] Chose Brightlist on price\./);
  assert.match(p, /2\. WON · Atlas · closed 2026-10-22\n   - \(nothing on file about why\)/);
  assert.match(p, /"changelog"/);
});

test('an answer is used only when it is a whole file', () => {
  assert.deepEqual(parseWinLoss('{"file":"# Win/loss\\n\\nWe lose on price to Brightlist (1 account).","changelog":"+1 loss to Brightlist, price"}'),
    { file: '# Win/loss\n\nWe lose on price to Brightlist (1 account).', changelog: '+1 loss to Brightlist, price' });
  assert.equal(parseWinLoss('{"file":"too short"}'), null);
  assert.equal(parseWinLoss('no json'), null);
});

// GET-1054: a pass edits, it does not rewrite. The model answers with ops on the doc's ids.
const reply = (x) => ({ model: 'm', usage: {}, content: [{ type: 'text', text: typeof x === 'string' ? x : JSON.stringify(x) }] });
/** A model that answers each call with the next reply in turn, and keeps what it was sent. */
function seq(...replies) {
  const calls = [];
  const fn = async (o) => { calls.push(o.messages); if (calls.length > replies.length) throw new Error('called too often'); return reply(replies[calls.length - 1]); };
  fn.calls = calls;
  return fn;
}
const seedDoc = () => parseDoc(seedBody('win_loss'));
const blockIn = (heading) => seedDoc().sections.find(s => s.heading === heading).blocks[0].id;

test('a pass edits the file with ops, writes the changelog from them, records what it read, and moves the cursor', async () => {
  const sb = db(seed());
  const model = seq({ operations: [
    { op: 'replace_block', section_id: 'why-we-lose', block_id: blockIn('Why we lose'), text: '- Price vs Brightlist (Brindle). One deal: an example, not a pattern.' },
    { op: 'replace_block', section_id: 'why-we-win', block_id: blockIn('Why we win'), text: '- Came for the API (Atlas Freight).' },
    { op: 'add_section', heading: 'Recent closes', level: 2, blocks: ['- 2026-10-22 · Atlas Freight · won · the API\n- 2026-10-20 · Brindle · lost · price'] },
  ] });
  const out = await runWinLoss(sb, sb.tables.workspace_living_files[0], { model });
  assert.equal(out.status, 'updated'); assert.equal(out.deals, 2);
  const prompt = model.calls[0][0].content;
  assert.match(prompt, /"id": "why-we-lose"/, 'the doc goes in as JSON with its ids');
  assert.ok(prompt.includes(`"id": "${blockIn('Why we lose')}"`));
  assert.match(prompt, /Brindle chose Brightlist on price/);
  assert.match(prompt, /1\. LOST · Brindle · closed 2026-10-20 · \$4,500 · Software/, 'the items as the whole-file prompt lists them');
  assert.doesNotMatch(prompt, /Uses HubSpot/, 'only what says why');
  assert.doesNotMatch(prompt, /2026-09-01/, 'closes before the cursor are not read again');
  assert.doesNotMatch(prompt, /Rewrite the whole file/);
  const body = sb.tables.workspace_context_files[0].body;
  assert.match(body, /## Why we lose\n\n- Price vs Brightlist \(Brindle\)/);
  assert.match(body, /## Recent closes\n\n- 2026-10-22 · Atlas Freight · won/);
  assert.ok(body.startsWith(seedBody('win_loss').split('## Why we win')[0]), 'the untouched intro is byte-identical');
  const v = sb.tables.workspace_context_file_versions[0];
  assert.deepEqual([v.author_kind, v.changelog], ['opennous', '1 updated under Why we lose, 1 updated under Why we win, new section Recent closes (+1)']);
  assert.deepEqual(v.based_on, { deals: ['d1', 'd2'] });
  const row = sb.tables.workspace_living_files[0];
  assert.equal(row.cursor_at, '2026-10-22T00:00:00Z');
  assert.equal(renderDoc(row.doc), body, 'the doc is stored beside the body');
  assert.equal(row.doc.sections.find(s => s.id === 'why-we-lose').blocks[0].id, blockIn('Why we lose'), 'the replaced block kept its id');
  assert.ok(row.doc.rebuilt_at, 'the first parse starts the weekly clock');
});

test('a reply with a shape error is rejected whole and asked again once, quoting the errors', async () => {
  const sb = db(seed());
  const model = seq({ operations: [{ op: 'append_block', section_id: 'why-we-lose', block_id: null, text: '- Price (Brindle).' }, { op: 'append_block', section_id: 'why-we-win', text: '- API (Atlas Freight).' }] },
    { operations: [{ op: 'append_block', section_id: 'why-we-lose', text: '- Price (Brindle).' }] });
  const out = await runWinLoss(sb, sb.tables.workspace_living_files[0], { model });
  assert.equal(out.status, 'updated');
  assert.equal(model.calls.length, 2);
  assert.match(model.calls[1].at(-1).content, /operations\[0\] \(append_block\) has a key it does not take: block_id/);
  assert.equal(model.calls[1][1].role, 'assistant');
  const body = sb.tables.workspace_context_files[0].body;
  assert.match(body, /- Price \(Brindle\)\./);
  assert.doesNotMatch(body, /API \(Atlas/, 'nothing from the rejected reply is applied');
  assert.equal(sb.tables.workspace_context_file_versions[0].changelog, '+1 point under Why we lose');
});

test('a second unreadable reply: nothing written, cursor not moved', async () => {
  const sb = db(seed());
  const before = sb.tables.workspace_context_files[0].body;
  const model = seq('sorry', { operations: [{ op: 'rewrite' }] });
  const out = await runWinLoss(sb, sb.tables.workspace_living_files[0], { model });
  assert.equal(out.status, 'failed');
  assert.equal(sb.tables.workspace_context_files[0].body, before);
  assert.equal(sb.tables.workspace_context_file_versions.length, 0);
  const row = sb.tables.workspace_living_files[0];
  assert.equal(row.cursor_at, '2026-10-01T00:00:00Z');
  assert.equal(row.doc, undefined);
  assert.match(row.last_error, /could not be read/);
});

test('an op on an unknown id is skipped and asked again once, with the real ids', async () => {
  const sb = db(seed());
  const model = seq({ operations: [{ op: 'append_block', section_id: 'losses', text: '- Price (Brindle).' }, { op: 'append_block', section_id: 'why-we-win', text: '- API (Atlas Freight).' }] },
    { operations: [{ op: 'append_block', section_id: 'why-we-lose', text: '- Price (Brindle).' }, { op: 'append_block', section_id: 'why-we-win', text: '- API (Atlas Freight).' }] });
  const out = await runWinLoss(sb, sb.tables.workspace_living_files[0], { model });
  assert.equal(out.status, 'updated');
  const retry = model.calls[1].at(-1).content;
  assert.match(retry, /operations\[0\] \(append_block\): unknown section_id losses/);
  assert.match(retry, /section why-we-lose "Why we lose": blocks b[0-9a-f]{8}/);
  const body = sb.tables.workspace_context_files[0].body;
  assert.equal(body.match(/API \(Atlas Freight\)/g).length, 1, 'the retry replaces the first reply, it does not add to it');
  assert.match(body, /Price \(Brindle\)/);
});

test('every op skipped, even after the retry: failed, nothing written, cursor not moved', async () => {
  const sb = db(seed());
  const model = seq({ operations: [{ op: 'remove_section', section_id: 'why-we-lose' }] }, { operations: [{ op: 'remove_section', section_id: 'why-we-lose' }] });
  const out = await runWinLoss(sb, sb.tables.workspace_living_files[0], { model });
  assert.equal(out.status, 'failed');
  assert.equal(sb.tables.workspace_context_file_versions.length, 0);
  assert.equal(sb.tables.workspace_living_files[0].cursor_at, '2026-10-01T00:00:00Z');
  assert.match(sb.tables.workspace_living_files[0].last_error, /required and cannot be removed/);
  // The next pass fails the same way: the cursor moves on, so the same items are not paid for every hour.
  const again = seq({ operations: [{ op: 'remove_section', section_id: 'why-we-lose' }] }, { operations: [{ op: 'remove_section', section_id: 'why-we-lose' }] });
  assert.equal((await runWinLoss(sb, sb.tables.workspace_living_files[0], { model: again })).status, 'unchanged');
  assert.equal(sb.tables.workspace_living_files[0].cursor_at, '2026-10-22T00:00:00Z');
  assert.match(sb.tables.workspace_living_files[0].last_error, /Moved past 2 items/);
  assert.equal(sb.tables.workspace_context_file_versions.length, 0);
});

test('zero ops for real new items: no version, no commit, and the cursor moves', async () => {
  const sb = db(seed());
  const before = sb.tables.workspace_context_files[0].body;
  const out = await runWinLoss(sb, sb.tables.workspace_living_files[0], { model: seq({ operations: [] }) });
  assert.equal(out.status, 'unchanged');
  assert.equal(sb.tables.workspace_context_files[0].body, before);
  assert.equal(sb.tables.workspace_context_file_versions.length, 0);
  assert.equal(sb.tables.workspace_living_files[0].cursor_at, '2026-10-22T00:00:00Z');
  // Ops that change nothing count as zero too, with no retry.
  const sb2 = db(seed());
  const same = seq({ operations: [{ op: 'replace_block', section_id: 'why-we-lose', block_id: blockIn('Why we lose'), text: '_No closed deals read yet._' }] });
  assert.equal((await runWinLoss(sb2, sb2.tables.workspace_living_files[0], { model: same })).status, 'unchanged');
  assert.equal(same.calls.length, 1);
  assert.equal(sb2.tables.workspace_context_file_versions.length, 0);
});

test('the first run on a file with whole-file text parses it, no rewrite; a hand edit since is built on, ids kept', async () => {
  const old = '# Win/loss\n\n4 won, 3 lost.\n\n## Why we lose\n\n- Price vs Brightlist (Brindle, Atlas Freight): 2 accounts.\n\n## By competitor\n\n- Brightlist: met 2, won 0.\n';
  const sb = db({ ...seed(), workspace_context_files: [{ ...seed().workspace_context_files[0], body: old }] });
  const doc0 = parseDoc(old);
  const priceId = doc0.sections[1].blocks[0].id;
  const m1 = seq({ operations: [{ op: 'append_block', section_id: 'why-we-lose', text: '- No admin seat (Brindle). One account: an example.' }] });
  await runWinLoss(sb, sb.tables.workspace_living_files[0], { model: m1 });
  assert.equal(sb.tables.workspace_context_files[0].body, old.replace('2 accounts.\n', '2 accounts.\n\n- No admin seat (Brindle). One account: an example.\n'), 'the old text is kept as it was, plus the one block');
  // Someone edits the file in the app: a line changed, a section added.
  const row = sb.tables.workspace_living_files[0];
  const edited = sb.tables.workspace_context_files[0].body.replace('Brightlist: met 2, won 0.', 'Brightlist: met 2, won 0. Cheaper per seat.').replace('## By competitor', '## Why we win\n\n- Fast setup (Atlas Freight).\n\n## By competitor');
  sb.tables.workspace_context_files[0].body = edited;
  const { doc, handEdited } = currentDoc(row.doc, edited);
  assert.equal(handEdited, true);
  assert.equal(doc.sections.find(s => s.id === 'why-we-lose').blocks[0].id, priceId, 'an unchanged block keeps its id');
  assert.equal(doc.sections.find(s => s.id === 'by-competitor').blocks[0].id, row.doc.sections.find(s => s.id === 'by-competitor').blocks[0].id, 'an edited block keeps its place and id');
  // The next pass edits the hand-edited text, by those ids.
  sb.tables.deal_outcomes.push({ id: 'o4', deal_id: 'd4', workspace_id: WS, entity_id: 'a1', outcome: 'lost', closed_at: '2026-10-24T00:00:00Z' });
  const m2 = seq({ operations: [{ op: 'replace_block', section_id: 'why-we-lose', block_id: priceId, text: '- Price vs Brightlist (Brindle, Atlas Freight, and Brindle again): 3 deals.' }] });
  assert.equal((await runWinLoss(sb, { ...row, cursor_at: '2026-10-22T00:00:00Z' }, { model: m2 })).status, 'updated');
  const body = sb.tables.workspace_context_files[0].body;
  assert.match(body, /Cheaper per seat\./, 'the hand edit is kept');
  assert.match(body, /## Why we win\n\n- Fast setup \(Atlas Freight\)\./);
  assert.match(body, /3 deals\./);
  assert.equal(sb.tables.workspace_context_file_versions.at(-1).changelog, '1 updated under Why we lose');
});

test('the weekly full rebuild: run when the last is over 7 days old, else edit ops', async () => {
  const now = new Date('2026-10-27T12:00:00Z');
  assert.equal(rebuildDue(null, now), false, 'a first run never rewrites');
  assert.equal(rebuildDue({ sections: [], rebuilt_at: '2026-10-24T12:00:00Z' }, now), false);
  assert.equal(rebuildDue({ sections: [], rebuilt_at: '2026-10-19T12:00:00Z' }, now), true);
  const stale = (at) => { const sb = db(seed()); Object.assign(sb.tables.workspace_living_files[0], { doc: { ...seedDoc(), rebuilt_at: at } }); return sb; };
  // Due: the old whole-file prompt, the file parsed back keeping ids, and the clock reset.
  const sb = stale('2026-10-19T12:00:00Z');
  const whole = seq({ file: '# Win/loss\n\n_Why you win and lose. Updated from every deal that closes. Every update is a version with what changed._\n\n1 won, 1 lost.\n\n## Why we win\n\n_No closed deals read yet._\n\n## Why we lose\n\n- Price vs Brightlist (Brindle).', changelog: '+1 loss to Brightlist, price; +1 win' });
  assert.equal((await runWinLoss(sb, sb.tables.workspace_living_files[0], { model: whole, now })).status, 'updated');
  assert.match(whole.calls[0][0].content, /Rewrite the whole file/);
  assert.equal(sb.tables.workspace_context_file_versions[0].changelog, 'Weekly rebuild: +1 loss to Brightlist, price; +1 win');
  const row = sb.tables.workspace_living_files[0];
  assert.equal(row.doc.rebuilt_at, now.toISOString());
  assert.equal(row.doc.sections.find(s => s.id === 'why-we-win').blocks[0].id, blockIn('Why we win'), 'an unchanged block keeps its id through a rebuild');
  assert.equal(renderDoc(row.doc), sb.tables.workspace_context_files[0].body);
  // Not due: edit ops.
  const sb2 = stale('2026-10-24T12:00:00Z');
  const ops = seq({ operations: [{ op: 'append_block', section_id: 'why-we-lose', text: '- Price (Brindle).' }] });
  await runWinLoss(sb2, sb2.tables.workspace_living_files[0], { model: ops, now });
  assert.doesNotMatch(ops.calls[0][0].content, /Rewrite the whole file/);
  assert.equal(sb2.tables.workspace_living_files[0].doc.rebuilt_at, '2026-10-24T12:00:00Z', 'an edit pass keeps the clock');
});

test('the edit prompt lists the items exactly as the whole-file prompt does', () => {
  const deals = [{ outcome: 'lost', account: 'Brindle', closed_at: '2026-10-20T00:00:00Z', notes: [{ category: 'pain', content: 'No time.' }] }];
  const { header, text } = itemsBlock('win_loss', deals, 'Lanternly');
  assert.equal(header, "DEALS THAT CLOSED SINCE IT WAS LAST UPDATED, with what the account's record says:");
  assert.equal(text, '1. LOST · Brindle · closed 2026-10-20\n   - [pain] No time.');
  assert.ok(buildWinLossPrompt({ current: '', deals, company: 'Lanternly' }).includes(`${header}\n${text}\n\nRewrite`));
  assert.match(itemsBlock('objections', [{ account: 'Atlas', said_at: '2026-10-16', status: null, hardness: null, outcome: null, occurred: null, content: 'Too pricey.', after: [] }]).text, /^1\. Atlas · 2026-10-16\n {3}Too pricey\.$/);
});

test('nothing new closed: no model call; an unreadable answer changes nothing', async () => {
  const quiet = db({ ...seed(), deal_outcomes: [] });
  const never = async () => { throw new Error('should not be called'); };
  assert.equal((await runWinLoss(quiet, quiet.tables.workspace_living_files[0], { model: never })).status, 'nothing_new');
  const sb = db(seed());
  const before = sb.tables.workspace_context_files[0].body;
  const out = await runWinLoss(sb, sb.tables.workspace_living_files[0], { model: async () => ({ content: [{ type: 'text', text: 'sorry' }] }) });
  assert.equal(out.status, 'failed');
  assert.equal(sb.tables.workspace_context_files[0].body, before);
  assert.equal(sb.tables.workspace_living_files[0].cursor_at, '2026-10-01T00:00:00Z', 'the closes are read again next pass');
});

// GET-1040: battlecards and the objection playbook, from new competitor and objection signals.
const signalsSeed = () => ({
  workspaces: [{ id: WS, name: 'Lanternly' }],
  workspace_living_files: [{ workspace_id: WS, key: 'battlecards', file_id: 'f2', enabled: true, cursor_at: '2026-10-01T00:00:00Z' },
    { workspace_id: WS, key: 'objections', file_id: 'f3', enabled: true, cursor_at: '2026-10-01T00:00:00Z' }],
  workspace_context_files: [{ id: 'f2', workspace_id: WS, title: 'Battlecards', kind: 'reference', body: seedBody('battlecards'), visibility: 'workspace' },
    { id: 'f3', workspace_id: WS, title: 'Objection playbook', kind: 'reference', body: seedBody('objections'), visibility: 'workspace' }],
  entity_list_rows: [{ workspace_id: WS, entity_id: 'p1', kind: 'person', name: 'Ines Okafor', company_id: 'a1', company_name: 'Brindle' }],
  deal_outcomes: [{ workspace_id: WS, entity_id: 'a1', outcome: 'lost', closed_at: '2026-10-25T00:00:00Z' }],
  claims: [
    { id: 'cl-c', workspace_id: WS, entity_id: 'p1', property: 'note.c', invalid_at: null, valid_from: '2026-10-10T00:00:00Z', value: { category: 'competitor', content: 'Ines is weighing Brightlist because it is cheaper.', metadata: { entity: 'Brightlist', stance: 'evaluating' } } },
    { workspace_id: WS, entity_id: 'p1', property: 'note.r', invalid_at: '2026-10-20T00:00:00Z', valid_from: '2026-10-11T00:00:00Z', value: { category: 'competitor', content: 'A misread one.', metadata: { entity: 'Tallyhook' } } },
    { workspace_id: WS, entity_id: 'p1', property: 'note.o', invalid_at: null, valid_from: '2026-10-12T00:00:00Z', value: { category: 'objection', content: 'Ines doubts reps will use an MCP.', metadata: { status: 'resolved', hardness: 'soft' } } },
    { workspace_id: WS, entity_id: 'p1', property: 'note.b', invalid_at: null, valid_from: '2026-10-14T00:00:00Z', value: { category: 'buying_signal', content: 'Ines wants to show it to the CRO.' } },
  ],
});

test('battlecards read new competitor mentions with their account and outcome, never a retired one', async () => {
  const sb = db(signalsSeed());
  const model = seq({ operations: [{ op: 'add_section', heading: 'Brightlist', level: 2, blocks: ['- Cheaper (Brindle). Lost at Brindle.'] }] });
  const out = await runLivingFile(sb, sb.tables.workspace_living_files[0], { model });
  assert.equal(out.status, 'updated');
  const prompt = model.calls[0][0].content;
  assert.match(prompt, /1\. Brightlist \(evaluating\) · Brindle · 2026-10-10 · deal lost\n   Ines is weighing Brightlist because it is cheaper\./);
  assert.doesNotMatch(prompt, /misread/);
  assert.equal(sb.tables.workspace_context_file_versions[0].changelog, 'new section Brightlist (+1)');
  assert.deepEqual(sb.tables.workspace_context_file_versions[0].based_on, { claims: ['cl-c'] });
  assert.equal(sb.tables.workspace_living_files[0].cursor_at, '2026-10-10T00:00:00Z');
});

test('the objection playbook reads each objection, its status, and what the buyer did after it', async () => {
  const sb = db(signalsSeed());
  const placeholder = parseDoc(seedBody('objections')).sections[0].blocks[1].id;
  const model = seq({ operations: [{ op: 'remove_block', section_id: 'objection-playbook', block_id: placeholder }, { op: 'add_section', heading: 'Reps will not use an MCP', level: 2, blocks: ['- Brindle; resolved; moved to the CRO.'] }] });
  const out = await runLivingFile(sb, sb.tables.workspace_living_files[1], { model });
  assert.equal(out.status, 'updated');
  assert.match(model.calls[0][0].content, /1\. Brindle · 2026-10-12 · resolved · soft · deal lost\n   Ines doubts reps will use an MCP\.\n   after it: Ines wants to show it to the CRO\./);
  const body = sb.tables.workspace_context_files[1].body;
  assert.match(body, /## Reps will not use an MCP/);
  assert.doesNotMatch(body, /No objections read yet/);
  assert.equal(sb.tables.workspace_context_file_versions[0].changelog, '1 removed under Objection playbook, new section Reps will not use an MCP (+1)');
});

// GET-1044: battlecards are hidden for now: not listed, not turned on, not run.
test('intelligence lists win/loss and the objection playbook only, and never runs battlecards', async () => {
  const sb = db(signalsSeed());
  assert.deepEqual((await listLivingFiles(sb, WS)).map(f => f.key), ['win_loss', 'objections']);
  await assert.rejects(setLivingFile(sb, WS, 'u1', 'battlecards', true), /Unknown intelligence file/);
  sb.tables.workspace_living_files = sb.tables.workspace_living_files.filter(r => r.key === 'battlecards');
  assert.deepEqual(await runLivingFiles(sb), { files: 0, updated: 0 });
  assert.equal(sb.tables.workspace_context_files[0].body, seedBody('battlecards'));
});

// GET-1044: the ICP is Intelligence. OpenNous writes what closed deals taught under the workspace's own words.
const icpSeed = () => ({ workspace_context_files: [{ id: 'icp1', workspace_id: WS, title: 'ICP', kind: 'icp', body: '# ICP\n\nB2B software, 20-200 staff.\n', visibility: 'workspace' }] });
const model = (won, lost) => async () => ({ has_model: true, has_outcomes: true, model_version: 'v1',
  signals: [{ key: 'crm', label: 'Uses a CRM', weight: 12, rule: {}, fires: 4, hits: 3, lift: 2.5 }], calibration: { gap: 0.3, resolved: won + lost, won, lost } });

test('the ICP gets the learned block under its own words, once, and again only when it changes', async () => {
  const sb = db(icpSeed());
  const first = await refreshIcpLearned(sb, WS, { compute: model(3, 2), now: new Date('2026-10-26T10:00:00Z') });
  assert.equal(first.status, 'updated');
  assert.equal(first.changelog, 'Learned from 5 closed deals: 3 won, 2 lost');
  const body = sb.tables.workspace_context_files[0].body;
  assert.match(body, /^# ICP\n\nB2B software, 20-200 staff\.\n\n<!-- nous:icp start -->/);
  assert.match(body, /\| Uses a CRM \| \+12 \| 2\.5x \| 4 \|/);
  assert.equal(sb.tables.workspace_context_file_versions.at(-1).author_kind, 'opennous');
  // The next day, nothing new: not rewritten just for the date.
  assert.equal((await refreshIcpLearned(sb, WS, { compute: model(3, 2), now: new Date('2026-10-27T10:00:00Z') })).status, 'nothing_new');
  // A new close: the block is replaced in place, the prose kept.
  assert.equal((await refreshIcpLearned(sb, WS, { compute: model(4, 2) })).status, 'updated');
  const after = sb.tables.workspace_context_files[0].body;
  assert.equal(after.match(/nous:icp start/g).length, 1);
  assert.match(after, /6 closed deals — 4 won \/ 2 lost/);
  assert.match(after, /B2B software, 20-200 staff\./);
});

test('no closed deals, or no ICP file: the ICP is left alone', async () => {
  const sb = db(icpSeed());
  const none = async () => ({ has_model: true, has_outcomes: false, signals: [], calibration: { won: 0, lost: 0 } });
  assert.equal((await refreshIcpLearned(sb, WS, { compute: none })).status, 'nothing_new');
  assert.equal(sb.tables.workspace_context_files[0].body, icpSeed().workspace_context_files[0].body);
  assert.equal((await refreshIcpLearned(db({}), WS, { compute: model(1, 0) })).status, 'no_file');
});

test('an event says when it happened beside when it was said (GET-1051)', async () => {
  const { buildObjectionsPrompt } = await import('../src/lib/livingFiles.mjs');
  const p = buildWinLossPrompt({ current: '# Win/loss\nold', deals: [
    { outcome: 'lost', account: 'Brindle', closed_at: '2026-10-20T00:00:00Z', notes: [
      { category: 'competitor', content: 'Brindle moved to Brightlist in March 2026.', occurred: '2026-03-01 to 2026-03-31' },
      { category: 'pain', content: 'Brindle has no time for notes.' },
    ] },
  ] });
  assert.match(p, /- \[competitor\] Brindle moved to Brightlist in March 2026\. \(happened 2026-03-01 to 2026-03-31\)\n   - \[pain\] Brindle has no time for notes\.\n/);
  const o = buildObjectionsPrompt({ current: '# Objection playbook', items: [
    { account: 'Atlas', said_at: '2026-10-16T09:00:00Z', occurred: '2026-10-23', status: 'open', hardness: 'hard', outcome: null, content: 'Ruairi needs a finance yes before the trial ends.', after: [] },
    { account: 'Brindle', said_at: '2026-10-14T09:00:00Z', occurred: null, status: null, hardness: null, outcome: null, content: 'Ines doubts the data.', after: [] },
  ] });
  assert.match(o, /1\. Atlas · 2026-10-16 · happened 2026-10-23 · open · hard\n/);
  assert.match(o, /2\. Brindle · 2026-10-14\n/);
});

// GET-1074 review: with a backtest the block must still read as unchanged on a new day.
test('an ICP block from a backtest is not rewritten just for the date', async () => {
  const sb = db(icpSeed());
  const bt = { ran_at: '2026-10-29T04:30:00Z', result: {
    coverage: { won: { total: 30, scored: 30 }, lost: { total: 70, scored: 70 } },
    tiers: [{ tier: 'tier_1', label: 'Tier 1', won: 10, lost: 10, rate: 0.5 }], strata: [],
    accuracy: { key: 'weak', label: 'Weak', win_rate: 0.3, fit_rate: 0.5, rest_rate: 0.25, raw_ratio: 2, controlled_ratio: 1.3, median_contacts: { won: 4, lost: 2 } },
    rules: [], disqualifiers: [], data_coverage: [], recommendations: [], period: { from: '2021-01-01T00:00:00Z', to: null }, deals: [] } };
  const withBt = async () => ({ ...(await model(3, 2)()), backtest: bt });
  assert.equal((await refreshIcpLearned(sb, WS, { compute: withBt, now: new Date('2026-10-29T10:00:00Z') })).status, 'updated');
  assert.match(sb.tables.workspace_context_files[0].body, /Score accuracy: Weak/);
  assert.equal((await refreshIcpLearned(sb, WS, { compute: withBt, now: new Date('2026-10-30T10:00:00Z') })).status, 'nothing_new');
});
