import { listSignals, listNotes, icpSignals, isLearnableDisposition, scoreTier, TIER_META, scoreLead, modelVersion, latestIcpBacktest, IMPACT_LABEL, RATIO_CAP } from '@nous/core';

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
// readIcpModel puts the three together for GET /v2/workspace/icp/model and GET /v2/icp
// (routes/v2/workspaceStatus.mjs reaches it through lib/icpScorer.mjs). Cloud-only: the
// learned half is Nous Cloud's model (GET-754 slice 8).

// The default file Nous reads/writes when the user has no existing ICP file and
// the agent creates one during onboarding. Convention-aligned (context/ is where
// Claude Code GTM setups keep foundations).
export const DEFAULT_ICP_PATH = 'context/icp.md';

export const ICP_BLOCK_START = '<!-- nous:icp start -->';
export const ICP_BLOCK_END = '<!-- nous:icp end -->';

// How good is the score (GET-1069)? Actual conversion per tier, from real won/lost
// only. already_decided (known before scoring, GET-1068) and no_opportunity are
// counted as left out, never as outcomes. One summary for the ICP file's block, the
// API and the ICP page, so all three say the same thing.
const TIERS = ['tier_1', 'tier_2', 'tier_3', 'not_icp'];
const MIN_GRADED = 20, MIN_WON = 5;

export function summarizeScoreQuality(rows) {
  const tiers = new Map(TIERS.map(t => [t, { tier: t, label: TIER_META[t]?.label ?? t, won: 0, lost: 0 }]));
  const graded = { won: 0, lost: 0 };
  const left_out = { already_decided: 0, no_opportunity: 0 };
  for (const p of rows || []) {
    if (!p.resolved_at) continue;
    const disp = p.outcome_value?.disposition;
    if (disp === 'already_decided' || disp === 'no_opportunity') { left_out[disp]++; continue; }
    if (!isLearnableDisposition(disp)) continue;
    const t = tiers.get(p.predicted_value?.tier ?? scoreTier(p.predicted_value?.score));
    if (!t) continue;
    t[disp]++;
    graded[disp]++;
  }
  const rate = (w, l) => (w + l ? Math.round((w / (w + l)) * 1000) / 1000 : null);
  const tierRows = [...tiers.values()].map(t => ({ ...t, rate: rate(t.won, t.lost) }));

  const sum = (keys) => tierRows.filter(t => keys.includes(t.tier)).reduce((a, t) => ({ won: a.won + t.won, lost: a.lost + t.lost }), { won: 0, lost: 0 });
  const fit = sum(['tier_1', 'tier_2']), rest = sum(['tier_3', 'not_icp']);
  const fitRate = rate(fit.won, fit.lost), restRate = rate(rest.won, rest.lost);
  let verdict;
  if (graded.won + graded.lost < MIN_GRADED || graded.won < MIN_WON) {
    verdict = { key: 'learning', text: `Only ${graded.won} won / ${graded.lost} lost graded so far, not enough to judge. The score is still your ICP.` };
  } else if (fitRate == null || restRate == null) {
    verdict = { key: 'learning', text: 'All graded deals fall on one side of the fit line, so there is nothing to compare yet. The score is still your ICP.' };
  } else {
    const ratio = restRate > 0 ? Math.round((fitRate / restRate) * 10) / 10 : null;
    if (ratio == null || ratio >= 1.5) verdict = { key: 'separates', ratio, text: `Fit accounts (Tier 1–2) convert ${ratio == null ? 'where the rest never do' : `${ratio}× as often as the rest`}. The score is doing its job.` };
    else if (ratio > 1.1) verdict = { key: 'weak', ratio, text: `Fit accounts convert only a little more often than the rest (${ratio}×). Sharpen the ICP.` };
    else verdict = { key: 'not_predictive', ratio, text: "Fit accounts don't convert more often than the rest yet. The ICP needs work." };
  }
  return { graded, left_out, tiers: tierRows, fit_rate: fitRate, rest_rate: restRate, verdict };
}

