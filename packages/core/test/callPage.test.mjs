// Call pages (GET-236): one review pass → the scorecard and the page in Pages.
//
// What this pins down: scores are 1–10; a call the model does not call "sales" gets no scores;
// the page lays out Summary → Transcript → Sales call score → Went well → Improve, with no raw
// transcript on it; Coaching ignores scorecards graded against another rubric; and a re-analysed
// call versions under its own series, never another call's.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/callPage.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCallScoreJson, computeOverall, summarizeScorecards, buildCallScorePrompt,
} from '../dist/services/callScoring.js';
import { callPageSections, callPageSeries, callSourceLabel } from '../dist/services/callPage.js';
import { defaultRubric, validateRubric } from '../dist/db/coachingRubric.js';
import { callScoreFromStored } from '../dist/db/callScorecards.js';

const rubric = defaultRubric();

const salesAnswer = JSON.stringify({
  call_type: 'sales',
  summary: 'Corin runs a 12-person logistics firm and tracks orders in spreadsheets.',
  verdict: 'Strong discovery, soft close.',
  went_well: ['The question that made Corin name his own reason to buy.', 'Clear answers on data security.'],
  improve: ['Put a number on "a lot of time saved".', 'Lock the Friday slot.'],
  next_step_secured: false,
  dimensions: [
    { key: 'discovery', score: 8, note: 'Dug for specifics ("Can you be more precise with that?").', moment: 'Can you be more precise with that?' },
    { key: 'rapport', score: 8, note: 'Peer energy.', moment: '' },
    { key: 'objection_handling', score: 7.4, note: 'Handled the price question.', moment: '' },
    { key: 'demo', score: 7, note: 'Tailored to his workflow.', moment: '' },
    { key: 'close', score: 7, note: 'Placeholder Friday, never firmly accepted.', moment: '' },
    { key: 'talk_listen', score: 6, note: 'Two tangents.', moment: '' },
  ],
});

test('the default rubric is the six ruled categories and its weights sum to 100', () => {
  assert.deepEqual(rubric.dimensions.map(d => d.key), ['discovery', 'rapport', 'objection_handling', 'demo', 'close', 'talk_listen']);
  assert.equal(validateRubric(rubric.dimensions), null);
});

test('a sales call parses onto the 1–10 scale with a weighted overall to one decimal', () => {
  const s = parseCallScoreJson(salesAnswer, rubric);
  assert.equal(s.call_type, 'sales');
  assert.equal(s.scores.find(d => d.key === 'objection_handling').score, 7);
  // 8*25 + 8*10 + 7*20 + 7*15 + 7*20 + 6*10 = 725 → 7.25 → 7.3
  assert.equal(s.overall, 7.3);
  assert.equal(computeOverall(s.scores), 7.3);
  assert.ok(s.summary.startsWith('Corin runs'));
});

test('scores are clamped to 1–10, and a missing one reads as 0 (a failed parse)', () => {
  const s = parseCallScoreJson(JSON.stringify({ call_type: 'sales', dimensions: [{ key: 'discovery', score: 42 }, { key: 'rapport', score: -3 }] }), rubric);
  assert.equal(s.scores.find(d => d.key === 'discovery').score, 10);
  assert.equal(s.scores.find(d => d.key === 'rapport').score, 0);
  assert.equal(s.scores.find(d => d.key === 'demo').score, 0);
});

test('an internal or other call comes back typed, with no scores', () => {
  for (const t of ['internal', 'other']) {
    const s = parseCallScoreJson(`Here you go: {"call_type":"${t}"}`, rubric);
    assert.equal(s.call_type, t);
    assert.deepEqual(s.scores, []);
  }
});

test('the prompt asks for the 1–10 scale and the page text', () => {
  const p = buildCallScorePrompt(rubric, 'Rep: hello');
  assert.match(p, /integer 1–10/);
  assert.match(p, /"call_type"/);
  assert.match(p, /went_well/);
  assert.doesNotMatch(p, /WHO WAS ON THE CALL/);
});

test('the prompt names the people from our records and carries the measured talk time', () => {
  const p = buildCallScorePrompt(rubric, 'Theo Bramwell: hello\nThem: hi', {
    rep: { name: 'Theo Bramwell', email: 'theo@example.com' },
    people: [
      { name: 'Theo Bramwell', email: 'theo@example.com' },
      { name: 'Rowan Achterberg', email: 'rowan@harborline.example', company: 'Harborline' },
      { email: 'wren@harborline.example', company: 'Harborline' },
    ],
    repTalkShare: 0.347,
  });
  assert.match(p, /Our team \(the sellers\):\n- Theo Bramwell <theo@example.com> \(recorded it\)/);
  assert.match(p, /The buyer side:\n- Rowan Achterberg <rowan@harborline.example>, Harborline\n- wren@harborline.example, Harborline/);
  assert.equal((p.match(/Theo Bramwell <theo@example.com>/g) ?? []).length, 1, 'the rep is listed once');
  assert.match(p, /never give anyone a job title/);
  assert.match(p, /carried 35% of the speaking time\. Grade Talk \/ listen on this number/);
  assert.doesNotMatch(p, /GRADE THE TEAM/, 'one seller is not a team');
});

