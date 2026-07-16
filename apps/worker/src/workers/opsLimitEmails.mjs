// Ops-limit warning emails (Phase 3 of ops enforcement).
//
// In-app banners only reach people who open the app. This hourly cron asks the
// api which teams are due an ops email (the api owns the plan/state logic and
// reserves each send once per team+kind+billing-period), then sends them via
// Resend. The worker is a dumb sender.
//
// Dormant by default: no-op unless WORKER_INTERNAL_SECRET is set (the same secret
// guards the api endpoint). sendEmail also no-ops without RESEND_API_KEY.

import { sendEmail } from '@nous/core';

const SECRET = process.env.WORKER_INTERNAL_SECRET;

const n = (x) => Number(x || 0).toLocaleString();
const daysLeft = (graceUntil) => {
  if (!graceUntil) return 0;
  return Math.max(0, Math.ceil((new Date(graceUntil).getTime() - Date.now()) / 86400000));
};

function template(item) {
  const link = `${process.env.APP_URL || 'https://app.opennous.cloud'}/usage`;
  const left = daysLeft(item.graceUntil);
  const dayWord = left === 1 ? 'day' : 'days';

  let subject, intro;
  if (item.kind === 'warn80') {
    subject = `You've used ${item.percentUsed}% of your monthly operations`;
    intro =
      `You've used ${n(item.used)} of your ${n(item.included)} monthly operations on the ${item.planName} plan (${item.percentUsed}%). ` +
      `Nothing changes yet. If you go over, you get a 3 day grace window before anything pauses.`;
  } else if (item.kind === 'over_limit') {
    subject = `You're over your monthly operations limit`;
    intro =
      `You've used all ${n(item.included)} monthly operations on the ${item.planName} plan. ` +
      `Everything keeps working for the next ${left} ${dayWord}. Upgrade before then to avoid any interruption to your agents and outbound.`;
  } else { // grace_expiring
    subject = `Your operations grace period ends in ${left} ${dayWord}`;
    intro =
      `Your 3 day grace window is almost over. When it ends, active operations (agent calls, scans, enrichment, campaign sends) pause until you upgrade. ` +
      `Your data and incoming signal stay safe and you can still log in.`;
  }

  const text = `${intro}\n\nSee your usage and plans: ${link}\n\nNous`;
  const html =
    `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a;max-width:520px">` +
    `<p>${intro}</p>` +
    `<p><a href="${link}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:9px 16px;border-radius:8px;font-weight:600;font-size:13px">View usage and plans</a></p>` +
    `<p style="color:#888;font-size:12px;margin-top:24px">Nous</p>` +
    `</div>`;

  return { subject, text, html };
}

export async function runOpsLimitEmails() {
  if (!SECRET) return; // dormant until activated
  const apiUrl = process.env.API_URL;
  if (!apiUrl) { console.warn('[OPS-EMAILS] API_URL unset, skipping'); return; }

  let queued = [];
  try {
    const r = await fetch(`${apiUrl}/internal/ops-emails/sweep`, {
      method: 'POST',
      headers: { 'X-Internal-Secret': SECRET, 'Content-Type': 'application/json' },
    });
    if (!r.ok) { console.error('[OPS-EMAILS] sweep failed:', r.status); return; }
    ({ queued = [] } = await r.json());
  } catch (e) {
    console.error('[OPS-EMAILS] sweep error:', e?.message);
    return;
  }

  if (!queued.length) return;
  console.log(`[OPS-EMAILS] ${queued.length} team(s) due`);
  for (const item of queued) {
    const tmpl = template(item);
    for (const to of item.to) {
      try {
        await sendEmail({ to, subject: tmpl.subject, text: tmpl.text, html: tmpl.html, tag: 'OPS_LIMIT' });
        console.log(`[OPS-EMAILS] sent ${item.kind} → ${to}`);
      } catch (e) {
        console.error(`[OPS-EMAILS] send failed ${item.kind} ${to}:`, e?.message);
      }
    }
  }
}
