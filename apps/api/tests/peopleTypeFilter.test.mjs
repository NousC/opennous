// The People filter (GET-1018): GET /api/contacts?type= narrows the flattened list to one row tag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { peopleTypeRefine } from '../src/routes/api/contacts.mjs';

// A client whose reads answer from `tables`, narrowed by eq; records the filters a refine applies.
function fakeDb(tables) {
  return {
    from(table) {
      const preds = [];
      const q = {
        select: () => q, is: () => q, limit: () => q, in: () => q,
        eq: (k, v) => { preds.push(r => r[k] === v); return q; },
        then: (resolve) => resolve({ data: (tables[table] ?? []).filter(r => preds.every(f => f(r))), error: null }),
      };
      return q;
    },
  };
}
const recorder = () => { const calls = []; const q = new Proxy({}, { get: (_t, m) => (...a) => { calls.push([m, ...a]); return q; } }); return { q, calls }; };

test('network: the people marked personal', async () => {
  const sb = fakeDb({ claims: [{ workspace_id: 'ws', entity_id: 'p1', property: 'is_personal', value: true }], entity_list_rows: [] });
  const refine = await peopleTypeRefine(sb, 'ws', 'network');
  const { q, calls } = recorder();
  refine(q);
  assert.deepEqual(calls, [['in', 'entity_id', ['p1']]]);
});

test('client: a won stage, legacy names included', async () => {
  const { q, calls } = recorder();
  (await peopleTypeRefine(fakeDb({}), 'ws', 'client'))(q);
  assert.equal(calls[0][0], 'in');
  assert.ok(calls[0][2].includes('closed_won') && calls[0][2].includes('client'));
});

test('user: a user or trial stage outside the funnel, or a PostHog user', async () => {
  const sb = fakeDb({ claims: [{ workspace_id: 'ws', entity_id: 'p9', property: 'product.user', value: true }] });
  const { q, calls } = recorder();
  (await peopleTypeRefine(sb, 'ws', 'user'))(q);
  assert.equal(calls[0][0], 'or');
  assert.match(calls[0][1], /stage\.ilike\.\*user\*/);
  assert.match(calls[0][1], /entity_id\.in\.\(p9\)/);
});

test('no type, or one we do not know: everyone', async () => {
  assert.equal(await peopleTypeRefine(fakeDb({}), 'ws', ''), null);
  assert.equal(await peopleTypeRefine(fakeDb({}), 'ws', 'nonsense'), null);
});
