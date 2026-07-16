import { listSignals, listNotes, scoreLead, modelVersion } from '@nous/core';

// The ICP model, rendered for write-back into the user's own ICP file.
//
// Nous keeps the ICP PROSE as a mirror of the user's file (context/icp.md), but
// it OWNS the learned half: which signals actually predict a win, by how much,
// and whether the model is calibrated. That learned half is what gets written
// back into their file inside a fenced <!-- nous:icp --> block, so the file they
// already maintain keeps sharpening underneath their own words.
//
// This module computes that learned model (computeIcpModel), finds the file to
// write it into (findIcpSourcePath), and renders the block (renderIcpBlock).

// The default file Nous reads/writes when the user has no existing ICP file and
// the agent creates one during onboarding. Convention-aligned (context/ is where
// Claude Code GTM setups keep foundations).
export const DEFAULT_ICP_PATH = 'context/icp.md';

export const ICP_BLOCK_START = '<!-- nous:icp start -->';
export const ICP_BLOCK_END = '<!-- nous:icp end -->';

// Compute the learned scoring model: active signals enriched with lift + the
// calibration gap, from resolved ICP-fit predictions. Mirrors the lift/gap math
// the GTM Context page's substrate endpoint uses, kept self-contained here.
export async function computeIcpModel(supabase, workspaceId) {
  const signals = await listSignals(supabase, workspaceId, { activeOnly: true });
  if (!signals.length) {
    return { has_model: false, signals: [], calibration: null, model_version: null };
  }

  const { data: preds } = await supabase
    .from('predictions')
    .select('predicted_value, outcome_value, resolved_at, predicted_at, feature_snapshot')
    .eq('workspace_id', workspaceId)
    .eq('kind', 'icp_fit')
    .order('predicted_at', { ascending: false })
    .limit(2000);
  const rows = preds || [];

  // ── Calibration gap: avg(outcome | scored >= 70) - avg(outcome | scored < 70).
  // A well-calibrated model scores the accounts that convert higher than the ones
  // that don't, so a large positive gap means the score is doing real work.
  const high = [], low = [];
  let won = 0, lost = 0;
  // ── Lift: winRate(signal fired) / winRate(not fired) across the decided cohort.
  const stat = new Map(signals.map(s => [s.key, { fires: 0, hits: 0 }]));
  let decided = 0, wins = 0;

  for (const p of rows) {
    if (!p.resolved_at) continue;
    const disp = p.outcome_value?.disposition;
    const os = Number(p.outcome_value?.score);
    const ps = Number(p.predicted_value?.score);

    if (Number.isFinite(ps) && Number.isFinite(os)) (ps >= 70 ? high : low).push(os);

    // Decided cohort = won + qualified-lost; 'no_opportunity' is excluded so cold
    // touches can't poison the lift. Pre-disposition rows fall back to the score.
    let isWin;
    if (disp) {
      if (disp === 'won') { won++; isWin = true; }
      else if (disp === 'no_opportunity') continue;
      else { lost++; isWin = false; }
    } else {
      if (!Number.isFinite(os)) continue;
      isWin = os >= 0.5;
    }
    decided++;
    if (isWin) wins++;

    const snap = p.feature_snapshot || {};
    const features = {};
    for (const [k, v] of Object.entries(snap)) features[k] = v?.value;
    const { fired } = scoreLead(features, signals);
    for (const f of fired) {
      const st = stat.get(f.key);
      if (!st) continue;
      st.fires++;
      if (isWin) st.hits++;
    }
  }

  const liftOf = (fires, hits) => {
    const notFired = decided - fires;
    const winsNotFired = wins - hits;
    if (fires < 3 || notFired < 1) return null;
    const wrFired = hits / fires;
    const wrNot = winsNotFired / notFired;
    if (wrNot <= 0) return null;
    return Math.round((wrFired / wrNot) * 10) / 10;
  };

  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const aHigh = avg(high), aLow = avg(low);
  const gap = aHigh != null && aLow != null ? Math.round((aHigh - aLow) * 100) / 100 : null;

  const enriched = signals.map(s => {
    const st = stat.get(s.key) || { fires: 0, hits: 0 };
    return {
      key: s.key,
      label: s.label || s.key,
      weight: s.weight,
      rule: s.rule,
      fires: st.fires,
      hits: st.hits,
      lift: liftOf(st.fires, st.hits),
    };
  });

  return {
    has_model: true,
    signals: enriched,
    calibration: { gap, resolved: decided, won, lost },
    has_outcomes: decided > 0,
    model_version: modelVersion(signals),
  };
}

