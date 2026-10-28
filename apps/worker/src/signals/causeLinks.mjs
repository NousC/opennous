// Cause-and-effect links between facts, extracted with the facts (GET-1053).
//
// A read used to file "Brindle froze the budget" and "Brindle's CFO left" as two facts with nothing
// between them, though the buyer said one happened because of the other. The objection playbook
// could only GUESS which of our replies answered an objection (shared words, livingOurSide.mjs), and
// win/loss could not say what a lost deal was lost to. Now each fact the model writes may carry
// `caused_by: [n]`: the 0-based positions, in the same JSON array, of up to two EARLIER facts that
// caused it. Ported in shape from Hindsight (retain/fact_extraction.py causal relations, and
// memories/pg/links.py create_causal_links_batch; MIT): one direction only (`caused_by`), the cause
// always earlier, at most two per fact, an invalid index dropped rather than repaired.
//
// THE LIFE OF A LINK
//   1. stampCauses (pure), on the raw answer, BEFORE anything is filtered: each fact gets a
//      `fact_ref` unique to this read, and its valid `caused_by` positions become `caused_by_refs`
//      (refs, not positions — positions stop meaning anything once a malformed fact is dropped, the
//      answer is routed into claims / ours / about-us, or a later part is read).
//   2. The facts travel as before; every guard copies them with a spread, so the refs ride along.
//      A fact a guard drops simply never reaches step 3, and its links go with it.
//   3. CauseLedger.claim(fact, claimId), at the write: persistFacts after the ADD/UPDATE pass (the
//      claim the fact became, or — a sure or model-judged repeat — the claim it corroborates), and
//      saveOurSideFacts (the reply filed, or the one on file it repeats).
//   4. CauseLedger.links() → claim-id pairs, written once per conversation by saveCauseLinks
//      (core saveClaimLinks: fail-safe without the table, archived when an end is retired).
import { saveClaimLinks } from '@nous/core';

// Hindsight's cap: more than two causes per fact is the model listing context, not a cause.
export const MAX_CAUSES = 2;

/** The prompt rule (shared system prompt). Every example is invented. */
export const CAUSE_RULES = `CAUSE AND EFFECT — "caused_by". When the conversation STATES or CLEARLY IMPLIES that one fact you record happened BECAUSE of another fact you record, give the effect "caused_by": a list of the 0-based positions, in this same JSON array, of the facts that caused it. Write the cause first: every position must be smaller than the effect's own position. At most 2 causes per fact. Sales examples (invented):
- "We froze the budget after our CFO left": the CFO leaving (staff_change) at position 0; the frozen budget (blocker) at position 1 with "caused_by": [0].
- The buyer worries about security, our side answers with our security doc, the buyer says "that settles it": our answer (our_side, our_reply) at position 0; the objection, "status": "resolved", at position 1 with "caused_by": [0].
- "The trial cut our prep time in half, so we're asking legal for the contract": the trial result at position 0; the next step (buying_signal) at position 1 with "caused_by": [0].
Only a cause the text gives ("because", "after", "so", "that's why", "since X, we…", or an answer the buyer says settled it). Two facts are not cause and effect because they were said one after the other, or are about the same deal. Never guess; when unsure, leave "caused_by" out.`;

/** The JSON shape note for "caused_by", appended to both prompts' Output line. */
export const CAUSED_BY_FIELD = ', "caused_by": [<the position of an EARLIER fact in this array that caused this one: an index smaller than this fact\'s own position; at most 2; omit when the text gives no cause>]';

/**
 * The model's `caused_by` for the fact at `pos`, held to the rules. Pure.
 * Kept: whole numbers (a digit string counts: models quote numbers), 0 ≤ n < pos (never itself,
 * never a later fact — a later fact cannot have caused an earlier one in Hindsight's convention, and
 * a forward index usually means the model counted wrong), each once, the first MAX_CAUSES. A lone
 * number is read as a one-item list. Anything else is dropped, never repaired.
 * @returns {number[]}
 */
