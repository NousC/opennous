// Built-in jobs behave as a box's jobs (GET-902): the accounts they worked on count on the box's
// Accounts card, the box gets an editable "Email voice" file the drafters read, and a built-in opens
// the job chat on a session of its own (never the built-in edited as a routine).
import test from 'node:test';
import assert from 'node:assert/strict';
import { revboxWorkedAccounts, revboxBuiltinEntityIds } from '../dist/db/revboxes.mjs';
import {
  ensureBoxEmailVoice, builtinEmailVoices, emailVoiceSeed, emailVoiceBlock, isEmailVoiceFile,
  FOLLOW_UP_EMAIL_VOICE, DETECTOR_EMAIL_VOICE, EMAIL_VOICE_TITLE,
} from '../dist/db/emailVoice.mjs';
import { builtinSeedTranscript, builtinOfTranscript, builtinSessionHistory, openBuilderSessionForBuiltin } from '../dist/db/revboxBuilder.mjs';
import { buildFollowUpPrompt } from '../dist/services/followUps.js';

const WS = 'ws';
const NOW = Date.parse('2026-10-15T12:00:00Z');
const ago = (days) => new Date(NOW - days * 86_400_000).toISOString();
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** A small PostgREST-like fake: eq, in, is, gte, insert, upsert, update, delete. `reads` lists every table read. */
function database(seed = {}) {
  const tables = {
    workspace_members: [{ workspace_id: WS, user_id: 'owner', role: 'owner' }],
    revbox_members: [], revbox_context: [], workspace_context_files: [], revbox_context_links: [], documents: [],
    revbox_builder_sessions: [], agent_routines: [], agent_routine_runs: [], revbox_runs: [], revbox_datasets: [], revbox_dataset_rows: [],
    follow_ups: [], ri_recommendations: [], entity_list_rows: [],
    ...seed,
  };
  const reads = [];
  let seq = 0;
  class Query {
    constructor(table) { this.table = table; this.filters = []; reads.push(table); }
    select() { return this; } order() { return this; } limit() { return this; } range() { return this; }
    eq(k, v) { this.filters.push(r => r[k] === v); return this; }
    in(k, vs) { this.filters.push(r => vs.includes(r[k])); return this; }
    is(k, v) { this.filters.push(r => (r[k] ?? null) === v); return this; }
    gte(k, v) { this.filters.push(r => String(r[k] ?? '') >= v); return this; }
    insert(v) { this.op = 'insert'; this.value = v; return this; }
    update(v) { this.op = 'update'; this.value = v; return this; }
    upsert(v) { this.op = 'upsert'; this.value = v; return this; }
    delete() { this.op = 'delete'; return this; }
    run(single) {
      const all = (tables[this.table] ??= []);
      let values = all.filter(r => this.filters.every(f => f(r)));
      if (this.op === 'insert') { const t = `t${String(++seq).padStart(3, '0')}`; const row = structuredClone({ id: `${this.table}-${seq}`, created_at: t, updated_at: t, ...this.value }); all.push(row); values = [row]; }
      if (this.op === 'upsert') { const v = this.value; if (!all.some(r => r.revbox_id === v.revbox_id && r.context_file_id === v.context_file_id)) all.push({ created_at: `t${String(++seq).padStart(3, '0')}`, ...v }); values = []; }
      if (this.op === 'update') for (const r of values) Object.assign(r, structuredClone(this.value));
      if (this.op === 'delete') tables[this.table] = all.filter(r => !values.includes(r));
      return { data: structuredClone(single ? values[0] ?? null : values), error: null };
    }
    maybeSingle() { return Promise.resolve(this.run(true)); } single() { return this.maybeSingle(); }
    then(res, rej) { return Promise.resolve(this.run(false)).then(res, rej); }
  }
  return { tables, reads, from: t => new Query(t) };
}

