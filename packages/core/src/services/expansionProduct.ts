// Which product an expansion signal is really about (GET-402).
//
// The dominant remaining error in the CRM-corpus miner is not
// false interest — it is the right sentence filed against the wrong product.
// "Marisol showed them the Beacon add-on, which Dorian asked about adopting" came back with
// product = Lumen Relay: the model picked a plausible catalogue name rather than the one the quote
// says. A stricter verifier only trades that error for another (it retires true asks whose quote
// happens not to spell the family name), so the correction is made here, deterministically, at
// the point of writing: when the evidence itself names exactly one catalogue family, that is the
// product, whatever the model offered.
//
// Pure. The catalogue is the vendor's own product families (regional suffixes and trademarks
// already stripped, fees and promos already removed — see the miner).

/** Product families mentioned in a piece of text, matched as whole words, case-insensitive. */
export function catalogueFamiliesIn(text: string, catalogue: readonly string[]): string[] {
  const t = String(text ?? '').toLowerCase();
  if (!t) return [];
  const out: string[] = [];
  for (const family of catalogue) {
    const f = String(family ?? '').toLowerCase().trim();
    if (!f) continue;
    // A family like "Lumen Lead" is often said as "lead" — but "lead" alone would also match
    // "lead time", so a family is only found by its FULL name, or by its last word when that word
    // is distinctive (four letters or more and not a generic product noun).
    const words = f.split(/\s+/);
    const last = words[words.length - 1];
    const whole = new RegExp(`(^|[^a-z0-9])${escape(f)}([^a-z0-9]|$)`);
    const short = words.length > 1 && last.length >= 4 && !GENERIC.has(last)
      ? new RegExp(`(^|[^a-z0-9])${escape(last)}([^a-z0-9]|$)`) : null;
    if (whole.test(t) || (short && short.test(t))) out.push(family);
  }
  return out;
}

const GENERIC = new Set(['package', 'plan', 'pro', 'lite', 'plus', 'basic', 'premium', 'suite', 'tool', 'tools', 'portal', 'credit', 'trade', 'lead', 'leads']);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The product an expansion signal should be filed under.
 *
 *   - the quote names exactly one catalogue family → that family (the model's choice is
 *     overridden, and `corrected` says so)
 *   - the quote names none, the sentence names exactly one → that family
 *   - otherwise → what the model offered, matched loosely against the catalogue as before
 *   - no catalogue at all → what the model offered
 *
 * `null` when nothing matches: an ask that cannot say WHAT to sell is not a lead, and the caller
 * drops it, which is the existing rule.
 */
export function resolveExpansionProduct(
  offered: string | null | undefined,
  quote: string,
  text: string,
  catalogue: readonly string[],
): { product: string | null; corrected: boolean } {
  const model = String(offered ?? '').trim();
  if (!catalogue.length) return { product: model || null, corrected: false };

  const inQuote = catalogueFamiliesIn(quote, catalogue);
  if (inQuote.length === 1) return { product: inQuote[0], corrected: !sameFamily(model, inQuote[0]) };
  const inText = catalogueFamiliesIn(text, catalogue);
  if (inQuote.length === 0 && inText.length === 1) return { product: inText[0], corrected: !sameFamily(model, inText[0]) };

  return { product: looseMatch(model, catalogue), corrected: false };
}

/**
 * The model's word matched against the catalogue.
 *
 * The miner's original rule was "either string contains the other", and that rule was itself a
 * source of mis-attribution: "Sync" is contained in "ClearSYNCer", which sorts before "Lumen Sync",
 * so an ask for Sync landed on ClearSyncer by alphabet. Matching is on whole words now — "sync" finds
 * "Lumen Sync" and not "ClearSyncer" — and when several families still match, the shortest wins,
 * because "Lumen Sync" is what someone means by "sync", not "Lumen Sync & Archive bundle".
 */
function looseMatch(offered: string, catalogue: readonly string[]): string | null {
  const x = offered.toLowerCase().trim();
  if (!x) return null;
  const exact = catalogue.find(c => c.toLowerCase().trim() === x);
  if (exact) return exact;
  const word = (needle: string, hay: string) => new RegExp(`(^|[^a-z0-9])${escape(needle)}([^a-z0-9]|$)`).test(hay);
  const hits = catalogue.filter(c => { const y = c.toLowerCase().trim(); return word(x, y) || word(y, x); });
  if (!hits.length) return null;
  return hits.sort((a, b) => a.length - b.length)[0];
}

function sameFamily(a: string, b: string): boolean {
  return looseMatch(a, [b]) === b;
}
