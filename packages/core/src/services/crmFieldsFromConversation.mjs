// "Based on what was discussed" (GET-715): the CRM fields a conversation gives evidence for. The
// model reads the call (or the signal) and proposes a value only where something said supports it,
// with the words that do. Nothing said, nothing written: an empty answer skips the step.
//
// Only fields the step allows are ever proposed, and values are checked to their type here (a date
// is a date, an amount is a number), so a guess cannot land in a field it does not fit.

import { createMessage, messageText } from '../llm/modelDoor.mjs';

/** Fields the AI may set by default, per record, when the step names none. Safe, free-text or typed. */
export const AI_FIELD_DEFAULTS = {
  update_deal: ['hs_next_step', 'closedate', 'amount', 'description'],
  update_contact: ['jobtitle', 'phone', 'city'],
  update_company: ['description', 'numberofemployees', 'city'],
};

const FIELD_HELP = {
  hs_next_step: 'the next step both sides agreed, one short sentence',
  closedate: 'the date they said they expect to sign or decide, as YYYY-MM-DD',
  amount: 'the deal value they stated, a number with no currency sign',
  description: 'one or two sentences on what they want and why, only if newly said',
  jobtitle: "the person's job title, if they stated it",
  phone: 'a phone number they gave',
  city: 'the city they said they are in',
  numberofemployees: 'the headcount they stated, a whole number',
};

/** The prompt. Pure. */
export function buildFieldsPrompt({ object, fields, call = null, signal = null, written = null }) {
  const record = object === 'update_deal' ? 'deal' : object === 'update_contact' ? 'contact' : 'company';
  const said = [
    call?.title ? `Call: ${call.title}${call.occurredAt ? ` (${String(call.occurredAt).slice(0, 10)})` : ''}` : null,
    call?.summary ? `Summary: ${call.summary}` : null,
    call?.nextSteps?.length ? `Next steps: ${call.nextSteps.map(x => x.title).join('; ')}` : null,
    call?.transcript ? `Transcript:\n${String(call.transcript).slice(0, 40_000)}` : null,
    signal ? `Signal: ${signal.kind}: ${signal.content ?? signal.title ?? ''}${signal.quote ? ` ("${signal.quote}")` : ''}` : null,
    !call && !signal && written ? `What the automation wrote:\n${String(written).slice(0, 6000)}` : null,
  ].filter(Boolean).join('\n\n');
  return {
    system: `You update a ${record} record in a CRM from a sales conversation. Propose a value for a field ONLY when the conversation states it plainly; never infer, estimate or round. Each value carries the exact words from the conversation that support it. If nothing supports a field, leave it out. An empty list is a good answer.\n\nFields you may set:\n${fields.map(f => `- ${f}: ${FIELD_HELP[f] ?? 'only if stated plainly'}`).join('\n')}\n\nAnswer ONLY with JSON: {"fields":[{"name":"<field>","value":"<value>","quote":"<words from the conversation>"}]}`,
    user: said || 'Nothing was said.',
  };
}

/** The model's answer, checked: allowed fields only, typed values, a quote each. Pure. */
export function parseFieldsAnswer(text, fields) {
  const allowed = new Set(fields);
  let obj = null;
  try { const t = String(text ?? ''); obj = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)); } catch { return []; }
  const out = [];
  const seen = new Set();
  for (const f of Array.isArray(obj?.fields) ? obj.fields : []) {
    const name = String(f?.name ?? '').trim();
    let value = String(f?.value ?? '').trim();
    const quote = String(f?.quote ?? '').trim();
    if (!allowed.has(name) || seen.has(name) || !value || !quote) continue;
    if (name === 'closedate') { if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value))) continue; }
    if (name === 'amount' || name === 'numberofemployees') {
      const n = Number(value.replace(/[,\s$€£]/g, ''));
      if (!Number.isFinite(n) || n <= 0) continue;
      value = String(name === 'numberofemployees' ? Math.round(n) : n);
    }
    seen.add(name);
    out.push({ name, value: value.slice(0, 1000), quote: quote.slice(0, 300) });
  }
  return out;
}

/** Ask the model. Returns { fields, model, usage }; never throws. */
export async function crmFieldsFromConversation({ object, fields, call = null, signal = null, written = null }) {
  const allow = (fields?.length ? fields : AI_FIELD_DEFAULTS[object] ?? []).filter(Boolean);
  if (!allow.length || (!call && !signal && !written)) return { fields: [], model: null, usage: null };
  const p = buildFieldsPrompt({ object, fields: allow, call, signal, written });
  try {
    const msg = await createMessage({
      feature: 'automation-handoff', tier: 'extraction', max_tokens: 800,
      system: p.system, messages: [{ role: 'user', content: p.user }],
    });
    return { fields: parseFieldsAnswer(messageText(msg), allow), model: msg?.model ?? null, usage: msg?.usage ?? null };
  } catch {
    return { fields: [], model: null, usage: null };
  }
}
