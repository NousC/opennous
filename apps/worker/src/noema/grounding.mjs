// A quote the model did not read in the source is one it made up.
//
// Every insight carries the sentence the prospect actually said. Claims — the account record
// itself, and the thing a rep reads before a call — carried nothing: well over a thousand of them on
// the first customer workspace, none with a quote. A claim said a buyer "pushed back" and called something
// "super important", and there was no way, by hand or by machine, to ask whether he said it.
//
// So a claim carries its quote, and the quote is CHECKED. The same guard already exists elsewhere
// for one field (`actionItems.mjs`: "a deadline it did not read in the item is one it made up");
// this is that rule, generalised to the output everything else is built on.
//
// It is also the cheapest quality measure Noema has. It needs no labels and no sample: every
// extraction can be checked against its own source, so "what share of what we assert is grounded in
// something someone actually said" is answerable over the whole corpus, continuously.

/**
 * Compare-shape for text: case, whitespace and the punctuation a transcript renders differently
 * from the way a model repeats it back. Deliberately NOT aggressive — stripping words or stemming
 * would hide paraphrase, which is the thing being detected.
 */
export function normalizeForMatch(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[‘’ʼ′]/g, "'")      // curly apostrophes → '
    .replace(/[“”″]/g, '"')            // curly quotes → "
    .replace(/[‐-―−]/g, '-')           // dashes → -
    .replace(/[ ​-‍﻿]/g, ' ')     // nbsp, zero-width → space
    .replace(/\s+/g, ' ')
    .trim();
}

/** A quote too short to mean anything matches almost any text, which makes it useless as evidence. */
const MIN_QUOTE = 12;
/** A "quote" longer than this is a paraphrase of the passage, not the telling line from it. */
const MAX_QUOTE = 400;

/**
 * The quote if it is verbatim in the source, else null.
 *
 * Null is not a small failure — it means the one piece of evidence offered for a claim cannot be
 * found in what was said. The caller decides whether to keep the claim without it; what it must not
 * do is store an unverified quote as though it were checked.
 */
export function groundQuote(quote, sourceText) {
  const q = String(quote ?? '').trim();
  if (q.length < MIN_QUOTE || q.length > MAX_QUOTE) return null;
  const haystack = normalizeForMatch(sourceText);
  if (!haystack) return null;
  return haystack.includes(normalizeForMatch(q)) ? q : null;
}

/**
 * Attach a checked quote to each fact, and say how many failed.
 *
 * Facts keep their place either way: a claim with an ungrounded quote is still a claim, and dropping
 * it would trade a measurable weakness for an invisible gap. What changes is that the quote is only
 * stored when it survived the check, so `quote is null` means exactly one thing — nothing verifiable
 * was offered — rather than two.
 */
export function groundFacts(facts, sourceText) {
  let offered = 0, grounded = 0;
  const out = (facts ?? []).map((f) => {
    if (!f || typeof f !== 'object') return f;
    const raw = typeof f.quote === 'string' ? f.quote.trim() : '';
    if (!raw) return { ...f, quote: null };
    offered++;
    const ok = groundQuote(raw, sourceText);
    if (ok) grounded++;
    return { ...f, quote: ok };
  });
  return { facts: out, offered, grounded };
}

// ── The two-sided source (GET-329) ────────────────────────────────────────────
//
// A transcript has one text. A thread has two.
//
// Grounding a claim about the customer against the whole thread lets OUR OWN sentence become
// their evidence. "As you mentioned, your finance team needs the export fix" is us repeating them
// back, and a model reading the thread will file it as something they said — with a verbatim,
// checked, entirely misattributed quote. That is the email version of the bug that filed calls
// onto the seller's own employees, and an unchecked attribution is worse than a missing quote
// because it looks like evidence.
//
// So a two-sided source is rendered with one header line per message, and a claim ABOUT THEM is
// grounded only against their blocks. Insights about US take the whole thread; the model reads
// all of it either way — only what a claim may REST ON narrows.
const SIDE_HEADER = /^---\s*(us|them)\s*·.*---\s*$/;

/**
 * The blocks one side wrote, from a thread rendered with SIDE_HEADER lines.
 *
 * FAILS CLOSED. Text with no headers is not a thread, and returning it whole would silently
 * restore the exact behaviour this exists to prevent — so it returns nothing instead. The cost of
 * the closed direction is visible (the email line's grounding rate drops to 0% in the weekly read);
 * the cost of the open one is invisible, which is the direction that has actually bitten us.
 */
export function sideBlocks(threadText, side) {
  const out = [];
  let keeping = false;
  for (const line of String(threadText ?? '').split('\n')) {
    const m = SIDE_HEADER.exec(line);
    if (m) { keeping = m[1] === side; continue; }
    if (keeping) out.push(line);
  }
  return out.join('\n').trim();
}

/** The customer's own messages — the only text a claim about the customer may quote. */
export const theirSideOf = (threadText) => sideBlocks(threadText, 'them');


/**
 * Who SAID a quote, read off the transcript's speaker labels (GET-417).
 *
 * A Fellow/Fireflies transcript is "Name: line" per turn. Find the quote, walk back to the start
 * of its turn, read the label. Null when the quote is not in the transcript, or the transcript has
 * no labels — an unknown speaker is not evidence either way.
 */
export function speakerOfQuote(quote, transcript) {
  const q = normalizeForMatch(quote);
  if (!q || q.length < MIN_QUOTE) return null;
  const lines = String(transcript ?? '').split('\n');
  let current = null;
  for (const raw of lines) {
    const m = /^([A-Za-zÀ-ÿ' .-]{2,60}):\s/.exec(raw);
    if (m) current = m[1].trim();
    if (current && normalizeForMatch(raw).includes(q)) return current;
  }
  // A quote spanning a line break: match against the turn as a whole.
  const turns = [];
  for (const raw of lines) {
    const m = /^([A-Za-zÀ-ÿ' .-]{2,60}):\s(.*)$/.exec(raw);
    if (m) turns.push({ speaker: m[1].trim(), text: m[2] });
    else if (turns.length) turns[turns.length - 1].text += ' ' + raw;
  }
  for (const t of turns) if (normalizeForMatch(t.text).includes(q)) return t.speaker;
  return null;
}

/**
 * Whether a quote was spoken by one of OUR people (GET-417).
 *
 * The failure mode: the rep's pitch and the rep's guesses filed as the customer's facts:
 * [pain] "Setup Time Main Worry" quoting Ottilie — "my guess is the setup time is what worries
 * you most"; [performance] "Healthy Order Volume" quoting "sounds like orders keep coming in for you".
 * The prompt forbids it and the model still does it, so the check is mechanical: the speaker label
 * on the quote's turn, against the names on our side of the call. A first-name match counts —
 * transcripts say "Ottilie:" as often as "Ottilie Brandt:". Unknown speaker → false (not evidence).
 */
export function spokenByOurSide(quote, transcript, ourNames = []) {
  const speaker = speakerOfQuote(quote, transcript);
  if (!speaker) return false;
  const sp = normalizeForMatch(speaker);
  const spFirst = sp.split(' ')[0];
  for (const n of ourNames) {
    const nn = normalizeForMatch(n);
    if (!nn) continue;
    if (nn === sp) return true;
    const first = nn.split(' ')[0];
    if (first.length >= 3 && (first === spFirst || sp.startsWith(nn) || nn.startsWith(sp))) return true;
  }
  return false;
}
