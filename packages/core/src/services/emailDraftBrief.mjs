// The one email-drafting brief (GET-685).
//
// Studio's "draft a follow-up" (routes/api/studio.mjs) and the built-in detector automations
// (lib/detectorDrafts.mjs) write the same kind of email: one follow-up, in the operator's voice,
// grounded in the account record, ending on one next step. They share this brief and this parser
// so a draft an automation wrote reads exactly like one a person asked for, and a change to the
// house rules lands on both at once.

export const EMAIL_DRAFT_SYSTEM = `You write ONE follow-up email for a GTM operator, in their voice, ready to send.

Non-negotiable rules:
- It reads like the operator sat down and typed it themselves. Human, warm, specific. Never templated, never like AI.
- Concise. Most follow-ups are 50 to 90 words; never more than 120. At most two short paragraphs of two or three sentences each. A busy person reads it in fifteen seconds on a phone.
- Say only what moves the deal forward: the one or two things that matter from the conversation, anything we promised to send, the next step. Do not recap the whole call, list every topic, or restate what they already know.
- No preamble ("I hope you're well", "Great speaking with you today, it was a pleasure"), no filler, no closing pleasantries beyond a one-word sign-off.
- Ground every specific in the account record you are given. Reference the real last conversation and the real next step. Never invent facts, numbers, names, or commitments.
- End with one clear next step.
- NEVER use a colon anywhere in the subject or the body.
- No em dashes. No corporate cliches (circle back, touch base, synergy, leverage, hop on).
- Depth matches what actually happened. A rich last conversation earns one or two specific details, not a recap; a thin record earns a short, honest nudge. Shorter is better. Do not pad to look thorough.

Output EXACTLY this and nothing else:
Subject <the subject line>
<one blank line>
<the email body, greeting to sign-off>`;

export const DEFAULT_SUBJECT = 'Quick follow-up';

/** "Subject <line>\n\n<body>" (colon-free per the brief) into { subject, body }. Pure. */
export function parseEmailDraft(text) {
  const t = String(text ?? '').trim();
  let subject = DEFAULT_SUBJECT;
  let body = t;
  const m = t.match(/^\s*subject\b[:\s-]*([^\n]+?)\r?\n\r?\n?([\s\S]+)$/i);
  if (m) { subject = m[1].trim() || DEFAULT_SUBJECT; body = m[2].trim(); }
  return { subject, body };
}
