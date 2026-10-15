// The RevBox Job Builder's engine side (GET-868, docs/revboxes/JOB_BUILDER.md): builder sessions,
// the server-side check of a proposed job, and approving it into a workflow-engine routine
// (`agent_routines` with `revbox_id`), the same engine the Automations run on.
//
// The flow rules mirror apps/api/src/lib/flows.mjs (checkFlow, scheduleColumns, destinationColumns)
// and the per-step readiness mirrors stepReady in apps/frontend/src/lib/flows.ts. Core cannot import
// the API, so they are restated here; change them together.
import { loadRevbox } from './revboxes.mjs';
import { JOB_PROMPTS, JOB_ARTIFACTS } from '../services/automationRun.mjs';
import { nextRunAt } from '../services/routineSchedule.mjs';
import { proposalFromRoutine, routineFactLookups, routineProposalCatalog } from './revboxJobProposal.mjs';
import { jobBrief } from './revboxJobBrief.mjs';
import { SOLO_TRIGGER_KINDS, MAX_ALSO_TRIGGERS } from '../services/routineTriggers.mjs';
import { normalizeDatasetColumns, datasetSlug, DATASET_WINDOWS } from '../services/datasetFormats.mjs';
import { createRevboxDataset } from './revboxDatasets.mjs';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
async function rows(q) { const { data, error } = await q; if (error) throw error; return data ?? []; }
async function one(q) { const { data, error } = await q; if (error) throw error; return data; }
const now = () => new Date().toISOString();
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** Triggers something actually dispatches today (LIVE_TRIGGERS in automations.mjs, plus manual). */
export const BUILDER_TRIGGERS = new Set(['clock', 'manual', 'call_ended', 'deal_closed_won', 'deal_closed_lost', 'deal_stage_changed', 'icp_tier_changed', 'account_signal', 'hubspot_field_changed', 'before_meeting']);
/** What a proposal may contain. `revbox_delivery` is not proposed: approve appends it (uses_box_delivery). */
export const BUILDER_STEP_TYPES = new Set(['agent', 'hubspot', 'gmail', 'slack', 'email', 'webhook', 'only_if', 'wait', 'approval', 'dataset_append', 'dataset_read']);
const AGENT_JOBS = new Set(['follow_up', 'call_summary', 'premeeting_brief', 'account_summary', 'deal_handoff']);
const HUBSPOT_ACTIONS = new Set(['read', 'note', 'task', 'update_deal', 'update_contact', 'update_company']);
const FREQUENCIES = new Set(['daily', 'weekly', 'monthly', 'quarterly']);
const WARNING_KINDS = new Set(['missing_access', 'missing_connection', 'unverified', 'cost', 'mailbox_owner']);
const STEP_ID = /^[A-Za-z0-9_-]{1,40}$/;
const STEP_REF = /\{\{\s*steps\.([A-Za-z0-9_-]+)\.output\s*\}\}/g;
const MAX_STEPS = 20;
const MAX_FLOW_BYTES = 60_000;
/** Datasets (GET-874): the tables one proposal may create, the jobs it may say are still to set up. */
const MAX_PROPOSED_DATASETS = 5;
const MAX_NEXT_JOBS = 5;
const DATASET_KEY = /^[a-z][a-z0-9_]{0,62}$/;
const DEDUPE_FROM = ['deal', 'account', 'none'];
const WINDOW_WORDS = { last_7_days: 'the last 7 days', last_30_days: 'the last 30 days', last_month: 'last month', last_quarter: 'last quarter', all: 'all rows' };
export const BOX_DELIVERY_STEP = 'box_delivery';

function validTimezone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** Why one step would not run, or null. stepReady's rules plus what the server can check. */
function stepProblem(s, { slackChannelIds, slackUserIds, mailboxIds, tables = null }) {
  const c = s.config;
  const name = `Step "${s.id}"`;
  switch (s.type) {
    case 'agent':
      if (c.mode === 'pick') return AGENT_JOBS.has(c.job) ? null : `${name}: pick one of the built-in jobs (${[...AGENT_JOBS].join(', ')}) or use mode "write" with a prompt.`;
      return str(c.prompt) ? null : `${name}: an AI step needs its instructions in "prompt".`;
    case 'hubspot': {
      const action = c.action ?? 'note';
      if (!HUBSPOT_ACTIONS.has(action)) return `${name}: unknown HubSpot action "${action}".`;
      if (action === 'read') {
        if (!str(c.object)) return `${name}: a HubSpot read needs the object to read.`;
        if (!Array.isArray(c.fields) || !c.fields.length || c.fields.some(f => !str(f))) return `${name}: a HubSpot read needs at least one field.`;
        return null;
      }
      if (action.startsWith('update_')) {
        const ok = c.fill === 'ai' ? (Array.isArray(c.ai_fields) && c.ai_fields.some(Boolean)) : (Array.isArray(c.properties) && c.properties.some(p => str(p?.name)));
        return ok ? null : `${name}: a HubSpot update needs the fields to set.`;
      }
      if (action === 'task') return c.task_from === 'call' || str(c.title) ? null : `${name}: a HubSpot task needs a title.`;
      return null;
    }
    case 'gmail': {
      if (!str(c.to) || !str(c.body)) return `${name}: an email needs who it goes to and its body.`;
      const box = c.send_from?.id;
      if (!box) return `${name}: choose the mailbox it is drafted in or sent from (send_from).`;
      if (mailboxIds && !mailboxIds.has(box)) return `${name}: mailbox ${box} is not a connected mailbox. Use one from the mailboxes tool.`;
      return null;
    }
    case 'email':
      return str(c.to) && str(c.body) ? null : `${name}: an email needs who it goes to and its body.`;
    case 'slack':
      if (c.action === 'dm') {
        if (!str(c.user_id)) return `${name}: a Slack direct message needs the person's user_id.`;
        if (slackUserIds && !slackUserIds.has(c.user_id)) return `${name}: Slack user ${c.user_id} was not found in the connected Slack.`;
        return null;
      }
      if (!str(c.channel_id)) return `${name}: a Slack post needs the channel's id (channel_id) from the slack_channels tool, not only its name.`;
      if (slackChannelIds && !slackChannelIds.has(c.channel_id)) return `${name}: Slack channel ${c.channel_id}${c.channel ? ` (#${String(c.channel).replace(/^#/, '')})` : ''} was not found in the connected Slack.`;
      return null;
    case 'webhook':
      return /^https:\/\/\S+$/i.test(String(c.url ?? '')) ? null : `${name}: a webhook needs an https:// URL.`;
    case 'only_if':
      return Array.isArray(c.rules) && c.rules.length && c.rules.every(r => str(r?.field)) ? null : `${name}: "Only if" needs at least one rule with a field.`;
    case 'wait':
      return `${name}: Wait steps do not run yet. Leave it out.`;
    case 'approval':
      return null;
    case 'dataset_append':
    case 'dataset_read': {
      // A box table (GET-874): its key must be one the box has or this proposal creates.
      const key = str(c.dataset_key);
      if (!DATASET_KEY.test(key)) return `${name}: set dataset_key to the key of one of this box's tables (revbox_datasets) or of a table in this proposal's datasets.`;
      if (tables && !tables.has(key)) return `${name}: this box has no table "${key}" and the proposal does not create one. Use a key from revbox_datasets, or add the table to datasets.`;
      if (s.type === 'dataset_append') return c.dedupe_from == null || DEDUPE_FROM.includes(c.dedupe_from) ? null : `${name}: dedupe_from is one of ${DEDUPE_FROM.join(', ')}.`;
      if (c.window != null && !DATASET_WINDOWS.includes(c.window)) return `${name}: window is one of ${DATASET_WINDOWS.join(', ')}.`;
      if (c.limit != null && !(Number.isInteger(c.limit) && c.limit >= 1 && c.limit <= 500)) return `${name}: limit is a whole number of rows from 1 to 500.`;
      return null;
    }
    default:
      return `${name}: unknown step type "${s.type}".`;
  }
}

function triggerProblems(t, { nested = false } = {}) {
  const out = [];
  if (!isObj(t)) return ['The proposal needs a trigger.'];
  if (!BUILDER_TRIGGERS.has(t.kind)) out.push(`Trigger "${t.kind}" has no runner. Use one of: ${[...BUILDER_TRIGGERS].join(', ')}.`);
  if (t.config != null && !isObj(t.config)) out.push('The trigger config must be an object.');
  const c = isObj(t.config) ? t.config : {};
  if (t.timezone != null && (typeof t.timezone !== 'string' || !validTimezone(t.timezone))) out.push(`"${t.timezone}" is not a timezone. Use an IANA name such as America/Toronto.`);
  if (t.kind === 'clock') {
    if (!FREQUENCIES.has(c.frequency)) out.push('A schedule needs a frequency: daily, weekly, monthly or quarterly.');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(c.at ?? ''))) out.push('A schedule needs a time as HH:MM.');
  }
  if (t.kind === 'before_meeting' && c.offset != null && !(Number(c.offset) > 0)) out.push('"Before a meeting" needs a positive offset in minutes.');
  if (t.kind === 'hubspot_field_changed' && (!str(c.object) || !str(c.property))) out.push('A HubSpot field trigger needs the object and the property to watch.');
  if (nested) return out;
  // Several signals (GET-873): the extra triggers in config.also, each checked like the primary. A
  // schedule runs on its slot and never also on an event.
  if (c.also != null) {
    if (!Array.isArray(c.also)) out.push('trigger.config.also must be a list of { kind, config } triggers.');
    else {
      if (c.also.length > MAX_ALSO_TRIGGERS) out.push(`A job starts on at most ${MAX_ALSO_TRIGGERS + 1} triggers.`);
      if (c.also.length && SOLO_TRIGGER_KINDS.has(t.kind)) out.push('A schedule cannot be combined with signals: a job runs either on a schedule or when its signals happen. Drop trigger.config.also, or use only event signals.');
      for (const x of c.also) {
        if (!isObj(x) || typeof x.kind !== 'string') { out.push('Every trigger in trigger.config.also needs a kind and a config.'); continue; }
        if (SOLO_TRIGGER_KINDS.has(x.kind)) { out.push(`"${x.kind}" cannot be combined with other triggers: a job runs either on a schedule or when its signals happen.`); continue; }
        out.push(...triggerProblems(x, { nested: true }).map(e => `Extra trigger "${x.kind}": ${e}`));
      }
    }
  }
  if (t.signal_keys != null) {
    const keys = t.signal_keys;
    if (!Array.isArray(keys) || !keys.length || keys.length > MAX_ALSO_TRIGGERS + 1 || keys.some(k => !str(k))) out.push('trigger.signal_keys must be a list of signal_catalog keys.');
    else if (keys.length > 1 && keys.includes('schedule')) out.push('A schedule cannot be combined with signals: a job runs either on a schedule or when its signals happen.');
  }
  return out;
}

