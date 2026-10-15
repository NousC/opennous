// A task from an internal call closes on the email its owner sent (GET-904).
//
// The shape that stayed open: a co-founder call files "share both team mailboxes with Mareck so
// he can open a shared Slack channel" on its owner, a teammate. The owner then emails Marek (the
// address book spells him with one less letter) the two addresses. The email is filed on Marek;
// the task on the teammate. The engine only ever looked at the record the task sits on, so it
// never saw the email; and its cheap rule closed the call's "draft the email to Mareck" task on
// an unrelated digest that happened to copy the teammate.
//
// Run: node --test packages/core/test/taskEmailClosure.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoCloseActionItems } from '../dist/services/actionItemClosure.mjs';
import { closeActionItemsForActivity } from '../dist/services/actionItems.js';
import {
  nameLike, namesPerson, emailCandidatesFor, settleVerdict, parseEmailVerdict, emailReason, taskEvidenceForViewer,
} from '../dist/services/taskEmailClosure.mjs';
import { ModelUnavailableError } from '../dist/llm/modelDoor.mjs';

delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENROUTER_API_KEY;

const WS = 'ws-1';
const HOUR = 3_600_000;
const T0 = Date.now() - 3 * 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();

// ── a small, honest stub: filters, aliases, pages, and writes that land ──────

function pick(row, path) {
  const m = /^(\w+)->>?(\w+)$/.exec(path);
  if (!m) return row[path];
  const base = row[m[1]];
  return base && typeof base === 'object' ? base[m[2]] ?? null : null;
}

function makeDb(tables) {
  const writes = [];
  const from = (table) => {
    let rows = () => tables[table] ?? [];
    const filters = [];
    let cols = null, sort = null, lo = 0, hi = Infinity, update = null;
    const q = {
      select(c) { cols = c; return q; },
      eq(col, val) { filters.push((r) => pick(r, col) === val); return q; },
      in(col, vals) { filters.push((r) => vals.includes(pick(r, col))); return q; },
      gte(col, val) { filters.push((r) => String(pick(r, col)) >= String(val)); return q; },
      lt(col, val) { filters.push((r) => String(pick(r, col)) < String(val)); return q; },
      is(col, val) { filters.push((r) => (pick(r, col) ?? null) === val); return q; },
      or() { return q; }, like() { return q; }, not() { return q; },
      order(col, o = {}) { if (!sort) sort = { col, asc: o.ascending !== false }; return q; },
      range(a, b) { lo = a; hi = b + 1; return q; },
      limit(n) { hi = n; return q; },
      update(v) { update = v; return q; },
      then(res, rej) {
        try {
          let data = rows().filter((r) => filters.every((f) => f(r)));
          if (update) {
            for (const r of data) { Object.assign(r, update); writes.push({ table, id: r.id, ...update }); }
            return res({ data: null, error: null });
          }
          if (sort) data = [...data].sort((a, b) => (String(a[sort.col]) < String(b[sort.col]) ? -1 : 1) * (sort.asc ? 1 : -1));
          data = data.slice(lo, hi);
          if (cols) {
            const parts = cols.split(',').map((s) => s.trim());
            data = data.map((r) => Object.fromEntries(parts.map((p) => {
              const [alias, path] = p.includes(':') ? p.split(':') : [p.replace(/^.*->>?/, ''), p];
              return [alias, pick(r, path) ?? null];
            })));
          }
          return res({ data, error: null });
        } catch (e) { return rej ? rej(e) : Promise.reject(e); }
      },
    };
    return q;
  };
  return { from, writes, tables };
}

// ── the world ─────────────────────────────────────────────────────────────────

const AVERY = 'p-avery';          // the teammate who owes it
const MAREK = 'p-marek';          // the customer's lead, at Fernpoint
const QUINN = 'p-quinn';          // somebody else entirely

const BODY = [
  'Hi Marek,',
  '',
  'Here are the addresses to add to the Slack channel:',
  '1. avery@harborline.example',
  '2. sam@harborline.example',
  '',
  'A few things to line up before we start: an NDA, what you need from our side, and a walkthrough of your CRM.',
].join('\n');

