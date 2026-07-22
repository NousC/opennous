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

import Anthropic from 'useleak';

const DAY = 86_400_000;
const JUDGE_MODEL = 'claude-haiku-4-5';   // cheap, and this is a yes/no with a quote

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
// Most real commitments don't match a pattern. "Share the MVP with Kabir",
// "Notify Sasha when the OS is ready", "Review the deck" — no regex knows what
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

async function judgeCompletion(anthropic, item, evidence) {
  const lines = evidence.map(e => {
    const when = (e.observed_at ?? '').slice(0, 10);
    return `- [${when}] ${e.property?.replace(/^interaction\./, '')} (${e.source}): ${e.text}`;
  }).join('\n');

  const resp = await anthropic.messages.create({
    feature: 'action-item-completion',
    model: JUDGE_MODEL,
    max_tokens: 300,
    system: JUDGE_SYSTEM,
    messages: [{
      role: 'user',
      content: [
        `COMMITMENT (made ${String(item.promised_at).slice(0, 10)}): ${item.title}`,
        item.account ? `TO: ${item.account}` : '',
        '',
        'WHAT HAPPENED SINCE:',
        lines || '(nothing)',
      ].filter(Boolean).join('\n'),
    }],
  });

  const text = (resp.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('');
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
export async function autoCloseActionItems(supabase, workspaceId) {
  const { data: rows, error } = await supabase
    .from('claims')
    .select('id, entity_id, property, value, computed_at')
    .eq('workspace_id', workspaceId)
    .like('property', 'action_item.%')
    .is('invalid_at', null)
    .limit(300);
  if (error || !rows?.length) return [];

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

  // Everything that happened with these people, so we can ask: did it happen?
  const { data: obs } = await supabase
    .from('observations')
    .select('entity_id, property, observed_at, source')
    .eq('workspace_id', workspaceId)
    .in('entity_id', entityIds)
    .order('observed_at', { ascending: false })
    .limit(1000);

  const byEntity = new Map();
  for (const o of obs ?? []) {
    if (!byEntity.has(o.entity_id)) byEntity.set(o.entity_id, []);
    byEntity.get(o.entity_id).push(o);
  }

  const closed = [];
  const unjudged = [];   // no rule fits — the model gets these

  for (const row of open) {
    const v = row.value || {};
    const owner = v.owner_kind ?? 'user';
    const rule = COMPLETION_RULES.find(r => r.match.test(v.title));
    // No rule fits → the model reads the evidence, but only for OUR own freeform
    // promises. A prospect's arbitrary commitment isn't ours to judge closed.
    if (!rule) { if (owner === 'user') unjudged.push(row); continue; }
    // Scheduling/meeting close for either side (a meeting existing is objective
    // evidence); every other kind is a delivery only the promiser discharges → ours.
    const ownerAgnostic = rule.kind === 'scheduling' || rule.kind === 'meeting';
    if (!ownerAgnostic && owner !== 'user') continue;

    // The promise was made when the item was recorded. Evidence only counts if it
    // came AFTER — an email you sent last week doesn't discharge a promise you
    // made yesterday. A small grace window absorbs clock skew between connectors.
    const promisedAt = new Date(v.recorded_at ?? row.computed_at).getTime() - (2 * 60_000);

    const activity = byEntity.get(row.entity_id) ?? [];
    const hit = activity.find(o => {
      const at = new Date(o.observed_at).getTime();
      if (!(at > promisedAt)) return false;
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
      completed_evidence: { property: hit.property, source: hit.source, at: hit.observed_at },
      completed_by: 'auto',
    };

    const { error: upErr } = await supabase
      .from('claims')
      .update({ value: next })
      .eq('id', row.id);
    if (!upErr) closed.push({ id: `${row.entity_id}:${row.property}`, title: v.title, reason: rule.reason });
  }

  // ── Tier 2 — the ones no rule can judge ──
  await judgeUnjudged(supabase, workspaceId, unjudged, byEntity, closed);

  return closed;
}

const MAX_JUDGED = 12;   // bound the spend on any single Tasks load

async function judgeUnjudged(supabase, workspaceId, rows, byEntity, closed) {
  if (!rows.length || !process.env.ANTHROPIC_API_KEY) return;

  // Only bother with items where something ACTUALLY happened afterwards — no
  // activity since the promise means there is nothing to read, so don't pay for
  // a model call to be told "no".
  const candidates = [];
  for (const row of rows) {
    const v = row.value || {};
    const promisedAt = new Date(v.recorded_at ?? row.computed_at).getTime() - (2 * 60_000);
    const since = (byEntity.get(row.entity_id) ?? []).filter(o => {
      const at = new Date(o.observed_at).getTime();
      return at > promisedAt && at - promisedAt < 90 * DAY;
    });
    if (since.length) candidates.push({ row, promisedAt, since });
    if (candidates.length >= MAX_JUDGED) break;
  }
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

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  for (const { row, promisedAt } of candidates) {
    const v = row.value || {};
    const evidence = (richByEntity.get(row.entity_id) ?? [])
      .filter(o => new Date(o.observed_at).getTime() > promisedAt)
      .slice(0, 12);
    if (!evidence.length) continue;

    let verdict;
    try {
      verdict = await judgeCompletion(anthropic, {
        title: v.title,
        account: v.account ?? null,
        promised_at: v.recorded_at ?? row.computed_at,
      }, evidence);
    } catch (e) {
      console.error('[autoclose] judge failed:', e.message);
      continue;   // a model failure must never close or drop a task
    }
    if (!verdict.done) continue;

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
