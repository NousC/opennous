// What automations cost, in credits (GET-714). Every model call an automation run makes is recorded
// in llm_usage with request_id `automation-run:<run id>:step:<n>` (automationRun.mjs makeArtifact),
// so a run's cost is the sum of its rows, and a step's is the sum of that step's. Credits are the
// plan's own rate (REQUESTED_USD_PER_CREDIT, the one the credit meter bills at: one credit per
// $0.005), rounded up, so History and Usage and billing say what the meter charged (GET-721).
import { REQUESTED_USD_PER_CREDIT } from '@nous/core';

const costToCredits = (usd) => (usd > 0 ? Math.ceil(usd / REQUESTED_USD_PER_CREDIT - 1e-9) : 0);

const PAGE = 1000;

async function usageRows(supabase, workspaceId, since) {
  const out = [];
  for (let from = 0; from < 20_000; from += PAGE) {
    let q = supabase.from('llm_usage').select('request_id, cost_usd, occurred_at')
      .eq('workspace_id', workspaceId).like('request_id', 'automation-run:%');
    if (since) q = q.gte('occurred_at', since);
    const { data, error } = await q.order('occurred_at', { ascending: false }).range(from, from + PAGE - 1);
    if (error) return out;
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

/** "automation-run:<run>:step:<n>" → { runId, step }. Pure. */
export function parseRunRequestId(id) {
  const m = /^automation-run:([0-9a-f-]{36})(?::step:(\d+))?$/i.exec(String(id ?? ''));
  return m ? { runId: m[1], step: m[2] ? Number(m[2]) : null } : null;
}

/** Credits per run, with each step's share. Map runId → { credits, steps: [{ step, credits }] }. */
export async function creditsForRuns(supabase, workspaceId, runs) {
  const out = new Map();
  if (!runs.length) return out;
  const oldest = runs.map(r => r.started_at).filter(Boolean).sort()[0] ?? null;
  const wanted = new Set(runs.map(r => r.id));
  const cost = new Map();   // runId → Map(step → usd)
  for (const row of await usageRows(supabase, workspaceId, oldest)) {
    const p = parseRunRequestId(row.request_id);
    if (!p || !wanted.has(p.runId)) continue;
    const steps = cost.get(p.runId) ?? new Map();
    steps.set(p.step ?? 0, (steps.get(p.step ?? 0) ?? 0) + (Number(row.cost_usd) || 0));
    cost.set(p.runId, steps);
  }
  for (const [runId, steps] of cost) {
    const total = [...steps.values()].reduce((a, b) => a + b, 0);
    out.set(runId, {
      credits: costToCredits(total),
      steps: [...steps.entries()].sort(([a], [b]) => a - b).map(([step, usd]) => ({ step, credits: costToCredits(usd) })),
    });
  }
  return out;
}

/** Credits by automation over a window, most expensive first: [{ routine_id, name, runs, credits }]. */
export async function creditsByAutomation(supabase, workspaceId, { days = 30 } = {}) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const byRun = new Map();
  for (const row of await usageRows(supabase, workspaceId, since)) {
    const p = parseRunRequestId(row.request_id);
    if (p) byRun.set(p.runId, (byRun.get(p.runId) ?? 0) + (Number(row.cost_usd) || 0));
  }
  if (!byRun.size) return [];
  const ids = [...byRun.keys()];
  const runs = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await supabase.from('agent_routine_runs').select('id, routine_id').eq('workspace_id', workspaceId).in('id', ids.slice(i, i + 200));
    runs.push(...(data ?? []));
  }
  const per = new Map();   // routine → { usd, runs }
  for (const r of runs) {
    const e = per.get(r.routine_id) ?? { usd: 0, runs: 0 };
    e.usd += byRun.get(r.id) ?? 0; e.runs += 1;
    per.set(r.routine_id, e);
  }
  const { data: autos } = per.size
    ? await supabase.from('agent_routines').select('id, name').in('id', [...per.keys()])
    : { data: [] };
  const names = new Map((autos ?? []).map(a => [a.id, a.name]));
  return [...per.entries()]
    .map(([routine_id, e]) => ({ routine_id, name: names.get(routine_id) ?? 'Deleted automation', runs: e.runs, credits: costToCredits(e.usd) }))
    .sort((a, b) => b.credits - a.credits);
}
