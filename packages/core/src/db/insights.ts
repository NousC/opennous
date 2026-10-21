import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  INSIGHT_CATEGORIES, INSIGHT_CATEGORY_KEYS, insightCategoryLabel, insightCategoryPromptBlock, normalizeInsightCategory,
  normalizeTeamCategory, teamInsightCategoryLabel, HIDDEN_INSIGHT_STATUS_LIST,
} from './insightCategories.js';
import { detectIdentifier, resolveFocus } from './entities.js';
import { loadInternalSpeakers } from './insightBoard.js';

// The statuses an insight moves through. Product gaps run the full lane; softer
// categories (buyer/market, team learnings) use the lighter subset — the UI offers
// the right options per source, the DB just validates membership.
export const INSIGHT_STATUSES = ['new', 'tracked', 'roadmap', 'shipped', 'dismissed', 'acknowledged', 'addressed'] as const;
export type InsightStatus = (typeof INSIGHT_STATUSES)[number];
export type InsightSource = 'external' | 'team';

export interface InsightItem {
  id: string;
  workspace_id: string;
  source: InsightSource;
  category: string;
  statement: string;
  quote: string | null;
  speaker: string | null;
  speaker_id: string | null;
  occurred_at: string | null;
  /** Where it was said — `source://fireflies/<id>`. Selected all along; declaring it is
   *  what lets a caller count the distinct CONVERSATIONS behind a theme rather than the
   *  rows, which is the difference between a pattern and one talkative call. */
  source_ref: string | null;
  source_system: string | null;
  /** Set once the insight belongs to a theme; null means it is still in the pool. */
  theme_id?: string | null;
  status: InsightStatus;
  status_changed_at: string | null;
  created_at: string | null;
}

// One insight → one stable key per workspace, so re-running extraction over the same
// call never creates a second row. Same recipe the markdown dedup uses (leading stem),
// namespaced by source+category so the identical sentence in two lanes stays distinct.
//
// The call it came from is part of the key when we know it. Without it, the second account to
// say the same thing in the same words was dropped as a duplicate of the first, which erased
// exactly the repetition that makes something a pattern. Re-running extraction over one call
// still maps to one row, because that call's ref is the same both times.
//
// With no call behind it (an agent's insight, GET-970), the account stands in for the call: the
// same point heard from a second account is that account's, not a duplicate of the first.
export function insightItemDedupKey(source: string, category: string, statement: string, sourceRef?: string | null, accountId?: string | null): string {
  const stem = String(statement || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
  const ref = String(sourceRef || '').trim();
  const acct = String(accountId || '').trim();
  const key = ref ? `${source}|${category}|${stem}|${ref}` : acct ? `${source}|${category}|${stem}|acct:${acct}` : `${source}|${category}|${stem}`;
  return createHash('sha1').update(key).digest('hex');
}

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
  /** Resolved by a source adapter from checked evidence, never guessed by the model. */
  contactId?: string | null;
  companyId?: string | null;
  /** The person who said it, when known as an entity (an agent's person focus). */
  speakerId?: string | null;
  saidAt?: string | null;
  /** One of the INSIGHT_CATEGORY_KEYS. */
  category: string;
  /** The insight, as one crisp standalone sentence about US. */
  content: string;
  /** A short verbatim line from the transcript that supports it (provenance). */
  quote?: string | null;
  /** WHO said the quote — the external person's name. Provenance is a person + a
   *  date, not a channel-specific label like a meeting title (the same insight can
   *  come from a call, a chat, or an email). */
  speaker?: string | null;
}

// The one prompt both extractors share (the worker's auto-hook and the API's
// manual "extract" button), so the two never drift. Pass the external attendee
// names so the model can tell the prospect's words from our own, and the workspace's
// own context (who WE are) so it can tell an insight about US from the prospect merely
// describing THEIR own separate business.
export function buildInsightExtractionPrompt(
  transcript: string,
  opts: { attendees?: string[]; workspaceContext?: string | null; watchTopics?: string | null } = {},
): string {
  const names = (opts.attendees ?? []).filter(Boolean);
  const whoSaid = names.length
    ? `The EXTERNAL attendees — the prospect/customer side we are learning from — are: ${names.join(', ')}. Everyone else who speaks (e.g. "Theo", our own side) is US.`
    : `The transcript has two sides: the person hosting/selling (US) and the prospect/customer. Judge which speaker is the prospect from context.`;
  // WHO WE ARE — the anchor that lets the model tell "an insight about our GTM" from
  // "the prospect describing their own company's buyers/economics/product". Without it
  // the extractor files a prospect's own business facts as if they were ours.
  const ctx = (opts.workspaceContext || '').trim();
  const whoWeAre = ctx
    ? `WHO WE ARE — our own company, product, positioning, and buyer. This is the ONLY "us" an insight may be about:
"""
${ctx}
"""

`
    : '';
  const attributionRule = ctx
    ? `\nCRITICAL ATTRIBUTION RULE: the prospect very often runs their OWN business and will describe THEIR buyers, THEIR market, THEIR product, THEIR pricing, and THEIR economics. Those are facts about the prospect's company, NOT insights about us. An insight qualifies ONLY if it maps to OUR company as described in WHO WE ARE — how WE build/message/sell/target, or a thesis that validates or challenges OUR bet about OUR market. When the prospect is describing their own company's buyers/pricing/product/market, SKIP it, however interesting — unless the SAME point is also directly true of OUR business as defined above.`
    : '';
  return `You are mining a sales/discovery call for insights about OUR OWN company — product, positioning, market, or buyer. Read the WHOLE transcript first.

${whoWeAre}${whoSaid}

THE HARD RULE: an insight may ONLY be grounded in what an EXTERNAL attendee (the prospect) actually said. Our own side's statements are our existing opinions, not learnings — NEVER turn something WE said into an insight, and NEVER use one of our lines as the quote. If the prospect merely agreed ("yeah exactly") with a point WE made, that is not their insight; skip it unless they said something substantive in their own words. Every quote MUST be a verbatim line spoken by the prospect.
${attributionRule}

CAPTURE (only from the prospect's own words, and only when it is about US per WHO WE ARE):
- Advice they gave us — what WE should build, how WE should message, who WE should sell to.
- A gap, objection, or friction they exposed in what WE do.
- A market shift, wedge, segment, or channel they revealed about OUR market, incl. why-now observations.
- The underlying pain that makes someone buy OUR offer.
- A thesis they state that validates or challenges OUR core bet — capture it even when it just agrees with us; external validation is high-value. (Hunt for this — it is the most-missed kind. E.g. an operator independently saying teams keep rebuilding customer context from scratch would validate a persistent-context product.)

Do NOT capture: facts about the attendee/their company, the prospect's OWN buyers/market/economics, logistics, pleasantries, or anything only WE said.

Transcript: "${transcript}"

Each insight must pass ALL FOUR bars: (1) ABOUT US — informs how we build/message/sell/target, or confirms/challenges our thesis; (2) DURABLE — useful weeks from now; (3) SPECIFIC — names the concrete mechanism, reason, or number the prospect actually gave, NOT a generic product-spec restatement. Write "converting warm replies into booked meetings is the real bottleneck", never "the system should generate value" or "the tool should automate analysis"; (4) OURS NOT THEIRS — it maps to our company per WHO WE ARE, not to the prospect's own separate business.

Tag each with:
- "category": exactly one of: ${INSIGHT_CATEGORY_KEYS.join(', ')}.
- "content": ONE tight sentence stating what this means for US, MAX ~18 words. Assert it as a finding; hedge ("may", "might", "could", "often") ONLY when the prospect themselves hedged. No preamble, no product-spec voice.
- "quote": the single most telling fragment the PROSPECT said, verbatim, MAX ~20 words. Not our words.
- "speaker": the NAME of the person who said the quote (from the external attendees above). Just the name, no title. Use "" only if genuinely unknown.
- "kind": ONLY for a product insight — "bug" (something of ours is broken, wrong or slow), "request" (a capability they asked for that we do not have), "improvement" (a change to something we already have: its format, length, order, defaults), "praise" (something of ours they explicitly value). Leave it out for every other category.

FEEDBACK ON OUR PRODUCT BELONGS HERE. When the prospect reacts to something we built or sent them — a summary, a report, a PDF, the workspace, an email, a workflow — that is a product insight of the right kind, even when it is about one feature. ("The account summary is too long when it holds two-year-old history" → product, improvement.)

Categories:
${insightCategoryPromptBlock()}
${opts.watchTopics ? `\nALSO specifically watch for these topics the team asked us to track — capture any that come up and put each in the best category above:\n${opts.watchTopics}\n` : ''}
Rules:
- Extract every insight that clears all FOUR bars — no target number. A thin call yields zero; a rich one several. NEVER pad, NEVER restate the same insight twice.
- Keep content and quote SHORT. If it needs two sentences, it is not tight enough — cut it down.
- Hard ceiling of 8 insights.

Output ONLY the raw JSON array — no markdown code fences, no \`\`\`json, no reasoning or commentary before or after. Begin your reply with [ and end with ]:
[{"category":"<key>","content":"...","quote":"...","speaker":"...","kind":"<product only>"}]
If nothing meaningful: []`;
}

