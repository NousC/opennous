import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pipelineFeatures } from '@nous/core';

// Slice 3 — pipeline-engagement features. Pure function: turns an activity log
// into bucketed, discovery-mineable features (lead source, channel, inbound,
// replied, banded counts). No DB; runs everywhere.

test('empty activity → no features', () => {
  assert.deepEqual(pipelineFeatures([]), {});
  assert.deepEqual(pipelineFeatures(null), {});
});

test('outbound email sequence, several touches, a reply and a meeting', () => {
  const acts = [
    { property: 'interaction.email_sent', source: 'instantly', observed_at: '2026-01-01T00:00:00Z' },
    { property: 'interaction.email_sent', source: 'instantly', observed_at: '2026-01-03T00:00:00Z' },
    { property: 'interaction.email_reply', source: 'gmail', observed_at: '2026-01-04T00:00:00Z' },
    { property: 'interaction.meeting_held', source: 'gmail', observed_at: '2026-01-08T00:00:00Z' },
  ];
  const f = pipelineFeatures(acts);
  assert.equal(f['pipe.channel'], 'email', 'first touch was email');
  assert.equal(f['pipe.inbound'], false, 'outbound — we reached out first');
  assert.equal(f['pipe.lead_source'], 'outbound_email');
  assert.equal(f['pipe.replied'], true);
  assert.equal(f['pipe.meetings_band'], '1');
  assert.equal(f['pipe.touches_band'], '3-5');
});

test('inbound from the website is detected as inbound', () => {
  const acts = [
    { property: 'interaction.website_visit', source: 'website', observed_at: '2026-02-01T00:00:00Z' },
    { property: 'interaction.signed_up', source: 'webhook', observed_at: '2026-02-02T00:00:00Z' },
  ];
  const f = pipelineFeatures(acts);
  assert.equal(f['pipe.inbound'], true);
  assert.equal(f['pipe.channel'], 'website');
  assert.equal(f['pipe.lead_source'], 'inbound_website');
});

test('inbound LinkedIn message, 3+ meetings band', () => {
  const acts = [
    { property: 'interaction.linkedin_message_received', source: 'heyreach', observed_at: '2026-03-01T00:00:00Z' },
    { property: 'interaction.meeting_held', source: 'gmail', observed_at: '2026-03-05T00:00:00Z' },
    { property: 'interaction.call', source: 'gmail', observed_at: '2026-03-09T00:00:00Z' },
    { property: 'interaction.meeting_held', source: 'gmail', observed_at: '2026-03-12T00:00:00Z' },
  ];
  const f = pipelineFeatures(acts);
  assert.equal(f['pipe.channel'], 'linkedin');
  assert.equal(f['pipe.inbound'], true);
  assert.equal(f['pipe.meetings_band'], '3+', '2 meetings + 1 call = 3');
});

test('outcome markers (deal_won/lost) are excluded from engagement', () => {
  const acts = [
    { property: 'interaction.email_sent', source: 'instantly', observed_at: '2026-04-01T00:00:00Z' },
    { property: 'interaction.deal_won', source: 'manual', observed_at: '2026-04-10T00:00:00Z' },
  ];
  const f = pipelineFeatures(acts);
  assert.equal(f['pipe.touches_band'], '1-2', 'deal_won not counted as a touch');
  assert.equal(f['pipe.channel'], 'email', 'first non-outcome touch sets the channel');
});
