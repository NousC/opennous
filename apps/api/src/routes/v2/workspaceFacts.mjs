import { Router } from 'express';
import { getSupabaseClient, listNotes, saveNote, supersedeNote, deleteNote, getWorkspaceEntityId } from '@nous/core';

export const workspaceFactsV2Router = Router();

// Agent write-backs are observed/inferred, not directly typed by the user, so
// they're confident but not certain — they show as "inferred" until confirmed.
const WRITEBACK_CONFIDENCE = 0.9;

// The curated GTM context sections. The first six feed the ICP scoring model;
// the rest are agent-readable context only (never scored). Curated, not open,
// so the context stays a tidy one-pager instead of sprawling into 30 sections.
export const SCORING_SECTIONS = ['ICP', 'Market', 'Product', 'Pricing', 'Competitors', 'Positioning'];
export const CONTEXT_SECTIONS = ['GTM Motion', 'Notes'];
export const ALL_SECTIONS = [...SCORING_SECTIONS, ...CONTEXT_SECTIONS];

// Sections that ACCUMULATE (append a new entry each time) rather than evolve a
// single belief. "Notes" is a running log; everything else is one living doc.
const APPEND_SECTIONS = new Set(['Notes']);

// Section name → stable subject slot, e.g. "GTM Motion" → "gtm-motion".
const slugify = (s) => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Find the active fact a write-back should evolve. The agent passes a bare slot
// name ("pricing"); a playbook-created fact owns "playbook.pricing", so match
// either form so a write-back updates the existing belief instead of duplicating.
export function findSupersedable(active, subject) {
  if (!subject) return null;
  return (
    active.find(n => n.subject === subject) ||
    active.find(n => n.subject === `playbook.${subject}`) ||
    active.find(n => typeof n.subject === 'string' && n.subject.endsWith(`.${subject}`)) ||
    null
  );
}

// Write one GTM context section (evolve-or-append), shared by the POST /facts
// route and the ICP file-import endpoint. In "replace" mode the section evolves
// into a single living belief (old versions kept as history); in "append" mode
// it logs a new entry. `sourcePath` records the file this section was synced
// FROM (e.g. "context/icp.md"), persisted in note metadata so the write-back
// (export_icp_model) knows which file to update. If a later edit doesn't carry the
// path, it's preserved from the fact being superseded so provenance stays sticky.
export async function writeWorkspaceFact(supabase, workspaceId, opts = {}) {
  const { section, category, content, mode, subject, supersedes, confidence, source, sourcePath, syncedHash } = opts;
  const sectionName = String(section || category || 'Notes');
  const entityId = await getWorkspaceEntityId(supabase, workspaceId);
  if (!entityId) throw new Error('workspace_entity_not_found');

  const append = mode === 'append' || (mode == null && APPEND_SECTIONS.has(sectionName));
  const slug = subject ? String(subject) : (append ? undefined : slugify(sectionName));
  const conf = typeof confidence === 'number'
    ? Math.min(Math.max(confidence, 0), 1)
    : WRITEBACK_CONFIDENCE;

  // Replace mode collapses every active fact this section owns (the evolving
  // slot match PLUS legacy slotless facts in the same category) into one current
  // belief — otherwise they pile up beside the evolved one (the "replace just
  // appends" bug).
  let targetId = supersedes ? String(supersedes) : null;
  let extraVictims = [];
  let target = null;
  if (!append) {
    const active = await listNotes(supabase, workspaceId, { entityId, limit: 200 });
    const ownedBySection = active.filter(n =>
      n.id !== targetId && (
        (slug && (
          n.subject === slug ||
          n.subject === `playbook.${slug}` ||
          (typeof n.subject === 'string' && n.subject.endsWith(`.${slug}`))
        )) ||
        n.category === sectionName
      )
    );
    if (!targetId) targetId = ownedBySection.shift()?.id ?? null;
    extraVictims = ownedBySection.filter(n => n.id !== targetId);
    target = active.find(n => n.id === targetId) ?? null;
  }

  // Carry the source path forward when this write doesn't supply one, so a later
  // section write doesn't strip the file link recorded at import time.
  // Same for the synced content hash + model version (the drift baseline) — keep
  // them unless this write supersedes them.
  const carriedPath = sourcePath || target?.metadata?.source_path || null;
  const meta = {};
  if (carriedPath) meta.source_path = carriedPath;
  const carriedHash = syncedHash || target?.metadata?.synced_hash || null;
  if (carriedHash) meta.synced_hash = carriedHash;
  if (target?.metadata?.synced_model_version) meta.synced_model_version = target.metadata.synced_model_version;
  const metadata = Object.keys(meta).length ? meta : undefined;

  const params = {
    entityId,
    category: sectionName,
    content: String(content).trim(),
    source: source || 'agent',
    subject: slug,
    confidence: conf,
    ...(metadata ? { metadata } : {}),
  };

  const fact = targetId
    ? await supersedeNote(supabase, workspaceId, targetId, params)
    : await saveNote(supabase, workspaceId, params);

  for (const v of extraVictims) {
    await deleteNote(supabase, workspaceId, v.id);
  }

  return {
    fact,
    section: sectionName,
    mode: append ? 'append' : 'replace',
    superseded: Boolean(targetId),
    collapsed: extraVictims.length,
  };
}

