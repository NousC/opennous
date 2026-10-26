// A Claude scheduled task endpoint through the API (GET-1035): the token is encrypted on the way in
// and never comes back out; the row shows which task it fires.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);
const { destinationFromBody, webhookOut } = await import('../src/lib/webhookDestination.mjs');

const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_01AbC/fire';

test('a Claude destination keeps the Fire URL and encrypts the token', async () => {
  const d = await destinationFromBody({ destination: { type: 'claude', url: ` ${FIRE} `, token: ' sk-ant-oat01-secret ' } });
  assert.equal(d.type, 'claude');
  assert.equal(d.url, FIRE);
  assert.ok(d.tokenEnc && !d.tokenEnc.includes('sk-ant-oat01-secret'));
});

test('a Claude destination needs both the Fire URL and the token', async () => {
  await assert.rejects(destinationFromBody({ destination: { type: 'claude', token: 't' } }), /claude_fire_url_required/);
  await assert.rejects(destinationFromBody({ destination: { type: 'claude', url: FIRE } }), /claude_token_required/);
});

test('the row names the task and never carries the token', () => {
  const out = webhookOut({ id: 'w1', destination_type: 'claude', url: FIRE, github_token_enc: 'enc', signing_secret: 's', workspace_id: 'ws' });
  assert.deepEqual(out.destination, { type: 'claude', url: FIRE, task: 'trig_01AbC' });
  assert.equal('github_token_enc' in out, false);
  assert.equal('signing_secret' in out, false);
});