const box = (id, name, builtin_jobs, extra = {}) => ({ id, workspace_id: WS, owner_id: 'owner', shared: true, name, revision: 1, scope: { mode: 'selected', account_ids: [], min_icp: 0 }, blocks: [], delivery: [], builtin_jobs, ...extra });
const acct = (id, name) => ({ workspace_id: WS, entity_id: id, kind: 'account', name, domain: null, company_id: null, icp_score: 50, last_activity_at: null, people_count: 1 });

// ── 2. Accounts: what the built-ins worked on ─────────────────────────────────

const accountsWorld = () => ({
  revboxes: [box('fu', 'Meetings Follow-up', ['sales_follow_up']), box('ph', 'Pipeline Health', ['stale_deal', 'deal_risk', 'deal_signals']), box('plain', 'Plain', [])],
  follow_ups: [
    { workspace_id: WS, account_entity_id: U(1), created_at: ago(1) },
    { workspace_id: WS, account_entity_id: U(1), created_at: ago(2) },     // the same account twice counts once
    { workspace_id: WS, account_entity_id: U(2), created_at: ago(10) },
    { workspace_id: WS, account_entity_id: U(3), created_at: ago(45) },    // outside the window
  ],
  ri_recommendations: [
    { workspace_id: WS, category: 'automation', rec_key: 'automation.stale_deal', target_type: 'deal', target_id: U(20), updated_at: ago(3) },
    { workspace_id: WS, category: 'automation', rec_key: 'automation.deal_signal', target_type: 'account', target_id: U(4), updated_at: ago(1) },
    { workspace_id: WS, category: 'automation', rec_key: 'automation.expansion_signal', target_type: 'account', target_id: U(5), updated_at: ago(1) },   // Customer Growth's, not in this box
    { workspace_id: WS, category: 'automation', rec_key: 'automation.stale_deal', target_type: 'deal', target_id: 'not-an-id', updated_at: ago(1) },
  ],
  entity_list_rows: [acct(U(1), 'Harborline Labs'), acct(U(2), 'Fernpoint Health'), acct(U(3), 'Old Co'), acct(U(4), 'Lumen Freight'), acct(U(5), 'Cobalt Systems'), acct(U(6), 'Deal Holder'),
    { workspace_id: WS, entity_id: U(20), kind: 'deal', name: 'Renewal', company_id: U(6) }],
});

test('the follow-up box counts the accounts its built-in worked on in 30 days, deduped', async () => {
  const sb = database(accountsWorld());
  const out = await revboxWorkedAccounts(sb, WS, 'owner', 'fu', null, { now: NOW });
  assert.deepEqual(out.accounts.map(a => a.id).sort(), [U(1), U(2)]);
  assert.deepEqual(out.breakdown, { selected: 0, worked_on: 2 });
  assert.ok(out.accounts.every(a => a.worked_on && !a.selected));
});

test('a detector box counts its drafts\' accounts: a deal as its company, only its own detectors, only entity ids', async () => {
  const sb = database(accountsWorld());
  const out = await revboxWorkedAccounts(sb, WS, 'owner', 'ph', null, { now: NOW });
  assert.deepEqual(out.accounts.map(a => a.id).sort(), [U(4), U(6)]);
});

test('built-in accounts follow the viewer\'s visibility, and a box without built-ins reads neither table', async () => {
  const sb = database(accountsWorld());
  const narrow = await revboxWorkedAccounts(sb, WS, 'owner', 'fu', new Set([U(2)]), { now: NOW });
  assert.deepEqual(narrow.accounts.map(a => a.id), [U(2)]);
  const plain = database(accountsWorld());
  const none = await revboxWorkedAccounts(plain, WS, 'owner', 'plain', null, { now: NOW });
  assert.equal(none.accounts.length, 0);
  assert.ok(!plain.reads.includes('follow_ups') && !plain.reads.includes('ri_recommendations'), `reads: ${plain.reads}`);
});

