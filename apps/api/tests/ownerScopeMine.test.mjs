// scope=mine | team: the My book / Team toggle on Home, Pipeline, Accounts and Customers.
//
// The invariant that matters most is the one that did NOT change: a list that is not sent `scope`
// reads exactly what it read before (resolveViewerOwner, fail open). On top of that, `team` is
// everything for anyone, and `mine` is the viewer's own book even for an admin, failing CLOSED
// (empty, flagged unmapped) when we cannot place them, because "mine" showing the team would lie.
//
// Pure apart from a tiny in-memory stand-in for the three Supabase reads ownerScope makes.
// Run: node --test apps/api/tests/ownerScopeMine.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readScope, resolveScopedOwner, resolveOwnOwner, csBookMatcher, ownerFilter } from '../src/lib/ownerScope.mjs';

const WS = 'ws1';

/** Just enough PostgREST for ownerScope: eq / ilike filters, maybeSingle, and a plain await. */
function fakeSupabase(tables) {
  return {
    from(table) {
      const filters = [];
      const missing = !(table in tables);
      const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      const q = {
        select() { return q; },
        eq(col, val) { filters.push((r) => String(r[col]) === String(val)); return q; },
        ilike(col, val) { filters.push((r) => String(r[col] ?? '').toLowerCase() === String(val).toLowerCase()); return q; },
        limit() { return q; },
        maybeSingle() { return Promise.resolve(missing ? { data: null, error: { message: `relation "${table}" does not exist` } } : { data: rows()[0] ?? null, error: null }); },
        then(ok, fail) { return Promise.resolve({ data: rows(), error: null }).then(ok, fail); },
      };
      return q;
    },
  };
}

const world = () => fakeSupabase({
  users: [
    { id: 'u-admin', email: 'founder@acme.test' },
    { id: 'u-ae', email: 'Rhea@Acme.test' },
    { id: 'u-cs', email: 'maya@acme.test' },
  ],
  workspace_crm_owners: [{ workspace_id: WS, user_id: 'u-mapped', owner_name: 'Chris Black', owner_email: 'chris@acme.test' }],
  // The AE owner on account rows: how a member is placed by email.
  entity_list_rows: [{ workspace_id: WS, kind: 'account', owner_name: 'Rhea Moss', owner_email: 'rhea@acme.test' }],
});
const admin = (id = 'u-admin') => ({ viewerScope: 'admin', internalUserId: id });
const member = (id) => ({ viewerScope: 'member', internalUserId: id });

test('scope is mine or team; anything else is "not asked"', () => {
  assert.equal(readScope('mine'), 'mine');
  assert.equal(readScope('team'), 'team');
  for (const v of [undefined, null, '', 'all', 'MINE', ['mine']]) assert.equal(readScope(v), null);
});

test('no scope is today\'s rule: an admin reads everything, a placed member their own book', async () => {
  const sb = world();
  assert.deepEqual(await resolveScopedOwner(sb, WS, admin(), undefined), { scope: null, owner: null, unmapped: false });
  const m = await resolveScopedOwner(sb, WS, member('u-ae'), undefined);
  assert.deepEqual(m.owner, { names: ['Rhea Moss'], emails: ['rhea@acme.test'] });
  assert.equal(m.unmapped, false);
  // An unplaced member still fails OPEN without a scope: null owner, never an empty book.
  assert.deepEqual(await resolveScopedOwner(sb, WS, member('u-cs'), 'bogus'), { scope: null, owner: null, unmapped: false });
});

test('team is the whole workspace, even for a member whose book we know', async () => {
  assert.deepEqual(await resolveScopedOwner(world(), WS, member('u-ae'), 'team'), { scope: 'team', owner: null, unmapped: false });
});

test('mine is the viewer\'s own book even for an admin, from the hand mapping first', async () => {
  const r = await resolveScopedOwner(world(), WS, admin('u-mapped'), 'mine');
  assert.equal(r.unmapped, false);
  assert.deepEqual(r.owner, { names: ['Chris Black'], emails: ['chris@acme.test'] });
});

