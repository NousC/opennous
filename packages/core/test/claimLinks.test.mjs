// Cause links between claims (GET-1053): what is written (both ends real claims of the workspace,
// never a self-link, archived when an end is already retired), what is read (live links touching
// the ids, in chunks), the fail-safe without the migration, and the migration's retire trigger.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/claimLinks.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cleanClaimLinks, isMissingClaimLinks, saveClaimLinks, listClaimLinks, CLAIM_LINK_KINDS } from '../dist/db/claimLinks.js';

const WS = '00000000-0000-4000-8000-000000000001';
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [A, B, C, D] = [id(10), id(11), id(12), id(13)];

/** A tiny PostgREST stand-in: claims to read, claim_links to upsert into and read back. */
function sb({ claims = [], links = [], error = null, calls = [] } = {}) {
  const tables = { claims: claims.map(r => ({ ...r })), claim_links: links.map(r => ({ ...r })) };
  const from = (t) => {
    const f = [];
    let op = 'select', payload = null, opts = null;
    const q = {
      select() { return q; }, limit() { return q; },
      eq(k, v) { f.push(r => r[k] === v); return q; },
      is(k, v) { f.push(r => (r[k] ?? null) === v); return q; },
      in(k, vs) { f.push(r => vs.includes(r[k])); return q; },
      or(expr) { calls.push({ t, or: expr }); return q; },
      upsert(v, o) { op = 'upsert'; payload = v; opts = o; return q; },
      then(res, rej) {
        if (error && t === 'claim_links') return Promise.resolve({ data: null, error }).then(res, rej);
        const rows = tables[t];
        if (op === 'upsert') {
          const keys = opts.onConflict.split(',');
          for (const r of payload) {
            const hit = rows.find(x => keys.every(k => x[k] === r[k]));
            if (hit) Object.assign(hit, r); else rows.push({ id: `l${rows.length + 1}`, ...r });
          }
          calls.push({ t, upsert: payload, opts });
          return Promise.resolve({ data: null, error: null }).then(res, rej);
        }
        return Promise.resolve({ data: rows.filter(r => f.every(fn => fn(r))), error: null }).then(res, rej);
      },
    };
    return q;
  };
  return { tables, from };
}

test('cleanClaimLinks: real ids, no self-link, a known kind, each link once', () => {
  assert.deepEqual(CLAIM_LINK_KINDS, ['caused_by']);
  assert.deepEqual(cleanClaimLinks([
    { fromClaimId: A, toClaimId: B },
    { fromClaimId: A, toClaimId: B, kind: 'caused_by' },   // duplicate
    { fromClaimId: A, toClaimId: A },                      // itself
    { fromClaimId: 'row-1', toClaimId: B },                // not an id
    { fromClaimId: A, toClaimId: C, kind: 'enables' },     // not a kind we write
    null,
  ]), [{ fromClaimId: A, toClaimId: B, kind: 'caused_by' }]);
  assert.deepEqual(cleanClaimLinks(undefined), []);
});

test('isMissingClaimLinks: 42P01, PGRST205, or the schema-cache message', () => {
  assert.equal(isMissingClaimLinks({ code: '42P01' }), true);
  assert.equal(isMissingClaimLinks({ code: 'PGRST205' }), true);
  assert.equal(isMissingClaimLinks({ message: "Could not find the table 'public.claim_links' in the schema cache" }), true);
  assert.equal(isMissingClaimLinks({ code: '23505', message: 'duplicate key' }), false);
  assert.equal(isMissingClaimLinks(null), false);
});

test('saveClaimLinks: both ends must be claims of the workspace; a retired end writes the link archived', async () => {
  const calls = [];
  const db = sb({ calls, claims: [
    { id: A, workspace_id: WS, invalid_at: null },
    { id: B, workspace_id: WS, invalid_at: null },
    { id: C, workspace_id: WS, invalid_at: '2026-10-20T00:00:00Z' },
    { id: D, workspace_id: 'another-workspace', invalid_at: null },
  ] });
  const out = await saveClaimLinks(db, WS, [
    { fromClaimId: A, toClaimId: B },
    { fromClaimId: A, toClaimId: C },     // retired cause → archived
    { fromClaimId: A, toClaimId: D },     // another workspace's claim → not written
  ]);
  assert.deepEqual(out, { written: 2, missing: false });
  const rows = db.tables.claim_links;
  assert.equal(rows.length, 2);
  assert.equal(rows.find(r => r.to_claim_id === B).archived_at, null);
  assert.ok(rows.find(r => r.to_claim_id === C).archived_at);
  assert.equal(calls.find(c => c.upsert).opts.onConflict, 'workspace_id,from_claim_id,to_claim_id,kind');
  // Written again: one row, archived_at follows the ends' current state.
  db.tables.claims.find(r => r.id === B).invalid_at = '2026-10-24T00:00:00Z';
  await saveClaimLinks(db, WS, [{ fromClaimId: A, toClaimId: B }]);
  assert.equal(db.tables.claim_links.length, 2);
  assert.ok(db.tables.claim_links.find(r => r.to_claim_id === B).archived_at);
});

