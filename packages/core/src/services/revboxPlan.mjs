import { nextRunAt } from './routineSchedule.mjs';
// Stage 1–4 compiler: deterministic suggestions, no paid model call or execution.
// Unrecognised instructions remain explicit draft instructions for review.
export const REVBOX_TOOLS=['granola','fireflies','fathom','hubspot','attio','gmail','slack','instantly'];
export const REVBOX_SIGNALS = [
  ['call_ended', 'Meeting completed'], ['deal_closed_won', 'Deal won'],
  ['deal_closed_lost', 'Deal lost'], ['deal_stage_changed', 'Deal stage changed'],
  ['account_signal', 'Account signal'], ['campaign_completed','Campaign completed'],
];

export function proposeRevboxPlan(prompt, options = {}) {
  const text = String(prompt ?? '').trim();
  if (!text || text.length > 12000) throw Object.assign(new Error('Write instructions of up to 12,000 characters.'), { status: 400 });
  const lower = text.toLowerCase();
  let kind = 'manual';
  if (/every|daily|weekly|monthly|quarterly|morning|at \d/.test(lower)) kind = 'clock';
  if (/after.*meeting|meeting.*(ends|done|completed)|after.*call/.test(lower)) kind = 'call_ended';
  if (/closed[ -]won|deal.*(won|wins)/.test(lower)) kind = 'deal_closed_won';
  if (/closed[ -]lost|deal.*lost/.test(lower) && !/won.*lost|won\/lost/.test(lower)) kind = 'deal_closed_lost';
  if (/campaign.*(done|complete|finish)/.test(lower)) kind = 'campaign_completed';
  if (/when.*webhook|webhook.*(arrives|received)/.test(lower)) kind = 'webhook_in';
  const weekday=['sunday','monday','tuesday','wednesday','thursday','friday','saturday'].findIndex(day=>lower.includes(day));
  const trigger = { kind, day_of_week:weekday<0?1:weekday, day_of_month:1, weekdays_only: /weekday/.test(lower), frequency: /quarter|3 months|three months/.test(lower) ? 'quarterly' : /monthly|every month/.test(lower) ? 'monthly' : /weekly|every week/.test(lower) ? 'weekly' : 'daily', at: '07:00', timezone: options.timezone || 'UTC', provider: '' };
  const time = lower.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (time) { let h = Number(time[1]); if (time[3]) h = h % 12 + (time[3] === 'pm' ? 12 : 0); if (h < 24) trigger.at = `${String(h).padStart(2, '0')}:${time[2] ?? '00'}`; }
  const tools = REVBOX_TOOLS.filter(t => lower.includes(t) || (options.tools ?? []).includes(t));
  trigger.provider = tools.find(t => ['granola', 'fireflies', 'fathom', 'hubspot', 'attio'].includes(t)) ?? '';
  const steps = [{ id: 'context', type: 'context', label: 'Read the RevBox context and scoped accounts', detail: 'Use the objective, reference files, and account filter configured for this box.' }, { id: 'agent', type: 'agent', label: /draft.*email|follow.?up/.test(lower) ? 'Draft the follow-up' : /handoff|onboarding/.test(lower) ? 'Prepare the onboarding brief' : 'Follow your instructions', detail: text }];
  if (tools.includes('gmail')) steps.push({ id: 'gmail', type: 'gmail', label: 'Create a Gmail draft', detail: 'Draft only. Choose a mailbox before execution is enabled.' });
  if (/approv|review|do not send|don.t send|dont send|but don/.test(lower)) steps.push({ id: 'approval', type: 'approval', label: 'Wait for review', detail: 'Keep the result for a person to approve.' });
  steps.push({ id: 'results', type: 'results', label: 'Save to Results', detail: 'Keep the output and its source evidence in this RevBox.' });
  if (tools.includes('slack')) steps.push({ id: 'slack', type: 'slack', label: 'Deliver to Slack', detail: 'Choose the channel in Delivery before execution is enabled.' });
  if (/webhook/.test(lower) && kind !== 'webhook_in') steps.push({ id: 'webhook', type: 'webhook', label: 'Deliver to a webhook', detail: 'Use a destination configured in Delivery.' });
  const questions = [];
  if (kind === 'manual') questions.push('Choose when this job should run.');
  if (/campaign/.test(lower)&&!tools.includes('instantly')) questions.push('Choose the campaign provider and campaign to analyze.');
  if (tools.includes('gmail')) questions.push('Confirm the sending mailbox and recipient rules.');
  if (tools.includes('slack')) questions.push('Confirm the connected Slack channel in Delivery.');
  return { trigger, tools, bindings: {}, steps, questions, compiler: 'suggestion-v1', execution_enabled: false };
}

