// The Mind — calibration metric (Phase 3).
//
// Surfaces the single headline number for "is the Mind getting smarter":
// the calibration gap. A well-calibrated ICP scores the contacts who actually
// convert higher than those who don't, so
//
//   gap = avg(outcome_score | predicted_score >= 70)
//       - avg(outcome_score | predicted_score <  70)
//
// is large and positive. The judge (Phase 4) widens it; this endpoint lets the
// Mind page plot it. See docs/compound-intelligence-mind.md §7.

import { Router } from 'express';
import { getSupabaseClient, listSignals, listNotes, scoreLead, getWorkspaceEntityId, getOrCreateEntity, logActivity, discoverSignals, upsertSignal, pipelineFeatures, scoreAndStake, rescoreOpenPredictions, isNonFeatureProp } from '@nous/core';
import { extractAndRecordWebsiteSignals } from '../../services/websiteSignals.mjs';
import { seedScorecardFromMemory } from '../../lib/scorecardSeed.mjs';
import { requireFeature } from '../../lib/access.mjs';
import { writeIcp } from '../../lib/icp.mjs';

export const mindRouter = Router();

// The ICP model is part of the Cloud team layer — building/seeding the scoring
// model is reserved for Nous Cloud (CLOUD_ONLY_FEATURES in access.mjs). On cloud
// every plan has it, so this only blocks self-host (403 cloud_only_feature).
const requireIcpModel = requireFeature('icpScoring');

// Features a seed signal's rule may reference. The lead feature snapshot is
// populated by enrichment; until then rules are valid but inert.
// FEATURE_VOCAB + the scorecard-seed routine now live in lib/scorecardSeed.mjs,
// shared with the agent route POST /v2/workspace/scoring-model.

// Monday-of-week key (UTC) — buckets episodes for the weekly trend.
function weekKey(iso) {
  const d = new Date(iso);
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

const round3 = (n) => Math.round(n * 1000) / 1000;
const avg = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null);

