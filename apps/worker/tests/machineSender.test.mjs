// A machine is a machine whatever its local part says (GET-329).
//
// isBulkEmail's header checks decide this correctly for live Gmail, and NOREPLY_RE catches the
// obvious local parts. Neither fires on CRM-IMPORTED mail: HubSpot stores from/to/subject/body and
// no headers at all, and a ticket tracker like `jira@examplecorp.atlassian.net` is often the loudest
// machine in such a corpus — not a no-reply, not a notification, not a digest by name, and a great
// many inbound rows we would have paid to mine facts out of.
//
// The two reasons are kept apart deliberately. A flat blocklist reads as arbitrary, and the next
// person to look at a pile of call-relay rows talks themselves into letting them back in.
//
// Run: node --test apps/worker/tests/machineSender.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBulkEmail, machineSenderReason, isRoleInbox } from '../src/utils/emailIdentity.mjs';
import { selectBackfillUnits } from '../src/backfillExtraction.mjs';

const noHeaders = null;   // what a CRM-imported row has

test('the case the regex misses — jira@ is a machine and nothing in its name says so', () => {
  assert.equal(machineSenderReason('jira@examplecorp.atlassian.net'), 'machine');
  assert.equal(isBulkEmail(noHeaders, 'jira@examplecorp.atlassian.net'), true);
});

test('suffix matching covers every tenant, so one line serves the next client too', () => {
  assert.equal(machineSenderReason('jira@examplecorp.atlassian.net'), 'machine');
  assert.equal(machineSenderReason('jira@someoneelse.atlassian.net'), 'machine');
  assert.equal(machineSenderReason('x@atlassian.net'), 'machine');
  assert.equal(machineSenderReason('bot@examplecorp.intercom-mail.com'), 'relay');
});

test('a suffix is a domain boundary, never a substring', () => {
  // The failure this prevents: `notatlassian.net` or `evil-atlassian.net.com` reading as ours.
  assert.equal(machineSenderReason('a@notatlassian.net'), null);
  assert.equal(machineSenderReason('a@atlassian.net.example.com'), null);
});

test('relay and machine are different reasons, and stay different', () => {
  // A relay is a HUMAN conversation owned by another integration — the email is a worse copy.
  assert.equal(machineSenderReason('no-reply@fellow.app'), 'relay');
  assert.equal(machineSenderReason('notify@ringcentral.com'), 'relay');
  assert.equal(machineSenderReason('alerts@justcall.io'), 'relay');
  // A machine has no human voice at any point.
  assert.equal(machineSenderReason('hr@app.bamboohr.com'), 'machine');
  assert.equal(machineSenderReason('drafts@fyxer.com'), 'machine');
});

test('real people are untouched, including on free mail', () => {
  for (const a of ['rowan@harborline.example', 'marisol@tidewell.example', 'test.user.0005@gmail.com']) {
    assert.equal(machineSenderReason(a), null, a);
    assert.equal(isBulkEmail(noHeaders, a), false, a);
  }
});

test('a mixed domain is NOT a machine domain — this is the trap', () => {
  // servicehub.example sends a thousand-odd rows from support@ and also has named people on it. Blocking the
  // domain would delete real conversations, so the domain list must not contain it.
  assert.equal(machineSenderReason('support@servicehub.example'), null);
  assert.equal(machineSenderReason('marlo.trevane@servicehub.example'), null);
  assert.equal(isBulkEmail(noHeaders, 'marlo.trevane@servicehub.example'), false);
});

test('role inboxes are their own question, not folded into bulk', () => {
  assert.equal(isRoleInbox('support@servicehub.example'), true);
  assert.equal(isRoleInbox('thirdpartysupport@agency.example'), true);
  assert.equal(isRoleInbox('d2c-service-support@vendor.example'), true);
  assert.equal(isRoleInbox('marlo.trevane@servicehub.example'), false);

  // ...and a role inbox is NOT bulk. It is a person at a desk nobody owns.
  assert.equal(isBulkEmail(noHeaders, 'support@servicehub.example'), false);
});

test('missing and malformed senders do not throw', () => {
  for (const a of [null, undefined, '', 'not-an-address', '@nolocal.example', 'nodomain@']) {
    assert.equal(machineSenderReason(a), null, String(a));
    assert.doesNotThrow(() => isRoleInbox(a));
  }
});

// ── the second caller ────────────────────────────────────────────────────────
// "Both callers use the one predicate" is the point of the issue. The live path has suppressed
// these since GET-245; the backfill never has.

const obs = (id, from, extra = {}) => ({
  id, entity_id: 'ext-1', property: 'interaction.email_received', source: 'hubspot',
  value: { summary: 'x'.repeat(200) },
  raw: { from, text: 'They confirmed the pilot starts on the 15th and asked for pricing.', ...extra },
});

test('the backfill skips machines, and says which reason', () => {
  const { units, skipped } = selectBackfillUnits({
    observations: [
      obs('a', 'jira@examplecorp.atlassian.net'),
      obs('b', 'no-reply@fellow.app'),
      obs('c', 'marisol@tidewell.example'),
    ],
    extractedIds: new Set(),
    externalIds: new Set(['ext-1']),
  });

  assert.equal(units.length, 1, 'only the human is work');
  assert.equal(units[0].obs.id, 'c');
  assert.equal(skipped['machine sender'], 1);
  assert.equal(skipped['relayed from a source we already hold'], 1);
});

test('a row the live path already flagged is trusted without re-deriving it', () => {
  // Live ingest stamps `bulk` from the RFC headers, which see things a sender never will
  // (List-Unsubscribe, Precedence). Re-deriving from the address would throw that away.
  const { units, skipped } = selectBackfillUnits({
    observations: [obs('d', 'campaign@somevendor.example', { bulk: true })],
    extractedIds: new Set(),
    externalIds: new Set(['ext-1']),
  });
  assert.equal(units.length, 0);
  assert.equal(skipped['machine sender'], 1);
});