// The file the learned block writes into: the source_path recorded on the ICP
// section at import time, falling back to the canonical default.
export async function findIcpSourcePath(supabase, workspaceId) {
  const notes = await listNotes(supabase, workspaceId, { categories: ['ICP'], limit: 50 });
  for (const n of notes) {
    const sp = n.metadata?.source_path;
    if (sp) return sp;
  }
  return DEFAULT_ICP_PATH;
}

const fmtWeight = (w) => (w > 0 ? `+${w}` : `${w}`);

// Render the fenced block the agent writes into the user's ICP file. The server
// renders it (not the agent) so the format is controlled centrally. Everything
// between the markers is Nous-owned and regenerated each sync.
export function renderIcpBlock(model, { syncedAt } = {}) {
  const date = (syncedAt || new Date().toISOString()).slice(0, 10);
  const lines = [ICP_BLOCK_START];
  lines.push(
    '<!-- Managed by Nous from your closed-deal outcomes. ' +
    'Edit your ICP above or below this block, never inside it. ' +
    'This block is regenerated on each sync. -->'
  );

  if (!model.has_model) {
    lines.push('## ICP scoring model (not built yet)');
    lines.push('');
    lines.push('_No scoring model yet. Run sync_icp to seed it from this file, then add closed deals to sharpen it._');
    lines.push(ICP_BLOCK_END);
    return lines.join('\n');
  }

  const drivers = model.signals.filter(s => s.weight > 0).sort((a, b) => b.weight - a.weight);
  // Hard exclusions ("who we are NOT") are pulled out of the detractors so they
  // read as a distinct, decisive list in the user's file — not lumped with the
  // soft loss-drivers the learning loop discovers.
  const exclusions = model.signals.filter(s => s.rule?.disqualify);
  const detractors = model.signals.filter(s => s.weight < 0 && !s.rule?.disqualify).sort((a, b) => a.weight - b.weight);
  const n = model.calibration?.won != null ? (model.calibration.won + model.calibration.lost) : 0;
  const dealsNote = model.has_outcomes ? `, ${n} closed deal${n === 1 ? '' : 's'}` : '';

  lines.push(`## What predicts a win (learned by Nous${dealsNote}, synced ${date})`);
  lines.push('_Read: weight feeds the 0-100 ICP score, lift = how much more often a deal wins when this is true, n = deals behind it._');
  lines.push('');

  const row = (s) => {
    const parts = [`- ${s.label}`, `  ${fmtWeight(s.weight)}`];
    if (s.lift != null) parts.push(`  ${s.lift}x lift`);
    if (s.fires > 0) parts.push(`  n=${s.fires}`);
    return parts.join('');
  };

  if (drivers.length) {
    lines.push('Win drivers:');
    for (const s of drivers) lines.push(row(s));
  }
  if (exclusions.length) {
    if (drivers.length) lines.push('');
    lines.push('Not a fit (hard exclusions — capped below Not-ICP):');
    // Show each exclusion with its feature key. Semantic exclusions (exclusion.*)
    // are judged from the website by signal-scan, which reads this block as its
    // lens and records the verdict on the matching key with the normal `record`
    // tool — so the key is shown for both the human and that pass to use.
    for (const s of exclusions) {
      const feat = s.rule?.feature ? `  \`${s.rule.feature}\`` : '';
      lines.push(`- ${s.label}${feat}`);
    }
  }
  if (detractors.length) {
    if (drivers.length || exclusions.length) lines.push('');
    lines.push('Loss drivers:');
    for (const s of detractors) lines.push(row(s));
  }

  if (model.calibration?.gap != null) {
    lines.push('');
    const g = model.calibration.gap;
    const reads = g > 0
      ? 'high-fit accounts convert more than low-fit'
      : 'not yet predictive — add more closed deals';
    lines.push(`Calibration gap ${g > 0 ? '+' : ''}${g} (${reads})`);
  } else if (!model.has_outcomes) {
    lines.push('');
    lines.push('_Seeded from your ICP. Add closed-won and closed-lost deals (train_icp_model) so Nous can learn which signals actually predict revenue._');
  }

  lines.push(ICP_BLOCK_END);
  return lines.join('\n');
}
