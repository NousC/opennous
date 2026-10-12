// Four shapes that look like a commitment and are not (GET-423). Quotes are invented, in the shapes the corpus showed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notACommitment } from '../dist/text/notACommitment.js';

test('a call to action in a bulk email is not a promise', () => {
  for (const q of [
    'RSVP for the webinar ( https://www.vendor.example/webinars/lead-capture-basics?utm_campaign=Late+Shift )',
    'Apply to join the partner circle ( https://www.vendor.example/partner-community?utm_campaign=Late+Shift )',
    'Review the Lumen Tag offer and get started: https://harborline.example/promotions/lumen-tag?utm_source=hubspot',
    'Click through it yourself: https://tours.harborline.example/demo/clexample0000demo0001',
    'Book a session with me: https://meetings-na1.hubspot.com/example-rep',
  ]) assert.match(String(notACommitment(q)), /bulk email/, q.slice(0, 50));
});

test('a numbered step in a template is not a promise', () => {
  for (const q of ['Step 1 — Pick a starting department.', 'Step 2 — Send your team the install link.', '3) Share the walkthrough with your team leads']) {
    assert.match(String(notACommitment(q)), /numbered step/, q);
  }
});

test('a real promise or ask is untouched — including one that merely mentions a link', () => {
  for (const q of [
    'could you send me a receipt for the 45.00 charge from last Tuesday',
    'Can you please take Ellery off the weekly report list?',
    'Swap the old logo for the new Lumen Lead one',
    'I will come back to you on Thursday with the revised timeline.',
    'We are still waiting on your IT team for the login details and the import file.',
    'Send us the signed order form and we will start the setup.',
    // a deliverable that happens to name our site — no tracking or booking path, so it stays
    'I will send the embed code over to your developer at quillbyte.example tomorrow.',
  ]) assert.equal(notACommitment(q), null, q.slice(0, 60));
});

test('nothing in, nothing out', () => {
  assert.equal(notACommitment(''), null);
  assert.equal(notACommitment(null), null);
  assert.equal(notACommitment(undefined), null);
});

// GET-424 — the fifth shape, and the only one judged on the title.
test('a standing state is not a task', () => {
  for (const t of [
    'Continue sending orders to the old portal until told otherwise.',
    'Keep the office move under wraps until Hollis Penrose announces it.',
    'Continue honoring the launch discount for the two pilot teams until March 31.',
    'Maintain the current approval flow for Corvane Supply.',
    'Hold off on the Lumen Rates rollout until the security review clears.',
  ]) assert.match(String(notACommitment('some quote', t)), /standing state/, t.slice(0, 50));
});

test('an open-ended promise to keep a PERSON posted survives', () => {
  for (const t of [
    'Keep Leopold posted on the Lumen Rates portion.',
    'Keep Barnaby updated on the website banner swap.',
    'Keep Odette Fairweather informed while the security review runs.',
    'Keep the team in the loop on the DMS go-live.',
  ]) assert.equal(notACommitment('I will keep you posted.', t), null, t);
});

test('a real deliverable that merely starts with a continuation verb is untouched', () => {
  for (const t of [
    'Send Barnaby the Lumen Verify signup steps.',
    'Chase Wilbur Ansley for confirmation of the DMS go-live date.',
    'Grant Petra Holloway admin access in the portal.',
  ]) assert.equal(notACommitment('I will send it over today.', t), null, t);
});

test('with no title the quote rules alone — the old call still behaves', () => {
  assert.equal(notACommitment('I will send the invoice today.'), null);
  assert.match(String(notACommitment('Step 1 — Pick a starting department.')), /numbered step/);
});
