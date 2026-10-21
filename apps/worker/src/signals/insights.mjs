// The insight extractor — the mirror image of the claim extractor.
//
// The claim extractor mines a call for durable facts ABOUT the attendees and is
// explicitly forbidden from recording our own side. This pass does the opposite:
// it reads the SAME transcript and asks what the call taught us about OUR product,
// positioning, market, and buyer, then appends each insight into the workspace's
// Insights docs (never onto a contact's account). Runs once per call.

import { setUser } from 'useleak';
import { appendInsights, buildInsightExtractionPrompt, parseInsightsJson, loadWorkspaceContext, listInsightTopics, formatWatchTopics, embedBatch } from '@nous/core';
import { read, parseArray, acceptsArray } from '../noema/read.mjs';
import { externalEvidence } from '../noema/externalEvidence.mjs';
import { groundQuote, spokenByOurSide } from '../noema/grounding.mjs';

// ── Evidence (GET-974) ───────────────────────────────────────────────────────
//
// An insight rests on the customer's own words; the prompt says so, and now code checks it. Claims
// have gone through the verbatim quote check since GET-329; insights went onto the page as "receipts"
// unchecked. An insight whose quote is not in the source, or is a line our own side spoke, is dropped.
// The caller passes what a quote may rest on: the transcript of a call, their side of a thread.
export function groundInsights(items, { sourceText, transcript = sourceText, ourNames = [] } = {}) {
  const kept = [];
  let dropped = 0;
  for (const it of items ?? []) {
    const quote = typeof it?.quote === 'string' ? groundQuote(it.quote, sourceText) : null;
    if (!quote || (ourNames.length && spokenByOurSide(quote, transcript, ourNames))) { dropped++; continue; }
    kept.push({ ...it, quote });
  }
  return { kept, dropped };
}

// A re-read of the same source must not file a point again (GET-974). One email thread, read again
// on every new reply, filed "activity summaries in Slack" about fourteen times, each reworded, which
// the 80-character text key cannot see. Measured on that workspace's insights: rewordings of one
// point sat at 0.85 and above, and nothing different came close. Only the SAME source counts: the
// same point from another account is the pattern insights exist to count, so it is kept.
export const INSIGHT_REPEAT_SIMILARITY = 0.85;
const cosine = (a, b) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return x && y ? d / Math.sqrt(x * y) : 0; };

/** The items that are not repeats: of one already filed from this source, or of each other. Pure. */
export function newInsights(items, itemVecs, existing, existingVecs, threshold = INSIGHT_REPEAT_SIMILARITY) {
  const out = [], outVecs = [];
  (items ?? []).forEach((it, i) => {
    const vec = itemVecs?.[i];
    if (!vec) { out.push(it); return; }
    const near = (cat, vecs, rows) => rows.some((r, k) => r.category === cat && vecs[k] && cosine(vec, vecs[k]) >= threshold);
    if (near(it.category, existingVecs ?? [], existing ?? []) || near(it.category, outVecs, out)) return;
    out.push(it); outVecs.push(vec);
  });
  return out;
}

async function withoutRepeats(supabase, workspaceId, items, sourceRef) {
  if (!items.length) return items;
  const { data: existing } = sourceRef
    ? await supabase.from('insight_items').select('category, statement').eq('workspace_id', workspaceId).eq('source_ref', sourceRef).limit(200)
    : { data: [] };
  const old = existing ?? [];
  if (!old.length && items.length < 2) return items;
  const vecs = await embedBatch([...items.map(i => i.content), ...old.map(e => e.statement)]).catch(() => null);
  if (!vecs) return items;   // no embeddings: file them; the text key still catches exact copies
  return newInsights(items, vecs.slice(0, items.length), old, vecs.slice(items.length));
}


// The insights pass reads the whole transcript once per call. It goes through the model door like
// every other call (GET-257): the extraction tier, its fallback, its host pins, metered at the real
// cost. It used to call INSIGHTS_BASE_URL directly when that was set, and prod set it — so insights
// ran on GLM 4.7 with no fallback, no host pin, and a recorded cost of $0.
//
// What a valid answer looks like is `parseInsightsJson` and nothing else: an array we can read, of
// which we keep the items carrying a content and a category. An array we CANNOT read is a different
// answer from an array with nothing in it, and until GET-320 this pass could not tell you which one
// it got — a transcript full of insights that came back as prose was filed as "this call taught us
// nothing". The old gate said only "there is a [ and a ] somewhere", which passed answers
// JSON.parse then threw on; the gate is now derived from the parser, so the two cannot disagree.
const parseInsights = (text) => (parseArray(text) === null ? null : parseInsightsJson(text));

async function readInsights(prompt, supabase, workspaceId) {
  // The budget covers reasoning + output; the JSON is read from the text block.
  return read({
    supabase, workspaceId,
    feature: 'call-insights-extract',
    meterAs: 'insights-extraction',
    accept: acceptsArray,
    parse: parseInsights,
    maxTokens: 6000,
    prompt,
  });
}

