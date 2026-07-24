// Running a routine.
//
// A scheduled run is not a special kind of agent — it is the SAME agent the user
// talks to on Home, handed the same kind of question, writing into the same kind
// of thread. That's deliberate: a brief the agent produced at 07:00 should be
// something you can reply to at 07:05 and keep pushing on. A scheduled result you
// can't interrogate is just a notification, and notifications get ignored.
//
// So we drain streamAgentTurn (nobody is watching the stream; we only want the
// final answer plus its tool trace) and persist it exactly as a chat turn.

import { getSupabaseClient } from '@nous/core';
import { streamAgentTurn, loadMemberProfile } from './playgroundAgent.mjs';
import { getMeetings } from './calendar.mjs';
import { nextRunAt } from './routineSchedule.mjs';

const DAY = 86_400_000;

/**
 * Execute one routine occurrence and land the result in a thread.
 *
 * `dedupeKey` identifies the OCCURRENCE (this Monday's slot, that specific call),
 * not the moment — the unique index on it is what makes a double-fire impossible,
 * whether the cause is a worker restart, an overlapping tick, or a calendar re-sync.
 *
 * Returns { status, thread_id } — or { status: 'skipped' } when this occurrence
 * already ran.
 */
export async function runRoutine(routine, { dedupeKey, meeting = null } = {}) {
  const supabase = getSupabaseClient();

  // Claim the occurrence FIRST. If another worker (or an earlier tick) already
  // has it, the unique constraint rejects us and we stop here — before spending a
  // model call, not after.
  const { data: run, error: claimErr } = await supabase
    .from('agent_routine_runs')
    .insert({
      routine_id:   routine.id,
      workspace_id: routine.workspace_id,
      dedupe_key:   dedupeKey,
      status:       'running',
      entity_id:    meeting?.entity_id ?? null,
    })
    .select('id')
    .single();

  if (claimErr) {
    if (claimErr.code === '23505') return { status: 'skipped' };   // already ran
    throw claimErr;
  }

  try {
    // What the agent is actually asked. For a meeting routine we pin the call it
    // is about, because "brief me on my next meeting" run at 06:00 for a 07:00
    // call must brief THAT call — not whatever is next by the time it executes.
    const question = meeting
      ? [
          routine.prompt,
          '',
          'The meeting this is about:',
          `  ${meeting.title}`,
          `  starts ${meeting.when}`,
          meeting.with ? `  with ${meeting.with}${meeting.company ? ` (${meeting.company})` : ''}` : '',
          meeting.entity_id ? `  entity id: ${meeting.entity_id}` : '',
        ].filter(Boolean).join('\n')
      : routine.prompt;

    const memberProfile = routine.user_id
      ? await loadMemberProfile(supabase, routine.workspace_id, routine.user_id).catch(() => null)
      : null;

    let content = '';
    let toolCalls = [];
    for await (const ev of streamAgentTurn({
      supabase,
      workspaceId:  routine.workspace_id,
      history:      [],
      userMessage:  question,
      userId:       routine.user_id ?? null,
      memberProfile,
    })) {
      if (ev.type === 'done') { content = ev.content; toolCalls = ev.toolCalls ?? []; }
    }

    // The thread. Titled for the routine (and the call, when there is one) so the
    // Threads list reads like a diary of what the agent did while you were away.
    //
    // playground_threads.user_id references the internal users.id (same id space
    // as routines and every other workspace object), so the routine's owner id
    // goes straight in — no auth-id translation needed.
    const title = meeting ? `${routine.name}: ${meeting.title}`.slice(0, 120) : routine.name;
    const { data: thread, error: threadErr } = await supabase
      .from('playground_threads')
      .insert({
        workspace_id: routine.workspace_id,
        user_id: routine.user_id ?? null,
        title,
      })
      .select('id')
      .single();
    if (threadErr) throw threadErr;

    // Persist as a normal chat turn: the ask, then the answer with its evidence.
    // This is why a routine result is continuable — it IS a conversation.
    await supabase.from('playground_messages').insert([
      { thread_id: thread.id, role: 'user',      content: question, tool_calls: null },
      { thread_id: thread.id, role: 'assistant', content, tool_calls: toolCalls.length ? toolCalls : null },
    ]);

    await supabase.from('agent_routine_runs')
      .update({ status: 'ok', thread_id: thread.id, finished_at: new Date().toISOString() })
      .eq('id', run.id);

    // Count it as usage, on its own surface. A briefing you didn't have to ask for
    // is still the agent working for you, and Adoption should say so.
    await supabase.from('workspace_system_log').insert({
      workspace_id: routine.workspace_id,
      user_id:      routine.user_id ?? null,
      source:       'schedule',
      event_type:   'routine.run',
      use_case:     meeting ? 'meeting_prep' : null,
      summary:      routine.name,
      metadata:     { routine_id: routine.id, tools: toolCalls.map(t => t.name) },
    }).then(() => {}, () => {});   // never fail a run over its own telemetry

    return { status: 'ok', thread_id: thread.id };
  } catch (err) {
    // A failed run must not consume the occurrence forever.
    //
    // The claim is written BEFORE the work (that's what makes double-firing
    // impossible), which means a run that dies holds a claim on a brief that never
    // happened. Left alone, the ledger would insist that Tuesday's call was already
    // briefed and quietly never brief it — the failure mode where you find out by
    // walking into the meeting cold.
    //
    // So on failure we keep the row (you should be able to see that it broke, and
    // why) but release its claim by making the key unique to this attempt. The next
    // tick is then free to try again, bounded naturally by the trigger window.
    await supabase.from('agent_routine_runs')
      .update({
        status: 'error',
        error: String(err.message ?? err).slice(0, 500),
        dedupe_key: `${dedupeKey}|failed|${run.id}`,
        finished_at: new Date().toISOString(),
      })
      .eq('id', run.id);
    throw err;
  }
}