// The workspace's own GTM context, assembled from its foundations, so the insight
// extractor knows who "us" is. Prefers the ICP (which carries the buyer + positioning
// in the canonical template), then any positioning/product/company/market foundation.
// Returns null when the workspace has no meaningful self-context — the caller then
// SKIPS extraction rather than mining a call blind and misattributing the prospect's
// own business as ours.
const CONTEXT_KINDS = ['icp'];
const CONTEXT_BUDGET = 4000;

export async function loadWorkspaceContext(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('foundations')
    .select('kind, title, body_md')
    .eq('workspace_id', workspaceId)
    .in('kind', CONTEXT_KINDS);
  const rows = (data as { kind: string; title: string | null; body_md: string | null }[] | null) || [];
  if (!rows.length) return null;
  const byKind = new Map(rows.map(r => [r.kind, r]));
  const parts: string[] = [];
  let used = 0;
  for (const kind of CONTEXT_KINDS) {
    const r = byKind.get(kind);
    // Strip the Nous-managed learned block from the ICP — the human-authored half is
    // the identity signal; the learned coefficients are noise for this purpose.
    let body = (r?.body_md || '').replace(/<!--\s*nous:icp start[\s\S]*?nous:icp end\s*-->/gi, '').trim();
    if (!body || body.length < 40) continue;
    const remaining = CONTEXT_BUDGET - used;
    if (remaining <= 0) break;
    if (body.length > remaining) body = body.slice(0, remaining) + '…';
    const heading = (r?.title || kind).toUpperCase();
    parts.push(`## ${heading}\n${body}`);
    used += body.length;
  }
  const text = parts.join('\n\n').trim();
  // Guard: a stub ICP that is just the empty template scaffold is not real context.
  return text.length >= 80 ? text : null;
}

export interface InsightReadiness {
  /** Whether extraction runs on this workspace's calls and emails. */
  ready: boolean;
  reason: 'no_icp' | null;
  detail: string | null;
  /** Where to set it up: the app's Context settings, the MCP tool, the REST route. */
  fix: { app: string; mcp: string; api: string } | null;
}

/**
 * Why a workspace has no insights, when the answer is setup rather than silence. Extraction skips
 * every source until the workspace says who WE are (loadWorkspaceContext), so a new workspace saw
 * an empty page with no reason. Read live, so it is never stale: the moment an ICP is saved, ready.
 */
export async function insightReadiness(supabase: SupabaseClient, workspaceId: string): Promise<InsightReadiness> {
  const context = await loadWorkspaceContext(supabase, workspaceId).catch(() => null);
  if (context) return { ready: true, reason: null, detail: null, fix: null };
  return {
    ready: false,
    reason: 'no_icp',
    detail: 'Insights start once your ICP says who you sell to and what you sell. Until then calls and emails are not read for insights.',
    fix: { app: '/settings?section=context', mcp: 'set_icp', api: 'PUT /v2/icp' },
  };
}

