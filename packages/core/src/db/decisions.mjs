// The decision loop — one service, three lanes, every surface.
//
// A decision is the unit of the recommendation-to-outcome dataset: what was recommended,
// what the human did with it, whether the action actually happened, and (via
// ri_decision_traces) what came back. This module is the single place that writes it, so
// the Claude Code plugin, any other agent over plain HTTP, and our own app all produce the
// SAME row shape. See supabase/migrations/2026_09_08_decision_loop.sql for the why.
//
// It lives in @nous/core (like audit.mjs) because BOTH sides need it and neither app can
// import from the other: the API writes proposals and verdicts, the worker confirms them off
// ingested sends. A second copy of the body-hash normalization is precisely how the
// accept-vs-edit label would silently rot.
//
// Nothing here stores a message body. Bodies are hashed and (optionally) pointed at with a
// git ref; the only content that survives is the derived edit metric. That keeps the
// plugin's contract intact — raw stays in the operator's git, never in Nous.

import { createHash } from 'node:crypto';
import { addConstraint } from './constraints.mjs';
import { addPreference } from './preferences.mjs';

export const VERDICTS = ['pending', 'accepted', 'edited', 'rejected'];
export const STATUSES = ['proposed', 'confirmed', 'unconfirmed', 'ignored', 'abandoned'];

// Where a correction was routed. 'none' is a real answer and should be the most common one:
// most edits are a typo or a detail only the human knew, and treating those as preferences is
// how an instruction block fills with noise that crowds out the signal.
export const CORRECTION_KINDS = ['rule', 'structure', 'claim', 'constraint', 'none'];

// 'product' means the user is telling us our default is wrong for everybody. That is a ticket
// for us, never a row written against them — one customer's taste must not ship to the rest.
export const CORRECTION_SCOPES = ['once', 'person', 'workspace', 'product'];

/** sha256 of a body, so we can compare drafted vs sent without storing either. */
export function hashBody(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  return createHash('sha256').update(normalize(text)).digest('hex');
}

// Whitespace and case are not edits. A rep who reflows a paragraph or fixes capitalisation
// did not reject our draft, and counting that as an edit would poison the label.
function normalize(text) {
  return String(text).replace(/\s+/g, ' ').trim().toLowerCase();
}
function tokens(text) {
  return normalize(text).split(' ').filter(Boolean);
}

// Token-level Levenshtein — how much of the draft survived. Word-level (not character)
// because that is the unit a human actually rewrites in, and it keeps a long email cheap.
// Above the cap we stop being precise and fall back to a multiset difference: the exact
// distance stops mattering once a body is that long, but "how much changed" still does.
const LEV_TOKEN_CAP = 600;
function levenshtein(a, b) {
  if (a.length > LEV_TOKEN_CAP || b.length > LEV_TOKEN_CAP) return multisetDistance(a, b);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[b.length];
}
function multisetDistance(a, b) {
  const counts = new Map();
  for (const t of a) counts.set(t, (counts.get(t) ?? 0) + 1);
  let shared = 0;
  for (const t of b) {
    const n = counts.get(t) ?? 0;
    if (n > 0) { shared += 1; counts.set(t, n - 1); }
  }
  return Math.max(a.length, b.length) - shared;
}

/**
 * Compare the drafted body to what actually went out.
 * Returns { verdict:'accepted'|'edited', edit_distance, edit_ratio } — ratio 0.0 means sent
 * verbatim, 1.0 means nothing of the draft survived.
 *
 * This is the label the rest of the market cannot compute. Only a system that sees BOTH
 * versions can answer "which of our recommendations do experienced reps consistently
 * correct" — a CRM only ever receives the sent artifact.
 */
export function editMetrics(drafted, sent) {
  if (typeof drafted !== 'string' || typeof sent !== 'string') return null;
  const a = tokens(drafted);
  const b = tokens(sent);
  if (!a.length && !b.length) return { verdict: 'accepted', edit_distance: 0, edit_ratio: 0 };
  const distance = levenshtein(a, b);
  const ratio = distance / Math.max(a.length, b.length, 1);
  return {
    verdict: distance === 0 ? 'accepted' : 'edited',
    edit_distance: distance,
    edit_ratio: Number(ratio.toFixed(4)),
  };
}