test('mine places an admin by their email against an owner email on the accounts, case-blind', async () => {
  const r = await resolveScopedOwner(world(), WS, admin('u-ae'), 'mine');
  assert.equal(r.unmapped, false);
  assert.deepEqual(r.owner, { names: ['Rhea Moss'], emails: ['rhea@acme.test'] });
});

test('mine fails CLOSED: an admin who is nobody\'s owner gets no owner and unmapped, never the team', async () => {
  assert.deepEqual(await resolveScopedOwner(world(), WS, admin(), 'mine'), { scope: 'mine', owner: null, unmapped: true });
  // No signed-in user at all.
  assert.deepEqual(await resolveScopedOwner(world(), WS, {}, 'mine'), { scope: 'mine', owner: null, unmapped: true });
  // And the owner filter a caller would build from it is no filter, which is why the caller must
  // answer an empty book itself rather than pass null down.
  assert.equal(ownerFilter(null), null);
});

test('a missing mapping table is unplaced, not an error', async () => {
  const sb = fakeSupabase({ users: [{ id: 'u1', email: 'x@y.test' }], entity_list_rows: [] });
  assert.deepEqual(await resolveScopedOwner(sb, WS, admin('u1'), 'mine'), { scope: 'mine', owner: null, unmapped: true });
});

test('for the CS book, the sign-in email rides along: a CS rep who is nobody\'s AE is still findable', async () => {
  const cs = await resolveScopedOwner(world(), WS, member('u-cs'), 'mine', { withLoginEmail: true });
  assert.equal(cs.unmapped, true);                     // no real join matched...
  assert.deepEqual(cs.owner.emails, ['maya@acme.test']); // ...but their inbox is the CS owner email
  const ae = await resolveOwnOwner(world(), WS, member('u-ae'), { withLoginEmail: true });
  assert.equal(ae.placed, true);
  assert.deepEqual(ae.emails, ['rhea@acme.test']);     // deduped, lower-cased
});

// ── csBookMatcher ───────────────────────────────────────────────────────────────────────────

const row = (cs, ae = {}) => ({ health: cs, ownerName: ae.name ?? null, ownerEmail: ae.email ?? null });
const maya = { names: ['Maya Chen'], emails: ['maya@acme.test'] };

test('default mode is the CS page\'s existing rule, unchanged', () => {
  const owned = csBookMatcher(maya, { csOwned: true });
  assert.equal(owned(row({ owner_name: 'Maya Chen' })), true);
  assert.equal(owned(row({ owner_email: 'MAYA@acme.test' })), true);
  assert.equal(owned(row({ owner_name: 'Leo Park' }, { name: 'Maya Chen' })), false); // CS owner wins over the AE
  assert.equal(owned(row({}, { name: 'Maya Chen' })), true);   // CS owners exist: the AE is ignored, row unowned, kept
  assert.equal(owned(row({})), true);                           // unowned stays visible: fail open
  // A workspace that records no CS owner anywhere falls back to the AE.
  const noCs = csBookMatcher(maya, { csOwned: false });
  assert.equal(noCs(row({}, { name: 'Maya Chen' })), true);
  assert.equal(noCs(row({}, { name: 'Rhea Moss' })), false);
});

test('strict (mine) reads the CS owner only, never the AE, and an unowned row is not mine', () => {
  const mine = csBookMatcher(maya, { csOwned: false, strict: true });
  assert.equal(mine(row({ owner_name: 'Maya Chen' })), true);
  assert.equal(mine(row({ owner_email: 'maya@acme.test' }, { name: 'Rhea Moss' })), true);
  assert.equal(mine(row({}, { name: 'Maya Chen', email: 'maya@acme.test' })), false); // the AE is a different seat
  assert.equal(mine(row({})), false);
  assert.equal(mine(row({ owner_name: 'Leo Park' })), false);
  // An empty identity matches nothing.
  assert.equal(csBookMatcher({ names: [], emails: [] }, { strict: true })(row({ owner_name: 'Maya Chen' })), false);
});
