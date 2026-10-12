// {{person.email}} was never filled (GET-834): every default "drafted for you" automation sent its
// Gmail draft to an empty To. Who the email is to, in order.
//
// Run: node --test packages/core/test/personVars.test.mjs   (after `tsc`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { personVars } from '../dist/services/automationRun.mjs';

// contacts answer by id (eq 'id') or by company (eq 'company_id', newest first as given).
function db(contacts, internal = []) {
  return {
    from(table) {
      const f = {};
      const q = {
        select: () => q, not: () => q, order: () => q, limit: () => q,
        eq: (k, v) => { f[k] = v; return q; },
        maybeSingle: async () => ({ data: contacts.find((c) => c.id === f.id) ?? null, error: null }),
        then: (res) => {
          if (table === 'team_members' || table === 'workspace_members' || table === 'users') return res({ data: [], error: null });
          return res({ data: contacts.filter((c) => c.company_id === f.company_id && c.email), error: null });
        },
      };
      return q;
    },
    internal,
  };
}

const dana = { id: 'p-dana', first_name: 'Dana', last_name: 'Wu', email: 'dana@harborline.example', job_title: 'COO', company_id: 'acc' };
const rui = { id: 'p-rui', first_name: 'Rui', last_name: null, email: 'rui@harborline.example', company_id: 'acc' };

test('the person who raised the signal', async () => {
  const v = await personVars(db([dana, rui]), 'w', { entityId: 'acc', signal: { entity_id: 'p-rui' } });
  assert.equal(v['person.email'], 'rui@harborline.example');
  assert.equal(v['person.name'], 'Rui');
});

test('else the first call attendee with an address', async () => {
  const v = await personVars(db([dana]), 'w', { entityId: 'acc', call: { attendees: [{ name: 'No Mail' }, { name: 'Lee Park', email: 'lee@fernpoint.example' }] } });
  assert.equal(v['person.email'], 'lee@fernpoint.example');
  assert.equal(v['person.name'], 'Lee Park');
});

test('else the account\'s most recently contacted person; a person-level run is that person', async () => {
  const v = await personVars(db([dana, rui]), 'w', { entityId: 'acc' });
  assert.equal(v['person.email'], 'dana@harborline.example');
  assert.equal(v['person.title'], 'COO');
  const p = await personVars(db([dana, rui]), 'w', { entityId: 'p-rui' });
  assert.equal(p['person.email'], 'rui@harborline.example');
});

test('nobody with an address leaves it empty, never throws', async () => {
  const v = await personVars(db([]), 'w', { entityId: 'acc' });
  assert.deepEqual(v, { 'person.email': null, 'person.name': null, 'person.title': null });
});
