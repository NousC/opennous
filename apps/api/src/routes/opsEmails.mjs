// Internal sweep endpoint for ops-limit warning emails (Phase 3).
//
// Lives here (not under routes/internal/, which is gitignored) but is mounted at
// the /internal/ops-emails URL. The api owns the plan + ops-state logic, so it
// computes WHO is due an email and RESERVES the send (idempotent per
// team+kind+billing-period). The worker cron calls this and does the actual
// sending. Dormant by default: returns 404 unless WORKER_INTERNAL_SECRET is set,
// and the caller must present it.

import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { getTeamOpsState, getPlanFromSubscription } from '../lib/plans.mjs';

export const opsEmailsRouter = Router();

// Email grace_expiring once the window is within ~a day of closing.
const GRACE_EXPIRING_WINDOW_MS = 26 * 60 * 60 * 1000;

opsEmailsRouter.use((req, res, next) => {
  const secret = process.env.WORKER_INTERNAL_SECRET;
  if (!secret) return res.status(404).json({ error: 'not_found' }); // feature off
  if (req.get('X-Internal-Secret') !== secret) return res.status(403).json({ error: 'forbidden' });
  next();
});

// POST /internal/ops-emails/sweep
// → { queued: [{ team_id, kind, to[], planName, used, included, percentUsed, graceUntil }] }
opsEmailsRouter.post('/sweep', async (_req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { data: subs } = await supabase.from('subscriptions').select('*');
    const queued = [];

    for (const sub of subs ?? []) {
      const teamId = sub.team_id;
      let ops;
      try {
        ops = await getTeamOpsState(supabase, teamId, sub);
      } catch (e) {
        console.error('[ops-emails] state failed for team', teamId, e?.message);
        continue;
      }

      // Which email, if any, is due for the current state?
      let kind = null;
      if (ops.state === 'warn') kind = 'warn80';
      else if (ops.state === 'grace') {
        const msLeft = new Date(ops.graceUntil).getTime() - Date.now();
        kind = msLeft <= GRACE_EXPIRING_WINDOW_MS ? 'grace_expiring' : 'over_limit';
      }
      if (!kind) continue;

      // Resolve recipients BEFORE reserving, so we never burn a reservation on a
      // team we can't actually email.
      const to = await teamEmails(supabase, teamId);
      if (!to.length) continue;

      // Reserve atomically — a unique-violation (23505) means already sent this period.
      const { error: resErr } = await supabase
        .from('team_ops_email_log')
        .insert({ team_id: teamId, kind, period_start: ops.periodStart });
      if (resErr) {
        if (resErr.code !== '23505') console.error('[ops-emails] reserve failed:', resErr.message);
        continue;
      }

      const plan = getPlanFromSubscription(sub);
      queued.push({
        team_id: teamId,
        kind,
        to,
        planName: plan.name,
        used: ops.used,
        included: ops.included,
        percentUsed: ops.percentUsed,
        graceUntil: ops.graceUntil,
      });
    }

    return res.json({ queued });
  } catch (err) {
    console.error('[ops-emails/sweep]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

async function teamEmails(supabase, teamId) {
  const { data: users } = await supabase.from('users').select('email').eq('team_id', teamId);
  return [...new Set((users ?? []).map((u) => u.email).filter(Boolean))];
}
