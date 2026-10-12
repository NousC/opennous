// A task is for our people — so a thing they owe us becomes our chase (GET-424, GET-425).
//
// A large share of the email corpus's tasks, and a smaller share of the meetings', were the
// CUSTOMER's homework: "Sign and return the onboarding agreement", "Provide the billing tax ID". Nobody here can tick
// those off — and deleting them loses the chase, which is the part a CS rep is paid for. So they
// are turned round rather than dropped. Structural, because both writers are impure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const strip = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

test('the email Read files a commitment they owe as OUR follow-up, not as theirs', async () => {
  const src = strip(await readFile(new URL('../src/noema/gmailRead.mjs', import.meta.url), 'utf8'));
  assert.match(src, /const theirs = owner === 'prospect';/);
  assert.match(src, /owner_kind:\s*'user',/, 'the row is ours whoever owed the thing');
  assert.match(src, /awaiting_them: theirs \|\| null/);
  assert.match(src, /owed_by:\s*theirs \? theirName : null/);
});

test('the call health read does the same', async () => {
  const src = strip(await readFile(new URL('../src/signals/callScore.mjs', import.meta.url), 'utf8'));
  assert.match(src, /const theirs = c\.owner === 'them';/);
  assert.match(src, /owner_kind:\s*'user',/);
  assert.match(src, /awaiting_them: theirs \|\| null/);
});

test('both say how many they turned round — a silent change is how the last four bugs hid', async () => {
  for (const f of ['../src/noema/gmailRead.mjs', '../src/signals/callScore.mjs']) {
    const src = await readFile(new URL(f, import.meta.url), 'utf8');
    assert.match(src, /flipped\) console\.log/, f);
  }
});

test('both prompts ask for a title our side can carry out', async () => {
  const gmail = await readFile(new URL('../src/noema/gmailRead.mjs', import.meta.url), 'utf8');
  assert.match(gmail, /ALWAYS SOMETHING \$\{ourName\} CAN DO/);
  const health = await readFile(new URL('../../../packages/core/src/services/accountHealth.ts', import.meta.url), 'utf8');
  assert.match(health, /ALWAYS SOMETHING OUR SIDE CAN DO/);
});
