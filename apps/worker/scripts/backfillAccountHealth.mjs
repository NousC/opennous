#!/usr/bin/env node
// Read a portal's account-health fields into the graph, once, and light up the Customer Success
// page without re-importing anything else.
//
// WHY THIS EXISTS
//
// The CS page stopped deriving who a customer is and started reading the CRM's own fields
// (packages/core/src/integrations/crm/accountHealth.ts). Those fields arrive on the COMPANY
// record, so every future sync picks them up for free — but a portal that was connected before
// this shipped has none of them in the graph, and waiting for the next full sync means waiting
// for contacts, deals, engagements and commerce to run first.
//
// This is the companies pass on its own. It reads companies, writes their facts, and stops.
//
// WHAT IT COSTS
//
// Reads: one HubSpot search page per 100 companies (rate limit 100 req/10s, handled upstream).
// Writes: the same `companyFacts` observations the normal sync writes — plus the `cs.*` bag for
// rows that show any sign of being a customer. A prospect yields an empty bag and writes nothing
// extra, so on a large portal this is a few hundred companies' worth of health, not tens of thousands.
//
// It then settles the claim queue, because the page reads CLAIMS (via the projection) and an
// observation that has not settled is invisible to it. Without this step the page stays empty for
// as long as the shared claim engine takes to wander past — most of a day on a big workspace.
//
// USAGE (worker image, prod env):
//   WS_ID=<uuid> HUBSPOT_TOKEN=pat-... node apps/worker/scripts/backfillAccountHealth.mjs
//   WS_ID=<uuid> HUBSPOT_TOKEN=pat-... node apps/worker/scripts/backfillAccountHealth.mjs --apply
//
// Dry run by default: it fetches ONE page of companies and prints what the health read found, so
// you can see whether a portal keeps these fields at all before writing anything.

import {
  getSupabaseClient, syncCrmProvider, settleClaimQueue,
  accountHealthProperties, readAccountHealth,
} from '@nous/core';
import { lockScript, WORKSPACE_WIDE_JOB } from '../src/lib/backfillLock.mjs';

const WS = process.env.WS_ID;
const TOKEN = process.env.HUBSPOT_TOKEN;
const APPLY = process.argv.includes('--apply');

if (!WS || !TOKEN) {
  console.error('WS_ID and HUBSPOT_TOKEN are required');
  process.exit(1);
}

// ── dry run: does this portal keep account health at all? ───────────────────────────────────
const props = accountHealthProperties('hubspot');
const res = await fetch('https://api.hubapi.com/crm/v3/objects/companies/search', {
  method: 'POST',
  headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    filterGroups: [{ filters: [{ propertyName: 'lifecyclestage', operator: 'EQ', value: 'customer' }] }],
    properties: ['name', ...props], limit: 100,
  }),
});
if (!res.ok) {
  console.error(`HubSpot ${res.status}: ${(await res.text()).slice(0, 300)}`);
  process.exit(1);
}
const sample = (await res.json()).results ?? [];
const filled = new Map();
for (const c of sample) {
  for (const [fact, value] of Object.entries(readAccountHealth('hubspot', c.properties ?? {}))) {
    const f = filled.get(fact) ?? { n: 0, example: null };
    f.n++; if (f.example == null) f.example = value;
    filled.set(fact, f);
  }
}
console.log(`sampled ${sample.length} companies the portal marks a customer`);
if (!filled.size) {
  console.log('This portal keeps NONE of the account-health fields we know how to read.');
  console.log('The CS page will fall back to deals, which is the honest answer, and nothing here');
  console.log('would change that. Add this portal\'s property names to HUBSPOT_MAP first.');
  process.exit(0);
}
for (const [fact, f] of [...filled].sort((a, b) => b[1].n - a[1].n)) {
  const pct = `${Math.round((100 * f.n) / sample.length)}%`.padStart(4);
  console.log(`  ${pct}  ${fact.padEnd(24)} e.g. ${JSON.stringify(f.example).slice(0, 60)}`);
}

if (!APPLY) {
  console.log('\nDry run. Re-run with --apply to sync every company and settle the claims.');
  process.exit(0);
}

// ── the run ─────────────────────────────────────────────────────────────────────────────────
const supabase = getSupabaseClient();
const { data: ws } = await supabase.from('workspaces').select('id, name').eq('id', WS).maybeSingle();
if (!ws) { console.error(`workspace ${WS} not found`); process.exit(1); }
// It settles the claim queue for the whole workspace afterwards: one writer.
const lock = await lockScript(supabase, WS, WORKSPACE_WIDE_JOB, { note: 'backfillAccountHealth', leaseMinutes: 120 });

const started = Date.now();
// `only: ['companies']` and no `since`: every company, one pass, nothing else. Deals, contacts,
// engagements and commerce are untouched — this must not be able to disturb a pipeline hours
// before somebody demos it.
const result = await syncCrmProvider(supabase, WS, 'hubspot', TOKEN, null, { only: ['companies'] });
console.log(JSON.stringify({
  workspace: ws.name,
  seconds: Math.round((Date.now() - started) / 1000),
  companies: result.companies, warnings: result.warnings, errors: result.errors,
}, null, 2));

// The page reads claims, not observations. Settle now rather than leaving it to the engine.
const settle = await settleClaimQueue(supabase, WS, {
  onProgress: p => process.stdout.write(`\r  settling ${p.phase}: ${p.settled} targets, ${p.failed} failed   `),
});
console.log(`\nsettled ${settle.settled} targets in ${settle.seconds}s (${settle.pending} still pending)`);

// Finally the projection, so `entity_list_rows.cs` is filled and the page has something to read.
// Needs supabase/migrations/2026_09_21_account_health_rows.sql applied first; without it the
// refresh still succeeds and simply has no column to write the bag into.
//
// refresh_entity_list_rows takes only the workspace and sweeps all three kinds, which is more
// work than this needs but is the one entry point that exists. It is idempotent.
const { error } = await supabase.rpc('refresh_entity_list_rows', { ws: WS });
if (error) console.warn(`list refresh: ${error.message} — run it by hand once the migration is in`);
else console.log('list rows refreshed');

await lock.exit(result.errors.length ? 2 : 0);
