import type { SupabaseClient } from '@supabase/supabase-js';
import type { CallScore } from './callScoring.js';
import { healthHeadline, healthPageSections, type AccountHealth } from './accountHealth.js';
import { writeDocument, type DocumentRow, type DocumentSection } from '../db/documents.js';

// The call page (GET-236): every sales call a note-taker records becomes one page in Pages,
// filed on the account. Summary → the link to the transcript → the sales call score → what went
// well and what to improve. The raw transcript is NOT on the page: it stays in the call's meeting
// notes and evidence file, where the agent reads it.
//
// ONE builder for every note-taker. Granola, Fireflies and Fathom (and Fellow next) all call
// writeCallPage through the worker's scorer, so the four can never lay a call out four ways.

const SOURCE_LABEL: Record<string, string> = {
  granola: 'Granola',
  fireflies: 'Fireflies',
  fathom: 'Fathom',
  fellow: 'Fellow',
  ringcentral: 'RingCentral',
};

/** The note-taker's logo, as the app serves it (apps/frontend/public/provider-logos). */
export function callSourceLogo(source: string | null | undefined): string | null {
  const s = String(source ?? '').toLowerCase();
  if (!SOURCE_LABEL[s]) return null;
  return `/provider-logos/${s}.${s === 'fellow' ? 'png' : 'svg'}`;
}

export function callSourceLabel(source: string | null | undefined): string {
  const s = String(source ?? '').toLowerCase();
  return SOURCE_LABEL[s] ?? (s ? s.charAt(0).toUpperCase() + s.slice(1) : 'the note-taker');
}

/**
 * A call page's title: what it is, the call's own name, and the day it happened (ruled 2026-09-14) —
 * "Call summary — Harborline.example x OpenNous — Sep 14, 2026". The date is the call's, in UTC, so a
 * page reads the same for everyone and a re-review never renames it.
 */
/** What to call each kind of call in the Pages list, so a year of them reads at a glance. */
const CALL_TYPE_TITLE: Record<string, string> = {
  discovery: 'Discovery call',
  demo: 'Demo',
  proposal: 'Proposal call',
  onboarding: 'Onboarding',
  training: 'Training',
  business_review: 'Business review',
};

export function callPageTitle(
  callName: string | null | undefined,
  occurredAt: string | null | undefined,
  callType?: string | null,
): string {
  const name = String(callName ?? '').trim() || 'Call';
  const prefix = CALL_TYPE_TITLE[String(callType ?? '').toLowerCase()] ?? 'Call summary';
  const t = Date.parse(String(occurredAt ?? ''));
  const day = Number.isFinite(t)
    ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(t))
    : null;
  return [prefix, name, day].filter(Boolean).join(' — ');
}

/** The series a call's page versions under. A re-analysed call replaces its own page and no other. */
export function callPageSeries(source: string | null | undefined, meetingId: string): string {
  return `call:${String(source ?? 'unknown').toLowerCase()}:${meetingId}`;
}

/** One note-taker's recording of the call. A call two teammates both recorded has two. */
export interface CallRecording { source: string | null; url?: string | null; meeting_id?: string | null; named_speakers?: boolean }

export interface CallPageInput {
  title: string;
  source: string | null;
  url?: string | null;
  /** Every recording of the call; defaults to the one named by `source` + `url`. */
  recordings?: CallRecording[];
  /** Who set up the meeting (owns the call), and the other teammates on it — display names. */
  host?: string | null;
  team?: string[];
}

function recordingLine(r: CallRecording): string {
  const label = callSourceLabel(r.source);
  const logo = callSourceLogo(r.source);
  const mark = logo ? `![${label}](${logo}) ` : '';
  return r.url
    ? `[${mark}Open the call in ${label}](${r.url})`
    : `${mark}The full transcript from ${label} is saved with this call's meeting notes.`;
}

/** The page's sections, in reading order. Pure: the same score always lays out the same page. */
export function callPageSections(score: CallScore, call: CallPageInput): DocumentSection[] {
  const sections: DocumentSection[] = [];

  if (score.summary) sections.push({ label: 'Summary', body: score.summary });

  // Who ran it, then every recording. The logo rides inside the link as a markdown image; Prose
  // draws /provider-logos/ images as an inline icon rather than a full-width picture.
  const recordings = call.recordings?.length ? call.recordings : [{ source: call.source, url: call.url ?? null }];
  const others = (call.team ?? []).filter(n => n && n !== call.host);
  const who = call.host
    ? `Hosted by **${call.host}**${others.length ? ` with ${others.join(', ')}` : ''}`
    : others.length ? `With ${others.join(', ')}` : '';
  sections.push({
    label: 'Transcript',
    body: [who, ...recordings.map(recordingLine)].filter(Boolean).join('\n\n'),
  });

  const lines: string[] = [];
  lines.push(`**Overall ${score.overall}/10.**${score.verdict ? ` ${score.verdict}` : ''}`);
  for (const d of score.scores) {
    lines.push(`**${d.label} ${d.score}/10:** ${d.note || 'No evidence on this call.'}`);
  }
  lines.push(`**Next step secured:** ${score.next_step_secured ? 'yes' : 'no'}`);
  sections.push({ label: 'Sales call score', body: lines.join('\n\n') });

  if (score.went_well) sections.push({ label: 'Went well', body: score.went_well });
  if (score.improve) sections.push({ label: 'Improve', body: score.improve });
  return sections;
}

