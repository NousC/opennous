import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { hasSupabase } from './helpers.mjs';
import {
  getSupabaseClient,
  saveNote,
  saveDocument,
  supersedeNote,
  updateNote,
  listNotes,
  getNote,
  assembleContext,
} from '@nous/core';
import { findSupersedable } from '../src/routes/v2/workspaceFacts.mjs';

// End-to-end check of the GTM-context evolution work (Phases 1 + 2): facts carry
// a subject slot + confidence, a rebuild SUPERSEDES the slot's prior fact (kept
// as history) instead of deleting it, and an agent write-back evolves the matching
// belief. Runs against the real DB, fully isolated in a throwaway team/workspace
// that cascade-deletes on cleanup.

const run = hasSupabase ? test : (n, _f) => test(n, { skip: 'no SUPABASE env' }, () => {});

let workspaceId = null;
let teamId = null;
let entityId = null;

before(async () => {
  if (!hasSupabase) return;
  const supabase = getSupabaseClient();
  const { data: team } = await supabase
    .from('teams').insert({ name: `zz-gtm-evolution-test-${Date.now()}` }).select('id').single();
  teamId = team.id;
  const { data: ws } = await supabase
    .from('workspaces').insert({ name: `zz-gtm-evolution-test-${Date.now()}`, team_id: teamId }).select('id').single();
  workspaceId = ws.id;
  const { data: ent } = await supabase
    .from('entities').insert({ workspace_id: workspaceId, type: 'workspace' }).select('id').single();
  entityId = ent.id;
});

after(async () => {
  const supabase = getSupabaseClient();
  // Deleting the workspace cascades to its entity + claims; then drop the team.
  if (workspaceId) await supabase.from('workspaces').delete().eq('id', workspaceId);
  if (teamId) await supabase.from('teams').delete().eq('id', teamId);
});

run('Phase 1 — a fact evolves by subject: supersede keeps history, active reads the latest', async () => {
  const supabase = getSupabaseClient();
  const slot = { entityId, category: 'Pricing', source: 'playbook', subject: 'playbook.pricing' };

  // 1. First fact in the slot — AI-drafted, confidence < 1, with a subject.
  const v1 = await saveNote(supabase, workspaceId, { ...slot, content: 'Flat $99/mo', confidence: 0.8 });
  assert.ok(v1, 'v1 saved');
  assert.equal(v1.confidence, 0.8, 'v1 confidence persisted');
  assert.equal(v1.subject, 'playbook.pricing', 'v1 subject persisted');
  assert.equal(v1.is_active, true, 'v1 active');

  // 2. Rebuild changes the slot → supersede, not overwrite.
  const v2 = await supersedeNote(supabase, workspaceId, v1.id, { ...slot, content: 'Usage-based, $0.01/call', confidence: 0.8 });
  assert.ok(v2, 'v2 saved');
  assert.equal(v2.content, 'Usage-based, $0.01/call', 'v2 content');
  assert.equal(v2.metadata.supersedes, v1.id, 'v2 links back to v1');

  // 3. Active read returns ONLY the latest — old version is gone from the profile.
  const active = await listNotes(supabase, workspaceId, { entityId });
  const activePricing = active.filter(n => n.subject === 'playbook.pricing');
  assert.equal(activePricing.length, 1, 'exactly one active fact in the slot');
  assert.equal(activePricing[0].content, 'Usage-based, $0.01/call', 'active is v2');
  assert.equal(active.some(n => n.content === 'Flat $99/mo'), false, 'v1 not in active set');

  // 4. The old fact is preserved as history, with a forward link.
  const oldNote = await getNote(supabase, workspaceId, v1.id);
  assert.ok(oldNote, 'v1 still exists (not hard-deleted)');
  assert.equal(oldNote.is_active, false, 'v1 invalidated');
  assert.equal(oldNote.superseded_by, v2.id, 'v1 links forward to v2');

  // 5. The timeline read (includeInactive + subject) returns both versions.
  const history = await listNotes(supabase, workspaceId, { entityId, subject: 'playbook.pricing', includeInactive: true, limit: 50 });
  assert.equal(history.length, 2, 'history has both versions');
  assert.equal(history.filter(n => n.is_active).length, 1, 'one current in history');
  assert.equal(history.filter(n => !n.is_active).length, 1, 'one superseded in history');
});

