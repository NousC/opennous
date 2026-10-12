// The commitments-only mode must not disturb what a full read left behind (GET-422).
//
// Structural, like gmailReadWiring: these are properties of impure code with no DB in the test,
// and each one is a real failure mode — a re-marked thread looks unread to the next resume
// (GET-356's shape), a prefix LIKE times out and reports every thread taskless (GET-396/414).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const strip = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

test('a commitments-only read skips claims and insights, and runs the commitments pass', async () => {
  const src = strip(await readFile(new URL('../src/noema/gmailRead.mjs', import.meta.url), 'utf8'));
  assert.match(src, /commitmentsOnly \? \{ facts: \[\], offered: 0, grounded: 0 \}/, 'claims are skipped');
  assert.match(src, /!dryRun && !commitmentsOnly\)\s*\{\s*insights = await extractCallInsights/s, 'insights are skipped');
  assert.match(src, /treatment === 'live' \|\| commitmentsOnly/, 'the commitments pass runs regardless of treatment');
});

test('a commitments-only read does NOT rewrite the thread read marker', async () => {
  const src = strip(await readFile(new URL('../src/noema/gmailRead.mjs', import.meta.url), 'utf8'));
  assert.match(src, /if \(!dryRun && !commitmentsOnly(?: && markable)?\) \{\s*await markThreadRead/s,
    'overwriting the marker with 0 claims/0 insights would make a read thread look unread');
});

test('the task lookup reads by range, never by prefix LIKE', async () => {
  const src = strip(await readFile(new URL('../scripts/backfillGmailThreads.mjs', import.meta.url), 'utf8'));
  assert.doesNotMatch(src, /\.like\(\s*'property'/, 'a prefix LIKE on property is a seq scan');
  assert.match(src, /\.gte\('property', 'action_item\.'\)[\s\S]{0,80}\.lt\('property', 'action_item\/'\)/);
});

test('commitments-only selects threads that ARE read, not the unread ones', async () => {
  const src = strip(await readFile(new URL('../scripts/backfillGmailThreads.mjs', import.meta.url), 'utf8'));
  assert.match(src, /COMMITMENTS_ONLY \? doneRefs\.has\(threadSourceRef\(u\)\) : !doneRefs\.has\(threadSourceRef\(u\)\)/);
});

test('a thread re-read retires what the previous read left behind (GET-426)', async () => {
  const src = strip(await readFile(new URL('../src/noema/gmailRead.mjs', import.meta.url), 'utf8'));
  // The property is deterministic per (thread, index), so a re-run overwrites index for index —
  // but a read that now yields three where it once yielded five leaves two live forever. Meetings
  // learned this as GET-410; threads had the same hole.
  assert.match(src, /const previousIds = dryRun \? \[\] : await threadTaskIds/);
  assert.match(src, /previousIds\.filter\(r => !written\.has\(r\.property\)\)/);
  assert.match(src, /invalid_at: new Date\(\)\.toISOString\(\)/);
});

test('the previous-task lookup is ranged, and a failure is logged not swallowed', async () => {
  const src = strip(await readFile(new URL('../src/noema/gmailRead.mjs', import.meta.url), 'utf8'));
  const fn = src.slice(src.indexOf('async function threadTaskIds'));
  assert.match(fn.slice(0, 600), /\.gte\('property', lo\)[\s\S]{0,60}\.lt\('property', `\$\{lo\}a`\)/);
  assert.match(fn.slice(0, 600), /console\.warn/);
});

test('--force re-reads every read thread, not only the taskless ones', async () => {
  const src = strip(await readFile(new URL('../scripts/backfillGmailThreads.mjs', import.meta.url), 'utf8'));
  assert.match(src, /if \(!FORCE\) candidates = candidates\.filter\(u => !withTasks\.has/);
});
