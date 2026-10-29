// Backtest the ICP score on closed deals (GET-1074). READ-ONLY: writes nothing.
//
// Scores every won/lost deal in deal_outcomes the way the live scorer would score its
// account today (best-fitting contact, ICP rules only) and prints how well the score
// separates winners: conversion per tier, the score-quality verdict, coverage, and lift
// per rule. See packages/core/src/cloud/icpBacktest.ts for the honest limits.
//
//   node apps/api/scripts/icpBacktest.mjs [--workspace=<uuid>] [--json]

import { getSupabaseClient, listSignals, getTierThresholds } from '@nous/core';
import { backtestIcp } from '@nous/core/cloud';
import { summarizeScoreQuality } from '../src/cloud/lib/icpModel.mjs';

const argv = process.argv.slice(2);
const arg = (name) => (argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1] || null;
const ONLY = arg('workspace');
const JSON_OUT = argv.includes('--json');

// The same features the live path builds (packages/core/src/db/predictions.ts).
const COMPANY_FEATURES = ['industry', 'employee_count', 'keywords', 'description'];
const SCOREABLE = ['job_title', 'seniority', 'department', 'industry', 'employee_count'];

const supabase = getSupabaseClient();
const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

async function all(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().order('id', { ascending: true }).range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < 1000) return out;
  }
}

async function claimsFor(ws, ids, filter) {
  const by = new Map();
  for (const grp of chunks(ids, 200)) {
    const rows = await all(() => filter(supabase.from('claims').select('id, entity_id, property, value')
      .eq('workspace_id', ws).in('entity_id', grp).is('invalid_at', null)));
    for (const c of rows) (by.get(c.entity_id) ?? by.set(c.entity_id, []).get(c.entity_id)).push(c);
  }
  return by;
}

async function backtestWorkspace(ws) {
  const signals = await listSignals(supabase, ws, { activeOnly: true });
  if (!signals.length) return null;
  const thresholds = await getTierThresholds(supabase, ws);

  const deals = await all(() => supabase.from('deal_outcomes').select('id, entity_id, outcome, closed_at')
    .eq('workspace_id', ws).in('outcome', ['won', 'lost']));
  if (!deals.length) return null;

  // Deal entity → its company (belongs_to); a company-level deal is its own company.
  const companyOf = new Map(deals.map(d => [d.entity_id, d.entity_id]));
  for (const grp of chunks([...companyOf.keys()], 200)) {
    const rels = await all(() => supabase.from('relationships').select('id, from_entity_id, to_entity_id')
      .eq('workspace_id', ws).eq('type', 'belongs_to').in('from_entity_id', grp));
    for (const r of rels) companyOf.set(r.from_entity_id, r.to_entity_id);
  }
  const companies = [...new Set(companyOf.values())];

  const peopleOf = new Map();
  for (const grp of chunks(companies, 200)) {
    const rels = await all(() => supabase.from('relationships').select('id, from_entity_id, to_entity_id')
      .eq('workspace_id', ws).eq('type', 'works_at').is('valid_to', null).in('to_entity_id', grp));
    for (const r of rels) (peopleOf.get(r.to_entity_id) ?? peopleOf.set(r.to_entity_id, []).get(r.to_entity_id)).push(r.from_entity_id);
  }

  // Only the features an ICP rule or the scoreable gate reads.
  const ruleFeatures = signals.map(s => s.rule?.feature).filter(Boolean);
  const personProps = [...new Set([...ruleFeatures, ...SCOREABLE])];
  const companyClaims = await claimsFor(ws, companies, q => q.or(
    `property.in.(${COMPANY_FEATURES.join(',')}),property.like.signal.%,property.like.exclusion.%`));
  const personClaims = await claimsFor(ws, [...new Set([...peopleOf.values()].flat())], q => q.in('property', personProps));

  // Company features a person inherits, built like buildEntityFeatures.
  const inherited = (companyId) => {
    const f = {};
    for (const c of companyClaims.get(companyId) || []) {
      if (COMPANY_FEATURES.includes(c.property)) f[c.property] = c.value;
      else if (c.property.startsWith('signal.')) { if (typeof c.value?.score === 'number') f[c.property] = c.value.score; }
      else if (c.property.startsWith('exclusion.')) { if (c.value?.matched !== false) f[c.property] = c.value ?? true; }
    }
    return f;
  };

  const input = deals.map(d => {
    const company = companyOf.get(d.entity_id);
    const base = inherited(company);
    const people = peopleOf.get(company) || [];
    const contacts = people.length
      ? people.map(p => { const f = {}; for (const c of personClaims.get(p) || []) f[c.property] = c.value; return { ...f, ...base }; })
      : [base];
    return { id: d.id, outcome: d.outcome, closedAt: d.closed_at, contacts };
  });

  const result = backtestIcp(input, signals, thresholds);
  const quality = summarizeScoreQuality(result.rows.map(r => ({
    resolved_at: r.closedAt, predicted_value: { score: r.score, tier: r.tier }, outcome_value: { disposition: r.outcome },
  })));
  return { workspace_id: ws, coverage: result.coverage, quality, rules: result.rules };
}

const pct = (r) => (r == null ? '–' : `${Math.round(r * 1000) / 10}%`);

async function main() {
  const workspaces = ONLY ? [ONLY] : [...new Set((await all(() => supabase.from('deal_outcomes').select('id, workspace_id'))).map(r => r.workspace_id))];
  const reports = [];
  for (const ws of workspaces) {
    const r = await backtestWorkspace(ws);
    if (r) reports.push(r);
  }
  if (JSON_OUT) { console.log(JSON.stringify(reports, null, 2)); return; }

  console.log('\n=== ICP backtest on closed deals (read-only) ===');
  for (const r of reports) {
    const { coverage: c, quality: q } = r;
    console.log(`\nworkspace ${r.workspace_id}`);
    console.log(`  scored ${c.won.scored}/${c.won.total} won, ${c.lost.scored}/${c.lost.total} lost (rest have nothing to score on)`);
    for (const t of q.tiers) console.log(`  ${t.label.padEnd(8)} ${String(t.won).padStart(5)} won ${String(t.lost).padStart(5)} lost  ${pct(t.rate)}`);
    console.log(`  fit ${pct(q.fit_rate)} vs rest ${pct(q.rest_rate)}: ${q.verdict.text}`);
    console.log('  rules (fired won/lost, lift):');
    for (const s of r.rules) console.log(`    ${s.weight > 0 ? '+' : ''}${s.weight}  ${s.key.padEnd(40)} ${s.fired_won}/${s.fired_lost}  ${s.lift == null ? '–' : `${s.lift}x`}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
