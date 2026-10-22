import { test } from 'node:test';
import assert from 'node:assert/strict';
import { certHint, untrustedCertCode } from '../src/certHint.js';

// What fetch actually throws for an untrusted certificate: TypeError("fetch failed") with the
// TLS error as its cause.
const fetchFailed = (code) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('tls'), { code }) });

test('each untrusted-certificate code gets the NODE_EXTRA_CA_CERTS hint', () => {
  for (const code of ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT']) {
    const hint = certHint(fetchFailed(code));
    assert.ok(hint, code);
    assert.match(hint, /NODE_EXTRA_CA_CERTS/);
    assert.match(hint, /self-host-bundled\.md#trying-it-on-a-laptop/);
    assert.ok(!hint.includes('\n'), 'one line');
  }
});

test('the code is found on the error itself too', () => {
  assert.equal(untrustedCertCode(Object.assign(new Error('x'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' })), 'SELF_SIGNED_CERT_IN_CHAIN');
});

test('other errors get no hint', () => {
  assert.equal(certHint(fetchFailed('ECONNREFUSED')), null);
  assert.equal(certHint(new Error('boom')), null);
  assert.equal(certHint(undefined), null);
});