test('saveClaimLinks / listClaimLinks without the migration: nothing, no throw', async () => {
  const db = sb({ claims: [{ id: A, workspace_id: WS, invalid_at: null }, { id: B, workspace_id: WS, invalid_at: null }], error: { code: 'PGRST205', message: 'missing' } });
  assert.deepEqual(await saveClaimLinks(db, WS, [{ fromClaimId: A, toClaimId: B }]), { written: 0, missing: true });
  assert.deepEqual(await listClaimLinks(db, WS, [A]), []);
  const throwing = { from: () => { throw Object.assign(new Error('relation "claim_links" does not exist'), { code: '42P01' }); } };
  assert.deepEqual(await saveClaimLinks(throwing, WS, [{ fromClaimId: A, toClaimId: B }]), { written: 0, missing: true });
  assert.deepEqual(await listClaimLinks(throwing, WS, [A]), []);
  assert.deepEqual(await saveClaimLinks(db, WS, []), { written: 0, missing: false }, 'nothing to write, no query');
});

test('listClaimLinks: live links touching the ids, either end, read in chunks', async () => {
  const calls = [];
  const many = Array.from({ length: 120 }, (_, i) => id(1000 + i));
  const db = sb({ calls, links: [
    { id: 'l1', workspace_id: WS, from_claim_id: A, to_claim_id: B, kind: 'caused_by', archived_at: null },
    { id: 'l2', workspace_id: WS, from_claim_id: C, to_claim_id: A, kind: 'caused_by', archived_at: null },
    { id: 'l3', workspace_id: WS, from_claim_id: A, to_claim_id: D, kind: 'caused_by', archived_at: '2026-10-24T00:00:00Z' },
    { id: 'l4', workspace_id: WS, from_claim_id: C, to_claim_id: D, kind: 'caused_by', archived_at: null },
  ] });
  const got = await listClaimLinks(db, WS, [A, ...many, 'not-an-id']);
  assert.deepEqual(got.map(l => l.id).sort(), ['l1', 'l2'], 'archived and unrelated links are left out');
  assert.equal(calls.filter(c => c.or).length, 3, '121 ids in chunks of 50');
  assert.match(calls[0].or, /^from_claim_id\.in\.\(.+\),to_claim_id\.in\.\(.+\)$/);
  assert.deepEqual(await listClaimLinks(db, WS, []), []);
});

test('the migration: idempotent table, RLS on, and the trigger that archives and restores links with their claims', () => {
  const sql = readFileSync(fileURLToPath(new URL('../../../supabase/migrations/2026_10_27_claim_links.sql', import.meta.url)), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.claim_links/);
  assert.match(sql, /kind text NOT NULL CHECK \(kind IN \('caused_by'\)\)/);
  assert.match(sql, /UNIQUE \(workspace_id, from_claim_id, to_claim_id, kind\)/);
  assert.match(sql, /archived_at timestamptz,/);
  assert.match(sql, /ALTER TABLE public\.claim_links ENABLE ROW LEVEL SECURITY/);
  assert.doesNotMatch(sql, /CREATE POLICY/, 'service role only');
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.claim_links_follow_claim\(\)/);
  assert.match(sql, /DROP TRIGGER IF EXISTS claim_links_follow_claim ON public\.claims/);
  assert.match(sql, /AFTER UPDATE OF invalid_at ON public\.claims/);
  // Retired: archive every live link touching it. Back: restore only where the other end is live.
  assert.match(sql, /OLD\.invalid_at IS NULL AND NEW\.invalid_at IS NOT NULL THEN\s+UPDATE public\.claim_links SET archived_at = now\(\)/);
  assert.match(sql, /OLD\.invalid_at IS NOT NULL AND NEW\.invalid_at IS NULL THEN\s+UPDATE public\.claim_links l SET archived_at = NULL/);
  assert.match(sql, /c\.invalid_at IS NULL\);/);
  const baseline = readFileSync(fileURLToPath(new URL('../../../supabase/schema.sql', import.meta.url)), 'utf8');
  assert.match(baseline, /CREATE TABLE public\.claim_links/);
  assert.match(baseline, /CREATE TRIGGER claim_links_follow_claim AFTER UPDATE OF invalid_at ON public\.claims/);
  assert.match(readFileSync(fileURLToPath(new URL('../../../supabase/schema-baseline-migrations.txt', import.meta.url)), 'utf8'), /^2026_10_27_claim_links\.sql$/m);
});