/**
 * Extract "insights about us" from a call transcript and append them to the
 * workspace's Insights docs. Returns the number of insights written.
 *
 * @param {object}   args
 * @param {import('@supabase/supabase-js').SupabaseClient} args.supabase
 * @param {string}   args.workspaceId
 * @param {string}   args.transcript  the full call notes/transcript
 * @param {string=}  args.sourceLabel  who/when, e.g. "Theo Bramwell, Harborline" (provenance)
 * @param {string[]=} args.attendees   external attendee names, so the model draws insights
 *                                      only from the prospect's words, not our own side.
 * @param {string=}  args.sourceRef   `source://fireflies/<id>` — where these were said. Carried
 *                                     onto every row so a quoted insight can reach its
 *                                     transcript. Without it an insight is the richest
 *                                     evidence in the product and the least checkable.
 * @param {string=}  args.sourceSystem the system behind the ref, for the panel's logo.
 */
/**
 * The read half of extractCallInsights: the insights a call holds, written nowhere. The extraction
 * test set (GET-774) scores exactly what production would file. Returns [] when the workspace has
 * no context to attribute against (production skips those calls too) or nothing could be read.
 */
export async function readCallInsightItems({ supabase, workspaceId, transcript, attendees }) {
  if (!transcript || transcript.length < 200) return [];
  const workspaceContext = await loadWorkspaceContext(supabase, workspaceId).catch(() => null);
  if (!workspaceContext) return [];
  const watchTopics = formatWatchTopics(await listInsightTopics(supabase, workspaceId, 'external').catch(() => []), 'external');
  const result = await readInsights(buildInsightExtractionPrompt(transcript, { attendees, workspaceContext, watchTopics }), supabase, workspaceId);
  return result.ok ? result.value.slice(0, 8) : [];
}

// onResult({ ok, reason }) — whether the model was reached: the Gmail reader holds its read marker
// when it was not, so an outage does not mark a thread done without its insights.
export async function extractCallInsights({ supabase, workspaceId, transcript, sourceLabel, attendees, occurredAt, sourceRef, sourceSystem, onResult = null, evidenceMessages = null, structuredOnly = false, minTranscriptChars = 200, groundAgainst = null, ourNames = [] }) {
  try {
    if (!transcript || transcript.length < minTranscriptChars) { onResult?.({ ok: true, reason: 'thin_source' }); return 0; }
    setUser({ id: String(workspaceId) });

    // Ground the extraction in who WE are. Without the workspace's own context the model
    // cannot tell an insight about our GTM from the prospect describing their own
    // business, so it files the prospect's world as ours. If there's no context yet,
    // SKIP — an ungrounded insight folder is worse than an empty one.
    const workspaceContext = await loadWorkspaceContext(supabase, workspaceId).catch(() => null);
    if (!workspaceContext) {
      onResult?.({ ok: true, reason: 'no_workspace_context' });
      console.log(`[INSIGHT_EXTRACTOR] skipped — workspace ${workspaceId} has no ICP/positioning context to attribute against`);
      return 0;
    }

    const watchTopics = formatWatchTopics(await listInsightTopics(supabase, workspaceId, 'external').catch(() => []), 'external');
    const result = await readInsights(buildInsightExtractionPrompt(transcript, { attendees, workspaceContext, watchTopics }), supabase, workspaceId);
    // Still 0 either way — but "we could not read the answer" is now a pipeline_events row rather
    // than a call that looks like it held no insight at all (GET-320).
    onResult?.(result.ok ? { ok: true } : { ok: false, reason: result.reason });
    if (!result.ok) return 0;
    let items;
    if (evidenceMessages !== null) items = externalEvidence(result.value, evidenceMessages);
    else {
      const g = groundInsights(result.value, { sourceText: groundAgainst ?? transcript, transcript, ourNames });
      if (g.dropped) console.log(`[INSIGHT_EXTRACTOR] ${g.dropped} of ${result.value.length} insight(s) dropped: quote not in the source, or ours (${sourceRef ?? 'no ref'})`);
      items = g.kept;
    }
    items = await withoutRepeats(supabase, workspaceId, items, sourceRef);
    if (items.length === 0) return 0;

    return await appendInsights(supabase, workspaceId, items.slice(0, 8), { sourceLabel, occurredAt, sourceRef, sourceSystem, structuredOnly, strict: evidenceMessages !== null });
  } catch (err) {
    console.warn('[INSIGHT_EXTRACTOR_ERROR]', err.message);
    onResult?.({ ok: false, reason: /unavailable|402|429|5\d\d/i.test(String(err?.message)) || err?.name === 'ModelUnavailableError' ? 'unavailable' : 'error' });
    return 0;
  }
}
