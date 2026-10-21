// A task closes on the email that did it, whoever's mailbox it was sent from (GET-904).
//
// A co-founder call ends with "share both mailboxes with the customer's lead so he can open a
// shared Slack channel". The next morning the task's owner emails that lead: "here are the
// addresses to add to the Slack channel: 1. … 2. …". The task stayed open until someone ticked it.
//
// Nothing errored. The closure engine looks for evidence on the entity a task is FILED on, and
// a task from an internal meeting is filed on its owner, a teammate. The email was filed on its
// recipient, the customer. The two never met: the judge was shown the owner's own activity (the
// meeting the task came from, unrelated digests) and correctly said "not done". Worse, the cheap
// rule tier read "any email on this entity after the promise" as "you contacted them", and on a
// teammate's own record that is every email they are copied on, so a "draft the email to X" task
// closed on an unrelated digest a day before the real email went out.
//
// So for every open task we own, this tier reads the emails its OWNER SENT afterwards, from any
// connected mailbox in the workspace, to the person the task names, and asks one question: does
// this email itself do the task? The bar is the same as for meetings: a verbatim quote, checked
// against the email's own text in code. A clear yes closes it, with the email as the evidence. A
// probable yes does not close anything; it puts "Looks done, close?" on the task for a person to
// confirm. A provider outage is not a "no": nothing is recorded, and the next pass tries again.

import { createMessage, messageText, ModelUnavailableError } from '../llm/modelDoor.mjs';
import { quoteInTranscript } from '../db/meetingTaskClosure.js';
import { canReadMessage } from '../privacy/messagePrivacy.mjs';

const DAY = 86_400_000;
/** An email this long after the promise is about something else. */
export const EMAIL_WINDOW_DAYS = 30;
/** Model calls per pass, so one pass has a known ceiling. */
export const MAX_EMAIL_JUDGED = 20;
const EMAILS_PER_TASK = 3;
const BODY_CHARS = 3000;
const EMAIL_PAGE = 1000;
const EMAIL_MAX = 4000;

// ── Names ────────────────────────────────────────────────────────────────────

const words = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

