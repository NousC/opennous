// Learned instructions. The tests that matter here are all refusals — what the engine declines
// to tell the agent. An instruction injected into context reads as a rule of the house, so the
// failure mode is not a missing rule, it is a confident wrong one that quietly shapes every
// draft afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { learnedInstructions, renderInstructions, INSTRUCTION_MIN_N, MAX_RULES } from '../dist/db/instructions.mjs';

const obs = (over = {}) => ({
  question_key: 'decision.quality:rewrite:outreach',
  category: 'decision',
  recommendation_template: 'Write shorter than feels finished.',
  effect: 0.4, confidence: 'high', sample_size: 120,
  conditions: { category: 'outreach' }, updated_at: '2026-09-09T00:00:00Z',
  ...over,
});

// learnedInstructions reads two tables now — observations for the rules, constraints for the
// things the operator has ruled out. The fake distinguishes them, because a block that silently
// returned constraints as rules would merge two kinds of instruction that must not read alike.
const db = (rows, error = null, constraints = [], preferences = []) => ({
  from: (table) => {
    const c = {};
    for (const m of ['select', 'eq', 'not', 'gte', 'order', 'is']) c[m] = () => c;
    c.limit = () => Promise.resolve({ data: rows, error });
    // listConstraints awaits the builder directly rather than calling .limit().
    c.then = (res) => res({
      data: table === 'ri_constraints' ? constraints
          : table === 'ri_preferences' ? preferences
          : rows,
      error: null,
    });
    return c;
  },
});

test('a well-sampled, confident finding becomes a rule', async () => {
  const out = await learnedInstructions(db([obs()]), 'ws-1');
  assert.equal(out.rules.length, 1);
  assert.equal(out.rules[0].n, 120);
});

test('a low-confidence finding is dropped, not hedged', async () => {
  // The hedge is the first thing a model discards, so a weak rule must not be emitted softly.
  for (const confidence of ['low', 'learning']) {
    const out = await learnedInstructions(db([obs({ confidence })]), 'ws-1');
    assert.equal(out.rules.length, 0, `${confidence} must not reach the agent`);
  }
});

test('a template with no text is not emitted as an empty bullet', async () => {
  const out = await learnedInstructions(db([obs({ recommendation_template: '   ' })]), 'ws-1');
  assert.equal(out.rules.length, 0);
});

test('the block is capped, so it cannot become prompt bloat', async () => {
  const many = Array.from({ length: 30 }, (_, i) => obs({ question_key: `k${i}` }));
  const out = await learnedInstructions(db(many), 'ws-1');
  assert.equal(out.rules.length, MAX_RULES);
  assert.equal(out.source_count, 30, 'the count of what qualified is still reported');
});

test('a read failure yields no instructions rather than throwing', async () => {
  // This runs inside a SessionStart hook. Breaking a session because we had nothing to add
  // would be a far worse outcome than starting without the extra context.
  const out = await learnedInstructions(db(null, { message: 'boom' }), 'ws-1');
  assert.deepEqual(out.rules, []);
});

test('every rendered rule carries its sample size and its segment', async () => {
  const text = renderInstructions({ rules: [{ text: 'Write shorter.', n: 120, confidence: 'high', conditions: { category: 'outreach' } }] });
  assert.match(text, /WHAT THIS WORKSPACE HAS LEARNED/);
  assert.match(text, /n=120/);
  assert.match(text, /category: outreach/);
  // An unconditioned finding is a coincidence with good PR; the condition travels with it.
  assert.match(text, /associations with a sample size, not rules/);
});

test('nothing learned renders to an empty string, so callers can concatenate blindly', () => {
  assert.equal(renderInstructions({ rules: [] }), '');
  assert.equal(renderInstructions(null), '');
});

test('the instruction floor is stricter than the reporting floor', () => {
  // Showing a person a thin number they can interpret is fine. Telling an agent to change how
  // it writes on the same evidence is not.
  assert.ok(INSTRUCTION_MIN_N >= 30);
});


test('a constraint travels with the rules but stays its own block', async () => {
  // Two kinds of instruction in one payload. A rule is a tendency to weigh against what is in
  // front of you; a constraint is not up for weighing. Rendered together they must still read
  // as different things, or the stronger gets averaged into the weaker.
  const out = await learnedInstructions(
    db([obs()], null, [{ statement: 'never send breakup emails', source: 'explicit' }]),
    'ws-1',
  );
  assert.equal(out.rules.length, 1);
  assert.equal(out.constraints.length, 1);

  const text = renderInstructions(out);
  assert.match(text, /THINGS THIS OPERATOR DOES NOT DO/);
  assert.match(text, /WHAT THIS WORKSPACE HAS LEARNED/);
  assert.ok(text.indexOf('DOES NOT DO') < text.indexOf('HAS LEARNED'), 'constraints come first');
});

test('constraints alone are still worth sending, with no rules at all', async () => {
  // The common early state: nothing learned yet, but the operator has already said "never do
  // X". Returning an empty string there would throw away the one instruction we are sure of.
  const out = await learnedInstructions(
    db([], null, [{ statement: 'we do not name competitors', source: 'explicit' }]),
    'ws-1',
  );
  assert.equal(out.rules.length, 0);
  const text = renderInstructions(out);
  assert.match(text, /do not name competitors/);
});

test('the three instruction kinds render in order of how much room the agent has to disagree', async () => {
  // A constraint is not up for weighing. A stated preference should be followed unless the
  // situation clearly says otherwise. A mined rule is a tendency to weigh against what you can
  // see. Flattened into one list they read alike and the strongest gets averaged into the weakest.
  const out = await learnedInstructions(
    db([obs()], null,
      [{ statement: 'never send breakup emails', source: 'explicit' }],
      [{ statement: 'write shorter', observed_count: 3 }]),
    'ws-1',
  );
  assert.equal(out.constraints.length, 1);
  assert.equal(out.preferences.length, 1);
  assert.equal(out.rules.length, 1);

  const text = renderInstructions(out);
  const iConstraint = text.indexOf('DOES NOT DO');
  const iPreference = text.indexOf('WANTS THINGS');
  const iRule = text.indexOf('HAS LEARNED');
  assert.ok(iConstraint < iPreference && iPreference < iRule, 'strongest first');
});

test('a stated preference reaches the agent with no statistical floor at all', async () => {
  // ri_observations needs n before it means anything. A preference was TOLD to us — putting it
  // behind the same floor would mean ignoring somebody who has already spoken.
  const out = await learnedInstructions(
    db([], null, [], [{ statement: 'write shorter', observed_count: 1 }]),
    'ws-1',
  );
  assert.equal(out.rules.length, 0, 'nothing mined yet');
  assert.match(renderInstructions(out), /write shorter/);
});
