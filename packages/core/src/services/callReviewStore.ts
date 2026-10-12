import type { SupabaseClient } from '@supabase/supabase-js';
import { getInternalEntityIds, teamUserIdsForEntities } from '../db/teamMembers.js';
import {
  upsertScorecard, linkScorecardDocument, findScorecardForCall, type ScorecardStored,
} from '../db/callScorecards.js';
import { writeCallPage, type CallRecording } from './callPage.js';
import type { CallScore, CallPerson } from './callScoring.js';

// Storing a call review (GET-260): ONE path for every reviewer. The worker's model pass (scoreCall)
// and the revenue plugin — Claude in the user's own session, sending its review through `record` —
// both land here, so a call reviewed either way gets the same host, the same team credit, the same
// merge with a second recording, the same scorecard and the same Call page. Nothing in this file
// calls a model.

export interface CallContact {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  company?: string | null;
  company_id?: string | null;
}

export interface CallRecorder { name?: string | null; email?: string | null; userId?: string | null }

export interface CallSides {
  /** The buyer-side contacts. */
  buyers: CallContact[];
  /** Every teammate on the call: the host, the recorder, and internal contacts that are members. */
  teamUserIds: string[];
  /** Everyone, named from our records and tagged team/buyer, for the review prompt. */
  people: CallPerson[];
  hostName: string | null;
  teamNames: string[];
}

const fullName = (c: CallContact) => [c?.first_name, c?.last_name].filter(Boolean).join(' ') || null;

/**
 * Who is on the call, on which side. Teammates are the contacts flagged internal (each carries the
 * member it IS) plus the host and the recorder; everyone else is the buyer side.
 */
export async function sidesOfCall(
  supabase: SupabaseClient,
  workspaceId: string,
  { contacts, hostUserId, recorder }: { contacts: CallContact[]; hostUserId: string | null; recorder?: CallRecorder | null },
): Promise<CallSides> {
  const internal = await getInternalEntityIds(supabase, workspaceId).catch(() => new Set<string>());
  const teamContacts = contacts.filter(c => internal.has(c.id));
  const buyers = contacts.filter(c => !internal.has(c.id));
  const memberOf = await teamUserIdsForEntities(supabase, workspaceId, teamContacts.map(c => c.id)).catch(() => new Map<string, string>());

  const teamUserIds = [...new Set([hostUserId, recorder?.userId, ...teamContacts.map(c => memberOf.get(c.id))]
    .filter((x): x is string => !!x))];
  const { data: users } = teamUserIds.length
    ? await supabase.from('users').select('id, name, email').in('id', teamUserIds)
    : { data: [] as { id: string; name: string | null; email: string | null }[] };
  const userById = new Map((users ?? []).map((u: { id: string; name: string | null; email: string | null }) => [u.id, u]));

  const recorderEmail = String(recorder?.email ?? '').toLowerCase();
  const people: CallPerson[] = [];
  const named = new Set<string>();
  const push = (p: CallPerson) => {
    const key = String(p.email || p.name || '').toLowerCase();
    if (!key || named.has(key)) return;
    named.add(key);
    people.push(p);
  };
  for (const id of teamUserIds) {
    const u = userById.get(id);
    const isRecorder = id === recorder?.userId;
    push({
      name: u?.name || (isRecorder ? recorder?.name : null) || null,
      email: isRecorder && recorder?.email ? recorder.email : (u?.email || null),
      side: 'team', host: id === hostUserId, recorder: isRecorder,
    });
    // A teammate's other addresses (the note-taker account vs the login) are the same person.
    if (isRecorder && recorder?.email) named.add(String(u?.email ?? '').toLowerCase());
  }
  for (const c of teamContacts) {
    const member = memberOf.get(c.id);
    if (member && teamUserIds.includes(member)) { named.add(String(c.email ?? '').toLowerCase()); continue; }
    push({ name: fullName(c), email: c.email || null, side: 'team', recorder: !!recorderEmail && String(c.email ?? '').toLowerCase() === recorderEmail });
  }
  if (recorder && !recorder.userId && (recorder.name || recorder.email)) push({ name: recorder.name ?? null, email: recorder.email ?? null, side: 'team', recorder: true });
  for (const c of buyers) push({ name: fullName(c), email: c.email || null, company: c.company || null, side: 'buyer' });

  const hostName = (hostUserId ? userById.get(hostUserId)?.name : null)
    || (hostUserId && hostUserId === recorder?.userId ? recorder?.name ?? null : null)
    || null;
  const teamNames = people.filter(p => p.side === 'team').map(p => p.name || p.email).filter((x): x is string => !!x);
  return { buyers, teamUserIds, people, hostName, teamNames };
}

const recordingKey = (r: CallRecording) => `${String(r.source ?? '').toLowerCase()}:${r.meeting_id}`;

/** Every recording of a call, once each; a later copy of the same recording fills in what the first lacked. */
export function mergeRecordings(...lists: CallRecording[][]): CallRecording[] {
  const out = new Map<string, CallRecording>();
  for (const r of lists.flat()) if (r && r.meeting_id) out.set(recordingKey(r), { ...out.get(recordingKey(r)), ...r });
  return [...out.values()];
}

