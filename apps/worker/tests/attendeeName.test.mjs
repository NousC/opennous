// A contact known only by email takes the name the note-taker's attendee list gives (GET-252).
// A Harborline contact sat nameless through a call whose invite named him, so extraction
// skipped every fact about him.
//
// Run: node --test apps/worker/tests/attendeeName.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillMissingName } from '../src/utils/resolveMeeting.mjs';

function stub() {
  const rows = [];
  const sb = {
    rows,
    from: () => ({
      insert(row) {
        rows.push(row);
        return { select: () => ({ single: async () => ({ data: { id: String(rows.length), ...row }, error: null }) }) };
      },
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
    }),
  };
  return sb;
}

test('an empty name is filled from the attendee, first and last', async () => {
  const sb = stub();
  const contact = { id: 'c1', first_name: null, last_name: null };
  await fillMissingName(sb, 'w', contact, { name: 'Corwin Ashdale (Sales)', email: 'corwin@harborline.example' }, 'granola');
  assert.deepEqual(sb.rows.map(r => [r.property, r.value]), [['first_name', 'Corwin'], ['last_name', 'Ashdale']]);
  assert.equal(contact.first_name, 'Corwin');
});

test('a name already on the record is never overwritten', async () => {
  const sb = stub();
  await fillMissingName(sb, 'w', { id: 'c1', first_name: 'Rowan', last_name: 'Achterberg' }, { name: 'Ro A' }, 'granola');
  assert.equal(sb.rows.length, 0);
});

test('an attendee that is only an email gives no name', async () => {
  const sb = stub();
  await fillMissingName(sb, 'w', { id: 'c1', first_name: null }, { name: 'corwin@harborline.example' }, 'granola');
  assert.equal(sb.rows.length, 0);
});

test('extraction is told what the workspace sells, from its positioning', async () => {
  const { offerExcerpt, ourOfferBlock } = await import('../src/signals/extractionText.mjs');
  const md = '# Nous positioning\n\n> Nous is the **revenue intelligence layer**. One agent layer that unifies every sales conversation.\n\n## Who it is for\nRevenue teams.';
  const offer = offerExcerpt(md);
  assert.equal(offer, 'Nous is the revenue intelligence layer. One agent layer that unifies every sales conversation. Revenue teams.');
  assert.match(ourOfferBlock({ companyName: 'OpenNous', offer }), /^WHAT OPENNOUS SELLS \(its own positioning — decide competitor vs status_quo against THIS\):\nNous is the revenue/);
  assert.equal(ourOfferBlock({ companyName: 'OpenNous', offer: null }), '');
  assert.equal(offerExcerpt('# Title only'), null);
});
