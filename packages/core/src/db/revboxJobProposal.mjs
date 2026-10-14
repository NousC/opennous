// A RevBox job's CURRENT setup as a Job Builder proposal (GET-873). Edit on a job that no builder
// chat made (moved in by hand, made before the builder) opens a chat seeded with this, shown as the
// approved card, so the person can say "make the report better" and approve to update the same
// routine. Read from the routine's real columns only: name, trigger (its signal-catalog key found
// by mapping the trigger back through the catalog), steps, a display line per step from its type,
// and the box-delivery step folded back into uses_box_delivery. Pure, except loading the catalog.
import { signalCatalog, signalLabel } from '../services/signalCatalog.mjs';
import { loadSignalCatalog } from './customSignals.mjs';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const clip = (t, n) => { const x = String(t ?? '').replace(/\s+/g, ' ').trim(); return x.length > n ? `${x.slice(0, n - 1)}…` : x; };
const FREQ = { daily: 'Every day', weekly: 'Every Monday', monthly: 'On the first of the month', quarterly: 'At the start of each quarter' };
const JOB_NAMES = { follow_up: 'Draft the follow-up', call_summary: 'Summarize the call', premeeting_brief: 'Write the pre-meeting brief', account_summary: 'Summarize the account', deal_handoff: 'Write the handoff' };
/** The display `tool` per step type (revboxBuilder's DISPLAY_TOOLS, first choice). */
const TOOL = { hubspot: 'hubspot', slack: 'slack', gmail: 'gmail', email: 'email', webhook: 'webhook', agent: 'ai', approval: 'approval', only_if: 'only_if', wait: 'wait', dataset_append: 'dataset_append', dataset_read: 'dataset_read' };

const same = (a, b) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});

/**
 * The catalog key a routine's trigger came from, or null when none fits (a before-meeting or manual
 * job). A schedule is "schedule"; a meeting names its recorder when it has exactly one.
 */
export function signalKeyForRoutine(routine, catalog = signalCatalog()) {
  const kind = String(routine?.trigger_kind ?? '');
  const cfg = isObj(routine?.trigger_config) ? routine.trigger_config : {};
  if (kind === 'clock') return 'schedule';
  const entries = [...(catalog?.builtin ?? []), ...(catalog?.custom ?? [])];
  if (kind === 'call_ended') {
    const tools = Array.isArray(cfg.tools) ? cfg.tools.map(String) : Array.isArray(routine?.tools) ? routine.tools.map(String) : [];
    const provider = str(cfg.provider) || (tools.length === 1 ? tools[0] : '');
    const meeting = entries.find(e => e.key === 'meeting.done');
    return provider && (meeting?.providers ?? []).includes(provider) ? `meeting.done:${provider}` : 'meeting.done';
  }
  if (kind === 'account_signal') {
    const kinds = Array.isArray(cfg.signals) ? cfg.signals.map(String) : [];
    return entries.find(e => e.trigger?.kind === kind && same(e.trigger.config?.signals, kinds))?.key ?? null;
  }
  // deal.*, icp.tier_changed, hubspot.field_changed: one entry per kind, its config the job's own.
  return entries.find(e => e.trigger?.kind === kind)?.key ?? null;
}

/** "Every day at 08:00 (Toronto)", "Meeting done · Granola", or the kind when nothing knows it. */
function triggerLabel(routine, key, catalog) {
  const cfg = isObj(routine?.trigger_config) ? routine.trigger_config : {};
  if (routine?.trigger_kind === 'clock') {
    const freq = cfg.frequency ?? routine.frequency ?? 'daily';
    const at = cfg.at ?? routine.at_time ?? '08:00';
    const city = String(routine.timezone ?? '').split('/').pop()?.replace(/_/g, ' ');
    return `${(cfg.weekdays_only || routine.weekdays_only) && freq === 'daily' ? 'Weekdays' : FREQ[freq] ?? 'Every day'} at ${at}${city && routine.timezone !== 'UTC' ? ` (${city})` : ''}`;
  }
  if (routine?.trigger_kind === 'before_meeting') return `${Number(cfg.offset ?? routine.offset_minutes) || 30} minutes before a meeting`;
  if (routine?.trigger_kind === 'manual') return 'Run by hand';
  return (key && signalLabel(key, catalog)) || String(routine?.trigger_kind ?? 'Trigger');
}

