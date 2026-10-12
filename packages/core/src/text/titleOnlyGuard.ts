// A job title on its own is not a fact — the mechanical half of that rule (GET-421).
//
// The extraction prompt has said so since GET-327, and both extractors still emit them. Measured
// on one customer's corpus 2026-09-22: well over the bar of Gmail claims were `general`, and **about
// half of those were a person's role and nothing else** — "Odette Marchbank is the General Sales
// Manager at Quarry Ridge Motors", "Bram Hollister is the Finance Director at Ashcombe RV", and
// dozens more. The same shape the meeting audit found. This is GET-417's lesson again: when a
// prompt forbids something and the model does it anyway, the check belongs in code.
//
// It costs nothing to drop them: `persistJobTitles` runs FIRST and files the title as the person's
// `job_title` attribute whether or not the claim survives. Dropping the claim removes a duplicate.
//
// THE SHAPE IS MATCHED WHOLE, AND THAT IS THE WHOLE DESIGN. The first version asked "does this
// sentence contain a role word and no verb of doing", which is an allowlist of verbs — unfinishable
// by construction. Validated against every live claim it would have dropped hundreds, including
// "Tamsin Orloff recently joined Fennick Honda as a sales manager" (joined), "the office
// clerk questioned which discount was applied" (questioned) and everything mentioning a sales *lead*
// or a *GM* store, because `lead` and `gm` are role words in a list and General Motors in a
// dealership corpus.
//
// So the sentence must match END TO END: "<Name> is [a|the] <title> [at <Company>]." Anything with
// a second clause, a subordinate ("who", "because"), a quote, or any other verb fails to match and
// is kept. A guard that can only fire on one exact shape cannot surprise you.

/** Role nouns. Deliberately excludes `lead`, `gm`, `head`, `rep` and `buyer`: in this corpus they
 *  are a sales lead, General Motors, a head office, a report and a car buyer far more often. */
const ROLE_WORD =
  '(?:manager|managers|director|directors|president|vice[- ]president|owner|principal|officer|coordinator|consultant|specialist|associate|assistant|advisor|adviser|analyst|controller|executive|founder|co[- ]?founder|partner|chief|vp|svp|evp|ceo|cfo|coo|cto|cmo|gsm|salesperson|technician|administrator|supervisor|treasurer|secretary|broker|trainer|engineer|accountant|bookkeeper|receptionist|strategist|marketer|dealer principal)';

/**
 * The whole sentence, and nothing but:
 *   <Name words> is|was|are|were [a|an|the] <up to 7 title words containing a role word>
 *   [at|of|for|with|@ <company words>] [.]
 * The title segment forbids the punctuation and connectives that introduce a second clause.
 */
// NOT case-insensitive, and that is load-bearing: with the `i` flag `[A-Z]` matches lowercase
// too, so the company slot below accepted "is the decision maker in the store" as a company name
// and the guard swallowed a real authority fact. The role word is tested separately, where case
// genuinely does not matter.
const TITLE_ONLY_RE = new RegExp(
  // The subject is a NAME — capitalised words — not "anything up to a copula". A loose segment
  // backtracks over the first clause and matches on a LATER copula: "Cyrus is the owner and
  // president of Velmont | and is | the decision maker in the store" parsed as name + "is" + title.
  '^(?:[A-ZÀ-Þ][\\wÀ-ÿ.\'’-]*\\s+){0,4}[A-ZÀ-Þ][\\wÀ-ÿ.\'’-]*\\s(?:is|was|are|were)\\s(?:a|an|the)?\\s*' +
  // Title words, or a bare separator: "Executive Assistant - National Operations".
  '(?:(?:[A-Za-z][\\w&/.\'’-]*|[-/&])(?:\\s+|(?=\\.?$))){1,8}' +
  // "[at <Company>]" — and the company must look like a NAME: capitalised tokens plus the few
  // connectors a dealership name carries. A loose `.{0,60}?` here let "Cyrus is the owner and
  // president of Velmont and is the decision maker in the store" match, swallowing a real authority
  // fact into the company slot.
  // `\\s*` not `\\s+`: the title phrase above already consumed the separating space.
  '(?:\\s*(?:at|of|for|with|@)\\s+[A-ZÀ-Þ][\\wÀ-ÿ&.\'’-]*(?:\\s+(?:[A-ZÀ-Þ][\\wÀ-ÿ&.\'’-]*|[a-z]{1,3}|&|-|\\d+))*)?' +
  '\\.?$',                                                                              // and then it ends
);

/** The title phrase has to name a role — checked here, where case does not matter. */
const HAS_ROLE_RE = new RegExp(`\\b${ROLE_WORD}\\b`, 'i');

/** Connectives and punctuation that mean the sentence says more than the role. */
// A reporting verb anywhere means someone is relaying it — that is a fact about the telling, and
// the name segment would otherwise absorb it ("Anselm Kraye said Dorian and Faisal are managers").
const SECOND_CLAUSE_RE = /\b(who|which|that|because|since|so|but|while|after|before|when|where|said|says|told|noted|confirmed|and (?:asked|wants|plans|uses|will|would|has|have|is now|is taking|recently))\b|[;:"“”]/i;

/**
 * Is this fact ONLY a statement of someone's role?
 *
 * True → drop the claim; the title is already filed as `job_title`. False → keep it.
 */
export function isTitleOnlyFact(content: string | null | undefined): boolean {
  const s = String(content ?? '').trim().replace(/\s+/g, ' ');
  if (!s || s.length > 140) return false;      // a long sentence is saying something
  if (SECOND_CLAUSE_RE.test(s)) return false;  // it says more than the role
  if (!HAS_ROLE_RE.test(s)) return false;      // "Kim is Canadian" is not a title statement
  // A title with a CHANGE or a RELATION in it is not a bare attribute, and `job_title` cannot hold
  // either: "Ivo Pemberly is NOW the operations manager", "Desmond is a NEW salesperson", "Liesel is a
  // FORMER finance manager", "Wren is Cassius Ondaatje'S sales manager" (whose manager she is).
  if (/\b(new|now|newly|former|formerly|previously|recently|incoming|outgoing|interim|acting|no longer)\b/i.test(s)) return false;
  if (/['’]s\s/.test(s)) return false;
  return TITLE_ONLY_RE.test(s);
}

export const TITLE_ONLY_REASON = 'a job title on its own is an attribute, not a fact (filed as job_title)';
