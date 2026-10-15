// A RevBox job's brief (GET-884): the one sentence the job card says in the agent's own voice
// ("Every morning I read yesterday's Company Daily Stats in HubSpot, write the credit check report
// and post it to #ops-daily."), plus its Starts label and whether it asks before sending.
//
// Built HERE, from the job's facts only: the trigger's kind and config, each step's type and config,
// and the server's facts (proposalFacts: checked Slack channel names, recipients, webhook hosts,
// table names). Never from the model's own words (summary, display titles, prompt), so a prompt
// cannot put text on the card (GET-858). The job's name is used only to name what it writes, and the
// name is on the card's header anyway. Pure and deterministic.
import { SIGNAL_LABEL } from '../services/signalLabels.mjs';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const clip = (t, n) => { const x = String(t ?? '').replace(/\s+/g, ' ').trim(); return x.length > n ? `${x.slice(0, n - 1)}…` : x; };
const list = (v) => (Array.isArray(v) ? v : []);
const addresses = (...vs) => vs.flatMap(v => (Array.isArray(v) ? v : String(v ?? '').split(/[,;]/))).map(x => String(x).trim()).filter(Boolean);
const humanize = (s) => String(s ?? '').replace(/^custom[._]/, '').replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim();
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
/** "a, b and c". */
export const joinAnd = (xs, word = 'and') => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ${word} ${xs.at(-1)}`);

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

// ── When ───────────────────────────────────────────────────────────────────────

/** "Every morning", "Every weekday afternoon", "Every Monday morning", "On the first of each month". */
function clockWhen(c) {
  const h = Number(String(c.at ?? '').slice(0, 2));
  const part = Number.isFinite(h) && /^\d\d:\d\d$/.test(String(c.at ?? '')) ? (h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening') : 'day';
  const dom = Number.isInteger(c.day_of_month) && c.day_of_month > 1 ? c.day_of_month : 1;
  switch (c.frequency) {
    case 'weekly': return `Every ${DAYS[Number.isInteger(c.day_of_week) ? c.day_of_week % 7 : 1]} ${part}`;
    case 'monthly': return dom === 1 ? 'On the first of each month' : `On the ${ordinal(dom)} of each month`;
    case 'quarterly': return dom === 1 ? 'At the start of each quarter' : `On the ${ordinal(dom)} day of each quarter`;
    default: return c.weekdays_only === true ? `Every weekday ${part}` : `Every ${part}`;
  }
}

/** "Every day 08:00 (Toronto)": the card's Starts row for a schedule. */
function clockStarts(c, timezone) {
  const at = /^\d\d:\d\d$/.test(String(c.at ?? '')) ? ` ${c.at}` : '';
  const city = str(timezone) && timezone !== 'UTC' ? ` (${String(timezone).split('/').pop().replace(/_/g, ' ')})` : '';
  const dom = Number.isInteger(c.day_of_month) && c.day_of_month > 1 ? c.day_of_month : 1;
  const base = c.frequency === 'weekly' ? `Every ${DAYS[Number.isInteger(c.day_of_week) ? c.day_of_week % 7 : 1]}`
    : c.frequency === 'monthly' ? (dom === 1 ? 'On the 1st of each month' : `On the ${ordinal(dom)} of each month`)
    : c.frequency === 'quarterly' ? (dom === 1 ? 'At the start of each quarter' : `On day ${dom} of each quarter`)
    : c.weekdays_only === true ? 'Weekdays' : 'Every day';
  return `${base}${at}${city}`;
}

/** What an account signal sounds like as an event: "a buyer raises an objection". */
const ACCOUNT_EVENT = {
  objection_raised: 'a buyer raises an objection', objection_resolved: 'an objection is resolved',
  competitor_mentioned: 'a competitor comes up', competitor_evaluating: 'an account evaluates a competitor',
  stakeholder_identified: 'a key stakeholder is identified', stakeholder_joined: 'a new stakeholder joins', stakeholder_left: 'a stakeholder leaves',
  budget_discussed: 'budget comes up', buying_signal: 'a buyer shows intent to buy', next_step: 'a next step is agreed',
  expansion_signal: 'a customer shows room to expand', expansion_declined: 'a customer declines an expansion', churn_risk: 'an account shows churn risk',
};
const PROVIDER = { granola: 'Granola', fireflies: 'Fireflies', fathom: 'Fathom' };
const singular = (o) => {
  const x = humanize(o).toLowerCase();
  if (!x || /^\d+ \d+$/.test(x)) return 'record';
  if (x === 'companies') return 'company';
  return x.endsWith('s') ? x.slice(0, -1) : x;
};

/**
 * One event trigger as [phrase, starts]: ["a deal is won", "Deal won"]. `custom` hands out the
 * names of the workspace's own signals in order (from the trigger's signal keys).
 */
function eventParts(kind, cfg, custom) {
  switch (kind) {
    case 'deal_closed_won': return [['a deal is won', 'Deal won']];
    case 'deal_closed_lost': return [['a deal is lost', 'Deal lost']];
    case 'deal_stage_changed': return [['a deal changes stage', 'Deal stage changed']];
    case 'icp_tier_changed': return [['an account\'s ICP tier changes', 'ICP tier changed']];
    case 'call_ended': {
      const p = PROVIDER[str(cfg.provider) || (list(cfg.tools).length === 1 ? String(cfg.tools[0]) : '')];
      return [[p ? `a ${p} meeting ends` : 'a meeting ends', p ? `Meeting done · ${p}` : 'Meeting done']];
    }
    case 'hubspot_field_changed': {
      const field = clip(str(cfg.property_label) || humanize(cfg.property) || 'a field', 60);
      const to = str(cfg.to) ? ` to ${clip(cfg.to, 40)}` : '';
      return [[`${field} changes${to} on a HubSpot ${singular(str(cfg.object_label) || cfg.object)}`, `${cap(field)} changed${to} in HubSpot`]];
    }
    case 'account_signal': {
      const out = list(cfg.signals).map(String).map((s) => {
        if (ACCOUNT_EVENT[s]) return [ACCOUNT_EVENT[s], SIGNAL_LABEL[s] ?? cap(humanize(s))];
        const name = s.startsWith('custom_') ? custom.shift() : humanize(s);
        return name ? [`your ${name.toLowerCase()} signal fires`, cap(name)] : ['one of your signals fires', 'Your signal'];
      });
      return out.length ? out : [['an account signal comes in', 'Account signal']];
    }
    case 'webhook_in': return [['a webhook arrives', 'Webhook event']];
    default: return [[`${humanize(kind) || 'the trigger'} happens`, cap(humanize(kind)) || 'Trigger']];
  }
}

/** -> { when: "When a deal is won or lost," | "Every morning", starts, kinds } */
export function briefTrigger(trigger) {
  const t = isObj(trigger) ? trigger : {};
  const kind = str(t.kind) || 'manual';
  const cfg = isObj(t.config) ? t.config : {};
  if (kind === 'clock') return { when: clockWhen(cfg), starts: clockStarts(cfg, t.timezone), kinds: ['clock'] };
  if (kind === 'manual') return { when: 'When you run me,', starts: 'Run by hand', kinds: ['manual'] };
  if (kind === 'before_meeting') {
    const m = Number(cfg.offset) > 0 ? Math.round(Number(cfg.offset)) : 30;
    const span = m === 60 ? 'An hour' : m % 60 === 0 ? `${m / 60} hours` : `${m} minutes`;
    return { when: `${span} before each meeting,`, starts: `${span} before each meeting`, kinds: ['before_meeting'] };
  }
  const keys = [...list(t.signal_keys), ...list(cfg.signal_keys), str(t.signal_key)].map(String).filter(k => k.startsWith('custom.'));
  const custom = [...new Set(keys)].map(k => humanize(k.slice('custom.'.length)));
  const triggers = [{ kind, config: cfg }, ...list(cfg.also).filter(isObj).map(x => ({ kind: str(x.kind), config: isObj(x.config) ? x.config : {} }))];
  const kinds = [...new Set(triggers.map(x => x.kind))];
  let parts = triggers.flatMap(x => eventParts(x.kind, x.config, custom));
  // Won and lost read as one event.
  if (kinds.includes('deal_closed_won') && kinds.includes('deal_closed_lost')) {
    const at = parts.findIndex(p => p[1] === 'Deal won' || p[1] === 'Deal lost');
    parts = parts.filter(p => p[1] !== 'Deal won' && p[1] !== 'Deal lost');
    parts.splice(Math.max(0, at), 0, ['a deal is won or lost', 'Deal won or lost']);
  }
  const seen = new Set();
  parts = parts.filter(p => (seen.has(p[0]) ? false : seen.add(p[0])));
  return { when: `When ${joinAnd(parts.map(p => p[0]), 'or')},`, starts: parts.map(p => p[1]).join(' or '), kinds };
}

// ── What it writes ─────────────────────────────────────────────────────────────

const PICK = {
  follow_up: ['draft the follow-up email', true], call_summary: ['summarize the call', true], premeeting_brief: ['write the pre-meeting brief', true],
  account_summary: ['summarize the account', true], deal_handoff: ['write the handoff', true],
};
const ARTIFACT_NOUNS = new Set(['report', 'reports', 'summary', 'digest', 'brief', 'briefing', 'analysis', 'update', 'updates', 'recap', 'review', 'handoff', 'hand-off', 'email', 'alert', 'alerts', 'scorecard', 'forecast', 'overview', 'snapshot', 'newsletter', 'memo', 'follow-up', 'followup', 'write-up', 'writeup', 'roundup', 'round-up', 'pulse', 'note', 'notes', 'pack', 'deck']);
const CADENCE = new Set(['daily', 'weekly', 'monthly', 'quarterly', 'nightly', 'hourly', 'annual', 'yearly', 'morning', 'evening', 'weekday', 'every', 'the', 'a', 'an', 'my', 'our']);
const FORMAT_ARTIFACT = { report: 'the report', digest: 'a digest', alert: 'an alert', handoff: 'the handoff', notification: 'a short update', approval: 'a message for approval', plain: 'an update' };

/**
 * "Credit Check daily report" -> "the credit check report": the name, when it names a document, with
 * its cadence dropped; words with capitals inside (VP, HubSpot, CS) keep their case. Else null.
 */
export function artifactFromName(name) {
  const words = str(name).replace(/[^\p{L}\p{N}\s/&'+-]/gu, ' ').split(/\s+/).filter(Boolean);
  if (!words.length || !ARTIFACT_NOUNS.has(words.at(-1).toLowerCase())) return null;
  const kept = words.filter(w => !CADENCE.has(w.toLowerCase()));
  if (!kept.length || kept.length > 6) return `the ${words.at(-1).toLowerCase()}`;
  return `the ${kept.map(w => (/\p{Lu}.*\p{Lu}|\d/u.test(w) ? w : w.toLowerCase())).join(' ')}`;
}

/** The first step after `i` that does something with what the AI step wrote. */
const consumerOf = (steps, i) => steps.slice(i + 1).find(s => ['slack', 'gmail', 'email', 'webhook', 'dataset_append', 'revbox_delivery', 'hubspot'].includes(s.type));

/** What one AI step does: "write the credit check report", "draft the follow-up email". */
function agentClause(proposal, steps, i, kinds, single) {
  const c = isObj(steps[i].config) ? steps[i].config : {};
  if (c.mode === 'pick') return PICK[c.job]?.[0] ?? 'do its work';
  const named = single ? artifactFromName(proposal?.name) : null;
  if (named) return `write ${named}`;
  const won = kinds.includes('deal_closed_won'), lost = kinds.includes('deal_closed_lost');
  if (won && lost) return 'write a win/loss analysis';
  const next = consumerOf(steps, i);
  if (next && (next.type === 'gmail' || next.type === 'email')) return kinds.includes('call_ended') ? 'write the follow-up email' : 'write an email';
  if (won) return 'write up the win';
  if (lost) return 'write up the loss';
  if (kinds.includes('call_ended')) return 'write a summary of the meeting';
  if (kinds.includes('before_meeting')) return 'write the pre-meeting brief';
  const fmt = next?.type === 'slack' ? str(next.config?.format) : next?.type === 'revbox_delivery' ? str(next.config?.format) || str(proposal?.box_delivery_format) : '';
  return `write ${FORMAT_ARTIFACT[fmt] ?? 'an update'}`;
}

// ── Steps as clauses ───────────────────────────────────────────────────────────

const HUBSPOT_WINDOW = { yesterday: 'yesterday\'s ', last_7_days: 'the last 7 days of ', last_30_days: 'the last 30 days of ' };
const TABLE_WINDOW = { last_7_days: 'the last 7 days of', last_30_days: 'the last 30 days of', last_month: 'last month\'s rows of', last_quarter: 'last quarter\'s rows of', all: 'every row of' };
const OPS = { is: 'is', is_not: 'is not', contains: 'contains', gt: 'is more than', lt: 'is less than', set: 'is set', not_set: 'is not set' };

/** "a@x.com and b@y.com", "the people on the call": recipients as a person reads them. */
function whoFor(raw) {
  const named = [...new Set(raw.map((a) => {
    if (!/\{\{/.test(a)) return clip(a, 60);
    if (/attendee|person\.|people/i.test(a)) return 'the people on the call';
    if (/owner/i.test(a)) return 'the owner';
    if (/contact/i.test(a)) return 'the contact';
    return 'the right person';
  }))];
  if (!named.length) return 'no one yet';
  return named.length > 2 ? `${named.slice(0, 2).join(', ')} and ${named.length - 2} more` : joinAnd(named);
}

function ruleText(c) {
  const one = (r) => [humanize(r?.field), OPS[r?.op] ?? humanize(r?.op), r?.op === 'set' || r?.op === 'not_set' ? '' : clip(r?.value ?? '', 40)].filter(Boolean).join(' ');
  const rules = list(c.rules).filter(r => str(r?.field)).map(one);
  return rules.length ? clip(rules.join(c.match === 'any' ? ' or ' : ' and '), 140) : null;
}

/** One step as a clause in the agent's voice, or null for a step the sentence leaves out. */
function stepClause(s, f, ctx) {
  const c = isObj(s.config) ? s.config : {};
  const it = ctx.made;
  switch (s.type) {
    case 'hubspot': {
      const action = str(c.action) || 'note';
      if (action === 'read') {
        const obj = str(c.object);
        const label = clip(str(c.object_label) || (obj && !/^\d+-\d+$/.test(obj) ? humanize(obj) : '') || 'records', 60);
        return `read ${HUBSPOT_WINDOW[c.window] ?? ''}${label} in HubSpot`;
      }
      if (action === 'task') return c.task_from === 'call' ? 'create HubSpot tasks from the call' : 'create a HubSpot task';
      if (action.startsWith('update_')) return `update the ${action.slice(7)} in HubSpot`;
      return it ? 'save it as a note in HubSpot' : 'add a note in HubSpot';
    }
    case 'slack': {
      if (c.action === 'dm') {
        const who = clip(f?.user ?? 'someone', 40);
        return it ? `send it to ${who} in Slack` : `message ${who} in Slack`;
      }
      // Only a channel the workspace's Slack really has is named (the fact); else "Slack".
      const where = f ? (f.channel ? `#${clip(f.channel, 60)}` : 'Slack') : 'Slack';
      return it ? `post it to ${where}` : `post an update to ${where}`;
    }
    case 'gmail': case 'email': {
      const who = whoFor(f ? list(f.recipients ?? f.sends_to).map(String) : addresses(c.to, c.cc, c.bcc));
      if (s.type === 'gmail' && (f?.mode ?? c.mode) === 'draft') return it ? `draft it in Gmail to ${who}` : `draft an email to ${who} in Gmail`;
      return it ? `email it to ${who}` : `email ${who}`;
    }
    case 'webhook': {
      let host = f?.host ?? null;
      if (!host) { try { host = new URL(str(c.url)).host; } catch { host = null; } }
      return `send ${it ? 'it' : 'the data'} to ${host ? clip(host, 60) : 'a webhook'}`;
    }
    case 'dataset_append': return `add a row to ${clip(f?.dataset ?? (str(c.dataset_key) || 'a table'), 60)}`;
    case 'dataset_read': return `read ${TABLE_WINDOW[c.window] ?? TABLE_WINDOW.all} ${clip(f?.dataset ?? (str(c.dataset_key) || 'a table'), 60)}`;
    case 'revbox_delivery': return `send ${it ? 'it' : 'the result'} to this box's destinations`;
    default: return null;   // approval (a note on the card), only_if (the closing condition), wait
  }
}

