import { Router } from 'express';
import {
  getSupabaseClient, getInternalEntityIds, getPersonalEntityIds,
  PIPELINE_LADDER, ALL_PIPELINE_STAGES, STAGE_RANK, stageRank, isTerminalStage,
  STAGE_DRIVING_PROPERTIES, reconstructLadder, stageOccupancies, kaplanMeierMedian,
} from '@nous/core';
import { buildPortfolio } from '../../lib/portfolio.mjs';

export const pipelineIntelligenceV2Router = Router();

// GET /v2/pipeline/portfolio — the whole account portfolio in one call (health/band,
// ICP, stage, days_quiet, flags, open objections, live competitors, engagement trend,
// multi-threading) + stage_counts + metric definitions. Powers the in-app agent's
// `pipeline` tool and the MCP `pipeline` tool — one shared view of every account.
pipelineIntelligenceV2Router.get('/portfolio', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : undefined;
    const out = await buildPortfolio(supabase, req.workspaceId, { limit });
    return res.json(out);
  } catch (err) {
    console.error('[GET /v2/pipeline/portfolio]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /v2/pipeline/intelligence — how the pipeline actually converts.
//
// Reads the timestamped pipeline_stage transition observations (every stage change
// is one, written by advancePipelineStage) and rolls up: where accounts sit now,
// the stage-to-stage conversion rate (of everyone who reached a stage, how many
// reached the next), median time to a win, and median time spent in each stage.
// Personal/team contacts are excluded (not deals). This is the "what converts and
// how long it takes" view — the input to predicting a live account's trajectory.
//
// The ladder is PIPELINE_LADDER from @nous/core (packages/core/src/pipeline.ts). The
// local six-stage copy this used to keep was missing the back half of the funnel, so
// everything at proposal/negotiation fell straight out of the distribution.

const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
};

pipelineIntelligenceV2Router.get('/intelligence', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const ws = req.workspaceId;

    // Read the INTERACTIONS, not the pipeline_stage rows.
    //
    // The stage rows are a lossy copy of the funnel and cannot answer a timing question:
    // rows written before the occurredAt fix carry the instant they were written rather
    // than the instant the account moved; backfilled activity writes no stage row at all
    // (contactHistoryEnricher passes skipStageAdvance by design, so a bulk import does not
    // fire a stage write per row); and stageDerivation only ever emits the CURRENT rung, so
    // an account that climbed four rungs over six months leaves exactly one row behind.
    // Reading them gave a median over a population of one-hop ladders, which is why the
    // cycle times came back empty or near zero.
    //
    // The interactions never had that problem — logActivity stamps observed_at from the
    // provider's own event time regardless of what order rows were written in — so the
    // ladder is rebuilt from them instead (reconstructLadder). Nothing is written and no
    // backfill is involved; this is purely a different read.
    //
    // Filtered to the stage-driving properties so this stays a slice of the activity log
    // rather than all of it.
    const acts = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from('observations')
        .select('entity_id, property, observed_at, raw')
        .eq('workspace_id', ws)
        .in('property', STAGE_DRIVING_PROPERTIES)
        .order('observed_at', { ascending: true })
        .range(from, from + 999);
      if (error) throw error;
      if (!data?.length) break;
      acts.push(...data);
      if (data.length < 1000) break;
    }
    const obs = acts;

    // Keep the funnel person-centric: only entities that ARE contacts count, and
    // personal/team are excluded (not deals). Company entities can now carry a
    // `closed_won` stage (propagated when a contact converts) — they must not
    // double-count in the person funnel, and they simply won't be in `contacts`.
    const allIds = [...new Set(obs.map(o => o.entity_id).filter(Boolean))];
    const isContact = new Set();
    for (let i = 0; i < allIds.length; i += 100) {
      const { data } = await supabase.from('contacts')
        .select('id')
        .in('id', allIds.slice(i, i + 100));
      for (const c of data || []) isContact.add(c.id);
    }
    // Internal (teammates) and personal contacts are not deals. They are asserted
    // as claims, NOT columns on the contacts view, so they must be excluded via the
    // canonical claim-backed sets — the same source query()/attention use. (A prior
    // `select('is_personal, is_internal')` read columns that do not exist, silently
    // let teammates count as pipeline.)
    const [internalIds, personalIds] = await Promise.all([
      getInternalEntityIds(supabase, ws),
      getPersonalEntityIds(supabase, ws),
    ]);
    const skip = new Set([...internalIds, ...personalIds]);

    // Per-entity timeline (collapse consecutive duplicate stages). The rows have not
    // been migrated, so they still hold aware/evaluating/proposal/client — normalize
    // every value onto the current funnel first. Collapsing AFTER the mapping also
    // drops the zero-length hops the old names create (aware then identified is one
    // stage now, not a transition). A value that resolves to nothing is not a stage
    // and is dropped rather than carried through as a phantom rung.
    // Group each account's stage-driving activity, then rebuild its ladder. reconstructLadder
    // owns the funnel rules (it shares targetStageFor with the live engine), so the rebuilt
    // ladder is the same funnel the product runs, and it already collapses repeats and stops
    // at a terminal exit.
    const byEntity = new Map();
    for (const o of obs) {
      if (!isContact.has(o.entity_id) || skip.has(o.entity_id)) continue;
      const bucket = byEntity.get(o.entity_id) || byEntity.set(o.entity_id, []).get(o.entity_id);
      bucket.push(o);
    }
    const now = Date.now();
    const tl = new Map();
    // Occupancies are collected as {days, censored} so the medians below can be censoring
    // aware. The still-open row is the one the previous implementation silently dropped.
    const occupancyByStage = {};
    for (const [entityId, activities] of byEntity) {
      const hops = reconstructLadder(activities, { now });
      if (!hops.length) continue;
      tl.set(entityId, hops.map(h => ({ stage: h.stage, at: h.at })));
      for (const occ of stageOccupancies(hops, { now })) {
        (occupancyByStage[occ.stage] ||= []).push({ days: occ.days, censored: occ.censored });
      }
    }

    const currentCounts = {}; const everReached = {};
    // Seed EVERY stage, ladder and terminal. Seeding from a partial list is what let
    // accounts at a stage outside it disappear from the distribution, so it stopped
    // summing to the account total while claiming it did.
    for (const s of ALL_PIPELINE_STAGES) { currentCounts[s] = 0; everReached[s] = 0; }
    const timeToWon = [];

    for (const seq of tl.values()) {
      // Every stage is seeded and every stage in the timeline is normalized, so this
      // always lands somewhere. No account is skipped: the counts sum to tl.size.
      const cur = seq[seq.length - 1].stage;
      currentCounts[cur]++;
      // Reach is by FURTHEST rung, not by literal visit. Stages get skipped constantly
      // (an inbound reply jumps straight to interested), so counting only the stages
      // that literally appear undercounts the lower rungs and can print a conversion
      // rate above 100%. Whatever reached a rung passed everything below it.
      let top = -1;
      for (const x of seq) if (!isTerminalStage(x.stage)) top = Math.max(top, stageRank(x.stage));
      for (const s of PIPELINE_LADDER) if (STAGE_RANK[s] <= top) everReached[s]++;
      // Terminals are exits, not rungs — nothing passes "through" them, so count the
      // ones actually hit, once each even if the account was revived and lost again.
      for (const t of new Set(seq.filter(x => isTerminalStage(x.stage)).map(x => x.stage))) everReached[t]++;
      const wonEntry = seq.find(x => x.stage === 'closed_won');
      if (wonEntry) timeToWon.push((new Date(wonEntry.at) - new Date(seq[0].at)) / 86400000);
      // Time-in-stage now comes from stageOccupancies (collected above), which INCLUDES the
      // rung an account is still sitting in. The gap-between-hops loop that used to live here
      // could only see occupancies that had already ended, and the deals that sit longest are
      // exactly the ones still sitting — so it systematically under-reported cycle times.
    }

    // Walk the real ladder, rung by rung. The old version jumped evaluating straight to
    // client and never reported the back half of the funnel at all.
    const stage_conversion = [];
    for (let i = 0; i < PIPELINE_LADDER.length - 1; i++) {
      const a = PIPELINE_LADDER[i], b = PIPELINE_LADDER[i + 1];
      const denom = everReached[a] || 0;
      stage_conversion.push({ from: a, to: b, reached_from: denom, reached_to: everReached[b] || 0, rate: denom ? +(everReached[b] / denom).toFixed(2) : null });
    }

    // `clients` and `median_days_to_client` keep their names: the MCP pipeline_intelligence
    // tool and Studio read those keys. What they measure is closed_won.
    return res.json({
      accounts: tl.size,
      clients: currentCounts.closed_won || 0,
      current_stage_counts: currentCounts,
      ever_reached: everReached,
      stage_conversion,
      median_days_to_client: median(timeToWon),
      // Time in stage only means something on the ladder — a terminal has nothing after it.
      //
      // Censoring aware (Kaplan-Meier): an account still sitting at a rung counts toward the
      // population without counting as an exit, so the slow tail is no longer discarded. A
      // stage returns null when more than half its accounts are still open, which is the
      // honest answer rather than a median computed from whichever few happened to finish.
      median_days_in_stage: Object.fromEntries(
        PIPELINE_LADDER.map(s => [s, kaplanMeierMedian(occupancyByStage[s] || [])]),
      ),
      // What the medians were computed from, so a thin number is visibly thin.
      stage_sample: Object.fromEntries(PIPELINE_LADDER.map(s => {
        const rows = occupancyByStage[s] || [];
        return [s, { total: rows.length, still_open: rows.filter(r => r.censored).length }];
      })),
      // How these numbers were derived. `reconstructed` means the ladder was rebuilt from
      // interaction history rather than read from the stage rows.
      basis: 'reconstructed',
    });
  } catch (err) {
    console.error('[GET /v2/pipeline/intelligence]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
