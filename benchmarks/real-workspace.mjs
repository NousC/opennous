// real-workspace.mjs
//
// Read-only benchmark against a REAL, live Nous workspace (not the synthetic
// fixture in fixture.mjs / e2e-fixture.mjs). No writes, no observations, no
// merges — this only ever GETs/POSTs read endpoints.
//
// Two sections implemented so far:
//
//   1. CRM hygiene precision — pulls the proposals Nous's own CRM sync has
//      already flagged (GET /v2/workspace/crm-hygiene) so a human can confirm
//      how many are actually correct. This uses the workspace's own detected
//      candidates as ground truth, since there is no planted ground truth for
//      real data.
//
//   2. Consistency + efficiency (single-arm) — asks the same "who should I
//      focus on today" question N times via POST /v2/query (semantic mode,
//      return=entities) and measures: how many distinct entity-id sets came
//      back (1 = perfectly consistent), plus token estimate + latency per call.
//      This is single-arm on purpose: there is no synthetic rawView to serve
//      as an honest Arm A baseline against real data, so this measures the
//      graph arm's own stability and cost, not a reconstruct-vs-graph gap.
//
// A third section (spot-check against accounts the user knows personally) is
// intentionally not implemented yet — it needs real account identifiers +
// ground-truth facts supplied by the user first.
//
// Usage:
//   NOUS_API_URL=... NOUS_API_KEY=... node real-workspace.mjs --hygiene
//   NOUS_API_URL=... NOUS_API_KEY=... node real-workspace.mjs --consistency

function baseUrl(apiUrl) {
  return apiUrl.replace(/\/$/, '');
}
function headers(apiKey) {
  return { 'Content-Type': 'application/json', 'x-api-key': apiKey };
}

// ---------------------------------------------------------------------------
// SECTION 1: CRM hygiene proposals — read-only, for manual human review.
// ---------------------------------------------------------------------------

export async function fetchHygieneProposals(apiUrl, apiKey, { status = 'proposed', limit = 100 } = {}) {
  const url = `${baseUrl(apiUrl)}/v2/workspace/crm-hygiene?status=${status}&limit=${limit}`;
  const res = await fetch(url, { headers: headers(apiKey) });
  const json = await res.json();
  if (!res.ok) throw new Error(`GET /v2/workspace/crm-hygiene failed: ${res.status} ${JSON.stringify(json)}`);
  return json.proposals ?? [];
}

function formatProposal(p, i) {
  const who = p.contact?.name || p.contact?.email || p.entity_id || '(unknown)';
  const company = p.contact?.company ? ` @ ${p.contact.company}` : '';
  const conf = p.confidence != null ? p.confidence.toFixed(2) : 'n/a';
  return [
    `[${i + 1}] ${who}${company}`,
    `    kind: ${p.kind}  field: ${p.field ?? '—'}  confidence: ${conf}  provider: ${p.provider}`,
    `    current: ${JSON.stringify(p.current_value)}  →  proposed: ${JSON.stringify(p.proposed_value)}`,
    `    reason: ${p.reason ?? '—'}`,
    `    id: ${p.id}`,
  ].join('\n');
}

async function runHygiene(apiUrl, apiKey) {
  console.log('Fetching CRM hygiene proposals (status=proposed) ...\n');
  const proposals = await fetchHygieneProposals(apiUrl, apiKey);
  if (proposals.length === 0) {
    console.log('No pending proposals.');
    return { proposals: [] };
  }
  console.log(`${proposals.length} pending proposal(s):\n`);
  proposals.forEach((p, i) => console.log(formatProposal(p, i) + '\n'));
  console.log('--- Review these and tell the agent which ids are correct/incorrect to score precision. ---');
  return { proposals };
}

// ---------------------------------------------------------------------------
// SECTION 2: Consistency + efficiency (single-arm, graph only).
// ---------------------------------------------------------------------------

export async function askFocusQuestion(apiUrl, apiKey, question) {
  const url = `${baseUrl(apiUrl)}/v2/query`;
  const start = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({
      scope: { kind: 'event', since_days: 30, limit: 50 },
      return: 'entities',
      question,
    }),
  });
  const latencyMs = Date.now() - start;
  const json = await res.json();
  if (!res.ok) throw new Error(`POST /v2/query failed: ${res.status} ${JSON.stringify(json)}`);
  const entityIds = (json.items ?? []).map(i => i.entity_id).filter(Boolean).sort();
  const labels = (json.items ?? []).slice(0, 5).map(i => i.entity_name || i.most_recent_summary?.slice(0, 40) || i.entity_id);
  return {
    entityIds,
    labels,
    matched: json.matched,
    tokenEstimate: json.meta?.token_estimate ?? null,
    latencyMs,
  };
}

async function runConsistency(apiUrl, apiKey, { question = 'which accounts should I focus on today', runs = 5 } = {}) {
  console.log(`Asking "${question}" ${runs} times via /v2/query ...\n`);
  const results = [];
  for (let i = 0; i < runs; i++) {
    const r = await askFocusQuestion(apiUrl, apiKey, question);
    results.push(r);
    console.log(`[run ${i + 1}] matched: ${r.matched}  top: ${r.labels.join(' | ')}  | tokens: ${r.tokenEstimate ?? 'n/a'}  | latency: ${r.latencyMs}ms`);
  }

  const distinctSets = new Set(results.map(r => r.entityIds.join(',')));
  const avgTokens = avg(results.map(r => r.tokenEstimate).filter(v => v != null));
  const avgLatency = avg(results.map(r => r.latencyMs));

  console.log('\n--- Consistency + efficiency ---');
  console.log(`Distinct answer sets: ${distinctSets.size} / ${runs}  (1 = perfectly consistent)`);
  console.log(`Avg token estimate:   ${avgTokens != null ? avgTokens.toFixed(0) : 'n/a'}`);
  console.log(`Avg latency:          ${avgLatency.toFixed(0)}ms`);
  console.log('Note: this calls /v2/query directly (semantic retrieval), not an LLM agent looping over');
  console.log('tools like arms.mjs does — so "consistency" here means the retrieval layer itself is');
  console.log('deterministic/stable, not that an agent gives the same natural-language answer each time.');

  return { results, distinctSetCount: distinctSets.size, avgTokens, avgLatency };
}

function avg(nums) {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

// ---------------------------------------------------------------------------
// CLI ENTRY POINT
// ---------------------------------------------------------------------------

function requireEnv(apiUrl, apiKey) {
  if (!apiUrl || !apiKey) {
    console.error('NOUS_API_URL and NOUS_API_KEY must be set.\n');
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].endsWith('real-workspace.mjs')) {
  const mode = process.argv[2];
  const apiUrl = process.env.NOUS_API_URL;
  const apiKey = process.env.NOUS_API_KEY;
  requireEnv(apiUrl, apiKey);

  if (mode === '--hygiene') {
    await runHygiene(apiUrl, apiKey);
  } else if (mode === '--consistency') {
    await runConsistency(apiUrl, apiKey);
  } else {
    console.log('Usage:');
    console.log('  NOUS_API_URL=... NOUS_API_KEY=... node real-workspace.mjs --hygiene');
    console.log('  NOUS_API_URL=... NOUS_API_KEY=... node real-workspace.mjs --consistency');
  }
}
