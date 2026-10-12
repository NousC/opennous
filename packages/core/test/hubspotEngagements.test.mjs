// HubSpot engagement → Nous activity mapping. Property names and value vocab are from a
// live portal's schema (scripts/hubspot-profile.mjs, 2026-09-09).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hubspotEngagementToActivity } from '../dist/integrations/crm/index.js';

const T = '2026-08-12T14:00:00.000Z';

test('calls: direction and status decide the type; AI summary beats rep notes for summary', () => {
  const m = hubspotEngagementToActivity('calls', { id: '1', properties: {
    hs_timestamp: T, hs_call_title: 'Discovery call', hs_call_direction: 'OUTBOUND', hs_call_status: 'COMPLETED',
    hs_call_body: '<p>Budget frozen until Q1.</p>', hs_ai_summary: 'Prospect raised budget timing; wants a pilot.',
    hs_call_duration: '900000', hs_call_recording_url: 'https://r/1', hs_call_has_transcript: 'true', hs_call_transcription_id: '77',
    hubspot_owner_id: '5',
  } });
  assert.equal(m.type, 'call_made');
  assert.equal(m.occurredAt, T);
  assert.equal(m.description, 'Discovery call');
  assert.equal(m.summary, 'Prospect raised budget timing; wants a pilot.');
  assert.match(m.text, /Summary\nProspect raised/);
  assert.match(m.text, /Notes\nBudget frozen/);
  assert.equal(m.docType, 'meeting_notes');
  assert.equal(m.ownerExternalId, '5');
  assert.equal(m.meta.duration_ms, 900000);
  assert.equal(m.meta.has_transcript, true);
  assert.equal(m.meta.transcription_id, '77');
});

test('calls: inbound and not-completed', () => {
  assert.equal(hubspotEngagementToActivity('calls', { id: '1', properties: { hs_timestamp: T, hs_call_direction: 'INBOUND', hs_call_status: 'COMPLETED' } }).type, 'call_received');
  assert.equal(hubspotEngagementToActivity('calls', { id: '1', properties: { hs_timestamp: T, hs_call_direction: 'OUTBOUND', hs_call_status: 'NO_ANSWER' } }).type, 'call_missed');
  const bare = hubspotEngagementToActivity('calls', { id: '1', properties: { hs_timestamp: T } });
  assert.equal(bare.type, 'call_made');
  assert.equal(bare.text, null);
  assert.equal(bare.docType, null);
});

test('emails: direction maps to sent/received; body rides on meta, never a document', () => {
  const inb = hubspotEngagementToActivity('emails', { id: '2', properties: {
    hs_timestamp: T, hs_email_subject: 'Re: pricing', hs_email_direction: 'INCOMING_EMAIL', hs_email_text: 'Can you send the SOC 2 report?',
  } });
  assert.equal(inb.type, 'email_received');
  assert.equal(inb.description, 'Re: pricing');
  assert.equal(inb.summary, 'Can you send the SOC 2 report?');
  assert.equal(inb.docType, null);
  assert.equal(inb.meta.body, 'Can you send the SOC 2 report?');
  assert.equal(hubspotEngagementToActivity('emails', { id: '3', properties: { hs_timestamp: T, hs_email_direction: 'EMAIL' } }).type, 'email_sent');
  assert.equal(hubspotEngagementToActivity('emails', { id: '3', properties: { hs_timestamp: T, hs_email_direction: 'FORWARDED_EMAIL' } }).type, 'email_sent');
});

test('meetings: outcome decides the type; start time wins over hs_timestamp', () => {
  const held = hubspotEngagementToActivity('meetings', { id: '4', properties: {
    hs_timestamp: '2026-08-01T00:00:00.000Z', hs_meeting_start_time: T, hs_meeting_title: 'Demo', hs_meeting_outcome: 'COMPLETED',
    hs_meeting_body: 'Demo of core workflow', hs_ai_summary: 'Strong interest; CFO to join next call.', hs_internal_meeting_notes: 'Champion is Solveig.',
    hs_has_meeting_transcript: true, hs_meeting_transcription_id: 91,
  } });
  assert.equal(held.type, 'meeting_held');
  assert.equal(held.occurredAt, T);
  assert.match(held.text, /Summary\nStrong interest/);
  assert.match(held.text, /Internal notes\nChampion is Solveig/);
  assert.equal(held.meta.has_transcript, true);
  assert.equal(held.meta.transcription_id, 91);
  assert.equal(hubspotEngagementToActivity('meetings', { id: '5', properties: { hs_timestamp: T, hs_meeting_outcome: 'CANCELED' } }).type, 'meeting_cancelled');
  assert.equal(hubspotEngagementToActivity('meetings', { id: '5', properties: { hs_timestamp: T, hs_meeting_outcome: 'NO_SHOW' } }).type, 'meeting_no_show');
  assert.equal(hubspotEngagementToActivity('meetings', { id: '5', properties: { hs_timestamp: T, hs_meeting_outcome: 'SCHEDULED' } }).type, 'meeting_scheduled');
});

