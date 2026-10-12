import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  meetingIdentity, groupMeetings, cleanMeetingText, meetingKind, skipReason, mergeTarget,
  isSameMeetingAsCard, dedupeSameMeeting, parseFollowUpAnswer, isWorthACard, buildFollowUpPrompt,
  pickRecipients, dedupeAcrossSources, hasMeetingNotes, MIN_MEETING_TEXT,
} from '../dist/services/followUps.js';

const now = Date.parse('2026-10-02T18:00:00Z');
const hs = (id, entity, at, body = '') => ({
  id: `o-${entity}`, entity_id: entity, property: 'interaction.meeting_scheduled', source: 'hubspot',
  observed_at: at, external_id: `hubspot_meetings_${id}_${entity}`, raw: { body, title: 'Demo with Quillmere' },
});

// The invite Harborline's HubSpot meetings actually carry (2026-10-02 probe), as HTML.
const TEAMS_INVITE = `Description<br>________________________________________________________________________________<br>
Microsoft Teams meeting<br>Join: https://teams.microsoft.com/meet/000000000000000?p=EXAMPLEp4ssc0de<br>
Meeting ID: 000 000 000 000 000<br>Passcode: Ab1Cd2Ef<br>________________________________<br>
Need help? | System reference<br>Dial in by phone<br>+1 555-010-0199,,000012345# United States, Denver<br>
Find a local number<br>Phone conference ID: 000 012 345#<br>For organizers: Meeting options | Reset dial-in PIN`;

test('a HubSpot meeting stored once per attendee is one meeting', () => {
  const rows = [hs('510000000042', 'a', '2026-10-01T15:00:00Z'), hs('510000000042', 'b', '2026-10-01T15:00:00Z', 'longer body text here'), hs('510000000042', 'c', '2026-10-01T15:00:00Z')];
  assert.equal(meetingIdentity(rows[0]).key, 'hubspot:510000000042');
  const g = groupMeetings(rows);
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].entityIds.sort(), ['a', 'b', 'c']);
  assert.equal(g[0].rawText, 'longer body text here', 'keeps the richest body');
});

test('a Fellow meeting is its note; anything else falls back to its own id', () => {
  const f = { id: 'o1', entity_id: 'x', property: 'interaction.meeting_held', source: 'fellow', observed_at: '2026-10-01T15:00:00Z', raw: { note_id: 'n-9' } };
  assert.deepEqual(meetingIdentity(f), { key: 'fellow:n-9', fellowNoteId: 'n-9' });
  const other = { id: 'o2', entity_id: 'x', property: 'interaction.meeting_held', source: 'fireflies', observed_at: '2026-10-01T15:00:00Z', external_id: 'ff-1' };
  assert.equal(meetingIdentity(other).key, 'fireflies:ff-1');
});

test('a calendar invite is not notes: the Teams invite cleans to nothing', () => {
  assert.equal(cleanMeetingText(TEAMS_INVITE), '');
});

test('real notes survive the invite being stripped', () => {
  const notes = `${TEAMS_INVITE}<br><p>Hollis confirmed Q4 budget and wants pricing for all three rooftops.</p><p>Marit is worried the DMS integration needs IT time.</p>`;
  const out = cleanMeetingText(notes);
  assert.match(out, /Hollis confirmed Q4 budget/);
  assert.match(out, /DMS integration/);
  assert.doesNotMatch(out, /teams\.microsoft|Passcode|Meeting ID/i);
});

test('meeting kind from the title', () => {
  assert.equal(meetingKind('Product Demo - Thistlecombe Mazda'), 'Demo');
  assert.equal(meetingKind('Quarterly business review'), 'Check-in');
  assert.equal(meetingKind('Kickoff and training'), 'Onboarding');
  assert.equal(meetingKind(null), 'Meeting');
});

test('which meetings get a card', () => {
  const since = now - 48 * 3_600_000;
  const text = 'x'.repeat(MIN_MEETING_TEXT);
  assert.equal(skipReason({ at: new Date(now - 10 * 60_000).toISOString() }, text, { now, since }), 'not over yet');
  assert.equal(skipReason({ at: new Date(now - 72 * 3_600_000).toISOString() }, text, { now, since }), 'older than the window');
  assert.equal(skipReason({ at: new Date(now - 3 * 3_600_000).toISOString() }, 'short', { now, since }), 'no real notes (invite or empty)');
  assert.equal(skipReason({ at: new Date(now - 3 * 3_600_000).toISOString() }, text, { now, since }), null);
});

