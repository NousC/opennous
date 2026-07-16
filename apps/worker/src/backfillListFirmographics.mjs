// One-off backfill: give every company in a lead list the firmographic CLAIMS
// (industry + employee_count) the ICP scorer reads, so leads that came in via the
// company-people fallback (person saved, company never created with firmographics)
// can actually score. Mirrors the legitimate write path — getOrCreateEntity +
// assertClaims — never raw claim inserts. Then rescores the workspace's open
// predictions so the whole list reflects the (corrected) live scorecard.
//
// WHY: AI-Ark / company-people leads only reliably get firmographics when the
// flaky AI-Ark webhook fires. The ones it missed have a company row but no
// scoreable claims, so shape_a_employee_count / shape_a_multi_client_agency can't
// fire and the lead never gets a graph ICP score. This fills that gap.
//
// VALUE SOURCE: real values from the `companies` table where Nous already has
// them; otherwise the SAME band-default the pipeline gave the rest of the list
// (industry='agency', employee_count=10) — a default, not a measured
// headcount. Junk / free-mail domains are skipped, never stamped.
//
// SAFE BY DEFAULT: dry-run. Prints exactly what it WOULD write and spends/changes
// nothing. Pass --live to apply.
//
// Usage (run from apps/worker so @nous/core resolves; pass PROD creds in env):
//   set -a; source /path/to/your/.env; set +a               # SUPABASE_URL + SERVICE_ROLE_KEY
//   node src/backfillListFirmographics.mjs                    # DRY RUN
//   node src/backfillListFirmographics.mjs --live             # APPLY

import { getSupabaseClient, getOrCreateEntity, assertClaims, scoreAndStake, listSignals, rescoreOpenPredictions } from '@nous/core';

const LIVE = process.argv.includes('--live');
const SKIP_RESCORE = process.argv.includes('--no-rescore');
const WS = process.env.WS_ID || '00000000-0000-0000-0000-000000000000';
const LL = process.env.LIST_ID || '00000000-0000-0000-0000-000000000000';
const DEFAULT_INDUSTRY = 'agency';
const DEFAULT_EMPLOYEE_COUNT = 10;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in env. Source the prod .env first.');
  process.exit(1);
}
const supabase = getSupabaseClient();

// Domains we must never stamp as a company: personal mailbox providers and known
// junk/placeholder domains seen in this dataset. Skipped, not defaulted.
const FREEMAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'outlook.com', 'hotmail.com',
  'live.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com',
  'gmx.com', 'gmx.net', 'mail.com', 'zoho.com', 'yandex.com', 'msn.com',
]);
const JUNK = new Set(['myuser.com', 'gateway.xyz', 'example.com', 'test.com']);
function isSkippable(domain) {
  if (!domain || !domain.includes('.')) return 'no-tld';
  if (FREEMAIL.has(domain)) return 'free-mail';
  if (JUNK.has(domain)) return 'junk';
  return null;
}

async function getAll(table, params) {
  // simple pager (1000/page) so we never silently truncate
  const out = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase.from(table).select(params.select)
      .match(params.match || {})
      .range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
    from += 1000;
  }
  return out;
}

