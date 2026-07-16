// /api/routines — the agent's half of Tasks.
//
// CRUD over scheduled work, plus "run it now" (which is how you find out whether a
// prompt is any good without waiting until Monday).

import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { nextRunAt, describeTrigger } from '../../lib/routineSchedule.mjs';
import { runRoutine, tickRoutines } from '../../lib/routineRunner.mjs';

export const routinesRouter = Router();

const FREQUENCIES = ['daily', 'weekly', 'monthly', 'quarterly'];

// The routine every workspace gets. Meeting prep is the thing an agent with your
// whole GTM record can do that a calendar reminder can't, so it ships on rather
// than sitting behind an empty state waiting to be discovered.
const DEFAULT_ROUTINE = {
  name: 'Meeting brief',
  prompt: 'Brief me on this meeting. Who am I talking to, what have we said to each other before, '
        + 'what changed since we last spoke, and what should I open with? Be specific and cite where you got each fact.',
  trigger_kind: 'before_meeting',
  offset_minutes: 60,
};

/** Shape a row for the client: add the human trigger line and the run summary. */
function present(r, runs = []) {
  const mine = runs.filter(x => x.routine_id === r.id);
  const last = mine[0] ?? null;
  return {
    ...r,
    trigger_label: describeTrigger(r),
    unseen: mine.filter(x => x.status === 'ok' && !x.seen_at).length,
    last_run: last ? { id: last.id, status: last.status, thread_id: last.thread_id, started_at: last.started_at, error: last.error } : null,
  };
}

