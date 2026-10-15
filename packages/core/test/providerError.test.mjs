// Model provider failures sorted into what a person and ops need to know (GET-885). Pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyProviderError, providerErrorSummary } from '../dist/index.js';

// What the Anthropic SDK throws: status, the parsed body on .error, the body in the message.
const sdkError = (status, type, message) => Object.assign(
  new Error(`${status ?? ''} ${JSON.stringify({ type: 'error', error: { type, message } })}`.trim()),
  { status, error: { type: 'error', error: { type, message } } },
);

test('billing: the 2026-10-15 credit-balance 400, a 402, and the billing_error type', () => {
  const credit = sdkError(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.');
  assert.equal(classifyProviderError(credit).kind, 'billing');
  assert.equal(classifyProviderError(credit).status, 400);
  assert.equal(classifyProviderError(Object.assign(new Error('Payment Required'), { status: 402 })).kind, 'billing');
  assert.equal(classifyProviderError(sdkError(undefined, 'billing_error', 'Insufficient credits')).kind, 'billing');
  assert.equal(classifyProviderError(new Error('model call failed: 402 {"error":{"message":"This request requires more credits"}}')).kind, 'billing');
  assert.equal(classifyProviderError(new Error('insufficient_quota: You exceeded your current quota')).kind, 'billing');
});

test('auth: 401/403, the error types, an invalid key message', () => {
  assert.equal(classifyProviderError(sdkError(401, 'authentication_error', 'invalid x-api-key')).kind, 'auth');
  assert.equal(classifyProviderError(sdkError(403, 'permission_error', 'Your API key does not have permission')).kind, 'auth');
  assert.equal(classifyProviderError(new Error('model call failed: 401 {"error":{"message":"No auth credentials found"}}')).kind, 'auth');
  assert.equal(classifyProviderError(new Error('Invalid API key provided')).kind, 'auth');
});

test('rate_limit: 429, 529, overloaded_error from a mid-stream error event', () => {
  assert.equal(classifyProviderError(sdkError(429, 'rate_limit_error', 'Number of request tokens has exceeded your per-minute rate limit')).kind, 'rate_limit');
  assert.equal(classifyProviderError(sdkError(529, 'overloaded_error', 'Overloaded')).kind, 'rate_limit');
  assert.equal(classifyProviderError(sdkError(undefined, 'overloaded_error', 'Overloaded')).kind, 'rate_limit');
  assert.equal(classifyProviderError(new Error('model call failed: 429 rate limited')).kind, 'rate_limit');
});

test('other: a plain bug, a 500, a bad request, nothing at all', () => {
  assert.equal(classifyProviderError(new Error('Cannot read properties of undefined')).kind, 'other');
  assert.equal(classifyProviderError(new Error('overloaded')).kind, 'other');   // a bare word is not a provider signal
  assert.equal(classifyProviderError(sdkError(500, 'api_error', 'Internal server error')).kind, 'other');
  assert.equal(classifyProviderError(sdkError(400, 'invalid_request_error', 'messages: text content blocks must be non-empty')).kind, 'other');
  assert.equal(classifyProviderError(null).kind, 'other');
  assert.equal(classifyProviderError(undefined).status, null);
});

test('billing wins over auth when a provider says both', () => {
  assert.equal(classifyProviderError(sdkError(403, 'permission_error', 'Your credit balance is too low')).kind, 'billing');
});

test('providerErrorSummary: the provider\'s own words, short, with anything key-like removed', () => {
  const s = providerErrorSummary(sdkError(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API.'));
  assert.equal(s, 'Your credit balance is too low to access the Anthropic API.');
  const leaky = providerErrorSummary(new Error('401 invalid key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 and sk-or-v1-0123456789abcdef0123 (Bearer abc.def.ghi)'));
  assert.doesNotMatch(leaky, /sk-ant|sk-or|abc\.def/);
  assert.match(leaky, /\[redacted\]/);
  assert.ok(providerErrorSummary(new Error('x'.repeat(1000))).length <= 300);
  assert.equal(providerErrorSummary(null), '');
});
