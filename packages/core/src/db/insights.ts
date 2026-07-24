import type { SupabaseClient } from '@supabase/supabase-js';
import { INSIGHT_CATEGORIES, INSIGHT_CATEGORY_KEYS, insightCategoryLabel, insightCategoryPromptBlock, normalizeInsightCategory } from './insightCategories.js';

// Insights — the workspace's self-knowledge, learned from calls.
//
// One row per (workspace, category). Each row is a running markdown doc that the
// insight extractor APPENDS to, and the Vault renders/edits like any other doc.
// This is the OPPOSITE direction from a foundation: a foundation is authored by
// the user and mirrored into Nous; an insight is authored by Nous (from calls)
// and can be mirrored out to the user's repo. Nous is always the home.

export interface InsightDoc {
  id: string;
  workspace_id: string;
  category: string;
  title: string;
  body_md: string;
  version: number;
  updated_at: string | null;
  created_at?: string | null;
}

export interface ExtractedInsight {
  /** One of the INSIGHT_CATEGORY_KEYS. */
  category: string;
  /** The insight, as one crisp standalone sentence about US. */
  content: string;
  /** A short verbatim line from the transcript that supports it (provenance). */
  quote?: string | null;
}

// The one prompt both extractors share (the worker's auto-hook and the API's
// manual "extract" button), so the two never drift. Pass the external attendee
// names so the model can tell the prospect's words from our own.
export function buildInsightExtractionPrompt(transcript: string, opts: { attendees?: string[] } = {}): string {
  const names = (opts.attendees ?? []).filter(Boolean);
  const whoSaid = names.length
    ? `The EXTERNAL attendees — the prospect/customer side we are learning from — are: ${names.join(', ')}. Everyone else who speaks (e.g. "Bennet", our own side) is US.`
    : `The transcript has two sides: the person hosting/selling (US) and the prospect/customer. Judge which speaker is the prospect from context.`;
  return `You are mining a sales/discovery call for insights about OUR OWN company — product, positioning, market, or buyer. Read the WHOLE transcript first.

${whoSaid}

THE HARD RULE: an insight may ONLY be grounded in what an EXTERNAL attendee (the prospect) actually said. Our own side's statements are our existing opinions, not learnings — NEVER turn something WE said into an insight, and NEVER use one of our lines as the quote. If the prospect merely agreed ("yeah exactly") with a point WE made, that is not their insight; skip it unless they said something substantive in their own words. Every quote MUST be a verbatim line spoken by the prospect.

CAPTURE (only from the prospect's own words):
- Advice they gave us — what to build, how to message, who to sell to.
- A gap, objection, or friction they exposed in what we do.
- A market shift, wedge, segment, or channel they revealed, incl. why-now observations.
- The underlying pain that makes someone buy.
- A thesis they state that validates or challenges our core bet — capture it even when it just agrees with us; external validation is high-value. (Hunt for this — it is the most-missed kind. E.g. an operator independently saying teams keep rebuilding customer context from scratch would validate a persistent-context product.)

Do NOT capture: facts about the attendee/their company, logistics, pleasantries, or anything only WE said.

Transcript: "${transcript}"

Each insight must pass ALL THREE bars: (1) ABOUT US — informs how we build/message/sell/target, or confirms/challenges our thesis; (2) DURABLE — useful weeks from now; (3) SPECIFIC — carries the concrete point.

Tag each with:
- "category": exactly one of: ${INSIGHT_CATEGORY_KEYS.join(', ')}.
- "content": ONE tight sentence, our point of view, MAX ~18 words. Punchy, no preamble, no hedging.
- "quote": the single most telling fragment the PROSPECT said, verbatim, MAX ~20 words. Not our words.

Categories:
${insightCategoryPromptBlock()}

Rules:
- Extract every insight that clears all three bars — no target number. A thin call yields zero; a rich one several. NEVER pad, NEVER restate the same insight twice.
- Keep content and quote SHORT. If it needs two sentences, it is not tight enough — cut it down.
- Hard ceiling of 8 insights.

Output ONLY valid JSON: [{"category":"<key>","content":"...","quote":"..."}]
If nothing meaningful: []`;
}