const card = (over) => ({
  id: 'c1', account_entity_id: 'acct', status: 'ready', meeting_keys: ['fellow:1'],
  meetings: [{ key: 'fellow:1', source: 'fellow', kind: 'Demo', title: 'Demo', at: '2026-09-30T15:00:00Z' }],
  content: { summary: '', tasks: [], updates: [], email: null, attribution: null, deal_change: null },
  updated_at: '2026-09-30T16:00:00Z', ...over,
});

test('merge: the newest open card on the same account, if recent', () => {
  const cards = [card({ id: 'old', updated_at: '2026-09-01T00:00:00Z' }), card({ id: 'new' }), card({ id: 'skipped', status: 'skipped', updated_at: '2026-10-01T00:00:00Z' }), card({ id: 'other', account_entity_id: 'zzz' })];
  assert.equal(mergeTarget(cards, 'acct', now)?.id, 'new');
  assert.equal(mergeTarget([card({ updated_at: '2026-09-01T00:00:00Z' })], 'acct', now), null, 'older than 14 days does not merge');
  assert.equal(mergeTarget([card({ status: 'approved' })], 'acct', now), null, 'a reviewed card does not take new meetings');
});

test('the same meeting from Fellow and HubSpot is one meeting', () => {
  assert.equal(isSameMeetingAsCard(card(), '2026-09-30T15:45:00Z'), true);
  assert.equal(isSameMeetingAsCard(card(), '2026-09-30T18:00:00Z'), false);
  const kept = dedupeSameMeeting([
    { at: '2026-10-01T15:00:00Z', textLength: 80, id: 'hubspot' },
    { at: '2026-10-01T15:20:00Z', textLength: 40000, id: 'fellow' },
    { at: '2026-10-01T19:00:00Z', textLength: 900, id: 'later' },
  ]);
  assert.deepEqual(kept.map((k) => k.id), ['fellow', 'later']);
});

test('parse: tasks, updates, email to the attendees, attribution across two deals, no stage change unless clear', () => {
  const answer = `Here you go:\n${JSON.stringify({
    summary: 'Strong demo; GM wants pricing for 3 rooftops.',
    tasks: [{ text: 'Send pricing for 3 rooftops', due_phrase: 'Friday', quote: 'send me pricing by Friday', stated_by: 'them', owed_by: null },
            { text: 'Send the security one-pager', due_phrase: null, quote: null, stated_by: 'us' }],
    keep_previous: [], drop_previous: [],
    updates: [{ label: 'Budget', value: 'Q4 budget approved', quote: 'budget is approved', speaker: 'Hollis' }],
    email: { subject: 'Pricing for your 3 rooftops', body: 'Hi Hollis, thanks for today...' },
    stage_change: { should_move: false, reason: null },
    insights: [{ category: 'budget', text: 'Q4 budget approved', quote: 'budget is approved' }],
  })}`;
  const deals = [{ id: 'd1', name: 'Growth', value: 12000, stage: 'Demo completed' }, { id: 'd2', name: 'Used desk', value: 5000, stage: 'Demo booked' }];
  const c = parseFollowUpAnswer(answer, { existingTasks: ['Send the security one-pager'], openDeals: deals, recipients: ['hollis@northvale.example'] });
  assert.ok(c);
  assert.equal(c.tasks.filter((t) => t.existing).length, 1, 'the filed task shows as existing');
  assert.deepEqual(c.tasks.filter((t) => !t.existing).map((t) => t.text), ['Send pricing for 3 rooftops'], 'a task already on the list is not proposed again');
  assert.equal(c.updates[0].label, 'Budget');
  assert.deepEqual(c.email.to, ['hollis@northvale.example']);
  assert.equal(c.attribution.options.length, 2);
  assert.equal(c.attribution.chosen, null);
  assert.equal(c.deal_change, null);
  assert.equal(isWorthACard(c), true);
});

