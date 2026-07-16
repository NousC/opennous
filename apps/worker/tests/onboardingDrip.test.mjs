/**
 * Onboarding drip decision logic — pure, no Supabase or network needed.
 * Exercises the cadence (cumulative from welcome), step progression, and the
 * reply/convert/unsubscribe exit signals. The actual send + idempotent reserve
 * are integration concerns covered by the observations UNIQUE index, not here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideNextStep } from '../src/workers/onboardingDrip.mjs';

const HOUR = 3_600_000;
const now = 1_000_000_000_000;        // fixed "now"
const ago = (h) => new Date(now - h * HOUR).toISOString();

const welcome = (h) => ({ property: 'interaction.welcome_email_sent', observed_at: ago(h) });
const drip = (step, h) => ({ property: 'interaction.onboarding_drip_sent', value: { step }, observed_at: ago(h) });

test('no welcome → no send', () => {
  assert.equal(decideNextStep([], now).send, false);
});

test('welcome only, before 48h → not due', () => {
  const d = decideNextStep([welcome(47)], now);
  assert.deepEqual([d.send, d.reason], [false, 'not_due']);
});

test('welcome only, past 48h → send step 1', () => {
  const d = decideNextStep([welcome(49)], now);
  assert.deepEqual([d.send, d.step], [true, 1]);
});

test('step 1 sent, past 96h → send step 2', () => {
  const d = decideNextStep([welcome(100), drip(1, 52)], now);
  assert.deepEqual([d.send, d.step], [true, 2]);
});

test('step 1 sent, before 96h → not due (cadence is from welcome, not last send)', () => {
  const d = decideNextStep([welcome(50), drip(1, 2)], now);
  assert.deepEqual([d.send, d.reason], [false, 'not_due']);
});

test('all three sent, past 168h → complete', () => {
  const d = decideNextStep([welcome(200), drip(1, 150), drip(2, 110), drip(3, 40)], now);
  assert.deepEqual([d.send, d.reason], [false, 'complete']);
});

test('reply after welcome → exit even when a step is due', () => {
  const obs = [welcome(100), { property: 'interaction.email_received', observed_at: ago(80) }];
  assert.deepEqual([decideNextStep(obs, now).send, decideNextStep(obs, now).reason], [false, 'replied']);
});

test('email_replied also counts as a reply', () => {
  const obs = [welcome(100), { property: 'interaction.email_replied', observed_at: ago(80) }];
  assert.equal(decideNextStep(obs, now).send, false);
});

test('subscription started → exit', () => {
  const obs = [welcome(100), { property: 'interaction.subscription_started', observed_at: ago(90) }];
  assert.deepEqual([decideNextStep(obs, now).send, decideNextStep(obs, now).reason], [false, 'converted']);
});

test('unsubscribed → exit', () => {
  const obs = [welcome(100), { property: 'interaction.unsubscribed', observed_at: ago(90) }];
  assert.deepEqual([decideNextStep(obs, now).send, decideNextStep(obs, now).reason], [false, 'unsubscribed']);
});

test('a reply BEFORE the welcome (stale) does not block the sequence', () => {
  // edge: email_received timestamped before welcome shouldn't count as engagement
  const obs = [welcome(49), { property: 'interaction.email_received', observed_at: ago(60) }];
  assert.deepEqual([decideNextStep(obs, now).send, decideNextStep(obs, now).step], [true, 1]);
});