function world({ extraEmails = [], tasks } = {}) {
  const task = (i, title, extra = {}) => ({
    id: `c-${i}`, workspace_id: WS, entity_id: AVERY, property: `action_item.internal_granola_m1_${i}_0`,
    computed_at: iso(T0 + HOUR), invalid_at: null,
    value: {
      title, status: 'open', owner_kind: 'user', owner_name: 'Avery Lund', owner_email: 'avery@harborline.example',
      internal_meeting: true, source_type: 'internal_meeting', source_title: 'Slack setup with the team',
      occurred_at: iso(T0), client: 'Mareck', ...extra,
    },
  });
  const claim = (entity, property, value) => ({ id: `${entity}-${property}`, workspace_id: WS, entity_id: entity, property, value, invalid_at: null });
  return makeDb({
    claims: [
      ...(tasks ?? [
        task(3, 'Share both team mailboxes with Mareck so he can create a shared Slack channel.'),
        task(2, 'Draft email to Mareck covering professional setup, NDA, expectations, and next steps.'),
      ]).map((t) => (typeof t === 'function' ? t(task) : t)),
      claim(AVERY, 'is_internal', true),
      claim(AVERY, 'first_name', 'Avery'), claim(AVERY, 'last_name', 'Lund'),
      claim(MAREK, 'first_name', 'Marek'), claim(MAREK, 'last_name', 'Thorne'),
      claim(QUINN, 'first_name', 'Quinn'), claim(QUINN, 'last_name', 'Abbott'),
    ],
    contacts: [],
    entity_identifiers: [{ workspace_id: WS, entity_id: AVERY, kind: 'email', value: 'avery@harborline.example' }],
    observations: [
      // A digest from another teammate's mailbox that copies Avery: it lands on Avery's own record.
      ...[AVERY, QUINN].map((e) => ({
        id: `o-digest-${e}`, workspace_id: WS, entity_id: e, property: 'interaction.email_sent', source: 'gmail',
        observed_at: iso(T0 + 17 * HOUR), owner_user_id: 'u-sam', source_ref: `source://gmail/digest_${e}`,
        value: { summary: 'Hi Quinn', description: 'Hi Quinn, the weekly closed-won digest.' },
        raw: { from: 'sam@harborline.example', to: ['quinn@lumen.example'], cc: ['avery@harborline.example'], is_outbound: true, body_text: 'Hi Quinn, the weekly closed-won digest.', mailbox_owner_ids: ['u-sam'] },
      })),
      {
        id: 'o-addresses', workspace_id: WS, entity_id: MAREK, property: 'interaction.email_sent', source: 'gmail',
        observed_at: iso(T0 + 30 * HOUR), owner_user_id: 'u-avery', source_ref: 'source://gmail/addr_p-marek',
        value: { summary: 'Hi Marek', description: BODY.slice(0, 120) },
        raw: { from: 'avery@harborline.example', to: ['marek@fernpoint.example'], cc: [], is_outbound: true, subject: 'Slack channel', body_text: BODY, mailbox_owner_ids: ['u-avery'] },
      },
      ...extraEmails,
    ],
  });
}

const status = (db, id) => db.tables.claims.find((c) => c.id === id).value;

/** A judge that reads the email the way the model is asked to, for the two tasks of the call. */
function judgeOf(log = []) {
  return async (task, emails) => {
    log.push({ title: task.row.value.title, emails: emails.map((e) => e.id), body: emails[0].body });
    const t = task.row.value.title;
    if (/^Share both/.test(t)) return { verdict: 'done', email: 0, quote: 'Here are the addresses to add to the Slack channel:', what: 'the Slack channel addresses' };
    if (/^Draft email/.test(t)) return { verdict: 'done', email: 0, quote: 'A few things to line up before we start: an NDA', what: 'the setup and NDA email' };
    return { verdict: 'no', email: 0, quote: '', what: '' };
  };
}

// ── the case ──────────────────────────────────────────────────────────────────

test('the internal-call task closes on the email its owner sent the person it names, with that email as evidence', async () => {
  const db = world();
  const log = [];
  const closed = await autoCloseActionItems(db, WS, { emailJudge: judgeOf(log) });

  const share = status(db, 'c-3');
  assert.equal(share.status, 'done');
  assert.equal(share.completed_by, 'auto');
  assert.equal(share.completed_reason, 'Avery emailed Marek the Slack channel addresses');
  assert.equal(share.completed_at, iso(T0 + 30 * HOUR), 'closed as of the email, not as of the sweep');
  assert.equal(share.completed_evidence.kind, 'email');
  assert.equal(share.completed_evidence.observation_id, 'o-addresses');
  assert.equal(share.completed_evidence.with, MAREK);
  assert.equal(share.completed_evidence.source_url, `/people/${MAREK}`);
  assert.match(share.completed_evidence.quote, /addresses to add to the Slack channel/);

  // The judge read the whole message, from the owner's mailbox, and nothing from the digest.
  const read = log.find((l) => /^Share/.test(l.title));
  assert.deepEqual(read.emails, ['o-addresses']);
  assert.match(read.body, /line up before we start/);

  // The other task from the same call is done by the same email, and closes on it, not on the digest.
  const draft = status(db, 'c-2');
  assert.equal(draft.status, 'done');
  assert.equal(draft.completed_evidence.observation_id, 'o-addresses');
  assert.equal(closed.length, 2);
});

