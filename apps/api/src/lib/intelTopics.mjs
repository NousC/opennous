// The Intel tab's topics for one record, as the viewer may see them — and a rebuild in the
// background when the record has facts the stored topics do not cover yet.
//
// A page load never waits on the model: it gets the stored topics plus any newer facts as plain
// chips, and the next load gets them grouped. See packages/core/src/db/intelTopics.ts.

import {
  loadIntelTopics, refreshIntelTopics, topicFacts, INTEL_TOPICS_MIN_FACTS, insightBoardModel,
} from '@nous/core';
import { createMessage, messageText } from './llm.mjs';

const inFlight = new Set();
const lastTry = new Map();           // entityId -> ms of the last rebuild attempt
const RETRY_MS = 10 * 60 * 1000;     // one rebuild per record per ten minutes, whatever the traffic

async function ask(prompt) {
  try {
    const msg = await createMessage({
      feature: 'intel-topics', model: insightBoardModel(), max_tokens: 8000,
      accept: (t) => t.includes('"topics"'),
      messages: [{ role: 'user', content: prompt }],
    });
    return messageText(msg) || null;
  } catch (err) {
    console.warn('[INTEL_TOPICS] model failed:', err.message);
    return null;
  }
}

/** Rebuild one record's topics now. `loadNotes` returns its full, unscoped fact set. */
export async function rebuildIntelTopics(supabase, workspaceId, entityId, loadNotes, { force = false } = {}) {
  const notes = await loadNotes();
  return refreshIntelTopics(supabase, workspaceId, entityId, notes, ask, { model: insightBoardModel(), force });
}

function scheduleRebuild(supabase, workspaceId, entityId, loadNotes) {
  if (inFlight.has(entityId)) return;
  if (Date.now() - (lastTry.get(entityId) ?? 0) < RETRY_MS) return;
  inFlight.add(entityId);
  lastTry.set(entityId, Date.now());
  rebuildIntelTopics(supabase, workspaceId, entityId, loadNotes)
    .then(r => { if (r === 'built' || r === 'failed') console.log(`[INTEL_TOPICS] ${entityId} ${r}`); })
    .catch(err => console.warn('[INTEL_TOPICS] rebuild failed:', err.message))
    .finally(() => inFlight.delete(entityId));
}

/**
 * The topics this viewer sees over `visibleNotes` (already privacy-scoped). A fact the viewer may
 * not read is dropped from its topic, and a topic missing any fact loses its summary, since the
 * summary was written from all of them. Returns null when the record has no topics (yet).
 */
export async function intelTopicsFor(supabase, workspaceId, entityId, visibleNotes, loadNotes) {
  const row = await loadIntelTopics(supabase, workspaceId, entityId);
  const visible = topicFacts(visibleNotes);
  const seen = new Set(visible.map(n => n.id));

  const covered = new Set((row?.topics ?? []).flatMap(t => t.facts.flat()));
  const uncovered = visible.some(n => !covered.has(n.id));
  if (uncovered && visible.length >= INTEL_TOPICS_MIN_FACTS) scheduleRebuild(supabase, workspaceId, entityId, loadNotes);
  if (!row?.topics?.length) return null;

  const topics = [];
  for (const t of row.topics) {
    const facts = t.facts.map(g => g.filter(id => seen.has(id))).filter(g => g.length);
    if (!facts.length) continue;
    const whole = facts.flat().length === t.facts.flat().length;
    topics.push({ label: t.label, kind: t.kind, summary: whole ? t.summary : null, facts });
  }
  return topics.length ? topics : null;
}
