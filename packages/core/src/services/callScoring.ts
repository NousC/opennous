import type { CoachingRubric, RubricDimension } from '../db/coachingRubric.js';
import { MEDDICC, BANT } from '../db/coachingRubric.js';

// Coaching v2 (GET-83): the scoring prompt + parser, shared so the worker (the LLM pass) and any
// test harness build the exact same request and read the exact same shape. The worker owns the
// model call; this owns "how we ask" and "how we read the answer" — pure, testable, no I/O.
//
// GET-236: the same pass now writes the call page too — the summary, the verdict, and what went
// well / what to improve — so the page in Pages and the scorecard on Coaching come from ONE
// answer and cannot disagree. Every score is on a 1–10 scale.

/** What kind of call this was (GET-287).
 *
 *  The first six are graded, each against its own rubric — a business review is not a failed sales
 *  call. `sales` remains for a selling conversation we cannot place more precisely, and for every
 *  scorecard written before types existed. `support`, `internal` and `other` are mined for intel
 *  and never scored. */
export type CallType =
  | 'discovery' | 'demo' | 'proposal' | 'onboarding' | 'training' | 'business_review' | 'sales'
  | 'support' | 'internal' | 'other';

/** The types we grade. Everything else is real, and simply not a coaching moment. */
export const GRADED_CALL_TYPES: CallType[] =
  ['discovery', 'demo', 'proposal', 'onboarding', 'training', 'business_review', 'sales'];

export const isGradedCallType = (t?: string | null): boolean =>
  GRADED_CALL_TYPES.includes(String(t || '') as CallType);

/**
 * Classify the call before choosing how to judge it — a short, cheap pass over the title and the
 * opening of the transcript (~500 tokens), not the whole call. Doing it in the review prompt would
 * mean picking the rubric before knowing the type, which is the bug this fixes.
 */
export function buildCallTypePrompt(
  title: string | null,
  opening: string,
  { externals = [] }: { externals?: string[] } = {},
): string {
  // WHO WAS IN THE ROOM IS EVIDENCE, NOT A GUESS. "internal — only people from the same company" is
  // a claim about the attendee list, and the model was being asked to infer it from a title and the
  // first 1,500 characters. On "Quarry Ridge Motors | Product Review" — two of the customer's people and one of theirs —
  // it answered `internal`, and the call was dropped: no health read, no page, no signals. The
  // attendee list settles it, so it goes in the prompt. Costs nothing: a handful of tokens on a
  // call that already runs.
  const room = externals.length
    ? `PEOPLE FROM OTHER COMPANIES ON THIS CALL: ${externals.join(', ')}
This call is NOT internal — someone from outside is present.`
    : 'PEOPLE FROM OTHER COMPANIES ON THIS CALL: none identified.';

  return `Classify this call in ONE word from this list, and return nothing else:

discovery — a first or early sales conversation: learning their situation, pain, fit.
demo — showing the product to a prospect or customer.
proposal — pricing, negotiation, or closing a decision.
onboarding — kickoff or implementation after a purchase.
training — teaching an existing customer how to use it (enablement, walkthroughs).
business_review — a check-in, QBR/MBR or account review with an existing customer.
support — troubleshooting a problem with the product.
internal — only people from the same company.
other — anything else (investor, partner, recruiting, vendor, personal).

${room}

TITLE: ${title || '(none)'}

TRANSCRIPT OPENING:
${opening}

Answer with ONLY this JSON, nothing else: {"call_type":"<one word from the list>"}`;
}

/**
 * The classifier's answer, checked against the one fact we hold about the room.
 *
 * `internal` means "only people from the same company". When someone from another company was on
 * the call, that answer is contradicted by the attendee list, and accepting it costs the whole
 * meeting: `internal` is not graded and not a health read, so the call produces no page, no account
 * standing and no risks. A customer call silently vanishes from the account.
 *
 * So the room wins. We do not know WHICH kind of customer call it was, and guessing a graded type
 * would put a fabricated grade on a rep; `business_review` is the conservative answer — it reads the
 * account and never scores anyone, which is exactly the right treatment for "a customer was here and
 * we could not tell what this was".
 */