test('parse a merge: earlier tasks the new call made moot are kept, struck through, with the reason', () => {
  const previous = { summary: 'Demo', tasks: [{ id: 't1', text: 'Send pricing for 1 rooftop', due: null, on: true }, { id: 't2', text: 'Book IT call', due: null, on: true }], updates: [], email: null, attribution: null, deal_change: null };
  const answer = JSON.stringify({
    summary: 'Second call: they want 3 rooftops.', tasks: [{ text: 'Send pricing for 3 rooftops', stated_by: 'us' }],
    keep_previous: ['t2'], drop_previous: [{ id: 't1', reason: 'replaced by: send the 3-rooftop quote' }],
    updates: [], email: { subject: 'Next steps', body: 'Hi Hollis...' }, stage_change: { should_move: true, reason: 'They asked for a proposal' }, insights: [],
  });
  const c = parseFollowUpAnswer(answer, { previous, openDeals: [{ id: 'd1', name: 'Growth', value: 12000, stage: 'Demo completed' }] });
  const byText = Object.fromEntries(c.tasks.map((t) => [t.text, t]));
  assert.equal(byText['Send pricing for 1 rooftop'].dropped, 'replaced by: send the 3-rooftop quote');
  assert.equal(byText['Send pricing for 1 rooftop'].on, false);
  assert.equal(byText['Book IT call'].dropped, null);
  assert.equal(byText['Send pricing for 3 rooftops'].on, true);
  assert.equal(new Set(c.tasks.map((t) => t.id)).size, c.tasks.length, 'ids stay unique across a merge');
  assert.deepEqual(c.deal_change, { reason: 'They asked for a proposal', deal_id: 'd1' }, 'a flag on the one open deal, never an action');
});

test('an unreadable answer is no card, and an empty one is not worth showing', () => {
  assert.equal(parseFollowUpAnswer('sorry, I cannot'), null);
  const empty = parseFollowUpAnswer(JSON.stringify({ summary: 'internal sync', tasks: [], updates: [], email: null }));
  assert.equal(isWorthACard(empty), false);
});

test('the model can say there is nothing to follow up on, and the card is dropped', () => {
  const c = parseFollowUpAnswer(JSON.stringify({ worth_following_up: false, summary: 'Audio trouble; substance unclear.', tasks: [], updates: [{ label: 'Note', value: 'Technical difficulties' }], email: { subject: 'x', body: 'Thanks for your time' } }));
  assert.equal(isWorthACard(c), false);
});

test('recipients: the account’s own people first, one address per person, at most four', () => {
  assert.deepEqual(
    pickRecipients(['piers@harrow-ag.example', 'fin1@osterfieldmitsu.example', 'GSM@osterfieldmitsu.example', 'spmgr2@osterfieldmitsu.test', 'gm@osterfieldmitsu.example', 'fin1@osterfieldmitsu.test'], 'osterfieldmitsu.example'),
    ['fin1@osterfieldmitsu.example', 'gsm@osterfieldmitsu.example', 'spmgr2@osterfieldmitsu.test', 'gm@osterfieldmitsu.example'],
  );
  assert.deepEqual(pickRecipients(['guy@rock.example', 'guy@rock.test'], 'rockinsurancebrokers.example'), ['guy@rock.example'], 'no domain match: everyone outside, one per person');
});

test('a meeting is over by its END time; no-shows and cancellations get no card', () => {
  const since = now - 48 * 3_600_000;
  const text = 'x'.repeat(MIN_MEETING_TEXT);
  const bookedYesterday = new Date(now - 20 * 3_600_000).toISOString();
  assert.equal(skipReason({ at: bookedYesterday, endsAt: new Date(now + 3 * 86_400_000).toISOString() }, text, { now, since }), 'not over yet', 'booked yesterday, happens next week');
  assert.equal(skipReason({ at: bookedYesterday, endsAt: new Date(now - 3_600_000).toISOString() }, text, { now, since }), null);
  assert.equal(skipReason({ at: bookedYesterday, outcome: 'NO_SHOW' }, text, { now, since }), 'no-show or cancelled');
  assert.equal(skipReason({ at: bookedYesterday, outcome: 'CANCELED' }, text, { now, since }), 'no-show or cancelled');
  const g = groupMeetings([{ ...hs('9', 'a', bookedYesterday), raw: { end_time: '2026-10-05T16:00:00Z', outcome: 'SCHEDULED', body: '' } }]);
  assert.equal(g[0].endsAt, '2026-10-05T16:00:00Z');
  assert.equal(g[0].outcome, 'SCHEDULED');
});

