// Revenue report — the onboarding "wow moment".
//
// The instant the post-import backfill finishes, we have every touchpoint, meeting and
// score for the imported accounts resolved into one graph. This turns that into a report
// the user could never have written themselves: where revenue is slipping, what to fix,
// and the patterns hiding in their meetings — then emails it to them.
//
// Two halves, on purpose:
//   1. Deterministic findings (computeFindings) — real numbers and NAMED accounts pulled
//      straight from the graph. This is what makes it credible, not horoscope.
//   2. LLM synthesis (synthesize) — turns those findings into a warm, specific narrative.
//      It only ever speaks about findings we handed it, so it can't invent accounts.

import { getSupabaseClient, sendEmail } from '@nous/core';
import Anthropic from 'useleak';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-5';

const DAY = 86400000;
const QUIET_DAYS = 30;       // no touch in this long = at risk
const HIGH_FIT = 70;         // ICP score at or above this = a fit worth protecting
const MEETING_PROPS = new Set(['interaction.meeting_held', 'interaction.meeting_scheduled']);
const REPLY_PROPS   = new Set(['interaction.email_reply', 'interaction.email_received', 'interaction.linkedin_message']);

// ── Recipient ────────────────────────────────────────────────────────────────
async function resolveOwnerEmail(supabase, workspaceId) {
  try {
    const { data: members } = await supabase.from('workspace_members')
      .select('user_id').eq('workspace_id', workspaceId).limit(10);
    const ids = (members || []).map(m => m.user_id).filter(Boolean);
    if (!ids.length) return null;
    const { data: users } = await supabase.from('users')
      .select('email, name, created_at').in('id', ids).order('created_at', { ascending: true });
    const u = (users || []).find(x => x.email);
    return u ? { email: u.email, firstName: (u.name || '').split(/\s+/)[0] || null } : null;
  } catch { return null; }
}

// ── Gather the graph slice for the imported accounts ─────────────────────────
async function gatherAccounts(supabase, workspaceId, contactIds, payload) {
  if (!contactIds.length) return [];

  // Names/company/email come from the import payload (works for cold leads not yet in
  // the contacts view). Everything else comes from the graph the backfill just filled.
  const byId = new Map();
  for (const p of payload || []) {
    if (p?.id) byId.set(p.id, { id: p.id, name: [p.first_name, p.last_name].filter(Boolean).join(' ') || p.email || 'Unknown', company: p.company || null, email: p.email || null });
  }
  for (const id of contactIds) if (!byId.has(id)) byId.set(id, { id, name: 'Unknown', company: null, email: null });

  // Fill names from the graph for anything the import payload didn't cover — this is
  // what makes the report work on an EXISTING workspace (no payload), not just a fresh
  // import. Engaged people are in the contacts view; cold leads only in claims.
  const missing = () => [...byId.values()].filter(a => !a.name || a.name === 'Unknown');
  if (missing().length) {
    const ids = missing().map(a => a.id);
    const { data: cv } = await supabase.from('contacts')
      .select('id, first_name, last_name, company, email').in('id', ids);
    for (const c of cv || []) {
      const a = byId.get(c.id); if (!a) continue;
      a.name = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || a.name;
      a.company = a.company || c.company || null;
      a.email = a.email || c.email || null;
    }
  }
  if (missing().length) {
    const ids = missing().map(a => a.id);
    const { data: claims } = await supabase.from('claims')
      .select('entity_id, property, value').in('entity_id', ids).in('property', ['first_name', 'last_name', 'company']);
    const nm = new Map();
    for (const c of claims || []) {
      const v = c.value;
      const s = typeof v === 'string' ? v : (v && typeof v === 'object' ? (v.value ?? '') : (v == null ? '' : String(v)));
      const e = nm.get(c.entity_id) || {}; e[c.property] = s; nm.set(c.entity_id, e);
    }
    for (const a of missing()) {
      const e = nm.get(a.id); if (!e) continue;
      a.name = [e.first_name, e.last_name].filter(Boolean).join(' ') || a.name;
      a.company = a.company || e.company || null;
    }
  }

  // Activities.
  const { data: obs } = await supabase.from('observations')
    .select('entity_id, property, observed_at, source, value')
    .eq('workspace_id', workspaceId).in('entity_id', contactIds)
    .like('property', 'interaction.%').order('observed_at', { ascending: false }).limit(5000);

  // ICP fit scores (latest prediction per entity).
  const { data: preds } = await supabase.from('predictions')
    .select('entity_id, predicted_value, predicted_at')
    .eq('workspace_id', workspaceId).in('entity_id', contactIds).eq('kind', 'icp_fit')
    .order('predicted_at', { ascending: false }).limit(2000);
  const scoreById = new Map();
  for (const p of preds || []) if (!scoreById.has(p.entity_id)) scoreById.set(p.entity_id, Number(p.predicted_value?.score));

  const now = Date.now();
  const meetingSummaries = [];
  for (const o of obs || []) {
    const a = byId.get(o.entity_id);
    if (!a) continue;
    a.activities = (a.activities || 0) + 1;
    const t = o.observed_at ? new Date(o.observed_at).getTime() : 0;
    if (!a.lastActivity || t > a.lastActivity) a.lastActivity = t;
    if (MEETING_PROPS.has(o.property)) {
      a.meetings = (a.meetings || 0) + 1;
      if (!a.lastMeeting || t > a.lastMeeting) a.lastMeeting = t;
      const s = o.value?.summary || o.value?.description;
      if (s && meetingSummaries.length < 40) meetingSummaries.push({ who: a.name, text: String(s).slice(0, 500) });
    }
    if (REPLY_PROPS.has(o.property)) a.replies = (a.replies || 0) + 1;
  }

  for (const a of byId.values()) {
    a.activities = a.activities || 0;
    a.meetings = a.meetings || 0;
    a.replies = a.replies || 0;
    a.score = scoreById.has(a.id) && Number.isFinite(scoreById.get(a.id)) ? scoreById.get(a.id) : null;
    a.daysSinceTouch = a.lastActivity ? Math.floor((now - a.lastActivity) / DAY) : null;
    // A meeting with no activity logged AFTER it = no follow-up happened.
    a.meetingNoFollowup = a.lastMeeting && (!a.lastActivity || a.lastActivity <= a.lastMeeting) && a.meetings > 0;
  }

  return { accounts: [...byId.values()], meetingSummaries };
}

