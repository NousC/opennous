import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODEL_LEVELS, DEFAULT_LEVEL, resolveLevel, listLevels, isChatModel, isKnownModel, resolveAgentModel,
} from '../src/lib/model.mjs';

// The chat picker's three levels (GET-212). Pure; no DB, no model calls.

test('exactly three levels, Low is GLM 5.2 and the default', () => {
  assert.deepEqual(MODEL_LEVELS.map((l) => [l.id, l.model]), [
    ['low', 'glm-5.2'],
    ['medium', 'claude-sonnet-5'],
    ['high', 'claude-opus-4-8'],
  ]);
  assert.equal(DEFAULT_LEVEL, 'low');
  for (const l of MODEL_LEVELS) assert.ok(isKnownModel(l.model), `${l.model} is in the registry`);
});

test('resolveLevel accepts level ids', () => {
  assert.equal(resolveLevel('low').model, 'glm-5.2');
  assert.equal(resolveLevel('medium').model, 'claude-sonnet-5');
  assert.equal(resolveLevel('high').model, 'claude-opus-4-8');
  assert.equal(resolveLevel(' High ').id, 'high', 'case and whitespace do not matter');
});

test('resolveLevel maps legacy registry keys from a stale tab', () => {
  assert.equal(resolveLevel('glm-5.2').id, 'low');
  assert.equal(resolveLevel('claude-sonnet-5').id, 'medium');
  assert.equal(resolveLevel('claude-opus-4-8').id, 'high');
});

test('anything else is Low', () => {
  for (const v of ['claude-haiku-4-5', 'gpt-oss-120b', 'kimi-k2.6', 'reason', 'nonsense', '', null, undefined, 42, {}]) {
    assert.equal(resolveLevel(v).id, 'low', `${JSON.stringify(v)} → low`);
  }
});

test('every level model may be the conversation model; other hidden models may not', () => {
  for (const l of MODEL_LEVELS) assert.ok(isChatModel(l.model), l.model);
  assert.equal(isChatModel('claude-haiku-4-5'), false);
  assert.equal(isChatModel('kimi-k2.6'), false);
});

test('listLevels carries display fields and no base URLs or key env names', () => {
  const rows = listLevels();
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    id: 'low', label: 'Low', model: 'glm-5.2', modelLabel: 'GLM 5.2', modelId: 'z-ai/glm-5.2', vendor: 'Z.ai', class: 'open',
  });
  for (const r of rows) {
    assert.equal('baseURL' in r, false);
    assert.equal('apiKeyEnv' in r, false);
  }
});

test('missing OPENROUTER_API_KEY falls back to Sonnet and says so as an error, once', () => {
  const saved = process.env.OPENROUTER_API_KEY;
  const origError = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(' '));
  try {
    delete process.env.OPENROUTER_API_KEY;
    const first = resolveAgentModel('glm-5.2');
    const second = resolveAgentModel('glm-5.2');
    assert.equal(first.modelId, 'claude-sonnet-5', 'the turn still runs, on the model usage will record');
    assert.equal(second.modelId, 'claude-sonnet-5');
    const glmErrors = logged.filter((l) => l.includes('glm-5.2') && l.includes('OPENROUTER_API_KEY'));
    assert.equal(glmErrors.length, 1, 'logged once per process, not per turn');

    process.env.OPENROUTER_API_KEY = 'test-not-a-real-key';
    assert.equal(resolveAgentModel('glm-5.2').modelId, 'z-ai/glm-5.2');
  } finally {
    console.error = origError;
    if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = saved;
  }
});

test('an agent turn that names no model runs GLM 5.2, the standard (2026-09-30)', async () => {
  const prev = process.env.NOUS_AGENT_MODEL;
  delete process.env.NOUS_AGENT_MODEL;
  process.env.OPENROUTER_API_KEY ||= 'test-key';
  const { resolveAgentModel, STANDARD_AGENT_MODEL } = await import('../src/lib/model.mjs');
  assert.equal(STANDARD_AGENT_MODEL, 'glm-5.2');
  assert.equal(resolveAgentModel().modelId, 'z-ai/glm-5.2');
  // A level that names Claude still gets Claude.
  assert.equal(resolveAgentModel('claude-sonnet-5').provider, 'anthropic');
  if (prev !== undefined) process.env.NOUS_AGENT_MODEL = prev;
});