test('two teammates on a call: the review is told who sells and grades the team', () => {
  const p = buildCallScorePrompt(rubric, 'Theo Bramwell: hi\nThem: hello', {
    people: [
      { name: 'Theo Bramwell', email: 'theo@fernpoint.example', side: 'team', host: true, recorder: true },
      { name: 'Avery Castellan', email: 'avery@fernpoint.example', company: 'Quorra Labs', side: 'team' },
      { name: 'Rowan Achterberg', email: 'rowan@harborline.example', company: 'Harborline', side: 'buyer' },
    ],
    repTalkShare: 0.29,
  });
  assert.match(p, /Our team \(the sellers\):\n- Theo Bramwell <theo@fernpoint.example> \(set up the meeting, recorded it\)\n- Avery Castellan <avery@fernpoint.example>\n/);
  assert.doesNotMatch(p, /Quorra Labs/, "a teammate is not shown under another company's name");
  assert.match(p, /The buyer side:\n- Rowan Achterberg <rowan@harborline.example>, Harborline/);
  assert.match(p, /GRADE THE TEAM, NOT ONE PERSON\. 2 people from our team/);
  assert.match(p, /"Them:" are everyone else on the call, which includes the other teammates/);
  assert.match(p, /carried 29% of the speaking time\. The other teammates speak on the "Them" audio/);
});

test('went well / improve given as one string still read as text', () => {
  const s = parseCallScoreJson(JSON.stringify({ call_type: 'sales', went_well: 'One thing.', improve: '- Another.' }), rubric);
  assert.equal(s.went_well, 'One thing.');
  assert.equal(s.improve, 'Another.');
});

test('the page reads Summary → Transcript → Sales call score → Went well → Improve, without the transcript text', () => {
  const s = parseCallScoreJson(salesAnswer, rubric);
  const sections = callPageSections(s, { title: 'Corin x OpenNous', source: 'granola', url: 'https://notes.granola.ai/d/abc' });
  assert.deepEqual(sections.map(x => x.label), ['Summary', 'Transcript', 'Sales call score', 'Went well', 'Improve']);
  assert.equal(sections[1].body, '[![Granola](/provider-logos/granola.svg) Open the call in Granola](https://notes.granola.ai/d/abc)');
  assert.equal(sections[3].body, '- The question that made Corin name his own reason to buy.\n- Clear answers on data security.');
  assert.equal(sections[4].body, '- Put a number on "a lot of time saved".\n- Lock the Friday slot.');
  const score = sections[2].body;
  assert.match(score, /^\*\*Overall 7\.3\/10\.\*\* Strong discovery, soft close\./);
  assert.match(score, /\*\*Discovery 8\/10:\*\* Dug for specifics/);
  assert.match(score, /\*\*Close & next steps 7\/10:\*\*/);
  assert.match(score, /\*\*Next step secured:\*\* no/);
});

test('the transcript section names the host and team and links every recording', () => {
  const s = parseCallScoreJson(salesAnswer, rubric);
  const sections = callPageSections(s, {
    title: 'Harborline x OpenNous', source: 'granola', host: 'Theo Bramwell', team: ['Theo Bramwell', 'Avery Castellan'],
    recordings: [
      { source: 'granola', url: 'https://notes.granola.ai/d/abc', meeting_id: 'not_1' },
      { source: 'fireflies', url: 'https://app.fireflies.ai/view/xyz', meeting_id: '01M' },
    ],
  });
  assert.equal(sections[1].body, [
    'Hosted by **Theo Bramwell** with Avery Castellan',
    '[![Granola](/provider-logos/granola.svg) Open the call in Granola](https://notes.granola.ai/d/abc)',
    '[![Fireflies](/provider-logos/fireflies.svg) Open the call in Fireflies](https://app.fireflies.ai/view/xyz)',
  ].join('\n\n'));
});

test('a stored review lays the page out again with no model call', () => {
  const s = parseCallScoreJson(salesAnswer, rubric);
  const back = callScoreFromStored({
    meeting_id: 'not_1', source: 'granola', entity_id: null, rep_user_id: null, rubric_role: 'default', rubric_version: 1,
    overall: '7.3', scores: s.scores, next_step_secured: false, occurred_at: '2026-09-14T16:50:00Z',
    call_type: 'sales', summary: s.summary, verdict: s.verdict, went_well: s.went_well, improve: s.improve,
    document_id: null, team_user_ids: [], recordings: [],
  });
  assert.equal(back.overall, 7.3);
  assert.deepEqual(callPageSections(back, { title: 'x', source: 'granola' }).map(x => x.body), callPageSections(s, { title: 'x', source: 'granola' }).map(x => x.body));
});