async function main() {
  const host = new URL(SUPABASE_URL).host;
  console.log(`\n=== Backfill list firmographics — ${LIVE ? 'LIVE' : 'DRY RUN'} ===`);
  console.log(`DB: ${host}  WS: ${WS}  LIST: ${LL}\n`);

  // 1. list domains (from lead domain or email)
  const leads = await getAll('leads', { select: 'email,domain', match: { lead_list_id: LL } });
  const domains = new Set();
  for (const l of leads) {
    let d = (l.domain || '').toLowerCase().trim();
    if (!d && l.email && l.email.includes('@')) d = l.email.split('@')[1].toLowerCase().trim();
    if (d) domains.add(d);
  }

  // 2. domain -> company entity
  const idRows = await getAll('entity_identifiers', { select: 'entity_id,value', match: { workspace_id: WS, kind: 'domain' } });
  const d2e = new Map(idRows.map(r => [String(r.value).toLowerCase(), r.entity_id]));

  // 3. entities that already carry an employee_count claim (already scoreable)
  const empClaims = await getAll('claims', { select: 'entity_id', match: { workspace_id: WS, property: 'employee_count' } });
  const haveClaim = new Set(empClaims.filter(c => c.entity_id).map(c => c.entity_id));

  // 4. real firmographics already in the companies table, by domain
  const coRows = await getAll('companies', { select: 'domain,industry,employee_count', match: { workspace_id: WS } });
  const tbl = new Map(coRows.filter(c => c.domain).map(c => [String(c.domain).toLowerCase(), c]));

  const signals = await listSignals(supabase, WS, { activeOnly: true });

  const plan = [];      // {domain, entity, hasEntity, industry, employee_count, src}
  const skipped = [];   // {domain, reason}
  let already = 0;

  for (const domain of domains) {
    const eid = d2e.get(domain);
    if (eid && haveClaim.has(eid)) { already++; continue; }   // already scoreable
    const reason = isSkippable(domain);
    if (reason) { skipped.push({ domain, reason }); continue; }
    const t = tbl.get(domain);
    const industry = (t && t.industry) ? t.industry : DEFAULT_INDUSTRY;
    const employee_count = (t && t.employee_count != null) ? t.employee_count : DEFAULT_EMPLOYEE_COUNT;
    const src = (t && (t.industry || t.employee_count != null)) ? 'companies-table' : 'default(agency/10)';
    plan.push({ domain, entity: eid || null, hasEntity: !!eid, industry, employee_count, src });
  }

  console.log(`Domains in list:        ${domains.size}`);
  console.log(`Already scoreable:      ${already}`);
  console.log(`Skipped (junk/free):    ${skipped.length}`);
  console.log(`To backfill:            ${plan.length}  (${plan.filter(p => p.hasEntity).length} have entity, ${plan.filter(p => !p.hasEntity).length} need entity)\n`);

  if (skipped.length) {
    console.log('SKIPPED:');
    for (const s of skipped) console.log(`  - ${s.domain}  (${s.reason})`);
    console.log('');
  }
  console.log('WOULD WRITE (industry / employee_count / source / entity):');
  for (const p of plan) {
    console.log(`  ${p.domain.padEnd(34)} ${String(p.industry).padEnd(9)} ${String(p.employee_count).padEnd(4)} ${p.src.padEnd(20)} ${p.hasEntity ? 'existing' : 'CREATE'}`);
  }

  if (!LIVE) {
    console.log(`\nDRY RUN — nothing written. Re-run with --live to apply (+ rescore ${'~open predictions'}).`);
    return;
  }

  // 5. apply: create/resolve entity, assert firmographic claims, stake the company
  console.log('\nApplying...');
  let written = 0, staked = 0;
  for (const p of plan) {
    try {
      const entityId = await getOrCreateEntity(supabase, WS, 'company', [{ kind: 'domain', value: p.domain }]);
      await assertClaims(supabase, WS, entityId, {
        values: { industry: p.industry, employee_count: p.employee_count },
        source: 'backfill',
      });
      written++;
      const res = await scoreAndStake(supabase, WS, entityId, signals);
      if (res) staked++;
    } catch (e) {
      console.warn(`  ! ${p.domain}: ${e.message}`);
    }
  }
  console.log(`  firmographics asserted on ${written} companies; ${staked} company predictions staked.`);

  // 6. rescore every OPEN prediction under the corrected live scorecard (refreshes
  //    the ~270 stale peers that were scored under the pre-fix model). People at the
  //    newly-backfilled companies are picked up by the scoreEntities cron (they
  //    inherit the company firmographics).
  if (SKIP_RESCORE) {
    console.log('  --no-rescore: leaving the ~271 stale peer predictions untouched.');
  } else {
    const r = await rescoreOpenPredictions(supabase, WS);
    console.log(`  rescoreOpenPredictions: rescored=${r.rescored} restamped=${r.restamped} version=${r.version}`);
  }
  console.log('\nDone.');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
