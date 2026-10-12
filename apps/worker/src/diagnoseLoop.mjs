// Diagnostic — answers "why no resolved predictions?" by walking each link of
// the compound-intelligence chain: scorecard signals → entities → claims →
// predictions (open + resolved) → outcomes.
import { getSupabaseClient } from '@nous/core';

const supabase = getSupabaseClient();

async function count(table, filter) {
  const q = supabase.from(table).select('id', { count: 'exact', head: true });
  for (const [col, op, val] of filter || []) {
    q[op](col, val);
  }
  const { count, error } = await q;
  if (error) return `error: ${error.message}`;
  return count ?? 0;
}

console.log('\n=== compound-intelligence chain ===\n');

// 1. Scorecard signals
const sigsActive = await count('scorecard_signals', [['active', 'eq', true]]);
const sigsTotal = await count('scorecard_signals', []);
console.log(`1. scorecard_signals:     ${sigsTotal} total, ${sigsActive} active`);

// 2. Entities (the population that can be scored)
const entitiesTotal = await count('entities', []);
console.log(`2. entities:              ${entitiesTotal} total`);

// 3. Claims (the beliefs prediction-write reads from)
const claimsTotal = await count('claims', []);
console.log(`3. claims:                ${claimsTotal} total`);

// 4. Predictions
const predTotal = await count('predictions', []);
const predOpen = await count('predictions', [['resolved_at', 'is', null]]);
const predResolved = await count('predictions', [['resolved_at', 'not', null]]);
const predIcpFit = await count('predictions', [['kind', 'eq', 'icp_fit']]);
console.log(`4. predictions:           ${predTotal} total · ${predOpen} open · ${predResolved} resolved · ${predIcpFit} icp_fit`);

// 5. Observations (what feeds claims)
const obsTotal = await count('observations', []);
console.log(`5. observations:          ${obsTotal} total`);

// 6. By workspace
console.log('\n=== per workspace ===\n');
const { data: workspaces } = await supabase.from('workspaces').select('id, name').limit(20);
for (const ws of workspaces ?? []) {
  const wsSigs = await count('scorecard_signals', [['workspace_id', 'eq', ws.id], ['active', 'eq', true]]);
  const wsEnts = await count('entities', [['workspace_id', 'eq', ws.id]]);
  const wsClaims = await count('claims', [['workspace_id', 'eq', ws.id]]);
  const wsPredOpen = await count('predictions', [['workspace_id', 'eq', ws.id], ['resolved_at', 'is', null]]);
  const wsPredResolved = await count('predictions', [['workspace_id', 'eq', ws.id], ['resolved_at', 'not', null]]);
  console.log(`${ws.id.slice(0, 8)} ${(ws.name || '').padEnd(30)}  signals=${wsSigs} entities=${wsEnts} claims=${wsClaims} pred_open=${wsPredOpen} pred_resolved=${wsPredResolved}`);
}

// 7. Show 5 most-recent predictions if any exist
if (predTotal > 0) {
  console.log('\n=== latest predictions ===\n');
  const { data: latest } = await supabase
    .from('predictions')
    .select('id, workspace_id, entity_id, kind, predicted_score, predicted_at, resolved_at, outcome_value')
    .order('predicted_at', { ascending: false })
    .limit(5);
  for (const p of latest ?? []) {
    console.log(`${p.predicted_at}  kind=${p.kind} score=${p.predicted_score} resolved=${p.resolved_at ? 'yes' : 'no'}`);
  }
}

// 8. Sample entity to see if any has claims that prediction-write would pick up
console.log('\n=== entities needing score (sample) ===\n');
if ((workspaces ?? []).length) {
  const ws = workspaces[0];
  // Entities with claims (i.e. that prediction-write could score)
  const { data: claimedEntities } = await supabase
    .from('claims')
    .select('entity_id')
    .eq('workspace_id', ws.id)
    .limit(5);
  const uniqueEntityIds = [...new Set((claimedEntities ?? []).map(c => c.entity_id))];
  console.log(`workspace ${ws.id.slice(0, 8)}: ${uniqueEntityIds.length} entit${uniqueEntityIds.length === 1 ? 'y' : 'ies'} carrying claims (sample)`);
}

process.exit(0);
