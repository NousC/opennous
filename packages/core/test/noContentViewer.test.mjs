// A workspace key reads no raw content (GET-248). It is a viewer on nothing, whatever its scope:
// no message, however the row is owned, no transcript, no raw payload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NO_CONTENT_VIEWER, ownerScoped, rawVisible, readContextFromReq } from '../dist/db/readContext.js';
import { canReadMessage, canReadMeetingRaw, redactObservationForViewer } from '../dist/privacy/messagePrivacy.mjs';
import { getObservations } from '../dist/db/observations.js';

const nobody = { userId: NO_CONTENT_VIEWER, emails: new Set() };
const ctx = { workspaceId: 'w', viewerUserId: NO_CONTENT_VIEWER, viewerScope: 'admin', openVisibility: true };

test('no message content: not a teammate\'s, not company tooling\'s', () => {
  assert.equal(canReadMessage({ owner_user_id: 'rep', raw: { from: 'a@x.co' } }, nobody), false);
  assert.equal(canReadMessage({ owner_user_id: null, raw: { from: 'a@x.co' } }, nobody), false);
});

test('a real person and a system job are untouched', () => {
  assert.equal(canReadMessage({ owner_user_id: 'rep' }, { userId: 'rep', emails: new Set() }), true);
  assert.equal(canReadMessage({ owner_user_id: 'rep' }, null), true);
});

test('no transcript, even carrying admin scope', () => {
  assert.equal(canReadMeetingRaw({}, { ...nobody, isAdmin: true }, { open: true }), false);
});

test('no raw payload, even carrying admin scope in an open workspace', () => {
  assert.equal(rawVisible('rep', ctx), false);
  assert.equal(rawVisible(null, ctx), false);
  assert.equal(rawVisible('rep', { ...ctx, viewerUserId: null }), true);
});

test('the read context names nobody when the request says so', () => {
  assert.equal(readContextFromReq({ workspaceId: 'w', memberUserId: null, noContent: true, viewerScope: 'admin' }).viewerUserId, NO_CONTENT_VIEWER);
  assert.equal(readContextFromReq({ workspaceId: 'w', memberUserId: 'rep', viewerScope: 'admin' }).viewerUserId, 'rep');
});

test('a redacted row keeps that it happened and nothing it said', () => {
  const o = redactObservationForViewer({ property: 'interaction.email_sent', owner_user_id: null, value: { summary: 'Pricing' }, raw: { subject: 'Pricing', from: 'a@x.co' } }, nobody);
  assert.equal(o.redacted, true);
  assert.equal(o.value.summary, null);
  assert.equal(o.raw.subject, undefined);
});

test('getObservations gives nobody the row, not its payload', async () => {
  const rows = [
    { property: 'interaction.email_sent', owner_user_id: null, value: { summary: 'Pricing' }, raw: { subject: 'Pricing' } },
    { property: 'evidence.meeting', owner_user_id: null, value: { summary: 'Call', content: 'every word' }, raw: { transcript: 'every word' } },
  ];
  let adminFlag;
  const supabase = {
    rpc(_name, args) { adminFlag = args.p_viewer_is_admin; return Promise.resolve({ data: rows, error: null }); },
    from() { const b = { select: () => b, eq: () => b, in: () => b, then: (ok) => Promise.resolve({ data: [], error: null }).then(ok) }; return b; },
  };
  const out = await getObservations(supabase, 'w', 'e', {}, ctx);
  assert.equal(adminFlag, false);
  assert.equal(out[0].value.summary, null);
  assert.equal(out[0].redacted, true);
  assert.deepEqual(out[1].value, {});
  assert.equal(out[1].raw, null);
});

test('admin scope does not skip the owner cut for a workspace key', () => {
  assert.equal(ownerScoped(ctx), true);
  assert.equal(ownerScoped({ workspaceId: 'w', viewerUserId: 'rep', viewerScope: 'member' }), true);
  assert.equal(ownerScoped({ workspaceId: 'w', viewerUserId: 'founder', viewerScope: 'admin' }), false);
  assert.equal(ownerScoped(undefined), false);
});