test('the digest that copies the owner does not close "draft the email to Mareck" any more', async () => {
  // No model configured, no email judge: before GET-904 the rule tier closed this on the digest.
  const db = world();
  const closed = await autoCloseActionItems(db, WS);
  assert.equal(closed.length, 0);
  assert.equal(status(db, 'c-2').status, 'open');
  assert.equal(status(db, 'c-3').status, 'open');
});

test('an email to someone the task does not name is never read for it', async () => {
  const db = world({
    tasks: [(task) => task(5, 'Send Imogen the onboarding checklist.', { client: 'Imogen' })],
  });
  const log = [];
  const closed = await autoCloseActionItems(db, WS, { emailJudge: judgeOf(log) });
  assert.equal(closed.length, 0);
  assert.equal(log.length, 0, 'no email to Imogen, so no model call');
  assert.equal(status(db, 'c-5').status, 'open');
});

test('an unrelated email to the named person stays open, and is not read again next pass', async () => {
  const db = world({
    tasks: [(task) => task(6, 'Send Mareck the signed pricing addendum.')],
  });
  const log = [];
  await autoCloseActionItems(db, WS, { emailJudge: judgeOf(log) });
  const v = status(db, 'c-6');
  assert.equal(v.status, 'open');
  assert.equal(v.close_check.email_through, iso(T0 + 30 * HOUR));
  assert.equal(v.suggested_done, undefined);

  await autoCloseActionItems(db, WS, { emailJudge: judgeOf(log) });
  assert.equal(log.length, 1, 'the same email is judged once');
});

test('a provider outage defers the task: nothing written, and the next pass closes it', async () => {
  const db = world();
  const stats = { deferred: 0 };
  let calls = 0;
  const down = async () => { calls++; throw new ModelUnavailableError('402 Payment Required'); };
  const closed = await autoCloseActionItems(db, WS, { emailJudge: down, stats });
  assert.equal(closed.length, 0);
  assert.equal(calls, 1, 'stops at the first outage instead of failing every task');
  assert.equal(stats.deferred, 2);
  assert.equal(status(db, 'c-3').status, 'open');
  assert.equal(status(db, 'c-3').close_check, undefined, 'an outage is not a "no"');

  const again = await autoCloseActionItems(db, WS, { emailJudge: judgeOf() });
  assert.equal(again.length, 2);
  assert.equal(status(db, 'c-3').status, 'done');
});

test('a probable completion does not close: it asks "looks done, close?"', async () => {
  const db = world({ tasks: [(task) => task(7, 'Share both team mailboxes with Mareck so he can create a shared Slack channel.')] });
  await autoCloseActionItems(db, WS, { emailJudge: async () => ({ verdict: 'likely', email: 0, quote: '', what: 'the Slack addresses' }) });
  const v = status(db, 'c-7');
  assert.equal(v.status, 'open');
  assert.equal(v.suggested_done.reason, 'Avery emailed Marek the Slack addresses');
  assert.equal(v.suggested_done.evidence.observation_id, 'o-addresses');
});

test('a "done" whose quote is not in the email is only a suggestion', async () => {
  const db = world({ tasks: [(task) => task(8, 'Share both team mailboxes with Mareck so he can create a shared Slack channel.')] });
  await autoCloseActionItems(db, WS, { emailJudge: async () => ({ verdict: 'done', email: 0, quote: 'I have shared both mailboxes with you today', what: '' }) });
  const v = status(db, 'c-8');
  assert.equal(v.status, 'open');
  assert.ok(v.suggested_done, 'flagged for a person instead');
});

test('the email a task was read out of never completes it', () => {
  const said = T0;
  const row = { id: 'c', entity_id: MAREK, property: 'action_item.gmail_x_0', value: { title: 'Chase Marek for the NDA', source_id: 'o-src' } };
  const people = new Map([[MAREK, { first_name: 'Marek', last_name: 'Thorne' }]]);
  const emails = [
    { id: 'o-src', entity_id: MAREK, observed_at: iso(said), from: 'avery@harborline.example' },
    { id: 'o-same-minute', entity_id: MAREK, observed_at: iso(said + 30_000), from: 'avery@harborline.example', description: 'x' },
  ];
  const out = emailCandidatesFor({ row, promisedAt: said, ownerAddrs: new Set(['avery@harborline.example']), selfFiled: false }, emails, people);
  assert.deepEqual(out, []);
});

