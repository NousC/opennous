// The automation's writers read the Intelligence files (GET-1042): a pre-meeting brief, a handoff
// and a Draft follow-up are handed what the workspace has learned for that account, told how to use
// it, never leak its ids into what they write, and the run's log line says which points they were
// shown. The follow-up cards' prompt builder takes it the same way.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/intelligenceInWriters.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeArtifactForTest, runStepsForTest as runSteps } from '../dist/services/automationRun.mjs';
import { registerIntelligenceSource } from '../dist/intelligenceContext.mjs';
import { intelligenceRule, withoutIntelligenceRefs } from '../dist/intelligencePrompt.mjs';
import { buildFollowUpPrompt, parseFollowUpAnswer } from '../dist/services/followUps.js';
import { registerAnthropicClient } from '../dist/llm/modelDoor.mjs';

const INTEL = [
  '## Intelligence',
  '',
  '### Objection playbook — Security review',
  '',
  'Send the SOC 2 report before the legal call; it shortened the last three reviews. [objections:b1a2b3c4]',
  '',
  '### Battlecards — Brackwater',
  '',
  'They win on price; we win on rollout time. [battlecards:9f00e1a2]',
].join('\n');

// A database that holds one account and nothing else: every read answers empty.
function fakeDb() {
  const inserted = [];
  return {
    inserted,
    from(table) {
      let row = null;
      const q = new Proxy({}, {
        get(_t, prop) {
          if (prop === 'then') return (ok) => Promise.resolve({ data: row ? [row] : [], error: null }).then(ok);
          if (prop === 'insert') return (r) => { row = { id: `${table}-${inserted.length + 1}`, version: 1, ...r }; inserted.push({ table, row }); return q; };
          if (prop === 'single') return async () => ({ data: row, error: null });
          if (prop === 'maybeSingle') return async () => ({ data: table === 'companies' ? { name: 'Quillmere', domain: 'quillmere.example' } : null, error: null });
          return () => q;
        },
      });
      return q;
    },
  };
}

async function withModel(answer, fn) {
  const asks = [];
  const before = process.env.WRITING_MODEL;
  process.env.WRITING_MODEL = 'claude-haiku-4-5-20251001';
  registerAnthropicClient({ messages: { create: async (a) => { asks.push(a); return { model: 'm', stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: answer }] }; } } }, { acceptsFeature: false });
  try { return await fn(asks); } finally {
    if (before === undefined) delete process.env.WRITING_MODEL; else process.env.WRITING_MODEL = before;
    registerAnthropicClient(null);
  }
}

function withSource(fn) {
  const calls = [];
  registerIntelligenceSource(async (_sb, ws, opts) => { calls.push({ ws, ...opts }); return { text: INTEL, used: [] }; });
  return Promise.resolve(fn(calls)).finally(() => registerIntelligenceSource(null));
}

const sys = (a) => (typeof a.system === 'string' ? a.system : JSON.stringify(a.system));