const clip = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);

// Evidence references, defensively. A skill under time pressure will pass a bare string, a
// null, or a hundred ids; none of those should be able to wedge a proposal that is otherwise
// fine. Cap and de-duplicate rather than reject — a decision with imperfect basis beats no
// decision at all.
const MAX_EVIDENCE = 25;
function normalizeEvidenceIds(value) {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : [value];
  const seen = [];
  for (const v of list) {
    const id = clip(typeof v === 'string' ? v : String(v?.id ?? ''), 200);
    if (id && !seen.includes(id)) seen.push(id);
    if (seen.length >= MAX_EVIDENCE) break;
  }
  return seen;
}

/**
 * The ICP score as it stood right now, for the account a decision is about.
 *
 * Predictions are append-only — a fresh score stakes a new row rather than updating one — so
 * the most recent row IS the point-in-time reading. We keep its id and its number, because a
 * pointer alone is not enough: the row's meaning shifts as the model version and resolution
 * move underneath it, and the analysis needs what the operator was actually looking at.
 *
 * Deliberately read-only. An unscored lead gets nulls; a proposal must never have scoring
 * side effects, or writing down a recommendation would change the thing being recommended on.
 */
async function icpAtDecisionTime(supabase, workspaceId, entityId) {
  if (!entityId) return { prediction_id: null, icp_score_at_decision: null };
  try {
    const { data } = await supabase.from('predictions')
      .select('id, predicted_value')
      .eq('workspace_id', workspaceId)
      .eq('entity_id', entityId)
      .eq('kind', 'icp_fit')
      .order('predicted_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const score = data?.predicted_value?.score;
    return {
      prediction_id: data?.id ?? null,
      icp_score_at_decision: Number.isFinite(score) ? score : null,
    };
  } catch (e) {
    // Never fail a proposal over its own metadata. A decision with no score is worth less
    // than one with a score, and far more than one that was never recorded.
    console.error('[decisions] icp snapshot failed:', e.message);
    return { prediction_id: null, icp_score_at_decision: null };
  }
}

/**
 * Write down what the agent recommended, BEFORE anyone acts on it.
 * Idempotent on (workspace_id, decision_id) — a retried propose updates in place rather
 * than forking, so an agent that re-runs a skill does not double-count its own advice.
 */
export async function proposeDecision(supabase, workspaceId, input = {}) {
  const decisionId = clip(input.decision_id, 120);
  const proposal = clip(input.proposal, 2000);
  if (!decisionId) throw new Error('decision_id_required');
  if (!proposal) throw new Error('proposal_required');

  // A re-proposed decision keeps the score it was FIRST recorded under. proposeDecision is
  // idempotent on (workspace_id, decision_id) so a skill can safely re-run — but an upsert
  // that re-stamped today's score would reintroduce exactly the hindsight leak this snapshot
  // exists to prevent, quietly, through the retry path.
  const { data: prior } = await supabase.from('ri_decisions')
    .select('prediction_id, icp_score_at_decision, evidence_ids, rationale')
    .eq('workspace_id', workspaceId).eq('decision_id', decisionId).maybeSingle();
  const icp = prior
    ? { prediction_id: prior.prediction_id, icp_score_at_decision: prior.icp_score_at_decision }
    : await icpAtDecisionTime(supabase, workspaceId, input.entity_id);

  const row = {
    workspace_id: workspaceId,
    decision_id: decisionId,
    entity_id: input.entity_id ?? null,
    ...icp,
    rec_id: input.rec_id ?? null,
    surface: clip(input.surface, 20) ?? 'agent',
    agent: clip(input.agent, 60),
    category: clip(input.category, 40),
    action_type: clip(input.action_type, 40),
    recipient: clip(input.recipient, 320)?.toLowerCase() ?? null,
    // WHY, kept apart from WHAT. `proposal` is the action; `rationale` is the reasoning, and
    // splitting them is what lets the loop grade reasoning as a class rather than leaving it
    // buried in prose nobody parses.
    rationale: clip(input.rationale, 2000),
    // What the recommendation rested on. Tier 3 by construction — the agent asserting what it
    // believes drove the call, not a verified causal chain. Useful, and labelled as such.
    evidence_ids: normalizeEvidenceIds(input.evidence_ids),
    proposal,
    proposal_ref: clip(input.proposal_ref, 500),
    // Accept a hash directly (the hook computes it locally and never sends the body), or
    // hash a body the caller passed in-process — our own app has the text in hand already.
    proposal_hash: clip(input.proposal_hash, 64) ?? hashBody(input.proposal_body),
    // Structured proposal data the one-line `proposal` cannot carry (the CRM agent's
    // ranked deal candidates, the activity in question). Only written when the caller
    // passed one, so a retry that omits it does not wipe what the first call stored.
    ...(input.payload && typeof input.payload === 'object' ? { payload: input.payload } : {}),
    updated_at: new Date().toISOString(),
  };

  // A retry that forgot to resend the basis must not erase it. The upsert replaces the row, so
  // anything the first call captured and this one omitted is carried forward explicitly.
  if (prior) {
    if (!row.evidence_ids.length && prior.evidence_ids?.length) row.evidence_ids = prior.evidence_ids;
    if (!row.rationale && prior.rationale) row.rationale = prior.rationale;
  }

  const { data, error } = await supabase.from('ri_decisions')
    .upsert(row, { onConflict: 'workspace_id,decision_id' })
    .select('*').single();
  if (error) throw error;
  return data;
}

/**
 * Record what the human decided. Pass `sent_body` (or `sent_hash` + metrics) alongside an
 * 'accepted' verdict and we derive accepted-vs-edited ourselves rather than trusting the
 * agent's own characterisation of how much the human changed.
 */
export async function recordVerdict(supabase, workspaceId, decisionId, input = {}) {
  const { data: existing } = await supabase.from('ri_decisions')
    .select('id, proposal_hash')
    .eq('workspace_id', workspaceId).eq('decision_id', decisionId).maybeSingle();
  if (!existing) {
    // A verdict on a proposal that was never recorded. This is not a rare edge — it is what a
    // correctly-wired approve handler does when the DRAFT side was never instrumented, and it
    // returned null silently, so the machinery looked healthy while recording nothing.
    console.warn(`[decisions] verdict for an unrecorded proposal (${decisionId}) — the surface that created it is not writing decision.proposed`);
    return null;
  }

  let verdict = VERDICTS.includes(input.verdict) ? input.verdict : 'accepted';
  const patch = {
    verdict_at: input.verdict_at ?? new Date().toISOString(),
    verdict_note: clip(input.verdict_note, 1000),
    // What the correction MEANT, written at the moment it happened. A diff mined a week later
    // shows a paragraph vanished; the agent that was there knows the user said "too pushy".
    interpretation: clip(input.interpretation, 1000),
    correction_kind: CORRECTION_KINDS.includes(input.correction_kind) ? input.correction_kind : null,
    correction_scope: CORRECTION_SCOPES.includes(input.correction_scope) ? input.correction_scope : null,
    updated_at: new Date().toISOString(),
  };

  // Derive the edit label from the two bodies when we have them. An agent that reports
  // 'accepted' while the human rewrote half the message is corrected here.
  //
  // `edit_verified` records whether we were in a POSITION to know. 'accepted' means the human
  // acted on the recommendation; on its own it does not mean they sent it unchanged, and
  // treating those as the same thing is what let this go wrong silently — a decision with no
  // drafted body to compare against reported as verbatim and inflated the acceptance rate to
  // a flat 100%. Rates over unverified rows mean nothing and are excluded downstream.
  if (verdict !== 'rejected') {
    const metrics = (typeof input.drafted_body === 'string' && typeof input.sent_body === 'string')
      ? editMetrics(input.drafted_body, input.sent_body)
      : null;
    if (metrics) {
      verdict = metrics.verdict;
      patch.edit_distance = metrics.edit_distance;
      patch.edit_ratio = metrics.edit_ratio;
      patch.edit_verified = true;
    } else if (Number.isFinite(input.edit_distance)) {
      patch.edit_distance = Math.round(input.edit_distance);
      patch.edit_ratio = Number.isFinite(input.edit_ratio) ? input.edit_ratio : null;
      if (patch.edit_distance > 0) verdict = 'edited';
      patch.edit_verified = true;
    } else if (input.sent_hash && existing.proposal_hash) {
      // Only a hash on both sides: we can tell THAT it changed, not how much.
      verdict = input.sent_hash === existing.proposal_hash ? 'accepted' : 'edited';
      patch.edit_verified = true;
    } else if (input.sent_hash && !existing.proposal_hash) {
      // Something went out and we cannot say whether it matched the draft. Loud, because a
      // whole workspace in this state reads as perfect advice.
      console.warn('[decisions] verdict recorded without a proposal_hash — the edit label cannot be checked. ' +
        'Skills must pass proposal_body on decision.proposed.');
    } else if (existing.proposal_hash) {
      // The other half of the same failure, and the one that actually bit us: we HELD the
      // draft and the verdict arrived with no version of what went out. Every such row reports
      // a verdict nobody measured, so a workspace can sit at "38% edited" that is entirely the
      // agent's opinion. Loud for the same reason — silence here looks like success.
      console.warn(`[decisions] verdict '${verdict}' on ${decisionId} with no sent body or hash — ` +
        'recorded as unverified. Whoever reports the verdict must pass sent_body when it can see it.');
    }
  }
  patch.verdict = verdict;
  // A rejected recommendation has no action coming. Close it now so the reconciler does
  // not later mature it into 'unconfirmed' and mislabel a clean 'no' as a broken promise.
  if (verdict === 'rejected') patch.status = 'abandoned';

  const { data, error } = await supabase.from('ri_decisions')
    .update(patch)
    .eq('workspace_id', workspaceId).eq('decision_id', decisionId)
    .select('*').single();
  if (error) throw error;

  await routeCorrection(supabase, workspaceId, { ...input, decisionId, kind: patch.correction_kind, scope: patch.correction_scope });
  return data;
}

/**
 * Send the correction to the home its KIND implies.
 *
 * Misrouting is the quiet failure of this whole feature. A structural request stored as a
 * prompt rule gets dropped by the model eventually; a prohibition stored as a preference gets
 * weighed against other considerations and overridden. Four kinds, four destinations, and the
 * agent names the kind because it is the only party that heard what was actually said.
 *
 * Best-effort throughout: a correction that fails to route must not fail the verdict. Losing
 * the lesson is bad; losing the record that the human answered at all is worse.
 */
async function routeCorrection(supabase, workspaceId, input = {}) {
  const { kind, scope } = input;
  // 'once' means fix this output and learn nothing, which is the honest answer for most edits.
  // 'product' is us being told our default is wrong for everyone — a ticket, not a row.
  if (!kind || kind === 'none' || !scope || scope === 'once' || scope === 'product') return;
  const statement = clip(input.interpretation, 500);
  if (!statement) return;

  const common = {
    statement,
    scope: scope === 'workspace' ? 'workspace' : 'person',
    user_id: scope === 'workspace' ? null : (input.user_id ?? null),
    evidence_ids: [input.decisionId].filter(Boolean),
    source: 'inferred',
  };
  try {
    if (kind === 'constraint') {
      await addConstraint(supabase, workspaceId, { ...common, action_type: input.action_type });
    } else if (kind === 'rule') {
      await addPreference(supabase, workspaceId, { ...common, source: 'stated', applies_to: input.action_type });
    }
    // 'claim' corrections already flow through the normal record path — the agent writes the
    // corrected fact as an observation, and authority ranking handles the rest. 'structure'
    // needs the artifact template (GET-191); until that lands the intent is stored on the
    // decision so nothing is lost, and it can be replayed when the destination exists.
  } catch (e) {
    console.error('[decisions] correction routing failed:', kind, e.message);
  }
}

/**
 * The action actually fired. Called by the plugin's PostToolUse hook (which saw the send
 * tool return), by our own send lanes, or by an inbound webhook.
 *
 * Idempotent and last-write-wins on the provider id: a hook confirmation followed by the
 * provider's own webhook for the same decision is the normal case, not a conflict.
 */
export async function confirmDecision(supabase, workspaceId, decisionId, input = {}) {
  const patch = {
    status: 'confirmed',
    confirmed_at: input.confirmed_at ?? new Date().toISOString(),
    confirmed_via: clip(input.confirmed_via, 20) ?? 'hook',
    provider: clip(input.provider, 40),
    provider_message_id: clip(input.provider_message_id, 300),
    action_type: clip(input.action_type, 40) ?? undefined,
    updated_at: new Date().toISOString(),
  };
  // An agent that confirms without ever proposing still tells us something happened; it
  // just cannot tell us what was recommended. Don't drop it — but don't invent a proposal
  // either, so the gap is visible in the data instead of papered over.
  for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];

  const { data, error } = await supabase.from('ri_decisions')
    .update(patch)
    .eq('workspace_id', workspaceId).eq('decision_id', decisionId)
    .select('*').maybeSingle();
  if (error) throw error;
  return data;
}

