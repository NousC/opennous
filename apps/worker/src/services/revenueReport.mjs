// Revenue Intelligence Report — the onboarding "wow", C-level edition.
//
// The moment the backfill finishes, we hold every touchpoint, meeting, extracted fact
// and fit score for the imported accounts in one graph. This turns that into a report
// a CRO would forward to the board: it does not SHOW the data, it TELLS you what's
// happening, what it's costing, what's about to happen, and what to do — with named
// accounts and the buyer's own words.
//
// Two halves:
//   1. Deterministic findings (computeFindings) — a Revenue Health score, at-risk and
//      predictive account lists, and the cross-account INTEL synthesis with verbatim
//      quotes. Real numbers and real accounts, so nothing is invented.
//   2. LLM synthesis (synthesize) — writes the diagnosis-first narrative FROM those
//      findings only.

import { getSupabaseClient, sendEmail } from '@nous/core';
import Anthropic from 'useleak';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-5';

const DAY = 86400000;
const QUIET_DAYS = 21;
const HIGH_FIT = 70;
const MEETING_PROPS = new Set(['interaction.meeting_held', 'interaction.meeting_scheduled']);
const REPLY_PROPS   = new Set(['interaction.email_reply', 'interaction.email_received', 'interaction.linkedin_message']);

// Human labels for the intel categories the extractor tags (see core claimCategories).
const CAT_LABEL = {
  pain: 'Pain points', objection: 'Objections', goal: 'Goals', competitor: 'Competitors',
  budget: 'Budget signals', timeline: 'Timelines', authority: 'Buying authority',
  status_quo: 'Current stack / status quo', preference: 'Preferences', relationship: 'Relationships',
};
const INTEL_ORDER = ['pain', 'objection', 'competitor', 'goal', 'budget', 'timeline', 'authority', 'status_quo'];

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

