#!/usr/bin/env node
// Grade the risk signals that were written before risks had a grade (GET-402).
//
// WHY
//
// Risks came out of the CRM-corpus miner and out of Fellow health reads before
// `risk_signal.severity` existed. The category backfill (GET-401) stamped them all
// `at_risk` — the middle grade — because it could not tell a stated cancellation from an invoice
// complaint without reading them. The at-risk list ranks on that grade: a customer who wrote "we're
// moving to another vendor at renewal" has to sit above one who is missing an invoice, and
// without a grade they tie.
//
// The miner grades new risks itself now. This is the one pass over the old ones.
//
// WHAT IT DOES
//
// Reads every open `risk_signal` claim on the customer cohort that no model has graded (no
// `severity_source`), sends them to Haiku in batches of 25 — content plus verbatim quote, nothing
// else — and writes `severity` back with `severity_source: 'graded'`, so a second run skips them.
// A grade outside the three is not written. Nothing else on the row changes.
//
// It reads by entity id over the cohort, never by property across the workspace.
//
// COST: one Haiku call per batch of 25, so a small fraction of a cent per risk.
//
// USAGE (worker image, prod env):
//   WS_ID=<uuid> node apps/worker/scripts/gradeRiskSeverity.mjs            # dry run: prints the plan and a sample
//   WS_ID=<uuid> node apps/worker/scripts/gradeRiskSeverity.mjs --apply
//   ... --model claude-haiku-4-5-20251001

import { pathToFileURL } from 'node:url';
import { lockScript } from '../src/lib/backfillLock.mjs';
import { getSupabaseClient } from '@nous/core';
import { createMessage, messageText } from '../src/lib/llm.mjs';

const APPLY = process.argv.includes('--apply');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const MODEL = arg('model', 'claude-haiku-4-5-20251001');
const WS = process.env.WS_ID;
const BATCH = 25;
const PAGE = 1000;
export const SEVERITIES = new Set(['stated_churn', 'at_risk', 'friction']);

const SYSTEM = `You grade customer-success risk signals for a B2B software vendor. Each item is one sentence about a customer, plus the customer's own words it rests on.

Grade each with exactly one of:
- "stated_churn": they cancelled, gave notice, or said they are leaving or cutting the cord. Their words, not your inference. "We would like to cancel", "we are moving to X", "please close our account".
- "at_risk": they are reviewing vendors, questioning the value, naming a competitor, escalating a problem that is still open, or the person who championed us has left.
- "friction": a billing, invoicing, support or service failure they raised with real frustration, but no threat to leave.

Grade on the quote first, the sentence second. When the quote is a rep's summary rather than the customer's words, grade what the customer is reported to have said. Output ONLY a JSON array: [{"i": <number>, "severity": "<grade>"}]`;

/** Every row of a paged read. PostgREST truncates at 1000 without saying so. */
async function pageAll(make) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await make(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

/** The claims still to grade: open risk_signal rows on the cohort that carry no model grade. */
export function needsGrade(value) {
  if (String(value?.category ?? '').toLowerCase() !== 'risk_signal') return false;
  const m = value?.metadata ?? {};
  if (m.severity_source) return false;
  // Noema grades at extraction (the extractor's own severity, from a model that read the whole
  // conversation); re-grading it from a quote would be a worse reading of the same evidence.
  if (m.extraction_source && m.severity && !m.mined_from && !m.signal_type) return false;
  return true;
}

/** The grades a batch reply contains, keyed by item index. Anything outside the three is dropped. */
export function parseGrades(text) {
  const s = String(text ?? '');
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a < 0 || b <= a) return new Map();
  let arr;
  try { arr = JSON.parse(s.slice(a, b + 1)); } catch { return new Map(); }
  const out = new Map();
  for (const x of Array.isArray(arr) ? arr : []) {
    const i = Number(x?.i);
    if (Number.isInteger(i) && SEVERITIES.has(x?.severity)) out.set(i, x.severity);
  }
  return out;
}

async function cohort(supabase) {
  const base = (cols) => supabase.from('entity_list_rows').select(cols).eq('workspace_id', WS).eq('kind', 'account');
  const ids = new Set();
  const withHealth = await pageAll((f, t) => base('entity_id').not('cs', 'is', null).order('entity_id').range(f, t)).catch(() => []);
  for (const r of withHealth) ids.add(r.entity_id);
  for (const r of await pageAll((f, t) => base('entity_id').gt('won_deals', 0).order('entity_id').range(f, t))) ids.add(r.entity_id);
  return [...ids];
}

async function main() {
  if (!WS) { console.error('WS_ID is required'); process.exit(1); }
  const supabase = getSupabaseClient();
  const lock = await lockScript(supabase, WS, 'gradeRiskSeverity', { leaseMinutes: 90 });
  try { await run(supabase); } finally { await lock.release(); }
}

async function run(supabase) {
  const ids = await cohort(supabase);

  const todo = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabase.from('claims').select('id, value')
      .eq('workspace_id', WS).is('invalid_at', null).in('entity_id', ids.slice(i, i + 100))
      .like('property', 'note.%').eq('value->>category', 'risk_signal').limit(5000);
    if (error) throw new Error(error.message);
    for (const row of data ?? []) if (needsGrade(row.value)) todo.push(row);
  }
  console.log(`${ids.length} customer accounts · ${todo.length} risks to grade · ${Math.ceil(todo.length / BATCH)} calls on ${MODEL}`);
  if (!todo.length) return;
  if (!APPLY) {
    console.log('\nsample of what would be graded:');
    for (const r of todo.slice(0, 5)) console.log(`  · ${String(r.value.content).slice(0, 110)}\n      "${String(r.value.metadata?.quote ?? '').replace(/\s+/g, ' ').slice(0, 110)}"`);
    console.log('\nDry run. Re-run with --apply to grade and write.');
    return;
  }

  const counts = { stated_churn: 0, at_risk: 0, friction: 0, ungraded: 0, failed: 0 };
  let spend = 0;
  for (let b = 0; b < todo.length; b += BATCH) {
    const batch = todo.slice(b, b + BATCH);
    const prompt = batch.map((r, i) => `${i}. ${String(r.value.content).slice(0, 300)}\n   quote: "${String(r.value.metadata?.quote ?? '').replace(/\s+/g, ' ').slice(0, 300)}"`).join('\n');
    let grades = new Map();
    try {
      const msg = await createMessage({ feature: 'cs_risk_grading', model: MODEL, max_tokens: 800, system: SYSTEM, messages: [{ role: 'user', content: prompt }] });
      spend += Number(msg.cost_usd ?? 0);
      grades = parseGrades(messageText(msg));
    } catch (err) { counts.failed += batch.length; console.warn(`  batch ${b / BATCH}: ${err?.message ?? err}`); continue; }

    for (let i = 0; i < batch.length; i++) {
      const sev = grades.get(i);
      if (!sev) { counts.ungraded++; continue; }
      const row = batch[i];
      const value = { ...row.value, metadata: { ...(row.value.metadata ?? {}), severity: sev, severity_source: 'graded' } };
      const { error } = await supabase.from('claims').update({ value }).eq('id', row.id).eq('workspace_id', WS);
      if (error) { counts.failed++; continue; }
      counts[sev]++;
    }
    process.stdout.write(`\r  ${Math.min(b + BATCH, todo.length)}/${todo.length} · $${spend.toFixed(2)}   `);
  }
  console.log(`\ngraded: ${counts.stated_churn} stated_churn, ${counts.at_risk} at_risk, ${counts.friction} friction · ${counts.ungraded} left ungraded, ${counts.failed} failed · $${spend.toFixed(2)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