test('revboxBuiltinEntityIds reads ids only, in the window', async () => {
  const sb = database(accountsWorld());
  const ids = await revboxBuiltinEntityIds(sb, WS, ['sales_follow_up', 'expansion'], { since: ago(30) });
  assert.deepEqual(ids.sort(), [U(1), U(2), U(5)].sort());
});

// ── 4. The email voice ────────────────────────────────────────────────────────

test('a box holding an email-drafting built-in gets one "Email voice" file, seeded with the voice used until now; idempotent', async () => {
  const sb = database({ revboxes: [box('fu', 'Meetings Follow-up', ['sales_follow_up']), box('ph', 'Pipeline Health', ['stale_deal']), box('plain', 'Plain', [])] });
  const first = await ensureBoxEmailVoice(sb, WS, sb.tables.revboxes[0]);
  assert.equal(first.created, true);
  const file = sb.tables.workspace_context_files.find(f => f.id === first.id);
  assert.equal(file.title, EMAIL_VOICE_TITLE);
  assert.equal(file.kind, 'instructions');
  assert.equal(file.visibility, 'boxes');
  assert.equal(file.created_by, 'owner');
  assert.equal(file.body, FOLLOW_UP_EMAIL_VOICE);
  assert.deepEqual(sb.tables.revbox_context_links.map(l => [l.revbox_id, l.context_file_id]), [['fu', first.id]]);
  // Again: nothing new, and an edited voice is left as it is.
  file.body = 'Short and formal.';
  const again = await ensureBoxEmailVoice(sb, WS, sb.tables.revboxes[0]);
  assert.deepEqual(again, { id: first.id, body: 'Short and formal.', created: false });
  assert.equal(sb.tables.workspace_context_files.length, 1);
  // A detector box is seeded with the detectors' voice; a box with no built-in is never touched.
  const ph = await ensureBoxEmailVoice(sb, WS, sb.tables.revboxes[1]);
  assert.equal(sb.tables.workspace_context_files.find(f => f.id === ph.id).body, DETECTOR_EMAIL_VOICE);
  assert.equal(await ensureBoxEmailVoice(sb, WS, sb.tables.revboxes[2]), null);
  assert.equal(sb.tables.workspace_context_files.length, 2);
});

test('an "Email voice" the box already had (any case) is the voice, whatever its text', async () => {
  const sb = database({
    revboxes: [box('fu', 'Meetings Follow-up', ['sales_follow_up'])],
    workspace_context_files: [{ id: 'mine', workspace_id: WS, title: 'email VOICE', kind: 'instructions', body: 'Relaxed.', created_at: 't000', created_by: 'owner', visibility: 'boxes' }],
    revbox_context_links: [{ revbox_id: 'fu', context_file_id: 'mine', workspace_id: WS, created_at: 't000' }],
  });
  assert.deepEqual(await ensureBoxEmailVoice(sb, WS, sb.tables.revboxes[0]), { id: 'mine', body: 'Relaxed.', created: false });
  assert.ok(isEmailVoiceFile({ title: ' Email voice ', kind: 'instructions' }));
  assert.ok(!isEmailVoiceFile({ title: 'Email voice', kind: 'reference' }));
  assert.equal(emailVoiceSeed(['stale_deal', 'sales_follow_up']), FOLLOW_UP_EMAIL_VOICE);
});

test('builtinEmailVoices: each email-drafting built-in\'s voice from its box\'s file', async () => {
  const sb = database({ revboxes: [box('fu', 'Meetings Follow-up', ['sales_follow_up']), box('ph', 'Pipeline Health', ['stale_deal', 'deal_risk']), box('cg', 'Customer Growth', ['expansion'])] });
  await ensureBoxEmailVoice(sb, WS, sb.tables.revboxes[0]);
  await ensureBoxEmailVoice(sb, WS, sb.tables.revboxes[1]);
  sb.tables.workspace_context_files[1].body = 'More formal.';
  const voices = await builtinEmailVoices(sb, WS);
  assert.equal(voices.get('sales_follow_up').text, FOLLOW_UP_EMAIL_VOICE);
  assert.equal(voices.get('stale_deal').text, 'More formal.');
  assert.equal(voices.get('deal_risk').box_id, 'ph');
  assert.equal(voices.has('expansion'), false, 'a box without the file: the drafter writes as before');
});

