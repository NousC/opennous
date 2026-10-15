// The signal catalog (GET-862): one list of what can start a job, each entry with the exact
// agent_routines trigger it becomes. Pinned here so the picker, Settings and the builder agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signalCatalog, triggerForSignal, signalLabel } from '../dist/services/signalCatalog.mjs';
import { SIGNAL_LABEL } from '../dist/services/automationRun.mjs';
import { BUILDER_TRIGGERS } from '../dist/db/revboxBuilder.mjs';

const CUSTOM = [
  { id: 'd1', key: 'security_review', name: 'Security review needed', rule: 'The buyer asks for a security review.', active: true, version: 3, sources: ['granola'] },
  { id: 'd2', key: 'old_rule', name: 'Old rule', rule: 'x', active: false, archived_at: '2026-10-01T00:00:00Z' },
  { id: 'd3', key: 'draft_rule', name: 'Draft rule', rule: 'y', active: false },
];

test('built-ins map onto triggers that have a runner, and keys are unique', () => {
  const { builtin } = signalCatalog();
  const keys = builtin.map(e => e.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const e of builtin) {
    assert.ok(BUILDER_TRIGGERS.has(e.trigger.kind), `${e.key} -> ${e.trigger.kind} has a runner`);
    assert.ok(['meetings', 'deals', 'account', 'schedule'].includes(e.group), e.key);
    assert.ok(e.label && e.description, e.key);
  }
  assert.deepEqual(triggerForSignal('meeting.done'), { kind: 'call_ended', config: {} });
  assert.deepEqual(triggerForSignal('deal.won'), { kind: 'deal_closed_won', config: {} });
  assert.deepEqual(triggerForSignal('deal.lost'), { kind: 'deal_closed_lost', config: {} });
  assert.deepEqual(triggerForSignal('deal.stage_changed'), { kind: 'deal_stage_changed', config: {} });
  assert.deepEqual(triggerForSignal('icp.tier_changed'), { kind: 'icp_tier_changed', config: {} });
  assert.equal(builtin.find(e => e.key === 'hubspot.field_changed').needs_config, true);
  assert.deepEqual(triggerForSignal('schedule'), { kind: 'clock', config: {} });
});

test('one account-signal entry per SIGNAL_LABEL kind, from the engine constant', () => {
  const account = signalCatalog().builtin.filter(e => e.group === 'account');
  assert.deepEqual(account.map(e => e.key).sort(), Object.keys(SIGNAL_LABEL).map(k => `signal.${k}`).sort());
  assert.deepEqual(triggerForSignal('signal.churn_risk'), { kind: 'account_signal', config: { signals: ['churn_risk'] } });
  assert.equal(account.find(e => e.key === 'signal.churn_risk').label, SIGNAL_LABEL.churn_risk);
});

test('a meeting signal can name its recorder; the runner reads config.tools', () => {
  assert.deepEqual(triggerForSignal('meeting.done:granola'), { kind: 'call_ended', config: { provider: 'granola', tools: ['granola'] } });
  assert.deepEqual(triggerForSignal('meeting.done:any'), { kind: 'call_ended', config: {} });
  assert.equal(triggerForSignal('meeting.done:zoom'), null);
  assert.equal(triggerForSignal('deal.won:granola'), null);
  assert.equal(signalLabel('meeting.done:granola'), 'Meeting done · Granola');
  assert.equal(signalLabel(null), 'On a schedule');
});

test('no signal is a schedule; an unknown key is null', () => {
  assert.deepEqual(triggerForSignal(null), { kind: 'clock', config: {} });
  assert.deepEqual(triggerForSignal(''), { kind: 'clock', config: {} });
  assert.equal(triggerForSignal('deal.exploded'), null);
  assert.equal(signalLabel('deal.exploded'), null);
});

test('custom signals use the account_signals kind publishCustomSignal writes; archived ones are not offered', () => {
  const catalog = signalCatalog({ custom: CUSTOM });
  assert.deepEqual(catalog.custom.map(e => e.key), ['custom.security_review', 'custom.draft_rule']);
  const entry = catalog.custom[0];
  assert.equal(entry.group, 'custom'); assert.equal(entry.active, true); assert.equal(entry.id, 'd1');
  // publishCustomSignal: account_signals.kind = `custom_${definition.id}`; processAccountSignals
  // runs a routine when trigger_config.signals includes the signal's kind.
  assert.deepEqual(triggerForSignal('custom.security_review', catalog), { kind: 'account_signal', config: { signals: ['custom_d1'] } });
  assert.equal(triggerForSignal('custom.old_rule', catalog), null);
  assert.equal(triggerForSignal('custom.security_review'), null);   // not in the default (built-in) catalog
  const wanted = triggerForSignal('custom.security_review', catalog).config.signals;
  assert.ok(wanted.includes(`custom_${CUSTOM[0].id}`));
});