test('meetings: a past meeting with no outcome counts as held; a future one as scheduled', () => {
  const future = new Date(Date.now() + 7 * 864e5).toISOString();
  assert.equal(hubspotEngagementToActivity('meetings', { id: '6', properties: { hs_meeting_start_time: T } }).type, 'meeting_held');
  assert.equal(hubspotEngagementToActivity('meetings', { id: '6', properties: { hs_meeting_start_time: future } }).type, 'meeting_scheduled');
});

test('notes: HTML is stripped; an empty note is dropped', () => {
  const n = hubspotEngagementToActivity('notes', { id: '7', properties: { hs_timestamp: T, hs_note_body: '<div>Sent the deck.<br>Follow up Friday.</div>' } });
  assert.equal(n.type, 'note_added');
  assert.equal(n.text, 'Sent the deck.\nFollow up Friday.');
  assert.equal(n.docType, 'note');
  assert.equal(hubspotEngagementToActivity('notes', { id: '8', properties: { hs_timestamp: T, hs_note_body: '<p></p>' } }), null);
});

test('no timestamp → null', () => {
  assert.equal(hubspotEngagementToActivity('calls', { id: '9', properties: { hs_call_title: 'x' } }), null);
});

// An HTML-only inbound email (GET-396).
//
// HubSpot leaves hs_email_text EMPTY when the message arrived as HTML, which is what a real
// person's mail client sends. The importer asked for text alone, so on Harborline about a third of
// received emails — and rising — were stored with no body at all, while our
// own sent mail was nearly all intact because it goes out through HubSpot and does populate text.
//
// That asymmetry is the whole bug, and it lands exactly where it hurts most: the two-sided guard
// means a claim about the customer may only quote the CUSTOMER's messages.
test('emails: an HTML-only message still has a body', () => {
  const m = hubspotEngagementToActivity('emails', { id: '9', properties: {
    hs_timestamp: T, hs_email_subject: 'Re: appraisal tool', hs_email_direction: 'INCOMING_EMAIL',
    hs_email_text: '',                       // HubSpot's text field, empty — the failure
    hs_email_html: '<div dir="ltr">We&#39;re on Motorlane CRM.<br>Can it pull status?</div>',
  } });
  assert.equal(m.type, 'email_received');
  assert.equal(m.meta.body, "We're on Motorlane CRM.\nCan it pull status?",
    'the HTML body is the fallback, parsed to text, with entities decoded and <br> as a break');
});

test('emails: the stylesheet is not the body', () => {
  // The local stripHtml deletes tags but keeps what is BETWEEN them, so a <style> block becomes
  // CSS filed as what the customer said. messageBodyText drops the element (GET-249).
  const m = hubspotEngagementToActivity('emails', { id: '10', properties: {
    hs_timestamp: T, hs_email_direction: 'INCOMING_EMAIL',
    hs_email_html: '<head><style>.x{color:#fff;font-size:11px}</style></head><body><p>Approved.</p></body>',
  } });
  assert.equal(m.meta.body, 'Approved.');
  assert.doesNotMatch(m.meta.body, /font-size|color:/);
});

test('emails: text wins when HubSpot has both', () => {
  // Not merely a preference: HubSpot's own text extraction is better than ours, and using it
  // keeps every already-imported row byte-identical so the re-sync touches only empty ones.
  const m = hubspotEngagementToActivity('emails', { id: '11', properties: {
    hs_timestamp: T, hs_email_direction: 'INCOMING_EMAIL',
    hs_email_text: 'Plain wins.', hs_email_html: '<p>HTML loses.</p>',
  } });
  assert.equal(m.meta.body, 'Plain wins.');
});

test('emails: quoted history is still dropped, in HTML as well as text', () => {
  // GET-277: HubSpot puts the whole thread in the body and every reply is its own row, so keeping
  // the quote files the same conversation again on each message.
  const m = hubspotEngagementToActivity('emails', { id: '12', properties: {
    hs_timestamp: T, hs_email_direction: 'INCOMING_EMAIL',
    hs_email_html: '<div>Yes, Friday works.</div><blockquote>On Tue, Piers wrote: are you free?</blockquote>',
  } });
  assert.equal(m.meta.body, 'Yes, Friday works.');
});

test('emails: a message with neither field stores null, not "undefined"', () => {
  const m = hubspotEngagementToActivity('emails', { id: '13', properties: {
    hs_timestamp: T, hs_email_direction: 'INCOMING_EMAIL', hs_email_subject: 'Read receipt',
  } });
  assert.equal(m.meta.body, null);
  assert.equal(m.summary, null);
});

test('the importer actually requests the html field', () => {
  // The mapping above is correct and was ALSO correct before this change for any row that
  // happened to carry html — it never did, because the fetch did not ask for it. The property
  // list is the fix; the mapping is what makes the fix usable.
  const src = readFileSync(new URL('../src/integrations/crm/index.ts', import.meta.url), 'utf8');
  const emails = src.slice(src.indexOf('emails: ['), src.indexOf(']', src.indexOf('emails: [')));
  assert.match(emails, /'hs_email_html'/, 'hs_email_html must be in ENGAGEMENT_PROPERTIES.emails');
});
