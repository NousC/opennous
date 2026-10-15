// The pronoun guard, in ONE place.
//
// An Intel fact must name its subject explicitly. A fact that collapses into 1st/2nd
// person ("you found us after viewing your profile", "my CEO will decide") renders as
// garbage on the card, because the card has no "you" — it is read by a third party
// about a fourth. So the extractor's output is refused when it inverts like that.
//
// This lived as a byte-identical copy in apps/worker/src/signals/index.mjs and
// apps/api/src/lib/recordObservations.mjs. GET-364/365/366 were all the same shape —
// two writers, one rule, drifted — so this one is imported by both rather than
// re-declared. See two-places-one-rule.
//
// GET-368: the previous lookbehind was (?<![-\w]), which excludes only hyphen and word
// characters. `&` is neither — so the `I` in "D&I" read as a bare first-person pronoun
// and every fact mentioning D&I was silently dropped. In an HR-heavy workspace that
// is most people-team conversations. `R.O.I`, `AT&I` and `Q&I` died the same way, while the
// old comment claimed "R.O.I" was safe precisely because it is capitalised — it never
// was: `I` IS the capital form, so the capitalisation argument only ever covered
// `my`/`mine`.
//
// The fix is to require a free-standing token: the pronoun must be preceded by
// whitespace (or start-of-string) rather than merely "not a word character". That kills
// the whole class of punctuation-adjacent false positives at once instead of patching
// `&` and waiting for the next separator to show up.

// Pronouns are legitimate inside a direct quote ("stated he is 'trying to keep as much
// of the old setup running as I can'"), inside a compound ("done-for-you", "pay-as-you-go"),
// or inside a proper name ("My Studio"). So before testing we collapse contraction
// apostrophes — so a '…'-delimited quote holding "I'm"/"don't" doesn't close early —
// then strip every quoted span.
const QUOTED_SPAN_RE = /'[^']*'|"[^"]*"|‘[^’]*’|“[^”]*”/g;
const CONTRACTION_RE = /([A-Za-z])['’]([A-Za-z])/g;

// (?<!\S) = preceded by whitespace or start-of-string, i.e. a free-standing token.
// (?![-\w&]) = not the head of a compound ("you-first") or an initialism ("I&M").
// Case-sensitive on purpose: "My Studio" and "Mine Safety" are names, not pronouns.
// "us"/"our"/"we" are never flagged — they legitimately refer to the workspace.
const SECOND_PERSON_RE = /(?<!\S)(you|your|yours)(?![-\w&])/;
const FIRST_PERSON_RE = /(?<!\S)(I|my|mine)(?![-\w&])/;

/**
 * True when a claim's content addresses its subject in 1st or 2nd person, which means
 * the model wrote as the contact instead of about them.
 */
export function violatesPronounRule(content: unknown): boolean {
  if (typeof content !== 'string') return false;
  const bare = content.replace(CONTRACTION_RE, '$1$2').replace(QUOTED_SPAN_RE, ' ');
  return SECOND_PERSON_RE.test(bare) || FIRST_PERSON_RE.test(bare);
}

/** The reason string stamped on a rejected observation (GET-369). */
export const PRONOUN_RULE_REASON = 'content addresses the subject in first or second person';