// ── Gather the graph slice ───────────────────────────────────────────────────
async function gatherAccounts(supabase, workspaceId, contactIds) {
  if (!contactIds.length) return { accounts: [] };

  const byId = new Map();
  for (const id of contactIds) byId.set(id, { id, name: 'Unknown', company: null, email: null, intel: [], disposition: null });

  // Names (contacts view first, then claims for cold leads).
  const { data: cv } = await supabase.from('contacts')
    .select('id, first_name, last_name, company, email').in('id', contactIds);
  for (const c of cv || []) {
    const a = byId.get(c.id); if (!a) continue;
    a.name = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || 'Unknown';
    a.company = c.company || null; a.email = c.email || null;
  }
  const stillUnknown = [...byId.values()].filter(a => a.name === 'Unknown').map(a => a.id);
  if (stillUnknown.length) {
    const { data: nc } = await supabase.from('claims')
      .select('entity_id, property, value').in('entity_id', stillUnknown).in('property', ['first_name', 'last_name', 'company']);
    const nm = new Map();
    for (const c of nc || []) {
      const v = c.value; const s = typeof v === 'string' ? v : (v && typeof v === 'object' ? (v.value ?? '') : (v == null ? '' : String(v)));
      const e = nm.get(c.entity_id) || {}; e[c.property] = s; nm.set(c.entity_id, e);
    }
    for (const id of stillUnknown) { const a = byId.get(id); const e = nm.get(id); if (a && e) { a.name = [e.first_name, e.last_name].filter(Boolean).join(' ') || a.name; a.company = a.company || e.company || null; } }
  }

  // Activities.
  const { data: obs } = await supabase.from('observations')
    .select('entity_id, property, observed_at, value')
    .eq('workspace_id', workspaceId).in('entity_id', contactIds)
    .like('property', 'interaction.%').order('observed_at', { ascending: false }).limit(8000);
  const now = Date.now();
  for (const o of obs || []) {
    const a = byId.get(o.entity_id); if (!a) continue;
    a.activities = (a.activities || 0) + 1;
    const t = o.observed_at ? new Date(o.observed_at).getTime() : 0;
    if (!a.lastActivity || t > a.lastActivity) a.lastActivity = t;
    if (MEETING_PROPS.has(o.property)) { a.meetings = (a.meetings || 0) + 1; if (!a.lastMeeting || t > a.lastMeeting) a.lastMeeting = t; }
    if (REPLY_PROPS.has(o.property)) a.replies = (a.replies || 0) + 1;
  }

  // ICP fit scores.
  const { data: preds } = await supabase.from('predictions')
    .select('entity_id, predicted_value, outcome_value, resolved_at, predicted_at')
    .eq('workspace_id', workspaceId).in('entity_id', contactIds).eq('kind', 'icp_fit')
    .order('predicted_at', { ascending: false }).limit(4000);
  const scoreSeen = new Set();
  for (const p of preds || []) {
    const a = byId.get(p.entity_id); if (!a) continue;
    if (!scoreSeen.has(p.entity_id)) { const sc = Number(p.predicted_value?.score); if (Number.isFinite(sc)) a.score = sc; scoreSeen.add(p.entity_id); }
    if (p.resolved_at && p.outcome_value?.disposition && !a.disposition) a.disposition = p.outcome_value.disposition; // won | lost
  }

  // INTEL — the extracted facts (note.* claims), with verbatim content + category.
  const { data: notes } = await supabase.from('claims')
    .select('entity_id, value').in('entity_id', contactIds).like('property', 'note.%').limit(6000);
  for (const n of notes || []) {
    const a = byId.get(n.entity_id); if (!a) continue;
    const cat = (n.value?.category || 'general').toLowerCase();
    const content = String(n.value?.content || '').trim();
    if (content) a.intel.push({ category: cat, content });
  }

  // Action items (commitments made on calls) — the "unlogged commitments" gap.
  const { data: acts } = await supabase.from('observations')
    .select('entity_id, observed_at, value').eq('workspace_id', workspaceId)
    .in('entity_id', contactIds).like('property', 'action_item.%').limit(4000);
  for (const ai of acts || []) {
    const a = byId.get(ai.entity_id); if (!a) continue;
    (a.actionItems ||= []).push({ text: String(ai.value?.description || ai.value?.summary || ai.value?.content || '').slice(0, 200), at: ai.observed_at ? new Date(ai.observed_at).getTime() : 0 });
  }

  const accounts = [...byId.values()];
  for (const a of accounts) {
    a.activities = a.activities || 0; a.meetings = a.meetings || 0; a.replies = a.replies || 0;
    a.actionItems = a.actionItems || [];
    a.score = Number.isFinite(a.score) ? a.score : null;
    a.daysSinceTouch = a.lastActivity ? Math.floor((now - a.lastActivity) / DAY) : null;
    a.meetingNoFollowup = a.meetings > 0 && a.lastMeeting && (!a.lastActivity || a.lastActivity <= a.lastMeeting);
    // A commitment with no activity logged after it (the meeting is at `at`, so if the
    // last touch is at-or-before it, nothing happened since).
    a.unloggedCommitments = a.actionItems.filter(x => x.text && (!a.lastActivity || a.lastActivity <= x.at));
  }
  return { accounts };
}