// ── List ────────────────────────────────────────────────────────────────────
routinesRouter.get('/', verifySupabaseAuth, async (req, res) => {
  try {
    const workspaceId = req.query.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });
    const supabase = getSupabaseClient();

    let { data: routines } = await supabase
      .from('agent_routines').select('*')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: true });

    // Seed the default on first look, so a new workspace's first meeting gets
    // briefed without anyone having configured anything.
    if (!routines?.length) {
      const { data: seeded } = await supabase.from('agent_routines').insert({
        ...DEFAULT_ROUTINE,
        workspace_id: workspaceId,
        user_id: req.internalUserId ?? null,
        timezone: req.query.tz || 'UTC',
      }).select('*');
      routines = seeded ?? [];
    }

    const { data: runs } = await supabase
      .from('agent_routine_runs')
      .select('id, routine_id, status, thread_id, started_at, seen_at, error')
      .eq('workspace_id', workspaceId)
      .order('started_at', { ascending: false })
      .limit(200);

    return res.json({ routines: (routines ?? []).map(r => present(r, runs ?? [])) });
  } catch (err) {
    console.error('[GET /api/routines]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── Create ──────────────────────────────────────────────────────────────────
routinesRouter.post('/', verifySupabaseAuth, async (req, res) => {
  try {
    const { workspaceId, name, prompt, trigger_kind, frequency, at_time,
            day_of_week, day_of_month, offset_minutes, timezone } = req.body ?? {};
    if (!workspaceId || !name?.trim() || !prompt?.trim()) {
      return res.status(400).json({ error: 'name_and_prompt_required' });
    }
    if (!['clock', 'before_meeting'].includes(trigger_kind)) {
      return res.status(400).json({ error: 'invalid_trigger_kind' });
    }
    if (trigger_kind === 'clock' && !FREQUENCIES.includes(frequency)) {
      return res.status(400).json({ error: 'invalid_frequency' });
    }

    const row = {
      workspace_id: workspaceId,
      user_id: req.internalUserId ?? null,
      name: name.trim(),
      prompt: prompt.trim(),
      trigger_kind,
      timezone: timezone || 'UTC',
      ...(trigger_kind === 'clock'
        ? {
            frequency,
            at_time: at_time || '09:00',
            day_of_week: frequency === 'weekly' ? (day_of_week ?? 1) : null,
            day_of_month: (frequency === 'monthly' || frequency === 'quarterly') ? (day_of_month ?? 1) : null,
          }
        : { offset_minutes: offset_minutes ?? 60 }),
    };

    const supabase = getSupabaseClient();
    // Compute the first slot up front, so the list can say when it next runs the
    // moment it's created rather than after the first tick.
    if (trigger_kind === 'clock') row.next_run_at = nextRunAt(row)?.toISOString() ?? null;

    const { data, error } = await supabase.from('agent_routines').insert(row).select('*').single();
    if (error) throw error;
    return res.status(201).json(present(data));
  } catch (err) {
    console.error('[POST /api/routines]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── Update (rename, re-prompt, re-schedule, pause) ──────────────────────────
routinesRouter.patch('/:id', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const patch = {};
    for (const k of ['name', 'prompt', 'enabled', 'trigger_kind', 'frequency', 'at_time',
                     'day_of_week', 'day_of_month', 'offset_minutes', 'timezone']) {
      if (req.body?.[k] !== undefined) patch[k] = req.body[k];
    }
    patch.updated_at = new Date().toISOString();

    const { data: current } = await supabase
      .from('agent_routines').select('*').eq('id', req.params.id).single();
    if (!current) return res.status(404).json({ error: 'not_found' });

    // Changing the KIND of trigger has to clear the other kind's fields.
    //
    // The row carries a CHECK that a clock routine holds a frequency and no offset,
    // and a meeting routine the reverse. Switching "every Monday" to "before every
    // meeting" while leaving the frequency behind violates it, and the save fails —
    // so the edit has to take the old shape away, not just add the new one.
    const kind = patch.trigger_kind ?? current.trigger_kind;
    if (kind === 'clock') {
      patch.offset_minutes = null;
      patch.frequency    = patch.frequency ?? current.frequency ?? 'weekly';
      patch.at_time      = patch.at_time   ?? current.at_time   ?? '09:00';
      // Weekly wants a weekday, monthly and quarterly want a day of the month, and
      // neither wants the other's — a leftover value would outlive the schedule.
      patch.day_of_week  = patch.frequency === 'weekly'
        ? (patch.day_of_week ?? current.day_of_week ?? 1) : null;
      patch.day_of_month = (patch.frequency === 'monthly' || patch.frequency === 'quarterly')
        ? (patch.day_of_month ?? current.day_of_month ?? 1) : null;
    } else {
      patch.frequency      = null;
      patch.day_of_week    = null;
      patch.day_of_month   = null;
      patch.next_run_at    = null;   // meeting runs come from the calendar, not a slot
      patch.offset_minutes = patch.offset_minutes ?? current.offset_minutes ?? 60;
    }

    // Any change to the schedule invalidates the stored slot — recompute it, or a
    // routine moved from 07:00 to 09:00 keeps firing at 07:00 until its next run.
    const merged = { ...current, ...patch };
    if (merged.trigger_kind === 'clock') {
      merged.next_run_at = nextRunAt(merged)?.toISOString() ?? null;
      patch.next_run_at = merged.next_run_at;
    }

    const { data, error } = await supabase
      .from('agent_routines').update(patch).eq('id', req.params.id).select('*').single();
    if (error) throw error;
    return res.json(present(data));
  } catch (err) {
    console.error('[PATCH /api/routines/:id]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

routinesRouter.delete('/:id', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { error } = await supabase.from('agent_routines').delete().eq('id', req.params.id);
    if (error) throw error;
    return res.status(204).end();
  } catch (err) {
    console.error('[DELETE /api/routines/:id]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── Run now ─────────────────────────────────────────────────────────────────
// A manual run is its own occurrence (stamped with the moment you asked), so it
// never collides with — or suppresses — the scheduled one.
routinesRouter.post('/:id/run', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { data: routine } = await supabase
      .from('agent_routines').select('*').eq('id', req.params.id).single();
    if (!routine) return res.status(404).json({ error: 'not_found' });

    const out = await runRoutine(routine, { dedupeKey: `manual|${new Date().toISOString()}` });
    return res.json(out);
  } catch (err) {
    console.error('[POST /api/routines/:id/run]', err);
    return res.status(500).json({ error: 'run_failed', detail: String(err.message ?? err) });
  }
});

// Mark a run's thread as read — clears the badge on Tasks.
routinesRouter.post('/runs/:runId/seen', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    await supabase.from('agent_routine_runs')
      .update({ seen_at: new Date().toISOString() }).eq('id', req.params.runId);
    return res.status(204).end();
  } catch (err) {
    console.error('[POST /api/routines/runs/:runId/seen]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── The scheduler tick ──────────────────────────────────────────────────────
// Driven by the worker's cron. Shared-secret auth: this runs the agent, so it must
// not be reachable by anyone who happens to find the URL.
routinesRouter.post('/tick', async (req, res) => {
  const secret = process.env.WORKER_SECRET;
  if (!secret || req.get('x-worker-secret') !== secret) {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    const results = await tickRoutines({});
    return res.json(results);
  } catch (err) {
    console.error('[POST /api/routines/tick]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