test('the catalog is a fresh copy every call', () => {
  const a = signalCatalog(); a.builtin[0].trigger.config.tools = ['x'];
  assert.deepEqual(signalCatalog().builtin[0].trigger.config, {});
  const t = triggerForSignal('signal.churn_risk'); t.config.signals.push('x');
  assert.deepEqual(triggerForSignal('signal.churn_risk').config.signals, ['churn_risk']);
});

test('an active custom signal loaded from the table shows up as custom.<key> (loadSignalCatalog, customSignalRulesForWorkspace)', async () => {
  const { loadSignalCatalog, customSignalRulesForWorkspace } = await import('../dist/db/customSignals.mjs');
  const rows = [
    { id: 'd1', workspace_id: 'ws', key: 'security_review', name: 'Security review', rule: 'r', version: 2, active: true, sources: ['granola'], archived_at: null },
    { id: 'd2', workspace_id: 'ws', key: 'draft_rule', name: 'Draft', rule: 'r', version: 1, active: false, sources: [], archived_at: null },
    { id: 'd3', workspace_id: 'ws', key: 'gone', name: 'Gone', rule: 'r', version: 3, active: false, sources: [], archived_at: '2026-10-01T00:00:00Z' },
    { id: 'd4', workspace_id: 'other', key: 'theirs', name: 'Theirs', rule: 'r', version: 1, active: true, sources: [], archived_at: null },
  ];
  const sb = { from() { const f = []; const q = { select: () => q, order: () => q, eq: (k, v) => { f.push(r => r[k] === v); return q; }, is: (k, v) => { f.push(r => (r[k] ?? null) === v); return q; }, then: (res, rej) => Promise.resolve({ data: rows.filter(r => f.every(x => x(r))), error: null }).then(res, rej) }; return q; } };
  const all = await loadSignalCatalog(sb, 'ws');
  assert.deepEqual(all.custom.map(e => e.key).sort(), ['custom.draft_rule', 'custom.security_review']);
  const live = await loadSignalCatalog(sb, 'ws', { activeOnly: true });
  assert.deepEqual(live.custom.map(e => [e.key, e.active, e.sources]), [['custom.security_review', true, ['granola']]]);
  assert.deepEqual(triggerForSignal('custom.security_review', live), { kind: 'account_signal', config: { signals: ['custom_d1'] } });
  // The rules list the extractor and the builder read carries the key, so it feeds the catalog too.
  const rules = await customSignalRulesForWorkspace(sb, 'ws');
  assert.deepEqual(signalCatalog({ custom: rules }).custom.map(e => e.key), ['custom.security_review']);
});

// GET-892: the pickers and the builder offer only the meeting recorders a workspace has connected.
test('withConnectedRecorders keeps only connected recorders, plus any recorder when one is', async () => {
  const { withConnectedRecorders, connectedRecorders } = await import('../dist/services/signalCatalog.mjs');
  assert.deepEqual(connectedRecorders(['slack', 'fireflies', 'granola', 'hubspot', 'granola']), ['granola', 'fireflies']);
  const base = signalCatalog({ custom: CUSTOM });
  const one = withConnectedRecorders(base, ['granola', 'slack']);
  const meeting = one.builtin.find(e => e.key === 'meeting.done');
  assert.deepEqual(meeting.providers, ['granola', 'any']);
  assert.deepEqual(one.recorders, ['granola']);
  // The input is not changed, and the other entries pass through.
  assert.deepEqual(base.builtin.find(e => e.key === 'meeting.done').providers, ['granola', 'fireflies', 'fathom', 'any']);
  assert.equal(one.builtin.length, base.builtin.length);
  assert.equal(one.custom.length, base.custom.length);
  const none = withConnectedRecorders(base, ['slack']);
  assert.deepEqual(none.builtin.find(e => e.key === 'meeting.done').providers, []);
  assert.deepEqual(none.recorders, []);
  // Resolving a key still uses the full catalog: an existing job on a disconnected recorder keeps its trigger.
  assert.deepEqual(triggerForSignal('meeting.done:fathom', base), { kind: 'call_ended', config: { provider: 'fathom', tools: ['fathom'] } });
});