/** Read decisions back — powers the app's loop view and the plugin's own reporting. */
export async function listDecisions(supabase, workspaceId, { entityId, status, verdict, limit = 100 } = {}) {
  let q = supabase.from('ri_decisions').select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(Math.min(Number(limit) || 100, 500));
  if (entityId) q = q.eq('entity_id', entityId);
  if (status) q = q.eq('status', status);
  if (verdict) q = q.eq('verdict', verdict);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

// How long after a recommendation a send still counts as that recommendation's action.
// Long enough for "I'll do it after lunch", short enough that tomorrow's unrelated email to
// the same person doesn't get credited to yesterday's advice.
const MATCH_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * Observe an ACTION and attach it to whatever decision it belongs to, when the caller has no
 * decision_id.
 *
 * This is the entry point for both evidence lanes that don't know our ids: a PostToolUse hook
 * (which fires because a send tool returned, not because the agent chose to tell us) and the
 * Gmail/outbound ingest (which fires because the provider says so). Neither has ever heard of
 * our decision_id. Both know who the message went to, so the server does the matching —
 * newest open proposal to that recipient inside the window.
 *
 * `stage` splits two signals that look alike and mean different things:
 *   'drafted' — a draft was created. That is the human saying YES to the recommendation, and
 *               nothing more. It is a verdict, NOT a confirmation: a draft sitting unsent in
 *               Gmail is not an action that happened, and counting it as one would put email
 *               in the dataset that never left the building.
 *   'sent'    — it actually went out. Verdict (if still pending) plus confirmation.
 *
 * The caller also sends a hash of the body. Comparing it to proposal_hash gives accepted-vs-
 * edited with NO cooperation from the agent at all — and it is what closes the flow people
 * actually use: agent drafts, human rewrites it in their own mail client, human sends. The
 * ingested body hashes differently from the draft, so the verdict upgrades to 'edited' on its
 * own. The magnitude of the edit still needs both bodies (see recordVerdict); the binary label
 * is free and unfakeable.
 */
export async function confirmByAction(supabase, workspaceId, input = {}) {
  const recipient = clip(input.recipient, 320)?.toLowerCase();
  if (!recipient) return { status: 'unmatched', reason: 'no_recipient' };

  const since = new Date(Date.now() - MATCH_WINDOW_MS).toISOString();
  const { data: candidates } = await supabase.from('ri_decisions')
    .select('id, decision_id, proposal_hash, verdict')
    .eq('workspace_id', workspaceId)
    .eq('recipient', recipient)
    .eq('status', 'proposed')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1);

  const match = (candidates ?? [])[0];
  // An action with no matching proposal is not an error — it is the agent acting without
  // writing down its recommendation first. Reported back so the skill can be fixed.
  if (!match) return { status: 'unmatched', reason: 'no_open_proposal' };

  const stage = input.stage === 'drafted' ? 'drafted' : 'sent';
  const sentHash = clip(input.sent_hash, 64);

  // Re-evaluate the verdict whenever we have a body hash, not just the first time. The draft
  // lane sets 'accepted' from the drafted body; the send that follows may carry a DIFFERENT
  // body because the human rewrote it in their mail client. Skipping the second look is how
  // an edit would be recorded as a clean acceptance.
  if (match.verdict === 'pending' || (sentHash && stage === 'sent')) {
    await recordVerdict(supabase, workspaceId, match.decision_id, {
      verdict: 'accepted', sent_hash: sentHash,
    });
  }

  // A draft is consent, not action. Leave the decision 'proposed' so the reconciler still
  // watches for a real send — and so a draft that is never sent surfaces as the
  // intent-to-action gap it is.
  if (stage === 'drafted') return { status: 'verdict_recorded', decision_id: match.decision_id };

  await confirmDecision(supabase, workspaceId, match.decision_id, {
    confirmed_via: clip(input.confirmed_via, 20) ?? 'hook',
    provider: input.provider,
    provider_message_id: input.provider_message_id,
    confirmed_at: input.sent_at,
    action_type: input.action_type,
  });
  return { status: 'confirmed', decision_id: match.decision_id };
}