test('only the owner\'s own sent mail counts', () => {
  const row = { id: 'c', entity_id: AVERY, property: 'action_item.internal_x', value: { title: 'Send Marek the deck' } };
  const people = new Map([[MAREK, { first_name: 'Marek', last_name: 'Thorne' }]]);
  const emails = [{ id: 'o1', entity_id: MAREK, observed_at: iso(T0 + 5 * HOUR), from: 'sam@harborline.example', description: 'deck' }];
  assert.equal(emailCandidatesFor({ row, promisedAt: T0, ownerAddrs: new Set(['avery@harborline.example']), selfFiled: true }, emails, people).length, 0);
});

test('the ingest-time rule leaves internal-call tasks alone', async () => {
  const db = world();
  const n = await closeActionItemsForActivity(db, WS, AVERY, { activityType: 'email_sent', isOutbound: true, occurredAt: iso(T0 + 17 * HOUR) });
  assert.equal(n, 0);
  assert.equal(status(db, 'c-2').status, 'open');
});

// ── the pieces ────────────────────────────────────────────────────────────────

test('a name heard on a call matches the spelling in the address book, within one letter', () => {
  assert.ok(nameLike('mareck', 'marek'));
  assert.ok(nameLike('marek', 'marek'));
  assert.ok(!nameLike('maria', 'marek'));
  assert.ok(!nameLike('al', 'al'), 'two letters are too little to go on');
  assert.ok(namesPerson('Share both mailboxes with Mareck', { first_name: 'Marek', last_name: 'Thorne' }));
  assert.ok(!namesPerson('Share both mailboxes with the team', { first_name: 'Marek', last_name: 'Thorne' }));
});

test('verdicts parse, and a quote must be in the email', () => {
  const v = parseEmailVerdict('noise {"verdict":"done","email":"E2","quote":"here it is","what":"the deck and the pricing and the plan and more words"} noise');
  assert.equal(v.email, 1);
  assert.equal(v.what.split(' ').length, 8);
  assert.equal(parseEmailVerdict('no json'), null);
  const emails = [{ body: 'a' }, { body: 'Hello, here it is: the deck.' }];
  assert.equal(settleVerdict(v, emails).kind, 'done');
  assert.equal(settleVerdict({ ...v, quote: 'something never written' }, emails).kind, 'likely');
  assert.equal(settleVerdict({ ...v, verdict: 'no' }, emails).kind, 'no');
});

test('the reason names who emailed whom; a viewer who cannot read the email sees only that', () => {
  assert.deepEqual(emailReason({ ownerName: 'Avery Lund', toName: 'Marek Thorne', what: 'the Slack channel addresses' }),
    { reason: 'Avery emailed Marek the Slack channel addresses', plain: 'Avery emailed Marek' });
  const ev = {
    kind: 'email', quote: 'Here are the addresses', what: 'the addresses', subject: 'Slack', reason_plain: 'Avery emailed Marek',
    owner_user_id: 'u-avery', mailbox_owner_ids: ['u-avery'], participants: { from: 'avery@harborline.example', to: ['marek@fernpoint.example'] },
  };
  const own = taskEvidenceForViewer(ev, 'Avery emailed Marek the addresses', { userId: 'u-avery', emails: new Set() });
  assert.equal(own.evidence.quote, 'Here are the addresses');
  const other = taskEvidenceForViewer(ev, 'Avery emailed Marek the addresses', { userId: 'u-sam', emails: new Set(['sam@harborline.example']) });
  assert.equal(other.evidence.quote, null);
  assert.equal(other.reason, 'Avery emailed Marek');
});

test('newer mail does not bury the email that did it: the judge reads the oldest unread first', async () => {
  const noise = [40, 41, 42].map((h) => ({
    id: `o-noise-${h}`, workspace_id: WS, entity_id: MAREK, property: 'interaction.email_sent', source: 'gmail',
    observed_at: iso(T0 + h * HOUR), owner_user_id: 'u-avery', source_ref: `source://gmail/n${h}`,
    value: { summary: 'Weekly digest', description: `Weekly digest ${h}` },
    raw: { from: 'avery@harborline.example', to: ['marek@fernpoint.example'], is_outbound: true, body_text: `Weekly digest ${h}`, mailbox_owner_ids: ['u-avery'] },
  }));
  const db = world({ extraEmails: noise, tasks: [(task) => task(9, 'Share both team mailboxes with Mareck so he can create a shared Slack channel.')] });
  const log = [];
  await autoCloseActionItems(db, WS, { emailJudge: judgeOf(log) });
  assert.equal(log[0].emails[0], 'o-addresses');
  assert.equal(status(db, 'c-9').status, 'done');
});