/** One display line for a real step, from its type and config (never invented). */
export function displayForStep(s) {
  const c = isObj(s?.config) ? s.config : {};
  const line = (title, detail) => ({ step_id: String(s.id), tool: TOOL[s.type] ?? s.type, title: clip(title, 90), ...(detail ? { detail: clip(detail, 140) } : {}) });
  switch (s?.type) {
    case 'hubspot': {
      const action = c.action ?? 'note';
      if (action === 'read') return line(`Read ${str(c.object_label) || str(c.object) || 'HubSpot records'}`, Array.isArray(c.fields) && c.fields.length ? `${c.fields.length} field${c.fields.length === 1 ? '' : 's'}${c.window ? ` · ${c.window}` : ''}` : null);
      if (action === 'task') return line(c.task_from === 'call' ? 'Create HubSpot tasks from the call' : `Create a HubSpot task${str(c.title) ? `: ${str(c.title)}` : ''}`);
      if (action.startsWith('update_')) return line(`Update the ${action.slice(7)} in HubSpot`);
      return line('Add a note in HubSpot');
    }
    case 'agent': return c.mode === 'pick' ? line(JOB_NAMES[c.job] ?? 'Write it with AI', str(c.extra)) : line('Write it with AI', str(c.prompt));
    case 'slack': return c.action === 'dm' ? line(`Message ${str(c.user_name) || 'a person'} in Slack`) : line(`Post to #${String(c.channel ?? c.channel_id ?? 'a channel').replace(/^#/, '')}`, c.format ? `${String(c.format).replace(/^./, x => x.toUpperCase())} layout` : null);
    case 'gmail': return line(`${c.mode === 'draft' ? 'Draft' : 'Email'} ${str(c.to) || 'someone'}`, c.send_from?.email ? `from ${c.send_from.email}` : null);
    case 'email': return line(`Email ${str(c.to) || 'someone'}`);
    case 'webhook': { let host = str(c.url); try { host = new URL(host).host; } catch { /* as saved */ } return line(`Send to ${host || 'a webhook'}`); }
    case 'approval': return line('Wait for approval');
    case 'only_if': return line('Only if the rules match');
    case 'wait': return line('Wait');
    case 'dataset_append': return line(`Add a row to the table ${str(c.dataset_key) || '(none)'}`);
    case 'dataset_read': return line(`Read the table ${str(c.dataset_key) || '(none)'}`, c.window ? String(c.window).replace(/_/g, ' ') : null);
    default: return line(`${s?.type ?? 'Step'}`);
  }
}

/**
 * The routine as a proposal: { name, summary, trigger: { signal_key?, kind, config, timezone, label },
 * steps (without the box-delivery step), display, uses_box_delivery, box_delivery_format?, warnings,
 * assumptions, estimated_credits_per_run }. `facts` is added by the caller (proposalFacts). Pure.
 */
export function proposalFromRoutine(routine, catalog = signalCatalog()) {
  const all = (Array.isArray(routine?.steps) ? routine.steps : []).filter(isObj);
  const delivery = all.find(s => s.type === 'revbox_delivery');
  const steps = all.filter(s => s.type !== 'revbox_delivery').map(s => ({ id: String(s.id ?? ''), type: String(s.type ?? ''), config: isObj(s.config) ? structuredClone(s.config) : {} }));
  const key = signalKeyForRoutine(routine, catalog);
  const label = triggerLabel(routine, key, catalog);
  const display = steps.map(displayForStep);
  const fmt = str(delivery?.config?.format);
  return {
    name: str(routine?.name) || 'Job',
    summary: clip(`${label}: ${[...display.map(d => d.title), ...(delivery ? ['deliver to the box\'s destinations'] : [])].join(', then ')}.`, 2000),
    trigger: { ...(key ? { signal_key: key } : {}), kind: String(routine?.trigger_kind ?? 'clock'), config: isObj(routine?.trigger_config) ? structuredClone(routine.trigger_config) : {}, timezone: str(routine?.timezone) || 'UTC', label },
    steps, display,
    uses_box_delivery: !!delivery,
    ...(delivery && fmt && fmt !== 'approval' ? { box_delivery_format: fmt } : {}),
    warnings: [], assumptions: [], estimated_credits_per_run: null,
  };
}

/** The lookups proposalFacts names targets with, taken from the steps' own saved config. Pure. */
export function routineFactLookups(steps) {
  const list = Array.isArray(steps) ? steps : [];
  const c = (s) => (isObj(s?.config) ? s.config : {});
  return {
    slackChannels: list.filter(s => s?.type === 'slack' && str(c(s).channel_id) && str(c(s).channel)).map(s => ({ id: c(s).channel_id, name: String(c(s).channel).replace(/^#/, '') })),
    slackPeople: list.filter(s => s?.type === 'slack' && str(c(s).user_id) && str(c(s).user_name)).map(s => ({ id: c(s).user_id, name: c(s).user_name })),
    mailboxes: list.filter(s => s?.type === 'gmail' && str(c(s).send_from?.id) && str(c(s).send_from?.email)).map(s => ({ id: c(s).send_from.id, email: c(s).send_from.email })),
  };
}

/** The workspace's catalog for mapping a trigger back (live and draft signals); the built-ins if it cannot load. */
export async function routineProposalCatalog(sb, workspaceId) {
  try { return await loadSignalCatalog(sb, workspaceId); } catch { return signalCatalog(); }
}

/** What the seeded chat's assistant says above the card. */
export const OUTSIDE_BUILDER_TEXT = "This job was set up outside the builder. Here's what it does now:";