test('with no link the transcript section says where the transcript is kept', () => {
  const s = parseCallScoreJson(salesAnswer, rubric);
  const sections = callPageSections(s, { title: 'Call', source: 'fireflies', url: null });
  assert.match(sections[1].body, /Fireflies is saved with this call's meeting notes/);
});

test('a call versions under its own series', () => {
  assert.equal(callPageSeries('Granola', 'not_1'), 'call:granola:not_1');
  assert.notEqual(callPageSeries('granola', 'not_1'), callPageSeries('granola', 'not_2'));
  assert.equal(callSourceLabel('fathom'), 'Fathom');
});

test('Coaching counts only scorecards graded against the current rubric', () => {
  const current = parseCallScoreJson(salesAnswer, rubric);
  const rows = [
    { meeting_id: 'new', entity_id: null, overall: current.overall, next_step_secured: false, occurred_at: '2026-09-14T10:00:00Z', scores: current.scores, document_id: 'doc-1' },
    { meeting_id: 'old', entity_id: null, overall: 0, next_step_secured: false, occurred_at: '2026-09-01T10:00:00Z',
      scores: [{ key: 'discovery_depth', label: 'Discovery depth', weight: 25, score: 0, note: '', moment: '' }] },
  ];
  const sum = summarizeScorecards(rows, rubric);
  assert.equal(sum.count, 1);
  assert.equal(sum.overall_avg, 7.3);
  assert.equal(sum.dims.find(d => d.key === 'discovery').avg, 8);
  assert.equal(sum.recent_calls[0].document_id, 'doc-1');
});

test('a call page is titled with what it is, the call name and the day', async () => {
  const { callPageTitle } = await import('../dist/services/callPage.js');
  assert.equal(callPageTitle('Harborline.example x OpenNous', '2026-09-14T16:50:14.828Z'), 'Call summary — Harborline.example x OpenNous — Sep 14, 2026');
  assert.equal(callPageTitle('', null), 'Call summary — Call');
});

test('talk share is measured per named speaker, team against buyer', async () => {
  const { talkShareFromTranscript } = await import('../dist/services/callScoring.js');
  const lines = [];
  for (let i = 0; i < 6; i++) {
    lines.push('Avery Castellan: ' + 'word '.repeat(20).trim());
    lines.push('Rowan Achterberg: ' + 'word '.repeat(10).trim());
    lines.push('Theo Bramwell: ' + 'word '.repeat(10).trim());
  }
  const t = talkShareFromTranscript(lines.join('\n'), ['Theo', 'Avery Castellan']);
  assert.ok(t);
  assert.equal(Math.round(t.teamShare * 100), 75);
  assert.deepEqual(t.bySpeaker.map(s => [s.name, s.team]), [['Avery Castellan', true], ['Rowan Achterberg', false], ['Theo Bramwell', true]]);
  assert.equal(talkShareFromTranscript('Them: hi\nMe: hello', ['Theo']), null, 'me/them transcripts are not measured this way');
  // A buyer who shares a teammate's first name but not the surname stays a buyer.
  const u = talkShareFromTranscript(lines.join('\n').replaceAll('Rowan Achterberg', 'Theo Garrick'), ['Theo Bramwell', 'Avery Castellan']);
  assert.equal(u.bySpeaker.find(s => s.name === 'Theo Garrick').team, false);
});

test('the prompt carries the measured talk per speaker', () => {
  const p = buildCallScorePrompt(rubric, 'x', {
    people: [{ name: 'Avery Castellan', side: 'team' }, { name: 'Rowan Achterberg', side: 'buyer' }],
    talk: { teamShare: 0.62, bySpeaker: [{ name: 'Avery Castellan', share: 0.62, team: true }, { name: 'Rowan Achterberg', share: 0.38, team: false }] },
  });
  assert.match(p, /MEASURED TALK TIME \(share of words spoken\): our team 62% — Avery Castellan 62% \(our team\), Rowan Achterberg 38%/);
});

test('a competitor is an alternative to us; a tool in their stack is status quo', async () => {
  const { claimCategoryPromptBlock } = await import('../dist/db/claimCategories.js');
  const block = claimCategoryPromptBlock();
  assert.match(block, /does the job WE sell/);
  assert.match(block, /Never a tool in their stack that does something else \(that is status_quo\)/);
  assert.match(block, /call recorder, meeting-notes or agenda tool, data vendor/);
});

test('recordings of one call merge once each, later copies filling gaps (GET-260 store)', async () => {
  const { mergeRecordings } = await import('../dist/services/callReviewStore.js');
  const merged = mergeRecordings(
    [{ source: 'granola', meeting_id: 'not_1' }],
    [{ source: 'Granola', meeting_id: 'not_1', url: 'https://notes.granola.ai/d/1', named_speakers: false },
     { source: 'fireflies', meeting_id: '01M', url: 'https://app.fireflies.ai/view/01M', named_speakers: true }],
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[0].url, 'https://notes.granola.ai/d/1');
  assert.equal(merged[1].source, 'fireflies');
  assert.deepEqual(mergeRecordings([{ source: 'x' }]), [], 'a recording with no id is dropped');
});
