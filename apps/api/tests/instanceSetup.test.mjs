// Settings → Instance setup (GET-837): which integrations and email a self-hosted install has
// ready, read from its environment. Pure: each test passes its own env.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { integrationStatus, emailStatus, addressStatus } from '../src/lib/instanceSetup.mjs';

const byId = (env) => Object.fromEntries(integrationStatus(env).map((i) => [i.id, i]));

test('key-paste integrations are ready on a bare install; OAuth ones say what they need', () => {
  const s = byId({});
  for (const id of ['hubspot', 'attio', 'fireflies', 'granola', 'fathom']) assert.equal(s[id].ready, true, id);
  assert.equal(s.salesforce.ready, false);
  assert.deepEqual(s.salesforce.needs, ['SALESFORCE_CLIENT_ID', 'SALESFORCE_CLIENT_SECRET', 'SALESFORCE_REDIRECT_URI']);
  assert.equal(s.gmail_oauth.ready, false);
  assert.match(s.gmail_oauth.guide, /#gmail-and-google-calendar$/);
});

test('Google is ready only with its own OAuth app (never Composio); Salesforce with its connected app', () => {
  assert.equal(byId({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's', API_DOMAIN: 'api.acme.com' }).gmail_oauth.ready, true);
  assert.equal(byId({ COMPOSIO_API_KEY: 'ak_1' }).gmail_oauth.ready, false);
  assert.equal(byId({ SALESFORCE_CLIENT_ID: 'a', SALESFORCE_CLIENT_SECRET: 'b', SALESFORCE_REDIRECT_URI: 'https://api.acme.com/cb' }).salesforce.ready, true);
});

test('email is ready only with an SMTP host and sender', () => {
  assert.equal(emailStatus({}).ready, false);
  assert.equal(emailStatus({ SMTP_HOST: 'smtp.acme.com', SMTP_ADMIN_EMAIL: 'no-reply@acme.com' }).ready, true);
});

test('the public address: localhost and private names cannot receive webhooks, a real domain can', () => {
  for (const d of ['localhost', 'api.localhost', '127.0.0.1', '192.168.1.20', 'nous.local', 'api.yourdomain.com', '']) {
    assert.equal(addressStatus({ API_DOMAIN: d }).public, false, d || '(unset)');
  }
  const s = addressStatus({ API_DOMAIN: 'api.acme.com' });
  assert.equal(s.public, true);
  assert.equal(s.domain, 'api.acme.com');
});