export function validateRevboxPlan(plan) {
  if (!plan || !['manual', 'clock', 'webhook_in', ...REVBOX_SIGNALS.map(s => s[0])].includes(plan.trigger?.kind)) return 'Choose a supported trigger.';
  if (!Array.isArray(plan.steps) || !plan.steps.length || plan.steps.length > 12) return 'A job needs a valid execution outline.';
  const ids = new Set();
  for (const s of plan.steps) {
    if (!s || !['context', 'agent', 'gmail', 'approval', 'results', 'slack', 'webhook'].includes(s.type) || typeof s.label !== 'string' || !s.label.trim() || typeof s.detail !== 'string' || typeof s.id !== 'string' || ids.has(s.id)) return 'The execution outline has an invalid step.';
    ids.add(s.id);
  }
  if (!Array.isArray(plan.questions) || plan.questions.some(q => typeof q !== 'string' || q.length > 1000)) return 'Review questions are invalid.';
  if (plan.email && !(plan.email.recipient_rule==='meeting_attendees' && plan.trigger.kind==='call_ended') && (typeof plan.email.to !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(plan.email.to))) return 'Choose a valid draft recipient.';
  if (!Array.isArray(plan.tools) || plan.tools.some(t => !REVBOX_TOOLS.includes(t))) return 'Tools must be a list of names.';
  if (plan.bindings && (typeof plan.bindings !== 'object' || Array.isArray(plan.bindings) || Object.entries(plan.bindings).some(([slug, id]) => !plan.tools.includes(slug) || typeof id !== 'string'))) return 'Choose valid tool connections.';
  if (plan.trigger.kind === 'clock') {
    if(plan.trigger.weekdays_only!==undefined&&typeof plan.trigger.weekdays_only!=='boolean')return 'Choose a valid weekday schedule.';
    if(plan.trigger.day_of_week!==undefined&&(!Number.isInteger(plan.trigger.day_of_week)||plan.trigger.day_of_week<0||plan.trigger.day_of_week>6))return 'Choose a weekday.';
    if(plan.trigger.day_of_month!==undefined&&(!Number.isInteger(plan.trigger.day_of_month)||plan.trigger.day_of_month<1||plan.trigger.day_of_month>31))return 'Choose a day of the month.';
    if (!['daily', 'weekly', 'monthly', 'quarterly'].includes(plan.trigger.frequency) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(plan.trigger.at)) return 'Choose a valid schedule.';
    try { new Intl.DateTimeFormat('en', { timeZone: plan.trigger.timezone }); } catch { return 'Choose a valid timezone.'; }
  }
  if (JSON.stringify(plan).length > 30000) return 'The plan is too large.';
  return null;
}

export function revboxMatchesAccount(scope, account) {
  if (scope.mode === 'selected') return (scope.account_ids ?? []).includes(account.id);
  if (scope.mode === 'won') return Number(account.won_deals) > 0;
  if (scope.mode === 'lost') return Number(account.lost_deals) > 0;
  if (scope.mode === 'icp') return Number(account.icp_score) >= Number(scope.min_icp ?? 70);
  return scope.mode === 'all';
}

export function revboxExecutionRequirements(job,box){
  if(job.plan.tools.includes('gmail')&&((!job.plan.email?.to&&job.plan.email?.recipient_rule!=='meeting_attendees')||!job.plan.bindings?.gmail))return 'Choose a connected Gmail mailbox and draft recipient.';
  for(const kind of ['slack','webhook'])if(job.plan.steps.some(s=>s.type===kind)&&!box.delivery.some(d=>d.kind===kind&&d.target.trim()))return `Add a ${kind} destination in Delivery.`;
  return null;
}

export function revboxNextRunAt(trigger,from=new Date()){
 return nextRunAt({trigger_kind:trigger.kind,frequency:trigger.frequency,at_time:trigger.at,timezone:trigger.timezone,weekdays_only:trigger.weekdays_only,day_of_week:trigger.day_of_week,day_of_month:trigger.day_of_month},from);
}