// ── The inspection surface ────────────────────────────────────────────────────────────────
//
// What the Settings view reads. Deliberately an INSPECTION surface, not a dashboard with a
// point of view: the job is to answer "is this working, and is it recording the right
// things" by looking. A rate reading 100% accepted, or a wall of unconfirmed, is obvious on
// a screen and invisible in a table.
//
// Every rate ships with its own n. At this volume most of them will not mean anything yet,
// and a number that cannot support a conclusion should say so rather than be quietly styled
// as if it could. `MIN_N` mirrors the discipline already in campaignPerformance.mjs, scaled
// to per-decision rather than per-campaign counts.
const MIN_N = 20;

const rate = (num, den) => (den > 0 ? Number((num / den).toFixed(4)) : null);
const bucket = (map, key) => {
  if (!map.has(key)) map.set(key, { key, total: 0, accepted: 0, edited: 0, rejected: 0, pending: 0, confirmed: 0, unconfirmed: 0, ignored: 0, verified: 0, verified_edited: 0 });
  return map.get(key);
};
const finish = (m) => ({
  ...m,
  accept_rate: rate(m.accepted + m.edited, m.total),
  // Over CHECKED rows only. A decision whose draft we never had cannot tell us whether it was
  // rewritten, and counting it as verbatim is how an unverified workspace reports flawless
  // advice. Null here means "not measured", which is the honest answer.
  edit_rate: rate(m.verified_edited, m.verified),
  reject_rate: rate(m.rejected, m.total),
  unconfirmed_rate: rate(m.unconfirmed, m.confirmed + m.unconfirmed),
  // Advice that was never engaged with at all. Distinct from unconfirmed, which is advice the
  // human agreed to and then did not do — one is a broken promise, the other is a shrug, and
  // collapsing them would hide which of the two we are actually producing.
  ignored_rate: rate(m.ignored, m.total),
  sufficient: m.total >= MIN_N,
  edit_measurable: m.verified > 0,
});

