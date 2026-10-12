#!/usr/bin/env node
// Work out which domains a workspace's own people use, and mark those people internal (GET-291).
//
// WHY THIS EXISTS. "Is this person ours?" was answered in four different places, four different
// ways, and in one day that produced four bugs: calls filed on a sibling account, calls filed on
// the seller's own employee, a customer call dropped as "internal", and two customers' calls
// merged because the only attendee they shared was the CS manager who ran both.
//
// `isEntityInternal` is already read across the codebase — team insights, message privacy, who
// counts as a buyer. It was simply wrong, because it only knew about SEATS, and a client whose reps
// have no seats has no internal people at all. Marking them from the domain does not add a new
// check; it makes the check everything already uses tell the truth.
//
// The work itself lives in services/ownDomains.mjs, because the hourly sweep does exactly the same
// thing and the rule for who counts as staff must not exist twice. This script is the way to run it
// deliberately, and to read the evidence before trusting it.
//
// USAGE (worker image, prod env):
//   docker compose run --rm --no-deps -e WS_ID=<uuid> worker \
//     node apps/worker/scripts/resolveOwnDomains.mjs --dry-run
//   … resolveOwnDomains.mjs                          # save domains + mark people
//   … resolveOwnDomains.mjs --confirm example.com    # a person vouching for a domain
//
// Calls no model. Costs nothing but the writes.

import { getSupabaseClient } from '@nous/core';
import { resolveAndMarkOwnPeople } from '../src/services/ownDomains.mjs';

const WS = process.env.WS_ID;
const DRY_RUN = process.argv.includes('--dry-run');
const arg = (name) => { const i = process.argv.indexOf(name); return i === -1 ? null : process.argv[i + 1]; };
const CONFIRM = String(arg('--confirm') || '').toLowerCase().trim() || null;

if (!WS) { console.error('WS_ID is required'); process.exit(1); }

const supabase = getSupabaseClient();
const { candidates, qualifying, people, toMark, marked } =
  await resolveAndMarkOwnPeople(supabase, WS, { dryRun: DRY_RUN, confirm: CONFIRM });

console.log(`[OWN_DOMAINS] workspace ${WS}`);
for (const c of candidates) {
  console.log(`  ${c.domain.padEnd(28)} ${c.sources.join(' + ').padEnd(28)} ${c.evidence.slice(0, 3).join(', ')}`);
}
if (!candidates.length) console.log('  (no corporate domain in the evidence — free mail never counts)');

for (const r of candidates.filter(c => !qualifying.includes(c))) {
  console.log(`[OWN_DOMAINS] not enough evidence for ${r.domain}: only ${r.sources.join(', ')} — needs a second source, or --confirm ${r.domain}`);
}
if (!qualifying.length) { console.log('[OWN_DOMAINS] nothing qualifies. Nothing written.'); process.exit(0); }

console.log(`[OWN_DOMAINS] ours: ${qualifying.map(q => q.domain).join(', ')}`);
console.log(`[OWN_DOMAINS] people on those domains: ${people.size} · already internal: ${people.size - toMark.length} · to mark: ${toMark.length}`);
for (const [, email] of toMark.slice(0, 200)) console.log(`   ${email}`);
if (toMark.length > 200) console.log(`   … and ${toMark.length - 200} more`);

console.log(DRY_RUN ? '[OWN_DOMAINS] dry run — nothing written' : `[OWN_DOMAINS] marked internal: ${marked}`);
process.exit(0);
