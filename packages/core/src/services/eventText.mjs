// An event in words (GET-941): its name, its tone and the one line that says what happened, and
// the Slack message a Slack destination posts. The app's Events page says the same things
// (apps/frontend/src/lib/events.ts); keep the two in step. Pure.

const LABEL = {
  'signal.objection_raised': 'Objection raised', 'signal.objection_resolved': 'Objection resolved',
  'signal.competitor_mentioned': 'Competitor mentioned', 'signal.competitor_evaluating': 'Evaluating a competitor',
  'signal.stakeholder_identified': 'Stakeholder identified', 'signal.stakeholder_joined': 'Stakeholder joined',
  'signal.stakeholder_left': 'Stakeholder left', 'signal.budget_discussed': 'Budget discussed',
  'signal.buying_signal': 'Buying signal', 'signal.next_step': 'Next step agreed',
  'signal.expansion_signal': 'Expansion signal', 'signal.expansion_declined': 'Expansion declined',
  'signal.churn_risk': 'Churn risk',
  'conversation.call_ended': 'Call ended', 'conversation.reply_received': 'Reply received',
  'deal.won': 'Deal won', 'deal.lost': 'Deal lost', 'deal.stage_changed': 'Stage changed',
  'icp.score_changed': 'ICP score changed', 'icp.tier_changed': 'ICP tier changed',
  'people.added': 'People added', 'automation.approval_requested': 'Approval requested',
  'webhook.test': 'Test event',
};

const TONE = {
  'deal.won': 'positive', 'signal.buying_signal': 'positive', 'signal.expansion_signal': 'positive',
  'signal.objection_resolved': 'positive', 'signal.next_step': 'positive', 'signal.stakeholder_joined': 'positive',
  'deal.lost': 'risk', 'signal.churn_risk': 'risk', 'signal.stakeholder_left': 'risk', 'signal.expansion_declined': 'risk',
  'signal.objection_raised': 'warning', 'signal.competitor_mentioned': 'warning', 'signal.competitor_evaluating': 'warning',
  'signal.budget_discussed': 'warning', 'automation.approval_requested': 'warning',
};

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** "signal.stakeholder_left" → "Stakeholder left"; an unknown type reads from its own name. */
export function eventLabel(type) {
  if (LABEL[type]) return LABEL[type];
  const last = String(type ?? '').split('.').pop() ?? '';
  return last.charAt(0).toUpperCase() + last.slice(1).replace(/_/g, ' ');
}

/** positive | risk | warning | neutral. */
export function eventTone(type) {
  return TONE[type] ?? 'neutral';
}

/** What happened, in one line, from the event's own data. Empty when it has none. */
export function eventSummary(e) {
  const d = e?.data ?? {};
  const type = String(e?.type ?? '');
  const family = type.split('.')[0];
  if (family === 'signal') return str(d.title) ?? str(d.text) ?? '';
  if (type === 'conversation.call_ended') return str(d.title) ?? '';
  if (type === 'conversation.reply_received') return str(d.subject) ?? '';
  if (type === 'deal.won' || type === 'deal.lost') return str(e?.deal?.name) ?? '';
  if (type === 'deal.stage_changed') return str(d.stage) ? `Stage is now ${str(d.stage)}` : '';
  if (family === 'icp') {
    const from = num(d.from?.score);
    const to = num(d.to?.score);
    return to == null ? '' : from == null ? `Scored ${to}` : `${from} → ${to}`;
  }
  if (type === 'people.added') { const n = num(d.count); return n == null ? '' : `${n} ${n === 1 ? 'person' : 'people'} added`; }
  if (type === 'automation.approval_requested') return str(d.automation?.name) ?? '';
  return '';
}

const TONE_EMOJI = { positive: ':large_green_circle:', risk: ':red_circle:', warning: ':large_orange_circle:', neutral: ':white_circle:' };
// Slack mrkdwn: only &, < and > need escaping.
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = (amount, currency) => {
  if (amount == null) return null;
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 0 }).format(amount); }
  catch { return String(amount); }
};

/**
 * The message a Slack destination posts for one event: a line that says what happened and where,
 * the quote when there is one, and the deal and the event's id underneath. `text` is the
 * notification's fallback; `blocks` is what the channel shows.
 */
export function slackMessage(eventType, payload) {
  const e = { ...(payload ?? {}), type: eventType };
  const label = eventLabel(eventType);
  const account = str(e.account?.name);
  const summary = eventSummary(e);
  const head = `${TONE_EMOJI[eventTone(eventType)]} *${esc(label)}*${account ? ` · ${esc(account)}` : ''}`;
  const lines = [head];
  if (summary) lines.push(esc(summary));
  const quote = str(e.data?.quote);
  if (quote) lines.push(`> ${esc(quote)}${str(e.data?.said_by) ? ` — ${esc(e.data.said_by)}` : ''}`);
  const deal = e.deal ?? null;
  const dealBits = deal ? [str(deal.name), str(deal.stage), money(num(deal.amount), str(deal.currency))].filter(Boolean) : [];
  const context = [dealBits.length ? dealBits.map(esc).join(' · ') : null, `\`${esc(eventType)}\``].filter(Boolean).join('   ');
  return {
    text: `${label}${account ? ` · ${account}` : ''}${summary ? `: ${summary}` : ''}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: context }] },
    ],
  };
}
