import { Router } from 'express';
import {
  getSupabaseClient,
  getOrCreateEntity,
  recordObservation,
  recomputeClaim,
  detectIdentifier,
  listSignals,
  scoreAndStake,
  rescoreEntityFromClaims,
  rescoreCompanyMembers,
} from '@nous/core';

export const observationsV2Router = Router();

// POST /v2/observations — record what happened / was learned.
// Body: {
//   focus: <entity UUID | email | domain>,
//   observations: [ { kind:'event'|'state', property, value, source?, method?,
//                      observed_at?, external_id?, raw? } ]
// }
// Agents never "update" — they observe. The substrate derives the new claims.
observationsV2Router.post('/', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const { focus, observations } = req.body;

    if (!focus || !Array.isArray(observations) || observations.length === 0) {
      return res.status(400).json({ error: 'focus_and_observations_required' });
    }

    // Resolve the focus to an entity — create one if it's a new identifier.
    // A write needs a precise identifier (id / email / LinkedIn / domain) —
    // never a bare name (too ambiguous to record against).
    const ident = detectIdentifier(String(focus));
    if (!ident) {
      return res.status(400).json({
        error: 'invalid_focus',
        detail: 'provide an entity id, email, LinkedIn URL, or domain — not a bare name',
      });
    }
    let entityId;
    if (ident.kind === 'entity_id') {
      entityId = ident.value;
    } else if (ident.kind === 'domain') {
      entityId = await getOrCreateEntity(supabase, workspaceId, 'company',
        [{ kind: 'domain', value: ident.value }]);
    } else {
      entityId = await getOrCreateEntity(supabase, workspaceId, 'person',
        [{ kind: ident.kind, value: ident.value }]);
    }

    // Append every observation to the immutable spine.
    let recorded = 0;
    const touchedProps = new Set();
    for (const o of observations) {
      if (!o.property || (o.kind !== 'event' && o.kind !== 'state')) continue;
      const result = await recordObservation(supabase, {
        workspaceId,
        entityId,
        kind: o.kind,
        property: o.property,
        value: o.value ?? null,
        source: o.source || 'agent',
        method: o.method || 'api',
        observedAt: o.observed_at,
        externalId: o.external_id,
        raw: o.raw,
      });
      if (result) {
        recorded++;
        if (o.kind === 'state') touchedProps.add(o.property);
      }
    }

    // Recompute the affected claims inline so the agent sees the effect now.
    const claimsRecomputed = [];
    for (const property of touchedProps) {
      try {
        await recomputeClaim(supabase, workspaceId, entityId, property);
        claimsRecomputed.push(property);
      } catch (e) {
        console.error('[POST /v2/observations] recompute failed:', property, e.message);
      }
    }

    // If a buying signal changed, (re)score the entity's ICP prediction NOW.
    // Signals are scorecard features, but scoring was previously only triggered
    // by the claim-engine worker — and that worker only RE-scores an entity that
    // ALREADY has an open prediction. A fresh lead that gets signal-scanned had
    // no prediction, so nothing ever staked one (the sidebar stayed "Not scored
    // yet"). Here: rescore the open prediction in place, or stake one if none
    // exists. Both gate on scoreable features (job_title/seniority/industry/…),
    // so an unenriched lead is correctly skipped (the lead-list fields.icp_score
    // fallback covers its sidebar). Best-effort — never block the write.
    // exclusion.* is a disqualifier feature, signal.* a buying-signal feature —
    // both are scorecard inputs, so either changing must (re)score now.
    let icpScored = null;
    if ([...claimsRecomputed].some(p => p.startsWith('signal.') || p.startsWith('exclusion.'))) {
      try {
        const signals = await listSignals(supabase, workspaceId);
        if (signals.some(s => s.active)) {
          // A signal/exclusion recorded on a COMPANY (focus = a domain) drives the
          // scores of its PEOPLE, not the company itself. Fan out so the whole
          // buying committee re-scores immediately — an exclusion flag caps every
          // contact at the account now, not on the next pass.
          const fan = await rescoreCompanyMembers(supabase, workspaceId, entityId, { signals });
          if (fan.members) {
            icpScored = { status: 'committee_rescored', members: fan.members, rescored: fan.rescored };
          } else {
            // A person's own signal/intent — re-score (or stake) that person.
            const r = await rescoreEntityFromClaims(supabase, workspaceId, entityId, { signals });
            if (r.status === 'no_open_prediction') {
              const staked = await scoreAndStake(supabase, workspaceId, entityId, signals);
              icpScored = staked ? { status: 'staked', score: staked.score } : { status: 'not_scoreable' };
            } else {
              icpScored = { status: r.status, score: r.to ?? null };
            }
          }
        }
      } catch (e) {
        console.error('[POST /v2/observations] icp (re)score failed:', e.message);
      }
    }

    return res.json({ entity_id: entityId, recorded, claims_recomputed: claimsRecomputed, icp_scored: icpScored });
  } catch (err) {
    console.error('[POST /v2/observations]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
