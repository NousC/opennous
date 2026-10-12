// A call review written by an agent — the revenue plugin's Claude, in the user's own session — and
// sent through `record` as a `call_review` observation (GET-260).
//
// The review is the same JSON the worker's model pass returns (buildCallScorePrompt), so it goes
// through the same parser against the workspace rubric and lands through the same core store as the
// app's own reviews: host and team, a second recording merged into its call, call_scorecards, the
// Call page. Nothing here calls a model — the review is the agent's, the layout is ours.
//
// value: {
//   source, meeting_id, title?, url?, occurred_at?,
//   attendees: [{ email, name? }],          everyone on the call we can identify, both sides
//   organizer_email?, recorder_email?,      who set it up / whose note-taker recorded it
//   named_speakers?,                        true when the transcript names each speaker
//   source_ref?,
//   review: { call_type, summary, verdict, went_well: [], improve: [],
//             dimensions: [{ key, score, note, moment }], next_step_secured }
// }

import {
  getCoachingRubric,
  parseCallScoreJson,
  resolveCallHost,
  sidesOfCall,
  resolveCallTarget,
  storeCallReview,
} from '@nous/core';

const appUrl = () => (process.env.APP_URL || 'https://app.opennous.cloud').replace(/\/$/, '');

/** The attendee emails a review names, lowercased and de-duplicated. */
export function reviewAttendeeEmails(value) {
  const list = Array.isArray(value?.attendees) ? value.attendees : [];
  return [...new Set(list
    .map(a => String((a && typeof a === 'object' ? a.email : a) ?? '').trim().toLowerCase())
    .filter(e => e.includes('@')))];
}

export async function recordCallReviewFromAgent(supabase, workspaceId, { value, focusEntityId = null, userId = null, observedAt = null, sourceRef = null }) {
  const v = value && typeof value === 'object' ? value : {};
  const source = String(v.source ?? '').trim().toLowerCase() || null;
  const meetingId = String(v.meeting_id ?? '').trim();
  if (!source || !meetingId || !v.review || typeof v.review !== 'object') {
    return { status: 'invalid', error: 'call_review needs source, meeting_id and review' };
  }

  const rubric = await getCoachingRubric(supabase, workspaceId, 'default');
  const scored = parseCallScoreJson(JSON.stringify(v.review), rubric);
  if (scored.call_type !== 'sales') {
    return { status: 'not_sales', call_type: scored.call_type, meeting_id: meetingId };
  }
  // Same guard the worker applies: every dimension empty means the review didn't match this rubric.
  if (!scored.scores.length || scored.scores.every(s => s.score === 0 && !s.note)) {
    return {
      status: 'unusable',
      error: 'no dimension matched the workspace rubric',
      expected_keys: rubric.dimensions.map(d => d.key),
      meeting_id: meetingId,
    };
  }

  // Everyone on the call we hold a record for: the named attendees, plus the focus the review was sent on.
  const emails = reviewAttendeeEmails(v);
  const cols = 'id, first_name, last_name, email, company, company_id';
  const [{ data: byEmail }, { data: byFocus }] = await Promise.all([
    emails.length
      ? supabase.from('contacts').select(cols).eq('workspace_id', workspaceId).in('email', emails)
      : Promise.resolve({ data: [] }),
    focusEntityId
      ? supabase.from('contacts').select(cols).eq('workspace_id', workspaceId).eq('id', focusEntityId)
      : Promise.resolve({ data: [] }),
  ]);
  const contacts = [...new Map([...(byEmail ?? []), ...(byFocus ?? [])].map(c => [c.id, c])).values()];

  // The recorder is the member whose session wrote the review, unless the review names another.
  let recorder = null;
  if (userId) {
    const { data: u } = await supabase.from('users').select('id, name, email').eq('id', userId).maybeSingle();
    recorder = { userId, name: u?.name ?? null, email: v.recorder_email || u?.email || null };
  } else if (v.recorder_email) {
    recorder = { userId: null, name: null, email: v.recorder_email };
  }
  const hostUserId = await resolveCallHost(supabase, workspaceId, {
    organizerEmail: v.organizer_email || null,
    recorderEmail: recorder?.email ?? null,
    recorderUserId: recorder?.userId ?? null,
  });

  const occurredAt = v.occurred_at || observedAt || new Date().toISOString();
  const sides = await sidesOfCall(supabase, workspaceId, { contacts, hostUserId, recorder });
  const target = await resolveCallTarget(supabase, workspaceId, {
    meetingId, source, url: v.url || null, namedSpeakers: !!v.named_speakers, occurredAt, contacts, sides, hostUserId,
  });
  // An agent's review is a full read of the transcript, so it replaces whatever review the call had.
  const stored = await storeCallReview(supabase, workspaceId, {
    score: scored,
    rubric: { role: rubric.role, version: rubric.version },
    target,
    sides,
    title: v.title || null,
    occurredAt,
    primaryEntityId: focusEntityId,
    sourceRef: v.source_ref || sourceRef || `source://${source}/${meetingId}`,
  });

  return {
    status: 'stored',
    meeting_id: stored.meetingId,
    overall: scored.overall,
    next_step_secured: scored.next_step_secured,
    merged_into_existing_call: !!target.existing,
    team_user_ids: target.teamUserIds,
    page_url: stored.documentId ? `${appUrl()}/pages/${stored.documentId}` : null,
  };
}