/** Parse the model's JSON array of insights out of raw text. Tolerant of prose around it. */
export function parseInsightsJson(text: string): ExtractedInsight[] {
  try {
    const t = (text || '').trim();
    const s = t.indexOf('['), e = t.lastIndexOf(']');
    if (s === -1 || e === -1) return [];
    const arr = JSON.parse(t.slice(s, e + 1));
    if (!Array.isArray(arr)) return [];
    return arr.filter(x => x && typeof x.content === 'string' && typeof x.category === 'string').map(item => {
      // Entity IDs are assigned by a source adapter after checking authorship.
      // A model response must never supply them for this or another workspace.
      const { contactId: _contact, companyId: _company, saidAt: _saidAt, ...finding } = item;
      return finding;
    });
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
// ISO timestamp → "Jul 24, 2026". Provenance is a person + a date, never a
// channel-specific label (the same insight can come from a call, chat, or email).
function isoToDay(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function formatBullet(item: ExtractedInsight, opts: { occurredAt?: string | null } = {}): string {
  const quote = item.quote ? ` — "${item.quote.trim().replace(/\s+/g, ' ').slice(0, 240)}"` : '';
  const who = (item.speaker || '').trim();
  const day = isoToDay(opts.occurredAt);
  // Attribute to the person and the date — not the meeting title.
  const prov = [who, day].filter(Boolean).join(', ');
  const src = prov ? ` (${prov})` : '';
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
  opts: {
    sourceLabel?: string | null;
    occurredAt?: string | null;
    /** Where these were extracted FROM — `source://fireflies/<id>`. Carried onto every row so
     *  a quoted insight can reach the call it came out of. See NewInsightItem.source_ref. */
    sourceRef?: string | null;
    sourceSystem?: string | null;
    /** Conversation sources with edit/delete reconciliation use the structured store only. */
    structuredOnly?: boolean;
    strict?: boolean;
  } = {},
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
  const allRows: ExtractedInsight[] = [];
  for (const [cat, catItems] of byCat) {
    allRows.push(...catItems);
    if (opts.structuredOnly) continue;
    const existing = await getInsight(supabase, workspaceId, cat);
    const body = existing?.body_md ?? '';
    // Cheap dedup: skip an insight whose leading clause already appears verbatim.
    const seen = body.toLowerCase();
    const fresh = catItems.filter(it => {
      const stem = it.content.trim().toLowerCase().slice(0, 60);
      return stem.length > 0 && !seen.includes(stem);
    });
    if (fresh.length === 0) continue;

    const bullets = fresh.map(it => formatBullet(it, { occurredAt: opts.occurredAt })).join('\n');
    const nextBody = body.trim() ? `${body.trim()}\n${bullets}\n` : `${bullets}\n`;
    await upsertInsight(supabase, workspaceId, cat, nextBody);
    written += fresh.length;
  }
  // The markdown doc stays the Vault-editable mirror and keeps its own "already said" filter.
  // The structured store is what the Insights page counts, so it gets EVERY insight: the doc's
  // filter used to decide both, and a second account repeating a point never reached the page.
  // Its own dedup key (per call) keeps a re-run of the same call from doubling anything.
  const stored = await upsertInsightItems(supabase, workspaceId, allRows.map(it => ({
    source: 'external', category: normalizeInsightCategory(it.category) || it.category,
    statement: it.content, quote: it.quote ?? null, speaker: it.speaker ?? null,
    ...(it.contactId ? { contact_id: it.contactId } : {}),
    ...(it.companyId ? { company_id: it.companyId } : {}),
    ...(it.speakerId ? { speaker_id: it.speakerId } : {}),
    occurred_at: it.saidAt ?? opts.occurredAt ?? null,
    source_ref: opts.sourceRef ?? null,
    source_system: opts.sourceSystem ?? null,
    kind: normalizeInsightKind((it as { kind?: string }).kind),
  }))).catch(error => { if (opts.strict) throw error; return 0; });
  return Math.max(stored, written);
}

// ── Agent-written insights (GET-970) ─────────────────────────────────────────

export interface AgentInsightInput {
  category?: unknown; content?: unknown; quote?: unknown; speaker?: unknown;
  /** Who said it or which account it is about, when it differs from the request's focus. */
  focus?: unknown;
}
export type PreparedAgentInsights =
  | { ok: true; items: ExtractedInsight[]; sourceRef: string | null; sourceSystem: string | null; submitted: number }
  | { ok: false; status: number; error: string; detail: string; focus?: string };

type AgentFocus = { ok: true; contactId: string | null; companyId: string; names: string[] } | { ok: false; status: number; error: string; detail: string };

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * Tie insights an agent writes (POST /v2/insights, MCP record_insight, the in-app agent) to the
 * account they came from. A call's insights get their account from the call's attendees; an agent's
 * have no call behind them, so without a focus they reached no account and `GET /v2/insights`, which
 * lists account-tied insights only, never showed the agent what it wrote.
 *
 * `focus` is an identifier (entity id, email, domain, LinkedIn URL), never a bare name, and a read
 * never mints an entity. A person is the contact, and their one current company the account; a
 * company is the account. A focus with no account, on our own side, or out of the caller's sight
 * (`canSee`) is refused, since an insight there could never be read back or would count us as a
 * customer. A per-insight focus overrides the request's. Every insight needs one, or nothing is
 * written: a half-written batch is worse than a clear error.
 */
export async function prepareAgentInsights(
  supabase: SupabaseClient,
  workspaceId: string,
  body: { insights?: unknown; focus?: unknown; source_ref?: unknown },
  opts: { canSee?: (entityId: string) => Promise<boolean> } = {},
): Promise<PreparedAgentInsights> {
  const raw = Array.isArray(body.insights) ? (body.insights as AgentInsightInput[]) : [];
  const valid = raw.filter(i => i && typeof i.content === 'string' && i.content.trim().length >= 8);
  if (!valid.length) {
    return { ok: false, status: 400, error: 'no_valid_insights', detail: 'each insight needs a category and content (8+ characters)' };
  }
  const shared = text(body.focus);
  const resolved = new Map<string, AgentFocus>();
  let internal: Awaited<ReturnType<typeof loadInternalSpeakers>> | null = null;
  const items: ExtractedInsight[] = [];
  for (const i of valid) {
    const own = text(i.focus);
    const focus = own ?? shared;
    if (!focus) {
      return { ok: false, status: 400, error: 'focus_required', detail: 'name who said it or the account it is about: an email, domain, LinkedIn URL or entity id, on the request or on each insight' };
    }
    if (!detectIdentifier(focus)) {
      return { ok: false, status: 400, error: 'invalid_focus', focus, detail: 'provide an entity id, email, LinkedIn URL or domain, not a bare name' };
    }
    if (!resolved.has(focus)) {
      internal ??= await loadInternalSpeakers(supabase, workspaceId);
      resolved.set(focus, await insightAccountOf(supabase, workspaceId, focus, internal, opts.canSee));
    }
    const acct = resolved.get(focus)!;
    if (!acct.ok) return { ok: false, status: acct.status, error: acct.error, focus, detail: acct.detail };
    const speaker = text(i.speaker);
    items.push({
      category: String(i.category ?? ''),
      content: String(i.content).trim(),
      quote: text(i.quote),
      speaker,
      contactId: acct.contactId,
      companyId: acct.companyId,
      // The focus person is the speaker unless the insight credits someone else: a shared focus on
      // the champion must not claim the line said by "their CFO".
      speakerId: acct.contactId && (own || !speaker || acct.names.includes(speaker.toLowerCase())) ? acct.contactId : null,
    });
  }
  const sourceRef = text(body.source_ref);
  // A source:// ref names its system (source://fireflies/<id>); a git:// or other ref names none.
  const sourceSystem = /^source:\/\/([a-z0-9_-]+)\//i.exec(sourceRef ?? '')?.[1]?.toLowerCase() ?? null;
  return { ok: true, items, sourceRef, sourceSystem, submitted: raw.length };
}

const NOT_FOUND: AgentFocus = { ok: false, status: 404, error: 'focus_not_found', detail: 'no person or company in this workspace has that identifier' };

/** The live entity behind a merged one, or null when the chain ends nowhere. */
async function liveEntity(supabase: SupabaseClient, workspaceId: string, id: string): Promise<{ id: string; type: string } | null> {
  let cur: string | null = id;
  for (let hop = 0; cur && hop < 5; hop++) {
    const { data } = await supabase.from('entities').select('id, type, status, merged_into')
      .eq('workspace_id', workspaceId).eq('id', cur).maybeSingle();
    const e = data as { id: string; type: string; status: string; merged_into: string | null } | null;
    if (!e) return null;
    if (e.status !== 'merged') return { id: e.id, type: e.type };
    cur = e.merged_into;
  }
  return null;
}

/** A focus → the contact and company an insight is tied to, or why it can't be. */
async function insightAccountOf(
  supabase: SupabaseClient,
  workspaceId: string,
  focus: string,
  internal: { ids: Set<string>; emails: Set<string>; domains: Set<string> },
  canSee?: (entityId: string) => Promise<boolean>,
): Promise<AgentFocus> {
  const ours: AgentFocus = { ok: false, status: 400, error: 'focus_is_internal', detail: 'that is one of our own people or our own company; name the customer or prospect who said it' };
  const f = focus.trim().toLowerCase();
  if (internal.emails.has(f) || internal.domains.has(f.includes('@') ? f.split('@')[1] : f)) return ours;
  const r = await resolveFocus(supabase, workspaceId, focus);
  if (r.status !== 'resolved') return NOT_FOUND;
  const entity = await liveEntity(supabase, workspaceId, r.entity_id);
  if (!entity || (entity.type !== 'person' && entity.type !== 'company')) return NOT_FOUND;
  if (internal.ids.has(entity.id)) return ours;
  let contactId: string | null = null, companyId: string | null = null;
  const names: string[] = [];
  if (entity.type === 'company') companyId = entity.id;
  else {
    contactId = entity.id;
    const { data } = await supabase.from('relationships').select('to_entity_id')
      .eq('workspace_id', workspaceId).eq('type', 'works_at').is('valid_to', null)
      .eq('from_entity_id', entity.id).limit(10);
    const employers = [...new Set(((data as { to_entity_id: string }[] | null) ?? []).map(x => x.to_entity_id))];
    if (employers.length !== 1) {
      return { ok: false, status: 422, error: 'focus_has_no_account', detail: employers.length ? 'that person works at more than one company; focus the company (its domain) instead' : 'that person has no company on record; focus their company (its domain) instead' };
    }
    companyId = employers[0];
    const { data: cl } = await supabase.from('claims').select('property, value')
      .eq('workspace_id', workspaceId).eq('entity_id', entity.id).in('property', ['name', 'first_name', 'last_name']).is('invalid_at', null);
    const part = Object.fromEntries(((cl as { property: string; value: unknown }[] | null) ?? [])
      .filter(c => typeof c.value === 'string').map(c => [c.property, String(c.value).trim().toLowerCase()]));
    const full = part.name || [part.first_name, part.last_name].filter(Boolean).join(' ');
    for (const n of [full, part.first_name]) if (n) names.push(n);
  }
  if (internal.ids.has(companyId)) return ours;
  const { data: doms } = await supabase.from('entity_identifiers').select('value')
    .eq('workspace_id', workspaceId).eq('entity_id', companyId).eq('kind', 'domain').eq('status', 'active');
  if (((doms as { value: string }[] | null) ?? []).some(d => internal.domains.has(String(d.value).toLowerCase()))) return ours;
  // Out of sight reads as not found, so a member key learns nothing about accounts it can't see.
  if (canSee && !(await canSee(companyId))) return NOT_FOUND;
  return { ok: true, contactId, companyId, names };
}

// ── Structured store (insight_items) ─────────────────────────────────────────

const ITEM_COLS = 'id, workspace_id, source, category, statement, quote, speaker, speaker_id, occurred_at, source_ref, source_system, status, status_changed_at, created_at';
/** PostgREST stops at 1000 rows without saying so; every list here pages. */
const INSIGHT_PAGE = 1000;
/** `in` is a URL — keep the id list short enough to fit in one. */
const THEME_ID_BATCH = 50;

export interface NewInsightItem {
  contact_id?: string | null;
  company_id?: string | null;
  speaker_id?: string | null;
  source: InsightSource;
  category: string;
  statement: string;
  quote?: string | null;
  speaker?: string | null;
  occurred_at?: string | null;
  /**
   * Where the quote was said — `source://fireflies/<meeting_id>`, the same pointer shape
   * observations carry.
   *
   * ⚠️ Without this an insight is the richest evidence in the product and the least
   * checkable: the panel can show a reader the verbatim line and can never show them the
   * conversation it came out of. `source` does NOT stand in for it — that field holds
   * 'team' / 'external', which is who was talking, not where.
   */
  source_ref?: string | null;
  /** The system behind the ref (fireflies / gmail). Named separately so the panel can put a
   *  real logo on the row instead of labelling every insight "Team". */
  source_system?: string | null;
  /** For a product insight: bug, request, improvement or praise (GET-775). Null otherwise. */
  kind?: string | null;
}

/** What kind of product feedback an insight is (GET-775). A closed set; anything else is no kind. */
export const INSIGHT_KINDS = ['bug', 'request', 'improvement', 'praise'] as const;
export function normalizeInsightKind(input?: string | null): string | null {
  const k = String(input ?? '').trim().toLowerCase();
  if (!k) return null;
  if ((INSIGHT_KINDS as readonly string[]).includes(k)) return k;
  if (/request|feature|ask/.test(k)) return 'request';
  if (/bug|broken|error|slow/.test(k)) return 'bug';
  if (/improve|change|enhance/.test(k)) return 'improvement';
  if (/praise|love|positive/.test(k)) return 'praise';
  return null;
}

/**
 * Insert insight rows, one per distinct insight per workspace. Conflicts on the
 * dedup key are ignored, so re-running extraction over the same calls is a no-op.
 * Returns how many NEW rows landed.
 */
export async function upsertInsightItems(
  supabase: SupabaseClient,
  workspaceId: string,
  items: NewInsightItem[],
): Promise<number> {
  const rows = items
    .filter(it => it && typeof it.statement === 'string' && it.statement.trim().length >= 8)
    .map(it => {
      const statement = it.statement.trim();
      return {
        workspace_id: workspaceId,
        source: it.source,
        category: it.category,
        statement,
        quote: it.quote?.trim() || null,
        speaker: it.speaker?.trim() || null,
        ...(it.contact_id ? { contact_id: it.contact_id } : {}),
        ...(it.company_id ? { company_id: it.company_id } : {}),
        ...(it.speaker_id ? { speaker_id: it.speaker_id } : {}),
        occurred_at: it.occurred_at || null,
        source_ref: it.source_ref || null,
        source_system: it.source_system || null,
        dedup_key: insightItemDedupKey(it.source, it.category, statement, it.source_ref, it.company_id ?? it.contact_id),
        ...(normalizeInsightKind(it.kind) ? { kind: normalizeInsightKind(it.kind) } : {}),
      };
    });
  if (!rows.length) return 0;
  const write = (rs: Record<string, unknown>[]) => supabase
    .from('insight_items')
    .upsert(rs, { onConflict: 'workspace_id,dedup_key', ignoreDuplicates: true })
    .select('id');
  let { data, error } = await write(rows);
  // Before the `kind` column exists (migration 2026_10_08_insight_items_kind.sql), store the
  // insight without it rather than lose it: the kind is a label, the insight is the point.
  if (error && rows.some(r => 'kind' in r) && /kind/.test(String((error as { message?: string }).message ?? ''))) {
    ({ data, error } = await write(rows.map(({ kind: _k, ...r }) => r)));
  }
  if (error) throw error;
  return (data as { id: string }[] | null)?.length ?? 0;
}

/** All structured insights for a workspace, optionally one source. Newest first. */
export async function listInsightItems(
  supabase: SupabaseClient,
  workspaceId: string,
  opts: { source?: InsightSource } = {},
): Promise<InsightItem[]> {
  const out: InsightItem[] = [];
  // PostgREST stops at 1000 rows and does not say so. This read used to be a bare
  // select, so a workspace past a thousand insights silently lost the rest: a
  // workspace with well over a thousand had an Insights page — and a clusterer behind
  // it — that could only see 1,000. No error, no log line, hundreds of calls' worth of
  // learning simply absent. Page until the source runs out.
  for (let from = 0; ; from += INSIGHT_PAGE) {
    let q = supabase
      .from('insight_items')
      .select(ITEM_COLS)
      .eq('workspace_id', workspaceId).not('status', 'in', HIDDEN_INSIGHT_STATUS_LIST);
    if (opts.source) q = q.eq('source', opts.source);
    const { data, error } = await q
      .order('occurred_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      // id breaks ties, so a row can never sit on two pages or fall between them
      // when many insights share an occurred_at (a backfill stamps a whole call alike).
      .order('id', { ascending: true })
      .range(from, from + INSIGHT_PAGE - 1);
    if (error) throw error;
    const page = (data as InsightItem[]) || [];
    out.push(...page);
    if (page.length < INSIGHT_PAGE) break;
  }
  return out;
}

/** The insights not yet in any theme — the pool the nightly router works from. */
export async function listUnclusteredInsightItems(
  supabase: SupabaseClient,
  workspaceId: string,
  source: InsightSource,
  category?: string,
): Promise<InsightItem[]> {
  const out: InsightItem[] = [];
  for (let from = 0; ; from += INSIGHT_PAGE) {
    let q = supabase
      .from('insight_items')
      .select(ITEM_COLS)
      .eq('workspace_id', workspaceId)
      .not('status', 'in', HIDDEN_INSIGHT_STATUS_LIST)
      .eq('source', source)
      .is('theme_id', null);
    if (category) q = q.eq('category', category);
    const { data, error } = await q
      .order('occurred_at', { ascending: false, nullsFirst: false })
      .order('id', { ascending: true })
      .range(from, from + INSIGHT_PAGE - 1);
    if (error) throw error;
    const page = (data as InsightItem[]) || [];
    out.push(...page);
    if (page.length < INSIGHT_PAGE) break;
  }
  return out;
}

/** Every insight currently sitting in one of the given themes, keyed by theme id. */
export async function listInsightItemsByTheme(
  supabase: SupabaseClient,
  workspaceId: string,
  themeIds: string[],
): Promise<Map<string, InsightItem[]>> {
  const byTheme = new Map<string, InsightItem[]>();
  if (!themeIds.length) return byTheme;
  // `in` is a URL, and a long id list does not fit in one — same lesson as GET-329.
  for (let i = 0; i < themeIds.length; i += THEME_ID_BATCH) {
    const batch = themeIds.slice(i, i + THEME_ID_BATCH);
    for (let from = 0; ; from += INSIGHT_PAGE) {
      const { data, error } = await supabase
        .from('insight_items')
        .select(`${ITEM_COLS}, theme_id`)
        .eq('workspace_id', workspaceId)
        .not('status', 'in', HIDDEN_INSIGHT_STATUS_LIST)
        .in('theme_id', batch)
        .order('id', { ascending: true })
        .range(from, from + INSIGHT_PAGE - 1);
      if (error) throw error;
      const page = (data as (InsightItem & { theme_id: string })[]) || [];
      for (const row of page) {
        if (!byTheme.has(row.theme_id)) byTheme.set(row.theme_id, []);
        byTheme.get(row.theme_id)!.push(row);
      }
      if (page.length < INSIGHT_PAGE) break;
    }
  }
  return byTheme;
}

/** Move one insight to a new status (the "mark shipped" / triage action). */
export async function setInsightItemStatus(
  supabase: SupabaseClient,
  workspaceId: string,
  id: string,
  status: string,
  userId?: string | null,
): Promise<InsightItem | null> {
  if (!status || !String(status).trim()) throw new Error('invalid_status'); // vocabulary is category-specific, owned by the app
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('insight_items')
    .update({ status, status_changed_at: now, status_changed_by: userId ?? null, updated_at: now })
    .eq('workspace_id', workspaceId)
    .eq('id', id)
    .select('id, workspace_id, source, category, statement, quote, speaker, speaker_id, occurred_at, source_ref, source_system, status, status_changed_at, created_at')
    .maybeSingle();
  if (error) throw error;
  return (data as InsightItem) || null;
}

// ── Synthesis: insight_themes ────────────────────────────────────────────────
//
// Hundreds of raw insights are noise; the recurring patterns across them are the signal. A
// theme is one such pattern — a claim, a takeaway (what it means + what to do), the
// member insight ids, and a status you drive on the THEME instead of on every quote.

export interface InsightTheme {
  id: string;
  workspace_id: string;
  source: InsightSource;
  category: string | null;
  title: string;
  takeaway: string | null;
  item_ids: string[];
  item_count: number;
  /** Distinct conversations behind the theme. The honest measure of a pattern —
   *  item_count counts rows, and one chatty call can manufacture seventeen. */
  call_count: number;
  /** Distinct people who said it. */
  people_count: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
  retired_at: string | null;
  rank: number;
  build_key: string | null;
  status: InsightStatus;
  status_changed_at: string | null;
  created_at: string | null;
}

export interface NewInsightTheme {
  category?: string | null;
  title: string;
  takeaway?: string | null;
  item_ids: string[];
  rank?: number;
  status?: string;
}

const THEME_COLS = 'id, workspace_id, source, category, title, takeaway, item_ids, item_count, call_count, people_count, first_seen_at, last_seen_at, retired_at, rank, build_key, status, status_changed_at, created_at';

/** A stable key for the exact set of insights a synthesis was built from. */
export function themeBuildKey(itemIds: string[]): string {
  return createHash('sha1').update([...itemIds].sort().join(',')).digest('hex');
}

/**
 * A workspace's themes for one source, in importance order.
 *
 * Retired themes (every member routed elsewhere) are excluded by default. They are kept
 * rather than deleted so a reporting_insight_state row pointing at one still resolves to
 * something nameable in History — but they are not part of the live surface.
 */
export async function listInsightThemes(
  supabase: SupabaseClient,
  workspaceId: string,
  source: InsightSource,
  opts: { includeRetired?: boolean } = {},
): Promise<InsightTheme[]> {
  let q = supabase
    .from('insight_themes')
    .select(THEME_COLS)
    .eq('workspace_id', workspaceId)
    .eq('source', source);
  if (!opts.includeRetired) q = q.is('retired_at', null);
  const { data, error } = await q.order('rank', { ascending: true });
  if (error) throw error;
  return (data as InsightTheme[]) || [];
}

// ── Durable themes: open, route, refresh ─────────────────────────────────────
//
// What replaced replaceInsightThemes (deleted every theme on each rebuild, orphaning their status rows; removed). A theme is now a row that persists and accumulates:
// new insights are ROUTED into it, and it keeps its id — which is what reporting_insight_state
// (status + notes, keyed by that id) needs in order to survive a rebuild. It never did before.

/** Open new themes for one category. Insert-only — nothing existing is touched. */
export async function openInsightThemes(
  supabase: SupabaseClient,
  workspaceId: string,
  source: InsightSource,
  category: string,
  themes: { title: string; takeaway?: string | null }[],
): Promise<InsightTheme[]> {
  if (!themes.length) return [];
  const now = new Date().toISOString();
  const rows = themes.map(t => ({
    workspace_id: workspaceId,
    source,
    category,
    title: t.title.trim(),
    takeaway: t.takeaway?.trim() || null,
    item_ids: [] as string[],
    item_count: 0,
    rank: 0,
    status: 'new',
    updated_at: now,
  }));
  const { data, error } = await supabase.from('insight_themes').insert(rows).select(THEME_COLS);
  if (error) throw error;
  return (data as InsightTheme[]) || [];
}

/** Put insights into a theme. The single write that changes membership. */
export async function assignInsightsToTheme(
  supabase: SupabaseClient,
  workspaceId: string,
  themeId: string,
  itemIds: string[],
): Promise<number> {
  if (!itemIds.length) return 0;
  let moved = 0;
  for (let i = 0; i < itemIds.length; i += THEME_ID_BATCH) {
    const batch = itemIds.slice(i, i + THEME_ID_BATCH);
    const { data, error } = await supabase
      .from('insight_items')
      .update({ theme_id: themeId, updated_at: new Date().toISOString() })
      .eq('workspace_id', workspaceId)
      .in('id', batch)
      .select('id');
    if (error) throw error;
    moved += (data as { id: string }[] | null)?.length ?? 0;
  }
  return moved;
}

/**
 * Recompute a theme's aggregates from its actual members, and rank the category.
 *
 * item_ids is rewritten here too — it is a mirror of theme_id, derived in the same pass
 * from the same query, never edited independently.
 *
 * A theme that ends up with no members is RETIRED, not deleted: deleting is what broke
 * every status row in the first place.
 */
export async function refreshThemeAggregates(
  supabase: SupabaseClient,
  workspaceId: string,
  source: InsightSource,
  category: string,
): Promise<InsightTheme[]> {
  const themes = await listInsightThemes(supabase, workspaceId, source, { includeRetired: true });
  const inCat = themes.filter(t => t.category === category);
  if (!inCat.length) return [];
  const members = await listInsightItemsByTheme(supabase, workspaceId, inCat.map(t => t.id));
  const now = new Date().toISOString();

  const computed = inCat.map(t => {
    const items = members.get(t.id) || [];
    const dates = items.map(i => i.occurred_at).filter(Boolean).sort() as string[];
    // A call is the provenance pointer the insight was extracted from. When it is missing
    // (older rows predate source_ref), the day stands in — two insights from the same day
    // are far more likely to be one conversation than two, so this under-counts rather
    // than inflating, which is the safe direction for a "this is a real pattern" gate.
    const calls = new Set(items.map(i => i.source_ref || (i.occurred_at || '').slice(0, 10)).filter(Boolean));
    const people = new Set(items.map(i => i.speaker_id || (i.speaker || '').toLowerCase().trim()).filter(Boolean));
    return {
      theme: t,
      items,
      patch: {
        item_ids: items.map(i => i.id),
        item_count: items.length,
        call_count: calls.size,
        people_count: people.size,
        first_seen_at: dates[0] || null,
        last_seen_at: dates[dates.length - 1] || null,
        retired_at: items.length === 0 ? (t.retired_at || now) : null,
        updated_at: now,
      },
    };
  });

  // Rank the live ones: how many separate conversations raised it, then how many people,
  // then recency. Mentions deliberately do NOT lead — that is the number a single
  // talkative call inflates.
  const live = computed.filter(c => c.patch.item_count > 0);
  live.sort((a, b) =>
    b.patch.call_count - a.patch.call_count ||
    b.patch.people_count - a.patch.people_count ||
    (b.patch.last_seen_at || '').localeCompare(a.patch.last_seen_at || ''));
  const rankById = new Map(live.map((c, i) => [c.theme.id, i]));

  const out: InsightTheme[] = [];
  for (const c of computed) {
    const { data, error } = await supabase
      .from('insight_themes')
      .update({ ...c.patch, rank: rankById.get(c.theme.id) ?? 999 })
      .eq('workspace_id', workspaceId)
      .eq('id', c.theme.id)
      .select(THEME_COLS)
      .maybeSingle();
    if (error) throw error;
    if (data) out.push(data as InsightTheme);
  }
  return out.filter(t => !t.retired_at);
}

/**
 * Hand every insight in one category back to the unclustered pool and retire that
 * category's themes.
 *
 * This is the ONE-TIME bootstrap onto the new engine, not a routine operation. Themes
 * built before 2026-09-20 came out of a single cross-category pass under a shared budget
 * of 12, so a category could hold one theme for dozens of insights across many calls while
 * another held five. Those are not salvageable by routing — they have to be clustered again, once,
 * per category. After that the engine routes and never rebuilds.
 *
 * The old themes are retired rather than deleted, so any reporting_insight_state row
 * pointing at one still resolves to a title in History instead of becoming a dangling id.
 */
export async function releaseInsightsFromThemes(
  supabase: SupabaseClient,
  workspaceId: string,
  source: InsightSource,
  category: string,
): Promise<number> {
  const themes = await listInsightThemes(supabase, workspaceId, source, { includeRetired: true });
  const ids = themes.filter(t => t.category === category && !t.retired_at).map(t => t.id);
  if (!ids.length) return 0;
  const now = new Date().toISOString();
  let released = 0;
  for (let i = 0; i < ids.length; i += THEME_ID_BATCH) {
    const batch = ids.slice(i, i + THEME_ID_BATCH);
    const { data, error } = await supabase
      .from('insight_items')
      .update({ theme_id: null, updated_at: now })
      .eq('workspace_id', workspaceId)
      .in('theme_id', batch)
      .select('id');
    if (error) throw error;
    released += (data as { id: string }[] | null)?.length ?? 0;
    const { error: rErr } = await supabase
      .from('insight_themes')
      .update({ retired_at: now, item_ids: [], item_count: 0, call_count: 0, people_count: 0, updated_at: now })
      .eq('workspace_id', workspaceId)
      .in('id', batch);
    if (rErr) throw rErr;
  }
  return released;
}

// ── The clustering prompts ───────────────────────────────────────────────────
//
// Three passes, all scoped to ONE category. Clustering used to run across all four at
// once under a single budget of 12, so whichever category the model found most
// interesting ate the budget: one workspace's Market tab held dozens of insights from
// many separate calls collapsed into ONE card, while Product got five. The model was
// also free to re-label a theme's category, overriding the value the extractor had
// already validated against the controlled taxonomy — which is how "personalized video
// outperforms generic AI messaging" ended up filed under Product.
//
// Now the category is an input, not an output.

/** How many themes one category may hold. Below this the tab is thin; above it, a wall. */
export const THEMES_PER_CATEGORY = 9;
/** Statements per clustering prompt. A category of several hundred insights is chunked, then merged. */
export const CLUSTER_CHUNK = 120;

/** Pass 1 — route new insights into the themes that already exist. */
export function buildThemeRoutingPrompt(
  themes: { title: string; takeaway: string | null }[],
  statements: string[],
): string {
  const themeList = themes.map((t, i) => `${i}. ${t.title}${t.takeaway ? ` — ${t.takeaway}` : ''}`).join('\n');
  const items = statements.map((s, i) => `${i}. ${s}`).join('\n');
  return `Below are existing THEMES a company has already identified, and NEW insights from recent calls.

Assign each new insight to the theme it genuinely belongs to. Be strict: only assign when the insight is really another instance of that same pattern. If it is a different point, or a new idea the themes do not cover, answer -1 — a new theme will be opened for it later. Forcing a new signal into a nearby theme is the one mistake that matters here, because it hides the thing that was new.

Themes:
${themeList}

New insights:
${items}

Output ONLY JSON, one entry per insight index: [{"i":0,"t":2},{"i":1,"t":-1}]`;
}

/** Pass 2 — open new themes from what fit nowhere. One category at a time. */
export function buildThemeClusterPrompt(
  categoryLabel: string,
  kind: string,
  statements: string[],
  budget: number,
): string {
  const items = statements.map((s, i) => `${i}. ${s}`).join('\n');
  return `Below are ${statements.length} "${categoryLabel}" insights mined from ${kind} calls. Cluster them into AT MOST ${budget} recurring THEMES (fewer is better).

Each theme:
- "title": the pattern as a short claim, 6-10 words. Concrete and specific — not a category name, not a restatement of "${categoryLabel}".
- "takeaway": ONE directive sentence — what this means for us and what we should DO.
- "items": the insight indices belonging to it.

RULES: merge small patterns into the nearest broader one. A theme needs at least 2 insights. Leave a genuine one-off OUT rather than padding a theme with it — unassigned insights are kept and shown separately, so nothing is lost by omitting them. Most-important first.

Insights:
${items}

Output ONLY a JSON array:
[{"title":"...","takeaway":"...","items":[0,3,7]}]`;
}

/** Pass 3 — only when a category was chunked: fold the per-chunk candidates together. */
export function buildThemeMergePrompt(titles: string[], budget: number): string {
  const list = titles.map((t, i) => `${i}. ${t}`).join('\n');
  return `These candidate themes were produced from separate batches of the same insight set, so several describe the same pattern in different words.

Merge them into AT MOST ${budget} final themes. Each final theme gets a title (6-10 words, a concrete claim), a takeaway (one directive sentence), and the list of candidate numbers it absorbs. Every candidate must appear in exactly one final theme.

Candidates:
${list}

Output ONLY JSON:
[{"title":"...","takeaway":"...","merges":[0,4,7]}]`;
}

/** Tolerant JSON-array read, shared by all three passes. */
export function parseThemeJson<T = unknown>(text: string): T[] {
  try {
    const t = String(text || '');
    const s = t.indexOf('['), e = t.lastIndexOf(']');
    if (s === -1 || e === -1) return [];
    const arr = JSON.parse(t.slice(s, e + 1));
    return Array.isArray(arr) ? (arr as T[]) : [];
  } catch {
    return [];
  }
}

/** Move one theme to a new status (the "mark shipped" action, on the theme). */
export async function setInsightThemeStatus(
  supabase: SupabaseClient,
  workspaceId: string,
  id: string,
  status: string,
  userId?: string | null,
): Promise<InsightTheme | null> {
  if (!status || !String(status).trim()) throw new Error('invalid_status'); // vocabulary is category-specific, owned by the app
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('insight_themes')
    .update({ status, status_changed_at: now, status_changed_by: userId ?? null, updated_at: now })
    .eq('workspace_id', workspaceId)
    .eq('id', id)
    .select(THEME_COLS)
    .maybeSingle();
  if (error) throw error;
  return (data as InsightTheme) || null;
}

// ── Insight extraction topics (Settings → Insights) ──────────────────────────
//
// The watch-topics that steer extraction, per (source, category). Defaults mirror the
// hardcoded taxonomy and are locked (is_default, undeletable); a workspace can add its
// own keywords to track, which then get woven into the extractor prompt going forward.

export interface InsightTopic {
  id: string;
  workspace_id: string;
  source: InsightSource;
  category: string;
  keyword: string;
  description: string | null;
  enabled: boolean;
  is_default: boolean;
}

// The seed set — what we already extract today, shown as locked defaults in Settings.
export const DEFAULT_INSIGHT_TOPICS: { source: InsightSource; category: string; keyword: string }[] = [
  { source: 'external', category: 'product', keyword: 'Missing feature or capability' },
  { source: 'external', category: 'product', keyword: 'Product friction' },
  { source: 'external', category: 'product', keyword: 'Feature request or idea' },
  { source: 'external', category: 'market', keyword: 'Segment or wedge' },
  { source: 'external', category: 'market', keyword: 'Channel to reach demand' },
  { source: 'external', category: 'market', keyword: 'Competitor dynamic' },
  { source: 'external', category: 'buyer', keyword: 'ICP / who buys' },
  { source: 'external', category: 'buyer', keyword: 'Buying pain' },
  { source: 'external', category: 'buyer', keyword: 'Trigger to act' },
  { source: 'external', category: 'positioning', keyword: 'What messaging lands' },
  { source: 'external', category: 'positioning', keyword: 'What confuses people' },
  { source: 'team', category: 'decisions', keyword: 'Direction or priority' },
  { source: 'team', category: 'decisions', keyword: 'Pricing' },
  { source: 'team', category: 'decisions', keyword: 'Scope or ownership' },
  { source: 'team', category: 'blockers', keyword: 'Dependency or risk' },
  { source: 'team', category: 'blockers', keyword: 'What is stuck' },
  { source: 'team', category: 'learnings', keyword: 'Process learning' },
  { source: 'team', category: 'learnings', keyword: 'Technical fix' },
  { source: 'team', category: 'learnings', keyword: 'Strategic realization' },
];

const TOPIC_COLS = 'id, workspace_id, source, category, keyword, description, enabled, is_default';

/** Ensure a workspace has the default topics seeded (idempotent; run before listing). */
export async function ensureDefaultTopics(supabase: SupabaseClient, workspaceId: string): Promise<void> {
  const rows = DEFAULT_INSIGHT_TOPICS.map(t => ({ workspace_id: workspaceId, source: t.source, category: t.category, keyword: t.keyword, is_default: true, enabled: true }));
  await supabase.from('insight_topics').upsert(rows, { onConflict: 'workspace_id,source,category,keyword', ignoreDuplicates: true });
}

export async function listInsightTopics(supabase: SupabaseClient, workspaceId: string, source?: InsightSource): Promise<InsightTopic[]> {
  let q = supabase.from('insight_topics').select(TOPIC_COLS).eq('workspace_id', workspaceId);
  if (source) q = q.eq('source', source);
  const { data, error } = await q.order('source').order('category').order('is_default', { ascending: false }).order('keyword');
  if (error) throw error;
  return (data as InsightTopic[]) || [];
}

export async function addInsightTopic(supabase: SupabaseClient, workspaceId: string, t: { source: InsightSource; category: string; keyword: string; description?: string | null }): Promise<InsightTopic | null> {
  const keyword = (t.keyword || '').trim();
  if (!keyword) throw new Error('keyword_required');
  const { data, error } = await supabase.from('insight_topics')
    .upsert({ workspace_id: workspaceId, source: t.source, category: t.category, keyword, description: t.description ?? null, is_default: false, enabled: true }, { onConflict: 'workspace_id,source,category,keyword' })
    .select(TOPIC_COLS).maybeSingle();
  if (error) throw error;
  return (data as InsightTopic) || null;
}

export async function updateInsightTopic(supabase: SupabaseClient, workspaceId: string, id: string, patch: { enabled?: boolean; description?: string | null }): Promise<InsightTopic | null> {
  const upd: Record<string, unknown> = {};
  if (typeof patch.enabled === 'boolean') upd.enabled = patch.enabled;
  if ('description' in patch) upd.description = patch.description ?? null;
  if (!Object.keys(upd).length) return null;
  const { data, error } = await supabase.from('insight_topics').update(upd).eq('workspace_id', workspaceId).eq('id', id).select(TOPIC_COLS).maybeSingle();
  if (error) throw error;
  return (data as InsightTopic) || null;
}

/** Delete a topic — defaults are locked and cannot be removed. */
export async function deleteInsightTopic(supabase: SupabaseClient, workspaceId: string, id: string): Promise<boolean> {
  const { data, error } = await supabase.from('insight_topics').delete().eq('workspace_id', workspaceId).eq('id', id).eq('is_default', false).select('id');
  if (error) throw error;
  return !!(data && data.length);
}

/** Format a workspace's enabled topics into the "watch for" block for the extractor prompt. */
export function formatWatchTopics(topics: InsightTopic[], source: InsightSource): string | null {
  const enabled = topics.filter(t => t.source === source && t.enabled);
  if (!enabled.length) return null;
  const byCat = new Map<string, string[]>();
  // A topic added in Settings has no category ('general'): it is a keyword to watch for in any of
  // them. Printed under its raw key it read as a category, and an insight the model filed there was
  // dropped as unknown.
  const normalize = source === 'team' ? normalizeTeamCategory : normalizeInsightCategory;
  for (const t of enabled) {
    const cat = normalize(t.category) ?? '';
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat)!.push(t.keyword);
  }
  const labelFn = source === 'team' ? teamInsightCategoryLabel : insightCategoryLabel;
  return [...byCat.entries()].map(([cat, kws]) => `- ${cat ? labelFn(cat) : 'Any category'}: ${kws.join(', ')}`).join('\n');
}

export { INSIGHT_CATEGORIES, INSIGHT_CATEGORY_KEYS, insightCategoryLabel };