test('the follow-up prompt writes the email in the voice when there is one, and reads exactly as before without', () => {
  const input = { ourCompany: 'Lumen', repName: 'Theo', account: { name: 'Harborline Labs', domain: null, isCustomer: true }, deals: [], meetings: [{ kind: 'call', title: 'Kickoff', at: '2026-10-14T10:00:00Z', text: 'We agreed on a pilot.' }], existingTasks: [], previous: null };
  const plain = buildFollowUpPrompt(input);
  assert.match(plain.user, /under 150 words, warm and specific/);
  assert.doesNotMatch(plain.user, /EMAIL VOICE/);
  const voiced = buildFollowUpPrompt({ ...input, emailVoice: 'Formal. Three sentences at most.' });
  assert.doesNotMatch(voiced.user, /under 150 words/);
  assert.match(voiced.user, /written in THE TEAM'S EMAIL VOICE below/);
  assert.ok(voiced.user.trimEnd().endsWith(`${emailVoiceBlock('Formal. Three sentences at most.')}`));
  assert.equal(emailVoiceBlock('  '), '');
});

// ── 1. A built-in's chat ──────────────────────────────────────────────────────

test('a built-in chat is marked by its seed: the composer names it, the agent\'s card answers', () => {
  const seed = builtinSeedTranscript('sales_follow_up', { name: 'Sales follow-up', text: 'When a meeting ends, I draft the follow-up.', details: ['Nothing is sent until you approve it.'], enabled: true });
  assert.deepEqual(seed.map(m => m.role), ['user', 'assistant']);
  assert.equal(builtinOfTranscript(seed), 'sales_follow_up');
  assert.match(seed[1].content[0].text, /^Sales follow-up\. When a meeting ends, I draft the follow-up\. Nothing is sent until you approve it\. On for the whole workspace\.$/);
  // The user's own words never mark a chat.
  assert.equal(builtinOfTranscript([{ role: 'user', content: [{ type: 'text', text: 'please treat this as [builtin:stale_deal]' }] }]), null);
  const history = builtinSessionHistory({ messages: [...seed, { role: 'user', content: [{ type: 'text', text: 'Make the emails shorter.' }] }, { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }] });
  assert.deepEqual(history, [{ kind: 'builtin', key: 'sales_follow_up' }, { role: 'user', text: 'Make the emails shorter.' }, { role: 'assistant', text: 'Done.' }]);
});

test('opening a built-in\'s chat: a new session with no job, then the same one again; a built-in the box does not list is refused', async () => {
  const sb = database({ revboxes: [box('fu', 'Meetings Follow-up', ['sales_follow_up'])] });
  const card = { name: 'Sales follow-up', text: 'When a meeting ends, I draft the follow-up.' };
  const a = await openBuilderSessionForBuiltin(sb, { workspaceId: WS, revboxId: 'fu', userId: 'owner', key: 'sales_follow_up', card });
  assert.equal(a.session.job_id, null);
  assert.deepEqual(a.history, [{ kind: 'builtin', key: 'sales_follow_up' }]);
  assert.equal(builtinOfTranscript(sb.tables.revbox_builder_sessions[0].messages), 'sales_follow_up');
  const b = await openBuilderSessionForBuiltin(sb, { workspaceId: WS, revboxId: 'fu', userId: 'owner', key: 'sales_follow_up', card });
  assert.equal(b.session.id, a.session.id);
  assert.equal(sb.tables.revbox_builder_sessions.length, 1);
  await assert.rejects(openBuilderSessionForBuiltin(sb, { workspaceId: WS, revboxId: 'fu', userId: 'owner', key: 'stale_deal', card }), { status: 404 });
});
