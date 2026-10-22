import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWhoami } from '../src/lib/whoami.mjs';

// A chainable stand-in for supabase-js: every query resolves from the table it started on and
// the filters it was given, so the test can tell a company count from a people count.
function fakeSupabase({ companies = 0, contacts = 0, icp = false } = {}) {
  return {
    from(table) {
      const filters = {};
      const q = {
        select() { return q; },
        eq(k, v) { filters[k] = v; return q; },
        maybeSingle() {
          if (table === 'workspaces') return Promise.resolve({ data: { id: 'ws', name: 'Acme', team_id: null, onboarding_activated_at: null } });
          if (table === 'foundations') return Promise.resolve({ data: icp ? { kind: 'icp' } : null });
          return Promise.resolve({ data: null });
        },
        then(res, rej) {
          let count = 0;
          if (table === 'entities' && filters.type === 'company' && filters.status === 'active') count = companies;
          if (table === 'contacts') count = contacts;
          return Promise.resolve({ count }).then(res, rej);
        },
      };
      return q;
    },
  };
}

test('whoami reports accounts as companies, people separately (GET-1011)', async () => {
  const r = await resolveWhoami(fakeSupabase({ companies: 12, contacts: 1340 }), { workspaceId: 'ws' });
  assert.equal(r.setup.accounts, 12);
  assert.equal(r.setup.people, 1340);
  assert.equal(r.setup.onboarded, true);
});

test('the setup gate still reads people, so a graph of contacts with no companies is set up', async () => {
  const r = await resolveWhoami(fakeSupabase({ companies: 0, contacts: 5 }), { workspaceId: 'ws' });
  assert.equal(r.setup.accounts, 0);
  assert.equal(r.setup.onboarded, true);
});

test('a fresh workspace is not set up', async () => {
  const r = await resolveWhoami(fakeSupabase(), { workspaceId: 'ws' });
  assert.deepEqual(r.setup, { onboarded: false, accounts: 0, people: 0, has_icp: false });
});
