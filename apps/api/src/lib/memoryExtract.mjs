// Post-turn memory extraction — how the agent's memory of a PERSON actually fills up.
//
// The primitive already existed: `learn_preference` writes a person-scoped row into
// account_memory (entity = the operator, owner = the operator) and every future turn
// injects it as "HOW THIS OPERATOR WORKS". It just never fired — one preference row
// existed across the whole product — because it depended on the model choosing to
// stop mid-answer and record something. Models don't volunteer housekeeping.
//
// So the write is taken away from the turn and made a consequence OF the turn. After
// the answer has streamed, a cheap pass reads the exchange and proposes at most two
// durable facts about the operator.
//
// PER TURN, NOT PER CONVERSATION. A chat thread never formally ends, so "after the
// conversation" means an idle timer and a memory that stays stale for the rest of the
// session — and the signal that matters most ("shorter please") arrives mid-thread and
// should bind the very next answer.
//
// But not every turn pays for a model call. A deterministic gate runs first, over the
// OPERATOR's message only (that is where facts about them live; the assistant's own
// prose is not evidence about the user). "thanks" costs nothing.

import { createMessage, messageText } from './llm.mjs';

// Extraction, not reasoning: the model door's extraction tier (GET-242).

// What a fact about the operator looks like in the wild. Deliberately narrow: a missed
// preference costs nothing (they'll say it again — and repetition is itself the signal),
// while a false positive is a wrong instruction the agent then follows for weeks.
const GATE = [
  // Identity — "I'm Theo", "my role is", "I run sales"
  /\b(i'?m|i am|my name is|call me)\b/i,
  /\b(my|our) (role|title|job|team|company|patch|book|quota|territory)\b/i,
  /\bi (work|run|lead|manage|own|handle|report)\b/i,
  // Standing instruction — "always", "never", "from now on", "stop"
  /\b(always|never|from now on|going forward|in future|by default|stop|don'?t)\b/i,
  // Correction of the answer just given — the highest-value signal there is
  // NB: `briefer`, never bare `brief` — "brief me on Brightwell" is the most common command
  // in this product, and it is a verb there, not a preference about length.
  /\b(shorter|concise|too long|too short|more detail|in depth|briefer|verbose|wordy|tl;?dr)\b/i,
  /\b(i (prefer|like|hate|want|need)|rather than|instead of)\b/i,
  // Explicit
  /\b(remember|note that|keep in mind|for future)\b/i,
];
const looksLikeAFact = (text) => {
  const t = (text ?? '').trim();
  // A bare command or a pleasantry carries nothing worth keeping.
  if (t.length < 12 || t.length > 4000) return false;
  return GATE.some((rx) => rx.test(t));
};

const SYSTEM = `You extract durable facts about a person from one exchange with their work assistant, so the assistant can serve them better next time.

Return ONLY facts that will STILL BE TRUE AND USEFUL IN A MONTH:
- identity: who they are, their role, their team, what they own
- preference: how they want the assistant to work — length, tone, format, what to always include or leave out
- correction: they told the assistant it got the STYLE wrong. "Make that shorter" is a standing preference, not a one-off.

Do NOT return:
- anything about an account, deal, company or person OTHER than the operator (that memory lives elsewhere)
- the topic of the conversation, what they asked, or what the assistant answered
- one-off task instructions ("do it for Acme this time", "use last quarter")
- anything you inferred rather than read. If they did not say it, it is not a fact.

Write each fact as ONE short sentence in the third person, no name, starting with a verb or "Prefers"/"Works as". Under 100 characters.
Good: "Prefers short answers with no preamble." / "Works as a sales executive." / "Always wants the account named in a follow-up."
Bad: "Asked about the pipeline." / "Is interested in Brightwell." / "Seems to like detail."

WHEN A NEW FACT CONTRADICTS SOMETHING ALREADY KNOWN, SAY SO. People change their minds, change teams, change how they want to be answered — and a memory that only ever grows ends up holding both "prefers short answers" and "wants more detail", which is worse than holding neither. Set "replaces" to the EXACT text of the known fact it supersedes, copied verbatim from the list above. Only for a genuine contradiction about the same thing; two facts that merely sit near each other both stay.

Reply with JSON only: {"facts":[{"kind":"identity|preference|correction","text":"...","replaces":"exact known fact or null"}]}
Return {"facts":[]} when the exchange carries nothing durable. That is the common case — most turns carry nothing, and a wrong fact becomes an instruction the assistant follows for weeks. Prefer silence.`;

/** Loose match, so "Prefers short answers" isn't stored three times in slightly different words. */
const norm = (s) => (s ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Memory is per-person and opt-out-able. Off = the pass never runs and nothing is written. */
export async function memoryEnabled(supabase, workspaceId, userId) {
  if (!workspaceId || !userId) return false;
  const { data } = await supabase
    .from('workspace_members').select('agent_prefs')
    .eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle();
  // Default ON, like every assistant people have used. An explicit false turns it off.
  return data?.agent_prefs?.memory_enabled !== false;
}

/**
 * Read one exchange and store what it says about the operator. Fire-and-forget: it runs
 * AFTER the answer has streamed, and every failure is swallowed — a memory that didn't
 * get written makes the product worse, but a turn that failed over its own bookkeeping
 * is a broken one.
 */
export async function extractTurnMemory({ supabase, workspaceId, userId, userText, assistantText }) {
  try {
    if (!workspaceId || !userId) return { skipped: 'no_user' };
    if (!looksLikeAFact(userText)) return { skipped: 'gate' };
    if (!(await memoryEnabled(supabase, workspaceId, userId))) return { skipped: 'disabled' };

    const { data: existing } = await supabase
      .from('account_memory').select('text')
      .eq('workspace_id', workspaceId).eq('entity_id', userId).eq('owner_user_id', userId)
      .order('captured_at', { ascending: false }).limit(60);
    const known = (existing ?? []).map((r) => r.text);
    const knownSet = new Set(known.map(norm));

    const resp = await createMessage({
      feature: 'turn-memory-extract',
      max_tokens: 400,
      system: SYSTEM,
      accept: (t) => /\{[\s\S]*\}/.test(t),
      messages: [{
        role: 'user',
        content:
          `Already known about this person (do not repeat these, or a reworded version of them):\n${known.length ? known.map(t => `- ${t}`).join('\n') : '- (nothing yet)'}\n\n` +
          `--- THE EXCHANGE ---\nThem: ${String(userText ?? '').slice(0, 4000)}\n\nAssistant: ${String(assistantText ?? '').slice(0, 2000)}`,
      }],
    });

    const raw = messageText(resp).trim();
    const json = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
    let facts = [];
    try { facts = JSON.parse(json)?.facts ?? []; } catch { return { skipped: 'unparsable' }; }
    if (!Array.isArray(facts) || facts.length === 0) return { stored: 0 };

    const rows = [];
    const superseded = [];
    for (const f of facts.slice(0, 2)) {
      const text = String(f?.text ?? '').trim().slice(0, 300);
      if (!text || knownSet.has(norm(text))) continue;
      knownSet.add(norm(text));
      // What this fact replaces. Matched on the normalised text rather than trusting the
      // model to echo it perfectly, and only ever against a fact we actually hold — a
      // `replaces` that matches nothing is dropped, not guessed at.
      const wants = norm(f?.replaces ?? '');
      if (wants) {
        const hit = known.find(k => norm(k) === wants);
        if (hit) superseded.push(hit);
      }
      rows.push({
        workspace_id: workspaceId, entity_id: userId, owner_user_id: userId,
        text,
        // 'auto' separates what the product INFERRED from what the operator or the agent
        // stated outright. The Memory page shows the difference, because a guess and a
        // statement do not deserve the same trust.
        source: 'auto', created_by: userId,
      });
    }
    if (!rows.length) return { stored: 0 };
    const { error } = await supabase.from('account_memory').insert(rows);
    if (error) return { skipped: 'insert_failed' };

    // Retire what the new fact contradicts, AFTER the replacement is safely stored — losing
    // the old one and failing to write the new one would quietly forget a preference the
    // operator had stated. Deleted rather than flagged: this table has no superseded column,
    // and an operator who changed their mind is not served by the agent remembering both.
    // Best-effort; a stale fact is a smaller problem than a turn that failed on bookkeeping.
    if (superseded.length) {
      await supabase.from('account_memory')
        .delete()
        .eq('workspace_id', workspaceId).eq('entity_id', userId).eq('owner_user_id', userId)
        .in('text', superseded)
        .then(() => {}, () => {});
    }
    return { stored: rows.length, superseded: superseded.length };
  } catch (err) {
    console.warn('[memory] extraction failed:', err?.message ?? err);
    return { skipped: 'error' };
  }
}

// ─── The overview ───────────────────────────────────────────────────────────
//
// A list of atomic facts is a database, not a picture of a person. The overview is
// the picture: a couple of sentences you can read at a glance and disagree with.
//
// GENERATED from the facts, never stored as the source of truth — the facts are the
// record, this is a view over them. Cached on the member (with the fact count it was
// built from) so opening Settings doesn't spend a model call every time, and rebuilt
// only when the underlying facts actually changed.

const OVERVIEW_SYSTEM = `You are writing a profile of a person for the assistant that works with them, from a list of facts it has learned about them.

Return JSON only:
{"bullets":[{"label":"Name","value":"..."}],"sections":[{"title":"...","text":"..."}]}

BULLETS — the at-a-glance identity. 0-5 of them, in this order when the facts support it:
Name, Role, Team, Company, Focus. Short values, a few words, no sentences.
ONLY include a bullet the facts actually state. No guessing, no "unknown", no empty values.

SECTIONS — 0-4, each a title and 1-3 sentences of plain second-person prose ("You...").
Group what is left into whatever sections the facts genuinely support — e.g. "How you like to be answered",
"What you work on", "How you make decisions". Invent the titles from the material; do not force a
fixed set. A section you have only one thin fact for is not a section: leave it out and let that fact
speak for itself in the list below. Never write a section that restates the bullets.

Use ONLY what the facts say. Never invent, never hedge, never pad. If there is too little to say,
return {"bullets":[],"sections":[]}.`;

/** Rebuild the profile from the member's facts. Returns empty bullets/sections when there's too little to say. */
export async function buildMemoryOverview(supabase, workspaceId, userId) {
  if (!workspaceId || !userId) return null;

  const { data } = await supabase
    .from('account_memory').select('text')
    .eq('workspace_id', workspaceId).eq('entity_id', userId).eq('owner_user_id', userId)
    .order('captured_at', { ascending: false }).limit(80);
  const facts = (data ?? []).map((r) => r.text).filter(Boolean);
  const empty = { profile: { bullets: [], sections: [] }, factCount: facts.length };
  // Below three facts a "profile" is just the facts restated in worse prose.
  if (facts.length < 3) return empty;

  try {
    const resp = await createMessage({
      feature: 'memory-overview',
      tier: 'writing',
      max_tokens: 700,
      system: OVERVIEW_SYSTEM,
      accept: (t) => /\{[\s\S]*\}/.test(t),
      messages: [{ role: 'user', content: facts.map(f => `- ${f}`).join('\n') }],
    });
    const raw = messageText(resp).trim();
    const json = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
    const parsed = JSON.parse(json);

    // Drop anything half-formed rather than render a bullet with no value or a section
    // with no body — an empty row reads as a bug, and the rule is that a section that
    // doesn't exist yet simply isn't shown.
    const bullets = (Array.isArray(parsed?.bullets) ? parsed.bullets : [])
      .map(b => ({ label: String(b?.label ?? '').trim().slice(0, 40), value: String(b?.value ?? '').trim().slice(0, 120) }))
      .filter(b => b.label && b.value)
      .slice(0, 5);
    const sections = (Array.isArray(parsed?.sections) ? parsed.sections : [])
      .map(sec => ({ title: String(sec?.title ?? '').trim().slice(0, 60), text: String(sec?.text ?? '').trim().slice(0, 900) }))
      .filter(sec => sec.title && sec.text)
      .slice(0, 4);

    return { profile: { bullets, sections }, factCount: facts.length };
  } catch (err) {
    console.warn('[memory] overview failed:', err?.message ?? err);
    return empty;
  }
}