/** The trigger's config as it is saved: config.also as given, and the signal keys (GET-873) beside it. */
function savedTriggerConfig(t) {
  const config = isObj(t?.config) ? { ...t.config } : {};
  const keys = Array.isArray(t?.signal_keys) ? t.signal_keys.map(str).filter(Boolean) : null;
  if (keys?.length) config.signal_keys = [...new Set(keys)];
  if (Array.isArray(config.also) && !config.also.length) delete config.also;
  return config;
}

/** The proposal's steps without any box-delivery step (approve adds it back from uses_box_delivery). */
const proposedSteps = (steps) => (Array.isArray(steps) ? steps.filter(s => s?.type !== 'revbox_delivery') : steps);

/** Which display `tool` may label which step type. The card's title is the model's words; the tool is not. */
export const DISPLAY_TOOLS = { hubspot: ['hubspot'], slack: ['slack'], gmail: ['gmail'], email: ['email'], webhook: ['webhook'], agent: ['ai', 'agent'], approval: ['approval'], only_if: ['only_if'], wait: ['wait'], dataset_append: ['dataset_append', 'dataset'], dataset_read: ['dataset_read', 'dataset'] };

const list = (v) => (Array.isArray(v) ? v : v ? [...v] : []);
const byId = (items, key) => new Map(list(items).filter(x => isObj(x) && x.id).map(x => [String(x.id), x[key] ?? x.name ?? null]));
const addresses = (...vs) => vs.flatMap(v => (Array.isArray(v) ? v : String(v ?? '').split(/[,;]/))).map(x => String(x).trim()).filter(Boolean);
function urlParts(raw) {
  const url = String(raw ?? '').trim();
  try { return { url, host: new URL(url).host }; } catch { return { url, host: null }; }
}