// ── Deterministic findings ───────────────────────────────────────────────────
function computeFindings({ accounts }) {
  const nm = (a) => a.name + (a.company ? ` (${a.company})` : '');
  const withScore = accounts.filter(a => a.score != null);
  const engaged = accounts.filter(a => a.activities > 0);
  const highFit = withScore.filter(a => a.score >= HIGH_FIT);
  const now = Date.now();

  const totals = {
    accounts: accounts.length,
    activities: accounts.reduce((s, a) => s + a.activities, 0),
    meetings: accounts.reduce((s, a) => s + a.meetings, 0),
    replies: accounts.reduce((s, a) => s + a.replies, 0),
    engaged: engaged.length,
    highFit: highFit.length,
  };

  // Revenue Health score — follow-through, high-fit coverage, momentum.
  const withMeetings = accounts.filter(a => a.meetings > 0);
  const followThrough = withMeetings.length ? 1 - withMeetings.filter(a => a.meetingNoFollowup).length / withMeetings.length : null;
  const highFitCoverage = highFit.length ? highFit.filter(a => a.activities > 0).length / highFit.length : null;
  const momentum = engaged.length ? engaged.filter(a => a.daysSinceTouch != null && a.daysSinceTouch <= QUIET_DAYS).length / engaged.length : null;
  const parts = [[followThrough, 0.4], [highFitCoverage, 0.35], [momentum, 0.25]].filter(([v]) => v != null);
  const wsum = parts.reduce((s, [, w]) => s + w, 0);
  const health = {
    score: wsum ? Math.round(100 * parts.reduce((s, [v, w]) => s + v * w, 0) / wsum) : null,
    followThroughPct: followThrough == null ? null : Math.round(followThrough * 100),
    highFitCoveragePct: highFitCoverage == null ? null : Math.round(highFitCoverage * 100),
    momentumPct: momentum == null ? null : Math.round(momentum * 100),
  };

  // At risk.
  const quietHighFit = highFit.filter(a => a.daysSinceTouch != null && a.daysSinceTouch >= QUIET_DAYS)
    .sort((a, b) => b.score - a.score).slice(0, 8).map(a => ({ name: nm(a), score: a.score, days: a.daysSinceTouch }));
  const meetingsNoFollowup = accounts.filter(a => a.meetingNoFollowup).sort((a, b) => b.meetings - a.meetings)
    .slice(0, 8).map(a => ({ name: nm(a), meetings: a.meetings, score: a.score }));
  const neverEngaged = accounts.filter(a => a.activities === 0).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 6).map(a => ({ name: nm(a), score: a.score }));

  // Predictions.
  const aboutToSlip = highFit.filter(a => a.daysSinceTouch != null && a.daysSinceTouch >= QUIET_DAYS && a.activities > 0)
    .sort((a, b) => b.score - a.score).slice(0, 6).map(a => ({ name: nm(a), score: a.score, days: a.daysSinceTouch }));
  const nextBest = highFit.filter(a => a.meetings === 0 && a.activities <= 3)
    .sort((a, b) => b.score - a.score).slice(0, 6).map(a => ({ name: nm(a), score: a.score, activities: a.activities }));

  // Effort vs fit.
  const mostActive = [...engaged].sort((a, b) => b.activities - a.activities).slice(0, 6)
    .map(a => ({ name: nm(a), activities: a.activities, meetings: a.meetings, score: a.score }));
  const overWorkedLowFit = engaged.filter(a => a.score != null && a.score < 40 && a.activities >= 3)
    .sort((a, b) => b.activities - a.activities).slice(0, 5).map(a => ({ name: nm(a), activities: a.activities, score: a.score }));

  // INTEL synthesis — cross-account, with verbatim quotes.
  const catMap = new Map();
  for (const a of accounts) {
    const seenCat = new Set();
    for (const it of a.intel) {
      const c = it.category;
      const e = catMap.get(c) || { category: c, label: CAT_LABEL[c] || c, count: 0, accounts: new Set(), quotes: [] };
      e.count += 1; e.accounts.add(a.id);
      if (e.quotes.length < 4 && !seenCat.has(c)) { e.quotes.push({ who: a.name, text: it.content.slice(0, 220) }); seenCat.add(c); }
      catMap.set(c, e);
    }
  }
  const intel = [...catMap.values()].map(e => ({ category: e.category, label: e.label, count: e.count, accounts: e.accounts.size, quotes: e.quotes }))
    .sort((a, b) => (INTEL_ORDER.indexOf(a.category) + 100 * (INTEL_ORDER.indexOf(a.category) < 0)) - (INTEL_ORDER.indexOf(b.category) + 100 * (INTEL_ORDER.indexOf(b.category) < 0)) || b.count - a.count);

  // Win / loss.
  const won = accounts.filter(a => a.disposition === 'won');
  const lost = accounts.filter(a => a.disposition === 'lost');
  const catShare = (list) => {
    const m = new Map();
    for (const a of list) for (const it of new Set(a.intel.map(x => x.category))) m.set(it, (m.get(it) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([c, n]) => ({ label: CAT_LABEL[c] || c, count: n }));
  };
  const winLoss = { won: won.length, lost: lost.length, enough: won.length + lost.length >= 3,
    wonShare: catShare(won), lostShare: catShare(lost) };

  // ── Leakage scorecard: gaps between what the CRM says and what the calls/emails
  //    say. Same shape every time (record vs. reality). Three are computable from the
  //    graph today; missing-stakeholders, missed-expansion and contradictions come as
  //    the identity + extraction layers catch up.
  const RISK_CATS = new Set(['competitor', 'objection', 'budget']);
  const riskAccounts = accounts.filter(a => a.intel.some(it => RISK_CATS.has(it.category)));
  const staleAll = accounts.filter(a => a.activities > 0 && a.daysSinceTouch != null && a.daysSinceTouch >= 30);
  const unloggedAll = accounts.filter(a => a.unloggedCommitments.length);
  const leakage = {
    total: riskAccounts.length + staleAll.length + unloggedAll.length,
    hiddenRisks: {
      count: riskAccounts.length,
      items: riskAccounts.slice(0, 8).map(a => { const r = a.intel.find(it => RISK_CATS.has(it.category)); return { name: nm(a), category: CAT_LABEL[r.category] || r.category, quote: r.content.slice(0, 200) }; }),
    },
    staleAccounts: {
      count: staleAll.length,
      items: [...staleAll].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 8).map(a => ({ name: nm(a), days: a.daysSinceTouch, score: a.score })),
    },
    unloggedCommitments: {
      count: unloggedAll.length,
      items: unloggedAll.slice(0, 8).map(a => ({ name: nm(a), commitment: a.unloggedCommitments[0].text })),
    },
  };

  return { totals, health, leakage, quietHighFit, meetingsNoFollowup, neverEngaged, aboutToSlip, nextBest, mostActive, overWorkedLowFit, intel, winLoss };
}