// ── Deterministic findings ───────────────────────────────────────────────────
function computeFindings({ accounts, meetingSummaries }) {
  const withScore = accounts.filter(a => a.score != null);
  const engaged = accounts.filter(a => a.activities > 0);

  const totals = {
    accounts: accounts.length,
    activities: accounts.reduce((s, a) => s + a.activities, 0),
    meetings: accounts.reduce((s, a) => s + a.meetings, 0),
    replies: accounts.reduce((s, a) => s + a.replies, 0),
    engaged: engaged.length,
    highFit: withScore.filter(a => a.score >= HIGH_FIT).length,
  };

  const byActivity = (a, b) => b.activities - a.activities;
  const name = (a) => a.name + (a.company ? ` (${a.company})` : '');

  // Revenue slipping through.
  const quietHighFit = accounts
    .filter(a => a.score != null && a.score >= HIGH_FIT && a.daysSinceTouch != null && a.daysSinceTouch >= QUIET_DAYS)
    .sort((a, b) => b.score - a.score).slice(0, 8)
    .map(a => ({ name: name(a), score: a.score, days: a.daysSinceTouch }));

  const neverEngaged = accounts
    .filter(a => a.activities === 0)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 8)
    .map(a => ({ name: name(a), score: a.score }));

  const meetingsNoFollowup = accounts
    .filter(a => a.meetingNoFollowup)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 8)
    .map(a => ({ name: name(a), score: a.score, meetings: a.meetings }));

  // Effort allocation: where is your time going vs. where the fit is?
  const mostActive = [...engaged].sort(byActivity).slice(0, 6)
    .map(a => ({ name: name(a), activities: a.activities, meetings: a.meetings, score: a.score }));
  const overWorkedLowFit = engaged
    .filter(a => a.score != null && a.score < 40 && a.activities >= 3)
    .sort(byActivity).slice(0, 6).map(a => ({ name: name(a), activities: a.activities, score: a.score }));

  return { totals, quietHighFit, neverEngaged, meetingsNoFollowup, mostActive, overWorkedLowFit, meetingSummaries };
}

// ── LLM synthesis ────────────────────────────────────────────────────────────
async function synthesize(findings, firstName) {
  const f = findings;
  const prompt = `You are writing a short revenue report for a GTM founder. Nous just backfilled every email, meeting and call for their accounts and scored each one for fit.

Write FROM THE FINDINGS BELOW ONLY. Never invent an account, number, or pattern that isn't here. Be specific and NAME accounts. Warm, direct, peer to peer. No fluff, no marketing, no em dashes.

Format EXACTLY as markdown, like this:
Subject: <one-line email subject>

<a 2 to 3 sentence opening paragraph>

## <Section title>
<section body, a short paragraph or a few bullet lines>

## <Section title>
<section body>

Cover these, but SKIP any section whose findings are empty:
- Revenue slipping through: quiet high-fit accounts, high-fit accounts never engaged, meetings with no follow-up. Name the accounts.
- Where effort is going vs where the fit is (most-active accounts; any low-fit accounts eating a lot of work).
- Meeting patterns: read the meeting summaries and call out recurring themes, objections, or competitors if any are clear.
- One "you'd never have known" line if the data supports it.

Recipient first name: ${firstName || 'there'}

FINDINGS:
${JSON.stringify(f, null, 1).slice(0, 14000)}`;

  let raw = '';
  try {
    const msg = await anthropic.messages.create({
      feature: 'revenue-report', model: MODEL, max_tokens: 2500,
      messages: [{ role: 'user', content: prompt }],
    });
    // Sonnet emits a thinking block first (content[0]), so grab the TEXT block, not [0].
    raw = (msg.content?.find(c => c.type === 'text')?.text || '').trim();
  } catch (e) {
    console.error('[REVENUE_REPORT] llm error:', e?.message || e);
  }
  return parseMarkdownReport(raw, f);
}

