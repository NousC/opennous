// The insight extractor — the mirror image of the claim extractor.
//
// The claim extractor mines a call for durable facts ABOUT the attendees and is
// explicitly forbidden from recording our own side. This pass does the opposite:
// it reads the SAME transcript and asks what the call taught us about OUR product,
// positioning, market, and buyer, then appends each insight into the workspace's
// Insights docs (never onto a contact's account). Runs once per call.

import { setUser } from 'useleak';
import { appendInsights, buildInsightExtractionPrompt, parseInsightsJson, loadWorkspaceContext, buildTeamInsightExtractionPrompt, appendTeamInsights, listInsightTopics, formatWatchTopics } from '@nous/core';
import { read, parseArray, acceptsArray } from '../noema/read.mjs';


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
export async function extractCallInsights({ supabase, workspaceId, transcript, sourceLabel, attendees, occurredAt, sourceRef, sourceSystem, onResult = null }) {
  try {
    if (!transcript || transcript.length < 200) return 0; // thin calls rarely hold a real insight
    setUser({ id: String(workspaceId) });

    // Ground the extraction in who WE are. Without the workspace's own context the model
    // cannot tell an insight about our GTM from the prospect describing their own
    // business, so it files the prospect's world as ours. If there's no context yet,
    // SKIP — an ungrounded insight folder is worse than an empty one.
    const workspaceContext = await loadWorkspaceContext(supabase, workspaceId).catch(() => null);
    if (!workspaceContext) {
      console.log(`[INSIGHT_EXTRACTOR] skipped — workspace ${workspaceId} has no ICP/positioning context to attribute against`);
      return 0;
    }

    const watchTopics = formatWatchTopics(await listInsightTopics(supabase, workspaceId, 'external').catch(() => []), 'external');
    const result = await readInsights(buildInsightExtractionPrompt(transcript, { attendees, workspaceContext, watchTopics }), supabase, workspaceId);
    // Still 0 either way — but "we could not read the answer" is now a pipeline_events row rather
    // than a call that looks like it held no insight at all (GET-320).
    onResult?.(result.ok ? { ok: true } : { ok: false, reason: result.reason });
    if (!result.ok) return 0;
    const items = result.value;
    if (items.length === 0) return 0;

    return await appendInsights(supabase, workspaceId, items.slice(0, 8), { sourceLabel, occurredAt, sourceRef, sourceSystem });
  } catch (err) {
    console.warn('[INSIGHT_EXTRACTOR_ERROR]', err.message);
    onResult?.({ ok: false, reason: /unavailable|402|429|5\d\d/i.test(String(err?.message)) || err?.name === 'ModelUnavailableError' ? 'unavailable' : 'error' });
    return 0;
  }
}

/**
 * Extract TEAM insights from an INTERNAL call (all attendees on our side — a founders'
 * sync, a standup) and append them to the structured store as source='team'. This is the
 * counterpart to extractCallInsights: no prospect, no attribution to who-we-are, just what
 * the team DECIDED, what is BLOCKING them, and what they LEARNED. Returns the count written.
 */
export async function extractTeamInsights({ supabase, workspaceId, transcript, occurredAt, sourceRef, sourceSystem }) {
  try {
    if (!transcript || transcript.length < 200) return 0;
    setUser({ id: String(workspaceId) });
    const watchTopics = formatWatchTopics(await listInsightTopics(supabase, workspaceId, 'team').catch(() => []), 'team');
    const result = await readInsights(buildTeamInsightExtractionPrompt(transcript, watchTopics), supabase, workspaceId);
    if (!result.ok) return 0;
    const items = result.value;
    if (!items.length) return 0;
    return await appendTeamInsights(supabase, workspaceId, items.slice(0, 8), { occurredAt, sourceRef, sourceSystem });
  } catch (err) {
    console.warn('[TEAM_INSIGHT_EXTRACTOR_ERROR]', err.message);
    return 0;
  }
}
