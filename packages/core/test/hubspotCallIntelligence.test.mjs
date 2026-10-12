// Transcript + Notetaker recap normalisers. The real response shapes have not been seen on
// a portal with Conversation Intelligence, so these defend the plausible forms rather than
// asserting one. When the customer's portal shows the actual shape, add it here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHubspotTranscript, normalizeHubspotRecap, recapToDocument } from '../dist/integrations/crm/index.js';

test('transcript: plain string, flat text field, and nested transcript field', () => {
  assert.equal(normalizeHubspotTranscript('hello there'), 'hello there');
  assert.equal(normalizeHubspotTranscript({ text: ' full text ' }), 'full text');
  assert.equal(normalizeHubspotTranscript({ transcript: 'via transcript key' }), 'via transcript key');
  assert.equal(normalizeHubspotTranscript({ fullTranscript: 'camel' }), 'camel');
});

test('transcript: segment arrays are joined with speakers when present', () => {
  const t = normalizeHubspotTranscript({ segments: [
    { speaker: 'Solveig', text: 'Budget is frozen until Q1.' },
    { speaker: 'Rep', text: 'Could a pilot start sooner?' },
    { text: 'unattributed line' },
  ] });
  assert.equal(t, 'Solveig: Budget is frozen until Q1.\nRep: Could a pilot start sooner?\nunattributed line');
  assert.equal(normalizeHubspotTranscript({ utterances: [{ speakerName: 'A', content: 'x' }] }), 'A: x');
  assert.equal(normalizeHubspotTranscript({ transcript: { segments: [{ text: 'nested' }] } }), 'nested');
});

test('transcript: empty and unknown shapes yield null', () => {
  assert.equal(normalizeHubspotTranscript(null), null);
  assert.equal(normalizeHubspotTranscript(''), null);
  assert.equal(normalizeHubspotTranscript({}), null);
  assert.equal(normalizeHubspotTranscript({ segments: [] }), null);
  assert.equal(normalizeHubspotTranscript({ status: 'error', message: 'nope' }), null);
});

test('recap: documented fields, camel and snake', () => {
  const r = normalizeHubspotRecap({
    summary: 'Demo went well.',
    actionItems: ['Send pricing by Friday', { text: 'Book exec call' }],
    questionsAsked: ['Do you have SOC 2?'],
    participants: [{ name: 'Solveig' }, { email: 'rep@x.example' }],
    recordingUrl: 'https://r/1',
  });
  assert.equal(r.summary, 'Demo went well.');
  assert.deepEqual(r.actionItems, ['Send pricing by Friday', 'Book exec call']);
  assert.deepEqual(r.questions, ['Do you have SOC 2?']);
  assert.deepEqual(r.participants, ['Solveig', 'rep@x.example']);
  assert.equal(r.recordingUrl, 'https://r/1');

  const s = normalizeHubspotRecap({ recap: { summary: 'nested', action_items: ['a'], questions_asked: ['q'] }, recording_url: 'u' });
  assert.equal(s.summary, 'nested');
  assert.deepEqual(s.actionItems, ['a']);
  assert.deepEqual(s.questions, ['q']);
  assert.equal(s.recordingUrl, 'u');
});

test('recap: nothing useful → null; error bodies → null', () => {
  assert.equal(normalizeHubspotRecap(null), null);
  assert.equal(normalizeHubspotRecap({ participants: ['x'] }), null);
  assert.equal(normalizeHubspotRecap({ status: 'error', category: 'GATED' }), null);
});

test('recap document lists what was promised and what was asked', () => {
  const doc = recapToDocument({ summary: 'S', actionItems: ['A1', 'A2'], questions: ['Q1'], participants: ['P'], recordingUrl: null, raw: {} });
  assert.equal(doc, 'Summary\nS\n\nAction items\n- A1\n- A2\n\nQuestions asked\n- Q1\n\nParticipants\nP');
});
