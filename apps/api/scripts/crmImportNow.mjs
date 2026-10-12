#!/usr/bin/env node
// Run a workspace's CRM import — the SAME path the Connect button runs (importFromCrm), against
// the connection that is already saved. Nothing here is special-cased for a client.
//
// Why it exists: connect fires the import inside the API process, which is right for a normal
// portal and wrong for a large one. An import of several thousand accounts takes hours, and any deploy restarts
// the API and kills it mid-flight. Run here, it lives in its own container and survives deploys.
//
// It is also the retry: the import dedups on external ids, so running it again fills in whatever
// an interrupted run did not reach.
//
// USAGE (worker image, prod env):
//   WS_ID=<uuid> node apps/api/scripts/crmImportNow.mjs            # what it would import
//   WS_ID=<uuid> node apps/api/scripts/crmImportNow.mjs --apply    # run it
//   WS_ID=<uuid> ONLY=subscriptions node apps/api/scripts/crmImportNow.mjs --apply   # one pass
//   WS_ID=<uuid> ONLY=emails SINCE=2026-04-01 UNTIL=2026-07-01 node … --apply          # one slice

import { readFile } from 'node:fs/promises';
import { getSupabaseClient } from '@nous/core';
import { importFromCrm, crmState } from '../src/lib/connectIngest.mjs';

const WS = process.env.WS_ID;
const APPLY = process.argv.includes('--apply');
if (!WS) { console.error('WS_ID is required'); process.exit(1); }

const supabase = getSupabaseClient();
const crm = await crmState(supabase, WS);
if (!crm) {
  console.error(`No CRM is connected on workspace ${WS}. Connect it first (Integrations, or POST /v2/workspace/integrations).`);
  process.exit(1);
}
console.log(JSON.stringify({ workspace: WS, provider: crm.provider, connection: crm.connectionId, already_imported: crm.imported,
  only: process.env.ONLY || 'everything', since: process.env.SINCE || 'default 12 months', until: process.env.UNTIL || 'now' }, null, 2));
if (!APPLY) { console.log('Plan only. Re-run with --apply to import.'); process.exit(0); }

const started = Date.now();
// ONLY=subscriptions,line_items finishes one pass without re-walking a portal that took hours.
const only = String(process.env.ONLY ?? '').split(',').map(x => x.trim()).filter(Boolean);
// SINCE / UNTIL slice the conversation window, so several runs share one portal's year without
// overlapping: ONLY=emails SINCE=2026-04-01 UNTIL=2026-07-01 is one quarter of the email (GET-289).
const since = process.env.SINCE ? new Date(process.env.SINCE).toISOString() : null;
const until = process.env.UNTIL ? new Date(process.env.UNTIL).toISOString() : null;
// SCOPE_FILE is a JSON array of HubSpot company ids, resolved ONCE and shared by every run that
// splits the work. Without it each run pays dozens of searches against a per-second limit, which is how
// three runs starting together produced sixty rate-limit refusals in sixteen pages (GET-291).
const companyIds = process.env.SCOPE_FILE
  ? JSON.parse(await readFile(process.env.SCOPE_FILE, 'utf8'))
  : null;
const out = await importFromCrm(supabase, WS, crm.provider, crm.connectionId, { only, since, until, companyIds });
const { result, ...rest } = out ?? {};
console.log(JSON.stringify({
  minutes: Math.round((Date.now() - started) / 60000),
  ...rest,
  ...(result ? { contacts: result.contacts, companies: result.companies, deals: result.deals, engagements: result.engagements, commerce: result.commerce, callIntelligence: result.callIntelligence, errors: result.errors, warnings: result.warnings, truncated: result.truncated } : {}),
}, null, 2));
process.exit(out?.error ? 2 : 0);
