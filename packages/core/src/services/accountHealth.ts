import type { CallReviewContext } from './callScoring.js';

// The account health read (GET-288): what a CUSTOMER call tells you about the account.
//
// A coaching score answers "how well did the rep do a skill?" — the right question for a discovery
// call, a demo, a proposal, a kickoff. It is the wrong question for a business review or a training
// session: nobody improves at "QBR" the way they improve at objection handling, and grading a CS
// manager 3.6/10 for not closing on a check-in is both wrong and demoralising.
//
// What those calls actually carry is the state of the account — whether it is being used, what is
// quietly going wrong, and what they asked for next. That is what this extracts, and it is what a
// CS team can act on the same day.
//
// Pure: the prompt and the parser, no I/O, so the worker owns the model call and this owns the
// shape — the same split as callScoring.

/** One thing the call revealed, with the line that proves it. */
export interface HealthSignal {
  /** One sentence, specific and falsifiable. Never "the customer seems happy". */
  text: string;
  /** A verbatim line from the transcript, or empty when nothing was quotable. */
  quote: string;
}

/**
 * A commitment is a task that has not been filed yet.
 *
 * The health read has always found these — "I'll send the export fix by Friday" — and rendered them on
 * the call page, and then dropped them. Meanwhile a whole task store exists, with a two-tier
 * completion engine that closes a commitment when the record shows it was kept. Nothing connected
 * the two, so dozens of meetings produced hundreds of open risks and zero tasks.
 *
 * `owner` is what makes it fileable: a commitment nobody owes is nobody's task. `due` stays in the
 * speaker's own words and is resolved against the call's date by the same code that resolves an
 * email's — the model says the phrase, code computes the date.
 */
export interface HealthCommitment extends HealthSignal {
  owner: 'us' | 'them';
  due: string;
  /** The person waiting on it, as named on the call. "" when the call does not say. */
  for: string;
  /** Who raised it — the asker, which is often not the owner. "" when nobody asked; it was volunteered. */
  asked_by: string;
  /** One sentence of context a reader needs to act: what exactly, and why. "" when the title already says it all. */
  context: string;
}

export interface AccountHealth {
  /** What the call WAS: who was on it and what was discussed. Every call gets a summary — the
   *  health read is what a CS call gets INSTEAD of a score, not instead of a summary. */
  summary: string;
  /** What changed on this account since last time — the paragraph a CS lead reads first. */
  what_changed: string;
  /** Who uses it, how, and where it has stalled. */
  adoption: string;
  /** Sentiment, but only as evidence allows: 'positive' | 'neutral' | 'at_risk'. */
  standing: 'positive' | 'neutral' | 'at_risk';
  /** What could cost us this account. Empty is a valid answer. */
  risks: HealthSignal[];
  /** A real opening — a new team, a new need, a second site. Never a pitch we want to make. */
  expansion: HealthSignal[];
  /** What either side committed to, with who owes it. */
  commitments: HealthCommitment[];
}

const STANDINGS = new Set(['positive', 'neutral', 'at_risk']);

// A DESCRIPTION OF HOW SOMETHING WORKS IS NOT A PROMISE (GET-729). On a product demo or a design
// call, "the agent sends the user a morning digest after the nightly run" describes what the
// software does, and it came back as "Theo to send the user a morning digest" — a task nobody
// agreed to and nobody could ever close. A commitment is a one-off thing a PERSON said they will do.
const NOT_A_PROMISE_RULE = `Never list how a product, system, agent or automation works or will work: "the agent sends a morning digest after the nightly run", "the system files it and asks for approval", "it syncs every hour". That describes software, not a promise, even when the speaker built it. A commitment is one specific thing a named PERSON on the call said they will do, once, and can tick off. Never turn a feature or a recurring behaviour into a task for the person who described it. BUT work our side agreed to do FOR this customer IS a commitment, even when the work is building or configuring software: "set up the automation that posts their daily activity summary to Slack", "draft the onboarding motion with them", "rework the prep brief into four short pointers". The line is between describing how something behaves (never a task) and agreeing to build, change or set something up for them (a task).`;

// WHAT THE CUSTOMER ASKED US TO DO IS OURS TO DO (GET-786). A customer listing what they want
// built or fixed is the most valuable thing a call or an email carries, and the strict bar above
// was dropping it whole: nobody on our side said "I will", so the model filed nothing.
const CUSTOMER_ASK_RULE = `When the customer asks our side to do, build, fix or change something and our side does not turn it down, that is a commitment owed by us ("owner" "us", "asked_by" the person who asked), even when nobody on our side said "I will". Each distinct ask is its own commitment.`;

