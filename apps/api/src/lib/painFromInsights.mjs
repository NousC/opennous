// Pain, from what buyers actually said.
//
// Evidence does not arrive in one lump. It arrives in an order:
//
//     website        day 0     → Fit
//     what buyers    week 2    → Pain      ← this file
//     say on calls
//     closed deals   month 6   → Fit, Intent
//
// You get fifty calls before you get twenty closes. So the Pain layer can be real months
// before any deal outcome can refine Fit — and until now it wasn't: a live workspace had 94
// Fit signals and 11 Pain ones, most of them guessed from the ICP paragraph. The layer that
// could have been filled from evidence first was the emptiest.
//
// A Pain signal is a keyword list matched against an account's text. That makes insights the
// perfect input, because an insight IS the language a buyer used. The keywords come out of
// their real statements rather than out of someone imagining how a buyer phrases a problem —
// which is the same "their words, not yours" rule the reporting skills already follow.
//
// ── What this is and isn't ──
//
// This is the PRIOR for Pain: prevalence, not outcome. "Nine different calls raised
// procurement" is a real fact about what matters to this market, and it is available now.
// Whether raising procurement predicts a WIN needs closed deals and belongs to the same
// Fisher/BH machinery that handles Fit (lib/icpEvidence.mjs) — which cannot run on insights
// yet, because insight_items carry a speaker NAME and no entity link, so a pain cannot be
// attached to the account that raised it. That link is the next piece of work, and until it
// exists this file must not pretend to know which pains win.

import { getSupabaseClient, listSignals, upsertSignal, HIDDEN_INSIGHT_STATUS_LIST } from '@nous/core';
import { trackLlmUsage } from './llmUsage.mjs';
import { createMessage, messageText } from './llm.mjs';

// The categories where a buyer describes a problem. `positioning` and `decisions` are about
// US — how we talk, what we chose — and scoring an account on our own internal debate would
// be measuring the wrong side of the call.
const PAIN_CATEGORIES = ['buyer', 'blockers', 'product', 'market'];

// A ceiling on how many pains become signals. Twenty keyword rules over one account's text is
// not a sharper model, it is a model that fires on everything.
const MAX_PAINS = 12;

// Prevalence → weight, on the scale Fit signals already use. Deliberately compressive: a pain
// raised on 40 calls is not eight times more important than one raised on 5, it is more
// established. Log keeps the top of the range from being owned by one loud theme.
function weightFor(mentions, maxMentions, ceiling) {
  if (mentions <= 0) return 0;
  const scaled = Math.log1p(mentions) / Math.log1p(Math.max(maxMentions, 2));
  return Math.max(1, Math.round(scaled * ceiling));
}

const PROMPT = (statements) => `You are reading real statements buyers made on sales calls, extracted from recordings.

Find the RECURRING PROBLEMS these buyers describe — the pains that would make someone look for a product like this. Cluster the statements; a pain mentioned once is not a pattern.

For each pain, return:
  key       a short snake_case identifier, e.g. "manual_crm_hygiene"
  label     how a salesperson would name it, 3-6 words
  keywords  6-12 SHORT phrases, drawn FROM THE STATEMENTS THEMSELVES, that would appear in a
            call or an email where someone has this problem. Use their words, not yours. Lower
            case. No punctuation. Include the obvious variants a person would actually type.
  mentions  how many of the statements below belong to this pain

Rules:
- Only pains the BUYER has. Not our positioning, not our internal decisions, not feature requests.
- A keyword must be specific enough that it wouldn't match every conversation. "data" is
  useless; "data lives in three places" is a pain.
- If fewer than three distinct pains recur, return only the ones that do. An empty array is a
  valid and honest answer.

Return ONLY a JSON array, no prose.

STATEMENTS:
${statements}`;

/**
 * Build the Pain layer from insight items.
 *
 * `dryRun` returns exactly what would be written, because a scoring model changing under
 * someone without warning is how they stop trusting the score.
 */
