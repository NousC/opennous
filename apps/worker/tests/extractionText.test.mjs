// What the extractor reads and how its facts are worded (signals/extractionText.mjs).
// Each test pins one failure from the GET-185 model comparison.
//
// Run: node --test apps/worker/tests/extractionText.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitForExtraction, loadSourceText, activityText, soleTeamSpeaker, ourSideLabel, ourSideRule, tidyFactContent, PART_CHARS,
} from '../src/signals/extractionText.mjs';
import { buildActivitySignalsPrompt, buildMeetingSignalsPrompt } from '../src/signals/index.mjs';

const line = (who, i) => `${who}: this is turn number ${i} of a long supplier call about delivery schedules and pricing.`;
const transcript = (n) => Array.from({ length: n }, (_, i) => line(i % 2 ? 'Ignatius Fernsby' : 'Theo Bramwell', i)).join('\n');

// ── 1. long meetings ─────────────────────────────────────────────────────────

test('short text is one part, unchanged — a DM or short call reads exactly as before', () => {
  const text = 'Hi Avery, saw your note in the Lantern Makers forum.';
  assert.deepEqual(splitForExtraction(text), { context: null, parts: [text] });
});

test('a long transcript is read in parts that cover all of it, cut on speaker turns', () => {
  const text = transcript(1400);                       // ~120,000 characters
  const { parts } = splitForExtraction(text);
  assert.ok(parts.length >= 5);
  assert.ok(parts.every(p => p.length <= PART_CHARS));
  assert.ok(parts.every(p => /^(Theo Bramwell|Ignatius Fernsby): /.test(p)), 'every part starts on a turn');
  assert.ok(parts.at(-1).includes('turn number 1399 '), 'the end of the call is read — the old cut lost it');
  assert.ok(parts[0].includes('turn number 0 '));
});

test('parts overlap, so a turn at a boundary is read whole at least once', () => {
  const text = transcript(1400);
  const { parts } = splitForExtraction(text);
  for (let i = 1; i < parts.length; i++) {
    const firstTurn = parts[i].split('\n')[0];
    assert.ok(parts[i - 1].includes(firstTurn), `part ${i} opens on a turn the previous part also holds`);
  }
});

test("a meeting-notes document's digest rides along as context on every part, never as a part", () => {
  const digest = 'Ignatius plans to move the pilot to 20 seats next quarter.';
  const doc = `${digest}\n\n———— Transcript ————\n\n${transcript(1400)}`;
  const { context, parts } = splitForExtraction(doc);
  assert.equal(context, digest);
  assert.ok(parts.every(p => !p.includes('———— Transcript ————') && !p.includes(digest)));
});

test('loadSourceText reads the full notes document for a meeting, not the 12,000-character summary', async () => {
  const full = `Overview\n\n———— Transcript ————\n\n${transcript(1100)}`;
  let filter;
  const supabase = {
    from: () => {
      const q = {
        select: () => q, like: () => q, is: () => q, limit: async () => ({ data: [{ value: { content: full } }, { value: { content: 'short' } }] }),
        eq: (col, val) => { if (col.startsWith('value->')) filter = val; return q; },
      };
      return q;
    },
  };
  const obs = {
    workspace_id: 'ws', property: 'interaction.meeting_held', source: 'fireflies',
    raw: { meeting_id: '01TESTMEETING00000000000001' }, value: { summary: transcript(1100).slice(0, 12_000) },
  };
  assert.equal(await loadSourceText(supabase, obs), full);
  assert.equal(filter, 'source://fireflies/01TESTMEETING00000000000001');
});

test('loadSourceText reads the longer of a message\'s summary and description', async () => {
  const noQuery = { from: () => { throw new Error('no query for a message'); } };
  const full = 'Hi Theo - I\'m Emrys, I look after partnerships at Quillmere. We are opening a second office this spring…';
  const obs = { property: 'interaction.linkedin_message', value: { summary: full.slice(0, 40), description: full } };
  assert.equal(await loadSourceText(noQuery, obs), full);
  assert.equal(await loadSourceText(noQuery, { property: 'interaction.email_received', value: { summary: 'Hi' } }), 'Hi');
});

test('a message is read at its fullest: raw text over description over the 200-character summary', () => {
  const full = 'Hi Theo - I\'m Odalys, Director at Wrenfield Harbour Capital. '.repeat(20);
  assert.equal(activityText({ summary: full.slice(0, 200), description: full.slice(0, 500), raw: { text: full } }), full);
  assert.equal(activityText({ summary: full.slice(0, 200), description: full.slice(0, 500) }), full.slice(0, 500));
});