// THE NEXT MEETING IS A TASK; THE LOGISTICS OF THIS ONE ARE NOT (GET-786). Meeting logistics were
// the largest share of junk tasks (GET-423) and stay out. But "let's get Friday on the calendar to
// go through the motions" is a promise someone has to keep, and dropping it meant nobody booked it.
const NEXT_MEETING_RULE = `Arranging the NEXT meeting IS a commitment when one side agreed to set it up, with a day or a purpose: "I'll book us Friday to go through the motions list" is "Book the Friday session with Dana to go through the motions list" — start the text with "Book". Everything else about meetings is logistics and NOT a commitment: attending, accepting an invitation, confirming or moving a time already set, sending or forwarding a link or invite for a meeting already agreed.`;

export function buildHealthReadPrompt(transcript: string, ctx?: { title?: string | null; callType?: string | null; people?: CallReviewContext['people'] }): string {
  const who = (ctx?.people ?? []).map(p => `- ${p.name ?? p.email ?? 'unknown'}${p.side ? ` (${p.side})` : ''}`).join('\n');
  return `You are reading one recorded call with an EXISTING customer, for the customer-success team that owns the account. They will act on this today. Work only from the transcript, and never invent a quote — every quote is copied verbatim.

${ctx?.title ? `CALL: ${ctx.title}\n` : ''}${ctx?.callType ? `KIND: ${ctx.callType}\n` : ''}${who ? `ON THE CALL:\n${who}\n` : ''}
This is NOT a sales call and you are not grading the rep. Do not judge whether they closed, handled objections, or asked discovery questions. Answer only: how is this account doing?

Give:
- summary: 3–5 sentences. What this call was: who was on it from each side, what they covered, and how it ended. A reader who was not there should know what happened.
- what_changed: 3–6 sentences. What is different about this account since the last conversation: what they are doing with the product, what they raised, what shifted. Concrete, in their own words where possible. If nothing changed, say that plainly.
- adoption: 2–4 sentences. Who actually uses it, for what, and where it has stalled. Name teams or roles when the call names them.
- standing: exactly one of "positive", "neutral", "at_risk". Choose "at_risk" only on evidence — frustration, an unused product, a sponsor who has gone, a competitor being evaluated, an unanswered problem.
- risks: 0–4 items, each {"text","quote"}. What could cost us this account. An account with no risk on the call gets an empty array — do not invent one.
- expansion: 0–4 items, each {"text","quote"}. A real opening they raised: another location, another team, a need the product covers. Never a pitch we would like to make.
- commitments: 0–8 items, each {"text","quote","owner","due","for","asked_by","context"}. What either side said they would do. "text" is the whole commitment in one sentence — who does what, for whom, with the specifics named on the call (the product, the page, the document, the person): "Marisol to send Dorian the Lumen Verify setup guide and the steps for updating the website widget", never "Send info" or "Follow up". It is read on its own, with no transcript beside it. "owner" is "us" when our side owes it, "them" when the customer does — mark the side correctly on every one. "text" IS ALWAYS SOMETHING OUR SIDE CAN DO: when we owe it, the deliverable itself ("Marisol to send Dorian the Lumen Verify setup guide"); when they owe it, our side of it, the chase ("Follow up with Dorian on the emails he owes"). Never write a line only the customer could carry out — nobody on our team can tick that off. "due" is the timing in their own words if stated ("by Friday", "before the launch", "right after this call"), else "". Write "due" in English even when the conversation is not ("juste après notre appel" is "right after the call", "le 30 septembre" is "September 30"). It must stand on its own: if the month, weekday or year is clear from the conversation, put it IN the phrase even when the speaker did not say it in that sentence — "the 5th" from a call about the October check-in is written "October 5th", because code turns this phrase into a date and cannot see the rest of what you wrote.
  NOT a commitment: a question the speaker asked, or a call to action from a marketing email. ${NEXT_MEETING_RULE} "for" is the person waiting on it, by the name used on the call ("Dorian", "Tamsin Vael") — the recipient of a send, the person a fix is for; "" when the call does not say. "asked_by" is who raised it, when someone asked for it rather than the owner volunteering it; "" otherwise. "context" is ONE sentence a reader who was not on the call needs in order to act: what exactly is being sent or done and why it came up ("Dorian wants to turn on Lumen Verify and needs the setup guide; Marisol also owes the widget update steps"). Never restate the text; "" when the text already says it all.
  ${NOT_A_PROMISE_RULE}
  ${CUSTOMER_ASK_RULE}

Return ONLY this JSON object, no prose around it:
{"summary":"...","what_changed":"...","adoption":"...","standing":"positive|neutral|at_risk","risks":[{"text":"...","quote":"..."}],"expansion":[{"text":"...","quote":"..."}],"commitments":[{"text":"...","quote":"...","owner":"us|them","due":"","for":"","asked_by":"","context":""}]}

TRANSCRIPT:
${transcript}`;
}

