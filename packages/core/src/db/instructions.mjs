// Learned instructions — what the loop knows, in a form the agent reads as guidance (GET-70).
//
// This is the move that makes the decision loop a loop instead of a ledger. Everything else
// collects, grades and reports; this changes what the agent says next.
//
// The mechanism, stated correctly: THE AGENT NEVER LEARNS. Its context changes. That follows
// from the architecture we already hold — the agent is stateless and dumb, the engine is
// stateful and smart — so the skill prompt is byte-identical in March and September and only
// the payload it reads differs. No re-prompting, no fine-tuning, no per-user prompt drift.
//
// Three consumers, one store: the plugin's SessionStart hook (durable rules, always present),
// get_context (situational, account-specific), and the app's drafting prompt (so the app and
// the agent give the same advice for the same reason).
//
// ── The guard that matters more than the feature ──────────────────────────────────────────
//
// An instruction injected into context reads as authoritative. The agent will follow "write
// shorter" from four observations exactly as readily as from four hundred, silently, in every
// draft from then on — and you would never trace a bad quarter back to it. So a rule that
// cannot carry weight is not emitted at all, rather than emitted with a hedge. A wrong
// instruction is worse than no instruction.

import { hashBody } from './decisions.mjs';
import { listConstraints, renderConstraints } from './constraints.mjs';
import { listPreferences, renderPreferences } from './preferences.mjs';

// Below this a pattern is an anecdote. Deliberately stricter than the page's display floor:
// showing someone a thin number they can interpret is fine, telling an agent to act on it is
// not.
export const INSTRUCTION_MIN_N = 30;

// A context block that grows without limit becomes prompt bloat that degrades everything else
// the agent does. Highest-confidence first, hard stop.
export const MAX_RULES = 6;

const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1, learning: 0 };

/**
 * The workspace's current learned rules, ready to drop into a prompt.
 *
 * Reads ri_observations — the table that has carried `recommendation_template`, `effect`,
 * `confidence` and `sample_size` since it was written, and which nothing has ever populated
 * for decisions. Filters to what is active, confident and well-sampled, then caps.
 *
 * Returns { rules, as_of, source_count } where each rule carries its own n and confidence, so
 * a consumer can render provenance and a reader can dismiss one on sight.
 */
export async function learnedInstructions(supabase, workspaceId, { limit = MAX_RULES, minN = INSTRUCTION_MIN_N, userId = null } = {}) {
  // Constraints ride along but stay a separate block. A rule is a tendency to weigh against
  // what is in front of you; a constraint is not up for weighing. Merged into one list they
  // read alike, and the stronger one gets averaged into the weaker.
  const constraints = await listConstraints(supabase, workspaceId, { userId });
  // Three kinds of instruction, and they are ordered by how much room the agent has to
  // disagree: a constraint is not up for weighing, a stated preference should be followed
  // unless the situation clearly says otherwise, a mined rule is a tendency to weigh against
  // what is in front of you. Flattened into one list they read alike and the strongest gets
  // averaged into the weakest.
  const preferences = await listPreferences(supabase, workspaceId, { userId });
  const { data, error } = await supabase.from('ri_observations')
    .select('question_key, category, recommendation_template, effect, confidence, sample_size, conditions, updated_at')
    .eq('workspace_id', workspaceId)
    .eq('status', 'active')
    .not('recommendation_template', 'is', null)
    .gte('sample_size', minN)
    .order('updated_at', { ascending: false })
    .limit(200);
  if (error) {
    // Never let this fail a session start or a context read. No instructions is a working
    // system with nothing to say yet; an error here would break the thing it is decorating.
    console.error('[instructions] read failed:', error.message);
    return { rules: [], as_of: null, source_count: 0 };
  }

  const usable = (data ?? [])
    .filter((o) => (CONFIDENCE_RANK[o.confidence] ?? 0) >= CONFIDENCE_RANK.medium)
    .filter((o) => String(o.recommendation_template).trim())
    .sort((a, b) =>
      (CONFIDENCE_RANK[b.confidence] ?? 0) - (CONFIDENCE_RANK[a.confidence] ?? 0) ||
      Math.abs(b.effect ?? 0) - Math.abs(a.effect ?? 0) ||
      (b.sample_size ?? 0) - (a.sample_size ?? 0));

  const rules = usable.slice(0, limit).map((o) => ({
    text: String(o.recommendation_template).trim(),
    n: o.sample_size,
    confidence: o.confidence,
    category: o.category,
    // The segment the rule holds for. An unconditioned finding is a coincidence with good PR,
    // so the condition travels with the sentence rather than being dropped on the way out.
    conditions: o.conditions && Object.keys(o.conditions).length ? o.conditions : null,
    question_key: o.question_key,
  }));

  return {
    rules,
    constraints,
    preferences,
    as_of: usable[0]?.updated_at ?? null,
    source_count: usable.length,
  };
}

/**
 * The same rules as a plain-text block for a prompt or a SessionStart hook.
 *
 * Every line carries its n. That is not decoration — an agent handed a bare imperative treats
 * it as a rule of the house, and a reader who cannot see the sample cannot judge it. Returns
 * an empty string when there is nothing worth saying, so a caller can concatenate blindly.
 */
export function renderInstructions(block) {
  const constraintText = renderConstraints(block?.constraints);
  const preferenceText = renderPreferences(block?.preferences);
  const head = [constraintText, preferenceText].filter(Boolean).join('\n\n');
  // Constraints and preferences are worth sending on their own. Mined rules never are — an
  // empty statistical block is just noise in the context.
  if (!block?.rules?.length) return head;   // constraints alone are worth sending
  const lines = block.rules.map((r) => {
    const segment = r.conditions
      ? ` [${Object.entries(r.conditions).map(([k, v]) => `${k}: ${v}`).join(', ')}]`
      : '';
    return `- ${r.text}${segment} (n=${r.n}, ${r.confidence} confidence)`;
  });
  return [
    ...(head ? [head, ''] : []),
    'WHAT THIS WORKSPACE HAS LEARNED',
    'Patterns from recommendations that were actually acted on and their outcomes. These are',
    'associations with a sample size, not rules — weigh them against what you can see on the',
    'account in front of you, and say so if you go against one.',
    '',
    ...lines,
  ].join('\n');
}

/** Stable fingerprint of a block, so a consumer can tell whether the guidance changed. */
export function instructionsVersion(block) {
  return hashBody(JSON.stringify((block?.rules ?? []).map((r) => [r.question_key, r.text, r.n])));
}
