/**
 * An internal meeting closes the tasks it shows done (GET-450).
 *
 * Next steps become tasks (GET-446), and the next meeting is usually where they are reported
 * back: "the pricing page is live", "we dropped the coaching tab". So when a meeting is
 * summarized, the open tasks from earlier internal meetings are read against its transcript,
 * and a task is closed when the meeting shows it done — or explicitly dropped.
 *
 * The bar is a verbatim quote, and the quote is checked against the transcript here, in code:
 * a close the model cannot point to in the words actually said is not a close. A false "done"
 * hides work somebody still owes, which is worse than leaving a task open a week too long.
 * Every close records the quote and the meeting, so it can be checked and reopened.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface OpenMeetingTask { claimId: string; key: string; title: string; owner: string | null; occurredAt: string | null; value: Record<string, unknown> }
export interface TaskVerdict { task: string; verdict: 'done' | 'dropped'; quote: string }

const LOOKBACK_DAYS = 45;
const MAX_TASKS = 80;

/** Open tasks from internal meetings held before this one, newest first. */
export async function openInternalMeetingTasks(
  supabase: SupabaseClient, workspaceId: string, before: string | null,
): Promise<OpenMeetingTask[]> {
  const since = new Date(Date.parse(before ?? new Date().toISOString()) - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const { data, error } = await supabase.from('claims').select('id, value')
    .eq('workspace_id', workspaceId).gte('property', 'action_item.internal_').lt('property', 'action_item.internal`')
    .is('invalid_at', null).limit(2000);
  if (error) throw error;
  const day = (before ?? '9999').slice(0, 10);
  return (data ?? [])
    .map(r => ({ id: r.id as string, v: (r.value ?? {}) as Record<string, unknown> }))
    .filter(r => r.v.status === 'open')
    .filter(r => { const d = String(r.v.occurred_at ?? '').slice(0, 10); return d && d < day && d >= since; })
    .sort((a, b) => String(b.v.occurred_at).localeCompare(String(a.v.occurred_at)))
    .slice(0, MAX_TASKS)
    .map((r, i) => ({
      claimId: r.id, key: `T${i + 1}`, title: String(r.v.title ?? ''),
      owner: (r.v.owner_name as string) ?? null, occurredAt: (r.v.occurred_at as string) ?? null, value: r.v,
    }))
    .filter(t => t.title);
}

export function buildTaskClosurePrompt(input: { title: string; date: string | null; tasks: OpenMeetingTask[]; transcript: string }): string {
  return [
    'You are checking an internal meeting against the team\'s open tasks.',
    `Meeting: ${input.title}${input.date ? ` (${input.date})` : ''}`,
    '',
    'OPEN TASKS (from earlier meetings)',
    ...input.tasks.map(t => `${t.key} · ${t.owner ?? 'unassigned'} · ${String(t.occurredAt ?? '').slice(0, 10)} · ${t.title}`),
    '',
    'For each task, decide from THIS transcript only:',
    '- "done": someone states it was completed, delivered, shipped or sent ("the pricing page is live", "I sent Rowan the email").',
    '- "dropped": the team explicitly decides not to do it, or replaces it with something else ("forget the coaching tab").',
    'Anything else is not a verdict: a task mentioned, discussed, planned, in progress or still open is left out.',
    'The quote must state that THIS task itself was completed or dropped. Words that only mention its topic do',
    'not qualify: for "Start the backfill", "after backfilling, pricing changes" is NOT done; "the backfill is running" is.',
    'Be strict. A false "done" hides work someone still owes; leaving a task open costs nothing.',
    '',
    'Return ONLY a JSON array, empty if nothing qualifies:',
    '[{ "task": "T3", "verdict": "done" | "dropped", "quote": "the exact words from the transcript, max 25 words" }]',
    'The quote must be copied verbatim from the transcript. No quote, no verdict.',
    '',
    'TRANSCRIPT',
    input.transcript.slice(0, 180_000),
  ].join('\n');
}

export function parseTaskClosure(text: string): TaskVerdict[] | null {
  const s = String(text ?? '');
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a === -1 || b < a) return null;
  let arr: unknown;
  try { arr = JSON.parse(s.slice(a, b + 1)); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  return arr
    .map(x => (x && typeof x === 'object' ? x as Record<string, unknown> : {}))
    .map(x => ({ task: String(x.task ?? '').trim(), verdict: x.verdict === 'dropped' ? 'dropped' as const : 'done' as const, quote: String(x.quote ?? '').trim() }))
    .filter(x => /^T\d+$/.test(x.task) && x.quote.length >= 8);
}

const norm = (s: string) => s.toLowerCase().replace(/[“”"'’`]/g, '').replace(/[^a-z0-9$%€]+/g, ' ').trim();

/**
 * Is the quote really in the transcript? Exact after normalising punctuation and case; or, for a
 * quote the model trimmed mid-sentence, a run of 8 consecutive words of it that is.
 */
export function quoteInTranscript(quote: string, transcript: string): boolean {
  const q = norm(quote), t = norm(transcript);
  if (!q) return false;
  if (t.includes(q)) return true;
  const words = q.split(' ');
  if (words.length < 8) return false;
  for (let i = 0; i + 8 <= words.length; i++) if (t.includes(words.slice(i, i + 8).join(' '))) return true;
  return false;
}

/** Close the tasks the verdicts name, with the quote and the meeting as the evidence. Returns the closed titles. */
export async function applyTaskClosure(
  supabase: SupabaseClient, workspaceId: string,
  input: { tasks: OpenMeetingTask[]; verdicts: TaskVerdict[]; transcript: string; meeting: { title: string; date: string | null; sourceRef: string; url: string | null } },
): Promise<string[]> {
  const byKey = new Map(input.tasks.map(t => [t.key, t]));
  const closed: string[] = [];
  const now = new Date().toISOString();
  for (const v of input.verdicts) {
    const t = byKey.get(v.task);
    if (!t || !quoteInTranscript(v.quote, input.transcript)) continue;
    const when = input.meeting.date ? ` (${input.meeting.date.slice(0, 10)})` : '';
    const next = {
      ...t.value,
      status: 'done',
      completed_at: now,
      completed_by: 'meeting',
      completed_reason: v.verdict === 'dropped'
        ? `dropped in ${input.meeting.title}${when}`
        : `reported done in ${input.meeting.title}${when}`,
      completed_evidence: {
        kind: 'internal_meeting', verdict: v.verdict, quote: v.quote,
        source_ref: input.meeting.sourceRef, source_title: input.meeting.title, source_url: input.meeting.url, occurred_at: input.meeting.date,
      },
    };
    const { error } = await supabase.from('claims').update({ value: next }).eq('workspace_id', workspaceId).eq('id', t.claimId);
    if (error) throw error;
    closed.push(t.title);
  }
  return closed;
}

// ── Near-duplicates ─────────────────────────────────────────────────────────

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'for', 'with', 'on', 'in', 'at', 'by', 'from', 'is', 'it', 'its', 'our', 'we']);
const words = (s: string) => new Set(norm(s).split(' ').filter(w => w.length > 1 && !STOP.has(w)));

/** Two task titles that say the same thing: most of their words in common (the same call recorded twice). */
export function sameTask(a: string, b: string): boolean {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return false;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / Math.min(x.size, y.size) >= 0.7;
}

/**
 * Is this commitment a task already filed from ANOTHER recording of the same call (GET-786)?
 *
 * One customer call recorded twice (two teammates' Granola notes, Granola and Fireflies) is two
 * meeting ids, and each read filed its own `action_item.meeting_<id>_<i>`: the same promise, worded
 * a little differently, twice on the account. A row counts as the same task only when it came from
 * another CALL (source_type meeting, a different meeting id), was said within two days, and the two
 * titles share most of ALL their words — Jaccard, not sameTask's overlap-of-the-smaller, which calls
 * "Follow up with Dorian on the contract" and "…on the invoice" one task. An email task or a typed
 * one is never a repeat of a call's: a call often restates an email's promise with something new.
 */
export function repeatsFiledTask(
  rows: { value: Record<string, unknown> | null }[],
  input: { title: string; sourceId: string; at: string | null },
): boolean {
  const at = Date.parse(input.at ?? '');
  if (Number.isNaN(at)) return false;
  const mine = words(input.title);
  if (!mine.size) return false;
  return rows.some(r => {
    const v = r.value ?? {};
    if (v.source_type !== 'meeting' || String(v.source_id ?? '') === input.sourceId) return false;
    const said = Date.parse(String(v.occurred_at ?? ''));
    if (Number.isNaN(said) || Math.abs(said - at) > 2 * 86_400_000) return false;
    const theirs = words(String(v.title ?? ''));
    let both = 0;
    for (const w of mine) if (theirs.has(w)) both++;
    return both / (mine.size + theirs.size - both) >= 0.8;
  });
}