// GET /v2/workspace/facts — workspace-level facts the workspace owner has
// explicitly recorded (ICP, target market, product, pricing, competitors,
// playbooks). These are NOT facts about individual people or companies;
// they're the workspace's own playbook.
//
// Query params:
//   categories — comma-separated list (e.g. "ICP,Market"). Omit for all.
//   limit      — max facts to return (default 50, max 500).
//
// Response:
//   {
//     facts:        [{ id, category, content, source, recorded_at }],
//     count:        number,
//     by_category:  { ICP: 2, Market: 1, ... }
//   }
//
// Read-only — to write a fact, use POST /v2/observations with a
// `note.<uuid>` property, or the workspace UI's Intelligence tab.
workspaceFactsV2Router.get('/', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;

    const workspaceEntityId = await getWorkspaceEntityId(supabase, workspaceId);
    if (!workspaceEntityId) {
      return res.json({ facts: [], count: 0, by_category: {} });
    }

    const rawCategories = typeof req.query.categories === 'string' ? req.query.categories : '';
    const categories = rawCategories
      .split(',')
      .map(c => c.trim())
      .filter(Boolean);

    const rawLimit = parseInt(String(req.query.limit ?? '50'), 10);
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 50, 1), 500);

    const notes = await listNotes(supabase, workspaceId, {
      entityId: workspaceEntityId,
      categories: categories.length ? categories : undefined,
      limit,
    });

    const facts = notes.map(n => ({
      id: n.id,
      category: n.category,
      content: n.content,
      source: n.source,
      confidence: n.confidence,
      // The file this section was synced from, if any (e.g. "context/icp.md").
      // Drives the UI's "synced from <file>" provenance + the write-back target.
      source_path: n.metadata?.source_path ?? null,
      // Reflect the last confirmation so "age" is honest — a reaffirmed fact is
      // fresh again even if it was first recorded long ago.
      recorded_at: n.reaffirmed_at || n.created_at,
    }));
    const by_category = {};
    for (const f of facts) by_category[f.category] = (by_category[f.category] || 0) + 1;

    return res.json({ facts, count: facts.length, by_category });
  } catch (err) {
    console.error('[GET /v2/workspace/facts]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /v2/workspace/facts — write-back. The agent keeps a SECTION of the GTM
// context current. A section is like a living file: in "replace" mode the new
// content evolves that section's belief (the old version is kept as history,
// never deleted); in "append" mode it adds an entry to a running log (Notes).
// The section name maps to a stable slot, so the agent never juggles ids.
//
// Body: { section, content, mode?, supersedes?, confidence? }
//   section    — one of ICP|Market|Product|Pricing|Competitors|Positioning|
//                "GTM Motion"|Notes  (category is accepted as a legacy alias)
//   content    — the section content (one short, current statement)
//   mode       — "replace" (default) evolves the section; "append" logs an entry
//                (default for Notes)
//   supersedes — explicit fact id to replace (overrides section matching)
//   confidence — 0–1; defaults to 0.9 for agent write-backs
workspaceFactsV2Router.post('/', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { section, category, content, mode, subject, supersedes, confidence, source_path } = req.body ?? {};

    if (!content || !String(content).trim()) {
      return res.status(400).json({ error: 'content required' });
    }

    const result = await writeWorkspaceFact(supabase, req.workspaceId, {
      section, category, content, mode, subject, supersedes, confidence, sourcePath: source_path,
    });
    return res.status(201).json(result);
  } catch (err) {
    if (String(err?.message) === 'workspace_entity_not_found') {
      return res.status(404).json({ error: 'workspace_entity_not_found' });
    }
    console.error('[POST /v2/workspace/facts]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
