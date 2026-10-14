// A job that starts on SEVERAL signals (GET-873), e.g. "when a deal is won or lost".
//
// No migration: agent_routines.trigger_kind stays the PRIMARY kind (what every older reader keys
// on), and the extra triggers ride in `trigger_config.also: [{ kind, config }]`, with
// `trigger_config.signal_keys: [...]` (signal-catalog keys) kept for display and for the builder to
// round-trip. Every event runner selects routines with `listensToFilter` (a superset, cheap in SQL)
// and decides with `triggerConfigsFor` (exact, in JS), so a routine matches when its primary kind OR
// one of its `also` entries is that kind with a matching config. One event still runs a routine at
// most once: each runner merges the matching configs before it decides, and keeps its dedupe key.
//
// A clock (or manual / condition) job cannot also start on events: it runs on its own slot, and an
// `also` on one is ignored here and refused by validateBuilderProposal. Pure.

/** Trigger kinds that run on their own and never combine with others. */
export const SOLO_TRIGGER_KINDS = new Set(['clock', 'manual', 'condition']);
export const MAX_ALSO_TRIGGERS = 20;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** The routine's own config without the multi-signal bookkeeping (what a single-trigger runner reads). */
export function primaryTriggerConfig(routine) {
  const tc = isObj(routine?.trigger_config) ? routine.trigger_config : {};
  const { also: _also, signal_keys: _keys, ...own } = tc;
  return own;
}

/** The extra triggers, cleaned: objects with a non-solo kind. Empty for a solo primary. */
export function alsoTriggers(routine) {
  if (SOLO_TRIGGER_KINDS.has(routine?.trigger_kind)) return [];
  const also = routine?.trigger_config?.also;
  if (!Array.isArray(also)) return [];
  return also.filter(t => isObj(t) && typeof t.kind === 'string' && t.kind && !SOLO_TRIGGER_KINDS.has(t.kind))
    .slice(0, MAX_ALSO_TRIGGERS)
    .map(t => ({ kind: t.kind, config: isObj(t.config) ? t.config : {} }));
}

/** Every trigger the routine starts on: the primary first, then `also`. */
export function routineTriggers(routine) {
  if (!routine?.trigger_kind) return [];
  return [{ kind: routine.trigger_kind, config: primaryTriggerConfig(routine) }, ...alsoTriggers(routine)];
}

/** The configs of the routine's triggers of one kind ([] when it does not listen to that kind). */
export function triggerConfigsFor(routine, kind) {
  return routineTriggers(routine).filter(t => t.kind === kind).map(t => t.config);
}

/** Whether the routine starts on this kind at all (config not checked). */
export const routineListensTo = (routine, kind) => triggerConfigsFor(routine, kind).length > 0;

/**
 * A PostgREST `or` filter that finds every routine that MAY listen to one of `kinds`: the primary
 * kind, or the kind's name anywhere in the `also` text. A superset (the text match can hit a config
 * value): callers always narrow with triggerConfigsFor. Kinds are snake_case words, so no quoting.
 */
export function listensToFilter(kinds) {
  const ks = [...new Set((Array.isArray(kinds) ? kinds : [kinds]).map(String).filter(k => /^[a-z_]+$/.test(k)))];
  if (!ks.length) throw new Error('listensToFilter needs a trigger kind');
  return [ks.length === 1 ? `trigger_kind.eq.${ks[0]}` : `trigger_kind.in.(${ks.join(',')})`, ...ks.map(k => `trigger_config->>also.like.*${k}*`)].join(',');
}

/**
 * account_signal: which signal kinds start the routine, merged over its account_signal triggers.
 * null = any signal (a trigger with no `signals` filter); [] = none (it does not listen).
 */
export function accountSignalKinds(routine) {
  const cfgs = triggerConfigsFor(routine, 'account_signal');
  if (!cfgs.length) return [];
  const out = new Set();
  for (const c of cfgs) {
    const s = Array.isArray(c.signals) ? c.signals.map(String).filter(Boolean) : [];
    if (!s.length) return null;
    for (const k of s) out.add(k);
  }
  return [...out];
}

/**
 * call_ended: which recorders start the routine, merged. null = any recorder; [] = it does not
 * listen. The primary reads its legacy `tools` column too (runCallEndedAutomations always has).
 */
export function callRecorders(routine) {
  const primary = routine?.trigger_kind === 'call_ended';
  const cfgs = triggerConfigsFor(routine, 'call_ended');
  if (!cfgs.length) return [];
  const out = new Set();
  cfgs.forEach((c, i) => {
    const tools = c.tools ?? (primary && i === 0 ? routine.tools : null) ?? [];
    const list = (Array.isArray(tools) ? tools : []).map(t => String(t).toLowerCase()).filter(Boolean);
    if (!list.length) { out.add('*'); return; }
    for (const t of list) out.add(t);
  });
  return out.has('*') ? null : [...out];
}

/**
 * before_meeting: how many minutes before a meeting the routine runs, or null when it does not.
 * Several before_meeting triggers: the earliest window (largest offset) wins; the run's dedupe key
 * is the meeting, so a meeting is still briefed once.
 */
export function beforeMeetingOffset(routine) {
  const cfgs = triggerConfigsFor(routine, 'before_meeting');
  if (!cfgs.length) return null;
  // The primary keeps reading its offset_minutes column first, as the runner always has.
  const offsets = cfgs.map((c, i) => Number((i === 0 && routine.trigger_kind === 'before_meeting' ? routine.offset_minutes : null) ?? c.offset_minutes ?? c.offset) || 60);
  return Math.max(...offsets);
}
