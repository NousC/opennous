// Closing commitments the record already says you kept.
//
// A meeting produces promises ("I'll send the deck", "I'll share the MVP"). The
// worker extracts them into action_item.* claims. But nothing ever closed them —
// so you'd send the deck on Tuesday and the task would still be nagging you on
// Friday. A task list that lies about what's outstanding is worse than none.
//
// The evidence to close them is already in the graph. If you promised to email
// someone and there's an email to them afterwards, it's done. If you promised to
// book a call and a meeting appears on the calendar, it's done. We don't need to
// ask the user, and we don't need an LLM for the common cases — we need to LOOK.
//
// Deliberately conservative: only close on evidence that is unambiguous, and
// record WHY it closed so a wrong call is auditable and reversible.

import { createMessage, messageText, ModelUnavailableError } from '../llm/modelDoor.mjs';
import { BOOKING_TITLE } from './actionItems.js';
import { getInternalEntityIds } from '../db/teamMembers.js';
import { closeTasksBySentEmail, isSelfFiled } from './taskEmailClosure.mjs';

const DAY = 86_400_000;

// A commitment's verb tells you what "done" looks like for it.
const COMPLETION_RULES = [
  {
    kind: 'email',
    match: /email|follow[- ]?up|send (?:him|her|them|over|a )?|reply|respond|reach out|share .*(?:link|doc|notes)/i,
    // Anything that means "I contacted them" after the promise.
    evidence: [/email_sent/, /email_replied/, /linkedin_message/, /message_sent/],
    reason: 'you contacted them after making this commitment',
  },
  {
    kind: 'scheduling',
    match: /schedule|book|invite|set up (?:a )?(?:call|meeting)|calendar/i,
    evidence: [/meeting_scheduled/, /meeting_held/],
    reason: 'a meeting appeared on the calendar afterwards',
  },
  {
    kind: 'meeting',
    match: /join|attend|conduct .*(?:call|meeting)|hop on/i,
    evidence: [/meeting_held/],
    reason: 'the meeting was held',
  },
];

// ─── Tier 2: read the evidence ──────────────────────────────────────────────
//
// Most real commitments don't match a pattern. "Share the MVP with Torvald",
// "Notify Marisela when the OS is ready", "Review the deck" — no regex knows what
// done looks like for those, and no regex ever will.
//
// But the answer is usually sitting in the next conversation: you get on a call
// and talk about the deck you sent. So for anything the rules can't judge, we
// show the model what happened AFTER the promise and ask one question: does this
// show it was done? It must quote the evidence, which is what stops it inventing
// completions — a claim with no quote is not a completion.

const JUDGE_SYSTEM = [
  'You decide whether a commitment was kept, using only the evidence given.',
  '',
  'You are shown a commitment someone made, and everything that happened with that person AFTERWARDS — meetings, messages, notes.',
  'Decide: does the evidence show the commitment was actually carried out?',
  '',
  'Be strict. The bar is evidence, not plausibility:',
  '  - "I sent you the deck" in a later call → DONE. They said it happened.',
  '  - A meeting where the deck is discussed as something already delivered → DONE.',
  '  - Merely talking to the person afterwards → NOT done. Contact is not delivery.',
  '  - Time passing → NOT done.',
  '  - Anything you are unsure about → NOT done. A false "done" hides work the user still owes someone, which is the worst thing you can do to them.',
  '',
  'Return your answer as JSON only, no prose: {"done": true|false, "quote": "<the exact words from the evidence that prove it, or null>"}',
  'If done is true you MUST supply a quote from the evidence. No quote means not done.',
].join('\n');

async function judgeCompletion(item, evidence) {
  const lines = evidence.map(e => {
    const when = (e.observed_at ?? '').slice(0, 10);
    return `- [${when}] ${e.property?.replace(/^interaction\./, '')} (${e.source}): ${e.text}`;
  }).join('\n');

  // A yes/no with a quote: the extraction tier.
  const resp = await createMessage({
    feature: 'action-item-completion',
    max_tokens: 300,
    accept: (t) => /\{[\s\S]*\}/.test(t),
    system: JUDGE_SYSTEM,
    messages: [{
      role: 'user',
      content: [
        `COMMITMENT (made ${String(item.promised_at).slice(0, 10)}): ${item.title}`,
        item.account ? `TO: ${item.account}` : '',
        item.description ? `CONTEXT: ${item.description}` : '',
        item.quote ? `AS SAID: "${item.quote}"` : '',
        '',
        'WHAT HAPPENED SINCE:',
        lines || '(nothing)',
      ].filter(Boolean).join('\n'),
    }],
  });

  const text = messageText(resp);
  try {
    const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    // No quote, no completion. This is the guardrail that matters.
    if (parsed?.done === true && typeof parsed.quote === 'string' && parsed.quote.trim()) {
      return { done: true, quote: parsed.quote.trim() };
    }
  } catch { /* unparseable → treat as not done */ }
  return { done: false };
}

