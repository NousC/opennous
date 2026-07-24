// The insight extractor — the mirror image of the claim extractor.
//
// The claim extractor mines a call for durable facts ABOUT the attendees and is
// explicitly forbidden from recording our own side. This pass does the opposite:
// it reads the SAME transcript and asks what the call taught us about OUR product,
// positioning, market, and buyer, then appends each insight into the workspace's
// Insights docs (never onto a contact's account). Runs once per call.

import Anthropic, { setUser } from 'useleak';
import { appendInsights, buildInsightExtractionPrompt, parseInsightsJson } from '@nous/core';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Extract "insights about us" from a call transcript and append them to the
 * workspace's Insights docs. Returns the number of insights written.
 *
 * @param {object}   args
 * @param {import('@supabase/supabase-js').SupabaseClient} args.supabase
 * @param {string}   args.workspaceId
 * @param {string}   args.transcript  the full call notes/transcript
 * @param {string=}  args.sourceLabel  who/when, e.g. "Jack Cane, Revenanas" (provenance)
 * @param {string[]=} args.attendees   external attendee names, so the model draws insights
 *                                      only from the prospect's words, not our own side.
 */
export async function extractCallInsights({ supabase, workspaceId, transcript, sourceLabel, attendees }) {
  try {
    if (!transcript || transcript.length < 200) return 0; // thin calls rarely hold a real insight
    setUser({ id: String(workspaceId) });

    const msg = await anthropic.messages.create({
      feature: 'call-insights-extract',
      // Sonnet, not Haiku: insight extraction runs ONCE per call (not per fact) and is
      // founder-critical — it must catch abstract thesis-validation insights that Haiku
      // reliably drops in favour of concrete items. The claim extractor stays on Haiku.
      // Sonnet is a reasoning model: it emits a `thinking` block first, so the budget
      // must cover thinking + output (1400 was all consumed by thinking → empty text),
      // and the JSON lives in the `text` block, not content[0].
      model: 'claude-sonnet-5',
      max_tokens: 6000,
      messages: [{ role: 'user', content: buildInsightExtractionPrompt(transcript, { attendees }) }],
    });

    const textBlock = msg.content.find(b => b.type === 'text')?.text ?? '[]';
    const items = parseInsightsJson(textBlock);
    if (items.length === 0) return 0;

    return await appendInsights(supabase, workspaceId, items.slice(0, 8), { sourceLabel });
  } catch (err) {
    console.warn('[INSIGHT_EXTRACTOR_ERROR]', err.message);
    return 0;
  }
}
