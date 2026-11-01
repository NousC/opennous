// `nous backfill` (GET-1085): no tools for the model, stopping and limits lose nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandFor, parseAnswer, isPlanLimit, progressLine, runBackfill } from '../src/backfill.js';

const CALL = { id: 'c1', system: 'sys', messages: [{ role: 'user', content: 'hello' }] };
const MODELS = { claude: { model: 'm', effort: 'low' }, codex: { model: 'g', effort: 'low' } };
const OK = JSON.stringify({ result: 'answer', usage: { input_tokens: 5, output_tokens: 2 } });

test('Claude runs with no tools, no settings and no MCP', () => {
  const { args } = commandFor('claude', MODELS.claude, CALL);
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  assert.ok(args.includes('--strict-mcp-config'));
});

test('Codex runs with its shell off: the read-only sandbox can still read files', () => {
  const { args } = commandFor('codex', MODELS.codex, CALL);
  assert.ok(args.includes('features.shell_tool=false'));
  assert.ok(args.includes('mcp_servers={}'));
});

test('parses both answers, and an error is not an answer', () => {
  assert.equal(parseAnswer('claude', OK).text, 'answer');
  assert.equal(parseAnswer('codex', '{"item":{"type":"agent_message","text":"hi"}}\n{"usage":{"input_tokens":1,"output_tokens":1}}').text, 'hi');
  assert.throws(() => parseAnswer('claude', JSON.stringify({ is_error: true, result: 'nope' })));
  assert.throws(() => parseAnswer('codex', 'noise'));
});

test('tells a plan limit from a bad call', () => {
  assert.ok(isPlanLimit("You've hit your usage limit"));
  assert.ok(!isPlanLimit('unexpected end of JSON'));
});

function harness({ pages, run }) {
  const answers = [], slept = [], logs = [];
  let t = 0;
  return {
    answers, slept, logs,
    go: () => runBackfill({
      agent: 'claude', jobId: 'j', run, log: (l) => logs.push(l), now: () => t,
      sleep: async (ms) => { slept.push(ms); t += ms; },
      api: { calls: async () => pages.shift(), answer: async (id, body) => { answers.push({ id, ...body }); } },
    }),
  };
}

test('answers calls until the job is done', async () => {
  const h = harness({ run: async () => OK, pages: [
    { status: 'own_model_running', models: MODELS, calls: [CALL] },
    { status: 'own_model_running', models: MODELS, calls: [] },
    { status: 'done', models: MODELS, calls: [] },
  ] });
  const r = await h.go();
  assert.deepEqual(r, { status: 'done', answered: 1, read: 0, failed: 0 });
  assert.equal(h.answers[0].answer, 'answer');
  assert.equal(h.answers[0].model, 'm');
});

test('a plan limit waits and retries; it never fails the read', async () => {
  let n = 0;
  const h = harness({ run: async () => { if (n++ === 0) throw new Error('usage limit reached'); return OK; }, pages: [
    { status: 'own_model_running', models: MODELS, calls: [CALL] },
    { status: 'done', models: MODELS, calls: [] },
  ] });
  await h.go();
  assert.equal(h.answers.length, 1);
  assert.equal(h.answers[0].answer, 'answer');
  assert.equal(h.slept[0], 30 * 60_000);
});

test('a call that keeps failing is reported, and the rest carry on', async () => {
  const h = harness({ run: async () => { throw new Error('bad output'); }, pages: [
    { status: 'own_model_running', models: MODELS, calls: [CALL] },
    { status: 'done', models: MODELS, calls: [] },
  ] });
  const r = await h.go();
  assert.equal(h.answers[0].error, 'bad output');
  assert.equal(r.answered, 0);
});

test('progress says how far it is, and that stopping is safe', () => {
  assert.match(progressLine({ total: 130, done: 12 }, 40), /Read 12 of 130 .*Ctrl-C.*carry on/);
  assert.match(progressLine(null, 5), /5 reads done.*carry on/);
  assert.match(progressLine(null, 0), /Pulling your history.*carry on/);
});

test('progress is printed, and says the same thing only so often', async () => {
  const h = harness({ run: async () => OK, pages: [
    { status: 'own_model_running', models: MODELS, calls: [] },
    { status: 'own_model_running', models: MODELS, calls: [] },
    { status: 'done', reading: { read: 7, failed: 1 }, models: MODELS, calls: [] },
  ] });
  const r = await h.go();
  assert.equal(h.logs.filter(l => /Pulling/.test(l)).length, 1);
  assert.equal(r.read, 7);
  assert.equal(r.failed, 1);
});

test('a job the server paused while we were away is picked up again', async () => {
  let resumed = 0;
  const pages = [{ status: 'paused_own_model', models: MODELS, calls: [] }, { status: 'done', models: MODELS, calls: [] }];
  const r = await runBackfill({ agent: 'claude', jobId: 'j', run: async () => OK, log: () => {}, sleep: async () => {}, api: { calls: async () => pages.shift(), answer: async () => {}, resume: async () => { resumed++; } } });
  assert.equal(resumed, 1);
  assert.equal(r.status, 'done');
});

test('a job that failed on our side says so', async () => {
  const h = harness({ run: async () => OK, pages: [{ status: 'failed', error: 'boom', models: MODELS, calls: [] }] });
  await assert.rejects(h.go(), /boom/);
});