export function validCauses(raw, pos) {
  const list = Array.isArray(raw) ? raw : (raw == null ? [] : [raw]);
  const out = [];
  for (const v of list) {
    const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN);
    if (!Number.isInteger(n) || n < 0 || n >= pos || !Number.isInteger(pos)) continue;
    if (out.includes(n)) continue;
    out.push(n);
    if (out.length >= MAX_CAUSES) break;
  }
  return out;
}

let readSeq = 0;
/** A prefix unique to one read in this process ("c17"), so refs from two parts never collide. */
export const nextReadId = () => `c${++readSeq}`;

/**
 * One raw answer, stamped (step 1). Each object fact gets `fact_ref` ("<read>:<pos>") and, when it
 * named valid causes, `caused_by_refs`; `caused_by` itself is removed so nothing downstream reads a
 * position that no longer means anything. Non-objects pass through untouched (factProblem drops them).
 * Pure apart from the read id.
 */
export function stampCauses(facts, readId = nextReadId()) {
  if (!Array.isArray(facts)) return facts;
  return facts.map((f, pos) => {
    if (!f || typeof f !== 'object' || Array.isArray(f)) return f;
    const { caused_by, ...rest } = f;
    const causes = validCauses(caused_by, pos);
    return { ...rest, fact_ref: `${readId}:${pos}`, ...(causes.length ? { caused_by_refs: causes.map(n => `${readId}:${n}`) } : {}) };
  });
}

/**
 * The fact refs → claim ids of one conversation (steps 3 and 4). Every write path of the read is
 * handed the same ledger; it is resolved once, after the last write.
 */
export class CauseLedger {
  constructor() {
    this.claimOf = new Map();   // fact_ref → claim id
    this.edges = [];            // [from fact_ref, to fact_ref]
  }

  /** The fact (by its fact_ref) is on file as `claimId`: the claim it became, or the one it repeats. */
  claim(fact, claimId) {
    const ref = fact?.fact_ref;
    if (!ref || !claimId) return;
    if (!this.claimOf.has(ref)) this.claimOf.set(ref, claimId);
    for (const to of fact.caused_by_refs ?? []) this.edges.push([ref, to]);
  }

  /** The links whose both ends reached a claim. A fact that was dropped (a guard, the signal
   *  check) never called claim(), so a link to or from it is dropped too. Two facts that landed
   *  on one claim (both repeats of it) are no link. Pure. */
  links() {
    const out = [], seen = new Set();
    for (const [from, to] of this.edges) {
      const fromClaimId = this.claimOf.get(from), toClaimId = this.claimOf.get(to);
      if (!fromClaimId || !toClaimId || fromClaimId === toClaimId) continue;
      const key = `${fromClaimId}|${toClaimId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ fromClaimId, toClaimId, kind: 'caused_by' });
    }
    return out;
  }
}

/** The links among a read's output facts by ref, no database (the eval, a dry run). Pure.
 *  @returns {{ from: object, to: object }[]} */
export function linksAmong(facts) {
  const byRef = new Map((facts ?? []).filter(f => f?.fact_ref).map(f => [f.fact_ref, f]));
  const out = [];
  for (const f of facts ?? []) {
    for (const to of f?.caused_by_refs ?? []) {
      const cause = byRef.get(to);
      if (cause && cause !== f) out.push({ from: f, to: cause });
    }
  }
  return out;
}

/** Write a conversation's links (step 4). Never throws; without the table it does nothing. */
export async function saveCauseLinks(supabase, workspaceId, ledger, { dryRun = false } = {}) {
  if (dryRun || !ledger) return 0;
  const links = ledger.links();
  if (!links.length) return 0;
  const { written } = await saveClaimLinks(supabase, workspaceId, links).catch(() => ({ written: 0 }));
  if (written) console.log(`[CAUSE_LINKS] ${written} cause link(s) filed`);
  return written;
}