/** What one real step touches, read from its config (never from `display`). */
function stepFact(s, { channels, people, boxes, tables }) {
  const c = isObj(s.config) ? s.config : {};
  const base = { step_id: String(s.id ?? ''), type: String(s.type ?? ''), external: false };
  switch (s.type) {
    case 'slack': {
      if (c.action === 'dm') {
        const uid = str(c.user_id);
        const who = people.get(uid);
        return { ...base, action: 'dm', user_id: uid, user: who ?? null, target: who ? `DM to ${who} (${uid})` : `DM to Slack user ${uid || '(none)'}` };
      }
      const id = str(c.channel_id);
      const real = channels.get(id);
      const said = str(c.channel).replace(/^#/, '');
      const target = real ? `#${String(real).replace(/^#/, '')} (${id})`
        : `Slack channel ${id || '(none)'}${said ? ` (named "${said}" by the builder, not checked)` : ''}`;
      return { ...base, action: 'channel', channel_id: id, channel: real ? String(real).replace(/^#/, '') : null, target };
    }
    case 'webhook': {
      const { url, host } = urlParts(c.url);
      return { ...base, external: true, url, host, sends_to: [host ?? url], target: `POST ${url}` };
    }
    case 'gmail':
    case 'email': {
      const recipients = addresses(c.to, c.cc, c.bcc);
      const mid = s.type === 'gmail' ? str(c.send_from?.id) : '';
      const mailbox = mid ? (boxes.get(mid) ?? null) : null;
      const from = s.type === 'gmail' ? (mailbox ?? (mid ? `mailbox ${mid} (not checked)` : '(no mailbox)')) : 'the OpenNous sender';
      const verb = s.type === 'gmail' && c.mode === 'draft' ? 'Draft' : 'Send';
      return { ...base, external: true, mode: s.type === 'gmail' ? (c.mode ?? 'send') : 'send', recipients, mailbox: mailbox ?? (mid || null), sends_to: recipients,
        target: `${verb} to ${recipients.join(', ') || '(no recipient)'} from ${from}` };
    }
    case 'hubspot': {
      const action = c.action ?? 'note';
      const write = action !== 'read';
      const object = str(c.object) || (action.startsWith('update_') ? action.slice(7) : action === 'read' ? '' : 'record');
      const fields = action === 'read' ? list(c.fields).map(String)
        : action.startsWith('update_') ? (c.fill === 'ai' ? list(c.ai_fields).map(String) : list(c.properties).map(p => str(p?.name)).filter(Boolean)) : [];
      const label = str(c.object_label);
      const obj = label && object && label !== object ? `${label} (${object})` : (object || label);
      const what = action === 'read' ? `Read ${obj}` : action === 'note' ? 'Create a note' : action === 'task' ? 'Create a task' : `Write ${obj}`;
      return { ...base, action, access: write ? 'write' : 'read', object: object || null, fields, target: `HubSpot: ${what}${fields.length ? `: ${fields.join(', ')}` : ''}` };
    }
    case 'agent': {
      const model = str(c.model) || 'opennous';
      return { ...base, model, mode: c.mode === 'pick' ? 'pick' : 'write', job: c.mode === 'pick' ? (c.job ?? null) : null, target: `AI (${model})${c.mode === 'pick' && c.job ? `: ${c.job}` : ''}` };
    }
    case 'dataset_append':
    case 'dataset_read': {
      // The table's name is the box's own, or the one this proposal creates under that key.
      const key = str(c.dataset_key);
      const t = tables.get(key) ?? null;
      const named = `the table ${t?.name ? `"${t.name}" (${key}${t.exists ? '' : ', new'})` : key || '(none)'}`;
      const fact = { ...base, action: s.type === 'dataset_append' ? 'append' : 'read', dataset_key: key || null, dataset: t?.name ?? null, new_dataset: !!t && !t.exists };
      if (s.type === 'dataset_append') {
        const dedupe = DEDUPE_FROM.includes(c.dedupe_from) ? c.dedupe_from : 'deal';
        return { ...fact, dedupe_from: dedupe, target: `Add a row to ${named}${dedupe === 'none' ? '' : `, one per ${dedupe}`}` };
      }
      const window = DATASET_WINDOWS.includes(c.window) ? c.window : 'all';
      return { ...fact, window, target: `Read ${named}: ${WINDOW_WORDS[window]}` };
    }
    case 'approval': return { ...base, target: 'Waits for a person to approve' };
    case 'only_if': return { ...base, target: `Only if ${list(c.rules).map(r => [r?.field, r?.op, r?.value].filter(x => x != null && x !== '').join(' ')).join(c.match === 'any' ? ' or ' : ' and ') || '(no rule)'}` };
    default: return { ...base, target: `${s.type} step` };
  }
}

/**
 * The facts the approve card shows under each of the model's titles, derived from the REAL steps
 * (one per step, in order): Slack channel name + id or DM user, webhook URL and host, email
 * recipients and sending mailbox, HubSpot object + fields + read/write, AI model. Names come from
 * the lookups, never from the model: `slackChannels` [{ id, name }], `slackPeople` [{ id, name }],
 * `mailboxes` [{ id, email }]. Pure.
 */
export function proposalFacts(proposal, { slackChannels = null, slackPeople = null, mailboxes = null, datasets = null } = {}) {
  const steps = proposedSteps(proposal?.steps);
  if (!Array.isArray(steps)) return [];
  const ctx = { channels: byId(slackChannels, 'name'), people: byId(slackPeople, 'name'), boxes: byId(mailboxes, 'email'), tables: tableNames(proposal, datasets) };
  return steps.filter(isObj).map(s => stepFact(s, ctx));
}

/**
 * The tables a proposal's steps may use (GET-874): key -> { name, exists }. The box's own (`datasets`,
 * [{ key, name }]) win over a proposed one with the same key: approve reuses those, never changes them.
 */
function tableNames(proposal, datasets) {
  const out = new Map();
  for (const d of list(proposal?.datasets)) {
    if (!isObj(d)) continue;
    const key = str(d.key) || datasetSlug(d.name, 56);
    if (key && !out.has(key)) out.set(key, { name: str(d.name) || key, exists: false });
  }
  for (const d of list(datasets)) if (isObj(d) && str(d.key)) out.set(str(d.key), { name: str(d.name) || str(d.key), exists: true });
  return out;
}

/**
 * The proposal's `datasets` checked: [{ key?, name, description?, columns }], up to 5, the key the name
 * slugged when missing, columns as normalizeDatasetColumns has them. `exists` = the box already has that
 * key (approve reuses it as it is). -> { errors, datasets }
 */
function proposedDatasets(raw, existing) {
  if (raw == null) return { errors: [], datasets: [] };
  if (!Array.isArray(raw)) return { errors: ['datasets must be a list of { key, name, description?, columns }.'], datasets: [] };
  if (raw.length > MAX_PROPOSED_DATASETS) return { errors: [`A proposal creates at most ${MAX_PROPOSED_DATASETS} tables.`], datasets: [] };
  const errors = [], out = [], seen = new Set();
  for (const d of raw) {
    if (!isObj(d)) { errors.push('Every table in datasets needs a name and columns.'); continue; }
    const name = str(d.name);
    if (!name || name.length > 120) { errors.push('Every table in datasets needs a name of up to 120 characters.'); continue; }
    const key = d.key == null || d.key === '' ? datasetSlug(name, 56) : str(d.key);
    if (!DATASET_KEY.test(key)) { errors.push(`Table "${name}": a key is lowercase letters, digits or underscores, starting with a letter.`); continue; }
    if (seen.has(key)) { errors.push(`Table key "${key}" is proposed twice.`); continue; }
    seen.add(key);
    if (d.description != null && (typeof d.description !== 'string' || d.description.length > 2000)) { errors.push(`Table "${name}": the description is text of up to 2,000 characters.`); continue; }
    const cols = normalizeDatasetColumns(d.columns);
    if (cols.error) { errors.push(`Table "${name}": ${cols.error}`); continue; }
    out.push({ key, name, description: str(d.description), columns: cols.columns, exists: !!existing?.has(key) });
  }
  return { errors, datasets: out };
}

/** A box destination's Slack target as an id or a bare channel name. */
const slackTargets = (boxDestinations) => new Set(list(boxDestinations)
  .flatMap(d => (typeof d === 'string' ? [d] : isObj(d) && (d.kind ?? 'slack') === 'slack' ? [d.target, d.channel_id, d.channel] : []))
  .filter(Boolean).map(t => String(t).trim().replace(/^#/, '').toLowerCase()));
/** Everyone a box destination already emails: an email destination's `target`, a Gmail draft's `to`. */
const mailTargets = (boxDestinations) => new Set(list(boxDestinations).filter(d => isObj(d) && (d.kind === 'email' || d.kind === 'gmail'))
  .flatMap(d => addresses(d.kind === 'email' ? (d.to ?? d.target) : d.to, d.cc)).map(a => a.toLowerCase()));

/**
 * Check a proposed job (pure; the builder's `propose_job` and approve both run it). Returns
 * { ok, errors[], facts[] } and, when ok, the cleaned `steps` and `trigger`. `facts` is
 * proposalFacts(): attach it to the proposal the card shows. `slackChannelIds`, `slackUserIds` and
 * `mailboxIds` are what the workspace really has; pass null to skip that lookup (shape only). The
 * optional `slackChannels`/`slackPeople`/`mailboxes` ({ id, name|email } lists) name the facts' targets
 * (and stand in for the id lists when those are not given). `boxDestinations` is the box's current
 * delivery list; with uses_box_delivery, an explicit Slack post to one of them is refused (it would post twice).
 */
export function validateBuilderProposal(proposal, { slackChannelIds = null, slackUserIds = null, mailboxIds = null, slackChannels = null, slackPeople = null, mailboxes = null, boxDestinations = null, datasets = null } = {}) {
  const errors = [];
  if (!isObj(proposal)) return { ok: false, errors: ['The proposal must be an object.'], facts: [] };
  const ids = (given, objs) => given ? new Set(given) : objs ? new Set(list(objs).map(x => x?.id).filter(Boolean)) : null;
  // The box's tables (GET-874), when known; null = shape only (any well-formed key).
  const boxTables = datasets ? new Set(list(datasets).map(d => str(d?.key)).filter(Boolean)) : null;
  const tables = proposedDatasets(proposal.datasets, boxTables);
  errors.push(...tables.errors);
  const lookups = {
    slackChannelIds: ids(slackChannelIds, slackChannels),
    slackUserIds: ids(slackUserIds, slackPeople),
    mailboxIds: ids(mailboxIds, mailboxes),
    tables: boxTables ? new Set([...boxTables, ...tables.datasets.map(d => d.key)]) : null,
  };
  const facts = proposalFacts({ ...proposal, datasets: tables.datasets }, { slackChannels, slackPeople, mailboxes, datasets });
  if (!str(proposal.name) || proposal.name.length > 120) errors.push('Give the job a name of up to 120 characters.');
  if (proposal.summary != null && (typeof proposal.summary !== 'string' || proposal.summary.length > 2000)) errors.push('The summary must be text of up to 2,000 characters.');
  errors.push(...triggerProblems(proposal.trigger));

  // checkFlow's shape rules.
  const steps = proposedSteps(proposal.steps);
  const clean = [];
  if (!Array.isArray(steps) || !steps.length) errors.push('Add at least one step.');
  else if (steps.length > MAX_STEPS) errors.push(`A job holds up to ${MAX_STEPS} steps.`);
  else {
    const ids = new Set();
    for (const s of steps) {
      if (!isObj(s)) { errors.push('Every step must be an object.'); continue; }
      const id = String(s.id ?? '');
      if (!STEP_ID.test(id)) { errors.push(`Step id "${id}" must be 1-40 letters, digits, "_" or "-".`); continue; }
      if (ids.has(id)) { errors.push(`Step id "${id}" is used twice.`); continue; }
      ids.add(id);
      if (!BUILDER_STEP_TYPES.has(s.type)) { errors.push(`Step "${id}": unknown step type "${s.type}".`); continue; }
      if (s.config != null && !isObj(s.config)) { errors.push(`Step "${id}": config must be an object.`); continue; }
      clean.push({ id, type: s.type, config: isObj(s.config) ? s.config : {} });
    }
    for (const s of clean) { const p = stepProblem(s, lookups); if (p) errors.push(p); }
    // Add to table writes the AI step before it as a row; Read table hands its rows to the AI step after it (GET-874).
    clean.forEach((s, i) => {
      if (s.type === 'dataset_append' && !clean.slice(0, i).some(x => x.type === 'agent')) errors.push(`Step "${s.id}": Add to table writes the output of an AI step before it as one row. Put an AI step (type agent) before it.`);
      if (s.type === 'dataset_read' && !clean.slice(i + 1).some(x => x.type === 'agent')) errors.push(`Step "${s.id}": Read table hands its rows to an AI step after it. Put an AI step (type agent) after it.`);
    });
    // {{steps.X.output}} reads a step that ran before it and wrote something: an AI step or a read (HubSpot, a table).
    clean.forEach((s, i) => {
      for (const m of JSON.stringify(s.config).matchAll(STEP_REF)) {
        const at = clean.findIndex(x => x.id === m[1]);
        if (at < 0) errors.push(`Step "${s.id}" reads {{steps.${m[1]}.output}}, but there is no step "${m[1]}".`);
        else if (at >= i) errors.push(`Step "${s.id}" reads {{steps.${m[1]}.output}}, but that step runs after it.`);
        else if (!(clean[at].type === 'agent' || clean[at].type === 'dataset_read' || (clean[at].type === 'hubspot' && clean[at].config.action === 'read'))) errors.push(`Step "${s.id}" reads {{steps.${m[1]}.output}}, but step "${m[1]}" writes no output.`);
      }
    });
    const tc = isObj(proposal.trigger?.config) ? proposal.trigger.config : {};
    if (JSON.stringify({ clean, tc }).length > MAX_FLOW_BYTES) errors.push('That job is larger than a job should be.');
  }

  // The card the person approves shows every step, and nothing that is not one.
  if (!Array.isArray(proposal.display)) errors.push('The proposal needs a display line for every step.');
  else {
    const shown = new Set();
    for (const d of proposal.display) {
      if (!isObj(d) || !str(d.step_id) || !str(d.title)) { errors.push('Every display line needs a step_id and a title.'); continue; }
      const step = clean.find(s => s.id === d.step_id);
      if (!step) errors.push(`Display line "${d.title}" points at no step ("${d.step_id}").`);
      else if (d.tool != null && !(DISPLAY_TOOLS[step.type] ?? [step.type]).includes(d.tool)) errors.push(`Display line "${d.title}" says tool "${d.tool}", but step "${step.id}" is a ${step.type} step. Use tool "${(DISPLAY_TOOLS[step.type] ?? [step.type])[0]}" and a title that says what it really does.`);
      if (shown.has(d.step_id)) errors.push(`Step "${d.step_id}" has more than one display line.`);
      shown.add(d.step_id);
    }
    for (const s of clean) if (!shown.has(s.id)) errors.push(`Step "${s.id}" has no display line.`);
  }
  if (proposal.uses_box_delivery != null && typeof proposal.uses_box_delivery !== 'boolean') errors.push('uses_box_delivery must be true or false.');
  if (proposal.box_delivery_format != null && (!['report', 'alert', 'handoff', 'digest', 'notification', 'plain'].includes(proposal.box_delivery_format) || proposal.uses_box_delivery !== true)) errors.push('box_delivery_format must be one of report, alert, handoff, digest, notification or plain, and only with uses_box_delivery.');
  // The box already posts there at the end of the job: an explicit step to the same channel posts twice.
  if (proposal.uses_box_delivery === true && boxDestinations) {
    const targets = slackTargets(boxDestinations);
    const names = byId(slackChannels, 'name');
    for (const s of clean) {
      if (s.type !== 'slack' || s.config.action === 'dm') continue;
      const id = str(s.config.channel_id);
      const name = String(names.get(id) ?? '').replace(/^#/, '').toLowerCase();
      if ((id && targets.has(id.toLowerCase())) || (name && targets.has(name))) errors.push(`Step "${s.id}" posts to Slack channel ${name ? `#${name} ` : ''}(${id}), which is already one of this box's destinations, so it would be posted twice. Drop the explicit step "${s.id}" or set uses_box_delivery to false.`);
    }
    // The same for email (GET-868): a gmail/email step to someone a box email or Gmail destination
    // already reaches would mail them twice.
    const mailed = mailTargets(boxDestinations);
    for (const s of clean) {
      if (s.type !== 'gmail' && s.type !== 'email') continue;
      const twice = addresses(s.config.to, s.config.cc, s.config.bcc).filter(a => mailed.has(a.toLowerCase()));
      if (twice.length) errors.push(`Step "${s.id}" emails ${twice.join(', ')}, who already gets this job's output from one of this box's destinations, so they would get it twice. Drop the explicit step "${s.id}" (or those recipients) or set uses_box_delivery to false.`);
    }
  }
  if (proposal.warnings != null && (!Array.isArray(proposal.warnings) || proposal.warnings.some(w => !isObj(w) || !WARNING_KINDS.has(w.kind) || !str(w.message)))) errors.push(`Every warning needs a kind (${[...WARNING_KINDS].join(', ')}) and a message.`);
  if (proposal.assumptions != null && (!Array.isArray(proposal.assumptions) || proposal.assumptions.some(a => typeof a !== 'string'))) errors.push('Assumptions must be a list of sentences.');
  if (proposal.estimated_credits_per_run != null && !(Number.isFinite(proposal.estimated_credits_per_run) && proposal.estimated_credits_per_run >= 0)) errors.push('estimated_credits_per_run must be a number of credits.');
  // The jobs still to set up in this chat (chaining): short names, shown under the card.
  if (proposal.next_jobs != null && (!Array.isArray(proposal.next_jobs) || proposal.next_jobs.length > MAX_NEXT_JOBS || proposal.next_jobs.some(j => !str(j) || j.length > 120))) errors.push(`next_jobs must be a list of up to ${MAX_NEXT_JOBS} job names of up to 120 characters.`);

  if (errors.length) return { ok: false, errors, facts };
  // The card's sentence (GET-884): built from the trigger, the steps and these facts, never the model's words.
  return { ok: true, errors: [], facts, brief: jobBrief(proposal, facts), steps: clean, datasets: tables.datasets, trigger: { kind: proposal.trigger.kind, config: savedTriggerConfig(proposal.trigger), timezone: proposal.trigger.timezone || 'UTC' } };
}

/** The legacy schedule columns. Mirrors scheduleColumns in apps/api/src/lib/flows.mjs. */
export function builderScheduleColumns(when, tc) {
  return {
    trigger_kind: when,
    frequency: when === 'clock' ? String(tc.frequency ?? 'daily') : null,
    at_time: when === 'clock' ? String(tc.at ?? '08:00') : null,
    offset_minutes: when === 'before_meeting' ? (Number(tc.offset) || 30) : null,
    tools: Array.isArray(tc.tools) && tc.tools.length ? tc.tools.map(String) : null,
  };
}

/** The legacy destination columns. Mirrors destinationColumns in apps/api/src/lib/flows.mjs. */
export function builderDestinationColumns(steps) {
  const s = steps.find(x => x.type === 'slack' || x.type === 'email' || x.type === 'webhook');
  if (!s) return { destination: 'none', destination_target: null };
  if (s.type === 'slack') return { destination: 'slack', destination_target: String(s.config.channel ?? '').trim() || null };
  if (s.type === 'webhook') return { destination: 'webhook', destination_target: String(s.config.url ?? '').trim() || null };
  const to = [s.config.to, s.config.cc].map(x => String(x ?? '').trim()).filter(Boolean).join(', ');
  return { destination: 'email', destination_target: to || null };
}

/**
 * The first AI step as the legacy artifact/prompt pair, the way the automation editor sends it: the
 * event runners write that step from these columns. A step on your own model sends words only.
 */
function legacyAgentColumns(steps) {
  const a = steps.find(s => s.type === 'agent');
  if (!a) return { artifact: null, prompt: null };
  const c = a.config;
  const extra = str(c.extra);
  if (c.mode !== 'pick') return { artifact: null, prompt: str(c.prompt) || null };
  const words = [JOB_PROMPTS[c.job], extra].filter(Boolean).join('\n\n') || null;
  if (c.model && c.model !== 'opennous') return { artifact: null, prompt: words };
  return JOB_ARTIFACTS[c.job] ? { artifact: JOB_ARTIFACTS[c.job], prompt: extra || null } : { artifact: null, prompt: words };
}

/** A checked proposal as agent_routines columns (pure). The box-delivery step ends the flow when asked for. */
export function builderRoutineColumns(proposal, checked) {
  const steps = [...checked.steps];
  if (proposal.uses_box_delivery) {
    let id = BOX_DELIVERY_STEP;
    for (let n = 2; steps.some(s => s.id === id); n++) id = `${BOX_DELIVERY_STEP}_${n}`;
    // The Slack layout the agent chose for the box's Slack destinations (GET-872), on the step itself.
    steps.push({ id, type: 'revbox_delivery', config: proposal.box_delivery_format ? { format: proposal.box_delivery_format } : {} });
  }
  const { kind, config, timezone } = checked.trigger;
  return {
    name: str(proposal.name).slice(0, 120),
    ...legacyAgentColumns(steps),
    ...builderScheduleColumns(kind, config),
    ...builderDestinationColumns(steps),
    steps,
    trigger_config: config,
    timezone,
  };
}

// ── Sessions ─────────────────────────────────────────────────────────────────

async function boxRoutine(sb, ws, revboxId, routineId) {
  return one(sb.from('agent_routines').select('*').eq('workspace_id', ws).eq('revbox_id', revboxId).eq('id', routineId).maybeSingle());
}

/** A new builder chat on a box (edit rights), optionally on one of its jobs ("Make changes"). */
export async function createBuilderSession(sb, { workspaceId, revboxId, userId, jobId = null }) {
  await loadRevbox(sb, workspaceId, userId, revboxId, true);
  if (jobId && !(await boxRoutine(sb, workspaceId, revboxId, jobId))) fail(404, 'Job not found.');
  return one(sb.from('revbox_builder_sessions').insert({ workspace_id: workspaceId, revbox_id: revboxId, user_id: userId, job_id: jobId, state: 'open', messages: [] }).select('*').single());
}

/**
 * One session, or null. Only the person who started it may read it (another editor gets null).
 * Throws as loadRevbox does when the person cannot edit its box. `revboxId`, when given, must match.
 */
export async function getBuilderSession(sb, { workspaceId, userId, sessionId, revboxId = null }) {
  const session = await one(sb.from('revbox_builder_sessions').select('*').eq('workspace_id', workspaceId).eq('id', sessionId).maybeSingle());
  if (!session || (revboxId && session.revbox_id !== revboxId)) return null;
  await loadRevbox(sb, workspaceId, userId, session.revbox_id, true);
  if (!userId || session.user_id !== userId) return null;
  return session;
}

/**
 * Write what a turn changed: messages and/or proposal, and updated_at. Never the state: a turn that
 * finishes after Approve must not reopen the session, so the write only lands while it is still
 * open (otherwise it is a no-op). `state` is accepted for older callers and ignored; state changes
 * go through setBuilderSessionState. Pass `userId` to bind the write to the session's creator.
 *
 * `expectUpdatedAt` (GET-889, two tabs on one chat): the session's updated_at when the turn read it.
 * The write lands only if nobody saved it since, so a second tab's turn never silently replaces the
 * first one's transcript. -> true when a row was written, false when nothing matched (closed,
 * someone else's, or changed meanwhile).
 */
export async function saveBuilderSession(sb, { workspaceId, sessionId, userId = null, messages, proposal, expectUpdatedAt = null }) {
  const patch = { updated_at: now() };
  if (messages !== undefined) { if (!Array.isArray(messages)) fail(400, 'messages must be a list.'); patch.messages = messages; }
  if (proposal !== undefined) { if (proposal !== null && !isObj(proposal)) fail(400, 'proposal must be an object.'); patch.proposal = proposal; }
  let q = sb.from('revbox_builder_sessions').update(patch).eq('workspace_id', workspaceId).eq('id', sessionId).eq('state', 'open');
  if (userId) q = q.eq('user_id', userId);
  if (expectUpdatedAt) q = q.eq('updated_at', expectUpdatedAt);
  return (await rows(q.select('id'))).length > 0;
}

/** The one explicit way to change a session's state (open, approved, abandoned). The session's creator only. */
export async function setBuilderSessionState(sb, { workspaceId, sessionId, userId, state }) {
  if (!['open', 'approved', 'abandoned'].includes(state)) fail(400, 'Unknown session state.');
  const row = await one(sb.from('revbox_builder_sessions').update({ state, updated_at: now() })
    .eq('workspace_id', workspaceId).eq('id', sessionId).eq('user_id', userId).select('*').maybeSingle());
  if (!row) fail(404, 'Builder session not found.');
  return row;
}

/** Whether `userId` owns the box or administers the workspace: who may take over another person's job. */
async function mayTakeOverJob(sb, workspaceId, box, userId) {
  if (box.access === 'owner' || box.owner_id === userId) return true;
  const member = await one(sb.from('workspace_members').select('role').eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle());
  return ['admin', 'owner'].includes(member?.role);
}

/**
 * Approve a proposal: check it, create the box's routine (or update the job the session edits),
 * switch it on, and mark the session approved. The session is claimed first, so pressing Approve
 * twice makes one job. Only the session's creator may approve it. Pass
 * `slackChannelIds`/`mailboxIds` (and optionally `slackChannels`/`slackPeople`/`mailboxes`/
 * `boxDestinations`, as validateBuilderProposal takes them) to re-check targets now.
 *
 * Switching on (GET-868 polish): approving IS switching the job on, after the checks the enable
 * endpoint makes. The trigger kind must have a runner (checked here); `enableCheck({ isNew, routineId,
 * trigger })` is the caller's part (credit gate, and the plan's automation limit for a new job): it
 * returns a reason string (or throws one) to leave the job off, null to switch it on. A failed check
 * never loses the work: the job is saved, off, and the reason comes back for the UI to show. A clock
 * job gets its next_run_at from the same scheduler (nextRunAt) the routine runner uses.
 *
 * Changing an existing job (Edit) that someone else owns needs the box owner or a workspace
 * admin/owner, and the job then runs as the approver (user_id = approver), so it never keeps acting
 * with the original owner's visibility on another person's say-so. The session is linked to the job
 * (job_id), so Edit can reopen the chat that made it (latestBuilderSessionForJob).
 *
 * An Edit keeps the job's current `enabled` (review 6): a paused job stays paused (no check runs), a
 * job that is on stays on after enableCheck (isNew false) passes. Only a new job defaults to on.
 *
 * `mailboxOwners` [{ id, email, user_id, user_name }] (review 8): a box Gmail destination whose
 * mailbox belongs to someone other than the approver (who owns the job from now on) is warned about
 * in `warnings` and in the stored proposal's warnings (kind mailbox_owner). The save is not refused.
 * -> { routine, facts, enabled, reason?, warnings? }
 */
export async function approveBuilderProposal(sb, { workspaceId, revboxId, userId, sessionId, proposal = null, name = null, slackChannelIds = null, slackUserIds = null, mailboxIds = null, slackChannels = null, slackPeople = null, mailboxes = null, boxDestinations = null, mailboxOwners = null, enableCheck = null }) {
  const box = await loadRevbox(sb, workspaceId, userId, revboxId, true);
  const session = await one(sb.from('revbox_builder_sessions').select('*').eq('workspace_id', workspaceId).eq('revbox_id', revboxId).eq('id', sessionId).maybeSingle());
  if (!session || session.user_id !== userId) fail(404, 'Builder session not found.');
  if (session.state !== 'open') fail(409, session.state === 'approved' ? 'This proposal was already approved.' : 'This builder session was closed.');
  // An inline rename on the card (`name`, or the route's proposal.name) wins over the proposed name.
  const base = proposal ?? session.proposal;
  if (!base) fail(400, 'There is no proposal to approve yet.');
  const p = str(name) ? { ...base, name: str(name) } : base;
  // The box's tables as they are now (GET-874), read here rather than taken from the caller.
  const boxTables = await rows(sb.from('revbox_datasets').select('key, name, columns').eq('workspace_id', workspaceId).eq('revbox_id', revboxId));
  const checked = validateBuilderProposal(p, { slackChannelIds, slackUserIds, mailboxIds, slackChannels, slackPeople, mailboxes, boxDestinations, datasets: boxTables });
  if (!checked.ok) throw Object.assign(new Error(`This job cannot run yet: ${checked.errors.join(' ')}`), { status: 400, errors: checked.errors });
  const cols = builderRoutineColumns(p, checked);

  // Edit: the job must still be there, and another person's job is the box owner's or an admin's to change.
  let existing = null;
  if (session.job_id) {
    existing = await boxRoutine(sb, workspaceId, revboxId, session.job_id);
    if (!existing) fail(404, 'The job this session was changing no longer exists.');
    if (existing.user_id !== userId && !(await mayTakeOverJob(sb, workspaceId, box, userId))) fail(403, 'This job belongs to someone else. Only its owner, the box owner or a workspace admin can change it.');
  }

  // May it run? A new job defaults to on; an Edit keeps the job as it is (a paused job stays paused).
  // The enable endpoint's checks run for a job that will be on, before anything is written; a "no" only keeps it off.
  const wantsOn = existing ? existing.enabled === true : true;
  let reason = null;
  if (wantsOn) {
    reason = BUILDER_TRIGGERS.has(cols.trigger_kind) ? null : 'This trigger is not connected yet.';
    if (!reason && enableCheck) {
      try { reason = (await enableCheck({ isNew: !existing, routineId: existing?.id ?? null, trigger: checked.trigger })) || null; }
      catch (e) { reason = str(e?.message) || 'This job could not be switched on.'; }
    }
  }
  const enabled = wantsOn && !reason;

  // The approver owns the job from now on; box Gmail drafts go out as the job's owner.
  const warnings = cols.steps.some(s => s.type === 'revbox_delivery') ? mailboxOwnerWarnings(box.delivery, mailboxOwners, userId) : [];
  const stored = { ...p, facts: checked.facts, brief: checked.brief };
  if (warnings.length || list(p.warnings).some(w => w?.kind === 'mailbox_owner')) stored.warnings = [...list(p.warnings).filter(w => w?.kind !== 'mailbox_owner'), ...warnings];

  const claimed = await one(sb.from('revbox_builder_sessions').update({ state: 'approved', proposal: stored, updated_at: now() })
    .eq('workspace_id', workspaceId).eq('id', sessionId).eq('user_id', userId).eq('state', 'open').select('*').maybeSingle());
  if (!claimed) fail(409, 'This proposal was already approved.');
  let routine;
  const tables = [];
  try {
    // The proposed tables first, so every step's dataset_key resolves when the job runs. A key the box
    // already has is reused as it is (jobs read it by key; its name and columns never change here).
    for (const d of checked.datasets ?? []) {
      const had = boxTables.find(t => t.key === d.key);
      if (had) { tables.push({ key: d.key, name: had.name, created: false }); continue; }
      try {
        const made = await createRevboxDataset(sb, { workspaceId, revboxId, userId, body: { key: d.key, name: d.name, description: d.description, columns: d.columns } });
        tables.push({ key: made.key, name: made.name, created: true });
      } catch (e) {
        if (e?.status !== 409) throw e;   // made meanwhile (another approval): reuse it
        tables.push({ key: d.key, name: d.name, created: false });
      }
    }
    const next = enabled ? nextRunAt({ ...cols, weekdays_only: cols.trigger_config?.weekdays_only === true }) : null;
    const write = { ...cols, enabled, next_run_at: next ? next.toISOString() : null, updated_at: now() };
    if (existing) {
      // The job runs as whoever approved this version of it.
      routine = await one(sb.from('agent_routines').update({ ...write, draft: null, edited_by: userId, user_id: userId })
        .eq('workspace_id', workspaceId).eq('revbox_id', revboxId).eq('id', existing.id).select('*').maybeSingle());
      if (!routine) fail(404, 'The job this session was changing no longer exists.');
    } else {
      routine = await one(sb.from('agent_routines').insert({ ...write, workspace_id: workspaceId, user_id: userId, revbox_id: revboxId }).select('*').single());
    }
  } catch (e) {
    await rows(sb.from('revbox_builder_sessions').update({ state: 'open', updated_at: now() }).eq('workspace_id', workspaceId).eq('id', sessionId)).catch(() => null);
    throw e;
  }
  // The chat that made the job belongs to it from now on (Edit reopens it).
  if (!session.job_id) await rows(sb.from('revbox_builder_sessions').update({ job_id: routine.id, updated_at: now() }).eq('workspace_id', workspaceId).eq('id', sessionId));
  const nextJobs = list(p.next_jobs).map(str).filter(Boolean);
  const chained = nextJobs.length ? await continueBuilderChat(sb, { workspaceId, revboxId, userId, messages: session.messages, approved: stored, routine, enabled, tables, nextJobs }) : null;
  return { routine, facts: checked.facts, enabled, ...(reason ? { reason } : {}), ...(warnings.length ? { warnings } : {}),
    ...(tables.length ? { datasets: tables } : {}), ...(chained ? { next_session_id: chained.id, next_jobs: nextJobs } : {}) };
}

/** How every approval note starts (APPROVED_NOTE for an Edit, chainedNote for a chat that goes on). */
const APPROVED_PREFIX = 'The user approved this proposal';
const CHAINED_PREFIX = `${APPROVED_PREFIX}; it is now a live job.`;
/** What the transcript records when a chat goes on to the next job after an approval. */
export function chainedNote({ name, enabled = true, tables = [], nextJobs = [] }) {
  const made = tables.map(t => `${t.key} ("${t.name}")`);
  return [
    `${CHAINED_PREFIX} It is saved as "${str(name)}"${enabled ? '' : ', switched off for now'}.`,
    made.length ? `The box has these tables now: ${made.join(', ')}. A later job reads or adds to them by that key; do not propose them again.` : '',
    `Jobs still to set up in this chat: ${nextJobs.join('; ')}.`,
    'Set up the next one as a NEW job and propose it with propose_job. Do not change or propose the approved job again.',
  ].filter(Boolean).join(' ');
}

/**
 * Chaining (GET-874): after an approval whose proposal names `next_jobs`, the chat goes on in a NEW
 * open session for the same person, on no job yet, seeded with this chat (the approved proposal
 * answered with chainedNote), so the next proposal makes a new job and its own Edit chat. The approved
 * session stays the first job's. A failure here never undoes the approval: no session, no chain.
 */
async function continueBuilderChat(sb, { workspaceId, revboxId, userId, messages, approved, routine, enabled, tables, nextJobs }) {
  try {
    const note = chainedNote({ name: routine?.name ?? approved?.name, enabled, tables, nextJobs });
    const seeded = seedTranscriptFromApproved(messages, approved, note);
    return await one(sb.from('revbox_builder_sessions').insert({ workspace_id: workspaceId, revbox_id: revboxId, user_id: userId, job_id: null, state: 'open', messages: seeded, proposal: null }).select('*').single());
  } catch (e) {
    console.error('[revbox-builder] continuing the chat failed', e?.message ?? e);
    return null;
  }
}

/**
 * The box's Gmail destinations whose mailbox someone other than `ownerId` owns, as warnings: the box
 * drafts as the job's owner, so those drafts would fail. `mailboxOwners` [{ id, email, user_id,
 * user_name }]; a mailbox not in it is not guessed about. Pure.
 */
export function mailboxOwnerWarnings(delivery, mailboxOwners, ownerId) {
  const owners = new Map(list(mailboxOwners).filter(m => isObj(m) && m.id).map(m => [String(m.id), m]));
  const out = [];
  for (const d of list(delivery)) {
    if (!isObj(d) || d.kind !== 'gmail') continue;
    const m = owners.get(str(d.target));
    if (!m || !m.user_id || m.user_id === ownerId) continue;
    const mailbox = str(m.email) || `mailbox ${str(d.target)}`;
    const owner = str(m.user_name) || 'someone else';
    out.push({ kind: 'mailbox_owner', destination_id: d.id ?? null, mailbox, owner,
      // The chosen mailbox drafts as its own owner (createFollowUpDraft), so this works, but the draft lands in
      // someone else's Drafts written with the job owner's access. Say so plainly.
      message: `Drafts go to ${owner}'s mailbox (${mailbox}) and are written with your access.`,
      fix: { label: `Pick a mailbox of yours for that destination if ${owner} shouldn't get them.` } });
  }
  return out;
}

// ── Edit: the job's own chat (GET-868 polish) ────────────────────────────────

/**
 * The most recent builder session of one of the box's jobs, or null. Box edit rights: any editor of
 * the box may open the job's chat history (only its creator may continue THAT session; Edit starts a
 * new one seeded from it). `approvedOnly` skips chats that never approved anything.
 */
export async function latestBuilderSessionForJob(sb, { workspaceId, revboxId, userId, jobId, approvedOnly = false }) {
  const { session } = await latestJobSession(sb, { workspaceId, revboxId, userId, jobId, approvedOnly });
  if (!session) return null;
  // Review 1: never the raw transcript. Tool results were read with its creator's visibility.
  return { ...session, messages: sanitizeBuilderTranscript(session.messages, { keepText: session.user_id === userId, approved: isObj(session.proposal) ? session.proposal : null }) };
}

/** The raw newest session of a job and the job itself. Internal: its transcript is the creator's. */
async function latestJobSession(sb, { workspaceId, revboxId, userId, jobId, approvedOnly = false }) {
  await loadRevbox(sb, workspaceId, userId, revboxId, true);
  const job = jobId ? await boxRoutine(sb, workspaceId, revboxId, jobId) : null;
  if (!job) fail(404, 'Job not found.');
  let q = sb.from('revbox_builder_sessions').select('*').eq('workspace_id', workspaceId).eq('revbox_id', revboxId).eq('job_id', jobId);
  if (approvedOnly) q = q.eq('state', 'approved');
  const found = await rows(q.order('updated_at', { ascending: false }).limit(20));
  const at = (r) => String(r.updated_at ?? r.created_at ?? '');
  return { job, session: found.reduce((best, r) => (!best || at(r) > at(best) ? r : best), null) };
}

/** What the transcript records once a proposal is approved and the chat is reopened to change it. */
export const APPROVED_NOTE = 'The user approved this proposal; it is now the live job. They reopened the chat to change it; their request follows.';
const NOT_RUN = 'Not run: the turn ended before this tool ran. Call it again if you still need it.';
/** What every carried-over tool result says instead of its body (review 1). */
export const RESULT_NOT_CARRIED = 'Result not carried over; call the tool again if needed.';
/** The model's opening line of a chat seeded from another person's approved job. */
const OTHER_EDITOR_NOTE = "[Context from the composer, not the user's words]\nThis job was set up earlier by someone else. Their conversation is not carried over; the approved setup follows. Call tools again for anything you need.";
const contentBlocks = (content) => (typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content.filter(isObj) : []);
const resultText = (b) => (typeof b.content === 'string' ? b.content : contentBlocks(b.content).filter(x => x.type === 'text').map(x => x.text ?? '').join('\n'));
const HINT_HEADER = "[Context from the composer, not the user's words]";
/** The user's own words: the composer's hint preamble (one block of lines, then a blank line) removed. */
function ownWords(t) {
  const s = String(t ?? '');
  if (!s.startsWith(HINT_HEADER)) return s.trim();
  const cut = s.indexOf('\n\n');
  return cut < 0 ? '' : s.slice(cut + 2).trim();
}

/**
 * An approved session's transcript as the start of a new one: the approved proposal is what the last
 * propose_job call says (so the model sees the job as it is, renamed or not), and every tool call the
 * last turn left open is answered, the proposal with APPROVED_NOTE. Stays valid Anthropic format.
 */
export function seedTranscriptFromApproved(messages, approved, note = APPROVED_NOTE) {
  const out = structuredClone(Array.isArray(messages) ? messages : []);
  const lastAt = out.length - 1;
  const last = out[lastAt];
  if (last?.role !== 'assistant' || !Array.isArray(last.content)) return out;
  const uses = last.content.filter(b => b?.type === 'tool_use');
  if (!uses.length) return out;
  const proposed = uses.find(b => b.name === 'propose_job');
  if (proposed && isObj(approved)) { const { facts: _f, brief: _b, ...input } = approved; proposed.input = input; }
  out.push({ role: 'user', content: uses.map(u => ({ type: 'tool_result', tool_use_id: u.id, content: u === proposed ? note : NOT_RUN })) });
  return out;
}

/** The tool results that are the user's own reply (an ask answered, words after a proposal), as the loop's closePending writes them. */
const OWN_REPLY = ['The user answered:', 'The user did not pick an option and wrote instead:', 'The proposal was shown to the user.'];
const ownReply = (t) => OWN_REPLY.some(x => t.startsWith(x));

/**
 * A builder transcript safe to hand to another session (review 1). Tool results were read with the
 * visibility of the person who ran them (reference documents, HubSpot rows, account searches), so
 * EVERY tool_result body becomes RESULT_NOT_CARRIED (our own APPROVED_NOTE / NOT_RUN markers stay,
 * and is_error is kept so a refused proposal stays refused); thinking blocks are dropped.
 * `keepText` (the same person continues): their text and the assistant's text and tool calls stay,
 * and so do their answers to an ask (GET-889: the user's own words, so the chat shows them again
 * after every approval; never a result a tool read).
 * Otherwise only the approved proposal is kept, as one answered-later propose_job call.
 * The result is valid Anthropic format: roles alternate, it starts with the user, and every tool_use
 * is answered in the next message (except a trailing one, which seedTranscriptFromApproved answers). Pure.
 */
export function sanitizeBuilderTranscript(messages, { keepText = false, approved = null } = {}) {
  if (!keepText) {
    if (!isObj(approved)) return [];
    const { facts: _f, brief: _b, ...input } = approved;
    return [
      { role: 'user', content: [{ type: 'text', text: OTHER_EDITOR_NOTE }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_approved_job', name: 'propose_job', input: structuredClone(input) }] },
    ];
  }
  const merged = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m?.role !== 'user' && m?.role !== 'assistant') continue;
    const content = [];
    for (const b of contentBlocks(m.content)) {
      if (b.type === 'text' && str(b.text)) content.push({ type: 'text', text: String(b.text) });
      else if (m.role === 'assistant' && b.type === 'tool_use' && b.id) content.push({ type: 'tool_use', id: b.id, name: b.name, input: isObj(b.input) ? structuredClone(b.input) : {} });
      else if (m.role === 'user' && b.type === 'tool_result' && b.tool_use_id) {
        const t = resultText(b);
        content.push({ type: 'tool_result', tool_use_id: b.tool_use_id, content: t === APPROVED_NOTE || t === NOT_RUN || t.startsWith(CHAINED_PREFIX) || (!b.is_error && ownReply(t)) ? t : RESULT_NOT_CARRIED, ...(b.is_error ? { is_error: true } : {}) });
      }
    }
    if (!content.length) continue;
    const prev = merged.at(-1);
    if (prev?.role === m.role) prev.content.push(...content);
    else merged.push({ role: m.role, content });
  }
  // Pair every tool_use with a result in the very next user message, results first; drop strays.
  const out = [];
  for (let i = 0; i < merged.length; i++) {
    const m = merged[i];
    if (m.role === 'assistant') { out.push(m); continue; }
    const prev = out.at(-1);
    const uses = prev?.role === 'assistant' ? prev.content.filter(b => b.type === 'tool_use').map(b => b.id) : [];
    const results = uses.map(id => m.content.find(b => b.type === 'tool_result' && b.tool_use_id === id) ?? { type: 'tool_result', tool_use_id: id, content: RESULT_NOT_CARRIED });
    const rest = m.content.filter(b => b.type !== 'tool_result');
    const content = [...results, ...rest];
    if (content.length) out.push({ role: 'user', content });
    else if (prev) out.pop();   // nothing left to say: the assistant turn before it cannot stand unanswered
  }
  // An assistant turn answered by nothing (but not the last) gets its results; it starts with the user.
  for (let i = 0; i < out.length - 1; i++) {
    if (out[i].role !== 'assistant' || out[i + 1].role !== 'assistant') continue;
    const uses = out[i].content.filter(b => b.type === 'tool_use');
    out.splice(i + 1, 0, { role: 'user', content: uses.length ? uses.map(u => ({ type: 'tool_result', tool_use_id: u.id, content: RESULT_NOT_CARRIED })) : [{ type: 'text', text: 'Continue.' }] });
  }
  if (out[0]?.role === 'assistant') out.unshift({ role: 'user', content: [{ type: 'text', text: OTHER_EDITOR_NOTE.split('\n')[0] + '\nEarlier conversation.' }] });
  return out;
}

/** "Question\n-> answer" blocks (the loop's renderAnswers) -> [{ question, answer }]. */
function parseAnswers(t) {
  return ownWords(t).split(/\n\n+/).map(chunk => {
    const at = chunk.lastIndexOf('\n-> ');
    return at < 0 ? null : { question: chunk.slice(0, at).trim(), answer: chunk.slice(at + 4).trim() };
  }).filter(Boolean);
}

/**
 * Whether the transcript ends on the user's turn with no reply (a turn that failed or was cut off):
 * their words, or tool results a turn was still working on. Our own seed notes (APPROVED_NOTE,
 * NOT_RUN, the chaining note) are not a turn. Pure.
 */
export function unanswered(messages) {
  const last = Array.isArray(messages) ? messages.at(-1) : null;
  if (last?.role !== 'user') return false;
  return contentBlocks(last.content).some(b => (b.type === 'text' && str(b.text))
    || (b.type === 'tool_result' && !(resultText(b).startsWith(APPROVED_PREFIX) || resultText(b) === NOT_RUN)));
}

/**
 * A builder transcript as the chat the UI shows again (Edit), pure: { role: 'user', text },
 * { role: 'assistant', text }, { kind: 'ask', questions, answers: [{ question, answer }] },
 * { kind: 'proposal', proposal, approved } and, last, { kind: 'failed', text } when the last turn got
 * no answer (GET-889). Tool calls, tool results, thinking and the composer's hint
 * preamble are left out; a proposal that did not validate, or a call that never ran, is not shown.
 * `proposal` is the session's own (validated, with facts) and stands in for its last propose_job;
 * `approved` says whether the session approved it (an earlier one was when APPROVED_NOTE answered it).
 */
export function builderSessionHistory(messages, { proposal = null, approved = false } = {}) {
  const items = [];
  const pending = new Map();   // tool_use id -> the item it made
  const say = (role, text) => {
    const t = String(text ?? '').trim();
    if (!t) return;
    const prev = items.at(-1);
    if (prev && prev.role === role && !prev.kind && role === 'assistant') prev.text = `${prev.text}\n\n${t}`;
    else items.push({ role, text: t });
  };
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m?.role === 'assistant') {
      for (const b of contentBlocks(m.content)) {
        if (b.type === 'text') say('assistant', b.text);
        else if (b.type === 'tool_use' && b.name === 'ask') {
          const item = { kind: 'ask', questions: Array.isArray(b.input?.questions) ? b.input.questions : [], answers: [] };
          items.push(item); pending.set(b.id, item);
        } else if (b.type === 'tool_use' && b.name === 'propose_job') {
          const item = { kind: 'proposal', proposal: isObj(b.input) ? b.input : {}, approved: false };
          items.push(item); pending.set(b.id, item);
        }
      }
    } else if (m?.role === 'user') {
      for (const b of contentBlocks(m.content)) {
        if (b.type === 'text') { say('user', ownWords(b.text)); continue; }
        if (b.type !== 'tool_result') continue;
        const item = pending.get(b.tool_use_id);
        if (!item) continue;
        pending.delete(b.tool_use_id);
        const t = resultText(b);
        if (b.is_error || t.startsWith('Not run')) { item.drop = true; continue; }
        if (item.kind === 'ask') {
          if (t.startsWith('The user answered:')) item.answers = parseAnswers(t.slice('The user answered:'.length).trim());
          else if (t.startsWith('The user did not pick an option and wrote instead:')) say('user', ownWords(t.slice(t.indexOf(':') + 1).trim()));
        } else if (item.kind === 'proposal' && t.startsWith(APPROVED_PREFIX)) item.approved = true;
      }
    }
  }
  const out = items.filter(i => !i.drop);
  // GET-889: a turn that failed (provider error, the tab closed mid-turn) saved the user's message
  // with no reply after it. Say so, so the person can try again; a seeded chat ends on our own notes.
  if (unanswered(messages)) out.push({ kind: 'failed', text: 'This message did not get an answer. Try again.' });
  const lastShown = [...out].reverse().find(i => i.kind === 'proposal');
  // The session's own proposal is its latest that validated: the last one still shown.
  if (lastShown) {
    if (isObj(proposal)) lastShown.proposal = proposal;
    if (approved) lastShown.approved = true;
  }
  return out.map(({ drop: _d, ...i }) => (i.kind === 'proposal' ? { ...i, proposal: withBrief(i.proposal) } : i));
}

/**
 * A proposal with its card sentence (GET-884): jobBrief from its own facts, or from facts derived from
 * its steps alone (nothing unchecked is named then). Older stored proposals have no brief. Pure.
 */
export function withBrief(p) {
  if (!isObj(p)) return p;
  return { ...p, brief: jobBrief(p, Array.isArray(p.facts) ? p.facts : proposalFacts(p)) };
}

/** Newest first: updated_at, then created_at. */
const byNewest = (a, b) => String(b.updated_at ?? b.created_at ?? '').localeCompare(String(a.updated_at ?? a.created_at ?? ''))
  || String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''));
/** Whether a session holds anything the person said (a seed alone does not). */
function saidSomething(messages) {
  return (Array.isArray(messages) ? messages : []).some(m => m?.role === 'user' && contentBlocks(m.content).some(b =>
    (b.type === 'text' && ownWords(b.text)) || (b.type === 'tool_result' && ownReply(resultText(b)))));
}
/** Close every tool call the transcript left open with NOT_RUN (a closed chat carried into a new one). */
function closeOpenCalls(messages) {
  const out = structuredClone(Array.isArray(messages) ? messages : []);
  const last = out.at(-1);
  const uses = last?.role === 'assistant' && Array.isArray(last.content) ? last.content.filter(b => b?.type === 'tool_use') : [];
  if (uses.length) out.push({ role: 'user', content: uses.map(u => ({ type: 'tool_result', tool_use_id: u.id, content: NOT_RUN })) });
  return out;
}
/**
 * A person's chat brought up to a job someone else approved since (GET-889): the job as it is now
 * becomes an approved propose_job at the end, introduced in one line, so the model and the card both
 * start from the live job. Valid Anthropic format. Pure.
 */
export function withNewerSetup(messages, approved, who = 'someone else') {
  const out = closeOpenCalls(messages);
  const intro = { type: 'text', text: `${HINT_HEADER}\nThe job was changed since by ${who}; its current setup follows.` };
  const last = out.at(-1);
  if (last?.role === 'user') last.content = [...contentBlocks(last.content), intro];
  else out.push({ role: 'user', content: [intro] });
  const { facts: _f, brief: _b, ...input } = isObj(approved) ? approved : {};
  out.push({ role: 'assistant', content: [{ type: 'text', text: `${who === 'someone else' ? 'Someone else' : who} changed this job since. This is how it runs now.` }, { type: 'tool_use', id: `toolu_newer_${out.length}`, name: 'propose_job', input: structuredClone(input) }] });
  return seedTranscriptFromApproved(out, approved);
}

/**
 * Open a job's chat (GET-889: the job's chat is ONE conversation per person, reopened, not a new one
 * per click). -> { session, history, source_session_id }; no model call. Box edit rights.
 *
 * Per person, not shared: a transcript holds what its creator's tools read with THEIR visibility and
 * their own words (review 1), and a session belongs to the person who started it (getBuilderSession,
 * approve), so co-owners each get their own chat on the job; the job itself is the shared state.
 *
 *   - Your newest chat on the job that you said something in (or approved), else your newest seeded
 *     one, is the chat. Still open: it IS the session, reused as it is, with its whole history (every
 *     message, reply, ask and proposal, approved or not, and a failed last turn).
 *   - Closed (you approved it): approving closes a session, so the chat goes on in a new one seeded
 *     with it (your words kept, tool results not carried), and the history shows all of it.
 *   - Someone else approved the job after your chat: the job as it is now is added at the end of
 *     yours (withNewerSetup), so you continue from the live job.
 *   - No chat of yours: the job's newest approved chat seeds a new one (another person's: the approved
 *     setup only, review 1); a job no chat made (set up elsewhere) opens on its current setup as an
 *     approved card (GET-873). That seeded session is then reused on the next open.
 * An empty open session of yours on the job is filled rather than another one created.
 */
export async function openBuilderSessionForJob(sb, { workspaceId, revboxId, userId, jobId }) {
  await loadRevbox(sb, workspaceId, userId, revboxId, true);
  const job = jobId ? await boxRoutine(sb, workspaceId, revboxId, jobId) : null;
  if (!job) fail(404, 'Job not found.');
  const all = (await rows(sb.from('revbox_builder_sessions').select('*').eq('workspace_id', workspaceId).eq('revbox_id', revboxId).eq('job_id', jobId)
    .order('updated_at', { ascending: false }).limit(50))).sort(byNewest);
  const mine = all.filter(r => r.user_id === userId);
  const hasMessages = (r) => Array.isArray(r.messages) && r.messages.length > 0;
  const base = mine.find(r => hasMessages(r) && (r.state === 'approved' || saidSomething(r.messages))) ?? mine.find(hasMessages) ?? null;
  const latestApproved = all.find(r => r.state === 'approved' && isObj(r.proposal)) ?? null;
  const newer = base && latestApproved && latestApproved.user_id !== userId && byNewest(latestApproved, base) < 0 ? withBrief(latestApproved.proposal) : null;
  const historyOf = (messages, proposal, approved = false) => builderSessionHistory(messages, { proposal, approved });

  // Your open chat: reused as it is.
  if (base?.state === 'open') {
    if (!newer) return { session: base, history: historyOf(base.messages, base.proposal), source_session_id: base.id };
    const messages = withNewerSetup(base.messages, newer);
    await saveBuilderSession(sb, { workspaceId, sessionId: base.id, userId, messages, proposal: newer });
    return { session: { ...base, messages, proposal: newer }, history: historyOf(messages, newer), source_session_id: base.id };
  }

  // Anything else continues in an open session of yours: an empty one already there, or a new one.
  const empty = mine.find(r => r.state === 'open' && !hasMessages(r));
  const target = empty ?? await createBuilderSession(sb, { workspaceId, revboxId, userId, jobId });
  const save = async (messages, proposal, history, source = null) => {
    await saveBuilderSession(sb, { workspaceId, sessionId: target.id, userId, messages, proposal });
    return { session: { ...target, messages, proposal }, history, source_session_id: source };
  };

  // Your closed chat (approved): carried into the new session, your words kept.
  if (base) {
    const approved = base.state === 'approved' && isObj(base.proposal) ? withBrief(base.proposal) : null;
    let messages = approved ? seedTranscriptFromApproved(sanitizeBuilderTranscript(base.messages, { keepText: true, approved }), approved) : closeOpenCalls(sanitizeBuilderTranscript(base.messages, { keepText: true }));
    let shown = approved ? seedTranscriptFromApproved(base.messages, approved) : base.messages;
    let proposal = approved ?? (isObj(base.proposal) ? base.proposal : null);
    if (newer) { messages = withNewerSetup(messages, newer); shown = withNewerSetup(shown, newer); proposal = newer; }
    return save(messages, proposal, historyOf(shown, proposal, !!approved && !newer), base.id);
  }

  // No chat of yours, but the job has an approved one: another person's (review 1: their setup only).
  if (latestApproved) {
    const approved = withBrief(latestApproved.proposal);
    const messages = seedTranscriptFromApproved(sanitizeBuilderTranscript(latestApproved.messages, { keepText: false, approved }), approved);
    const jobName = str(job?.name) || str(approved?.name) || 'this job';
    return save(messages, approved, [{ role: 'assistant', text: `Edited from ${jobName}'s approved setup.` }, { kind: 'proposal', proposal: approved, approved: true }], latestApproved.id);
  }

  // No chat made this job (GET-873): the chat opens on its current setup, as an approved card, so
  // the person can ask for a change and approve to update the same routine.
  // The chat shows the job's brief only (GET-884): no line about where it was set up. The model
  // gets the whole current setup (every step's config: the AI step's prompt, the Slack layout)
  // as its own approved propose_job call, so it can change any of it.
  const current = proposalFromRoutine(job, await routineProposalCatalog(sb, workspaceId));
  const shown = withBrief({ ...current, facts: proposalFacts(current, routineFactLookups(current.steps)) });
  const seeded = seedTranscriptFromApproved([
    { role: 'user', content: [{ type: 'text', text: `${HINT_HEADER}\nThe user opened this job to change it. It was set up outside the builder; its current setup follows.` }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_current_job', name: 'propose_job', input: current }] },
  ], shown);
  return save(seeded, shown, [{ kind: 'proposal', proposal: shown, approved: true }]);
}

/** The box's workflow-engine jobs, oldest first (view access). */
export async function listRevboxRoutines(sb, { workspaceId, revboxId, userId }) {
  await loadRevbox(sb, workspaceId, userId, revboxId);
  return rows(sb.from('agent_routines').select('*').eq('workspace_id', workspaceId).eq('revbox_id', revboxId).order('created_at', { ascending: true }));
}

/** One of the box's routines, with the box (edit rights when `edit`). 404 when it is not this box's. */
export async function loadRevboxRoutine(sb, { workspaceId, revboxId, userId, routineId, edit = false }) {
  const box = await loadRevbox(sb, workspaceId, userId, revboxId, edit);
  const routine = await boxRoutine(sb, workspaceId, revboxId, routineId);
  if (!routine) fail(404, 'Job not found.');
  return { box, routine };
}

// ── Where the box's jobs deliver (GET-868) ───────────────────────────────────

/**
 * Every delivery target the box's jobs use, read from their REAL steps (never from a display line),
 * for the sidebar's Delivery list next to the box's own destinations: [{ job_id, job_name, kind,
 * label, target }]. Slack channel -> "#channel", DM -> "DM to <name>", gmail -> "Gmail draft · from
 * <mailbox> · to <recipients>", email -> "Email · to <recipients>", webhook -> its host only (a path
 * or query often carries a token). `mailboxes` [{ id, email }] names a Gmail step's mailbox; an
 * unknown one is left out rather than guessed. The revbox_delivery step is the box's own list. Pure.
 */
export function revboxJobDeliveries(routines, { mailboxes = null } = {}) {
  const boxes = byId(mailboxes, 'email');
  const out = [];
  const seen = new Set();
  for (const r of list(routines)) {
    if (!isObj(r)) continue;
    for (const s of list(r.steps)) {
      if (!isObj(s)) continue;
      const c = isObj(s.config) ? s.config : {};
      let d = null;
      if (s.type === 'slack') {
        if (c.action === 'dm') d = { kind: 'slack', label: `DM to ${str(c.user_name) || 'a Slack user'}`, target: str(c.user_id), editable: false };
        else {
          const name = str(c.channel).replace(/^#/, '');
          d = { kind: 'slack', label: name ? `#${name}` : `Slack channel ${str(c.channel_id) || '(none)'}`, target: str(c.channel_id) || name, channel_id: str(c.channel_id) || null, channel: name || null };
        }
      } else if (s.type === 'gmail') {
        const mid = str(c.send_from?.id);
        const from = boxes.get(mid) ?? null;
        const to = addresses(c.to, c.cc);
        const smtp = c.send_from?.kind === 'smtp';
        d = { kind: smtp ? 'email' : 'gmail', label: [smtp ? 'Email' : c.mode === 'send' ? 'Gmail' : 'Gmail draft', from && `from ${from}`, to.length && `to ${to.join(', ')}`].filter(Boolean).join(' · '), target: mid,
          to: addresses(c.to).join(', '), cc: addresses(c.cc).join(', '), mailbox_id: mid || null, ...(smtp ? { editable: false } : {}) };
      } else if (s.type === 'email') {
        const to = addresses(c.to, c.cc);
        d = { kind: 'email', label: to.length ? `Email · to ${to.join(', ')}` : 'Email', target: to.join(', '), to: addresses(c.to).join(', '), cc: addresses(c.cc).join(', ') };
      } else if (s.type === 'webhook') {
        const { host } = urlParts(c.url);
        d = { kind: 'webhook', label: host ?? 'Custom webhook', target: host ?? '' };
      }
      if (!d) continue;
      const key = `${r.id}|${d.kind}|${d.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // step_id and step_type: which step the rail's job-step dialog edits (GET-872); `editable`
      // false = only through the chat (a DM, an SMTP mailbox).
      out.push({ job_id: r.id ?? null, job_name: r.name ?? null, step_id: s.id ?? null, step_type: s.type, editable: true, ...d });
    }
  }
  return out;
}

/**
 * The box's routines and their job deliveries, read with the box's own access (listRevboxRoutines:
 * a member, viewer or above, or a shared box's workspace). `job_deliveries` also carries one
 * { kind: 'warning', destination_id, label } row per box Gmail destination a box-delivering job
 * cannot draft in (its mailbox belongs to someone other than the job's owner). `mailboxes` is a list or an async loader,
 * called only after the access check.
 */
export async function listRevboxJobDeliveries(sb, { workspaceId, revboxId, userId, mailboxes = null }) {
  const box = await loadRevbox(sb, workspaceId, userId, revboxId);
  const routines = await rows(sb.from('agent_routines').select('*').eq('workspace_id', workspaceId).eq('revbox_id', revboxId).order('created_at', { ascending: true }));
  const boxes = typeof mailboxes === 'function' ? await Promise.resolve(mailboxes()).catch(() => []) : mailboxes;
  const job_deliveries = revboxJobDeliveries(routines, { mailboxes: boxes });
  // Review 8: a job ending in box delivery drafts in the box's Gmail destinations as its owner; one
  // whose mailbox is someone else's fails. The rail shows that as a `warning` row under the destination.
  const gmail = list(box.delivery).filter(d => isObj(d) && d.kind === 'gmail');
  if (gmail.length) {
    const owners = list(boxes).filter(m => isObj(m) && m.id && m.owner_user_id).map(m => ({ id: m.id, email: m.email ?? null, user_id: m.owner_user_id }));
    const pending = [];
    for (const r of list(routines)) {
      if (!isObj(r) || !list(r.steps).some(s => s?.type === 'revbox_delivery')) continue;
      for (const w of mailboxOwnerWarnings(gmail, owners, r.user_id)) pending.push({ r, w, uid: owners.find(m => String(m.id) === str(gmail.find(d => d.id === w.destination_id)?.target))?.user_id });
    }
    if (pending.length) {
      const ids = [...new Set(pending.map(p => p.uid).filter(Boolean))];
      const names = new Map((await rows(sb.from('users').select('id, name').in('id', ids)).catch(() => [])).map(u => [u.id, str(u.name)]));
      for (const { r, w, uid } of pending) {
        const owner = names.get(uid) || 'someone else';
        job_deliveries.push({ job_id: r.id ?? null, job_name: r.name ?? null, kind: 'warning', destination_id: w.destination_id, target: w.destination_id ?? '',
          label: `${w.mailbox} belongs to ${owner}; drafts from "${r.name ?? 'this job'}" will fail while it runs as someone else.` });
      }
    }
  }
  return { routines, job_deliveries };
}

// ── A built-in job's chat (GET-902) ────────────────────────────────────────────
//
// A built-in job (core REVBOX_BUILTIN_JOBS) is not a routine: OpenNous runs it. Clicking its card
// opens the same chat as a builder job, on a session with NO job_id (so approve can only ever create
// a NEW job in the box, never edit the built-in as a routine). The session is marked by its seed:
// the first user message is the composer's context naming the built-in (`[builtin:<key>]`), then the
// agent's card (the built-in's brief) as its first reply. The loop reads the mark (builtinOfTranscript)
// and gives the model the built-in's facts and the builtin_job tool. One chat per person per built-in
// per box: their newest open one is reused.

const BUILTIN_MARK = /\[builtin:([a-z_]+)\]/;

/**
 * The seed of a built-in's chat: the composer's context naming it (never the user's words), then the
 * agent's card as its first reply. `card`: { name, text, details?, starts?, enabled? }. Valid
 * Anthropic format (user, assistant). Pure.
 */
export function builtinSeedTranscript(key, card = {}) {
  const name = str(card.name) || key;
  const state = card.enabled === true ? 'On for the whole workspace.' : card.enabled === false ? 'Off for the whole workspace.' : '';
  const lines = [str(card.text), ...(Array.isArray(card.details) ? card.details.map(str).filter(Boolean) : []), state].filter(Boolean);
  return [
    { role: 'user', content: [{ type: 'text', text: `${HINT_HEADER}\nThe user opened the built-in job "${name}" [builtin:${key}] in this box, to ask about it or change it. It is not a workflow; see the system prompt.` }] },
    { role: 'assistant', content: [{ type: 'text', text: `${name}. ${lines.join(' ')}`.trim() }] },
  ];
}

/** The built-in a chat is about, from its seed (the first message, the composer's context), or null. Pure. */
export function builtinOfTranscript(messages) {
  const first = Array.isArray(messages) ? messages[0] : null;
  if (first?.role !== 'user') return null;
  const t = contentBlocks(first.content).find(b => b.type === 'text')?.text ?? '';
  if (!String(t).startsWith(HINT_HEADER)) return null;
  return String(t).split('\n\n')[0].match(BUILTIN_MARK)?.[1] ?? null;
}

/**
 * A built-in chat's history for the UI: its card first ({ kind: 'builtin', key }), then every turn
 * after the seed, as builderSessionHistory shows a job's chat. Pure.
 */
export function builtinSessionHistory(session) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  const key = builtinOfTranscript(messages);
  return [{ kind: 'builtin', key }, ...builderSessionHistory(messages.slice(2), { proposal: session?.proposal ?? null, approved: session?.state === 'approved' })];
}

/**
 * Open a built-in's chat (GET-902) -> { session, history }; no model call. Box edit rights, and the
 * box must list the built-in. The person's newest open chat on it in this box is reused as it is;
 * else a new session (job_id null) is seeded with the card. `card` is the built-in's brief as the
 * API builds it (builtinJobBrief, with the workspace's facts).
 */
export async function openBuilderSessionForBuiltin(sb, { workspaceId, revboxId, userId, key, card = {} }) {
  const box = await loadRevbox(sb, workspaceId, userId, revboxId, true);
  const listed = Array.isArray(box.builtin_jobs) ? box.builtin_jobs : [];
  if (!listed.includes(key)) fail(404, 'This built-in job is not in this RevBox.');
  const mine = (await rows(sb.from('revbox_builder_sessions').select('*').eq('workspace_id', workspaceId).eq('revbox_id', revboxId).eq('user_id', userId).eq('state', 'open')
    .is('job_id', null).order('updated_at', { ascending: false }).limit(50))).sort(byNewest);
  const open = mine.find(r => builtinOfTranscript(r.messages) === key);
  if (open) return { session: open, history: builtinSessionHistory(open) };
  const session = await createBuilderSession(sb, { workspaceId, revboxId, userId, jobId: null });
  const messages = builtinSeedTranscript(key, card);
  await saveBuilderSession(sb, { workspaceId, sessionId: session.id, userId, messages, proposal: null });
  const seeded = { ...session, messages, proposal: null };
  return { session: seeded, history: builtinSessionHistory(seeded) };
}
