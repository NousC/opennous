import { Router } from 'express';
import { getSupabaseClient, runForecast } from '@nous/core';

export const forecastV2Router = Router();

// POST /v2/forecast — how much revenue is likely to land in a period.
//
//   contribution = amount x P(win) x P(closes inside the period)
//
// The whole computation lives in @nous/core (services/forecastRun.ts) — this route is a
// thin shell per the layer rules, and deliberately so: the worker's weekly snapshot cron
// runs the SAME runForecast, so the number graded later is the number a caller saw here.
//
// Layer 1: Beta-smoothed stage conversion chain + censoring-aware timing curves.
// Layer 2: intent as a hazard multiplier on the timing half + Monte Carlo bands.
// Layer 3: per-account facts (ICP layers, objections, competitors, stall, threading)
//          adjust P(win) around the stage base rate — hand-set defaults until the
//          workspace's own fitted model earns its place on a time-ordered holdout.
// Every response carries `basis`, `win_model.basis` and per-deal pWinBase/pCloseBase so a
// number resting on assumptions never wears the same face as one built on evidence.
forecastV2Router.post('/', async (req, res) => {
  try {
    const out = await runForecast(getSupabaseClient(), req.workspaceId, {
      period: req.body || {},
    });
    return res.json(out);
  } catch (err) {
    console.error('[POST /v2/forecast]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /v2/forecast/snapshots — the forecast's own history: what it said, week by week.
//
// This is what makes the forecast gradeable. Once a period closes, these rows are the only
// record of what was predicted while it was still open — compare `expected`/p10/p90
// against what actually landed and you have the accuracy story (and the calibration input
// for the band). Written weekly by the worker cron; read-only here.
forecastV2Router.get('/snapshots', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 26, 1), 200);
    let q = supabase.from('forecast_snapshots')
      .select('id, period_start, period_end, taken_at, model_version, basis, expected, p10, p50, p90, deal_count, open_pipeline')
      .eq('workspace_id', req.workspaceId)
      .order('taken_at', { ascending: false })
      .limit(limit);
    if (req.query.period_start) q = q.eq('period_start', String(req.query.period_start));
    const { data, error } = await q;
    if (error) throw error;
    return res.json({ snapshots: data ?? [] });
  } catch (err) {
    console.error('[GET /v2/forecast/snapshots]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /v2/forecast/snapshots/:id — one snapshot with its full per-deal detail, for
// "what exactly did we think on the 3rd, and which deals carried the number".
forecastV2Router.get('/snapshots/:id', async (req, res) => {
  try {
    const { data, error } = await getSupabaseClient().from('forecast_snapshots')
      .select('*')
      .eq('workspace_id', req.workspaceId)
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'not_found' });
    return res.json(data);
  } catch (err) {
    console.error('[GET /v2/forecast/snapshots/:id]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
