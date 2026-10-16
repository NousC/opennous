// A Slack destination (GET-941): what an event looks like in the channel, how the send answers,
// and which URLs a Slack destination accepts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slackMessage, eventLabel, eventTone, eventSummary } from '../dist/services/eventText.mjs';
import { deliverToSubscription, sendSlackMessage } from '../dist/db/webhookDeliveries.js';
import { SLACK_WEBHOOK_RE } from '../dist/db/triggers.js';

const champion = {
  id: 'evt-1', type: 'signal.stakeholder_left',
  account: { entity_id: 'a1', name: 'Meridian <Analytics>' },
  deal: { name: 'Meridian renewal', stage: 'negotiation', amount: 84000, currency: 'USD' },
  data: { title: 'Champion left: Sarah Chen', quote: 'Sarah has moved on', said_by: 'Tom Reyes' },
};

test('a signal reads as what happened, where, the quote, and the deal underneath', () => {
  const m = slackMessage('signal.stakeholder_left', champion);
  assert.equal(m.text, 'Stakeholder left · Meridian <Analytics>: Champion left: Sarah Chen');
  const body = m.blocks[0].text.text;
  assert.match(body, /^:red_circle: \*Stakeholder left\* · Meridian &lt;Analytics&gt;/, 'red for a risk, and escaped');
  assert.match(body, /Champion left: Sarah Chen/);
  assert.match(body, /> Sarah has moved on — Tom Reyes/);
  const ctx = m.blocks[1].elements[0].text;
  assert.match(ctx, /Meridian renewal · negotiation · \$84,000/);
  assert.match(ctx, /`signal\.stakeholder_left`/);
});

test('labels and tones match the Events page', () => {
  assert.equal(eventLabel('deal.won'), 'Deal won');
  assert.equal(eventLabel('signal.brand_new'), 'Brand new');
  assert.equal(eventTone('deal.won'), 'positive');
  assert.equal(eventTone('signal.objection_raised'), 'warning');
  assert.equal(eventTone('conversation.call_ended'), 'neutral');
  assert.equal(eventSummary({ type: 'icp.score_changed', data: { from: { score: 40 }, to: { score: 82 } } }), '40 → 82');
  assert.match(slackMessage('deal.won', { account: { name: 'Atlas' }, deal: { name: 'Atlas platform' } }).blocks[0].text.text, /^:large_green_circle: \*Deal won\* · Atlas\nAtlas platform/);
});

test('the send posts the message, not the JSON, and a removed webhook is permanent', async () => {
  let sent = null;
  const ok = await sendSlackMessage({ url: 'https://hooks.slack.com/services/T/B/x', eventType: 'deal.won', payload: { account: { name: 'Atlas' } },
    fetchImpl: async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return new Response('ok', { status: 200 }); } });
  assert.equal(ok.ok, true);
  assert.ok(sent.body.blocks && sent.body.text.startsWith('Deal won'));
  const gone = await sendSlackMessage({ url: 'https://hooks.slack.com/services/T/B/x', eventType: 'deal.won', payload: {},
    fetchImpl: async () => new Response('no_service', { status: 404 }) });
  assert.equal(gone.ok, false);
  assert.equal(gone.permanent, true);
  assert.match(gone.error, /Slack webhook removed/);
  const limited = await sendSlackMessage({ url: 'https://hooks.slack.com/services/T/B/x', eventType: 'deal.won', payload: {},
    fetchImpl: async () => new Response('rate_limited', { status: 429 }) });
  assert.equal(limited.permanent, false, 'a rate limit is retried');
});

test('one send path: a Slack subscription goes to Slack, unsigned', async () => {
  let headers = null;
  const r = await deliverToSubscription({ url: 'https://hooks.slack.com/services/T/B/x', signing_secret: 's', destination_type: 'slack' },
    { eventType: 'deal.won', eventId: 'e1', payload: { account: { name: 'Atlas' } },
      fetchImpl: async (_u, init) => { headers = init.headers; return new Response('ok', { status: 200 }); } });
  assert.equal(r.ok, true);
  assert.equal(headers['X-Nous-Signature'], undefined);
});

test('only a Slack incoming webhook is a Slack destination', () => {
  assert.ok(SLACK_WEBHOOK_RE.test('https://hooks.slack.com/services/T000/B000/XXXX'));
  assert.ok(SLACK_WEBHOOK_RE.test('https://hooks.slack.com/triggers/T000/123/abc'));
  assert.ok(!SLACK_WEBHOOK_RE.test('https://evil.example/hooks.slack.com/services/x'));
  assert.ok(!SLACK_WEBHOOK_RE.test('http://hooks.slack.com/services/T/B/x'));
  assert.ok(!SLACK_WEBHOOK_RE.test('https://hooks.slack.com.evil.example/services/T/B/x'));
});