function extractJsonObject(text: string): any | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

/**
 * Commitments, with the two fields that make one fileable as a task.
 *
 * `owner` defaults to 'us' when the model does not say. That is deliberate and it is the safe
 * direction: a commitment wrongly assigned to us appears on our list and gets dismissed, while one
 * wrongly assigned to them disappears silently — and the whole point is that nothing promised on a
 * call goes missing.
 */
function commitments(raw: unknown): HealthCommitment[] {
  return signals(raw, MAX_COMMITMENTS).map((s, i) => {
    const r = Array.isArray(raw) ? (raw[i] as any) : {};
    return {
      ...s,
      owner: String(r?.owner ?? '').toLowerCase() === 'them' ? 'them' as const : 'us' as const,
      due: String(r?.due ?? '').trim(),
      // The three fields that let a task say who it is for and where it came from (GET-400).
      // Older model outputs have none of them; "" is the honest empty, never a guess.
      for: String(r?.for ?? '').trim(),
      asked_by: String(r?.asked_by ?? '').trim(),
      context: String(r?.context ?? '').trim(),
    };
  });
}

// A busy call carries more than five promises; the old cap of five dropped everything after the
// fifth, in the model's order, which is not the order of importance (GET-786).
const MAX_COMMITMENTS = 8;

function signals(raw: unknown, max = 5): HealthSignal[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r: any) => ({
      text: String(r?.text ?? r ?? '').trim(),
      quote: String(r?.quote ?? '').trim(),
    }))
    .filter(s => s.text)
    .slice(0, max);
}

/** Read the model's answer. A health read with nothing in it is valid — many check-ins are quiet. */
export function parseHealthReadJson(text: string): AccountHealth | null {
  const raw = extractJsonObject(text);
  if (!raw) return null;
  const standing = String(raw.standing ?? '').toLowerCase();
  const health: AccountHealth = {
    summary: String(raw.summary ?? '').trim(),
    what_changed: String(raw.what_changed ?? '').trim(),
    adoption: String(raw.adoption ?? '').trim(),
    standing: (STANDINGS.has(standing) ? standing : 'neutral') as AccountHealth['standing'],
    risks: signals(raw.risks),
    expansion: signals(raw.expansion),
    commitments: commitments(raw.commitments),
  };
  // Nothing readable at all: treat as a failed parse rather than storing an empty page that
  // looks like a quiet account.
  if (!health.summary && !health.what_changed && !health.adoption && !health.risks.length
      && !health.expansion.length && !health.commitments.length) return null;
  return health;
}

/** The current state of an account, as the last customer call left it. Written onto the account
 *  so a CS lead can see standing without opening the call, and the agent can answer "who is at
 *  risk" without re-reading a year of transcripts. */
export interface AccountHealthState {
  standing: AccountHealth['standing'];
  at: string;                 // when the call happened
  risks: string[];            // the risk sentences, newest call only
  expansion: string[];
  source_ref: string | null;  // the call it came from
}

export function healthStateFrom(h: AccountHealth, opts: { at: string; sourceRef?: string | null }): AccountHealthState {
  return {
    standing: h.standing,
    at: opts.at,
    risks: h.risks.map(r => r.text),
    expansion: h.expansion.map(e => e.text),
    source_ref: opts.sourceRef ?? null,
  };
}

const STANDING_LABEL: Record<AccountHealth['standing'], string> = {
  positive: 'Healthy',
  neutral: 'Steady',
  at_risk: 'At risk',
};