test('an email subject is never read in place of a short reply', () => {
  assert.equal(activityText({ summary: 'Thanks, talk Friday!', description: 'Re: Networking Call between Theo Bramwell and Ignatius Fernsby' }), 'Thanks, talk Friday!');
  assert.equal(activityText({ description: 'Monthly Partner Review' }), 'Monthly Partner Review', 'no summary: the description is all there is');
});

test('the "You:" timeline prefix never reaches the model', () => {
  assert.equal(activityText({ summary: 'You: happy to share the deck' }), 'happy to share the deck');
});

test('a part of a long call tells the model which part it is and gives it the summary', () => {
  const { prompt } = buildActivitySignalsPrompt({
    contactName: 'Ignatius Fernsby', type: 'meeting_held', summary: 'Ignatius Fernsby: we pay $250 a month for Trellisdata.',
    part: { index: 1, total: 4, context: 'Supplier call about delivery.' },
  });
  assert.match(prompt, /part 2 of 4/);
  assert.match(prompt, /CALL SUMMARY \(context only/);
  assert.match(prompt, /Supplier call about delivery\./);
});

// ── 2. naming our side ───────────────────────────────────────────────────────

const theo = { ownerName: 'Theo Bramwell', teamNames: ['Theo Bramwell', 'Avery Castellan'], companyName: 'OpenNous' };
const team = { ownerName: null, teamNames: ['Theo Bramwell', 'Avery Castellan'], companyName: 'OpenNous' };

test('the prompt names the teammate instead of "the user"', () => {
  const { prompt } = buildActivitySignalsPrompt({ contactName: 'Sabeline Kroft', type: 'linkedin_message', summary: 'hi Avery', ourSide: theo });
  assert.match(prompt, /sent to Theo Bramwell/);
  assert.match(prompt, /name Theo Bramwell — never "the user", "us", "we", "our" or "you"/);
  assert.doesNotMatch(prompt, /the user \(us\)|you \(the user\)/);
});

test('with no owner, the prompt lists the team and falls back to the company', () => {
  assert.equal(ourSideLabel(team), 'the OpenNous team');
  assert.match(ourSideRule(team), /\(Theo Bramwell, Avery Castellan\)/);
  assert.match(ourSideRule(team), /otherwise write "the OpenNous team"/);
});

test('the multi-attendee meeting prompt carries the same two rules', () => {
  const prompt = buildMeetingSignalsPrompt({ roster: '1. Bertram Ollivane (Quayside)', transcript: 'x', maxFacts: 12, ourSide: theo });
  assert.match(prompt, /Our side of the call is Theo Bramwell/);
  assert.match(prompt, /never "the user"/);
  assert.match(prompt, /Never add your own reading of what it implies/);
});

test('an unstamped meeting finds our side from the one teammate who speaks', () => {
  assert.equal(soleTeamSpeaker(transcript(4), team.teamNames), 'Theo Bramwell');
  assert.equal(soleTeamSpeaker('Avery Castellan: hi\nTheo: hey\nJuno Ravelstad: hello', team.teamNames), null, 'two teammates → not guessed');
  assert.equal(soleTeamSpeaker('Juno Ravelstad: hello', team.teamNames), null);
});

test('"the user" in a fact becomes the teammate\'s name', () => {
  assert.equal(
    tidyFactContent("Sabeline Kroft found the user through a post in the Lantern Makers forum.", theo),
    'Sabeline Kroft found Theo Bramwell through a post in the Lantern Makers forum.');
  assert.equal(
    tidyFactContent("Thaddeus Moorcroft's company previously utilized the user's Inventory Audit service.", team),
    "Thaddeus Moorcroft's company previously utilized the OpenNous team's Inventory Audit service.");
});

// ── 3. no interpretation ─────────────────────────────────────────────────────

test('an interpretive clause is cut, the fact is kept', () => {
  assert.equal(
    tidyFactContent('Thaddeus Moorcroft offers himself and Wystan as references for the rollout, indicating a positive prior vendor relationship.'),
    'Thaddeus Moorcroft offers himself and Wystan as references for the rollout.');
  assert.equal(
    tidyFactContent('Cosimo Thistlewood runs the regional warehouse programme, as evidenced by the site visits he hosts.'),
    'Cosimo Thistlewood runs the regional warehouse programme.');
  assert.equal(
    tidyFactContent('Thaddeus Moorcroft said the team would have kept the add-on, meaning the downgrade was driven by budget.'),
    'Thaddeus Moorcroft said the team would have kept the add-on.');
});

test('what the contact actually said is never cut', () => {
  const keep = [
    'Juno Ravelstad strongly advised against the blue theme because it clashes with their print catalogue.',
    'Ottoline Brask believes delivery windows — shipping before the weekend — matter more than price.',
    'Leopold Ferrars suggested two changes to the returns form.',
  ];
  for (const k of keep) assert.equal(tidyFactContent(k, theo), k);
});
