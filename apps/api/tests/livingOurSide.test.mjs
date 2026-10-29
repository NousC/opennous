// Our side's words in the Intelligence files (GET-1052): the objection playbook pairs each objection
// with the replies we gave on the same account (same conversation, or after it, by said date), and
// win/loss lists what we pitched and promised on each closed deal. These two are the only readers of
// our side's claims; every buyer view drops them (core test ourSideClaims.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);
const { seedBody, buildObjectionsPrompt, buildWinLossPrompt, runLivingFile } = await import('../src/lib/livingFiles.mjs');
const { repliesFor, saidLines } = await import('../src/lib/livingOurSide.mjs');

// A PostgREST-ish fake that reads JSON paths ("value->metadata->>side") the way PostgREST does.
const get = (r, k) => {
  const parts = k.split(/->>?/);
  let v = r;
  for (const p of parts) v = v?.[p];
  return v ?? null;
};
function db(seed) {
  const tables = { workspace_context_file_versions: [], workspace_context_repos: [], ...structuredClone(seed) };
  class Q {
    constructor(t) { this.t = t; this.f = []; this.lim = Infinity; }
    select() { return this; } order() { return this; } limit(n) { this.lim = n; return this; }
    eq(k, v) { this.f.push(r => get(r, k) === v); return this; }
    is(k, v) { this.f.push(r => get(r, k) === v); return this; }
    in(k, vs) { this.f.push(r => vs.includes(get(r, k))); return this; }
    gt(k, v) { this.f.push(r => String(get(r, k)) > String(v)); return this; }
    like(k, p) { const re = new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`); this.f.push(r => re.test(get(r, k) ?? '')); return this; }
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
const ours = (extra = {}) => ({ side: 'ours', about: 'company', speaker: 'Theo Bramwell', ...extra });
const claim = (property, entity_id, valid_from, category, content, metadata = {}) =>
  ({ workspace_id: WS, entity_id, property, invalid_at: null, valid_from, value: { category, content, metadata } });

const seed = () => ({
  workspaces: [{ id: WS, name: 'Lanternly' }],
  workspace_living_files: [
    { workspace_id: WS, key: 'objections', file_id: 'f3', enabled: true, cursor_at: '2026-10-01T00:00:00Z' },
    { workspace_id: WS, key: 'win_loss', file_id: 'f1', enabled: true, cursor_at: '2026-10-01T00:00:00Z' },
  ],
  workspace_context_files: [
    { id: 'f3', workspace_id: WS, title: 'Objection playbook', kind: 'reference', body: seedBody('objections'), visibility: 'workspace' },
    { id: 'f1', workspace_id: WS, title: 'Win/loss', kind: 'reference', body: seedBody('win_loss'), visibility: 'workspace' },
  ],
  entity_list_rows: [
    { workspace_id: WS, entity_id: 'a1', kind: 'account', name: 'Brindle' },
    { workspace_id: WS, entity_id: 'p1', kind: 'person', name: 'Ines Okafor', company_id: 'a1', company_name: 'Brindle' },
  ],
  deal_outcomes: [{ workspace_id: WS, entity_id: 'a1', outcome: 'won', closed_at: '2026-10-25T00:00:00Z' }],
  claims: [
    claim('note.o', 'p1', '2026-10-12T00:00:00Z', 'objection', 'Ines doubts the HubSpot sync keeps up.', { status: 'open', source_ref: 'source://fireflies/m1' }),
    // Same call: answers it.
    claim('note.r1', 'a1', '2026-10-12T00:00:00Z', 'our_reply', 'Answered the HubSpot sync doubt by showing tasks write back within a minute.', ours({ answers: 'HubSpot sync', source_ref: 'source://fireflies/m1' })),
    // A later call, about something else: not an answer to this one.
    claim('note.r2', 'a1', '2026-10-15T00:00:00Z', 'our_reply', 'Answered the price question with the annual plan.', ours({ answers: 'Annual price', source_ref: 'source://fireflies/m2' })),
    // Before the objection was raised, another call: never its answer.
    claim('note.r0', 'a1', '2026-10-05T00:00:00Z', 'our_reply', 'Answered a HubSpot sync question about field mapping.', ours({ answers: 'HubSpot sync', source_ref: 'source://fireflies/m0' })),
    claim('note.c1', 'a1', '2026-10-12T00:00:00Z', 'our_commitment', 'Promised to send the security doc by Friday, October 16, 2026.', ours({ fact_kind: 'event', occurred_start: '2026-10-16' })),
    claim('note.pl', 'a1', '2026-10-12T00:00:00Z', 'pitch_line', 'Framed the product as replacing two tools.', ours()),
    claim('note.b', 'p1', '2026-10-20T00:00:00Z', 'buying_signal', 'Brindle asked for the order form.', {}),
  ],
});

test('repliesFor: same conversation first, a later one only when it is about the same thing, never one before', () => {
  const s = seed();
  const objection = s.claims[0];
  const replies = s.claims.filter(c => c.value.category === 'our_reply');
  assert.deepEqual(repliesFor(objection, replies), ['Answered the HubSpot sync doubt by showing tasks write back within a minute.']);
  // A later call that answers the same concern is paired too.
  const later = claim('note.r3', 'a1', '2026-10-18T00:00:00Z', 'our_reply', 'Answered the HubSpot sync worry with the audit log.', ours({ answers: 'HubSpot sync' }));
  assert.deepEqual(repliesFor(objection, [...replies, later]).length, 2);
  assert.deepEqual(repliesFor(objection, []), []);
});

test('saidLines: pitch lines and promises (with the due date), never a reply', () => {
  const lines = saidLines(seed().claims);
  assert.deepEqual(lines, [
    '[commitment] Promised to send the security doc by Friday, October 16, 2026. (due 2026-10-16)',
    '[pitch line] Framed the product as replacing two tools.',
  ]);
});

test('the playbook prompt states the answers given as "we answered:"', () => {
  const p = buildObjectionsPrompt({ current: '# Objection playbook', items: [
    { account: 'Brindle', said_at: '2026-10-12', status: 'open', content: 'Ines doubts the HubSpot sync keeps up.', answered: ['Answered it with the audit log.'], after: [] },
    { account: 'Atlas', said_at: '2026-10-13', content: 'Too pricey.', after: [] },
  ] });
  assert.match(p, /1\. Brindle · 2026-10-12 · open\n   Ines doubts the HubSpot sync keeps up\.\n   we answered: Answered it with the audit log\./);
  assert.match(p, /2\. Atlas · 2026-10-13\n   Too pricey\.(?!\n   we answered)/);
});

test('the win/loss prompt lists what we said on a deal, labelled as ours', () => {
  const p = buildWinLossPrompt({ current: '# Win/loss', deals: [
    { outcome: 'won', account: 'Brindle', closed_at: '2026-10-25T00:00:00Z', notes: [{ category: 'buying_signal', content: 'Asked for the order form.' }], said: ['[pitch line] Framed it as replacing two tools.'] },
  ] });
  assert.match(p, /   - \[buying_signal\] Asked for the order form\.\n   what we said \(our side, not the buyer's\):\n   - \[pitch line\] Framed it as replacing two tools\./);
});

// The model answers with edit operations (GET-1054): one new section from the file's heading and bullet.
const answer = (file) => async ({ messages }) => {
  const [, heading, bullet] = file.match(/\n## (.+)\n(- .+)$/);
  // A section the file already has gets the bullet appended; a new one is added.
  const id = heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const has = new RegExp(`"id": "${id}"`).test(String(messages.at(-1).content));
  const ops = { operations: [has ? { op: 'append_block', section_id: id, text: bullet } : { op: 'add_section', heading, level: 2, blocks: [bullet] }] };
  return { model: 'm', usage: {}, content: [{ type: 'text', text: JSON.stringify(ops) }], _prompt: messages[0].content };
};

test('the objection playbook pass pairs our reply from the same call to the objection', async () => {
  const sb = db(seed());
  let prompt = null;
  const model = async (o) => { prompt = o.messages[0].content; return answer('# Objection playbook\n\n## HubSpot sync\n- Brindle; answered with the write-back.')(o); };
  const out = await runLivingFile(sb, sb.tables.workspace_living_files[0], { model });
  assert.equal(out.status, 'updated');
  assert.match(prompt, /Ines doubts the HubSpot sync keeps up\.\n   we answered: Answered the HubSpot sync doubt by showing tasks write back within a minute\.\n   after it: Brindle asked for the order form\./);
  assert.doesNotMatch(prompt, /annual plan|field mapping/);
  // Our reply is never itself read as an objection.
  assert.equal((prompt.match(/^\d+\. /gm) ?? []).length, 1);
});

test('the win/loss pass lists what we pitched and promised, apart from why the buyer bought', async () => {
  const sb = db(seed());
  let prompt = null;
  const model = async (o) => { prompt = o.messages[0].content; return answer('# Win/loss\n\n## Why we win\n- Brindle wanted the order form.')(o); };
  const out = await runLivingFile(sb, sb.tables.workspace_living_files[1], { model });
  assert.equal(out.status, 'updated');
  assert.match(prompt, /- \[buying_signal\] Brindle asked for the order form\./);
  assert.match(prompt, /what we said \(our side, not the buyer's\):\n   - \[commitment\] Promised to send the security doc/);
  assert.match(prompt, /\[pitch line\] Framed the product as replacing two tools\./);
  // Our side's claims are never listed as a reason (the deal's notes are the buyer's).
  assert.doesNotMatch(prompt, /- \[our_reply\]|- \[pitch_line\]|- \[our_commitment\]/);
});
