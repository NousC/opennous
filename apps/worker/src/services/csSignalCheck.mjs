// What counts as a customer ASKING for a product, decided in one place.
//
// The CS expansion list rests entirely on these asks (2026-10-01: the CRM's upgrade price was
// demoted to context, so an account is an expansion opportunity only because a customer asked).
// That makes the precision of an ask the precision of the page.
//
// Measured on an early workspace before this module existed, a sample of mined asks mostly did not
// hold up. The misses had two shapes the miner prompt did not rule out firmly enough:
//
//   SUPPORT  a request for access, a login, a routing address, setup help for something they
//            already have. "I can't tell whether my login still works" (Larkfield Systems) and
//            "where do I find the forwarding address" (Quillmere Holdings) were filed as asks.
//   PITCH    our rep presenting a product, written up in a call summary, read back as the
//            customer's interest. "Our rep walked them through the reporting module" was
//            filed as an ask.
//
// So an ask has to name what the customer DID (`ASK_EVIDENCE`), and every ask is re-read alone
// against its own quote before it is written. Used by the miner (inline) and by
// verifyExpansionSignals.mjs (for the asks written before this existed).
//
// WHY THE CHECK ANSWERS QUESTIONS RATHER THAN GIVING A VERDICT. A one-word verdict on Haiku moved
// between runs on the same quote: support questions flipped in and out of YES. Three plain
// questions (who is speaking, is it something they already have, do they want more) are each
// easy, and the verdict is computed here from the answers, so the rule is code and is tested.

/** What the customer did that makes it an ask. An ask that cannot name one is dropped. */
export const ASK_EVIDENCE = new Set([
  'price',            // asked what it costs
  'quote',            // asked for a quote, a proposal or a contract for it
  'trial',            // asked to try it, or agreed to a trial
  'another_location', // asked to add it at another store or a sister company
  'more_seats',       // asked to add more users or seats
  'wants_it',         // said in their own words that they want it or want to buy it
  'demo',             // asked US to show it to them (our offering a demo is not this)
  'replacing',        // replacing a tool or vendor that does this job
  'mandate',          // an OEM, lender or regulator now requires the capability
]);

/** The miner's own label for an ask. True only when it names what the customer did. */
export function hasAskEvidence(sig) {
  return ASK_EVIDENCE.has(String(sig?.evidence ?? '').toLowerCase());
}

export const ASK_CHECK_SYSTEM = `You check whether a recorded signal is a real opening to sell more to an existing customer of a B2B software vendor.

You get a product name, a one-line summary of what happened, and the verbatim quote it came from. Read the QUOTE; the summary is only context. Answer four questions about the quote and return JSON only:

{"why":"<at most 15 words>","who":"customer"|"vendor","about":"new"|"existing","wants_more":true|false,"complaint":true|false}

who: whose words or actions does the quote record?
  "customer" = the customer's own words, or a summary of something the customer did, asked or decided.
  "vendor"   = the vendor's rep speaking, asking the customer a question, presenting, introducing, offering, sending or flagging something. "What are you running today and what is it costing you?" is the vendor. "Sam presented the reporting module" is the vendor, even if it adds that the customer seemed interested.

about: is the quote about something the customer does NOT have yet, or something they already have?
  "new"      = a product, capability, extra location or extra seats they do not have yet.
  "existing" = something they already have, already signed up for, or are being set up on: access, logins, permissions, passwords, routing or email addresses, integrations, installation, credentialing, training, or how a feature works or can be configured ("can it accept other file types", "can certain users only see certain sources", "can we swap this banner").

wants_more: does the quote show the customer wanting to buy, add, try or price it, asking us to show it to them or their people, extending it to another location or more users, or needing it because of a mandate (OEM, lender, regulator) or because they are replacing a tool that does the job? A bare question about how it works is false. Saying they want LESS of something is false.

complaint: is it a problem, a criticism, a request to remove or turn it off, or an objection to its price?

When unsure, choose the answer that does NOT make this an opening. A list full of weak openings teaches a CS team to stop reading it.`;

export function askCheckPrompt({ product, text, quote }) {
  return `PRODUCT: ${product}\nWHAT HAPPENED: ${text}\nQUOTE: "${quote}"`;
}

/**
 * The verdict, computed from the model's answers. Anything unreadable is NO, never YES.
 *
 *   COMPLAINT  it is a problem with the product (re-filed as a risk by the verifier)
 *   PITCH      the quote records the vendor, not the customer
 *   SUPPORT    it is about something they already have
 *   YES        the customer, about something new, wanting more
 *   NO         anything else
 */
export function verdictFromAnswers(raw) {
  let a = raw;
  if (typeof raw === 'string') {
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    try { a = s >= 0 && e > s ? JSON.parse(raw.slice(s, e + 1)) : null; } catch { a = null; }
  }
  if (!a || typeof a !== 'object') return 'NO';
  if (a.complaint === true) return 'COMPLAINT';
  if (a.who !== 'customer') return 'PITCH';
  if (a.about !== 'new') return 'SUPPORT';
  return a.wants_more === true ? 'YES' : 'NO';
}

/**
 * Re-read one ask alone. `createMessage` / `messageText` are the worker's llm helpers, passed in
 * so this module stays importable from a test without a model client.
 * Returns the verdict, or 'SKIP' when the call failed (a failed check retires nothing).
 */
export async function checkAsk(ask, { createMessage, messageText, model, workspaceId = null }) {
  try {
    const msg = await createMessage({
      meter: { workspaceId },
      feature: 'cs_expansion_verify', model, max_tokens: 150, system: ASK_CHECK_SYSTEM,
      messages: [{ role: 'user', content: askCheckPrompt(ask) }],
    });
    return { verdict: verdictFromAnswers(messageText(msg)), cost: Number(msg?.cost_usd ?? 0) };
  } catch {
    return { verdict: 'SKIP', cost: 0 };
  }
}
