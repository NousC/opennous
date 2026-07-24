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
// manual "extract" button), so the two never drift.
export function buildInsightExtractionPrompt(transcript: string): string {
  return `You are mining a sales/discovery call for insights about OUR OWN company — the side running the call (referred to as "we"/"us"/"our product"). This is the OPPOSITE of recording facts about the other attendees; those are captured elsewhere. Read the WHOLE transcript before deciding.

CAPTURE anything that teaches us about our own product, positioning, market, or buyer. This includes, and you must not miss:
- Direct advice they gave us (what to build, how to message, who to sell to).
- A gap, objection, or friction they exposed in what we do.
- A market shift, wedge, segment, or channel they revealed — including WHY-NOW observations about where the market is going.
- The underlying pain that makes someone buy — the bottleneck they feel.
- A general truth or thesis they state that VALIDATES or CHALLENGES our core bet — even when it is framed as a broad observation and not as advice aimed at us. If a well-informed operator independently arrives at the thesis our product is built on, that is a high-value insight, not small talk. Capture it.

Do NOT capture: pure facts about the attendee/their company, logistics, or generic pleasantries.

Transcript: "${transcript}"

An insight is worth recording ONLY if it passes ALL THREE bars:
1. ABOUT US — it informs how WE build, message, sell, or target, OR it confirms/challenges our thesis. Not merely a fact about them.
2. DURABLE — a lesson still useful weeks from now, not a one-off logistic.
3. SPECIFIC — it carries the concrete point or reason, not a vague platitude.

Tag each insight with:
- "category": exactly one of: ${INSIGHT_CATEGORY_KEYS.join(', ')}.
- "content": the insight as ONE crisp standalone sentence, written from our point of view.
- "quote": a short verbatim line from the transcript that supports it (for provenance).

Categories:
${insightCategoryPromptBlock()}

THESIS-VALIDATION is the most commonly missed category, so hunt for it explicitly. Whenever an attendee independently describes a structural problem, a market shift, or a "why now" that our product is built to solve — even in passing, even as their own philosophy rather than advice to us — that is a high-value insight. Do not skip it because it merely agrees with us; external validation of our bet is exactly what we want to capture. Illustrative pattern (NOT from this call, do not copy it — find the real equivalents in the transcript above): an operator saying "teams keep rebuilding the same customer context from scratch every quarter" would be a market insight validating a persistent-context product. Now find every such moment ACTUALLY present in this transcript and record it with its real quote.

Rules:
- Extract EVERY insight that clears all three bars — there is no target number. A thin call yields zero; a rich discovery call can yield several. When a statement is a genuine thesis/market/buyer signal, err toward capturing it rather than dropping it. NEVER pad, NEVER restate the same insight twice.
- Hard ceiling of 8 insights — a safety limit, not a goal.

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
