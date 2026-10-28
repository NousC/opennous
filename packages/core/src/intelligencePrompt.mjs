// How a writer is told to use the Intelligence it is handed (GET-1042), and how what it wrote is
// cleaned of the ids. The automation's briefs and follow-ups, the detector drafts and the follow-up
// cards all say it the same way, so a change to the rule lands on every writer at once.
//
// intelligenceFor (./intelligenceContext.mjs) ends every point with its id, [objections:b1a2b3c4],
// so the run can say which points the writer was shown. The ids are for us. A buyer who reads
// "[battlecards:9f00e1a2]" in an email has been shown our notes, so the writer is told to leave them
// out and anything that slips through is taken out before the draft is saved.

const REF = /[ \t]*\[(?:win_loss|objections|battlecards|icp):[a-z0-9_-]+\]/g;

/**
 * The paragraph a system prompt adds when the material holds Intelligence. Pure.
 *   purpose  'draft' for words the buyer reads (an email), 'brief' for words a colleague reads.
 *   field    where the material holds it ("intelligence" in a JSON material, a heading elsewhere).
 */
export function intelligenceRule(purpose = 'brief', { field = '"intelligence"' } = {}) {
  const what = `${field} is what this workspace has learned from earlier deals: the Objection playbook, the Battlecards, Win/loss and what predicts a win.`;
  const markers = 'Every point there ends in an id like [objections:b1a2b3c4]. Never write those ids.';
  if (purpose === 'draft') {
    return `WHAT HAS WORKED BEFORE. ${what} Where a point there answers what this buyer raised, you may use it: an answer that has worked before. Say it in your own words, as something you know; never quote it, and never tell the buyer it exists. Never use a point it does not hold, and never invent one. When nothing there fits, leave it out. ${markers}`;
  }
  return `WHAT HAS WORKED BEFORE. ${what} Where a point there bears on this account (an objection still open, a competitor in play), say it where it belongs: the answer that has worked before, what wins against that competitor. Never use a point it does not hold, and never invent one. When nothing there fits, leave it out. ${markers}`;
}

/** Text with any Intelligence ids taken out (a writer that echoed one). Pure. */
export function withoutIntelligenceRefs(text) {
  if (typeof text !== 'string') return text;
  return text.replace(REF, '');
}