/**
 * The brief: { text, starts, asks_first }. `facts` are proposalFacts() for the proposal's steps
 * (the card's own); without them, nothing the server has not checked is named (a Slack post reads
 * "post it to Slack"). A job ending in box delivery (`uses_box_delivery`, or a revbox_delivery step
 * on a routine) says so last. Pure.
 */
export function jobBrief(proposal, facts = null) {
  const p = isObj(proposal) ? proposal : {};
  const all = list(p.steps).filter(isObj).map(s => ({ ...s, type: String(s.type ?? ''), config: isObj(s.config) ? s.config : {} }));
  const steps = all.filter(s => s.type !== 'revbox_delivery');
  const box = p.uses_box_delivery === true || all.some(s => s.type === 'revbox_delivery');
  if (box) steps.push({ id: '__box', type: 'revbox_delivery', config: { format: str(p.box_delivery_format) || str(all.find(s => s.type === 'revbox_delivery')?.config?.format) } });
  const byStep = new Map(list(facts).filter(isObj).map(f => [String(f.step_id), f]));
  const { when, starts, kinds } = briefTrigger(p.trigger);
  const writers = steps.filter(s => s.type === 'agent' && s.config.mode !== 'pick').length;
  const ctx = { made: false };
  const clauses = [];
  let condition = null;
  steps.forEach((s, i) => {
    if (s.type === 'only_if') { condition ??= ruleText(s.config); return; }
    let clause;
    if (s.type === 'agent') { clause = agentClause(p, steps, i, kinds, writers === 1); ctx.made = true; }
    else clause = stepClause(s, byStep.get(String(s.id)), ctx);
    if (clause && !clauses.includes(clause)) clauses.push(clause);
  });
  const does = clauses.length ? joinAnd(clauses) : 'run its steps';
  const text = clip(`${when} I ${does}${condition ? `, but only if ${condition}` : ''}.`, 420);
  return { text, starts, asks_first: steps.some(s => s.type === 'approval') };
}
