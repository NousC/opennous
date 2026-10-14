// The signal catalog (GET-862, GET-868): the ONE list of what can start a job. The Job Builder's
// Signals picker, Settings > Signals and the builder agent all read it, so a signal means the
// same thing everywhere. Each entry carries the exact agent_routines trigger it becomes
// (`trigger: { kind, config }`), and every kind here has a runner (BUILDER_TRIGGERS in
// db/revboxBuilder.mjs) — a signal that cannot start anything is not offered.
//
// KEYS ARE STABLE. A job, a builder hint and the UI refer to a signal by key: `meeting.done`,
// `deal.won`, `signal.churn_risk`, `schedule`, and `custom.<key>` for a workspace's own signal
// (custom_signal_definitions.key, immutable and never reused). A meeting signal can name its
// recorder as `meeting.done:granola`; plain `meeting.done` is any recorder.
//
// No signal is a schedule: when the user picks nothing, the job most likely runs on a clock.
import { SIGNAL_LABEL } from './automationRun.mjs';

export const MEETING_PROVIDERS = ['granola', 'fireflies', 'fathom'];
const PROVIDER_LABEL = { granola: 'Granola', fireflies: 'Fireflies', fathom: 'Fathom' };
export const SIGNAL_GROUPS = [
  { id: 'meetings', label: 'Meetings' }, { id: 'deals', label: 'Deals' },
  { id: 'account', label: 'Account signals' }, { id: 'schedule', label: 'Schedule' }, { id: 'custom', label: 'Your signals' },
];

const ACCOUNT_DESCRIPTION = {
  objection_raised: 'A buyer raised an objection in a call or email.', objection_resolved: 'An earlier objection was answered.',
  competitor_mentioned: 'A competitor came up in conversation.', competitor_evaluating: 'The account is actively evaluating a competitor.',
  stakeholder_identified: 'A key stakeholder was identified.', stakeholder_joined: 'A new stakeholder joined the conversation.', stakeholder_left: 'A stakeholder left the account.',
  budget_discussed: 'Budget or pricing was discussed.', buying_signal: 'The buyer showed intent to buy.', next_step: 'A concrete next step was agreed.',
  expansion_signal: 'The customer showed room to expand.', expansion_declined: 'The customer declined an expansion.', churn_risk: 'The customer showed a risk of churning.',
};

/** The built-in entries. Pure, frozen per call (callers may mutate their copy). */
export function builtinSignals() {
  return [
    { key: 'meeting.done', label: 'Meeting done', description: 'A recorded meeting ended and its notes are in.', group: 'meetings', providers: [...MEETING_PROVIDERS, 'any'], trigger: { kind: 'call_ended', config: {} } },
    { key: 'deal.won', label: 'Deal won', description: 'A deal moved to closed won.', group: 'deals', trigger: { kind: 'deal_closed_won', config: {} } },
    { key: 'deal.lost', label: 'Deal lost', description: 'A deal moved to closed lost.', group: 'deals', trigger: { kind: 'deal_closed_lost', config: {} } },
    { key: 'deal.stage_changed', label: 'Deal stage changed', description: 'A deal moved to another pipeline stage.', group: 'deals', trigger: { kind: 'deal_stage_changed', config: {} } },
    { key: 'icp.tier_changed', label: 'ICP tier changed', description: 'An account moved to another ICP tier.', group: 'deals', trigger: { kind: 'icp_tier_changed', config: {} } },
    { key: 'hubspot.field_changed', label: 'HubSpot field changed', description: 'A chosen HubSpot property changed value.', group: 'deals', needs_config: true, trigger: { kind: 'hubspot_field_changed', config: {} } },
    ...Object.entries(SIGNAL_LABEL).map(([kind, label]) => ({
      key: `signal.${kind}`, label, description: ACCOUNT_DESCRIPTION[kind] ?? `${label} on an account.`, group: 'account',
      trigger: { kind: 'account_signal', config: { signals: [kind] } },
    })),
    { key: 'schedule', label: 'On a schedule', description: 'No signal: the job runs on a clock (the default).', group: 'schedule', trigger: { kind: 'clock', config: {} } },
  ];
}

/**
 * A workspace signal as a catalog entry. Archived ones are not offered. The trigger is the kind
 * publishCustomSignal writes to account_signals (`custom_<definition id>`), which is exactly what
 * processAccountSignals matches trigger_config.signals against.
 */
export function customSignalEntry(def) {
  return {
    key: `custom.${def.key}`, label: def.name, description: String(def.rule ?? '').slice(0, 280), group: 'custom',
    id: def.id, active: def.active === true, version: def.version ?? 1, sources: def.sources ?? [],
    trigger: { kind: 'account_signal', config: { signals: [`custom_${def.id}`] } },
  };
}

/** { builtin, custom }: the whole catalog for one workspace. `custom` = its definition rows. */
export function signalCatalog({ custom = [] } = {}) {
  return { builtin: builtinSignals(), custom: (custom ?? []).filter(d => d && !d.archived_at && d.key).map(customSignalEntry) };
}

/**
 * The agent_routines trigger a signal key becomes: `{ kind, config }`, or null for a key the
 * catalog does not know (or a custom signal that is archived). No key = a schedule.
 * `meeting.done:granola` limits the call_ended trigger to that recorder: the runner reads
 * `config.tools` (runCallEndedAutomations); `provider` is kept alongside for display.
 */
export function triggerForSignal(key, catalog = signalCatalog()) {
  if (key == null || key === '') return { kind: 'clock', config: {} };
  if (typeof key !== 'string') return null;
  const [base, provider] = key.split(':');
  const entry = [...(catalog?.builtin ?? []), ...(catalog?.custom ?? [])].find(e => e.key === base);
  if (!entry) return null;
  const trigger = { kind: entry.trigger.kind, config: structuredClone(entry.trigger.config ?? {}) };
  if (provider !== undefined) {
    if (base !== 'meeting.done' || !(entry.providers ?? []).includes(provider)) return null;
    if (provider !== 'any') Object.assign(trigger.config, { provider, tools: [provider] });
  }
  return trigger;
}

/** "Meeting done · Granola", "Deal won", "On a schedule". Null for an unknown key. */
export function signalLabel(key, catalog = signalCatalog()) {
  if (key == null || key === '') return 'On a schedule';
  const [base, provider] = String(key).split(':');
  const entry = [...(catalog?.builtin ?? []), ...(catalog?.custom ?? [])].find(e => e.key === base);
  if (!entry) return null;
  return provider && provider !== 'any' && PROVIDER_LABEL[provider] ? `${entry.label} · ${PROVIDER_LABEL[provider]}` : entry.label;
}
