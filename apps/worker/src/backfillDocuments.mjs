// One-off backfill (GET-197): the documents the agent wrote as `note.*` claims become rows in
// `documents`, through the SAME `writeDocument` the live tools call — so a backfilled
// document is chunked, linked, versioned and flattened exactly like a new one.
//
// What it fixes on the way, all observed in production on 2026-09-13:
//   · account briefs and plans filed on the WORKSPACE entity (the focus did not resolve at
//     write time) are re-homed to the account their title names, when that name resolves to
//     exactly one account
//   · a brief titled with a raw entity id is retitled with the account's name
//   · a report's window, which existed only in its title ("last 30 days"), becomes its period
//   · near-identical briefs on one account become versions of one document rather than a pile
//
// SAFE BY DEFAULT: dry-run prints the plan. `--apply` writes the documents and invalidates the
// note rows they came from (invalid_at + metadata.moved_to_document), so an account read shows
// each document once. `--revert` undoes both. Idempotent: a note already copied is skipped.
//
// Usage (worker container):
//   docker compose exec -T worker node apps/worker/src/backfillDocuments.mjs [--workspace <id>] [--apply | --revert]
//
// `--sources` (with or without --apply): give each backfilled document the evidence of the chat
// turn that wrote it. Every note-era document was saved with `sources: []`, but the message
// still holds its tool calls, and the sources the document was numbered against are those calls'
// sources in first-seen order. Only documents with no sources yet are touched.

import './bootEnv.mjs';
import {
  getSupabaseClient, writeDocument, resolveFocus, labelEntities, inferPeriodFromTitle,
  sectionsFromMarkdown, documentKindFromDocType, seriesFor, attachDocumentSources,
} from '@nous/core';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const REVERT = args.includes('--revert');
const SOURCES = args.includes('--sources');
const wsIdx = args.indexOf('--workspace');
const WORKSPACE = wsIdx >= 0 ? args[wsIdx + 1] : null;

const DOC_TYPES = ['account_brief', 'account_plan', 'report', 'meeting_brief', 'objection_prep'];
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const supabase = getSupabaseClient();

async function revert() {
  let q = supabase.from('documents').select('id, workspace_id, legacy_claim_id').not('legacy_claim_id', 'is', null);
  if (WORKSPACE) q = q.eq('workspace_id', WORKSPACE);
  const { data: docs, error } = await q.limit(5000);
  if (error) throw error;
  console.log(`[revert] ${docs.length} backfilled documents`);
  for (const d of docs) {
    const { data: claim } = await supabase.from('claims').select('id, value').eq('id', d.legacy_claim_id).maybeSingle();
    if (claim) {
      const value = { ...claim.value, metadata: { ...(claim.value?.metadata ?? {}) } };
      delete value.metadata.moved_to_document;
      await supabase.from('claims').update({ invalid_at: null, value }).eq('id', claim.id);
    }
    // Documents written AFTER the backfill may have superseded this one; unlink them first so
    // the delete does not orphan a live chain.
    await supabase.from('documents').update({ supersedes_id: null }).eq('supersedes_id', d.id);
    await supabase.from('documents').delete().eq('id', d.id);
  }
  console.log('[revert] done');
}

/** The account a title names: "Brief — Harborline", "Quillfield account plan", "Harborline". */
function nameFromTitle(title) {
  return String(title ?? '')
    .replace(/^(brief|plan|report|meeting brief|objection prep)\s+[—–-]\s+/i, '')
    .replace(/\s+(account plan|account brief|brief|plan)$/i, '')
    .trim();
}

async function recoverSources() {
  let q = supabase.from('documents').select('id, workspace_id, title, legacy_claim_id, created_at').not('legacy_claim_id', 'is', null);
  if (WORKSPACE) q = q.eq('workspace_id', WORKSPACE);
  const { data: docs, error } = await q.limit(5000);
  if (error) throw error;
  console.log(`[sources] ${docs.length} backfilled documents${APPLY ? '' : ' — DRY RUN'}`);
  let attached = 0;
  for (const d of docs) {
    // The message that WROTE it: a present_* / save_note call whose output names the note id.
    // Messages that merely mention the id later (a follow-up reading it) are not the author.
    // Messages carry no workspace, so go through the workspace's threads, and look only at the
    // minutes after the document was written: the authoring turn is persisted when it ends.
    const { data: threads } = await supabase.from('playground_threads').select('id').eq('workspace_id', d.workspace_id).limit(5000);
    const threadIds = (threads ?? []).map(t => t.id);
    const from = new Date(Date.parse(d.created_at) - 60_000).toISOString();
    const to = new Date(Date.parse(d.created_at) + 20 * 60_000).toISOString();
    const msgs = [];
    for (let i = 0; i < threadIds.length; i += 200) {
      const { data } = await supabase.from('playground_messages').select('id, tool_calls, created_at')
        .in('thread_id', threadIds.slice(i, i + 200)).eq('role', 'assistant')
        .gte('created_at', from).lte('created_at', to).order('created_at', { ascending: true });
      msgs.push(...(data ?? []));
    }
    let sources = null;
    for (const m of msgs) {
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      const at = calls.findIndex(c => ['present_document', 'present_brief', 'save_note'].includes(c?.name)
        && (c?.output?.document_id === d.legacy_claim_id || c?.output?.note_id === d.legacy_claim_id));
      if (at < 0) continue;
      const seen = new Set();
      sources = [];
      for (const c of calls.slice(0, at)) {
        for (const src of Array.isArray(c?.sources) ? c.sources : []) {
          // First-seen, deduped the way the note-era snapshot deduped: that order is what the
          // document's [n] markers were numbered against.
          const key = `${src.system}|${src.detail}`;
          if (seen.has(key)) continue;
          seen.add(key);
          sources.push(src);
        }
      }
      break;
    }
    if (!sources) { console.log(`  none   ${d.title.slice(0, 60).padEnd(60)} (no authoring message found)`); continue; }
    console.log(`  ${APPLY ? 'attach' : 'plan  '} ${d.title.slice(0, 60).padEnd(60)} sources=${sources.length}`);
    if (!APPLY || !sources.length) continue;
    const r = await attachDocumentSources(supabase, d.workspace_id, d.id, sources);
    if (r.attached) attached++;
    else console.log(`         skipped: ${r.skipped}`);
  }
  console.log(`[sources] ${APPLY ? `attached to ${attached} documents` : 'dry run complete — pass --apply to write'}`);
}