/** At most one insertion, deletion or substitution apart. */
function oneEditApart(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * Is this word the person's first name? Exact for any name of three letters or more; one letter
 * off for names of four or more that start the same, because a name heard on a call is written
 * the way it sounds ("Mareck") and the address book spells it the way the person does ("Marek").
 */
export function nameLike(word, first) {
  const w = String(word ?? '').toLowerCase(), f = String(first ?? '').toLowerCase();
  if (!w || !f) return false;
  if (w === f) return f.length >= 3;
  if (f.length < 4 || w.length < 4 || w[0] !== f[0]) return false;
  return oneEditApart(w, f);
}

/** Does the task's wording name this person (full name, or first name as above)? */
export function namesPerson(text, person) {
  const t = words(text);
  if (!t.length || !person) return false;
  const first = words(person.first_name)[0];
  const last = words(person.last_name).join(' ');
  if (first && last && ` ${t.join(' ')} `.includes(` ${first} ${last} `)) return true;
  return !!first && t.some((w) => nameLike(w, first));
}

// ── Which tasks, which emails ────────────────────────────────────────────────

/**
 * Is this task filed on its own owner rather than on the account it is about? Tasks out of an
 * internal meeting are (there is no customer on the call to file them on), and so is anything
 * filed on a teammate's record. For those, activity on the record is the owner's own mail, and
 * "you contacted them after the promise" says nothing about whether the task was done.
 */
export function isSelfFiled(row, internalIds) {
  const v = row?.value || {};
  return String(row?.property ?? '').startsWith('action_item.internal_')
    || v.internal_meeting === true
    || !!(internalIds && internalIds.has(row?.entity_id));
}

const addrList = (v) => (Array.isArray(v) ? v : v == null ? [] : String(v).split(','))
  .map((a) => String(a).trim().toLowerCase()).filter((a) => a.includes('@'));

/**
 * The emails worth showing the judge for one task: SENT by its owner, after it was said and within
 * the window, to someone outside the workspace whom the task names, the person it is for, or (for
 * a task filed on a customer's record) that person or a colleague at that account.
 * Newest first, one per message. Pure.
 *
 * A task filed on a teammate needs its owner's address: without one, there is no telling whose
 * mail is whose. A task on a customer's record with no owner recorded is ours, so any mail the
 * workspace sent them counts.
 */
export function emailCandidatesFor(task, emails, people, accountOf = new Map()) {
  const { row, promisedAt, ownerAddrs, selfFiled } = task;
  const v = row.value || {};
  if (!ownerAddrs?.size && selfFiled) return [];
  const text = [v.title, v.client, v.for_name].filter(Boolean).join(' ');
  const seen = new Set();
  const out = [];
  for (const e of emails) {
    const at = Date.parse(e.observed_at ?? '');
    // Strictly after it was said: an email task's own source message is stamped at the moment
    // the task was said, and must never be read as the task's completion.
    if (!(at > promisedAt + 60_000) || at - promisedAt > EMAIL_WINDOW_DAYS * DAY) continue;
    if (e.id && (e.id === v.source_id || (e.source_ref && e.source_ref === v.source_ref))) continue;
    if (e.outbound === 'false' || e.outbound === false) continue;
    if (ownerAddrs?.size && !addrList(e.from).some((a) => ownerAddrs.has(a))) continue;
    if (e.entity_id === row.entity_id && selfFiled) continue;
    const who = people.get(e.entity_id);
    if (who?.internal) continue;
    const named = e.entity_id === v.for_entity_id || (who && namesPerson(text, who))
      || (!selfFiled && (e.entity_id === row.entity_id || accountOf.get(e.entity_id) === row.entity_id));
    if (!named) continue;
    // One message to three people is three observations; the judge needs it once.
    const key = `${e.observed_at}|${String(e.description ?? e.summary ?? '').slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out.sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at));
}

// ── The judge ────────────────────────────────────────────────────────────────

export const EMAIL_JUDGE_SYSTEM = [
  'You decide whether an email someone SENT carries out a task they owed.',
  '',
  'Verdicts:',
  '  "done": the email itself does the task. It delivers, shares or sends what the task says to, or it IS the email the task says to write.',
  '  "likely": the email is plainly about this task and suggests it was done, but does not itself show it.',
  '  "no": anything else. Mentioning the topic, promising to do it later, asking about it, or doing a different task is NOT done.',
  'Be strict. A false "done" hides work someone still owes; leaving a task open costs nothing.',
  '',
  'Return JSON only, no prose:',
  '{"verdict": "done" | "likely" | "no", "email": "E1", "quote": "<the exact words from that email that do the task, max 30 words>", "what": "<what was sent or done, max 8 words, e.g. the Slack channel addresses>"}',
  'For "done" the quote MUST be copied verbatim from the email. No quote, no "done".',
].join('\n');

export function buildEmailJudgePrompt(task, emails) {
  const v = task.row.value || {};
  return [
    `TASK (owed by ${v.owner_name ?? 'us'}, said ${String(v.occurred_at ?? '').slice(0, 10) || 'earlier'}): ${v.title}`,
    v.description ? `CONTEXT: ${String(v.description).slice(0, 500)}` : '',
    v.source_title ? `FROM: ${v.source_title}` : '',
    '',
    'EMAILS THE OWNER SENT AFTERWARDS:',
    ...emails.map((e, i) => [
      `[E${i + 1}] ${String(e.observed_at).slice(0, 10)} to ${e.to_name ?? 'them'}${e.subject ? ` · Subject: ${e.subject}` : ''}`,
      String(e.body ?? '').slice(0, BODY_CHARS),
      '',
    ].join('\n')),
  ].filter((l) => l !== '').join('\n');
}

/** The model's verdict, or null when there is none to read. Pure. */
export function parseEmailVerdict(text) {
  const s = String(text ?? '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a === -1 || b < a) return null;
  let o;
  try { o = JSON.parse(s.slice(a, b + 1)); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const verdict = ['done', 'likely', 'no'].includes(o.verdict) ? o.verdict : 'no';
  const m = /^E(\d+)$/i.exec(String(o.email ?? '').trim());
  return {
    verdict,
    email: m ? Number(m[1]) - 1 : 0,
    quote: typeof o.quote === 'string' ? o.quote.trim() : '',
    what: typeof o.what === 'string' ? o.what.replace(/\s+/g, ' ').trim().split(' ').slice(0, 8).join(' ') : '',
  };
}

async function defaultEmailJudge(task, emails, workspaceId = null) {
  const resp = await createMessage({
    meter: { workspaceId },
    feature: 'task-email-completion',
    max_tokens: 300,
    accept: (t) => /\{[\s\S]*\}/.test(t),
    system: EMAIL_JUDGE_SYSTEM,
    messages: [{ role: 'user', content: buildEmailJudgePrompt(task, emails) }],
  });
  return parseEmailVerdict(messageText(resp));
}

/**
 * What the judge said, held to the bar in code: "done" stands only on a quote that is really in
 * that email; a "done" whose quote cannot be found is at most a "likely". Pure.
 */
export function settleVerdict(verdict, emails) {
  if (!verdict || verdict.verdict === 'no') return { kind: 'no' };
  const email = emails[verdict.email] ?? null;
  if (!email) return { kind: 'no' };
  const text = [email.subject, email.body ?? email.description].filter(Boolean).join('\n');
  const quoted = verdict.quote.length >= 6 && quoteInTranscript(verdict.quote, text);
  if (verdict.verdict === 'done' && quoted) return { kind: 'done', email, quote: verdict.quote, what: verdict.what };
  return { kind: 'likely', email, quote: quoted ? verdict.quote : null, what: verdict.what };
}

// ── The evidence a close carries ─────────────────────────────────────────────

const firstOf = (name) => String(name ?? '').trim().split(/\s+/)[0] || null;

/** "Avery emailed Marek the Slack channel addresses", and the same without the content. Pure. */
export function emailReason({ ownerName, from, toName, what }) {
  const owner = firstOf(ownerName) ?? (addrList(from)[0]?.split('@')[0] ?? 'You');
  const plain = `${owner} emailed ${firstOf(toName) ?? 'them'}`;
  return { reason: what ? `${plain} ${what}` : plain, plain };
}

function evidenceOf(task, settled, people) {
  const e = settled.email;
  const toName = people.get(e.entity_id)?.name ?? null;
  const { reason, plain } = emailReason({ ownerName: task.row.value?.owner_name, from: e.from, toName, what: settled.what });
  return {
    reason,
    evidence: {
      kind: 'email',
      observation_id: e.id ?? null,
      source_ref: e.source_ref ?? null,
      source: e.source ?? null,
      at: e.observed_at,
      with: e.entity_id,
      with_name: toName,
      subject: e.subject ?? null,
      quote: settled.quote ?? null,
      what: settled.what || null,
      reason_plain: plain,
      // Whose mail it is. The task is shared; the email may not be, and the Tasks API hides the
      // words from anyone the message itself would be hidden from.
      owner_user_id: e.owner_user_id ?? null,
      mailbox_owner_ids: Array.isArray(e.mailbox_owner_ids) ? e.mailbox_owner_ids : [],
      participants: { from: e.from ?? null, to: e.to ?? [], cc: e.cc ?? [] },
      // Where to read it: the person's record, where the email is filed. A Gmail link would only
      // open for the mailbox it came from.
      source_url: e.entity_id ? `/people/${e.entity_id}` : null,
    },
  };
}

/**
 * The evidence on a task, as this viewer may see it. An email the viewer could not open keeps who
 * and when, and loses its words. Pure.
 */
export function taskEvidenceForViewer(evidence, reason, viewer) {
  if (!evidence || typeof evidence !== 'object' || evidence.kind !== 'email') return { evidence, reason };
  const msg = { owner_user_id: evidence.owner_user_id ?? null, raw: { mailbox_owner_ids: evidence.mailbox_owner_ids ?? [], participants: evidence.participants ?? {} } };
  if (canReadMessage(msg, viewer)) return { evidence, reason };
  return {
    evidence: { ...evidence, quote: null, what: null, subject: null, redacted: true },
    reason: evidence.reason_plain ?? reason,
  };
}

// ── The pass ─────────────────────────────────────────────────────────────────

async function sentEmailsSince(supabase, workspaceId, sinceIso) {
  const rows = [];
  for (let from = 0; from < EMAIL_MAX; from += EMAIL_PAGE) {
    const { data, error } = await supabase
      .from('observations')
      .select('id, entity_id, observed_at, source, source_ref, owner_user_id, description:value->>description, summary:value->>summary, from:raw->>from, outbound:raw->>is_outbound')
      .eq('workspace_id', workspaceId)
      .eq('property', 'interaction.email_sent')
      .gte('observed_at', sinceIso)
      .order('observed_at', { ascending: false })
      .range(from, from + EMAIL_PAGE - 1);
    if (error) return rows;
    rows.push(...(data ?? []));
    if (!data || data.length < EMAIL_PAGE) break;
  }
  return rows;
}

const claimText = (v) => (typeof v === 'string' ? v : typeof v?.value === 'string' ? v.value : null);

/**
 * Close (or flag) open tasks the owner's own sent mail shows done. `rows` are the open action-item
 * claims; returns the ids it judged, so the general judge does not read them again.
 *
 * opts.judge   (task, emails) => verdict, for tests; defaults to the model when one is configured.
 * opts.stats   { deferred } is incremented when the model could not be reached, so the caller can
 *              schedule another pass. Nothing is written for a deferred task.
 */
export async function closeTasksBySentEmail(supabase, workspaceId, rows, { judge, stats, internalIds, accountOf, closed = [] } = {}) {
  const judgeFn = judge ?? ((process.env.ANTHROPIC_API_KEY || process.env.OPENROUTER_API_KEY) ? defaultEmailJudge : null);
  const judged = new Set();
  if (!judgeFn) return judged;

  const now = Date.now();
  const tasks = [];
  for (const row of rows) {
    const v = row.value || {};
    if (!v.title || (v.status ?? 'open') !== 'open' || (v.owner_kind ?? 'user') !== 'user') continue;
    const said = Date.parse(v.occurred_at ?? v.recorded_at ?? row.computed_at ?? '');
    const reopened = Date.parse(v.reopened_at ?? '');
    const base = Number.isFinite(said) ? said : NaN;
    if (!Number.isFinite(base) || now - base > (EMAIL_WINDOW_DAYS + 30) * DAY) continue;
    const promisedAt = Number.isFinite(reopened) && reopened > base ? reopened : base;
    tasks.push({ row, promisedAt, selfFiled: isSelfFiled(row, internalIds) });
  }
  if (!tasks.length) return judged;

  // The owner's addresses: the one the task carries, and for a task filed on a teammate, every
  // address on that teammate's record (the mailbox they send from is often not the one they sign in with).
  const selfIds = [...new Set(tasks.filter((t) => t.selfFiled).map((t) => t.row.entity_id))];
  const addrsOf = new Map();
  if (selfIds.length) {
    const { data: ids } = await supabase.from('entity_identifiers').select('entity_id, kind, value')
      .eq('workspace_id', workspaceId).in('entity_id', selfIds).eq('kind', 'email');
    for (const r of ids ?? []) {
      if (r.kind && r.kind !== 'email') continue;
      if (!addrsOf.has(r.entity_id)) addrsOf.set(r.entity_id, new Set());
      for (const a of addrList(r.value)) addrsOf.get(r.entity_id).add(a);
    }
  }
  for (const t of tasks) {
    const set = new Set(addrList(t.row.value?.owner_email));
    if (t.selfFiled) for (const a of addrsOf.get(t.row.entity_id) ?? []) set.add(a);
    t.ownerAddrs = set;
  }

  const since = new Date(Math.min(...tasks.map((t) => t.promisedAt))).toISOString();
  const emails = (await sentEmailsSince(supabase, workspaceId, since)).filter((e) => e && e.entity_id && e.observed_at);
  if (!emails.length) return judged;

  // Who each email went to: a name to match against the task, and whether they are one of us.
  const recipientIds = [...new Set(emails.map((e) => e.entity_id))];
  const people = new Map();
  for (let i = 0; i < recipientIds.length; i += 200) {
    const { data } = await supabase.from('claims').select('entity_id, property, value')
      .eq('workspace_id', workspaceId).in('entity_id', recipientIds.slice(i, i + 200))
      .in('property', ['first_name', 'last_name', 'name']).is('invalid_at', null);
    for (const c of data ?? []) {
      if (!['first_name', 'last_name', 'name'].includes(c.property)) continue;
      const p = people.get(c.entity_id) ?? {};
      p[c.property] = claimText(c.value);
      people.set(c.entity_id, p);
    }
  }
  for (const [id, p] of people) {
    if (!p.first_name && p.name) p.first_name = String(p.name).split(/\s+/)[0];
    p.name = p.name ?? ([p.first_name, p.last_name].filter(Boolean).join(' ') || null);
    p.internal = !!internalIds?.has(id);
  }
  for (const id of internalIds ?? []) if (!people.has(id)) people.set(id, { internal: true });

  // Each task's candidates, minus what an earlier pass already read and said no to.
  const work = [];
  for (const t of tasks) {
    const through = Date.parse(t.row.value?.close_check?.email_through ?? '');
    const cands = emailCandidatesFor(t, emails, people, accountOf)
      .filter((e) => !(Number.isFinite(through) && Date.parse(e.observed_at) <= through));
    // The judge reads them OLDEST first, a few at a time: the email that does a task is usually
    // the first one after it was said, and later passes move on through the rest. Reading the
    // newest three and recording "read through" past them would skip the one that mattered.
    if (cands.length) work.push({ t, newest: Date.parse(cands[0].observed_at), cands: [...cands].reverse().slice(0, EMAILS_PER_TASK) });
  }
  // Newest evidence first: the task whose email went out this morning is the one someone is
  // looking at, and a pass that always started from the same rows starved the rest (the general
  // judge's twelve were the first twelve by entity id, every run).
  work.sort((a, b) => b.newest - a.newest);
  const batch = work.slice(0, MAX_EMAIL_JUDGED);
  if (!batch.length) return judged;

  // The words. The list query carried only the first lines; the judge reads the message.
  const ids = [...new Set(batch.flatMap((w) => w.cands.map((e) => e.id)).filter(Boolean))];
  const bodies = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await supabase.from('observations')
      .select('id, body:raw->>body_text, text:raw->>text, subject:raw->>subject, to:raw->to, cc:raw->cc, mailbox_owner_ids:raw->mailbox_owner_ids')
      .eq('workspace_id', workspaceId).in('id', ids.slice(i, i + 100));
    for (const r of data ?? []) bodies.set(r.id, r);
  }

  const nowIso = new Date().toISOString();
  for (const { t, cands } of batch) {
    const v = t.row.value || {};
    const shown = cands.map((e) => {
      const b = bodies.get(e.id) ?? {};
      return {
        ...e,
        body: b.body || b.text || e.description || e.summary || '',
        subject: b.subject ?? null,
        to: b.to ?? [], cc: b.cc ?? [],
        mailbox_owner_ids: b.mailbox_owner_ids ?? [],
        to_name: people.get(e.entity_id)?.name ?? null,
      };
    });

    let verdict;
    try {
      verdict = await judgeFn(t, shown, workspaceId);
    } catch (err) {
      // The model could not be reached (credit, rate limit, outage) or answered with an error.
      // That is not a "no": record nothing, so the next pass reads this task again, and stop
      // here rather than spending the rest of the batch on the same failure.
      if (stats) stats.deferred = (stats.deferred ?? 0) + (batch.length - judged.size);
      console.error(`[autoclose] email judge ${err instanceof ModelUnavailableError ? 'unavailable' : 'failed'}, deferring: ${err?.message ?? err}`);
      break;
    }
    judged.add(t.row.id);

    const settled = settleVerdict(verdict, shown);
    const check = { ...(v.close_check ?? {}), email_through: shown[shown.length - 1].observed_at, at: nowIso };
    let next;
    if (settled.kind === 'done') {
      const { reason, evidence } = evidenceOf(t, settled, people);
      next = {
        ...v, status: 'done', completed_at: settled.email.observed_at, completed_by: 'auto',
        completed_reason: reason, completed_evidence: evidence, suggested_done: null, close_check: check,
      };
    } else if (settled.kind === 'likely') {
      const { reason, evidence } = evidenceOf(t, settled, people);
      next = { ...v, suggested_done: { reason, evidence, at: nowIso }, close_check: check };
    } else {
      next = { ...v, close_check: check };
    }
    const { error } = await supabase.from('claims').update({ value: next }).eq('workspace_id', workspaceId).eq('id', t.row.id);
    if (error) continue;
    if (settled.kind === 'done') {
      closed.push({ id: `${t.row.entity_id}:${t.row.property}`, title: v.title, reason: next.completed_reason });
    }
  }
  return judged;
}