export async function summarizeDecisions(supabase, workspaceId, { days = 90, limit = 2000 } = {}) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data: rows, error } = await supabase.from('ri_decisions')
    .select('decision_id, surface, agent, category, action_type, verdict, status, edit_ratio, edit_verified, icp_score_at_decision, evidence_ids, rationale, created_at')
    .eq('workspace_id', workspaceId)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  const decisions = rows ?? [];

  const overall = bucket(new Map(), 'all');
  const bySurface = new Map();
  const byCategory = new Map();
  const editRatios = [];
  let withBasis = 0, withRationale = 0, verified = 0;

  for (const d of decisions) {
    for (const m of [overall, bucket(bySurface, d.surface || 'unknown'), bucket(byCategory, d.category || 'uncategorized')]) {
      m.total += 1;
      if (d.verdict === 'accepted') m.accepted += 1;
      else if (d.verdict === 'edited') m.edited += 1;
      else if (d.verdict === 'rejected') m.rejected += 1;
      else m.pending += 1;
      if (d.status === 'confirmed') m.confirmed += 1;
      else if (d.status === 'unconfirmed') m.unconfirmed += 1;
      else if (d.status === 'ignored') m.ignored += 1;
      if (d.edit_verified) {
        m.verified += 1;
        if (d.verdict === 'edited') m.verified_edited += 1;
      }
    }
    if (d.edit_verified && Number.isFinite(d.edit_ratio) && d.edit_ratio > 0) editRatios.push(d.edit_ratio);
    if (d.evidence_ids?.length) withBasis += 1;
    if (d.rationale) withRationale += 1;
    if (d.edit_verified) verified += 1;
  }

  // What came back, for the decisions that produced a traceable action.
  const outcomes = {};
  const ids = decisions.map((d) => d.decision_id).filter(Boolean).slice(0, 1000);
  if (ids.length) {
    const { data: traces } = await supabase.from('ri_decision_traces')
      .select('decision_id, outcome')
      .eq('workspace_id', workspaceId)
      .in('decision_id', ids);
    for (const t of traces ?? []) {
      const k = t.outcome ?? 'open';
      outcomes[k] = (outcomes[k] ?? 0) + 1;
    }
  }

  return {
    window_days: days,
    min_n: MIN_N,
    overall: finish(overall),
    by_surface: [...bySurface.values()].map(finish).sort((a, b) => b.total - a.total),
    by_category: [...byCategory.values()].map(finish).sort((a, b) => b.total - a.total),
    // How hard the average surviving draft was rewritten. Only the edited ones — averaging in
    // the verbatim sends would drag this toward zero and hide the trend that matters.
    median_edit_ratio: editRatios.length
      ? Number(editRatios.sort((a, b) => a - b)[Math.floor(editRatios.length / 2)].toFixed(4))
      : null,
    // Coverage of the loop's own inputs. If these sit near zero the skills are not recording
    // their reasoning, and every rate above is measuring actions with no explanation attached.
    coverage: {
      with_basis: withBasis,
      with_rationale: withRationale,
      basis_rate: rate(withBasis, decisions.length),
      rationale_rate: rate(withRationale, decisions.length),
      // Whether the accepted-vs-edited label could be checked at all. Near zero means the
      // skills are not sending the drafted body, and every edit figure on the page is blank
      // rather than wrong — which is the outcome we want from a broken input.
      edit_verified: verified,
      edit_verified_rate: rate(verified, decisions.length),
    },
    outcomes,
    recent: decisions.slice(0, 50),
  };
}


