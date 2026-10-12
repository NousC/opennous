// Automation flows (GET-523): what the API accepts, and the legacy columns a flow fills.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkFlow, scheduleColumns, destinationColumns, isMissingFlowColumn, FLOW_TRIGGER_KEYS } from '../src/lib/flows.mjs';

test('a flow needs at least one step, of a kind the runner knows', () => {
  assert.equal(checkFlow({ steps: [] }).ok, false);
  assert.equal(checkFlow({ steps: [{ id: 'a', type: 'teleport', config: {} }] }).error, 'unknown_step');
  assert.equal(checkFlow({ steps: [{ id: 'a', type: 'agent' }, { id: 'a', type: 'slack' }] }).error, 'bad_step_id');
  const ok = checkFlow({ steps: [{ id: 'a', type: 'agent', config: { mode: 'write', prompt: 'x' } }], trigger_config: { days: 14 } });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.triggerConfig, { days: 14 });
});

test('PostHog is an account signal, and every family is offered', () => {
  for (const k of ['call_ended', 'health_changed', 'posthog_event', 'deal_stalled', 'clock', 'manual']) {
    assert.ok(FLOW_TRIGGER_KEYS.has(k), k);
  }
});

test('the schedule shape follows the trigger, so the table constraint holds', () => {
  assert.deepEqual(scheduleColumns('clock', { frequency: 'weekly', at: '09:00' }),
    { trigger_kind: 'clock', frequency: 'weekly', at_time: '09:00', offset_minutes: null, tools: null });
  assert.equal(scheduleColumns('before_meeting', { offset: '60' }).offset_minutes, 60);
  const ev = scheduleColumns('health_changed', { frequency: 'daily' });
  assert.equal(ev.frequency, null); assert.equal(ev.at_time, null); assert.equal(ev.offset_minutes, null);
});

test('the first delivery step becomes the legacy destination', () => {
  assert.deepEqual(destinationColumns([{ type: 'agent', config: {} }]), { destination: 'none', destination_target: null });
  assert.deepEqual(destinationColumns([{ type: 'slack', config: { channel: '#deals' } }]), { destination: 'slack', destination_target: '#deals' });
  assert.deepEqual(destinationColumns([{ type: 'email', config: { to: 'a@b.co', cc: 'c@d.co' } }]), { destination: 'email', destination_target: 'a@b.co, c@d.co' });
});

test('a missing flows column is recognised, so the API can say the migration has not run', () => {
  assert.equal(isMissingFlowColumn({ message: "Could not find the 'steps' column of 'agent_routines' in the schema cache" }), true);
  assert.equal(isMissingFlowColumn({ message: 'duplicate key' }), false);
});