/**
 * Close open commitments that the record shows were kept.
 *
 * Two tiers. First the deterministic rules — cheap and certain. Then, for the
 * ones no rule can judge, the model reads what happened since and must quote the
 * evidence. Both are conservative by design: leaving a done task open is a minor
 * annoyance, closing an open one hides work you still owe someone.
 *
 * Returns what it closed and why. Safe to call on every Tasks load.
 */
/**
 * The person a commitment names, if it names exactly one of the account's own.
 *
 * "I'll send Quillon the lead-feed fix" is not discharged by emailing the receptionist. When the promise
 * names somebody we hold, only that person's activity counts; when it names nobody, anyone at the
 * account will do — which is the right default, because most promises name no one.
 *
 * Ambiguity resolves to null, never to a guess: two Bastians at one company means we cannot tell
 * who was meant, and widening to the account is a smaller error than closing on the wrong person.
 */
export function personNamedIn(title, candidates = []) {
  if (!title || !candidates.length) return null;
  const t = ` ${String(title).toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  const full = candidates.filter(p => {
    const first = String(p.first_name || '').toLowerCase();
    const last = String(p.last_name || '').toLowerCase();
    return first && last && t.includes(` ${first} ${last} `);
  });
  // A full name is stronger evidence than a first name and settles the ambiguity it would
  // otherwise create: "Send Bastian Okonkwo the deck" at an account holding two Bastians names one of
  // them, and falling back to the account there would be a worse answer, not a safer one.
  if (full.length === 1) return full[0].id;
  if (full.length > 1) return null;

  // A short first name ("Al", "Jo") matches too much ordinary text to be evidence of anything.
  const byFirst = candidates.filter(p => {
    const first = String(p.first_name || '').toLowerCase();
    return first.length >= 3 && t.includes(` ${first} `);
  });
  return byFirst.length === 1 ? byFirst[0].id : null;
}

/**
 * When the promise was MADE — the moment evidence has to come after.
 *
 * This was `recorded_at ?? computed_at`: when we extracted it. For a task read out of a June call
 * in September, that put the promise in September, and every email and meeting between June and
 * September — the exact window the promise was kept in — fell before it and did not count.
 * One account's "send the SSO setup guide" (said in early June) was still open in late September
 * with the signup done and the service provisioned; so was August's posters task with the posters sent.
 *
 * `occurred_at` is when it was said (GET-400, stamped by every writer now). It wins. A task
 * reopened by hand moves the line to the reopen: whatever closed it before was judged wrong, and
 * the same evidence must not close it again.
 */
export function promisedAtOf(row) {
  const v = row?.value || {};
  const said = Date.parse(v.occurred_at ?? v.recorded_at ?? row?.computed_at ?? '');
  const reopened = Date.parse(v.reopened_at ?? '');
  const base = Number.isFinite(said) ? said : Date.now();
  const line = Number.isFinite(reopened) && reopened > base ? reopened : base;
  // A small grace window absorbs clock skew between connectors.
  return line - 2 * 60_000;
}

const CLAIM_PAGE = 1000;
const CLAIM_MAX = 10_000;

/**
 * Every open action item in the workspace.
 *
 * Was `LIKE 'action_item.%' … limit(300)`: a prefix LIKE cannot use the index (GET-396), and 300
 * is fewer than the largest customer holds open, so which tasks were ever considered was whatever the planner
 * returned first — and the rest were never looked at. A half-open range on the same column is an
 * index scan; paging with an order terminates correctly; and `status` is filtered in the database
 * (open, or never set) so the done ones are not read to be discarded.
 */
async function openActionItems(supabase, workspaceId) {
  const rows = [];
  for (let from = 0; from < CLAIM_MAX; from += CLAIM_PAGE) {
    const { data, error } = await supabase
      .from('claims')
      .select('id, entity_id, property, value, computed_at')
      .eq('workspace_id', workspaceId)
      .gte('property', 'action_item.')
      .lt('property', 'action_item/')
      .is('invalid_at', null)
      .or('value->>status.eq.open,value->>status.is.null')
      .order('entity_id')
      .order('property')
      .range(from, from + CLAIM_PAGE - 1);
    if (error) return rows;
    rows.push(...(data ?? []));
    if (!data || data.length < CLAIM_PAGE) break;
  }
  return rows;
}

export async function autoCloseActionItems(supabase, workspaceId, opts = {}) {
  const { emailJudge, stats } = opts;
  const rows = await openActionItems(supabase, workspaceId);
  if (!rows?.length) return [];

  // All open items with a title. Ownership is applied PER RULE below: a delivery
  // promise ("I'll send X") is only ours to close (a promise THEY made isn't
  // discharged by us acting), but a scheduling/meeting commitment is discharged for
  // BOTH sides the moment the meeting objectively exists — whoever proposed it.
  const open = rows.filter(r => {
    const v = r.value || {};
    return v.title && (v.status ?? 'open') === 'open';
  });
  if (!open.length) return [];

  const entityIds = [...new Set(open.map(r => r.entity_id).filter(Boolean))];
  if (!entityIds.length) return [];

  // A COMMITMENT SITS ON THE ACCOUNT. AN EMAIL SITS ON A PERSON (GET-357).
  //
  // Both are right. A commitment filed on "Odessa Brightwater" hides one belonging to Larkfield
  // Software, so meetings file on the account; an email has a recipient, not a company, so mail
  // files on the person. Together they meant this engine's most common rule — you promised to
  // email them, and an email to them followed — could never fire on anything a meeting produced.
  //
  // Measured before the fix: dozens of open commitments, about half matching the email verb, none
  // closable. Every entity carrying meeting tasks was a company; nearly all email_sent rows were on people.
  // Nothing errored. A task list that never closes looks exactly like a team that never follows up.
  //
  // So evidence is gathered over the account's PEOPLE as well as the account row, and filed back
  // under the entity that carries the commitment.
  const { data: people } = await supabase
    .from('contacts')
    .select('id, company_id, first_name, last_name, email')
    .eq('workspace_id', workspaceId)
    .in('company_id', entityIds)
    .limit(2000);

  // account id -> its contacts, and contact id -> the account we should file their evidence under.
  const peopleOf = new Map();
  const accountOf = new Map();
  for (const p of people ?? []) {
    if (!peopleOf.has(p.company_id)) peopleOf.set(p.company_id, []);
    peopleOf.get(p.company_id).push(p);
    accountOf.set(p.id, p.company_id);
  }

  const lookupIds = [...new Set([...entityIds, ...accountOf.keys()])];
  const { data: obs } = await supabase
    .from('observations')
    .select('entity_id, property, observed_at, source')
    .eq('workspace_id', workspaceId)
    .in('entity_id', lookupIds)
    .order('observed_at', { ascending: false })
    .limit(5000);

  const byEntity = new Map();
  for (const o of obs ?? []) {
    // An observation on a person counts for their account's commitments, and stays tagged with
    // whose it was so a promise naming someone is not discharged by mailing a colleague.
    for (const key of [o.entity_id, accountOf.get(o.entity_id)].filter(Boolean)) {
      if (!byEntity.has(key)) byEntity.set(key, []);
      byEntity.get(key).push({ ...o, actorId: o.entity_id });
    }
  }

  const namedPersonFor = (row, title) => personNamedIn(title, peopleOf.get(row.entity_id) ?? []);

  // Teammates. A task filed on one of them (every task out of an internal meeting is filed on its
  // owner) has no "them" on its record: the activity there is the owner's own mail and meetings.
  let internalIds = new Set();
  try { internalIds = await getInternalEntityIds(supabase, workspaceId); } catch { /* none known */ }

  const closed = [];
  const closedIds = new Set();
  const unjudged = [];   // no rule fits — the model gets these

  for (const row of open) {
    const v = row.value || {};
    const owner = v.owner_kind ?? 'user';
    // The rules below read "an email on this record after the promise" as "you contacted them".
    // On the owner's own record that is any email they were on: a "draft the email to X" task
    // closed on an unrelated digest a day before the real email went out (GET-904). Those tasks
    // are judged on what their owner sent to the person they name, in the email tier below.
    if (isSelfFiled(row, internalIds)) continue;
    // A promise to book a meeting closes on a meeting, never on the recap email (GET-786).
    const rule = COMPLETION_RULES.find(r => r.match.test(v.title) && !(r.kind === 'email' && BOOKING_TITLE.test(v.title)));
    // No rule fits → the model reads the evidence, but only for OUR own freeform
    // promises. A prospect's arbitrary commitment isn't ours to judge closed.
    if (!rule) { if (owner === 'user') unjudged.push(row); continue; }
    // Scheduling/meeting close for either side (a meeting existing is objective
    // evidence); every other kind is a delivery only the promiser discharges → ours.
    const ownerAgnostic = rule.kind === 'scheduling' || rule.kind === 'meeting';
    if (!ownerAgnostic && owner !== 'user') continue;

    // Evidence only counts if it came AFTER the promise was made — an email you sent last week
    // doesn't discharge a promise you made yesterday. See promisedAtOf for which date that is.
    const promisedAt = promisedAtOf(row);

    // When the promise names one of their people, only that person's activity discharges it:
    // "I'll send Quillon the lead-feed fix" is not kept by emailing the receptionist. A scheduling or
    // meeting commitment is exempt — a meeting existing is objective whoever it was with.
    const named = ownerAgnostic ? null : namedPersonFor(row, v.title);
    const activity = (byEntity.get(row.entity_id) ?? [])
      .filter(o => !named || o.actorId === named || o.actorId === row.entity_id);
    // A booking has to come more than an hour after the promise to book one (GET-786): the call it
    // was said on lands its own meeting_held at the call's start, which is otherwise "after" the
    // two-minute grace line, and "Book the Friday follow-up" closed itself on its own call.
    const floor = rule.kind === 'scheduling' ? promisedAt + 2 * 60_000 + 60 * 60_000 : promisedAt;
    const hit = activity.find(o => {
      const at = new Date(o.observed_at).getTime();
      if (!(at > floor)) return false;
      // ...and not so much later that it's plainly unrelated.
      if (at - promisedAt > 90 * DAY) return false;
      return rule.evidence.some(re => re.test(o.property));
    });
    if (!hit) continue;

    const next = {
      ...v,
      status: 'done',
      completed_at: hit.observed_at,
      // Why we think so — the whole point. A silent auto-close you can't audit is
      // just a bug that hides itself.
      completed_reason: rule.reason,
      // Who the evidence was with, not just what it was — an auto-close on an account of forty
      // people is unauditable without it.
      completed_evidence: { property: hit.property, source: hit.source, at: hit.observed_at, with: hit.actorId ?? null },
      completed_by: 'auto',
    };

    const { error: upErr } = await supabase
      .from('claims')
      .update({ value: next })
      .eq('id', row.id);
    if (!upErr) { closedIds.add(row.id); closed.push({ id: `${row.entity_id}:${row.property}`, title: v.title, reason: rule.reason }); }
  }

  // ── The email tier: what the owner SENT to the person the task names (GET-904) ──
  // Any mailbox in the workspace, any filing: the task from a co-founder call and the email to the
  // customer it was about sit on different records, and only this tier reads them together.
  const emailJudged = await closeTasksBySentEmail(supabase, workspaceId, open.filter(r => !closedIds.has(r.id)),
    { judge: emailJudge, stats, internalIds, accountOf, closed });

  // ── Tier 2 — the ones no rule can judge ──
  // Not the self-filed ones: their record's activity is their owner's, and a judge reading a
  // teammate's week will find "contact" everywhere and completion nowhere.
  await judgeUnjudged(supabase, workspaceId,
    unjudged.filter(r => !emailJudged.has(r.id) && !isSelfFiled(r, internalIds)), byEntity, closed, stats);

  return closed;
}

const MAX_JUDGED = 12;   // bound the spend on any single Tasks load

async function judgeUnjudged(supabase, workspaceId, rows, byEntity, closed, stats) {
  // The model door routes by model name — an OpenRouter model needs OPENROUTER_API_KEY and no
  // Anthropic key at all. Gating on the Anthropic key alone meant a worker configured for
  // OpenRouter, which is how production runs, never judged anything.
  if (!rows.length || !(process.env.ANTHROPIC_API_KEY || process.env.OPENROUTER_API_KEY)) return;

  // Only bother with items where something ACTUALLY happened afterwards — no
  // activity since the promise means there is nothing to read, so don't pay for
  // a model call to be told "no".
  //
  // Newest activity first, and never the same evidence twice: this took the first twelve rows by
  // entity id on every pass, so a workspace with more than twelve such tasks judged the same
  // twelve forever and the rest never (GET-904). A "no" records how far it read
  // (close_check.judge_through); only activity after that brings the task back.
  const all = [];
  for (const row of rows) {
    const promisedAt = promisedAtOf(row);
    const through = Date.parse(row.value?.close_check?.judge_through ?? '');
    const since = (byEntity.get(row.entity_id) ?? []).filter(o => {
      const at = new Date(o.observed_at).getTime();
      return at > promisedAt && at - promisedAt < 90 * DAY;
    });
    if (!since.length) continue;
    const newest = Math.max(...since.map(o => new Date(o.observed_at).getTime()));
    if (Number.isFinite(through) && newest <= through) continue;
    all.push({ row, promisedAt, since, newest });
  }
  const candidates = all.sort((a, b) => b.newest - a.newest).slice(0, MAX_JUDGED);
  if (!candidates.length) return;

  // The observations we already loaded carry no text — fetch the words, because
  // "does the evidence say the deck was sent" is a question about what was said.
  const entityIds = [...new Set(candidates.map(c => c.row.entity_id))];
  const { data: rich } = await supabase
    .from('observations')
    .select('entity_id, property, value, source, observed_at')
    .eq('workspace_id', workspaceId)
    .in('entity_id', entityIds)
    .order('observed_at', { ascending: false })
    .limit(300);

  const textOf = (v) => {
    if (!v) return '';
    if (typeof v === 'string') return v;
    for (const f of ['summary', 'description', 'text', 'body', 'content', 'title']) {
      if (typeof v[f] === 'string' && v[f].trim()) return v[f].trim();
    }
    return '';
  };

  const richByEntity = new Map();
  for (const o of rich ?? []) {
    const t = textOf(o.value);
    if (!t) continue;
    if (!richByEntity.has(o.entity_id)) richByEntity.set(o.entity_id, []);
    richByEntity.get(o.entity_id).push({ ...o, text: t.slice(0, 400) });
  }

  for (let i = 0; i < candidates.length; i++) {
    const { row, promisedAt, newest } = candidates[i];
    const v = row.value || {};
    const evidence = (richByEntity.get(row.entity_id) ?? [])
      .filter(o => new Date(o.observed_at).getTime() > promisedAt)
      .slice(0, 12);
    if (!evidence.length) continue;

    let verdict;
    try {
      verdict = await judgeCompletion({
        title: v.title,
        account: v.account ?? v.for_name ?? null,
        promised_at: v.occurred_at ?? v.recorded_at ?? row.computed_at,
        // What the promise was about, in the words it was made in — so "the posters" in a later
        // email can be matched to the posters that were promised.
        description: v.description ?? null,
        quote: v.quote ?? null,
      }, evidence);
    } catch (e) {
      // A model failure must never close or drop a task, and it is not a "no" either: nothing is
      // recorded, and when the provider itself is down the rest of the batch waits for the retry
      // instead of failing one by one (twelve 402s in a row on GET-904's day).
      console.error('[autoclose] judge failed:', e.message);
      if (e instanceof ModelUnavailableError) {
        if (stats) stats.deferred = (stats.deferred ?? 0) + (candidates.length - i);
        break;
      }
      continue;
    }
    if (!verdict.done) {
      const check = { ...(v.close_check ?? {}), judge_through: new Date(newest).toISOString(), at: new Date().toISOString() };
      await supabase.from('claims').update({ value: { ...v, close_check: check } }).eq('id', row.id);
      continue;
    }

    const next = {
      ...v,
      status: 'done',
      completed_at: new Date().toISOString(),
      completed_reason: 'a later conversation shows this was done',
      completed_evidence: { quote: verdict.quote },
      completed_by: 'auto',
    };
    const { error } = await supabase.from('claims').update({ value: next }).eq('id', row.id);
    if (!error) {
      closed.push({
        id: `${row.entity_id}:${row.property}`,
        title: v.title,
        reason: `a later conversation shows this was done — "${verdict.quote}"`,
      });
    }
  }
}
