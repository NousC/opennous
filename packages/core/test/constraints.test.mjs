// Constraints. The tests that matter are the ones about binding — a constraint applied to the
// wrong person, or not applied when it should be, are the two ways this feature damages trust
// rather than building it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addConstraint, listConstraints, applies as constraintApplies, renderConstraints } from '../dist/db/constraints.mjs';

const db = (rows = []) => {
  const writes = [];
  return {
    writes,
    from() {
      const c = {};
      for (const m of ['select', 'eq', 'is', 'order', 'update']) c[m] = () => c;
      c.upsert = (row) => { writes.push(row); c._row = row; return c; };
      c.single = () => Promise.resolve({ data: c._row });
      c.maybeSingle = () => Promise.resolve({ data: c._row ?? null });
      c.then = (res) => res({ data: rows, error: null });
      return c;
    },
  };
};

test('a person-scoped constraint without an owner is refused, not silently made global', async () => {
  // The one direction this must never fail in. A person constraint with no user_id would bind
  // everyone in the workspace — one rep's preference quietly becoming company policy.
  await assert.rejects(
    () => addConstraint(db(), 'ws-1', { statement: 'never send breakup emails', scope: 'person' }),
    /user_id_required_for_person_scope/,
  );
});

test('an empty statement is refused', async () => {
  await assert.rejects(() => addConstraint(db(), 'ws-1', { scope: 'workspace', statement: '  ' }), /statement_required/);
});

test('a workspace constraint needs no owner and stores none', async () => {
  const d = db();
  await addConstraint(d, 'ws-1', { statement: 'we do not name competitors', scope: 'workspace', user_id: 'u-1' });
  assert.equal(d.writes[0].scope, 'workspace');
  assert.equal(d.writes[0].user_id, null, 'a workspace rule must not carry a personal owner');
});

test('inferred is recorded as inferred, so it can be presented as the weaker claim it is', async () => {
  const d = db();
  await addConstraint(d, 'ws-1', {
    statement: 'never send breakup emails', scope: 'person', user_id: 'u-1',
    source: 'inferred', evidence_ids: ['d1', 'd2', 'd3'],
  });
  assert.equal(d.writes[0].source, 'inferred');
  assert.deepEqual(d.writes[0].evidence_ids, ['d1', 'd2', 'd3']);
});

test('an unnarrowed constraint binds every action', () => {
  // "I don't do breakup emails" was said about outreach generally. Refusing to apply it
  // because the caller passed no action_type would defeat the point.
  const c = { statement: 'no breakup emails' };
  assert.equal(constraintApplies(c, { actionType: 'email_send' }), true);
  assert.equal(constraintApplies(c, { actionType: 'linkedin_message' }), true);
  assert.equal(constraintApplies(c, {}), true);
});

test('a narrowed constraint does not leak across channels', () => {
  const c = { statement: 'no cold email', action_type: 'email_send' };
  assert.equal(constraintApplies(c, { actionType: 'email_send' }), true);
  assert.equal(constraintApplies(c, { actionType: 'linkedin_message' }), false);
});

test("one person's constraint does not bind their colleague", async () => {
  const rows = [
    { id: 'a', scope: 'person', user_id: 'u-1', statement: 'no breakup emails' },
    { id: 'b', scope: 'workspace', user_id: null, statement: 'we do not name competitors' },
  ];
  const mine = await listConstraints(db(rows), 'ws-1', { userId: 'u-1' });
  assert.equal(mine.length, 2, 'own + workspace');
  const theirs = await listConstraints(db(rows), 'ws-1', { userId: 'u-2' });
  assert.deepEqual(theirs.map((c) => c.id), ['b'], 'only the workspace rule binds a colleague');
});

test('constraints render as absolute, and an inferred one says so', () => {
  const text = renderConstraints([
    { statement: 'never send breakup emails', source: 'explicit' },
    { statement: 'never ask for a call on a first touch', source: 'inferred' },
  ]);
  assert.match(text, /THINGS THIS OPERATOR DOES NOT DO/);
  // A constraint must not read like a learned rule, or the stronger gets averaged into the weaker.
  assert.match(text, /not preferences to weigh/);
  assert.match(text, /inferred from repeated refusals/);
});

test('no constraints renders empty, so callers can concatenate blindly', () => {
  assert.equal(renderConstraints([]), '');
  assert.equal(renderConstraints(null), '');
});