export function callTypeAgainstRoom(
  callType: CallType,
  { hasExternalAttendee }: { hasExternalAttendee: boolean },
): CallType {
  if (callType !== 'internal' || !hasExternalAttendee) return callType;
  return 'business_review';
}

const CALL_TYPE_ALIASES: Record<string, CallType> = {
  qbr: 'business_review', mbr: 'business_review', check_in: 'business_review', review: 'business_review',
  kickoff: 'onboarding', implementation: 'onboarding',
  enablement: 'training', walkthrough: 'training',
  negotiation: 'proposal', closing: 'proposal', pricing: 'proposal',
  intro: 'discovery', prospecting: 'discovery',
};

/**
 * Read the classifier's answer — a bare word, or the JSON the shared model runner requires.
 *
 * That runner only accepts an object containing "call_type" (it is the same door the review goes
 * through, and a review that is not JSON is unusable). A one-word answer was therefore rejected as
 * unusable, every model in the chain was tried, and the call came back unclassified — which looked
 * like "nothing is a sales call" rather than "the answer never got through".
 */
export function parseCallType(text: string | null | undefined): CallType {
  const s = String(text ?? '');
  let word = s;
  const m = s.match(/"call_type"\s*:\s*"([a-z_]+)"/i);
  if (m) word = m[1];
  const raw = word.toLowerCase().replace(/[^a-z_]/g, ' ').trim().split(/\s+/)[0] ?? '';
  const known: CallType[] = [...GRADED_CALL_TYPES, 'support', 'internal', 'other'];
  if (known.includes(raw as CallType)) return raw as CallType;
  return CALL_TYPE_ALIASES[raw] ?? 'other';
}

export interface DimensionScore {
  key: string;
  label: string;
  weight: number;
  score: number;      // 1–10 for this dimension; 0 only when the model gave nothing
  note: string;       // why it scored that, with the call's own words quoted
  moment: string;     // the single quote that best justifies it (may be empty)
}

export interface CallScore {
  call_type: CallType;
  summary: string;    // the read on the call: who the buyer is, what it turned on, where it stands
  verdict: string;    // the overall judgement behind the number
  went_well: string;  // markdown bullets
  improve: string;    // markdown bullets
  scores: DimensionScore[];
  next_step_secured: boolean;
  overall: number;    // weighted 1–10, one decimal
}

function methodologyChecklist(methodology: string): string {
  if (methodology === 'bant') return `BANT: ${BANT.join(', ')}`;
  if (methodology === 'meddicc') return `MEDDICC: ${MEDDICC.join(', ')}`;
  return methodology ? `${methodology} (team-defined)` : 'the team methodology';
}

/** Who was on the call, as our records know them — so the review never has to guess a name. */
export interface CallPerson {
  name?: string | null;
  email?: string | null;
  company?: string | null;
  /** Our team or the buyer's side. Unset reads as the buyer's side. */
  side?: 'team' | 'buyer' | null;
  /** Set up the meeting (owns the call). */
  host?: boolean;
  /** Their note-taker recorded it, so their microphone is the labelled one. */
  recorder?: boolean;
}

/**
 * Who talked how much, from a transcript whose lines name their speaker ("Jane Doe: …") — what
 * Fireflies, Fathom and Fellow send. Measured in words, which tracks speaking time closely without
 * needing timestamps every note-taker formats differently. `teamNames` are our side; matching is on
 * the name as written, case-insensitive, first name alone accepted when it is unambiguous.
 * Returns null when too few lines carry a speaker to say anything honest.
 */
