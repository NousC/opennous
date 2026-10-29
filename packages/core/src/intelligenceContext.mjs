// What the workspace has learned, for the next action (GET-1042).
//
// Intelligence files (Win/loss, the Objection playbook, Battlecards, the ICP's learned block) are
// written by Nous Cloud from every close and every objection. They only compound when the next
// action reads them: call prep, follow-up drafts, the agent and MCP. Those readers are public code,
// the files are Cloud's, so the Cloud layer registers a source here and public code asks through it.
// Without one (a self-hosted install) there is no Intelligence, and every reader works as before.

let source = null;

/**
 * `fn(sb, ws, opts)` → { text, used } | null. Set once by the Intelligence files' reader
 * (packages/core/src/context/intelligence.mjs, open source since 2026-10-29).
 */
export function registerIntelligenceSource(fn) { source = typeof fn === 'function' ? fn : null; }

/**
 * The parts of the workspace's Intelligence files that bear on this action.
 *
 *   companyId  the account it is for: its open objections and competitors pick the sections.
 *              Null asks for the files as a whole (an agent reading what the workspace knows).
 *   purpose    'brief' (call prep, a meeting brief), 'draft' (a follow-up or reply) or 'agent'.
 *   budget     the most characters of text to return.
 *
 * → { text, used: [{ key, section, blocks }] } or null when there is none. `text` is markdown, one
 * heading per section, each point ending in its id ([objections:b1a2b3c4]) so an outcome can be
 * traced back to the point that was used. Never throws: a reader without Intelligence is a reader.
 */
export async function intelligenceFor(sb, ws, { companyId = null, purpose = 'brief', budget = 3500 } = {}) {
  if (!source || !ws) return null;
  try {
    const out = await source(sb, ws, { companyId, purpose, budget });
    return out?.text?.trim() ? out : null;
  } catch {
    return null;
  }
}

/** The ids `intelligenceFor` stamped on its points, as `key:blockId`, in order. Pure. */
export function intelligenceRefs(text) {
  return [...String(text ?? '').matchAll(/\[(win_loss|objections|battlecards|icp):([a-z0-9_-]+)\]/g)].map(m => `${m[1]}:${m[2]}`);
}
