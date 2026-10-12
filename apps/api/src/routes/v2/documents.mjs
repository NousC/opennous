// /v2/documents — the documents already written in a workspace, for agents on the key
// (GET-197). Backs the MCP `documents` and `read_document` tools, so the plugin reads the same
// Docs the operator browses and the in-app agent reads — one store, one read path.
//
// Reads, and ONE write: POST, the path the revenue plugin files a finished document through
// (GET-204). The in-app agent writes through present_document; both land in writeDocument.

import { Router } from 'express';
import {
  getSupabaseClient, resolveFocus, listDocuments, getDocument, searchDocuments, labelEntities,
  documentRef, sectionText, sectionsFromMarkdown, systemLabel, writeDocument, DOCUMENT_KINDS,
} from '@nous/core';
import { viewerVisibleAccountSet, entityVisibleToMember } from '../../lib/visibility.mjs';
import { sanitizeBlocks, asText, BLOCK_TYPES } from '../../lib/reportBlocks.mjs';

export const documentsV2Router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function visibility(supabase, req) {
  const viewerId = req.memberUserId ?? req.internalUserId ?? null;
  const set = await viewerVisibleAccountSet(supabase, req.workspaceId, viewerId, { isAdmin: req.viewerScope === 'admin' });
  return set.unrestricted ? () => true : (id) => set.ids.has(id);
}

const summary = (d, labels) => ({
  document_id: d.id,
  ref: documentRef(d.id),
  kind: d.kind,
  title: d.title,
  headline: d.headline,
  about: d.subject_entity_id ? labels.get(d.subject_entity_id)?.name ?? null : null,
  about_entity_id: d.subject_entity_id,
  // Enough to draw the thing's own face (GET-426). A feed row headed by the account's logo
  // reads as that account's; a generic glyph reads as ours. labelEntities already has both.
  about_type: d.subject_entity_id ? labels.get(d.subject_entity_id)?.type ?? null : null,
  about_domain: d.subject_entity_id ? labels.get(d.subject_entity_id)?.domain ?? null : null,
  about_photo: d.subject_entity_id ? labels.get(d.subject_entity_id)?.photo_url ?? null : null,
  series: d.series,
  cadence: d.cadence,
  period: d.period_start ? { start: d.period_start.slice(0, 10), end: d.period_end?.slice(0, 10) ?? null } : null,
  written: d.created_at,
  version: d.version,
  ...(d.status !== 'live' ? { replaced: true } : {}),
});