export function talkShareFromTranscript(transcript: string, teamNames: string[]): { teamShare: number; bySpeaker: { name: string; share: number; team: boolean }[] } | null {
  const team = teamNames.map(n => String(n ?? '').trim().toLowerCase()).filter(Boolean);
  const firstNames = new Map<string, number>();
  for (const n of team) { const f = n.split(/\s+/)[0]; firstNames.set(f, (firstNames.get(f) ?? 0) + 1); }
  // "Theo Bramwell" on the transcript is "Theo" in the member list: same first name counts when
  // the surnames don't contradict each other and only one teammate has that first name.
  const isTeam = (speaker: string) => {
    const [sf, ...sr] = speaker.toLowerCase().split(/\s+/);
    return team.some(n => {
      const [tf, ...tr] = n.split(/\s+/);
      if (tf !== sf) return false;
      if (tr.length && sr.length) return tr.join(' ') === sr.join(' ');
      return firstNames.get(tf) === 1;
    });
  };
  const words = new Map<string, number>();
  let labelled = 0, total = 0;
  for (const line of String(transcript ?? '').split('\n')) {
    const m = /^([^:\n]{1,60}):\s(.+)$/.exec(line.trim());
    if (!m) continue;
    const name = m[1].trim();
    if (/^(speaker|unknown|participant)\s*\d*$/i.test(name) || name === 'Them' || name === 'Me') continue;
    const n = m[2].split(/\s+/).filter(Boolean).length;
    words.set(name, (words.get(name) ?? 0) + n);
    labelled++; total += n;
  }
  if (labelled < 10 || total < 100) return null;
  const bySpeaker = [...words.entries()]
    .map(([name, n]) => ({ name, share: n / total, team: isTeam(name) }))
    .sort((a, b) => b.share - a.share);
  const teamShare = bySpeaker.filter(s => s.team).reduce((a, s) => a + s.share, 0);
  return { teamShare, bySpeaker };
}

export interface CallReviewContext {
  /** @deprecated pass the recorder in `people` with `recorder: true`, `side: 'team'`. */
  rep?: CallPerson | null;
  /** Everyone we know was on the call. */
  people?: CallPerson[];
  /** Share of speaking time on the recorder's microphone, 0–1, when the note-taker measures it. */
  repTalkShare?: number | null;
  /** Words spoken per named speaker, when the transcript names them (Fireflies, Fathom, Fellow). */
  talk?: ReturnType<typeof talkShareFromTranscript>;
  /** What kind of call the classifier said this was — the rubric below is the one for it. */
  callType?: CallType | null;
}

function personLine(p: CallPerson): string {
  const name = String(p.name ?? '').trim();
  const email = String(p.email ?? '').trim();
  const who = name && email ? `${name} <${email}>` : (name || email);
  const tags = [p.host ? 'set up the meeting' : '', p.recorder ? 'recorded it' : ''].filter(Boolean);
  const base = p.company && p.side !== 'team' ? `${who}, ${p.company}` : who;
  return tags.length ? `${base} (${tags.join(', ')})` : base;
}

