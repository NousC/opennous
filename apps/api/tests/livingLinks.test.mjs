// Cause links in the Intelligence files (GET-1053): the objection playbook shows "answered by:" from
// a link between an objection and our reply (preferred over the shared-words pairing, which stays
// the fallback), and win/loss shows "lost because:" for the objections and blockers linked as the
// cause of a lost deal's facts. Without the table, both files read as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);
const { seedBody, buildObjectionsPrompt, buildWinLossPrompt, runLivingFile } = await import('../src/lib/livingFiles.mjs');
const { answersFromLinks, lostBecauseLines } = await import('../src/lib/livingLinks.mjs');

// The PostgREST-ish fake of livingOurSide.test.mjs, plus or() (listClaimLinks filters what it gets
// back to the ids it asked about, so a no-op or() is enough) and a claim_links table that can be missing.
const get = (r, k) => { let v = r; for (const p of k.split(/->>?/)) v = v?.[p]; return v ?? null; };
function db(seed, { missingLinks = false } = {}) {
  const tables = { workspace_context_file_versions: [], workspace_context_repos: [], claim_links: [], ...structuredClone(seed) };
  class Q {
    constructor(t) { this.t = t; this.f = []; this.lim = Infinity; }
    select() { return this; } order() { return this; } or() { return this; } limit(n) { this.lim = n; return this; }
    eq(k, v) { this.f.push(r => get(r, k) === v); return this; }
    is(k, v) { this.f.push(r => get(r, k) === v); return this; }
    in(k, vs) { this.f.push(r => vs.includes(get(r, k))); return this; }
    gt(k, v) { this.f.push(r => String(get(r, k)) > String(v)); return this; }
    lte(k, v) { this.f.push(r => String(get(r, k)) <= String(v)); return this; }
    like(k, p) { const re = new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`); this.f.push(r => re.test(get(r, k) ?? '')); return this; }
    insert(v) { this.op = 'insert'; this.v = v; return this; }
    update(v) { this.op = 'update'; this.v = v; return this; }
    run(one) {
      if (missingLinks && this.t === 'claim_links') return { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.claim_links' in the schema cache" } };
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
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OBJ = id(1), LINKED = id(2), PAIRED = id(3), LOSS = id(4), BLOCK = id(5), STAFF = id(6), OPEN = id(7);
const ours = (extra = {}) => ({ side: 'ours', about: 'company', ...extra });
const claim = (cid, entity_id, valid_from, category, content, metadata = {}) =>
  ({ id: cid, workspace_id: WS, entity_id, property: `note.${cid}`, invalid_at: null, valid_from, value: { category, content, metadata } });
const link = (from, to) => ({ id: `l-${from.slice(-2)}-${to.slice(-2)}`, workspace_id: WS, from_claim_id: from, to_claim_id: to, kind: 'caused_by', archived_at: null });

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
  deal_outcomes: [{ workspace_id: WS, entity_id: 'a1', outcome: 'lost', closed_at: '2026-10-25T00:00:00Z' }],
  claims: [
    claim(OBJ, 'p1', '2026-10-12T00:00:00Z', 'objection', 'Ines worried recordings would leave the EU, now resolved.', { status: 'resolved', source_ref: 'source://fireflies/m1' }),
    // Linked: the record says this reply resolved it, though it shares few words with the objection.
    claim(LINKED, 'a1', '2026-10-12T00:00:00Z', 'our_reply', 'Pointed to the Frankfurt region in the security doc.', ours({ answers: 'Data location', source_ref: 'source://fireflies/m9' })),
    // Paired by the old rule (same conversation): shown only when nothing is linked.
    claim(PAIRED, 'a1', '2026-10-12T00:00:00Z', 'our_reply', 'Answered the EU worry by offering a call with our security lead.', ours({ answers: 'EU recordings', source_ref: 'source://fireflies/m1' })),
    // The lost deal: the budget freeze (blocker) caused the pause; the pause also had a staff cause.
    claim(LOSS, 'a1', '2026-10-20T00:00:00Z', 'risk_signal', 'Brindle paused the rollout for the year.', { severity: 'at_risk' }),
    claim(BLOCK, 'a1', '2026-10-18T00:00:00Z', 'blocker', 'Brindle froze its budget for new tools.', { status: 'open' }),
    claim(STAFF, 'a1', '2026-10-17T00:00:00Z', 'staff_change', "Brindle's CFO left.", { change: 'left' }),
    claim(OPEN, 'p1', '2026-10-13T00:00:00Z', 'objection', 'Ines doubts the HubSpot sync keeps up.', { status: 'open', source_ref: 'source://fireflies/m1' }),
  ],
  claim_links: [link(OBJ, LINKED), link(LOSS, BLOCK), link(LOSS, STAFF)],
});

test('answersFromLinks: our replies linked to an objection, either way round; never a buyer claim', () => {
  const s = seed();
  const byId = new Map(s.claims.map(c => [c.id, c]));
  const got = answersFromLinks([OBJ, OPEN], [link(OBJ, LINKED), link(PAIRED, OPEN), link(OPEN, STAFF)], byId);
  assert.deepEqual(got.get(OBJ), ['Pointed to the Frankfurt region in the security doc.']);
  assert.deepEqual(got.get(OPEN), ['Answered the EU worry by offering a call with our security lead.'], 'reply caused_by objection counts too');
  assert.deepEqual(answersFromLinks([OBJ], [], byId), new Map());
});

test('lostBecauseLines: objections and blockers linked as causes of the deal\'s facts, nothing else', () => {
  const s = seed();
  const byId = new Map(s.claims.map(c => [c.id, c]));
  assert.deepEqual(lostBecauseLines(s.claims.map(c => c.id), s.claim_links, byId),
    ['[blocker] Brindle froze its budget for new tools. (led to: Brindle paused the rollout for the year.)']);
  // An effect outside the deal is not this deal's reason.
  assert.deepEqual(lostBecauseLines([BLOCK], s.claim_links, byId), []);
});

test('the prompt lines: "answered by:" from a link wins over "we answered:"; "lost because:" on a lost deal', () => {
  const p = buildObjectionsPrompt({ current: '# Objection playbook', items: [
    { account: 'Brindle', said_at: '2026-10-12', status: 'resolved', content: 'EU recordings.', answered_by: ['Pointed to Frankfurt.'], answered: ['Offered a call.'], after: [] },
    { account: 'Atlas', said_at: '2026-10-13', content: 'Too pricey.', answered: ['Offered the annual plan.'], after: [] },
  ] });
  assert.match(p, /1\. Brindle · 2026-10-12 · resolved\n   EU recordings\.\n   answered by: Pointed to Frankfurt\.\n/);
  assert.doesNotMatch(p, /Offered a call/);
  assert.match(p, /2\. Atlas · 2026-10-13\n   Too pricey\.\n   we answered: Offered the annual plan\./);
  const w = buildWinLossPrompt({ current: '# Win/loss', deals: [
    { outcome: 'lost', account: 'Brindle', closed_at: '2026-10-25T00:00:00Z', notes: [], lost_because: ['[blocker] Budget frozen. (led to: Rollout paused.)'] },
  ] });
  assert.match(w, /lost because \(the record links these as causes\):\n   - \[blocker\] Budget frozen\. \(led to: Rollout paused\.\)/);
});

const answer = (file) => async ({ messages }) => {
  const [, heading, bullet] = file.match(/\n## (.+)\n(- .+)$/);
  const ops = { operations: [{ op: 'add_section', heading, level: 2, blocks: [bullet] }] };
  return { model: 'm', usage: {}, content: [{ type: 'text', text: JSON.stringify(ops) }], _prompt: messages[0].content };
};

test('the objection pass: the linked reply is "answered by:"; an objection with no link falls back to the pairing', async () => {
  const sb = db(seed());
  let prompt = null;
  const model = async (o) => { prompt = o.messages[0].content; return answer('# Objection playbook\n\n## EU data\n- Brindle.')(o); };
  assert.equal((await runLivingFile(sb, sb.tables.workspace_living_files[0], { model })).status, 'updated');
  assert.match(prompt, /now resolved\.\n   answered by: Pointed to the Frankfurt region in the security doc\./);
  assert.doesNotMatch(prompt, /now resolved\.\n   we answered/);
  assert.match(prompt, /HubSpot sync keeps up\.\n   we answered: Answered the EU worry/, 'no link: the same-conversation pairing, as before');
});

test('the win/loss pass: a lost deal lists what the record links as its cause', async () => {
  const sb = db(seed());
  let prompt = null;
  const model = async (o) => { prompt = o.messages[0].content; return answer('# Win/loss\n\n## Budget freezes\n- Brindle froze budget.')(o); };
  assert.equal((await runLivingFile(sb, sb.tables.workspace_living_files[1], { model })).status, 'updated');
  assert.match(prompt, /lost because \(the record links these as causes\):\n   - \[blocker\] Brindle froze its budget for new tools\. \(led to: Brindle paused the rollout for the year\.\)/);
  assert.doesNotMatch(prompt, /claim_ids|00000000-0000/, 'ids never reach the prompt');
});

test('without the claim_links table both files read exactly as before', async () => {
  const sb = db(seed(), { missingLinks: true });
  const prompts = [];
  const model = async (o) => { prompts.push(o.messages[0].content); return answer('# File\n\n## Section\n- Brindle.')(o); };
  await runLivingFile(sb, sb.tables.workspace_living_files[0], { model });
  await runLivingFile(sb, sb.tables.workspace_living_files[1], { model });
  assert.match(prompts[0], /now resolved\.\n   we answered: Answered the EU worry/, 'the pairing, as before links');
  assert.doesNotMatch(prompts[0], /answered by:/);
  assert.doesNotMatch(prompts[1], /lost because/);
});
