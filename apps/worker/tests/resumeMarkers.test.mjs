// "Has this transcript already been read?" — and why one marker is never enough.
//
// GET-359 gave claims a `source_ref` so a resumed backfill could answer that question. It did not
// reach every writer: `extractActivitySignals` — which handles 1:1 calls, threads and messages,
// and which the meeting path FALLS BACK TO for any single-participant call — never accepted the
// parameter, so everything it wrote was born with a null ref. In prod that was most of the
// meeting claims: fully extracted meetings, invisible to the resume check.
//
// Measured cost: a run selected a batch of "remaining" meetings, most of which had already been
// read, and filed over a hundred duplicate claims onto live accounts before it was stopped and they were
// retired. Same shape as GET-356 (a notes blob counted as extraction) and GET-361 (claims without
// a ref could not be seen) — a resume marker that one writer forgets is worse than none, because
// it reports confidently.
//
// Run: node --test apps/worker/tests/resumeMarkers.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SIGNALS = readFileSync(join(here, '..', 'src', 'signals', 'index.mjs'), 'utf8');
const BACKFILL = readFileSync(join(here, '..', 'scripts', 'fellowBackfill.mjs'), 'utf8');

test('extractActivitySignals accepts a sourceRef', () => {
  const sig = SIGNALS.match(/export async function extractActivitySignals\(\{[^}]*\}/s);
  assert.ok(sig, 'could not find extractActivitySignals');
  assert.match(sig[0], /sourceRef/,
    'the activity path must accept a sourceRef, or every claim it writes is unattributable');
});

test('every persistFacts call passes a sourceRef', () => {
  // Three writers reach persistFacts. A ref that stops at one of them is the bug this file exists
  // for, and the next one to be added will be copied from whichever call site is nearest.
  const calls = [...SIGNALS.matchAll(/persistFacts\(supabase, workspaceId, \w+, \{([^}]*)\}/g)];
  assert.ok(calls.length >= 2, `expected at least 2 persistFacts calls, found ${calls.length}`);
  for (const c of calls) {
    assert.match(c[1], /sourceRef/, `a persistFacts call omits sourceRef: { ${c[1].trim()} }`);
  }
});

test('the 1:1 fallback forwards the ref the meeting path already holds', () => {
  // A single-participant meeting is routed to the activity prompt on purpose. It arrives holding a
  // perfectly good sourceRef, and used to drop it on the floor — so a 1:1 call was indistinguishable
  // from one nobody had ever read.
  const fallback = SIGNALS.match(/if \(participants\.length === 1\)[\s\S]{0,600}?\}\);/);
  assert.ok(fallback, 'could not find the 1:1 fallback');
  assert.match(fallback[0], /sourceRef/, 'the 1:1 fallback must forward sourceRef');
});

test('the backfill resume check uses TWO independent markers', () => {
  assert.match(BACKFILL, /extractedNoteIdsByObservation/,
    'the observation-link marker must exist');
  // Unioned, not intersected: either proof is sufficient. Requiring both would re-introduce the
  // blind spot from the other side, since hundreds of claims carry no supporting observation.
  const union = BACKFILL.match(/alreadyExtracted = [\s\S]{0,400}?\]\);/);
  assert.ok(union, 'could not find the alreadyExtracted assembly');
  assert.match(union[0], /extractedNoteIds\(/, 'must still consult source_ref');
  assert.match(union[0], /extractedNoteIdsByObservation\(/, 'must also consult the observation link');
  assert.match(union[0], /new Set\(\[/, 'the two markers must be UNIONED, not intersected');
});

test('the observation marker pages, because a response silently caps at 1000', () => {
  const fn = BACKFILL.match(/async function extractedNoteIdsByObservation[\s\S]*?\n\}/);
  assert.ok(fn, 'could not find extractedNoteIdsByObservation');
  assert.match(fn[0], /\.range\(from, from \+ PAGE - 1\)/,
    'both queries must page — an unpaged read of a few thousand claims returns 1,000 and lies');
  const ranges = [...fn[0].matchAll(/\.range\(/g)];
  assert.equal(ranges.length, 2, `expected both queries to page, found ${ranges.length}`);
});

test('a failed marker read never silently marks work done', () => {
  // The posture the file already takes elsewhere: paying twice is visible on the bill, skipping a
  // year of transcripts is not. An exception must return an EMPTY set, never a partial one.
  const fn = BACKFILL.match(/async function extractedNoteIdsByObservation[\s\S]*?\n\}/);
  assert.match(fn[0], /catch[\s\S]*?return new Set\(\)/,
    'on failure it must return an empty set, so nothing is treated as already done');
});
