// A company's facts need somewhere to live, and a meeting needs one row.
//
// Two gaps a real account surfaced. Quarrendon Nissan held dozens of facts on the company record. The
// page could show at most a handful of them — six deal fields in the sidebar, then three lists on
// Overview capped at 8, 6 and 6 — and there was no screen anywhere that showed the rest. A PERSON
// has had a category-grouped Intel tab since the beginning; a company never did.
//
// And its Activity feed showed "meeting held" five times for one September review: a four-person
// call is filed once per attendee, then mirrored by HubSpot with its own ids, so one conversation
// renders up to eight times under two icons.
//
// Run: node --test packages/core/test/companyIntelSurface.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const FE = join(here, '..', '..', '..', 'apps', 'frontend', 'src', 'components');
const COMPANY = readFileSync(join(FE, 'CompanyDetailView.tsx'), 'utf8');
const PARTS = readFileSync(join(FE, 'record', 'RecordParts.tsx'), 'utf8');

test('the company page has an Intel tab carrying every fact', () => {
  assert.match(COMPANY, /type Tab = [^;]*"intel"/, 'intel must be a tab');
  // Since GET-498 the count is the chips the tab shows — one per topic, plus any fact no topic
  // covers yet — computed over the full fact set, never a capped slice.
  assert.match(COMPANY, /id: "intel"[^}]*count: intelChips\(intel, /,
    'the tab count must be the chips shown over the FULL fact set, not a capped slice');
  assert.match(COMPANY, /tab === "intel" \? <CompanyIntelPanel/, 'the tab must render the panel');
});

test('the Intel panel caps nothing', () => {
  const panel = COMPANY.match(/function CompanyIntelPanel[\s\S]*?\n\}/);
  assert.ok(panel, 'could not find CompanyIntelPanel');
  assert.doesNotMatch(panel[0], /\.slice\(0,/,
    'the one screen that exists to show everything must not truncate');
});

test('an unknown category sorts to the tail instead of disappearing', () => {
  // The person page lost six categories this way: an allow-list that only held the taxonomy of
  // the day it was written. The `|| 99` fallback is what keeps a new category visible. The order
  // and the renderer moved to RecordParts (IntelGroups) in GET-404 so the deal page reads the
  // same way; the company panel renders through it.
  const order = PARTS.match(/INTEL_ORDER = \[[\s\S]*?\]/);
  assert.ok(order, 'could not find INTEL_ORDER');
  for (const cat of ['firmographic', 'performance', 'adoption', 'proficiency', 'seasonality', 'staff_change', 'risk_signal', 'expansion_signal']) {
    assert.match(order[0], new RegExp(`"${cat}"`), `${cat} must have a place in the reading order`);
  }
  assert.match(PARTS, /\|\| 99\)/, 'an unlisted category must sort to the tail, not vanish');
  assert.match(COMPANY, /<IntelGroups /, 'the company panel must render through the shared IntelGroups');
  // `general` is the leftovers drawer and belongs last wherever it appears.
  const keys = [...order[0].matchAll(/"([a-z_]+)"/g)].map(m => m[1]);
  assert.equal(keys[keys.length - 1], 'general', '`general` must sort last');
});

// The shipped expression, with its TypeScript annotations removed so it can be evaluated. The
// point is to test the code that actually runs rather than a copy that can drift from it.
const loadMeetingKey = () => {
  const src = PARTS.match(/export const meetingKey =([\s\S]*?);\n\n/);
  assert.ok(src, 'could not find meetingKey');
  const js = src[1].trim().replace(/\(\s*a\s*:\s*any\s*\)\s*:\s*string\s*\|\s*null\s*=>/, '(a) =>');
  return new Function('a', `return (${js})(a);`);
};

test('one meeting is one row, across attendees and across sources', () => {
  assert.match(PARTS, /const key = meetingKey\(a\)/, 'the feed must use it before the id keys');
  const meetingKey = loadMeetingKey();

  const fellow = { activity_type: 'meeting_held', occurred_at: '2026-09-16T17:00:00Z', subject: 'Meeting: Quarrendon Nissan | review with Harborline.example' };
  const hubspot = { activity_type: 'meeting_held', occurred_at: '2026-09-16T17:02:00Z', subject: 'Quarrendon Nissan | review with Harborline.example' };
  assert.equal(meetingKey(fellow), meetingKey(hubspot),
    'the same call from two sources, two minutes apart, must collapse to one row');

  const other = { activity_type: 'meeting_held', occurred_at: '2026-09-16T17:00:00Z', subject: 'Tallowmere GM | Review' };
  assert.notEqual(meetingKey(fellow), meetingKey(other), 'different meetings at the same time stay separate');

  const later = { activity_type: 'meeting_held', occurred_at: '2026-09-16T19:00:00Z', subject: 'Meeting: Quarrendon Nissan | review with Harborline.example' };
  assert.notEqual(meetingKey(fellow), meetingKey(later), 'a recurring meeting on the same day stays separate');
});

test('non-meetings and undated meetings keep their own rows', () => {
  const meetingKey = loadMeetingKey();
  assert.equal(meetingKey({ activity_type: 'email_sent', occurred_at: '2026-09-16T17:00:00Z' }), null,
    'an email must fall through to the message-id key');
  assert.equal(meetingKey({ activity_type: 'meeting_held', occurred_at: null }), null,
    'losing a real conversation to tidy a feed is the wrong trade');
  assert.equal(meetingKey({}), null);
});
