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
  return `You are mining a sales/discovery call for insights about OUR OWN company — the side running the call (referred to as "we"/"us"/"our product"). This is the OPPOSITE of recording facts about the other attendees.

Capture ONLY things that teach us something about our own product, positioning, market, or buyer — advice they gave us, a gap they exposed, a market or wedge they revealed, a reframing of who buys and why. IGNORE everything that is purely a fact about the attendee or their company (that is captured elsewhere). If they were just describing their own situation with no lesson for us, skip it.

Transcript: "${transcript}"

An insight is worth recording ONLY if it passes ALL THREE bars:
1. ABOUT US — it changes how WE should build, message, sell, or target, not merely a fact about them.
2. DURABLE — a lesson still useful weeks from now, not a one-off logistic.
3. SPECIFIC — it carries the concrete point or reason, not a vague platitude.

Tag each insight with:
- "category": exactly one of: ${INSIGHT_CATEGORY_KEYS.join(', ')}.
- "content": the insight as ONE crisp standalone sentence, written from our point of view.
- "quote": a short verbatim line from the transcript that supports it (for provenance).

Categories:
${insightCategoryPromptBlock()}

Rules:
- Extract EVERY insight that clears all three bars — there is no target number. Most calls yield zero, one, or two. NEVER pad, NEVER restate the same insight twice.
- Hard ceiling of 6 insights — a safety limit, not a goal.

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