/** Where a review of this recording belongs: its own call, or the call another recording already opened. */
export interface CallReviewTarget {
  existing: ScorecardStored | null;
  meetingId: string;
  source: string | null;
  hostUserId: string | null;
  recordings: CallRecording[];
  teamUserIds: string[];
}

export async function resolveCallTarget(
  supabase: SupabaseClient,
  workspaceId: string,
  call: {
    meetingId: string; source: string | null; url?: string | null; namedSpeakers?: boolean;
    occurredAt: string; contacts: CallContact[]; sides: CallSides | null; hostUserId: string | null;
    // WHO PROVES TWO RECORDINGS ARE ONE CALL. Only an EXTERNAL participant can: our own staff are on
    // every call, so matching on "any shared contact within three hours" merged two different
    // dealerships' installations because one CS manager ran both that afternoon. Their pages, their
    // risks and their commitments became one record. Omit it and every contact matches, which is
    // the old behaviour — kept so callers that cannot tell the sides apart are unchanged.
    matchContactIds?: string[];
  },
): Promise<CallReviewTarget> {
  const thisRecording: CallRecording = { source: call.source, meeting_id: String(call.meetingId), url: call.url || null, named_speakers: !!call.namedSpeakers };
  const matchIds = call.matchContactIds ?? call.contacts.map(c => c.id);
  const existing = matchIds.length
    ? await findScorecardForCall(supabase, workspaceId, { contactIds: matchIds, occurredAt: call.occurredAt, meetingId: String(call.meetingId) }).catch(() => null)
    : null;
  const teamUserIds = call.sides?.teamUserIds ?? (call.hostUserId ? [call.hostUserId] : []);
  if (!existing) {
    return { existing: null, meetingId: String(call.meetingId), source: call.source, hostUserId: call.hostUserId, recordings: [thisRecording], teamUserIds };
  }
  return {
    existing,
    meetingId: existing.meeting_id,
    source: existing.source,
    hostUserId: existing.rep_user_id || call.hostUserId,
    recordings: mergeRecordings(existing.recordings?.length ? existing.recordings : [{ source: existing.source, meeting_id: existing.meeting_id }], [thisRecording]),
    teamUserIds: [...new Set([...(existing.team_user_ids ?? []), ...teamUserIds])],
  };
}

/**
 * Store a sales-call review and lay out its Call page. `score` must already be a parsed CallScore of
 * type 'sales'. The page is written even when the scorecard write fails loudly elsewhere, and a page
 * failure never loses the scorecard. Returns the document id when a page was written.
 */
export async function storeCallReview(
  supabase: SupabaseClient,
  workspaceId: string,
  input: {
    score: CallScore;
    rubric: { role: string | null; version: number | null } | null;
    target: CallReviewTarget;
    sides: CallSides | null;
    title: string | null;
    occurredAt: string;
    primaryEntityId?: string | null;
    accountEntityId?: string | null;
    mentionEntityIds?: string[];
    sourceRef?: string | null;
  },
): Promise<{ documentId: string | null; meetingId: string }> {
  const { score, rubric, target, sides } = input;
  const buyers = sides?.buyers ?? [];
  const primaryEntityId = target.existing?.entity_id || input.primaryEntityId || buyers[0]?.id || null;
  const account = input.accountEntityId || buyers[0]?.company_id || primaryEntityId;
  const occurredAt = target.existing?.occurred_at || input.occurredAt;

  await upsertScorecard(supabase, {
    workspaceId,
    meetingId: target.meetingId,
    source: target.source,
    entityId: primaryEntityId,
    repUserId: target.hostUserId,
    rubricRole: rubric?.role ?? null,
    rubricVersion: rubric?.version ?? null,
    overall: score.overall,
    scores: score.scores,
    nextStepSecured: score.next_step_secured,
    occurredAt,
    callType: score.call_type,
    summary: score.summary,
    verdict: score.verdict,
    wentWell: score.went_well,
    improve: score.improve,
    teamUserIds: target.teamUserIds,
    recordings: target.recordings,
  });

  let documentId: string | null = null;
  try {
    const page = await writeCallPage(supabase, workspaceId, {
      score,
      meetingId: target.meetingId,
      title: input.title || 'Call',
      source: target.source,
      url: target.recordings.find(r => r.meeting_id === target.meetingId)?.url ?? null,
      recordings: target.recordings,
      host: sides?.hostName ?? null,
      team: sides?.teamNames ?? [],
      occurredAt,
      subjectEntityId: account,
      mentionEntityIds: sides ? buyers.map(b => b.id) : (input.mentionEntityIds ?? []),
      repUserId: target.hostUserId,
      sourceRef: input.sourceRef ?? null,
      // The page names the kind of call in Pages: "Demo — Quarry Ridge Motors — Sep 17, 2025".
      callType: score.call_type,
    });
    if (page?.id) {
      documentId = page.id;
      await linkScorecardDocument(supabase, workspaceId, target.meetingId, page.id);
    }
  } catch (err) {
    console.warn(`[call-review] call page for meeting ${target.meetingId} failed:`, (err as Error)?.message ?? err);
  }
  return { documentId, meetingId: target.meetingId };
}