export interface WriteCallPageInput extends CallPageInput {
  score: CallScore;
  meetingId: string;
  occurredAt: string;
  /** The account the call was with (the company when known, else the person). */
  subjectEntityId: string | null;
  /** Everyone else on the call from the buyer's side. */
  mentionEntityIds?: string[];
  repUserId?: string | null;
  sourceRef?: string | null;
  /** What kind of call it was, so the page names itself in the Pages list. */
  callType?: string | null;
}

/**
 * File the health read of a CUSTOMER call into Pages (GET-288).
 *
 * Same page, different shape: a business review or a training session still belongs in Pages —
 * what changes is that it carries the state of the account rather than a grade of the rep. No
 * scorecard, so it never reaches Coaching.
 */
export async function writeHealthPage(
  supabase: SupabaseClient,
  workspaceId: string,
  health: AccountHealth,
  input: Omit<WriteCallPageInput, 'score'>,
): Promise<DocumentRow | null> {
  if (!input.subjectEntityId) return null;
  const label = callSourceLabel(input.source);
  const recordings = input.recordings?.length ? input.recordings : [{ source: input.source, url: input.url ?? null, meeting_id: input.meetingId }];
  const sources = recordings
    .map(r => (r.meeting_id ? { system: callSourceLabel(r.source), ref: `source://${String(r.source ?? '').toLowerCase()}/${r.meeting_id}`, detail: input.title || 'Call', when: input.occurredAt } : null))
    .filter((x): x is NonNullable<typeof x> => !!x);
  if (!sources.length && input.sourceRef) sources.push({ system: label, ref: input.sourceRef, detail: input.title || 'Call', when: input.occurredAt });

  // The transcript line the coaching page carries, minus the score: how to reach the recording.
  const who = (input.host ? `Hosted by **${input.host}**` : '');
  const transcriptSection = {
    label: 'Transcript',
    body: [who, ...recordings.map(r => (r.url
      ? `[![${callSourceLabel(r.source)}](${callSourceLogo(r.source) ?? ''}) Open the call in ${callSourceLabel(r.source)}](${r.url})`
      : `The full transcript from ${callSourceLabel(r.source)} is saved with this call's meeting notes.`))].filter(Boolean).join('\n\n'),
  };

  return writeDocument(supabase, workspaceId, {
    kind: 'call',
    title: callPageTitle(input.title, input.occurredAt, input.callType),
    headline: `Account health · ${healthHeadline(health)}`,
    sections: [...healthPageSections(health), transcriptSection],
    subjectEntityId: input.subjectEntityId,
    mentionEntityIds: (input.mentionEntityIds ?? []).filter(id => id && id !== input.subjectEntityId),
    periodStart: input.occurredAt,
    periodEnd: input.occurredAt,
    series: callPageSeries(input.source, input.meetingId),
    generatedFrom: [...new Set(recordings.map(r => callSourceLabel(r.source)))],
    authorUserId: input.repUserId ?? null,
    skill: 'account-health',
    writtenBy: 'routine',
    sources,
  });
}

/** File the call page into Pages. Returns the document, or null when there is no account to file it on. */
export async function writeCallPage(supabase: SupabaseClient, workspaceId: string, input: WriteCallPageInput): Promise<DocumentRow | null> {
  if (!input.subjectEntityId) return null;
  const label = callSourceLabel(input.source);
  const recordings = input.recordings?.length ? input.recordings : [{ source: input.source, url: input.url ?? null, meeting_id: input.meetingId }];
  // One cited source per recording, so the page reaches every transcript of the call.
  const sources = recordings
    .map(r => (r.meeting_id ? { system: callSourceLabel(r.source), ref: `source://${String(r.source ?? '').toLowerCase()}/${r.meeting_id}`, detail: input.title || 'Call', when: input.occurredAt } : null))
    .filter((x): x is NonNullable<typeof x> => !!x);
  if (!sources.length && input.sourceRef) sources.push({ system: label, ref: input.sourceRef, detail: input.title || 'Call', when: input.occurredAt });
  return writeDocument(supabase, workspaceId, {
    kind: 'call',
    title: callPageTitle(input.title, input.occurredAt, input.callType),
    headline: `Sales call score ${input.score.overall}/10`,
    sections: callPageSections(input.score, input),
    subjectEntityId: input.subjectEntityId,
    mentionEntityIds: (input.mentionEntityIds ?? []).filter(id => id && id !== input.subjectEntityId),
    periodStart: input.occurredAt,
    periodEnd: input.occurredAt,
    series: callPageSeries(input.source, input.meetingId),
    generatedFrom: [...new Set(recordings.map(r => callSourceLabel(r.source)))],
    authorUserId: input.repUserId ?? null,
    skill: 'call-review',
    writtenBy: 'routine',
    sources,
  });
}
