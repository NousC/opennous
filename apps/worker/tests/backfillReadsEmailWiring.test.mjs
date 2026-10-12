// The backfill reads the email it filed (GET-557).
//
// It did not: the enricher filed 90 days of a mailbox and the job marked itself done. Reading a
// thread into facts — the model work the backfill credits pay for — only ran in the twice-daily
// reader, over the last three days. Structural, like gmailReadWiring: the failure was a call that
// was never made.
//
// Run: node --test apps/worker/tests/backfillReadsEmailWiring.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const JOBS = readFileSync(new URL('../src/workers/contactEnrichmentJobs.mjs', import.meta.url), 'utf8');
const DAILY = readFileSync(new URL('../src/workers/emailThreadsDaily.mjs', import.meta.url), 'utf8');

test('the job reads the filed email before it says done', () => {
  const read = JOBS.indexOf('await readBackfilledEmail(supabase, job);');
  const done = JOBS.indexOf("status: 'done', done: true", read);
  assert.ok(read >= 0, 'readBackfilledEmail is called');
  assert.ok(done > read, 'and the job is marked done after it');
});

test('the read covers the job window, capped at the allowance, under the reader lock', () => {
  const fn = JOBS.slice(JOBS.indexOf('async function readBackfilledEmail'), JOBS.indexOf('async function pauseForCredits'));
  assert.match(fn, /job\.window_days/);
  // What is left of the backfill's own allowance (GET-699), not the month's.
  assert.match(fn, /backfillCreditState\(supabase, job\)/);
  assert.match(fn, /remaining \/ CREDIT_SCALE/);
  assert.match(fn, /countsAgainstMonth:/);
  assert.match(fn, /withBackfillLock\(supabase, job\.workspace_id, 'emailThreads'/);
  assert.match(fn, /onProgress:/);
});

test('the reader reports progress for every thread it handles, skipped ones included', () => {
  assert.match(DAILY, /onProgress = null/);
  const skips = DAILY.match(/done\+\+/g) ?? [];
  assert.ok(skips.length >= 2, 'counted on a read and on a skip');
});