test('one meeting recorded by Fellow and HubSpot under two accounts is one meeting (shared customer, 90 minutes)', () => {
  const kept = dedupeAcrossSources([
    { id: 'hubspot-pemberly', at: '2026-09-30T17:00:00Z', textLength: 900, attendeeEmails: ['imelda.b@pemberly-rv.example'] },
    { id: 'fellow-fallowmere', at: '2026-09-30T17:10:00Z', textLength: 41000, attendeeEmails: ['imelda@fallowmere.example', 'imelda.b@pemberly-rv.example'] },
    { id: 'other-meeting', at: '2026-09-30T17:05:00Z', textLength: 2000, attendeeEmails: ['someone@else.example'] },
  ]);
  assert.deepEqual(kept.map((k) => k.id).sort(), ['fellow-fallowmere', 'other-meeting']);
});

test('a HubSpot meeting still "scheduled" with only the invitation in it gets no card', () => {
  const since = now - 48 * 3_600_000;
  const at = new Date(now - 20 * 3_600_000).toISOString();
  const invite = 'Hi Marigold, Microsoft Teams meeting Join: https://teams.microsoft.com/meet/245 Really appreciate you taking the time to book a demo with Harborline.example. Looking forward to connecting and walking you through the platform. '.repeat(2);
  assert.equal(hasMeetingNotes(invite), false);
  assert.equal(skipReason({ at, source: 'hubspot', outcome: 'SCHEDULED', hasNotes: false }, 'x'.repeat(400), { now, since }), 'only the invitation, no notes');
  assert.equal(hasMeetingNotes('📆 This meeting has notes on Fellow — Next steps: send pricing'), true);
  assert.equal(skipReason({ at, source: 'hubspot', outcome: 'SCHEDULED', hasNotes: true }, 'x'.repeat(400), { now, since }), null);
  assert.equal(skipReason({ at, source: 'hubspot', outcome: 'COMPLETED', hasNotes: false }, 'x'.repeat(400), { now, since }), null, 'a completed meeting is judged by its text');
});

test('the same host starting within 20 minutes is the same meeting, whatever contacts each tool used', () => {
  const kept = dedupeAcrossSources([
    { id: 'hubspot', at: '2026-09-30T17:01:32Z', textLength: 900, attendeeEmails: ['imelda.b@pemberly-rv.example'], hostEmail: 'tamsin@harborline.example' },
    { id: 'fellow', at: '2026-09-30T17:00:00Z', textLength: 41000, attendeeEmails: ['imelda@fallowmere.example'], hostEmail: 'TAMSIN@harborline.example' },
    { id: 'tamsin-later', at: '2026-09-30T18:00:00Z', textLength: 3000, attendeeEmails: ['otto@quarrybank.example'], hostEmail: 'tamsin@harborline.example' },
  ]);
  assert.deepEqual(kept.map((k) => k.id).sort(), ['fellow', 'tamsin-later']);
});

test('the brief carries the deals, the tasks already filed and the earlier card', () => {
  const { user } = buildFollowUpPrompt({
    ourCompany: 'Harborline', repName: 'Ansel Okafor', account: { name: 'Northvale Hyundai', domain: 'northvale.example', isCustomer: false },
    deals: [{ id: 'd1', name: 'Growth', stage: 'Demo completed', value: 12000, close_date: '2026-10-24' }],
    meetings: [{ kind: 'Demo', title: 'Demo', at: '2026-10-01T15:00:00Z', text: 'notes' }],
    existingTasks: ['Send the deck'], previous: { tasks: [{ id: 't1', text: 'Book IT call' }], summary: 'x' },
  });
  assert.match(user, /Growth · stage Demo completed/);
  assert.match(user, /- Send the deck/);
  assert.match(user, /\[t1\] Book IT call/);
  assert.match(user, /signed by Ansel Okafor/);
});
