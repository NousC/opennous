// A signal's tag (GET-894): the Accounts table's Latest signal shows a tinted pill for the kind and
// what was actually said. The tone of every kind is decided once, here, and the row the API sends
// carries the label, the tone and the text so the browser only paints it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIGNAL_LABEL } from '../dist/services/signalLabels.mjs';
import { SIGNAL_TONE, SIGNAL_TONES, CUSTOM_TONES, signalTone, signalText, latestSignalView } from '../dist/services/signalTone.mjs';

test('every known signal kind has a tone from the palette', () => {
  for (const kind of Object.keys(SIGNAL_LABEL)) {
    assert.ok(SIGNAL_TONE[kind], `${kind} has no tone`);
    assert.ok(SIGNAL_TONES.includes(SIGNAL_TONE[kind]), `${kind} tone ${SIGNAL_TONE[kind]} is not in the palette`);
  }
  assert.deepEqual(Object.keys(SIGNAL_TONE).sort(), Object.keys(SIGNAL_LABEL).sort());
});

test('negative kinds are red, positive green, the rest grouped', () => {
  assert.equal(signalTone('churn_risk'), 'red');
  assert.equal(signalTone('expansion_declined'), 'red');
  assert.equal(signalTone('stakeholder_left'), 'red');
  assert.equal(signalTone('expansion_signal'), 'green');
  assert.equal(signalTone('buying_signal'), 'green');
  assert.equal(signalTone('objection_resolved'), 'green');
  assert.equal(signalTone('stakeholder_identified'), 'blue');
  assert.equal(signalTone('stakeholder_joined'), 'blue');
  assert.equal(signalTone('competitor_mentioned'), 'amber');
  assert.equal(signalTone('competitor_evaluating'), 'amber');
  assert.equal(signalTone('objection_raised'), 'orange');
  assert.equal(signalTone('budget_discussed'), 'purple');
  assert.equal(signalTone('next_step'), 'slate');
});

test('a custom signal gets a stable colour of its own; an unknown kind is neutral', () => {
  const a = signalTone('custom_3b0c2a4e-0000-4000-8000-000000000001');
  assert.ok(CUSTOM_TONES.includes(a));
  assert.equal(signalTone('custom_3b0c2a4e-0000-4000-8000-000000000001'), a);
  const seen = new Set(Array.from({ length: 24 }, (_, i) => signalTone(`custom_${i}`)));
  assert.ok(seen.size > 1, 'custom signals spread over the palette');
  for (const t of CUSTOM_TONES) assert.ok(SIGNAL_TONES.includes(t));
  assert.equal(signalTone('something_new'), 'slate');
  assert.equal(signalTone(null), 'slate');
});

test('the text is what was said: content, then the quote, then the title', () => {
  assert.equal(signalText({ title: 'Reporting', content: 'They will switch to a cheaper vendor after renewal.', quote: 'we are moving' }), 'They will switch to a cheaper vendor after renewal.');
  assert.equal(signalText({ title: 'Reporting', content: '  ', quote: '  we are moving  ' }), 'we are moving');
  assert.equal(signalText({ title: 'Monthly Cost Need' }), 'Monthly Cost Need');
  assert.equal(signalText({ content: 'Line one\n\n  line   two' }), 'Line one line two');
  assert.equal(signalText({}), null);
});

test('the latest-signal row carries label, tone and text', () => {
  const raw = { kind: 'churn_risk', title: null, content: 'Asked to stop sending leads after renewal.', quote: 'please stop', at: '2026-10-14T10:00:00Z', entity_id: 'e1', claim_property: 'note.x' };
  assert.deepEqual(latestSignalView(raw), { ...raw, label: 'Churn risk', tone: 'red', text: 'Asked to stop sending leads after renewal.' });
  // A custom signal's label is its definition's name (the row's title).
  const custom = latestSignalView({ kind: 'custom_d1', title: 'Security review needed', content: 'The buyer asked for SOC 2.', at: null });
  assert.equal(custom.label, 'Security review needed');
  assert.equal(custom.text, 'The buyer asked for SOC 2.');
  assert.ok(CUSTOM_TONES.includes(custom.tone));
  assert.equal(latestSignalView({ kind: 'custom_d1', title: 'Security review needed', content: null }).text, null);
  // A row from before the migration (title only) still reads: the title is the text.
  const old = latestSignalView({ kind: 'expansion_signal', title: 'Reporting', at: null });
  assert.equal(old.label, 'Expansion signal');
  assert.equal(old.text, 'Reporting');
  // An unknown kind reads as a sentence, never snake_case.
  assert.equal(latestSignalView({ kind: 'odd_kind', title: null }).label, 'Odd kind');
  assert.equal(latestSignalView(null), null);
});