test('a Draft follow-up reads the account\'s Intelligence as a draft, never writes its ids, and says which points it was shown', async () => {
  await withSource(async (calls) => withModel('Subject Next step on the review\n\nHi Ines,\n\nI will send the SOC 2 report before the legal call. [objections:b1a2b3c4]\n\nTheo', async (asks) => {
    const db = fakeDb();
    const doc = await makeArtifactForTest(db, 'w1', { entityId: 'a1', stage: 'call_ended', prompt: null, format: 'email' });
    assert.deepEqual(calls.map(c => [c.ws, c.companyId, c.purpose]), [['w1', 'a1', 'draft']]);
    const material = JSON.parse(asks[0].messages[0].content);
    assert.equal(material.intelligence, INTEL);
    assert.match(sys(asks[0]), /never quote it, and never tell the buyer it exists/);
    const body = doc.sections.map(s => s.body).join('\n');
    assert.match(body, /SOC 2 report before the legal call\./);
    assert.doesNotMatch(body, /\[objections:/);
    assert.deepEqual(doc.intelligence, ['objections:b1a2b3c4', 'battlecards:9f00e1a2']);
  }));
});

test('a brief reads it as a brief and its sections lose any id the writer echoed', async () => {
  await withSource(async (calls) => withModel('## Executive Summary\nQuillmere is reviewing security. Send the SOC 2 report first. [objections:b1a2b3c4]', async (asks) => {
    const doc = await makeArtifactForTest(fakeDb(), 'w1', { entityId: 'a1', stage: 'premeeting', prompt: 'Write a pre-meeting brief.' });
    assert.equal(calls[0].purpose, 'brief');
    assert.match(sys(asks[0]), /WHAT HAS WORKED BEFORE/);
    assert.doesNotMatch(doc.sections.map(s => s.body).join('\n'), /\[objections:/);
    assert.deepEqual(doc.intelligence, ['objections:b1a2b3c4', 'battlecards:9f00e1a2']);
  }));
});

test('no Intelligence (a self-hosted install): the material and the prompt are as they were', async () => {
  await withModel('Subject Hello\n\nHi,\n\nShort note.\n\nTheo', async (asks) => {
    const doc = await makeArtifactForTest(fakeDb(), 'w1', { entityId: 'a1', stage: 'call_ended', prompt: null, format: 'email' });
    assert.equal('intelligence' in JSON.parse(asks[0].messages[0].content), false);
    assert.doesNotMatch(sys(asks[0]), /WHAT HAS WORKED BEFORE/);
    assert.equal(doc.intelligence, undefined);
  });
});

test('"View context" shows the Intelligence the writer would be handed', async () => {
  await withSource(async () => {
    const { material } = await makeArtifactForTest(fakeDb(), 'w1', { entityId: 'a1', stage: 'closed_won', prompt: null, materialOnly: true });
    assert.equal(material.intelligence, INTEL);
  });
});

test('the AI step\'s line in the run log keeps the points its document was shown', async () => {
  const doc = { id: 'd1', title: 'Quillmere — follow-up', headline: 'Next step', sections: [{ label: 'Email', body: 'Hi' }], intelligence: ['objections:b1a2b3c4'] };
  const r = await runSteps({ id: 'r1', name: 'Follow-up', user_id: 'u1', steps: [{ id: 'a', type: 'agent', config: {} }] }, doc,
    { stage: 'call_ended', ctx: { supabase: fakeDb(), workspaceId: 'w1', entityId: null } });
  assert.deepEqual(r.log.find(x => x.id === 'a').intelligence, ['objections:b1a2b3c4']);
});

test('the rule and the cleaner', () => {
  assert.match(intelligenceRule('draft'), /never tell the buyer it exists/);
  assert.doesNotMatch(intelligenceRule('brief'), /buyer it exists/);
  assert.equal(withoutIntelligenceRefs('Send it first. [objections:b1a2b3c4]\n[icp:learned] Next.'), 'Send it first.\n Next.');
  assert.equal(withoutIntelligenceRefs('A cite stays.[c1a2]'), 'A cite stays.[c1a2]');
});

test('the follow-up card prompt carries the Intelligence and the rule only when there is some', () => {
  const base = {
    ourCompany: 'Lanternfold', repName: 'Theo', account: { name: 'Quillmere', domain: 'quillmere.example', isCustomer: false },
    deals: [], meetings: [{ kind: 'call', title: 'Review', at: '2026-10-20T15:00:00Z', text: 'Security came up.' }], existingTasks: [], previous: null,
  };
  const plain = buildFollowUpPrompt(base);
  const withIntel = buildFollowUpPrompt({ ...base, intelligence: INTEL });
  assert.doesNotMatch(plain.user, /WHAT HAS WORKED BEFORE|objections:b1a2b3c4/);
  assert.match(withIntel.user, /WHAT HAS WORKED BEFORE/);
  assert.match(withIntel.user, /Send the SOC 2 report before the legal call/);
});

test('a follow-up card\'s email loses any id the writer echoed', () => {
  const answer = JSON.stringify({ summary: 'Security review.', tasks: [], updates: [], email: { subject: 'Next step [battlecards:9f00e1a2]', body: 'Hi Ines,\n\nThe SOC 2 report is attached. [objections:b1a2b3c4]\n\nTheo' } });
  const c = parseFollowUpAnswer(answer, { recipients: ['ines@quillmere.example'] });
  assert.equal(c.email.subject, 'Next step');
  assert.doesNotMatch(c.email.body, /\[objections:/);
});