const fmtPct = (r) => `${Math.round(r * 1000) / 10}%`;
const fmtN = (n) => n.toLocaleString('en-US');

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
    .not('resolved_at', 'is', null)   // only resolved rows count below; don't spend the cap on open ones
    .order('predicted_at', { ascending: false })
    .limit(5000);
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
    if (disp === 'already_decided') continue;   // known before scoring (GET-1068)
    const os = Number(p.outcome_value?.score);
    const ps = Number(p.predicted_value?.score);

    if (Number.isFinite(ps) && Number.isFinite(os)) (ps >= 70 ? high : low).push(os);

    // Decided cohort = won + qualified-lost; 'no_opportunity' is excluded so cold
    // touches can't poison the lift. Pre-disposition rows fall back to the score.
    let isWin;
    if (disp) {
      if (disp === 'won') { won++; isWin = true; }
      else if (!isLearnableDisposition(disp)) continue;   // no_opportunity, already_decided
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
    const { fired } = scoreLead(features, icpSignals(signals));
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
    quality: summarizeScoreQuality(rows),
    // The newest backtest on closed deals (GET-1074), when the worker has run one.
    backtest: await latestIcpBacktest(supabase, workspaceId).catch(() => null),
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

  if (model.backtest) {
    lines.push(...backtestLines(model.backtest, date, model.quality));
    lines.push(ICP_BLOCK_END);
    return lines.join('\n');
  }

  const drivers = model.signals.filter(s => s.weight > 0).sort((a, b) => b.weight - a.weight);
  // Hard exclusions ("who we are NOT") are pulled out of the detractors so they
  // read as a distinct, decisive list in the user's file — not lumped with the
  // soft loss-drivers the learning loop discovers.
  const exclusions = model.signals.filter(s => s.rule?.disqualify);
  const detractors = model.signals.filter(s => s.weight < 0 && !s.rule?.disqualify).sort((a, b) => a.weight - b.weight);
  // Describe the evidence honestly. Lift can only be LEARNED from wins (losses
  // alone give nothing to contrast against), so a cohort of losses with zero wins
  // is still seed estimates — don't call it "learned … N closed deals" as if the
  // model trained on them. Split won/lost so the header can't overstate.
  const won = model.calibration?.won ?? 0;
  const lost = model.calibration?.lost ?? 0;
  const n = won + lost;
  const learned = won > 0;
  const dealsNote = !model.has_outcomes ? ''
    : learned ? `, ${n} closed deal${n === 1 ? '' : 's'} — ${won} won / ${lost} lost`
    : `, ${lost} closed-lost, no wins yet`;

  lines.push(`## What predicts a win (${learned ? 'learned by Nous' : 'seed estimates'}${dealsNote}, synced ${date})`);

  // Trust first (GET-1070): whether to rely on the score is what a reader, person
  // or agent, needs before the drivers.
  const q = model.quality;
  const showQuality = q && (q.graded.won + q.graded.lost + q.left_out.already_decided) > 0;
  if (showQuality) {
    lines.push('');
    lines.push('How good is this score:');
    const out = [];
    if (q.left_out.already_decided) out.push(`${fmtN(q.left_out.already_decided)} left out: already customers or already lost when scored`);
    if (q.left_out.no_opportunity) out.push(`${fmtN(q.left_out.no_opportunity)} never became an opportunity`);
    lines.push(`- Graded on ${fmtN(q.graded.won)} won / ${fmtN(q.graded.lost)} lost${out.length ? `. ${out.join('; ')}` : ''}`);
    const conv = q.tiers.filter(t => t.rate != null).map((t, i) => `${t.label}${i === 0 ? ' converted' : ''} ${fmtPct(t.rate)}`);
    if (conv.length) lines.push(`- ${conv.join(' · ')}`);
    lines.push(`- ${q.verdict.text}`);
    lines.push(`- For agents: ${q.verdict.key === 'separates'
      ? 'route on the tier.'
      : 'the tier is a hint, not yet proven by outcomes. Check the account yourself before you route on it.'}`);
  }

  // Drivers as a table so the columns line up wherever the file is read.
  const cell = (v) => String(v).replace(/\|/g, '\\|');
  const table = (title, list) => {
    lines.push('');
    lines.push(`| ${title} | Weight | Lift | n |`);
    lines.push('|---|---:|---:|---:|');
    for (const s of list) {
      lines.push(`| ${cell(s.label)} | ${fmtWeight(s.weight)} | ${s.lift != null ? `${s.lift}x` : '–'} | ${s.fires > 0 ? s.fires : '–'} |`);
    }
  };

  if (drivers.length) table('Win drivers', drivers);
  if (exclusions.length) {
    lines.push('');
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
  if (detractors.length) table('Loss drivers', detractors);
  if (drivers.length || detractors.length) {
    lines.push('');
    lines.push('_Weight feeds the 0-100 ICP score. Lift = how much more often a deal wins when this is true. n = deals behind it._');
  }

  // The calibration gap says what the quality verdict says, less readably; keep it
  // only as the fallback when there is no quality summary.
  if (!showQuality && model.calibration?.gap != null) {
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

// With a backtest (GET-1074) the block reads like the ICP page: same sections, same words.
const pct1 = (r) => (r == null ? '–' : `${Math.round(r * 1000) / 10}%`);
const cell = (v) => String(v).replace(/\|/g, '\\|');
const fmtX = (x) => (x >= RATIO_CAP ? `${RATIO_CAP}×+` : `${x}×`);

function backtestLines(bt, date, quality) {
  const r = bt.result ?? bt;
  const a = r.accuracy;
  const scored = r.coverage.won.scored + r.coverage.lost.scored;
  const since = r.period?.from ? ` since ${r.period.from.slice(0, 4)}` : '';
  // ", synced <date>)" is the form livingFiles.mjs strips to tell a real change from a new day.
  const out = [`## What the deals say (backtest, synced ${date})`, '', `Score accuracy: ${a.label}`];
  out.push(`- Deals analyzed: ${fmtN(scored)}${since} · win rate ${pct1(a.win_rate)}`);
  if (a.fit_rate != null && a.rest_rate != null) {
    const raw = a.raw_ratio != null ? ` (${fmtX(a.raw_ratio)})` : '';
    const ctl = a.controlled_ratio != null ? `; ${fmtX(a.controlled_ratio)} at equal contact coverage` : '';
    out.push(`- ICP win rate ${pct1(a.fit_rate)} vs ${pct1(a.rest_rate)} non-ICP${raw}${ctl}`);
  }
  if (quality && quality.graded.won + quality.graded.lost > 0) out.push(`- Live: ${fmtN(quality.graded.won)} won / ${fmtN(quality.graded.lost)} lost graded since scoring`);
  out.push(`- For agents: ${a.key === 'validated' ? 'route on the tier.' : 'treat the tier as a hint. Research the account before you route on it.'}`);

  out.push('', 'Win rate by tier', '| Tier | Deals | Win rate | Won / lost |', '|---|---:|---:|---|');
  for (const t of r.tiers) out.push(`| ${t.label} | ${fmtN(t.won + t.lost)} | ${pct1(t.rate)} | ${fmtN(t.won)} / ${fmtN(t.lost)} |`);

  if (r.rules.length) {
    out.push('', 'Scoring criteria', '| Criterion | Weight | Deals | Impact |', '|---|---:|---:|---|');
    for (const c of r.rules) {
      const n = c.fired_won + c.fired_lost;
      const impact = IMPACT_LABEL[c.impact] + ((c.impact === 'positive' || c.impact === 'negative') && c.controlled_lift != null ? ` · ${fmtX(c.controlled_lift)}` : '');
      out.push(`| ${cell(c.label)} | ${fmtWeight(c.weight)} | ${n ? fmtN(n) : '–'} | ${impact} |`);
    }
  }

  if (r.disqualifiers.length) {
    // The feature key stays visible: signal-scan reads this block as its lens and records the
    // verdict on that key with the normal `record` tool.
    const STATUS = { no_data: 'No data', working: 'Working', review: 'Review' };
    out.push('', 'Disqualifiers', '| Disqualifier | Deals capped | Status |', '|---|---:|---|');
    for (const d of r.disqualifiers) {
      const key = d.feature ? ` \`${d.feature}\`` : '';
      out.push(`| ${cell(d.label)}${key} | ${d.capped ? fmtN(d.capped) : '–'} | ${STATUS[d.status]}${d.status === 'review' ? ` · ${d.won} won` : ''} |`);
    }
  }

  if (r.data_coverage.length) out.push('', 'Data coverage', `- ${r.data_coverage.map(c => `${c.label} ${Math.round(c.share * 100)}%`).join(' · ')}`);
  if (r.recommendations.length) {
    out.push('', 'Recommendations');
    for (const x of r.recommendations) out.push(`- ${x.text} (${x.meta})`);
  }
  return out;
}

/** The learned ICP model as GET /v2/workspace/icp/model serves it. Also read by GET /v2/icp. */
export async function readIcpModel(supabase, workspaceId) {
  const model = await computeIcpModel(supabase, workspaceId);
  const target_path = await findIcpSourcePath(supabase, workspaceId);
  const block = renderIcpBlock(model, {});
  return {
    has_model: model.has_model,
    has_outcomes: model.has_outcomes ?? false,
    target_path,
    block,
    block_start: '<!-- nous:icp start -->',
    block_end: '<!-- nous:icp end -->',
    signals: model.signals,
    calibration: model.calibration,
    quality: model.quality ?? null,   // how good the score is, per tier (GET-1069)
    model_version: model.model_version,
  };
}