// ── LLM synthesis (diagnosis-first) ──────────────────────────────────────────
async function synthesize(findings, firstName) {
  const prompt = `You are a revenue-intelligence analyst writing a report for a GTM leader. Nous resolved every email, meeting and call for their accounts into one graph, extracted the buyer's own words, and scored each account for fit. Write like a sharp CRO advisor: a point of view, not a data dump.

Write FROM THE FINDINGS BELOW ONLY. Never invent an account, number, quote, or pattern that isn't here. Name accounts. Quote buyers verbatim from the intel quotes. Warm, direct, no fluff, no marketing, no em dashes.

The core idea: you found GAPS between what their CRM says and what their conversations actually say. Report those gaps.

Format EXACTLY as markdown:
Subject: <one-line subject stating the single biggest gap you found, with the number>

## The diagnosis
<2 to 4 sentences. Name the ONE constraint and cite leakage.total as "N gaps between your CRM and your conversations." A verdict, not a summary.>

## Hidden risks in your conversations
<From leakage.hiddenRisks. For each, name the account, the risk type, and the buyer's VERBATIM quote. This is a competitor/objection/budget signal sitting in a call that the CRM doesn't reflect.>

## Accounts going dark
<From leakage.staleAccounts. Named accounts that had real activity and then went quiet 30+ days. One line each.>

## Commitments made and never logged
<From leakage.unloggedCommitments. Named accounts where a next step was promised on a call with no follow-up after. Quote the commitment.>

## Your next best deals
<From nextBest: high-fit accounts barely touched. Name them, this is found pipeline.>

## Do this now
<3 to 5 ranked, specific actions, each tied to a named account or a process fix.>

Skip any section whose findings are empty. Recipient first name: ${firstName || 'there'}

FINDINGS:
${JSON.stringify(findings, null, 1).slice(0, 16000)}`;

  let raw = '';
  try {
    const msg = await anthropic.messages.create({ feature: 'revenue-report', model: MODEL, max_tokens: 3000, messages: [{ role: 'user', content: prompt }] });
    raw = (msg.content?.find(c => c.type === 'text')?.text || '').trim();
  } catch (e) { console.error('[REVENUE_REPORT] llm error:', e?.message || e); }
  return parseMarkdownReport(raw, findings);
}