// Markdown → { subject, summary, sections }. Robust to fences, prose, and truncation:
// a cut-off final section still yields all the earlier ones.
function parseMarkdownReport(raw, f) {
  const fallbackSummary = `We backfilled ${f.totals.activities} touchpoints across ${f.totals.accounts} accounts and scored each for fit. Here's what stands out.`;
  if (!raw) return { subject: 'Your revenue report from Nous', summary: fallbackSummary, sections: [] };

  let body = raw.replace(/^```(?:markdown)?\s*/i, '').replace(/```\s*$/i, '').trim();

  let subject = 'Your revenue report from Nous';
  const sm = body.match(/^\s*subject:\s*(.+)$/im);
  if (sm) { subject = sm[1].trim(); body = body.replace(/^\s*subject:\s*.+$/im, '').trim(); }

  const parts = body.split(/\n(?=##\s)/);
  let summary = fallbackSummary;
  let blocks = parts;
  if (parts[0] && !/^##\s/.test(parts[0])) { summary = parts[0].trim() || fallbackSummary; blocks = parts.slice(1); }

  const sections = [];
  for (const blk of blocks) {
    const m = blk.match(/^##\s*(.+?)\n([\s\S]*)$/);
    if (m && m[2].trim()) sections.push({ title: m[1].trim(), body: m[2].trim() });
  }
  return { subject, summary, sections };
}

// ── Render ───────────────────────────────────────────────────────────────────
function renderHtml(report, f) {
  const esc = (s) => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const stat = (n, l) => `<td style="padding:8px 14px;text-align:center"><div style="font-size:22px;font-weight:700;color:#1A1712">${n}</div><div style="font-size:11px;color:#6B655B;text-transform:uppercase;letter-spacing:.04em">${l}</div></td>`;
  const sections = (report.sections || []).map(s =>
    `<div style="margin:22px 0"><div style="font-size:15px;font-weight:600;color:#1A1712;margin-bottom:6px">${esc(s.title)}</div><div style="font-size:14px;line-height:1.65;color:#3a352d;white-space:pre-wrap">${esc(s.body)}</div></div>`
  ).join('');
  return `<div style="max-width:620px;margin:0 auto;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1A1712;padding:8px 4px">
  <div style="font-size:13px;color:#6B655B;margin-bottom:4px">Nous revenue report</div>
  <div style="font-size:15px;line-height:1.6;color:#3a352d;margin-bottom:18px">${esc(report.summary)}</div>
  <table style="width:100%;border-collapse:collapse;background:#FBFAF5;border:1px solid #E4DED1;border-radius:12px;margin-bottom:8px"><tr>
    ${stat(f.totals.accounts, 'Accounts')}${stat(f.totals.activities, 'Touchpoints')}${stat(f.totals.meetings, 'Meetings')}${stat(f.totals.highFit, 'High fit')}
  </tr></table>
  ${sections}
  <div style="margin-top:26px;font-size:12px;color:#6B655B;border-top:1px solid #E4DED1;padding-top:12px">Generated from your account graph in Nous. Open the app to work the accounts above.</div>
</div>`;
}

function renderText(report, f) {
  const secs = (report.sections || []).map(s => `${s.title}\n${s.body}`).join('\n\n');
  return `Nous revenue report\n\n${report.summary}\n\n${f.totals.accounts} accounts · ${f.totals.activities} touchpoints · ${f.totals.meetings} meetings · ${f.totals.highFit} high-fit\n\n${secs}\n\nGenerated from your account graph in Nous.`;
}

// ── Orchestrator ─────────────────────────────────────────────────────────────
export async function generateAndEmailRevenueReport(supabase, workspaceId, contactIds, payload, opts = {}) {
  if (process.env.SELF_HOSTED === 'true' && !opts.recipient) return { sent: false, reason: 'self_hosted' };
  if (!process.env.ANTHROPIC_API_KEY) return { sent: false, reason: 'no_llm' };

  // opts.recipient overrides the workspace owner (used for one-off / test sends).
  const recipient = opts.recipient
    ? { email: opts.recipient, firstName: opts.firstName || null }
    : await resolveOwnerEmail(supabase, workspaceId);
  if (!recipient?.email) return { sent: false, reason: 'no_recipient' };

  const gathered = await gatherAccounts(supabase, workspaceId, contactIds, payload);
  if (!gathered.accounts?.length) return { sent: false, reason: 'no_accounts' };

  const findings = computeFindings(gathered);
  // Nothing to say if there's no history at all — don't email an empty report.
  if (findings.totals.activities === 0) return { sent: false, reason: 'no_activity' };

  const report = await synthesize(findings, recipient.firstName);
  const html = renderHtml(report, findings);
  const text = renderText(report, findings);

  await sendEmail({
    to: recipient.email,
    subject: report.subject || 'Your Nous revenue report',
    text, html, tag: 'REVENUE_REPORT',
  });
  console.log(`[REVENUE_REPORT] sent to ${recipient.email} — ${findings.totals.accounts} accounts, ${findings.totals.activities} touchpoints`);
  return { sent: true, report, totals: findings.totals };
}