async function main() {
  if (REVERT) return revert();
  if (SOURCES) return recoverSources();

  let q = supabase.from('claims')
    .select('id, workspace_id, entity_id, value, valid_from, computed_at')
    .like('property', 'note.%')
    .is('invalid_at', null)
    .in('value->metadata->>doc_type', DOC_TYPES)
    // Oldest first, so each newer brief on an account supersedes the one before it.
    .order('computed_at', { ascending: true })
    .limit(5000);
  if (WORKSPACE) q = q.eq('workspace_id', WORKSPACE);
  const { data: notes, error } = await q;
  if (error) throw error;

  const { data: done } = await supabase.from('documents').select('legacy_claim_id').not('legacy_claim_id', 'is', null).limit(5000);
  const copied = new Set((done ?? []).map(d => d.legacy_claim_id));

  const entityIds = [...new Set(notes.map(n => n.entity_id))];
  const { data: ents } = entityIds.length
    ? await supabase.from('entities').select('id, workspace_id, type, merged_into').in('id', entityIds)
    : { data: [] };
  const entityById = new Map((ents ?? []).map(e => [e.id, e]));

  console.log(`[backfill] ${notes.length} document notes, ${copied.size} already copied${APPLY ? '' : ' — DRY RUN'}`);
  let written = 0;
  for (const n of notes) {
    if (copied.has(n.id)) continue;
    const meta = n.value?.metadata ?? {};
    const kind = documentKindFromDocType(meta.doc_type);
    if (!kind) continue;
    const createdAt = n.valid_from ?? n.computed_at;

    // Subject: the entity it was filed on — following a merge — unless that is the workspace.
    let ent = entityById.get(n.entity_id);
    let subject = ent?.type === 'workspace' ? null : (ent?.merged_into ?? n.entity_id);
    let title = String(meta.title ?? '').trim();
    let rehomed = false;
    if (!subject && kind !== 'report') {
      const name = nameFromTitle(title);
      if (name && !UUID_RE.test(name)) {
        const r = await resolveFocus(supabase, n.workspace_id, name);
        if (r.status === 'resolved') { subject = r.entity_id; rehomed = true; }
      }
    }
    if (subject && (!title || UUID_RE.test(title))) {
      const label = (await labelEntities(supabase, n.workspace_id, [subject])).get(subject);
      const prefix = { brief: 'Brief', plan: 'Plan', meeting_brief: 'Meeting brief', objection_prep: 'Objection prep', report: 'Report' }[kind];
      if (label?.name) title = `${prefix} — ${label.name}`;
    }
    if (!title) title = kind === 'report' ? 'Report' : 'Document';

    const sections = Array.isArray(meta.sections) && meta.sections.length
      ? meta.sections.filter(s => s && s.label)
      : sectionsFromMarkdown(String(n.value?.content ?? ''));
    const period = kind === 'report' ? inferPeriodFromTitle(title, createdAt) : null;

    console.log(`  ${APPLY ? 'write' : 'plan '} ${kind.padEnd(14)} ${title.slice(0, 60).padEnd(60)} subject=${subject ?? '—'}${rehomed ? ' (re-homed)' : ''}${period ? ` period=${period.start.slice(0, 10)}→${period.end.slice(0, 10)}` : ''} sources=${(meta.sources ?? []).length}`);
    if (!APPLY) continue;

    const doc = await writeDocument(supabase, n.workspace_id, {
      kind,
      title,
      headline: meta.headline ?? null,
      sections,
      subjectEntityId: subject,
      periodStart: period?.start ?? null,
      periodEnd: period?.end ?? null,
      series: kind === 'report' ? seriesFor(null, title) : null,
      generatedFrom: Array.isArray(meta.generated_from) ? meta.generated_from : null,
      writtenBy: meta.written_by ?? 'web_agent',
      sources: Array.isArray(meta.sources) ? meta.sources : [],
      createdAt,
      legacyClaimId: n.id,
    });
    await supabase.from('claims').update({
      invalid_at: new Date().toISOString(),
      value: { ...n.value, metadata: { ...meta, moved_to_document: doc.id } },
    }).eq('id', n.id);
    written++;
  }
  console.log(`[backfill] ${APPLY ? `wrote ${written}` : 'dry run complete — pass --apply to write'}`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
