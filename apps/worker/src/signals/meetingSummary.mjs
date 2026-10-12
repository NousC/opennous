// The internal meeting summary (GET-445): one consistent record of every call with only the team on
// it — Summary, Accounts, Insights (by scope, then topic), Decisions, Next steps, Open issues. The
// prompt and the shape live in packages/core/src/db/meetingSummaries.ts; this is the model call and
// the save, run once per internal call beside the team-insight extractor.

import { meetingHooks } from '../lib/meetingHooks.mjs';
import { buildInternalMeetingSummaryPrompt, parseInternalMeetingSummary, saveInternalMeetingSummary, fileInternalMeetingTasks, listInternalMeetings, internalMeetingSummaries,
  openInternalMeetingTasks, buildTaskClosurePrompt, parseTaskClosure, applyTaskClosure } from '@nous/core';
import { read } from '../noema/read.mjs';

/**
 * @param {object} a
 * @param {import('@supabase/supabase-js').SupabaseClient} a.supabase
 * @param {string}   a.workspaceId
 * @param {string}   a.transcript     the call's transcript (or notes, when that is all there is)
 * @param {string}   a.title
 * @param {string=}  a.occurredAt
 * @param {string}   a.sourceRef      `source://<system>/<id>` — the join key to the call everywhere
 * @param {string}   a.sourceSystem
 * @param {string}   a.subjectEntityId the internal attendee the summary is filed on
 * @param {string[]=} a.participants  names, so a misspelled speaker maps to a real person
 * @returns {Promise<boolean>} whether a summary was saved
 */
export async function summarizeInternalMeeting({ supabase, workspaceId, transcript, title, occurredAt, sourceRef, sourceSystem, subjectEntityId, participants = [] }) {
  try {
    if (!transcript || transcript.length < 200 || !subjectEntityId || !sourceRef) return false;
    // The same call from a second recorder (GET-458): it is already summarized under the first.
    const call = (await listInternalMeetings(supabase, workspaceId).catch(() => [])).find(x => x.refs.includes(sourceRef));
    const others = (call?.refs ?? []).filter(r => r !== sourceRef);
    if (others.length && (await internalMeetingSummaries(supabase, workspaceId, others)).size) {
      console.log(`[meeting-summary] ${sourceRef}: a second recording of a call already summarized — skipped`);
      return false;
    }
    const { data: ws } = await supabase.from('workspaces').select('name').eq('id', workspaceId).maybeSingle();
    // The host who recorded the call is not an attendee on record (they are "us"), so the roster is
    // what lets the model put a name to them rather than invent one.
    const { data: members } = await supabase.from('workspace_members').select('users:user_id(name)').eq('workspace_id', workspaceId);
    const team = (members ?? []).map(m => (Array.isArray(m.users) ? m.users[0] : m.users)?.name).filter(Boolean);
    const prompt = buildInternalMeetingSummaryPrompt({
      company: ws?.name || 'our company',
      title: title || 'Internal meeting',
      date: occurredAt ? String(occurredAt).slice(0, 10) : null,
      participants: [...new Set(participants.filter(Boolean))],
      team,
      transcript,
    });
    const result = await read({
      supabase, workspaceId,
      feature: 'internal-meeting-summary',
      tier: 'writing',
      maxTokens: 8000,
      accept: (t) => parseInternalMeetingSummary(t) !== null,
      parse: parseInternalMeetingSummary,
      prompt,
    });
    if (!result.ok) return false;
    const doc = await saveInternalMeetingSummary(supabase, workspaceId, {
      sourceRef, title: title || 'Internal meeting', occurredAt: occurredAt ?? null,
      subjectEntityId, summary: result.value, system: sourceSystem,
    });
    // First, what this meeting reports as done or dropped closes (GET-450); then its own next
    // steps become tasks (GET-446), linked to the meeting's page where there is one (Cloud).
    await closeTasksFromMeeting(supabase, workspaceId, { transcript, title: title || 'Internal meeting', occurredAt, sourceRef })
      .catch(err => console.warn('[MEETING_TASK_CLOSE_ERROR]', err?.message ?? err));
    // What the team believes now, rebuilt for the topics this meeting touched (GET-466). The GTM
    // brain's, so Cloud's: a no-op in the open-source edition (lib/meetingHooks.mjs, GET-839).
    await meetingHooks.afterSummary(supabase, workspaceId, doc)
      .catch(err => console.warn('[INSIGHT_SYNTHESIS_ERROR]', err?.message ?? err));
    await fileMeetingTasks(supabase, workspaceId, { sections: doc.sections, sourceRef, title: title || 'Internal meeting', occurredAt, subjectEntityId })
      .catch(err => console.warn('[MEETING_TASKS_ERROR]', err?.message ?? err));
    return true;
  } catch (err) {
    console.warn('[MEETING_SUMMARY_ERROR]', err?.message ?? err);
    return false;
  }
}

/** A stored summary's next steps → tasks. Shared by the live path and the backfill. */
export async function fileMeetingTasks(supabase, workspaceId, { sections, sourceRef, title, occurredAt, subjectEntityId }) {
  const meetingUrl = await meetingHooks.meetingUrl(supabase, workspaceId, sourceRef).catch(() => null);
  const n = await fileInternalMeetingTasks(supabase, workspaceId, {
    sections, sourceRef, title, occurredAt: occurredAt ?? null, fallbackEntityId: subjectEntityId, meetingUrl,
  });
  if (n) console.log(`[meeting-tasks] ${sourceRef}: ${n} next step(s) filed as tasks`);
  return n;
}

/**
 * Read this meeting against the team's open tasks from earlier internal meetings and close the
 * ones it shows done or dropped — only on a quote found in the transcript (GET-450).
 */
export async function closeTasksFromMeeting(supabase, workspaceId, { transcript, title, occurredAt, sourceRef }) {
  const tasks = await openInternalMeetingTasks(supabase, workspaceId, occurredAt ?? null);
  if (!tasks.length || !transcript || transcript.length < 200) return [];
  const result = await read({
    supabase, workspaceId,
    feature: 'internal-meeting-task-close',
    maxTokens: 3000,
    accept: (t) => parseTaskClosure(t) !== null,
    parse: parseTaskClosure,
    prompt: buildTaskClosurePrompt({ title, date: occurredAt ? String(occurredAt).slice(0, 10) : null, tasks, transcript }),
  });
  if (!result.ok || !result.value.length) return [];
  const url = await meetingHooks.meetingUrl(supabase, workspaceId, sourceRef).catch(() => null);
  const closed = await applyTaskClosure(supabase, workspaceId, {
    tasks, verdicts: result.value, transcript, meeting: { title, date: occurredAt ?? null, sourceRef, url },
  });
  if (closed.length) console.log(`[meeting-tasks] ${sourceRef}: closed ${closed.length} task(s) the meeting reported done or dropped`);
  return closed;
}