run('Phase 2 — an agent write-back evolves the matching belief, not a duplicate', async () => {
  const supabase = getSupabaseClient();

  // A playbook-created belief on the positioning slot.
  const seed = await saveNote(supabase, workspaceId, {
    entityId, category: 'Positioning', source: 'playbook', subject: 'playbook.positioning',
    content: 'We win on speed of setup', confidence: 0.8,
  });

  // The agent writes back with the bare slot name "positioning". findSupersedable
  // (the real endpoint helper) must match the playbook.positioning fact so the
  // write-back EVOLVES it rather than adding a second positioning fact.
  const active = await listNotes(supabase, workspaceId, { entityId, limit: 200 });
  const target = findSupersedable(active, 'positioning');
  assert.ok(target, 'write-back matched the existing belief by bare subject');
  assert.equal(target.id, seed.id, 'matched the right fact');

  const updated = await supersedeNote(supabase, workspaceId, target.id, {
    entityId, category: 'Positioning', source: 'agent', subject: 'positioning',
    content: 'We win on depth of GTM context, not just speed', confidence: 0.9,
  });
  assert.equal(updated.source, 'agent', 'write-back recorded as agent source');

  // Exactly one active positioning fact, and it is the agent's version.
  const afterActive = await listNotes(supabase, workspaceId, { entityId });
  const positioning = afterActive.filter(n => n.category === 'Positioning');
  assert.equal(positioning.length, 1, 'no duplicate positioning fact');
  assert.equal(positioning[0].content, 'We win on depth of GTM context, not just speed', 'active is the write-back');
  assert.equal(positioning[0].source, 'agent', 'active is agent-sourced');

  // The superseded playbook belief is kept as history.
  const seedAfter = await getNote(supabase, workspaceId, seed.id);
  assert.equal(seedAfter.is_active, false, 'old belief invalidated, not deleted');
  assert.equal(seedAfter.superseded_by, updated.id, 'old belief links to the write-back');
});

run('Phase 3 — confirming a fact raises confidence to 1 and resets staleness', async () => {
  const supabase = getSupabaseClient();

  // An AI-drafted, unconfirmed fact (would show "inferred" + appear in revisit list).
  const f = await saveNote(supabase, workspaceId, {
    entityId, category: 'Market', source: 'playbook', subject: 'playbook.segments',
    content: 'Series A-B B2B SaaS', confidence: 0.8,
  });
  assert.equal(f.confidence, 0.8, 'starts inferred');
  assert.equal(f.reaffirmed_at, null, 'not yet reaffirmed');

  // Confirm it — the page's Confirm button posts exactly this patch.
  const confirmed = await updateNote(supabase, workspaceId, f.id, { confidence: 1, reaffirm: true });
  assert.equal(confirmed.confidence, 1, 'confidence raised to 1');
  assert.ok(confirmed.reaffirmed_at, 'reaffirmed_at stamped — staleness reset');
  assert.equal(confirmed.is_active, true, 'still active');
  assert.equal(confirmed.content, 'Series A-B B2B SaaS', 'content unchanged');
});

run('context-changes feed pairs a superseded fact to its replacement (the "what it learned" timeline)', async () => {
  const supabase = getSupabaseClient();
  await saveNote(supabase, workspaceId, {
    entityId, category: 'Market', source: 'playbook', subject: 'playbook.market', content: 'SMB', confidence: 0.8,
  }).then(v1 => supersedeNote(supabase, workspaceId, v1.id, {
    entityId, category: 'Market', source: 'agent', subject: 'playbook.market', content: 'Mid-market', confidence: 0.9,
  }));

  // Replicates the GET /api/mind/context-changes derivation exactly.
  const all = await listNotes(supabase, workspaceId, { entityId, includeInactive: true, limit: 300 });
  const byId = new Map(all.map(n => [n.id, n]));
  const changes = all
    .filter(n => !n.is_active && n.superseded_by && byId.has(n.superseded_by))
    .map(n => ({ from: n.content, to: byId.get(n.superseded_by).content }));

  const pair = changes.find(c => c.to === 'Mid-market');
  assert.ok(pair, 'the change shows up in the feed');
  assert.equal(pair.from, 'SMB', 'feed pairs new content with the old it replaced');
});

