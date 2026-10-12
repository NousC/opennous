// The list-row property set exists in two languages: as LIST_ROW_PROPERTIES in
// settleClaimQueue.ts, which decides when a settled claim rebuilds a row, and as the `props`
// array inside refresh_list_chunk, which decides what a row is built FROM.
//
// If they drift, the failure is silent and shaped exactly like the bugs this codebase keeps
// hitting: a property the projection reads but the engine does not watch means the list shows a
// stale value until the crawler wanders past, which on a real client is a day. The reverse means
// rebuilding rows for a claim that changes nothing on them.
//
// So this reads the SQL and compares. "Two places, one rule" — if you must have two, make one of
// them fail loudly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isListRowProperty } from '../dist/services/settleClaimQueue.js';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'supabase', 'migrations');

/** The `props` array from the most recent migration that defines refresh_list_chunk. */
function propsFromLatestMigration() {
  const files = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort();
  let found = null;
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), 'utf8');
    if (!/function\s+public\.refresh_list_chunk|function\s+refresh_list_chunk/i.test(sql)) continue;
    const m = sql.match(/props\s+text\[\]\s*:=\s*array\[([\s\S]*?)\]/i);
    if (m) found = { file: f, props: [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]) };
  }
  return found;
}

test('every property the projection reads also triggers a rebuild', () => {
  const latest = propsFromLatestMigration();
  assert.ok(latest, 'no migration defining refresh_list_chunk with a props array was found');
  assert.ok(latest.props.length > 5, `parsed too few props from ${latest.file}`);

  const missing = latest.props.filter(p => !isListRowProperty(p));
  assert.deepEqual(
    missing, [],
    `${latest.file} builds list rows from ${missing.join(', ')}, but a settled claim on ` +
    `${missing.length === 1 ? 'it' : 'them'} would not rebuild the row. Add ${missing.join(', ')} ` +
    'to LIST_ROW_PROPERTIES in settleClaimQueue.ts.',
  );
});

test('no property triggers a rebuild the projection never reads', () => {
  const latest = propsFromLatestMigration();
  const sqlProps = new Set(latest.props);
  // Probe the exported predicate with the SQL set plus obvious non-members.
  const spurious = [...sqlProps].length
    ? ['name', 'first_name', 'last_name', 'job_title', 'industry', 'icp_score',
       'deal_health_score', 'pipeline_stage', 'status', 'value', 'stage',
       'close_date', 'owner_name', 'pipeline_id', 'is_internal', 'location',
      ].filter(p => isListRowProperty(p) && !sqlProps.has(p))
    : [];
  assert.deepEqual(
    spurious, [],
    `LIST_ROW_PROPERTIES contains ${spurious.join(', ')}, which refresh_list_chunk does not read — ` +
    'rebuilding a row for those is work nobody can see.',
  );
});

test('a claim the list never shows does not trigger a rebuild', () => {
  for (const p of ['what_they_do', 'funding_stage', 'note.summary', 'signal.hiring', 'employee_count']) {
    assert.equal(isListRowProperty(p), false, `${p} should not rebuild a list row`);
  }
});

// The account-health family is read by PREFIX rather than from the props array — `cl.property
// like 'cs.%'` inside the account branch — so the parser above cannot see it. Same rule, same
// drift risk, asserted the same way: if the projection stops reading the prefix, or the engine
// stops watching it, one of these fails.
test('the account-health prefix is read by the projection and watched by the engine', () => {
  const latest = propsFromLatestMigration();
  const sql = readFileSync(join(MIGRATIONS, latest.file), 'utf8');
  assert.match(
    sql, /cl\.property\s+like\s+'cs\.%'/i,
    `${latest.file} defines refresh_list_chunk but never reads the cs.* health family. Either the ` +
    'projection lost it, or this migration predates it and the test is reading the wrong file.',
  );
  for (const p of ['cs.status', 'cs.mrr', 'cs.active_users_30d', 'cs.upgrade_value']) {
    assert.equal(isListRowProperty(p), true, `${p} must rebuild the account row it lands on`);
  }
});