function contextBlock(ctx: CallReviewContext | undefined): string {
  if (!ctx) return '';
  // Fold the older `rep` field in as the team's recorder, so a caller on either shape reads the same.
  const people: CallPerson[] = [...(ctx.people ?? [])];
  if (ctx.rep && (ctx.rep.name || ctx.rep.email)) {
    const email = String(ctx.rep.email ?? '').toLowerCase();
    const known = people.find(p => email && String(p.email ?? '').toLowerCase() === email);
    if (known) Object.assign(known, { side: 'team', recorder: true, name: known.name || ctx.rep.name });
    else people.unshift({ ...ctx.rep, side: 'team', recorder: true });
  }
  const seen = new Set<string>();
  const unique = people.filter(p => {
    if (!p.name && !p.email) return false;
    const key = String(p.email || p.name).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const team = unique.filter(p => p.side === 'team');
  const buyers = unique.filter(p => p.side !== 'team');
  const recorder = team.find(p => p.recorder);

  const lines: string[] = [];
  if (unique.length) {
    lines.push('WHO WAS ON THE CALL (from the calendar and our records — use exactly these names and companies):');
    if (team.length) {
      lines.push('Our team (the sellers):');
      for (const p of team) lines.push(`- ${personLine(p)}`);
    }
    if (buyers.length) {
      lines.push('The buyer side:');
      for (const p of buyers) lines.push(`- ${personLine(p)}`);
    }
    lines.push('Never invent a name, and never give anyone a job title or role the transcript does not state outright. When you cannot tell who said a line, write "the buyer" or "the team" rather than guessing a name.');
    if (team.length > 1) {
      lines.push(`GRADE THE TEAM, NOT ONE PERSON. ${team.length} people from our team were on this call. Score how the team ran it together, and credit each good or weak moment to whichever teammate it belongs to, by name, when the transcript makes it clear.`);
    }
    if (recorder) {
      const rName = recorder.name || recorder.email;
      lines.push(`SPEAKER LABELS: lines labelled "${rName}:" are ${rName}'s own microphone. Lines labelled "Them:" are everyone else on the call${team.length > 1 ? ', which includes the other teammates as well as the buyers — tell them apart from what is said' : ''}.`);
    }
  }
  if (ctx.talk) {
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    const top = ctx.talk.bySpeaker.slice(0, 6).map(s => `${s.name} ${pct(s.share)}${s.team ? ' (our team)' : ''}`).join(', ');
    lines.push(`MEASURED TALK TIME (share of words spoken): our team ${pct(ctx.talk.teamShare)} — ${top}. Grade Talk / listen on these numbers, not on an impression.`);
  } else if (typeof ctx.repTalkShare === 'number' && Number.isFinite(ctx.repTalkShare)) {
    const pct = Math.round(Math.max(0, Math.min(1, ctx.repTalkShare)) * 100);
    const who = recorder ? `${recorder.name || recorder.email}'s microphone` : "the recorder's microphone";
    lines.push(team.length > 1
      ? `MEASURED TALK TIME: ${who} carried ${pct}% of the speaking time. The other teammates speak on the "Them" audio, so the team's real share is higher than that; judge Talk / listen for the team as a whole.`
      : `MEASURED TALK TIME: ${who} carried ${pct}% of the speaking time. Grade Talk / listen on this number, not on an impression.`);
  }
  return lines.length ? `${lines.join('\n')}\n\n` : '';
}

/** Build the review prompt: classify the call, then grade THIS transcript against THIS rubric, strict JSON. */
export function buildCallScorePrompt(rubric: CoachingRubric, transcript: string, ctx?: CallReviewContext): string {
  const dims = rubric.dimensions.map((d, i) =>
    `${i + 1}. ${d.label} [key: ${d.key}, weight: ${d.weight}]\n   Good looks like: ${d.good}`,
  ).join('\n');

  return `You are a senior sales coach writing the review of one recorded call for the team that made it. The rep and their manager will read it to decide what to do next on the deal and what to practise. Work only from the transcript. Never invent a quote: every quote must be copied verbatim from the transcript.

${contextBlock(ctx)}STEP 1: CONFIRM THE CALL.
This call has already been classified as: ${ctx?.callType ?? 'sales'}. The rubric below is the one
for that kind of call — judge it on THAT job, not on a job nobody on the call was doing.
If the transcript shows it was in fact only colleagues, or nothing to do with a customer, return
ONLY {"call_type":"internal"} or {"call_type":"other"} and stop.

STEP 2: REVIEW THE CALL. Be specific and thorough in every field; a reader who was not on the call should come away knowing exactly what happened.

RUBRIC (discovery also grades against ${methodologyChecklist(rubric.methodology)}):
${dims}

For EACH dimension give:
- score: an integer 1–10 for how well the rep did on it in THIS call. 5 is ordinary, 8 is strong, 10 is rare.
- note: 4–7 plain sentences. Say what the rep did, quoting at least two short verbatim lines in double quotes; name exactly what was missed or left unasked; and say what a stronger rep would have done at that moment. No praise padding.
- moment: the single most representative verbatim line for the score, or "" if there is none.

Also write:
- summary: two paragraphs, 7–12 sentences in all. First paragraph: who the buyer is (company, the people on the call, what they run today, their size and situation), what they need and why now. Second paragraph: what was discussed or shown, the concerns and objections raised, what the deal now turns on, and exactly where it stands, including any agreed next steps with owners and dates.
- verdict: 3–5 sentences, the overall judgement: what the rep did best, the biggest miss, and what that miss puts at risk in this deal.
- went_well: an array of 2–4 items, each one sentence naming a specific moment worth repeating.
- improve: an array of 2–4 items, each one concrete action: what to do differently, or what to do before the next conversation.
- next_step_secured: true only if a specific, dated next step with an owner was agreed on the call (not "I'll send info" / "let's stay in touch").

Return ONLY a JSON object, no prose around it:
{"call_type":"sales","summary":"...","verdict":"...","went_well":["..."],"improve":["..."],"dimensions":[{"key":"<dimension key>","score":<1-10>,"note":"...","moment":"<verbatim quote or empty>"}],"next_step_secured":<true|false>}

TRANSCRIPT:
${transcript}`;
}

// Tolerant JSON extraction — the model may wrap the object in prose or a code fence.
function extractJsonObject(text: string): any | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

/** A dimension score on the 1–10 scale. Missing or unreadable is 0, which is how a failed parse shows. */
const clampScore = (n: unknown): number => {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.max(1, Math.min(10, Math.round(v)));
};

const oneDecimal = (n: number) => Math.round(n * 10) / 10;

/** Weighted overall from the per-dimension scores and the rubric weights, 1–10 to one decimal. */
export function computeOverall(scores: DimensionScore[]): number {
  const totalWeight = scores.reduce((a, s) => a + (s.weight || 0), 0);
  if (!totalWeight) return 0;
  const weighted = scores.reduce((a, s) => a + s.score * (s.weight || 0), 0);
  return oneDecimal(weighted / totalWeight);
}

// ── Aggregation for the Coaching page (GET-85) ───────────────────────────────
// Pure summary of a rep's (or team's) scorecards into the shapes the UI renders:
// the radar (per-dim average), the trend (overall over time), what-to-work-on
// (weakest dim + the calls/moments behind it), and best/recent calls.

export interface ScorecardRowLite {
  meeting_id: string;
  entity_id: string | null;
  overall: number | null;
  next_step_secured: boolean | null;
  occurred_at: string;
  scores: DimensionScore[] | null;
  document_id?: string | null;
}

export interface CoachingSummary {
  count: number;
  overall_avg: number;
  next_step_rate: number;                                   // 0–1
  dims: Array<{ key: string; label: string; weight: number; avg: number }>;
  trend: Array<{ occurred_at: string; overall: number }>;   // chronological
  weakest: { key: string; label: string; avg: number } | null;
  weakest_moments: Array<{ meeting_id: string; entity_id: string | null; score: number; note: string; moment: string; occurred_at: string }>;
  best_calls: Array<{ meeting_id: string; entity_id: string | null; overall: number; occurred_at: string; document_id: string | null }>;
  recent_calls: Array<{ meeting_id: string; entity_id: string | null; overall: number; next_step_secured: boolean; occurred_at: string; document_id: string | null }>;
}

const avg = (ns: number[]) => (ns.length ? oneDecimal(ns.reduce((a, b) => a + b, 0) / ns.length) : 0);

export function summarizeScorecards(rows: ScorecardRowLite[], rubric: CoachingRubric): CoachingSummary {
  // A scorecard graded against another rubric (an older default, a role's own) shares none of
  // this rubric's dimensions; counting it would read as a 0 on every axis. Only calls scored
  // against these dimensions belong in this summary.
  const keys = new Set(rubric.dimensions.map((d) => d.key));
  const clean = (rows || []).filter((r) => r && Array.isArray(r.scores) && r.scores.some((s) => keys.has(s.key)));
  if (clean.length === 0) {
    return { count: 0, overall_avg: 0, next_step_rate: 0, dims: rubric.dimensions.map((d) => ({ key: d.key, label: d.label, weight: d.weight, avg: 0 })), trend: [], weakest: null, weakest_moments: [], best_calls: [], recent_calls: [] };
  }

  // Per-dimension average, in rubric order (so radar axes are stable + labelled).
  const dims = rubric.dimensions.map((d) => {
    const scores = clean.map((r) => (r.scores!.find((s) => s.key === d.key)?.score ?? 0));
    return { key: d.key, label: d.label, weight: d.weight, avg: avg(scores) };
  });

  const overall_avg = avg(clean.map((r) => Number(r.overall ?? 0)));
  const next_step_rate = clean.filter((r) => r.next_step_secured).length / clean.length;

  // Chronological trend of the overall score (oldest → newest for a left-to-right line).
  const trend = [...clean]
    .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))
    .map((r) => ({ occurred_at: r.occurred_at, overall: Number(r.overall ?? 0) }));

  // Weakest dimension = lowest average; the "what to work on".
  const weakest = dims.length ? dims.reduce((lo, d) => (d.avg < lo.avg ? d : lo), dims[0]) : null;

  // The calls that pulled the weakest dimension down, with their exact moments — trend-to-moment.
  const weakest_moments = weakest
    ? clean
        .map((r) => ({ row: r, s: r.scores!.find((x) => x.key === weakest.key) }))
        .filter((x) => x.s)
        .sort((a, b) => (a.s!.score - b.s!.score))
        .slice(0, 4)
        .map((x) => ({ meeting_id: x.row.meeting_id, entity_id: x.row.entity_id, score: x.s!.score, note: x.s!.note, moment: x.s!.moment, occurred_at: x.row.occurred_at }))
        .filter((m) => m.moment || m.note)
    : [];

  const best_calls = [...clean]
    .sort((a, b) => Number(b.overall ?? 0) - Number(a.overall ?? 0))
    .slice(0, 3)
    .map((r) => ({ meeting_id: r.meeting_id, entity_id: r.entity_id, overall: Number(r.overall ?? 0), occurred_at: r.occurred_at, document_id: r.document_id ?? null }));

  const recent_calls = [...clean]
    .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
    .slice(0, 10)
    .map((r) => ({ meeting_id: r.meeting_id, entity_id: r.entity_id, overall: Number(r.overall ?? 0), next_step_secured: !!r.next_step_secured, occurred_at: r.occurred_at, document_id: r.document_id ?? null }));

  return { count: clean.length, overall_avg, next_step_rate, dims, trend, weakest, weakest_moments, best_calls, recent_calls };
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** A list the model gave as an array (or, from an older answer, one string), as markdown bullets. */
const bullets = (v: unknown, max: number): string => {
  const items = (Array.isArray(v) ? v : [v])
    .map(x => (typeof x === 'string' ? x.trim().replace(/^[-*•]\s+/, '') : ''))
    .filter(Boolean)
    .slice(0, 6);
  if (!items.length) return '';
  if (items.length === 1 && !Array.isArray(v)) return items[0].slice(0, max);
  return items.map(i => `- ${i}`).join('\n').slice(0, max);
};

/**
 * Parse the model output into a CallScore, keyed off the rubric so weights/labels are authoritative
 * (the model only supplies score/note/moment and the page text). A call the model did not call
 * "sales" comes back with that type and empty scores. Missing dimensions default to 0 with an
 * empty note, which the worker reads as a failed parse.
 */
export function parseCallScoreJson(text_: string, rubric: CoachingRubric, forType?: CallType | null): CallScore {
  const raw = extractJsonObject(text_) ?? {};
  // The type was decided before the rubric was chosen; the reviewer may only overrule it by
  // declaring the call was not with a customer at all.
  const declared = String(raw.call_type ?? '').toLowerCase();
  const callType: CallType = (declared === 'internal' || declared === 'other' || declared === 'support')
    ? (declared as CallType)
    : (isGradedCallType(forType) ? (forType as CallType) : 'sales');
  const byKey = new Map<string, any>();
  for (const d of Array.isArray(raw.dimensions) ? raw.dimensions : []) {
    if (d && typeof d.key === 'string') byKey.set(d.key, d);
  }
  const scores: DimensionScore[] = !isGradedCallType(callType) ? [] : rubric.dimensions.map((d: RubricDimension) => {
    const m = byKey.get(d.key) ?? {};
    return {
      key: d.key,
      label: d.label,
      weight: d.weight,
      score: clampScore(m.score),
      note: text(m.note, 2500),
      moment: text(m.moment, 600),
    };
  });
  return {
    call_type: callType,
    summary: text(raw.summary, 4000),
    verdict: text(raw.verdict, 2000),
    went_well: bullets(raw.went_well, 1500),
    improve: bullets(raw.improve, 1500),
    scores,
    next_step_secured: raw.next_step_secured === true,
    overall: computeOverall(scores),
  };
}
