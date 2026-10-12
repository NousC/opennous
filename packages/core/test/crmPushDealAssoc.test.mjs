// The associations block on a HubSpot engagement push: the contact, plus every deal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hubspotEngagementAssociations, HUBSPOT_DEAL_ASSOC } from '../dist/services/crmPush.js';

test('contact only, when there is no deal', () => {
  const a = hubspotEngagementAssociations('notes', 'c1');
  assert.equal(a.length, 1);
  assert.equal(a[0].to.id, 'c1');
  assert.equal(a[0].types[0].associationTypeId, 202);
});

test('contact plus one association per deal, with the object-specific deal type id', () => {
  for (const [object, typeId] of Object.entries(HUBSPOT_DEAL_ASSOC)) {
    const a = hubspotEngagementAssociations(object, 'c1', ['d1', 'd2']);
    assert.equal(a.length, 3, object);
    assert.deepEqual(a.slice(1).map(x => x.to.id), ['d1', 'd2']);
    for (const x of a.slice(1)) assert.equal(x.types[0].associationTypeId, typeId);
  }
});

test('verified live ids: notes 214, meetings 212, emails 210, calls 206', () => {
  assert.deepEqual(HUBSPOT_DEAL_ASSOC, { notes: 214, meetings: 212, emails: 210, calls: 206 });
});

test('duplicates and blanks are dropped; numbers are stringified', () => {
  const a = hubspotEngagementAssociations('meetings', 'c1', ['d1', 'd1', '', null, undefined, 42]);
  assert.deepEqual(a.slice(1).map(x => x.to.id), ['d1', '42']);
});

test('an object with no deal association type sends the contact only', () => {
  const a = hubspotEngagementAssociations('tasks', 'c1', ['d1']);
  assert.equal(a.length, 1);
});