/**
 * Mirror an app draft into the decision loop.
 *
 * A `pending_actions` row already IS a recommendation awaiting a human verdict — the app just
 * never wrote it down as one. Shared because the app creates drafts in FIVE places (the Focus
 * worklist's two routes, the chat agent's two tools, and /v2/drafts) and only two were
 * instrumented; the one operators actually use, the chat agent, was not. A local helper in one
 * route file is how that happened.
 *
 * The app lane is the highest-fidelity surface we have. It holds the drafted body, it collects
 * a rationale from the agent as a matter of course, and its approve handler sees both versions
 * of the message — so accepted-vs-edited is measured here rather than inferred from a hash.
 *
 * Best-effort by construction: a draft must never fail because the loop's bookkeeping did.
 */
export async function mirrorDraftAsDecision(supabase, workspaceId, action, opts = {}) {
  if (!action?.id) return null;
  const payload = opts.payload && typeof opts.payload === 'object' ? opts.payload : null;
  const row = (withPayload) => ({
    decision_id: `app:${action.id}`,
    entity_id: action.entity_id ?? null,
    rec_id: action.rec_id ?? null,
    surface: opts.surface ?? 'app',
    agent: opts.agent ?? 'nous-studio',
    category: opts.category ?? 'outreach',
    action_type: opts.actionType,
    recipient: action.recipient_email || action.linkedin_url || null,
    proposal: action.subject || `${opts.actionType ?? 'message'} to ${action.recipient ?? 'contact'}`,
    // The agent is asked to say what it based the draft on, and the app stores it. That is
    // the rationale this loop wants, already collected — it just was never carried across.
    rationale: action.rationale ?? null,
    // Hashed and discarded. Without it the edit label cannot be checked at all (GET-68).
    proposal_body: action.body ?? null,
    // Structured data about where the draft came from (GET-685: a detector automation's origin
    // marker). Optional; proposeDecision writes it only when given.
    ...(withPayload && payload ? { payload } : {}),
  });
  try {
    return await proposeDecision(supabase, workspaceId, row(true));
  } catch (e) {
    // ri_decisions.payload is a hand-applied column (2026_09_15_crm_agent.sql). Where it is
    // missing, the decision row matters more than the payload: write it without.
    if (payload && /payload|42703|PGRST204/i.test(`${e?.message ?? ''} ${e?.code ?? ''}`)) {
      try { return await proposeDecision(supabase, workspaceId, row(false)); }
      catch (e2) { console.error('[decisions] could not mirror draft as decision:', e2.message); return null; }
    }
    console.error('[decisions] could not mirror draft as decision:', e.message);
    return null;
  }
}