// GET /api/mind/substrate?workspaceId=… — the compound-intelligence loop,
// stage by stage, read straight from the v2 evidence substrate:
//
//   observations  →  claims (self-healing)  →  predictions  →  calibration
//
// Each stage is a real table. This is the loop made transparent: the
// evidence it has seen, the beliefs it derived, the predictions it staked,
// and how well those predictions held up.
mindRouter.get('/substrate', async (req, res) => {
  try {
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    const supabase = getSupabaseClient();
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000).toISOString();

    // Totals via count('exact') — Supabase/PostgREST caps row-returning
    // queries at 1000 server-side, so .length of a fetched array LIES about
    // total count. Use head:true count queries for the headline numbers and
    // separate (capped) sample queries for breakdowns.
    // The Playbooks page reads only predictions + calibration + top_signals +
    // recent_predictions from this endpoint, so we skip the two 2000-row
    // observations/claims SAMPLE fetches (their by-source / freshness / epistemic
    // breakdowns are unused) and keep only the cheap head-count totals. That trims
    // the endpoint's two heaviest row transfers.
    const [
      obsTotalRes, obs7Res,
      claimsTotalRes,
      jobsRes,
      predTotalRes, predSampleRes,
    ] = await Promise.all([
      // observations total
      supabase.from('observations').select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId),
      // last-7d observations count
      supabase.from('observations').select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId).gte('ingested_at', sevenDaysAgo),
      // claims total
      supabase.from('claims').select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId).is('invalid_at', null),
      // self-healing — the unprocessed recompute queue
      supabase.from('claim_jobs').select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId).is('picked_at', null),
      // predictions total
      supabase.from('predictions').select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId),
      // predictions sample for kind/open/resolved + calibration trend
      supabase.from('predictions')
        .select('kind, predicted_value, outcome_value, predicted_at, resolved_at, feature_snapshot')
        .eq('workspace_id', workspaceId).limit(2000),
    ]);
    if (predSampleRes.error) throw predSampleRes.error;

    const observationsTotal = obsTotalRes.count ?? 0;
    const claimsTotal = claimsTotalRes.count ?? 0;
    const predictionsTotal = predTotalRes.count ?? 0;

    // ── 1. evidence ──────────────────────────────────────────────
    // by-source breakdown intentionally omitted — the Playbooks page shows totals
    // only, so we don't pay for the 2000-row sample fetch.
    const sources = [];

    // ── 2. beliefs ───────────────────────────────────────────────
    // freshness / epistemic-class breakdowns omitted for the same reason.
    const freshness = { fresh: 0, aging: 0, suspect: 0, expired: 0 };
    const epistemic = { observed: 0, inferred: 0, predicted: 0, asserted: 0 };

    // ── 3 + 4. predictions and calibration ───────────────────────
    // A well-calibrated model scores the accounts that actually convert
    // higher than those that don't, so
    //   gap = avg(outcome | predicted >= 70) - avg(outcome | predicted < 70)
    // is large and positive.
    const preds = predSampleRes.data || [];
    const byKind = {};
    let open = 0, resolved = 0, won = 0, lost = 0;
    const high = [], low = [];
    const byWeek = new Map();
    for (const p of preds) {
      byKind[p.kind] = (byKind[p.kind] || 0) + 1;
      if (!p.resolved_at) { open++; continue; }
      resolved++;
      const disp = p.outcome_value?.disposition;
      if (disp === 'won') won++;
      else if (disp === 'lost') lost++;
      const ps = Number(p.predicted_value?.score);
      const os = Number(p.outcome_value?.score);
      if (!Number.isFinite(ps) || !Number.isFinite(os)) continue;
      (ps >= 70 ? high : low).push(os);
      const k = weekKey(p.predicted_at);
      if (!byWeek.has(k)) byWeek.set(k, { high: [], low: [] });
      (ps >= 70 ? byWeek.get(k).high : byWeek.get(k).low).push(os);
    }
    const avgHigh = avg(high), avgLow = avg(low);
    const gap = avgHigh != null && avgLow != null ? round3(avgHigh - avgLow) : null;
    const trend = [...byWeek.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([week, c]) => {
        const h = avg(c.high), l = avg(c.low);
        return { week, n: c.high.length + c.low.length, gap: h != null && l != null ? round3(h - l) : null };
      });

    // ── 5. compound-intelligence layer — signals, predictions feed, misses, attention ──

    // Active scorecard signals (used both for hit-rate analysis and ranking)
    const activeSignals = await listSignals(supabase, workspaceId, { activeOnly: true });

    // Top firing signals — by re-evaluating each resolved prediction's
    // feature_snapshot through the current Scorecard. We count fires + hits
    // (positive outcome = outcome_value.score >= 0.5).
    const signalStats = new Map();
    for (const s of activeSignals) signalStats.set(s.key, { signal: s, fires: 0, hits: 0 });
    // Decided cohort = resolved predictions with a finite outcome. Lift compares
    // the win rate among accounts where a signal fired vs where it didn't.
    let totalDecided = 0, totalWins = 0;
    for (const p of preds) {
      if (!p.resolved_at) continue;
      // Cohort = won + qualified-lost. 'no_opportunity' (scored but never a real
      // opportunity, then quiet) is excluded so cold touches can't poison the
      // lift. Predictions resolved before dispositions existed fall back to the
      // outcome-score threshold.
      const disp = p.outcome_value?.disposition;
      let isWin;
      if (disp) {
        if (disp === 'no_opportunity') continue;
        isWin = disp === 'won';
      } else {
        const out = Number(p.outcome_value?.score);
        if (!Number.isFinite(out)) continue;
        isWin = out >= 0.5;
      }
      totalDecided++;
      if (isWin) totalWins++;
      const snap = p.feature_snapshot || {};
      const features = {};
      for (const [k, v] of Object.entries(snap)) features[k] = v?.value;
      const { fired } = scoreLead(features, activeSignals);
      for (const f of fired) {
        const stat = signalStats.get(f.key);
        if (!stat) continue;
        stat.fires++;
        if (isWin) stat.hits++;
      }
    }
    // lift(signal) = winRate(fired) / winRate(not-fired). Null until both groups
    // have a minimum sample and a non-zero baseline — small cohorts lie.
    const liftOf = (fires, hits) => {
      const notFired = totalDecided - fires;
      const winsNotFired = totalWins - hits;
      if (fires < 3 || notFired < 1) return null;
      const wrFired = hits / fires;
      const wrNot = winsNotFired / notFired;
      if (wrNot <= 0) return null;
      return Math.round((wrFired / wrNot) * 10) / 10;
    };
    const topSignals = [...signalStats.values()]
      .filter(s => s.fires > 0)
      .sort((a, b) => b.fires - a.fires)
      .slice(0, 8)
      .map(s => ({
        key: s.signal.key,
        label: s.signal.label,
        weight: s.signal.weight,
        fires: s.fires,
        hits: s.hits,
        hit_rate: s.fires ? Math.round((s.hits / s.fires) * 100) : 0,
        lift: liftOf(s.fires, s.hits),
        sample: s.fires,
      }));

    // Analyzed-accounts feed — every account we've scored (newest first), one
    // row per account (latest prediction wins), enriched with name + email.
    const recentPredsRes = await supabase
      .from('predictions')
      .select('id, entity_id, predicted_value, predicted_at, outcome_value, resolved_at')
      .eq('workspace_id', workspaceId).eq('kind', 'icp_fit')
      .order('predicted_at', { ascending: false }).limit(500);
    // Dedupe by entity — keep the newest prediction per account — then order by
    // most-recent activity (resolved-now accounts surface above old scores).
    const seenEntity = new Set();
    const recentRows = (recentPredsRes.data || [])
      .filter(r => {
        if (seenEntity.has(r.entity_id)) return false;
        seenEntity.add(r.entity_id);
        return true;
      })
      .sort((a, b) => String(b.resolved_at || b.predicted_at).localeCompare(String(a.resolved_at || a.predicted_at)));
    const recentEntityIds = [...new Set(recentRows.map(r => r.entity_id))];

    let nameByEntity = {}, emailByEntity = {}, domainByEntity = {}, companyByEntity = {};
    if (recentEntityIds.length) {
      const [{ data: claimsForNames }, { data: emailIdents }, { data: domainIdents }] = await Promise.all([
        supabase.from('claims').select('entity_id, property, value')
          .in('entity_id', recentEntityIds).is('invalid_at', null)
          .in('property', ['first_name', 'last_name', 'company']),
        supabase.from('entity_identifiers').select('entity_id, value')
          .in('entity_id', recentEntityIds).eq('kind', 'email').eq('status', 'active'),
        supabase.from('entity_identifiers').select('entity_id, value')
          .in('entity_id', recentEntityIds).eq('kind', 'domain').eq('status', 'active'),
      ]);
      for (const c of claimsForNames || []) {
        if (c.property === 'company') {
          if (!companyByEntity[c.entity_id] && c.value != null) companyByEntity[c.entity_id] = c.value;
          continue;
        }
        if (!nameByEntity[c.entity_id]) nameByEntity[c.entity_id] = { first_name: null, last_name: null };
        nameByEntity[c.entity_id][c.property] = c.value;
      }
      for (const i of emailIdents || []) emailByEntity[i.entity_id] = i.value;
      for (const i of domainIdents || []) if (!domainByEntity[i.entity_id]) domainByEntity[i.entity_id] = i.value;
    }

    const buildRecent = (p) => {
      const n = nameByEntity[p.entity_id];
      // Person → full name; company (closed-deal) → its domain.
      const name = (n ? [n.first_name, n.last_name].filter(Boolean).join(' ') || null : null) || domainByEntity[p.entity_id] || null;
      // Top firing signal keys (recompute, lightweight)
      const snap = p.feature_snapshot || {};
      const features = {};
      for (const [k, v] of Object.entries(snap)) features[k] = v?.value;
      const fired = scoreLead(features, activeSignals).fired.slice(0, 3).map(f => f.key);
      return {
        id: p.id,
        entity_id: p.entity_id,
        name,
        company: companyByEntity[p.entity_id] || domainByEntity[p.entity_id] || null,
        email: emailByEntity[p.entity_id] || null,
        score: p.predicted_value?.score ?? null,
        fit: p.predicted_value?.fit ?? null,
        predicted_at: p.predicted_at,
        resolved_at: p.resolved_at,
        outcome_score: p.outcome_value?.score ?? null,
        disposition: p.outcome_value?.disposition ?? null,
        replied: p.outcome_value?.replied ?? null,
        fired,
      };
    };
    const recentEnriched = recentRows.map(buildRecent);

    // Misses — resolved predictions where the model and reality disagreed
    const misses = recentEnriched
      .filter(p => {
        if (!p.resolved_at || typeof p.outcome_score !== 'number') return false;
        const s = Number(p.score);
        if (!Number.isFinite(s)) return false;
        return (s >= 70 && p.outcome_score < 0.3) || (s < 30 && p.outcome_score > 0.7);
      })
      .slice(0, 10);

    // Attention feed intentionally not computed here — it's unused by the
    // Playbooks page and lives behind its own endpoint. Skipping it removes an
    // extra multi-query helper from this hot path.
    const attention = [];

    return res.json({
      observations: {
        total: observationsTotal,
        last_7d: obs7Res.count ?? 0,
        by_source: sources,
      },
      claims: { total: claimsTotal, freshness, epistemic },
      recompute: { pending: jobsRes.count ?? 0 },
      predictions: { total: predictionsTotal, open, resolved, won, lost, by_kind: byKind },
      calibration: {
        resolved: high.length + low.length,
        gap,
        high: { count: high.length, avg_outcome: avgHigh != null ? round3(avgHigh) : null },
        low: { count: low.length, avg_outcome: avgLow != null ? round3(avgLow) : null },
        trend,
      },
      top_signals: topSignals,
      recent_predictions: recentEnriched,
      misses,
      attention,
    });
  } catch (err) {
    console.error('[GET /api/mind/substrate]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/mind/account/:entityId?workspaceId=… — the ICP record for one
// analyzed account, standalone (NOT the CRM contact view). Everything the
// Context page needs to show "what we did to this account": the current fit,
// why it scored, the full trail of scores, and how each resolved outcome fed
// the learning model. Sourced entirely from the ICP substrate (predictions +
// scorecard_runs), independent of the contacts table.
mindRouter.get('/account/:entityId', async (req, res) => {
  try {
    const { workspaceId } = req.query;
    const { entityId } = req.params;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    const supabase = getSupabaseClient();

    const { data: preds } = await supabase
      .from('predictions')
      .select('id, predicted_value, predicted_at, resolved_at, outcome_value, model_version')
      .eq('workspace_id', workspaceId).eq('entity_id', entityId).eq('kind', 'icp_fit')
      .order('predicted_at', { ascending: false }).limit(30);

    // Flatten each prediction row into trail entries: the row's current
    // (head) score, then any prior scores from re-scores (predicted_value.history),
    // so the trail reads "Re-scored 35 → Scored 15". Newest-first throughout.
    const history = [];
    for (const p of preds || []) {
      const pv = p.predicted_value || {};
      const priors = Array.isArray(pv.history) ? pv.history : [];
      history.push({
        id:            p.id,
        score:         pv.score ?? null,
        fit:           pv.fit ?? null,
        reason:        pv.reason ?? null,
        scored_at:     pv.rescored_at || p.predicted_at,
        rescored:      priors.length > 0,
        resolved_at:   p.resolved_at,
        disposition:   p.resolved_at ? (p.outcome_value?.disposition ?? null) : null,
        outcome_score: p.resolved_at ? (p.outcome_value?.score ?? null) : null,
        learned:       null,
      });
      for (const h of priors) {
        history.push({
          id:            `${p.id}:${h.at}`,
          score:         h.score ?? null,
          fit:           h.fit ?? null,
          reason:        h.reason ?? null,
          scored_at:     h.at,
          rescored:      false,
          resolved_at:   null,
          disposition:   null,
          outcome_score: null,
          learned:       null,
        });
      }
    }

    // Tie each resolved won/lost outcome to the first scorecard_run after it
    // resolved — the run whose training cohort it was part of.
    const learnable = history.filter(h => h.resolved_at && (h.disposition === 'won' || h.disposition === 'lost'));
    if (learnable.length) {
      const { data: runs } = await supabase
        .from('scorecard_runs')
        .select('note, created_at')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: true });
      const runRows = runs || [];
      for (const h of learnable) {
        const run = runRows.find(r => r.created_at >= h.resolved_at);
        if (!run) { h.learned = { status: 'pending' }; continue; }
        const changed = typeof run.note === 'string' && run.note.startsWith('kept');
        const detail = changed ? run.note.replace(/^kept\s+\d+:\s*/, '') : null;
        h.learned = { status: changed ? 'changed' : 'no_change', at: run.created_at, detail };
      }
    }

    // Name/email for the header — from claims + identifiers, not the CRM row.
    let name = null, email = null;
    const [{ data: nameClaims }, { data: emailIdent }] = await Promise.all([
      supabase.from('claims').select('property, value')
        .eq('entity_id', entityId).is('invalid_at', null).in('property', ['first_name', 'last_name']),
      supabase.from('entity_identifiers').select('value')
        .eq('entity_id', entityId).eq('kind', 'email').eq('status', 'active').limit(1),
    ]);
    if (nameClaims?.length) {
      const byProp = Object.fromEntries(nameClaims.map(c => [c.property, c.value]));
      name = [byProp.first_name, byProp.last_name].filter(Boolean).join(' ') || null;
    }
    email = emailIdent?.[0]?.value ?? null;

    // ── Company report — who they are. For a person the firmographics live on
    // their employer (works_at); for a company entity, on itself. Merge: the
    // entity's own claims first, the employer fills any gaps.
    const ownClaimsRes = await supabase.from('claims').select('property, value')
      .eq('entity_id', entityId).is('invalid_at', null);
    let companyClaims = ownClaimsRes.data || [];
    const { data: rels } = await supabase.from('relationships').select('to_entity_id')
      .eq('workspace_id', workspaceId).eq('from_entity_id', entityId).eq('type', 'works_at').is('valid_to', null).limit(1);
    const employerId = rels?.[0]?.to_entity_id ?? null;
    if (employerId) {
      const { data: empClaims } = await supabase.from('claims').select('property, value')
        .eq('entity_id', employerId).is('invalid_at', null);
      const have = new Set(companyClaims.map(c => c.property));
      companyClaims = [...companyClaims, ...(empClaims || []).filter(c => !have.has(c.property))];
    }
    const cm = {};
    for (const c of companyClaims) cm[c.property] = c.value;
    const collect = (prefix) => companyClaims
      .filter(c => c.property.startsWith(prefix) && c.value === true)
      .map(c => c.property.slice(prefix.length).replace(/_/g, ' '));
    const company = {
      what_they_do: cm.what_they_do ?? null,
      industry: cm.industry ?? null,
      company_type: cm.company_type ?? null,
      size_band: cm.size_band ?? (cm.employee_count != null ? String(cm.employee_count) : null),
      funding_stage: cm.funding_stage ?? null,
      country: cm.country ?? null,
      target_market: cm['signal.target_market'] ?? null,
      pricing_model: cm['signal.pricing_model'] ?? null,
      recently_funded: cm['signal.recently_funded'] ?? null,
      product: ['has_api', 'has_docs', 'has_sandbox', 'self_serve_signup', 'free_trial'].filter(k => cm[`signal.${k}`] === true).map(k => k.replace(/_/g, ' ')),
      tech: collect('signal.tech.'),
      hiring: collect('signal.hiring.'),
      compliance: collect('signal.compliance.'),
    };
    const hasCompany = Object.values(company).some(v => Array.isArray(v) ? v.length : (v != null && v !== false));

    // ── Pipeline report — how the deal went, derived from the activity log. ──
    const { data: acts } = await supabase.from('observations')
      .select('property, source, observed_at')
      .eq('entity_id', entityId).eq('kind', 'event').like('property', 'interaction.%')
      .order('observed_at', { ascending: true }).limit(500);
    const events = acts || [];
    const typeOf = (p) => (p || '').replace(/^interaction\./, '');
    const count = (pred) => events.filter(e => pred(typeOf(e.property))).length;
    const pipeline = events.length ? {
      n_touches: events.length,
      n_meetings: count(t => t.includes('meeting') || t.includes('call')),
      n_emails: count(t => t.includes('email')),
      n_linkedin: count(t => t.includes('linkedin')),
      n_replies: count(t => t.includes('reply') || t.includes('replied') || t.includes('received')),
      first_touch_at: events[0].observed_at,
      last_touch_at: events[events.length - 1].observed_at,
      lead_source: events[0].source || null,
      first_touch_type: typeOf(events[0].property),
      stage: cm.pipeline_stage ?? null,
    } : null;

    return res.json({
      account: { entity_id: entityId, name, email, company: cm.company ?? cm.name ?? null },
      icp: history.length ? { current: history[0], history } : null,
      company: hasCompany ? company : null,
      pipeline,
    });
  } catch (err) {
    console.error('[GET /api/mind/account/:entityId]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/mind/icp?workspaceId=… — the plain-English ICP, the Scorecard seed.
mindRouter.get('/icp', async (req, res) => {
  try {
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    const { data, error } = await getSupabaseClient()
      .from('workspaces')
      .select('icp_text')
      .eq('id', workspaceId)
      .maybeSingle();
    if (error) throw error;
    return res.json({ icp_text: data?.icp_text ?? null });
  } catch (err) {
    console.error('[GET /api/mind/icp]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// PUT /api/mind/icp — set the ICP. Body: { workspaceId, icp_text }.
//
// Writes through lib/icp.mjs so this lands in the Vault and the ICP note as well as the
// column. It used to write `icp_text` alone, which meant editing your ICP here changed
// nothing your agent or the scoring model could see.
mindRouter.put('/icp', async (req, res) => {
  try {
    const { workspaceId, icp_text } = req.body;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    const value = typeof icp_text === 'string' ? icp_text.trim() : '';

    // Clearing it is a different operation from setting it — there is no "empty ICP"
    // playbook, so drop the row rather than upserting a blank one that would keep the
    // onboarding gate open on nothing.
    if (!value) {
      const supabase = getSupabaseClient();
      await supabase.from('playbooks').delete().eq('workspace_id', workspaceId).eq('kind', 'icp');
      await supabase.from('workspaces').update({ icp_text: null }).eq('id', workspaceId);
      return res.json({ icp_text: null });
    }

    await writeIcp(getSupabaseClient(), workspaceId, { body_md: value, source: 'nous' });
    return res.json({ icp_text: value });
  } catch (err) {
    console.error('[PUT /api/mind/icp]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/mind/scorecard?workspaceId=… — the current weighted signal list.
mindRouter.get('/scorecard', async (req, res) => {
  try {
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    const signals = await listSignals(getSupabaseClient(), workspaceId);
    return res.json({ signals });
  } catch (err) {
    console.error('[GET /api/mind/scorecard]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

const SIGNAL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// PATCH /api/mind/scorecard/signals/:id — edit a signal's label / weight /
// active flag. Body: { workspaceId, label?, weight?, active? }. Scoped to the
// workspace so one tenant can't touch another's Scorecard.
mindRouter.patch('/scorecard/signals/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { workspaceId, label, weight, active } = req.body;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    if (!SIGNAL_ID_RE.test(id)) return res.status(400).json({ error: 'invalid_id' });

    const updates = {};
    if (typeof label === 'string' && label.trim()) updates.label = label.trim().slice(0, 200);
    if (weight !== undefined && Number.isFinite(Number(weight))) {
      updates.weight = Math.max(-10, Math.min(10, Math.round(Number(weight))));
    }
    if (typeof active === 'boolean') updates.active = active;
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'nothing_to_update' });

    const { data, error } = await getSupabaseClient()
      .from('scorecard_signals')
      .update(updates)
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .select('id, key, label, weight, coverage, active')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'not_found' });
    return res.json({ signal: data });
  } catch (err) {
    console.error('[PATCH /api/mind/scorecard/signals/:id]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// DELETE /api/mind/scorecard/signals/:id — remove a signal. Body: { workspaceId }.
mindRouter.delete('/scorecard/signals/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { workspaceId } = req.body;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    if (!SIGNAL_ID_RE.test(id)) return res.status(400).json({ error: 'invalid_id' });
    const { error } = await getSupabaseClient()
      .from('scorecard_signals')
      .delete()
      .eq('id', id)
      .eq('workspace_id', workspaceId);
    if (error) throw error;
    return res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /api/mind/scorecard/signals/:id]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/mind/worker-runs?workspaceId=…&limit=50 — surface the
// compound-intelligence loop's run history on the Intelligence page.
//
// Scoped tightly: only the two workers that *are* the loop —
//   mind_outcomes  (outcome resolution, nightly)
//   scorecard_loop (Scorecard learning, nightly)
// Infrastructure workers (crm_sync, pipeline_decay, claim_engine,
// embeddings, lead_replies, score_entities) write to worker_runs too,
// but they belong in a separate "infra" view, not in this one — the
// user wants the loop dashboard to be about the loop, not plumbing.
const LOOP_WORKERS = ['mind_outcomes', 'scorecard_loop'];

mindRouter.get('/worker-runs', async (req, res) => {
  try {
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

    // Scope strictly to this workspace. NULL workspace_id rows are cross-tenant
    // infra runs that have nothing to do with one customer's loop — surfacing
    // them here was leaking other workspaces' activity into a fresh tenant.
    const { data, error } = await getSupabaseClient()
      .from('worker_runs')
      .select('id, workspace_id, worker, status, summary, details, error, duration_ms, started_at, finished_at')
      .in('worker', LOOP_WORKERS)
      .eq('workspace_id', workspaceId)
      .order('finished_at', { ascending: false })
      .limit(limit);

    if (error?.code === '42P01' || error?.code === 'PGRST205') {
      return res.json({ runs: [], migration_pending: true });
    }
    if (error) throw error;
    return res.json({ runs: data || [] });
  } catch (err) {
    console.error('[GET /api/mind/worker-runs]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/mind/scorecard/runs?workspaceId=… — the learning loop's run history.
mindRouter.get('/scorecard/runs', async (req, res) => {
  try {
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    const { data, error } = await getSupabaseClient()
      .from('scorecard_runs')
      .select('id, target, steps, gap_before, gap_after, signal_count, note, created_at')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })
      .limit(30);
    if (error) throw error;
    return res.json({ runs: data || [] });
  } catch (err) {
    console.error('[GET /api/mind/scorecard/runs]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/mind/context-changes?workspaceId=… — the workspace's context
// evolution: every GTM fact that was superseded, as from→to pairs, newest
// first. Half of the "what it's learned" timeline (the other half is the
// scoring-model runs above) — this is the workspace sharpening its own profile.
mindRouter.get('/context-changes', async (req, res) => {
  try {
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    const supabase = getSupabaseClient();
    const entityId = await getWorkspaceEntityId(supabase, workspaceId);
    if (!entityId) return res.json({ changes: [] });

    const all = await listNotes(supabase, workspaceId, { entityId, includeInactive: true, limit: 300 });
    const byId = new Map(all.map(n => [n.id, n]));
    const changes = all
      .filter(n => !n.is_active && n.superseded_by && byId.has(n.superseded_by))
      .map(n => {
        const next = byId.get(n.superseded_by);
        return { category: next.category, from: n.content, to: next.content, at: next.created_at, source: next.source };
      })
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .slice(0, 20);
    return res.json({ changes });
  } catch (err) {
    console.error('[GET /api/mind/context-changes]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/mind/scorecard/seed — translate the plain-English ICP into a seed
// Scorecard. Body: { workspaceId, force? }. Refuses to clobber an existing
// Scorecard unless force=true.
mindRouter.post('/scorecard/seed', requireIcpModel, async (req, res) => {
  try {
    const { workspaceId, force } = req.body;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    const supabase = getSupabaseClient();

    const r = await seedScorecardFromMemory(supabase, workspaceId, { force });
    if (r.status === 'exists')             return res.status(409).json({ error: 'scorecard_exists', signals: r.signals });
    if (r.status === 'no_icp_memory')      return res.status(400).json({ error: 'no_icp_memory' });
    if (r.status === 'translation_failed') return res.status(502).json({ error: 'translation_failed' });
    return res.status(201).json({ signals: r.signals });
  } catch (err) {
    console.error('[POST /api/mind/scorecard/seed]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/mind/closed-deals — build the scoring model from real closed deals.
// Body: { workspaceId, won: [domain|{domain}], lost: [domain|{domain}] }
// For each account: resolve a company entity, extract website signals, record the
// won/lost outcome, then run contrastive lift discovery over the cohort and seed
// the Scorecard from what actually predicts revenue. The owned, no-CSV version of
// Deepline's signal discovery. See docs/icp-from-closed-deals.md, Step 5.
const cleanDomain = (d) => String(d || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/^www\./i, '').toLowerCase();

// Small-cohort fallback. Contrastive lift (discoverSignals) needs a real cohort
// (>=8 deals, >=4 each side) or it's statistically meaningless. With only a
// handful, propose the boolean/categorical features common to the WON accounts
// — down-weighted if they also show up among losers — as positive signals. An
// honest starting point the nightly lift discovery sharpens as more deals land.
const dslug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
const featLabel = (feature, value) => {
  const f = String(feature).replace(/^signal\./, '').replace(/[._]/g, ' ').trim();
  const title = f.replace(/\b\w/g, c => c.toUpperCase());
  return typeof value === 'boolean' ? title : `${title}: ${String(value).replace(/_/g, ' ')}`;
};
function discoverWinnerSignals(episodes, existing) {
  const scored = new Set((existing || []).filter(s => s.active !== false).map(s => s.rule?.feature).filter(Boolean));
  const wonEps = episodes.filter(e => e.disposition === 'won');
  const lostEps = episodes.filter(e => e.disposition === 'lost');
  if (!wonEps.length) return [];
  const tally = new Map();
  const add = (eps, side) => { for (const e of eps) for (const [f, v] of Object.entries(e.features || {})) {
    if (v == null) continue;
    if (isNonFeatureProp(f)) continue;   // identity/metadata/vendor-id, never a signal
    const isBool = typeof v === 'boolean', isCat = typeof v === 'string' && v.length <= 40;
    if (!isBool && !isCat) continue;
    if (isBool && v === false) continue;
    const k = `${f}::${String(v)}`;
    const c = tally.get(k) || { feature: f, value: v, won: 0, lost: 0 };
    c[side]++; tally.set(k, c);
  }};
  add(wonEps, 'won'); add(lostEps, 'lost');
  const out = [];
  for (const c of tally.values()) {
    if (scored.has(c.feature)) continue;            // don't re-propose what we already score
    const wonFrac = c.won / wonEps.length;
    if (c.won === 0 || wonFrac < 0.5) continue;     // must be common among winners
    const lostFrac = lostEps.length ? c.lost / lostEps.length : 0;
    const weight = lostFrac === 0 ? 6 : lostFrac < 0.5 ? 4 : 2;  // weaker if losers share it
    out.push({ feature: c.feature, value: c.value, won: c.won, wonFrac, lostFrac, weight });
  }
  out.sort((a, b) => (b.wonFrac - b.lostFrac) - (a.wonFrac - a.lostFrac));
  return out.slice(0, 5).map(d => ({
    action: 'add',
    signal: {
      key: `win_${dslug(d.feature)}${typeof d.value === 'string' ? '_' + dslug(d.value) : ''}`,
      label: featLabel(d.feature, d.value),
      weight: d.weight,
      rule: { feature: d.feature, op: '==', value: d.value },
    },
    note: `on ${d.won} of your ${wonEps.length} won deal${wonEps.length === 1 ? '' : 's'}`,
  }));
}

// Build the scoring model from real closed deals (contrastive lift). Returns a
// result object; shared by the web route and the agent route
// (POST /v2/workspace/closed-deals). Errors propagate to the caller.
export async function runClosedDeals(supabase, workspaceId, { won = [], lost = [] } = {}) {
    const clean = (list) => (Array.isArray(list) ? list : [])
      .map(x => (typeof x === 'string' ? x : x?.domain))
      .map(cleanDomain)
      .filter(Boolean)
      .slice(0, 40);
    const wonList = clean(won), lostList = clean(lost);
    if (wonList.length + lostList.length < 1) {
      return { need_more_deals: true };
    }

    // Seniority ordering — when a company has several contacts (founder + two
    // CEOs), the MOST SENIOR one represents the deal's decision-maker for the
    // buyer traits; we still link and resolve ALL of them.
    const SENIORITY_RANK = { ic: 0, manager: 1, director: 2, vp: 3, c_suite: 4 };

    // Every contact we already have at a domain — recognized three ways:
    //   1. via the company record (companies.domain → contacts.company_id),
    //   2. the contact's own domain (contacts.domain),
    //   3. email as the fallback (entity_identifiers ilike @domain).
    // Returns deduped person entity ids (contact.id == entity.id by convention).
    const findPeopleAtDomain = async (domain) => {
      const ids = new Set();
      const [byContactDomain, comp, emails] = await Promise.all([
        supabase.from('contacts').select('id').eq('workspace_id', workspaceId).eq('domain', domain),
        supabase.from('companies').select('id').eq('workspace_id', workspaceId).eq('domain', domain).maybeSingle(),
        supabase.from('entity_identifiers').select('entity_id').eq('workspace_id', workspaceId).eq('kind', 'email').eq('status', 'active').ilike('value', `%@${domain}`),
      ]);
      for (const c of byContactDomain.data || []) ids.add(c.id);
      for (const e of emails.data || []) ids.add(e.entity_id);
      if (comp.data?.id) {
        const { data: byCompany } = await supabase.from('contacts').select('id')
          .eq('workspace_id', workspaceId).eq('company_id', comp.data.id);
        for (const c of byCompany || []) ids.add(c.id);
      }
      return [...ids];
    };

    const episodes = [];
    let enriched = 0;
    const linked = [];        // contacts we recognized and joined to the deal
    const companyDeals = [];  // {companyId, disposition} — scored after discovery
    const personDeals = [];   // {personId, disposition} — resolved after discovery
    const ingest = async (domain, disposition) => {
      const companyId = await getOrCreateEntity(supabase, workspaceId, 'company', [{ kind: 'domain', value: domain }]);
      const r = await extractAndRecordWebsiteSignals(supabase, workspaceId, companyId, domain).catch(() => null);
      if (r) enriched++;

      // Decision-maker linkage — recognize EVERY contact we already have at this
      // company, link each to the company (works_at), and record the won/lost on
      // each: that resolves their open ICP prediction and joins their pipeline
      // history (touches, calls, channel) to the deal.
      const personIds = await findPeopleAtDomain(domain);
      for (const personId of personIds) {
        try {
          await supabase.from('relationships').upsert(
            { workspace_id: workspaceId, from_entity_id: personId, to_entity_id: companyId, type: 'works_at', valid_from: new Date().toISOString() },
            { onConflict: 'workspace_id,from_entity_id,to_entity_id,type', ignoreDuplicates: true },
          );
        } catch { /* best-effort link */ }
        await logActivity(supabase, {
          workspaceId, entityId: personId,
          type: disposition === 'won' ? 'deal_won' : 'deal_lost',
          source: 'closed-deals-import', externalId: `import_${disposition}_${personId}`,
          occurredAt: new Date().toISOString(),
          description: disposition === 'won' ? 'Closed-won (closed-deals import)' : 'Closed-lost (closed-deals import)',
        }).catch(() => {});
        personDeals.push({ personId, disposition });
      }

      // Buyer traits for the episode — the most senior linked contact represents
      // the deal's decision-maker; all names are recorded for the UI.
      let buyer = {};
      if (personIds.length) {
        const { data: pc } = await supabase.from('claims').select('entity_id, property, value')
          .in('entity_id', personIds).is('invalid_at', null)
          .in('property', ['job_title', 'seniority', 'department', 'first_name', 'last_name']);
        const byPerson = {};
        for (const c of pc || []) (byPerson[c.entity_id] ||= {})[c.property] = c.value;
        let bestRank = -1;
        for (const pid of personIds) {
          const p = byPerson[pid] || {};
          const rank = SENIORITY_RANK[p.seniority] ?? 0;
          if (rank >= bestRank) { bestRank = rank; buyer = { job_title: p.job_title, seniority: p.seniority, department: p.department }; }
          const full = [p.first_name, p.last_name].filter(Boolean).join(' ') || null;
          linked.push({ domain, name: full || 'a contact' });
        }
      }

      // Record the deal on the company too (the company-level discovery cohort).
      await logActivity(supabase, {
        workspaceId, entityId: companyId,
        type: disposition === 'won' ? 'deal_won' : 'deal_lost',
        source: 'closed-deals-import', externalId: `import_${disposition}_${companyId}`,
        occurredAt: new Date().toISOString(),
        description: disposition === 'won' ? 'Imported closed-won' : 'Imported closed-lost',
      }).catch(() => {});

      // Episode features = company firmographics/signals + the decision-maker's
      // own traits (job_title/seniority/department) + the pipeline-engagement of
      // the deal (lead source, channel, inbound/outbound, meetings/touches) — so
      // discovery learns *who* buys and *how* the deal went, not just *what* the
      // company is.
      const { data: companyClaims } = await supabase
        .from('claims').select('property, value').eq('entity_id', companyId).is('invalid_at', null);
      const features = {};
      for (const c of companyClaims ?? []) features[c.property] = c.value;
      for (const [k, v] of Object.entries(buyer)) if (v != null && !(k in features)) features[k] = v;
      if (personIds.length) {
        const { data: pacts } = await supabase
          .from('observations').select('property, source, observed_at')
          .in('entity_id', personIds).eq('kind', 'event').like('property', 'interaction.%')
          .order('observed_at', { ascending: true }).limit(1000);
        for (const [k, v] of Object.entries(pipelineFeatures(pacts || []))) if (!(k in features)) features[k] = v;
      }
      episodes.push({ features, disposition });
      // Only surface the COMPANY as its own analyzed row when we have no contact
      // there — otherwise the linked person IS the account (with the real
      // pipeline), and a separate company row just duplicates it.
      companyDeals.push({ companyId, disposition, hasContacts: personIds.length > 0 });
    };
    for (const d of wonList) await ingest(d, 'won');
    for (const d of lostList) await ingest(d, 'lost');

    const existing = await listSignals(supabase, workspaceId);
    // Prefer rigorous contrastive lift; fall back to winner-signal extraction
    // when the cohort is too small for it to mean anything.
    let proposals = discoverSignals(episodes, existing);
    let mode = 'lift';
    if (proposals.length === 0) { proposals = discoverWinnerSignals(episodes, existing); mode = 'winners'; }
    for (const p of proposals) {
      await upsertSignal(supabase, workspaceId, {
        key: p.signal.key, label: p.signal.label, weight: p.signal.weight, rule: p.signal.rule,
      }).catch(() => {});
    }

    // The signal set just changed — re-score every OPEN account in place so the
    // whole table reflects the new model (and builds a re-score trail), not just
    // the closed-deal accounts. Idempotent: no-ops when versions already match.
    let rescored = 0;
    try { rescored = (await rescoreOpenPredictions(supabase, workspaceId)).rescored; } catch { /* best-effort */ }

    // Slice 4 — surface the closed-deal COMPANIES in the analyzed table. Score
    // each with the just-updated signals, then resolve it to its known outcome
    // (resolution reads the deal_won/lost observation recorded during ingest).
    // Skip companies already scored so re-runs don't duplicate rows.
    const freshSignals = await listSignals(supabase, workspaceId);
    let surfaced = 0;
    for (const { companyId, disposition, hasContacts } of companyDeals) {
      try {
        if (hasContacts) continue;   // the linked person carries this deal, not a dup company row
        const { count } = await supabase.from('predictions')
          .select('id', { count: 'exact', head: true })
          .eq('workspace_id', workspaceId).eq('entity_id', companyId).eq('kind', 'icp_fit');
        if (count) continue;
        const staked = await scoreAndStake(supabase, workspaceId, companyId, freshSignals);
        if (!staked) continue;
        // We KNOW the outcome — it's an imported closed deal — so resolve the
        // prediction directly (the won/lost obs predates this late stake, so the
        // observation-based resolver wouldn't see it).
        await supabase.from('predictions').update({
          resolved_at: new Date().toISOString(),
          outcome_value: { disposition, score: disposition === 'won' ? 1 : 0, imported: true },
        }).eq('id', staked.prediction_id);
        surfaced++;
      } catch { /* best-effort */ }
    }

    // The linked PEOPLE are the real accounts — resolve each directly to the
    // deal's known outcome (don't rely on the event hook, which is fragile to
    // timing/dedup). Score them first if they have no prediction yet; skip
    // anyone already resolved so re-runs don't churn.
    for (const { personId, disposition } of personDeals) {
      try {
        const { data: ex } = await supabase.from('predictions')
          .select('id, resolved_at').eq('workspace_id', workspaceId).eq('entity_id', personId).eq('kind', 'icp_fit')
          .order('predicted_at', { ascending: false }).limit(1);
        if (ex?.[0]?.resolved_at) continue;          // already resolved — leave it
        let pid = ex?.[0]?.id;
        if (!pid) {
          const staked = await scoreAndStake(supabase, workspaceId, personId, freshSignals);
          pid = staked?.prediction_id;
        }
        if (!pid) {
          // Unenriched contact (no scoreable features) — scoreAndStake gated it,
          // but we KNOW this deal closed, so still record the account from
          // whatever claims/pipeline it has.
          const { data: cl } = await supabase.from('claims').select('property, value').eq('entity_id', personId).is('invalid_at', null);
          const feats = {}, snap = {};
          for (const c of cl || []) { feats[c.property] = c.value; snap[c.property] = { value: c.value, confidence: 1 }; }
          const { data: pa } = await supabase.from('observations').select('property, source, observed_at')
            .eq('entity_id', personId).eq('kind', 'event').like('property', 'interaction.%').order('observed_at', { ascending: true }).limit(500);
          for (const [k, v] of Object.entries(pipelineFeatures(pa || []))) { feats[k] = v; snap[k] = { value: v, confidence: 1 }; }
          const sr = scoreLead(feats, freshSignals);
          const { data: ins } = await supabase.from('predictions').insert({
            workspace_id: workspaceId, entity_id: personId, kind: 'icp_fit',
            predicted_value: { score: sr.score, fit: sr.score >= 70, reason: 'closed-deal import (unenriched)' },
            predicted_confidence: sr.score / 100, feature_snapshot: snap, model_version: 'imported',
          }).select('id').single();
          pid = ins?.id;
        }
        if (!pid) continue;
        await supabase.from('predictions').update({
          resolved_at: new Date().toISOString(),
          outcome_value: { disposition, score: disposition === 'won' ? 1 : 0, imported: true },
        }).eq('id', pid);
      } catch { /* best-effort */ }
    }

    return {
      surfaced,
      enriched, won: wonList.length, lost: lostList.length, mode,
      linked: [...new Map(linked.map(l => [l.name, l])).values()],
      discovered: proposals.map(p => ({ label: p.signal.label, weight: p.signal.weight, note: p.note })),
    };
}

mindRouter.post('/closed-deals', requireIcpModel, async (req, res) => {
  try {
    const { workspaceId, won = [], lost = [] } = req.body;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    const r = await runClosedDeals(getSupabaseClient(), workspaceId, { won, lost });
    if (r.need_more_deals) return res.status(400).json({ error: 'need_more_deals', detail: 'add at least one closed deal (a won or lost domain)' });
    return res.status(201).json(r);
  } catch (err) {
    console.error('[POST /api/mind/closed-deals]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