run('sections: a "replace" section evolves to one active; "Notes" appends multiple', async () => {
  const supabase = getSupabaseClient();

  // "GTM Motion" is a replace section → slug "gtm-motion", one living doc.
  const m1 = await saveNote(supabase, workspaceId, {
    entityId, category: 'GTM Motion', source: 'agent', subject: 'gtm-motion',
    content: 'Founder-led outbound', confidence: 0.9,
  });
  await supersedeNote(supabase, workspaceId, m1.id, {
    entityId, category: 'GTM Motion', source: 'agent', subject: 'gtm-motion',
    content: 'Founder-led outbound → PLG self-serve', confidence: 0.9,
  });
  const active = await listNotes(supabase, workspaceId, { entityId });
  const motion = active.filter(n => n.category === 'GTM Motion');
  assert.equal(motion.length, 1, 'GTM Motion has exactly one active version');
  assert.equal(motion[0].content, 'Founder-led outbound → PLG self-serve', 'evolved to latest');

  // "Notes" is an append section → no subject, entries accumulate.
  await saveNote(supabase, workspaceId, { entityId, category: 'Notes', source: 'agent', content: 'Moved upmarket in Q2', confidence: 0.9 });
  await saveNote(supabase, workspaceId, { entityId, category: 'Notes', source: 'agent', content: 'RevOps owns the handoff', confidence: 0.9 });
  const notes = (await listNotes(supabase, workspaceId, { entityId })).filter(n => n.category === 'Notes');
  assert.equal(notes.length, 2, 'Notes accumulates entries instead of replacing');
});

run('contact documents: a note/brief saves with doc_type metadata and appends (the record)', async () => {
  const supabase = getSupabaseClient();
  // A separate person entity, like a contact the agent attaches documents to.
  const { data: person } = await supabase
    .from('entities').insert({ workspace_id: workspaceId, type: 'person' }).select('id').single();

  // Two dated documents on the same contact via the real saveDocument helper
  // (the path the /v2/notes endpoint and the meeting webhooks use) — append.
  await saveDocument(supabase, workspaceId, {
    entityId: person.id, type: 'meeting_brief', source: 'agent',
    content: 'Brief for the May kickoff: focus on RevOps pains.',
    title: 'Kickoff brief — May', date: '2026-05-15',
  });
  await saveDocument(supabase, workspaceId, {
    entityId: person.id, type: 'meeting_notes', source: 'fathom',
    content: 'Full meeting notes…', title: 'Meeting notes — Jun 1', date: '2026-06-01',
    meta: { url: 'https://fathom.video/x' },
  });

  const docs = (await listNotes(supabase, workspaceId, { entityId: person.id }))
    .filter(n => n.metadata?.doc_type);
  assert.equal(docs.length, 2, 'both documents kept (append, not overwrite)');
  const brief = docs.find(d => d.metadata.doc_type === 'meeting_brief');
  assert.ok(brief, 'brief stored with its doc_type');
  assert.equal(brief.metadata.title, 'Kickoff brief — May', 'title round-trips');
  assert.equal(brief.metadata.date, '2026-05-15', 'date round-trips');
});

run('Slice 3 — get_context surfaces documents compactly, out of the claim stream', async () => {
  const supabase = getSupabaseClient();
  const { data: person } = await supabase
    .from('entities').insert({ workspace_id: workspaceId, type: 'person' }).select('id').single();
  await saveDocument(supabase, workspaceId, {
    entityId: person.id, type: 'meeting_brief', title: 'Prep — Q3 renewal', date: '2026-06-01',
    content: 'A long meeting brief body that should not be dumped into the claim stream…',
  });

  const ctx = await assembleContext(supabase, workspaceId, person.id, 'meeting_prep');
  assert.ok(ctx, 'context assembled');
  assert.ok(
    ctx.documents.some(d => d.type === 'meeting_brief' && d.title === 'Prep — Q3 renewal'),
    'the document is surfaced in ctx.documents',
  );
  assert.equal(
    ctx.claims.some(c => typeof c.property === 'string' && c.property.startsWith('note.')),
    false,
    'document is kept OUT of the claim stream (no token blowup)',
  );
});