/**
 * The scheduler tick. Finds everything due and runs it.
 *
 * Called on a cron from the worker, and safe to call from anywhere: every run is
 * claimed through the unique index, so a concurrent tick can't double-fire.
 */
export async function tickRoutines({ now = new Date() } = {}) {
  const supabase = getSupabaseClient();
  const results = { clock: 0, meetings: 0, skipped: 0, errors: 0 };

  const { data: routines } = await supabase
    .from('agent_routines')
    .select('*')
    .eq('enabled', true);

  for (const r of routines ?? []) {
    try {
      if (r.trigger_kind === 'clock') {
        // Due when the stored next_run_at has passed. A routine with none yet
        // (freshly created) gets one computed and waits for its slot — creating a
        // routine should never make it fire immediately.
        if (!r.next_run_at) {
          await supabase.from('agent_routines')
            .update({ next_run_at: nextRunAt(r, now)?.toISOString() ?? null })
            .eq('id', r.id);
          continue;
        }
        if (new Date(r.next_run_at) > now) continue;

        // Advance the clock BEFORE running. If the run throws, the routine still
        // moves to its next slot rather than retrying in a hot loop every tick.
        const slot = r.next_run_at;
        await supabase.from('agent_routines')
          .update({ next_run_at: nextRunAt(r, now)?.toISOString() ?? null, last_run_at: now.toISOString() })
          .eq('id', r.id);

        const out = await runRoutine(r, { dedupeKey: `clock|${slot}` });
        out.status === 'skipped' ? results.skipped++ : results.clock++;
      }

      if (r.trigger_kind === 'before_meeting') {
        // Look ahead exactly as far as the offset. A meeting is due for its brief
        // once we are inside the offset window — i.e. it starts within the next
        // `offset_minutes`. The unique dedupe key (this call, this start time)
        // means we brief each call once and only once, however often we look.
        const offsetMs = (r.offset_minutes ?? 60) * 60_000;
        const meetings = await getMeetings(supabase, r.workspace_id, {
          fromDays: 0,
          toDays: Math.ceil(offsetMs / DAY) + 1,
          upcomingOnly: true,
        }).catch(() => []);

        for (const m of meetings) {
          const startsIn = +new Date(m.when) - +now;
          if (startsIn < 0 || startsIn > offsetMs) continue;   // not yet inside the window (or already started)
          const out = await runRoutine(r, {
            dedupeKey: `meeting|${m.entity_id ?? 'none'}|${m.when}`,
            meeting: m,
          });
          out.status === 'skipped' ? results.skipped++ : results.meetings++;
        }
      }
    } catch (err) {
      results.errors++;
      console.error(`[routines] ${r.name} (${r.id}):`, err.message);
    }
  }

  return results;
}
