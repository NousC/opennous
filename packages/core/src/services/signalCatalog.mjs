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

// ── Several signals on one job (GET-873) ─────────────────────────────────────

const uniqueKeys = (keys) => [...new Set((Array.isArray(keys) ? keys : keys == null ? [] : [keys]).map(k => String(k ?? '').trim()).filter(Boolean))];

/**
 * Why these keys cannot start one job together, or null when they can: an unknown or archived key,
 * or a schedule combined with signals (a clock job runs on its slot, never on an event too).
 */
export function signalKeysProblem(keys, catalog = signalCatalog()) {
  const ks = uniqueKeys(keys);
  if (ks.length > 20) return 'A job starts on at most 20 signals.';
  const unknown = ks.filter(k => !triggerForSignal(k, catalog));
  if (unknown.length) return `${unknown.map(k => `"${k}"`).join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not in the signal catalog.`;
  if (ks.length > 1 && ks.some(k => triggerForSignal(k, catalog).kind === 'clock')) return 'A schedule cannot be combined with signals: a job runs either on a schedule or when its signals happen.';
  return null;
}

/**
 * The agent_routines trigger for one or more signal keys: `{ trigger_kind, trigger_config }`. The
 * first key's kind is the primary (`trigger_kind`); each other kind goes into
 * `trigger_config.also: [{ kind, config }]`, and `trigger_config.signal_keys` keeps the keys.
 * Keys of one kind merge into one trigger, so one event runs the job once: two account signals are
 * `{ signals: [a, b] }`, two recorders are `{ tools: [a, b] }`, and any recorder wins over a named
 * one. No keys = a schedule. null when signalKeysProblem says no.
 */
export function triggersForSignals(keys, catalog = signalCatalog()) {
  const ks = uniqueKeys(keys);
  if (!ks.length) return { trigger_kind: 'clock', trigger_config: {} };
  if (signalKeysProblem(ks, catalog)) return null;
  const byKind = new Map();
  for (const k of ks) {
    const t = triggerForSignal(k, catalog);
    const prev = byKind.get(t.kind);
    if (!prev) { byKind.set(t.kind, structuredClone(t.config ?? {})); continue; }
    if (t.kind === 'account_signal') prev.signals = [...new Set([...(prev.signals ?? []), ...(t.config.signals ?? [])])];
    else if (t.kind === 'call_ended') {
      // Plain meeting.done (no tools) is any recorder: it wins.
      if (!prev.tools?.length || !t.config.tools?.length) { delete prev.tools; delete prev.provider; }
      else { prev.tools = [...new Set([...prev.tools, ...t.config.tools])]; delete prev.provider; }
    }
  }
  const [[kind, config], ...rest] = [...byKind.entries()];
  const trigger_config = { ...config, signal_keys: ks };
  if (rest.length) trigger_config.also = rest.map(([k, c]) => ({ kind: k, config: c }));
  return { trigger_kind: kind, trigger_config };
}

// How a signal reads inside "When …". Unknown keys fall back to their label.
const SIGNAL_PHRASE = {
  'meeting.done': 'a meeting ends', 'deal.stage_changed': 'a deal changes stage',
  'icp.tier_changed': 'an account changes ICP tier', 'hubspot.field_changed': 'a HubSpot field changes',
};
const joinOr = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs.at(-1)}`);

/**
 * One line for a job's signals: one key reads as its label ("Deal won"), several as a sentence
 * ("When a deal is won or lost", "When a meeting ends or an account shows churn risk or buying
 * signal"). Pure; custom keys need the workspace catalog for their names.
 */
export function signalsLabel(keys, catalog = signalCatalog()) {
  const ks = uniqueKeys(keys);
  if (!ks.length) return 'On a schedule';
  if (ks.length === 1) return signalLabel(ks[0], catalog) ?? ks[0];
  const outcomes = ['deal.won', 'deal.lost'].filter(k => ks.includes(k)).map(k => k.split('.')[1]);
  const accounts = [];
  const phrases = [];
  for (const k of ks) {
    const [base, provider] = k.split(':');
    if (base === 'deal.won' || base === 'deal.lost') {
      if (base === (ks.includes('deal.won') ? 'deal.won' : 'deal.lost')) phrases.push(`a deal is ${joinOr(outcomes)}`);
    } else if (base.startsWith('signal.') || base.startsWith('custom.')) {
      if (!accounts.length) phrases.push(accounts);   // filled below, kept in order of the first one
      accounts.push(String(signalLabel(k, catalog) ?? base.split('.').slice(1).join('.').replace(/_/g, ' ')).toLowerCase());
    } else if (base === 'meeting.done' && provider && provider !== 'any') {
      phrases.push(`a ${PROVIDER_LABEL[provider] ?? provider} meeting ends`);
    } else phrases.push(SIGNAL_PHRASE[base] ?? String(signalLabel(k, catalog) ?? k).toLowerCase());
  }
  const parts = phrases.map(p => (Array.isArray(p) ? `an account shows ${joinOr(p)}` : p));
  return `When ${joinOr([...new Set(parts)])}`;
}
