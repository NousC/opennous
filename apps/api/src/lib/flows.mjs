// Automation flows (GET-523) — what the API accepts as a flow, and how a flow is written
// back into the columns the older runners read.
//
// Mirrors apps/frontend/src/lib/flows.ts. The frontend builds; this checks. A flow that gets
// past here is a trigger this table allows and a list of steps of kinds the runner knows,
// each with an object for its settings and nothing larger than a flow has any reason to be.

export const FLOW_TRIGGERS = [
  // conversations
  { key: 'call_ended', family: 'conversations', label: 'When a call ends' },
  { key: 'before_meeting', family: 'conversations', label: 'Before a meeting' },
  { key: 'email_received', family: 'conversations', label: 'When a reply comes in' },
  { key: 'reply_owed', family: 'conversations', label: 'When a reply is owed' },
  { key: 'thread_quiet', family: 'conversations', label: 'When a thread goes quiet' },
  // account signals
  { key: 'account_signal', family: 'signals', label: 'When an account signal lands' },
  { key: 'health_changed', family: 'signals', label: 'When account health changes' },
  { key: 'posthog_event', family: 'signals', label: 'When a PostHog event fires' },
  { key: 'champion_quiet', family: 'signals', label: 'When the champion goes quiet' },
  { key: 'committee_joined', family: 'signals', label: 'When someone joins the committee' },
  { key: 'icp_tier_changed', family: 'signals', label: 'When the ICP tier changes' },
  { key: 'expansion_signal', family: 'signals', label: 'When an expansion signal shows' },
  { key: 'promise_overdue', family: 'signals', label: 'When a promise is overdue' },
  // deals
  { key: 'deal_stage_changed', family: 'deals', label: 'When a deal changes stage' },
  { key: 'deal_closed_won', family: 'deals', label: 'When a deal is won' },
  { key: 'deal_closed_lost', family: 'deals', label: 'When a deal is lost' },
  { key: 'deal_stalled', family: 'deals', label: 'When a deal stalls' },
  { key: 'deal_created', family: 'deals', label: 'When a deal is created' },
  { key: 'hubspot_field_changed', family: 'deals', label: 'When a HubSpot field changes' },
  // other
  { key: 'clock', family: 'other', label: 'On a schedule' },
  { key: 'webhook_in', family: 'other', label: 'When a webhook arrives' },
  { key: 'manual', family: 'other', label: 'When I run it' },
];

export const FLOW_TRIGGER_KEYS = new Set(FLOW_TRIGGERS.map(t => t.key));

export const STEP_TYPES = new Set([
  'agent', 'hubspot', 'gmail', 'slack', 'email', 'webhook', 'only_if', 'wait', 'approval',
  // A RevBox job's last step (GET-868): the box's destinations at run time. Added by the Job Builder.
  'revbox_delivery',
  // A RevBox job's tables (GET-874): add the AI step's row to a box dataset, read a window of rows back.
  'dataset_append', 'dataset_read',
]);
/** Steps only the system writes: never offered on the public API, never accepted from it. */
export const INTERNAL_STEP_TYPES = new Set(['revbox_delivery', 'dataset_append', 'dataset_read']);

const MAX_STEPS = 20;
const MAX_FLOW_BYTES = 60_000;

/**
 * Check a flow. Returns { ok: true, steps, triggerConfig } or { ok: false, error, message }.
 * `when` has been checked against FLOW_TRIGGER_KEYS by the caller.
 */
export function checkFlow({ steps, trigger_config: triggerConfig }) {
  if (!Array.isArray(steps) || !steps.length) {
    return { ok: false, error: 'no_steps', message: 'Add at least one step.' };
  }
  if (steps.length > MAX_STEPS) {
    return { ok: false, error: 'too_many_steps', message: `A flow holds up to ${MAX_STEPS} steps.` };
  }
  const ids = new Set();
  const clean = [];
  for (const s of steps) {
    if (!s || typeof s !== 'object') return { ok: false, error: 'bad_step' };
    const id = String(s.id ?? '').slice(0, 40);
    if (!id || ids.has(id)) return { ok: false, error: 'bad_step_id' };
    if (!STEP_TYPES.has(s.type)) return { ok: false, error: 'unknown_step', step: s.type };
    const config = s.config && typeof s.config === 'object' && !Array.isArray(s.config) ? s.config : {};
    ids.add(id);
    clean.push({ id, type: s.type, config });
  }
  const tc = triggerConfig && typeof triggerConfig === 'object' && !Array.isArray(triggerConfig) ? triggerConfig : {};
  if (JSON.stringify({ clean, tc }).length > MAX_FLOW_BYTES) {
    return { ok: false, error: 'flow_too_large', message: 'That flow is larger than a flow should be.' };
  }
  return { ok: true, steps: clean, triggerConfig: tc };
}

/**
 * The legacy columns for a flow's trigger: trigger_kind and the schedule shape the table's
 * constraint demands (a clock carries a frequency and an hour, a before-meeting its offset,
 * everything else neither).
 */
export function scheduleColumns(when, tc) {
  return {
    trigger_kind: when,
    frequency: when === 'clock' ? String(tc.frequency ?? 'daily') : null,
    at_time: when === 'clock' ? String(tc.at ?? '08:00') : null,
    offset_minutes: when === 'before_meeting' ? (Number(tc.offset) || 30) : null,
    tools: Array.isArray(tc.tools) && tc.tools.length ? tc.tools.map(String) : null,
  };
}

/**
 * The first delivery step as the legacy destination, so a simple flow (agent → Slack) still
 * lands where it says under the runner that reads `destination`.
 */
export function destinationColumns(steps) {
  const s = steps.find(x => x.type === 'slack' || x.type === 'email' || x.type === 'webhook');
  if (!s) return { destination: 'none', destination_target: null };
  if (s.type === 'slack') return { destination: 'slack', destination_target: String(s.config.channel ?? '').trim() || null };
  if (s.type === 'webhook') return { destination: 'webhook', destination_target: String(s.config.url ?? '').trim() || null };
  const to = [s.config.to, s.config.cc].map(x => String(x ?? '').trim()).filter(Boolean).join(', ');
  return { destination: 'email', destination_target: to || null };
}

/** True when a write failed because the flows migration has not run on this database. */
export function isMissingFlowColumn(error) {
  const m = String(error?.message ?? '');
  return /steps|trigger_config/.test(m) && /column|schema cache/i.test(m);
}