export async function seedPainFromInsights(workspaceId, {
  supabase = getSupabaseClient(),
  dryRun = false,
  minMentions = 2,
} = {}) {
  const { data: items, error } = await supabase
    .from('insight_items')
    .select('category, statement, quote, occurred_at')
    .eq('workspace_id', workspaceId)
    .in('category', PAIN_CATEGORIES)
    .not('status', 'in', HIDDEN_INSIGHT_STATUS_LIST)
    .order('occurred_at', { ascending: false })
    .limit(400);
  if (error) throw error;

  if (!items?.length) {
    return {
      status: 'no_insights',
      note: 'No call insights yet. Pain stays on whatever the ICP paragraph implied, which is a guess until a call says otherwise.',
    };
  }

  // Statements only — the quote is the evidence for a human, not extra signal for the model,
  // and doubling the payload with quotes buys nothing but tokens.
  const text = items
    .map((i, n) => `${n + 1}. [${i.category}] ${String(i.statement ?? '').trim()}`)
    .filter(l => l.length > 12)
    .join('\n')
    .slice(0, 60000);

  const resp = await createMessage({
    meter: false,
    feature: 'pain-from-insights',
    max_tokens: 4096,
    temperature: 0.1,
    accept: (t) => /\[[\s\S]*\]/.test(t),
    messages: [{ role: 'user', content: PROMPT(text) }],
  });

  // Metered like every other model call, so the Usage page can show what building the Pain
  // layer costs rather than it arriving as an unexplained line.
  Promise.resolve(trackLlmUsage(supabase, {
    workspaceId, feature: 'pain-from-insights', model: resp.model, usage: resp.usage,
  })).catch(() => {});

  const raw = messageText(resp);
  let pains;
  try {
    // The prompt asks for a bare array; models sometimes wrap it. Take the array.
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');
    pains = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { status: 'parse_failed', note: 'The model did not return a usable list.', chars: raw.length };
  }
  if (!Array.isArray(pains)) return { status: 'parse_failed', note: 'Expected an array.' };

  const clean = pains
    .filter(p => p && typeof p.key === 'string' && Array.isArray(p.keywords) && p.keywords.length >= 3)
    .map(p => ({
      key: `pain_${String(p.key).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
      label: String(p.label ?? p.key).trim().slice(0, 80),
      // Short, lower-case, de-duplicated. A keyword long enough to be a sentence never matches.
      keywords: [...new Set(p.keywords
        .map(k => String(k).trim().toLowerCase())
        .filter(k => k.length >= 4 && k.length <= 48))].slice(0, 12),
      mentions: Number(p.mentions) || 0,
    }))
    .filter(p => p.keywords.length >= 3 && p.mentions >= minMentions)
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, MAX_PAINS);

  if (!clean.length) {
    return {
      status: 'no_recurring_pain',
      items_read: items.length,
      note: `Read ${items.length} call statements; no problem recurred often enough to score on. That is a finding about the calls, not a failure.`,
    };
  }

  // Weights sit on the scale the existing model uses, so a Pain signal and a Fit signal are
  // comparable rather than a new number nobody can place. Cap at the Fit ceiling.
  const existing = await listSignals(supabase, workspaceId);
  const ceiling = Math.max(...existing.map(s => Math.abs(Number(s.weight) || 0)), 5);
  const maxMentions = Math.max(...clean.map(p => p.mentions));

  const signals = clean.map(p => ({
    key: p.key,
    label: p.label,
    weight: weightFor(p.mentions, maxMentions, ceiling),
    // The same rule shape the existing Pain signals use — keyword match on the account's text.
    rule: { feature: 'keywords', op: 'contains_any', value: p.keywords },
    layer: 'pain',
    mentions: p.mentions,
  }));

  if (!dryRun) {
    for (const s of signals) {
      // upsertSignal, never seedSignals: seedSignals deletes seed-origin rows and re-inserts
      // them, which would drop `manual` and `added_in` across the WHOLE model — including the
      // Fit layer this has no business touching.
      try {
        await upsertSignal(supabase, workspaceId, {
          key: s.key, label: s.label, weight: s.weight, rule: s.rule, layer: 'pain',
        });
      } catch (e) {
        console.error('[PAIN_FROM_INSIGHTS] upsert failed', s.key, e?.message || e);
      }
    }
  }

  return {
    status: dryRun ? 'preview' : 'seeded',
    items_read: items.length,
    pains: signals.length,
    // Prevalence, stated, so nobody reads these as outcome-backed. They are what buyers RAISE,
    // not what predicts a win — that needs closed deals and an account link the insights
    // don't carry yet.
    basis: 'prevalence',
    note: 'Weighted by how often buyers raised each problem, not by whether raising it predicted a win. That needs closed deals linked to the calls.',
    signals,
  };
}