function parseMarkdownReport(raw, f) {
  const fallbackSummary = `We resolved ${f.totals.activities} touchpoints and ${f.totals.meetings} meetings across ${f.totals.accounts} accounts. Here's what stands out.`;
  if (!raw) return { subject: 'Your revenue intelligence report', summary: fallbackSummary, sections: [] };
  let body = raw.replace(/^```(?:markdown)?\s*/i, '').replace(/```\s*$/i, '').trim();
  let subject = 'Your revenue intelligence report';
  const sm = body.match(/^\s*subject:\s*(.+)$/im);
  if (sm) { subject = sm[1].trim(); body = body.replace(/^\s*subject:\s*.+$/im, '').trim(); }
  const parts = body.split(/\n(?=##\s)/);
  let summary = '';
  let blocks = parts;
  if (parts[0] && !/^##\s/.test(parts[0])) { summary = parts[0].trim(); blocks = parts.slice(1); }
  const sections = [];
  for (const blk of blocks) { const m = blk.match(/^##\s*(.+?)\n([\s\S]*)$/); if (m && m[2].trim()) sections.push({ title: m[1].trim(), body: m[2].trim() }); }
  return { subject, summary: summary || fallbackSummary, sections };
}

// ── Render ───────────────────────────────────────────────────────────────────
function mdInline(s) {
  return String(s ?? '')
    .replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}
function mdBlock(body) {
  const lines = String(body || '').split('\n');
  let html = '', inList = false;
  for (const ln of lines) {
    const t = ln.trim();
    if (/^[-*]\s+/.test(t)) { if (!inList) { html += '<ul style="margin:6px 0 6px 18px;padding:0">'; inList = true; } html += `<li style="margin:3px 0">${mdInline(t.replace(/^[-*]\s+/, ''))}</li>`; }
    else { if (inList) { html += '</ul>'; inList = false; } if (t) html += `<p style="margin:8px 0">${mdInline(t)}</p>`; }
  }
  if (inList) html += '</ul>';
  return html;
}
function healthColor(s) { return s == null ? '#6B655B' : s >= 70 ? '#15803d' : s >= 45 ? '#E0912B' : '#b45309'; }

function renderHtml(report, f) {
  const h = f.health;
  const stat = (n, l) => `<td style="padding:8px 12px;text-align:center"><div style="font-size:20px;font-weight:700;color:#1A1712">${n}</div><div style="font-size:10px;color:#6B655B;text-transform:uppercase;letter-spacing:.04em">${l}</div></td>`;
  const scoreBlock = h.score == null ? '' : `<div style="text-align:center;margin:0 0 18px">
    <div style="font-size:11px;color:#6B655B;text-transform:uppercase;letter-spacing:.05em">Revenue Health</div>
    <div style="font-size:40px;font-weight:800;color:${healthColor(h.score)};line-height:1.1">${h.score}<span style="font-size:18px;color:#6B655B">/100</span></div>
    <div style="font-size:11px;color:#6B655B">Follow-through ${h.followThroughPct ?? '—'}% · High-fit coverage ${h.highFitCoveragePct ?? '—'}% · Momentum ${h.momentumPct ?? '—'}%</div>
  </div>`;
  const lk = f.leakage || { total: 0 };
  const gapCell = (n, l) => `<td style="padding:12px 8px;text-align:center;border:1px solid #E4DED1;background:#fff;width:33%"><div style="font-size:24px;font-weight:800;color:${n > 0 ? '#b45309' : '#6B655B'}">${n}</div><div style="font-size:10.5px;color:#6B655B;line-height:1.25">${l}</div></td>`;
  const scorecard = lk.total ? `<div style="margin:0 0 18px">
    <div style="font-size:15.5px;font-weight:700;color:#1A1712;text-align:center;margin-bottom:8px">Nous found ${lk.total} gap${lk.total === 1 ? '' : 's'} between your CRM and your conversations</div>
    <table style="width:100%;border-collapse:collapse;border-radius:12px;overflow:hidden"><tr>
      ${gapCell(lk.hiddenRisks.count, 'Hidden risks')}${gapCell(lk.staleAccounts.count, 'Accounts going dark')}${gapCell(lk.unloggedCommitments.count, 'Unlogged commitments')}
    </tr></table>
  </div>` : '';
  const sections = (report.sections || []).map(s =>
    `<div style="margin:22px 0"><div style="font-size:15px;font-weight:700;color:#1A1712;margin-bottom:4px">${mdInline(s.title)}</div><div style="font-size:14px;line-height:1.6;color:#3a352d">${mdBlock(s.body)}</div></div>`
  ).join('');
  return `<div style="max-width:640px;margin:0 auto;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1A1712;padding:8px 4px">
  <div style="font-size:13px;color:#6B655B;margin-bottom:12px">Nous · Revenue Intelligence Report</div>
  ${scoreBlock}
  ${scorecard}
  <table style="width:100%;border-collapse:collapse;background:#FBFAF5;border:1px solid #E4DED1;border-radius:12px;margin-bottom:6px"><tr>
    ${stat(f.totals.accounts, 'Accounts')}${stat(f.totals.activities, 'Touchpoints')}${stat(f.totals.meetings, 'Meetings')}${stat(f.totals.highFit, 'High fit')}
  </tr></table>
  <div style="font-size:14px;line-height:1.6;color:#3a352d;margin:14px 0">${mdInline(report.summary)}</div>
  ${sections}
  <div style="margin-top:26px;font-size:12px;color:#6B655B;border-top:1px solid #E4DED1;padding-top:12px">Generated from your account graph in Nous. It sharpens every time your team talks to an account.</div>
</div>`;
}
function renderText(report, f) {
  const secs = (report.sections || []).map(s => `${s.title}\n${s.body}`).join('\n\n');
  const hs = f.health.score == null ? '' : `Revenue Health: ${f.health.score}/100\n`;
  return `Nous Revenue Intelligence Report\n${hs}\n${report.summary}\n\n${f.totals.accounts} accounts · ${f.totals.activities} touchpoints · ${f.totals.meetings} meetings · ${f.totals.highFit} high-fit\n\n${secs}\n\nGenerated from your account graph in Nous.`;
}

// ── Orchestrator ─────────────────────────────────────────────────────────────
export async function generateAndEmailRevenueReport(supabase, workspaceId, contactIds, _payload, opts = {}) {
  if (process.env.SELF_HOSTED === 'true' && !opts.recipient) return { sent: false, reason: 'self_hosted' };
  if (!process.env.ANTHROPIC_API_KEY) return { sent: false, reason: 'no_llm' };

  const recipient = opts.recipient ? { email: opts.recipient, firstName: opts.firstName || null } : await resolveOwnerEmail(supabase, workspaceId);
  if (!recipient?.email) return { sent: false, reason: 'no_recipient' };

  const { accounts } = await gatherAccounts(supabase, workspaceId, contactIds);
  if (!accounts?.length) return { sent: false, reason: 'no_accounts' };

  const findings = computeFindings({ accounts });
  if (findings.totals.activities === 0) return { sent: false, reason: 'no_activity' };

  const report = await synthesize(findings, recipient.firstName);
  const html = renderHtml(report, findings);
  const text = renderText(report, findings);

  await sendEmail({ to: recipient.email, subject: report.subject || 'Your revenue intelligence report', text, html, tag: 'REVENUE_REPORT' });
  console.log(`[REVENUE_REPORT] sent to ${recipient.email} — ${findings.totals.accounts} accounts, health ${findings.health.score}`);
  return { sent: true, report, findings };
}