/** The one-line headline of the page: the standing, and what drives it. */
export function healthHeadline(h: AccountHealth): string {
  const parts = [STANDING_LABEL[h.standing]];
  if (h.risks.length) parts.push(`${h.risks.length} risk${h.risks.length === 1 ? '' : 's'}`);
  if (h.expansion.length) parts.push(`${h.expansion.length} expansion signal${h.expansion.length === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

const bullets = (items: HealthSignal[]): string =>
  items.map(s => (s.quote ? `- ${s.text}\n  > ${s.quote}` : `- ${s.text}`)).join('\n');

/** The page's sections, in reading order. Empty sections are left out, not padded. */
export function healthPageSections(h: AccountHealth): { label: string; body: string }[] {
  const out: { label: string; body: string }[] = [];
  if (h.summary) out.push({ label: 'Summary', body: h.summary });
  if (h.what_changed) out.push({ label: 'What changed', body: h.what_changed });
  if (h.adoption) out.push({ label: 'Adoption', body: h.adoption });
  if (h.risks.length) out.push({ label: 'Risk', body: bullets(h.risks) });
  if (h.expansion.length) out.push({ label: 'Expansion signal', body: bullets(h.expansion) });
  if (h.commitments.length) out.push({ label: 'Commitments', body: bullets(h.commitments) });
  return out;
}


/**
 * A commitments-only read, for every call that is not a health read (GET-418).
 *
 * Tasks used to come only from business reviews and training calls, because the health read was
 * the only prompt that asked for commitments. A discovery call's "I'll send the proposal Friday"
 * was filed nowhere. This asks the same question with the same schema — so the same filing code,
 * provenance and re-read supersession apply — and nothing else.
 */
export function buildCommitmentsPrompt(transcript: string, ctx?: { title?: string | null; callType?: string | null; people?: CallReviewContext['people'] }): string {
  const who = (ctx?.people ?? []).map(p => `- ${p.name ?? p.email ?? 'unknown'}${p.side ? ` (${p.side})` : ''}`).join('\n');
  return `You are reading one recorded call and listing ONLY the commitments made on it. Work only from the transcript, and never invent a quote — every quote is copied verbatim.

${ctx?.title ? `CALL: ${ctx.title}\n` : ''}${ctx?.callType ? `KIND: ${ctx.callType}\n` : ''}${who ? `ON THE CALL:\n${who}\n` : ''}
Give:
- commitments: 0–8 items, each {"text","quote","owner","due","for","asked_by","context"}. What either side said they would do. "text" is the whole commitment in one sentence — who does what, for whom, with the specifics named on the call (the product, the page, the document, the person): "Marisol to send Dorian the Lumen Verify setup guide and the steps for updating the website widget", never "Send info" or "Follow up". It is read on its own, with no transcript beside it. "owner" is "us" when our side owes it, "them" when the customer does — mark the side correctly on every one. "text" IS ALWAYS SOMETHING OUR SIDE CAN DO: when we owe it, the deliverable itself ("Marisol to send Dorian the Lumen Verify setup guide"); when they owe it, our side of it, the chase ("Follow up with Dorian on the emails he owes"). Never write a line only the customer could carry out — nobody on our team can tick that off. "due" is the timing in their own words if stated ("by Friday", "before the launch", "right after this call"), else "". Write "due" in English even when the conversation is not ("juste après notre appel" is "right after the call", "le 30 septembre" is "September 30"). It must stand on its own: if the month, weekday or year is clear from the conversation, put it IN the phrase even when the speaker did not say it in that sentence — "the 5th" from a call about the October check-in is written "October 5th", because code turns this phrase into a date and cannot see the rest of what you wrote.
  "for" is the person waiting on it, by the name used on the call ("Dorian", "Tamsin Vael") — the recipient of a send, the person a fix is for; "" when the call does not say. "asked_by" is who raised it, when someone asked for it rather than the owner volunteering it; "" otherwise. "context" is ONE sentence a reader who was not on the call needs in order to act: what exactly is being sent or done and why it came up ("Dorian wants to turn on Lumen Verify and needs the setup guide; Marisol also owes the widget update steps"). Never restate the text; "" when the text already says it all.
Never list a STANDING STATE: "Continue routing leads to the old inbox", "Keep the pricing change internal until the board meets", "Continue the current discount until the renewal". Carrying on with what already happens is a fact about the account, not a commitment — nobody can ever mark it done. A promise to keep a PERSON posted ("I'll keep you updated on the Lumen Verify setup") IS a commitment.
${NOT_A_PROMISE_RULE}
${CUSTOMER_ASK_RULE}
${NEXT_MEETING_RULE}
A call with no commitments gets an empty array — do not invent one.

Return ONLY this JSON object, no prose around it:
{"commitments":[{"text":"...","quote":"...","owner":"us|them","due":"","for":"","asked_by":"","context":""}]}

TRANSCRIPT:
${transcript}`;
}

/** The commitments in a commitments-only answer, parsed with the health read's own rules. */
export function parseCommitmentsJson(text: string): HealthCommitment[] {
  const raw = extractJsonObject(text);
  if (!raw) return [];
  return commitments(Array.isArray(raw) ? raw : raw.commitments);
}