// GET /v2/documents?q=&kind=&focus=&series=&cadence=&since=&until=&limit=
// With `q`: passages that match, best first. Without: the list, newest first.
documentsV2Router.get('/', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const visible = await visibility(supabase, req);

    let subjectIds;
    if (req.query.focus) {
      const r = await resolveFocus(supabase, workspaceId, String(req.query.focus));
      if (r.status === 'not_found') return res.status(404).json({ error: 'entity_not_found' });
      if (r.status === 'ambiguous') return res.json({ status: 'ambiguous', candidates: r.candidates });
      if (!visible(r.entity_id)) return res.status(404).json({ error: 'entity_not_found' });
      subjectIds = [r.entity_id];
    }
    const kind = DOCUMENT_KINDS.includes(String(req.query.kind)) ? [String(req.query.kind)] : undefined;
    const limit = Math.min(Number(req.query.limit) || 20, 50);

    if (req.query.q) {
      const hits = (await searchDocuments(supabase, workspaceId, String(req.query.q), { limit, kinds: kind, subjectEntityIds: subjectIds }))
        .filter(h => !h.document.subject_entity_id || visible(h.document.subject_entity_id));
      const labels = await labelEntities(supabase, workspaceId, hits.map(h => h.document.subject_entity_id).filter(Boolean));
      return res.json({
        results: hits.map(h => ({ ...summary(h.document, labels), ref: h.ref, section: h.section_index, heading: h.heading, passage: h.snippet })),
      });
    }

    const docs = (await listDocuments(supabase, workspaceId, {
      kinds: kind,
      subjectEntityIds: subjectIds,
      series: req.query.series ? String(req.query.series) : null,
      cadence: req.query.cadence ? String(req.query.cadence) : null,
      since: req.query.since ? String(req.query.since) : null,
      until: req.query.until ? String(req.query.until) : null,
      includeSuperseded: req.query.include_old_versions === 'true',
      limit,
    })).filter(d => !d.subject_entity_id || visible(d.subject_entity_id));
    const labels = await labelEntities(supabase, workspaceId, docs.map(d => d.subject_entity_id).filter(Boolean));
    return res.json({ documents: docs.map(d => summary(d, labels)) });
  } catch (err) {
    console.error('[GET /v2/documents]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /v2/documents/:id?section=&find= — one document: the whole thing, one section, or the
// passages around a phrase; plus what it cited, what it links to, and its versions.
documentsV2Router.get('/:id', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
    const detail = await getDocument(supabase, req.workspaceId, req.params.id);
    if (!detail) return res.status(404).json({ error: 'not_found' });
    const visible = await visibility(supabase, req);
    const doc = detail.document;
    if (doc.subject_entity_id && !visible(doc.subject_entity_id)) return res.status(404).json({ error: 'not_found' });

    const sectionIdx = req.query.section != null && req.query.section !== '' ? Number(req.query.section) : null;
    const section = Number.isInteger(sectionIdx) ? doc.sections[sectionIdx] : null;
    const find = String(req.query.find ?? '').trim().toLowerCase();
    const body = doc.body_md ?? '';
    let passages = null;
    if (find) {
      const lines = body.split('\n');
      passages = [];
      for (let i = 0; i < lines.length && passages.length < 8; i++) {
        if (lines[i].toLowerCase().includes(find)) passages.push(lines.slice(Math.max(0, i - 2), i + 3).join('\n'));
      }
    }
    // detail.subject comes from labelEntities, which now carries the account's domain, so the
    // reading page's chip wears the same logo the feed row does with no second lookup.
    const labels = new Map(detail.subject ? [[detail.subject.id, detail.subject]] : []);

    return res.json({
      ...summary(doc, labels),
      sections: doc.sections.map((s, i) => ({ index: i, label: s.label })),
      ...(passages
        ? { find, passages }
        : section
          ? { section: { index: sectionIdx, label: section.label }, content: sectionText(section) }
          : { content: body.slice(0, 40000), ...(body.length > 40000 ? { truncated: true } : {}) }),
      sources: detail.sources.filter(s => s.cited).map(s => ({
        ref: s.ref, system: s.system, detail: s.detail, when: s.occurred_at, quote: s.quote, speaker: s.speaker,
        sections: s.section_indexes,
      })),
      mentions: detail.mentions.filter(m => visible(m.id)).map(m => ({ entity_id: m.id, name: m.name })),
      links_to: detail.outgoing.map(d => ({ document_id: d.id, title: d.title })),
      linked_from: detail.backlinks.map(d => ({ document_id: d.id, title: d.title })),
      versions: detail.versions,
    });
  } catch (err) {
    console.error('[GET /v2/documents/:id]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /v2/documents — file a finished document into Pages (GET-204).
//
// The revenue plugin used to leave its briefs and reports in the chat, or in the operator's
// repo, where nothing else could find them. This files them where the app's own documents live:
// the same tree, versions, Evidence and agent retrieval.
//
// Body: {
//   kind:     brief | plan | report | meeting_brief | objection_prep | call
//   account?: email / domain / LinkedIn URL / entity id / name — required unless kind is report
//   title?:   a report's name, or a meeting brief's meeting; a brief or plan is named by its account
//   headline?, generated_from?: string[], skill?, period?: { start, end }
//   markdown? — the document as markdown, split into sections on its `##` headings; or
//   sections? — [{ label, body?, blocks? }] (blocks: the report vocabulary, reports only)
//   sources?  — [{ ref, system?, detail?, when?, quote?, speaker? }], cited in the text as
//               [1], [2], … in this order. `ref` is the source_ref the tools returned.
// }
const DOC_LABEL = { brief: 'Brief', plan: 'Plan', report: 'Report', meeting_brief: 'Meeting brief', objection_prep: 'Objection prep', call: 'Call' };
const REPORT_ONLY_BLOCKS = new Set(['metrics', 'chart']);

documentsV2Router.post('/', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const b = req.body ?? {};
    const kind = String(b.kind ?? '').trim();
    if (!DOCUMENT_KINDS.includes(kind)) {
      return res.status(400).json({ error: 'invalid_kind', allowed: DOCUMENT_KINDS });
    }

    // The document itself: sections with blocks, or markdown split on its headings.
    const allow = kind === 'report' ? BLOCK_TYPES : new Set([...BLOCK_TYPES].filter(t => !REPORT_ONLY_BLOCKS.has(t)));
    let sections = Array.isArray(b.sections)
      ? b.sections.map(x => {
          if (!x || typeof x !== 'object') return null;
          const label = String(x.label ?? x.heading ?? x.title ?? '').trim();
          const body = asText(x.body ?? x.content ?? x.text);
          const blocks = sanitizeBlocks(x.blocks, { allow });
          if (!label || (!body && !blocks.length)) return null;
          return { label, ...(body ? { body } : {}), ...(blocks.length ? { blocks } : {}) };
        }).filter(Boolean)
      : sectionsFromMarkdown(String(b.markdown ?? ''));
    sections = sections.slice(0, 20);
    if (!sections.length) {
      return res.status(400).json({
        error: 'empty_document',
        message: 'Pass `markdown` (sections split on ## headings) or `sections: [{label, body}]`.',
      });
    }

    // What it is about. A brief or plan without an account is not filed as one.
    let subjectEntityId = null;
    let subjectName = null;
    if (b.account) {
      const r = await resolveFocus(supabase, workspaceId, String(b.account));
      if (r.status === 'ambiguous') return res.json({ status: 'ambiguous', candidates: r.candidates });
      if (r.status === 'not_found') {
        if (kind !== 'report') return res.status(404).json({ error: 'account_not_found', account: b.account });
      } else {
        const viewerId = req.memberUserId ?? req.internalUserId ?? null;
        if (!(await entityVisibleToMember(supabase, workspaceId, viewerId, r.entity_id, { isAdmin: req.viewerScope === 'admin' }))) {
          return res.status(404).json({ error: 'account_not_found', account: b.account });
        }
        subjectEntityId = r.entity_id;
        subjectName = (await labelEntities(supabase, workspaceId, [r.entity_id])).get(r.entity_id)?.name ?? r.name ?? null;
      }
    } else if (kind !== 'report') {
      return res.status(400).json({ error: 'account_required', message: `A ${kind.replace('_', ' ')} is about one account: pass \`account\`.` });
    }

    // A meeting brief is named by its MEETING (GET-231), the way it is looked for afterwards.
    const meetingTitle = kind === 'meeting_brief' ? String(b.title ?? '').trim() : '';
    const title = meetingTitle ? meetingTitle
      : kind !== 'report' && subjectName
      ? `${DOC_LABEL[kind]} — ${subjectName}`
      : (String(b.title ?? '').trim()
        || /^#\s+(.+)$/m.exec(String(b.markdown ?? ''))?.[1]?.trim()
        || (subjectName ? `${DOC_LABEL[kind]} — ${subjectName}` : DOC_LABEL[kind]));

    const day = (v) => (Number.isFinite(Date.parse(String(v ?? ''))) ? new Date(String(v)).toISOString() : null);
    const period = kind === 'report' && b.period && typeof b.period === 'object'
      ? { start: day(b.period.start), end: day(b.period.end) }
      : null;

    // Sources, in the order the text numbers them. The system is read from the ref when the
    // caller did not name it — `source://fireflies/…` is a Fireflies call.
    const sources = (Array.isArray(b.sources) ? b.sources : [])
      .map(x => (typeof x === 'string' ? { ref: x } : x))
      .filter(x => x && typeof x.ref === 'string' && x.ref.trim())
      .slice(0, 100)
      .map(x => {
        const fromRef = /^source:\/\/([a-z0-9_]+)\//i.exec(x.ref)?.[1] ?? (x.ref.startsWith('nous://') ? 'nous' : null);
        return {
          ref: x.ref.trim(),
          system: x.system ? String(x.system) : systemLabel(fromRef),
          detail: x.detail ?? null, when: x.when ?? null, quote: x.quote ?? null, speaker: x.speaker ?? null,
        };
      });

    const doc = await writeDocument(supabase, workspaceId, {
      kind,
      title,
      headline: b.headline ? String(b.headline).trim() : null,
      sections,
      subjectEntityId,
      periodStart: period?.start ?? null,
      periodEnd: period?.end ?? null,
      generatedFrom: Array.isArray(b.generated_from) ? b.generated_from.map(x => String(x).slice(0, 40)) : null,
      authorUserId: req.memberUserId ?? req.internalUserId ?? null,
      skill: b.skill ? String(b.skill).slice(0, 60) : null,
      writtenBy: 'plugin',
      sources,
    });

    const appUrl = (process.env.APP_URL || 'https://app.opennous.cloud').replace(/\/$/, '');
    return res.status(201).json({
      document_id: doc.id,
      ref: documentRef(doc.id),
      title: doc.title,
      kind: doc.kind,
      version: doc.version,
      cadence: doc.cadence,
      url: `${appUrl}/pages/${doc.id}`,
      sources: sources.length,
    });
  } catch (err) {
    console.error('[POST /v2/documents]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