/** Parse the model's JSON array of insights out of raw text. Tolerant of prose around it. */
export function parseInsightsJson(text: string): ExtractedInsight[] {
  try {
    const t = (text || '').trim();
    const s = t.indexOf('['), e = t.lastIndexOf(']');
    if (s === -1 || e === -1) return [];
    const arr = JSON.parse(t.slice(s, e + 1));
    if (!Array.isArray(arr)) return [];
    return arr.filter(x => x && typeof x.content === 'string' && typeof x.category === 'string');
  } catch {
    return [];
  }
}

/** List a workspace's insight docs (no body), one per category that exists. */
export async function listInsights(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<InsightDoc[]> {
  const { data, error } = await supabase
    .from('insights')
    .select('id, workspace_id, category, title, body_md, version, updated_at, created_at')
    .eq('workspace_id', workspaceId)
    .order('category', { ascending: true });
  if (error) throw error;
  return (data as InsightDoc[]) || [];
}

/** Get one insight doc by category (with body). Returns null if not created yet. */
export async function getInsight(
  supabase: SupabaseClient,
  workspaceId: string,
  category: string,
): Promise<InsightDoc | null> {
  const cat = normalizeInsightCategory(category);
  if (!cat) return null;
  const { data, error } = await supabase
    .from('insights')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('category', cat)
    .maybeSingle();
  if (error) throw error;
  return (data as InsightDoc) || null;
}

/** Upsert an insight doc's full body (used by the Vault editor). */
export async function upsertInsight(
  supabase: SupabaseClient,
  workspaceId: string,
  category: string,
  body_md: string,
): Promise<InsightDoc> {
  const cat = normalizeInsightCategory(category);
  if (!cat) throw new Error('invalid_insight_category');
  const { data: existing } = await supabase
    .from('insights')
    .select('version')
    .eq('workspace_id', workspaceId)
    .eq('category', cat)
    .maybeSingle();
  const now = new Date().toISOString();
  const row = {
    workspace_id: workspaceId,
    category: cat,
    title: insightCategoryLabel(cat),
    body_md,
    version: existing ? (existing as { version: number }).version + 1 : 1,
    updated_at: now,
  };
  const { data, error } = await supabase
    .from('insights')
    .upsert(row, { onConflict: 'workspace_id,category' })
    .select('*')
    .single();
  if (error) throw error;
  return data as InsightDoc;
}

// One appended bullet. Kept deliberately plain-markdown so the doc stays readable
// and hand-editable in the Vault, and so a repo mirror is a clean .md file.
function formatBullet(item: ExtractedInsight, sourceLabel?: string | null): string {
  const quote = item.quote ? ` — "${item.quote.trim().replace(/\s+/g, ' ').slice(0, 240)}"` : '';
  const src = sourceLabel ? ` (${sourceLabel})` : '';
  return `- ${item.content.trim()}${quote}${src}`;
}

/**
 * Append extracted insights to their category docs. Groups items by category,
 * skips near-duplicates already present in the doc, bumps version, and stamps the
 * update. Returns the number of bullets actually written.
 */
export async function appendInsights(
  supabase: SupabaseClient,
  workspaceId: string,
  items: ExtractedInsight[],
  opts: { sourceLabel?: string | null } = {},
): Promise<number> {
  const byCat = new Map<string, ExtractedInsight[]>();
  for (const it of items) {
    const cat = normalizeInsightCategory(it.category);
    if (!cat || !it?.content || typeof it.content !== 'string' || it.content.trim().length < 8) continue;
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat)!.push({ ...it, category: cat });
  }
  if (byCat.size === 0) return 0;

  let written = 0;
  for (const [cat, catItems] of byCat) {
    const existing = await getInsight(supabase, workspaceId, cat);
    const body = existing?.body_md ?? '';
    // Cheap dedup: skip an insight whose leading clause already appears verbatim.
    const seen = body.toLowerCase();
    const fresh = catItems.filter(it => {
      const stem = it.content.trim().toLowerCase().slice(0, 60);
      return stem.length > 0 && !seen.includes(stem);
    });
    if (fresh.length === 0) continue;

    const bullets = fresh.map(it => formatBullet(it, opts.sourceLabel)).join('\n');
    const nextBody = body.trim() ? `${body.trim()}\n${bullets}\n` : `${bullets}\n`;
    await upsertInsight(supabase, workspaceId, cat, nextBody);
    written += fresh.length;
  }
  return written;
}

export { INSIGHT_CATEGORIES, INSIGHT_CATEGORY_KEYS, insightCategoryLabel };
