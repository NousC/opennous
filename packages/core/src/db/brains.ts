/**
 * Brains (GET-431): the named places a workspace keeps what it knows about how it sells.
 *
 * v1 has one, the GTM brain, and it is mostly things that already exist, given one address:
 *
 *   written pages   Decisions, competitor pages, working documents, the archive. Documents of
 *                   kind `brain_page`, filed by path. Every save is a new version, never an edit.
 *   playbooks       Positioning, ICP, Market, Distribution, Pricing: the GTM profile sections
 *                   the ICP model already scores against. The page IS that fact, so there is
 *                   no second copy to drift from it.
 *   live pages      Overview, every folder index, Insights and Internal Meetings. Built on read from the rows
 *                   underneath, so they cannot go stale and nobody edits them. Insights are
 *                   written by the background extractor only; a person or an agent reads them.
 *
 * Every page reaches the reader as markdown, and `[[Path]]` / `[[Path|Label]]` links resolve
 * inside the brain, which is what gives a page its outgoing links and its backlinks.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { writeDocument, sectionText, labelEntities, type DocumentRow, type DocumentSection } from './documents.js';
import { listNotes, getWorkspaceEntityId } from './notes.js';
import { getInternalEntityIds, getInternalEmails } from './teamMembers.js';
import { sameTask } from './meetingTaskClosure.js';
import { rawVisible, type ReadContext } from './readContext.js';
import { internalMeetingSummaries, parseMeetingSummarySections, OUR_BUSINESS } from './meetingSummaries.js';
import { resolveClientCompany } from './meetingTasks.js';
import { proposalPath, proposalParts, PROPOSAL_PREFIX, PLAYBOOK_TOPICS } from './playbookProposals.js';

export type BrainTemplate = 'gtm' | 'blank';

export interface Brain {
  id: string;
  workspace_id: string;
  slug: string;
  name: string;
  template: BrainTemplate;
  charter: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

/** How a page is made: generated on read, written as a document, or a GTM profile section. */
export type BrainPageKind = 'live' | 'written' | 'playbook';

export interface BrainNode {
  path: string;
  name: string;
  kind: 'folder' | 'page';
  page?: BrainPageKind;
  updated_at?: string | null;
  children?: BrainNode[];
}

export interface BrainLink { path: string; title: string }

export interface BrainPage {
  path: string;
  title: string;
  kind: BrainPageKind;
  body_md: string;
  /** Whether a person may save a new version of it. Live pages never. */
  editable: boolean;
  /** What the editor opens with, when that is not the page as shown (Decisions: the written log only). */
  edit_md: string | null;
  /** A playbook's proposed next version waiting for review (GET-470), or null. */
  proposal?: { document_id: string; proposed: string; why: string; open: string; drafted_at: string } | null;
  /** Who last wrote it: `agent`, `user`, `extractor` (insights), `generated` (live). */
  source: string;
  updated_at: string | null;
  words: number;
  document_id: string | null;
  version: number | null;
  outgoing: BrainLink[];
  backlinks: BrainLink[];
}

const BRAIN_COLS = 'id, workspace_id, slug, name, template, charter, created_at, updated_at, archived_at';
const DAY = 86_400_000;

// ── The GTM template ─────────────────────────────────────────────────────────

/** Playbook page → the GTM profile section behind it. Distribution is the profile's "GTM Motion". */
export const PLAYBOOK_SECTIONS: { name: string; section: string }[] = [
  { name: 'Positioning', section: 'Positioning' },
  { name: 'ICP', section: 'ICP' },
  { name: 'Market', section: 'Market' },
  { name: 'Distribution', section: 'GTM Motion' },
  { name: 'Pricing', section: 'Pricing' },
];

// Customer insights are one page, a section per category (GET-445). Internal insights are a separate
// page inside Internal Meetings, built from the meeting summaries: what the team concluded is kept
// apart from what customers said, so the two can never be read as one.
// Customer insights are NOT in the brain (product decision, 2026-09-25): they live on the Insights page, and a
// second copy here was two answers to one question. The brain keeps what the team itself concluded.
const INTERNAL_INSIGHTS = 'Internal Meetings/Internal Insights';

// A meeting with no summary yet still shows what the team-insight extractor took from it.
const TEAM_CATEGORY_LABEL: Record<string, string> = { decisions: 'Decisions', blockers: 'Blockers', learnings: 'Learnings' };

/** Folders a written page may be filed in. A written page outside them is refused. */
const WRITABLE_FOLDERS = ['Playbooks/Competitors', 'Working Documents', 'Archive'];

const DEFAULT_CHARTER =
  'How we sell: who we sell to, how we describe ourselves, where we find buyers, what we charge, ' +
  'who we lose to, and what we decided along the way.';

// ── Brains ───────────────────────────────────────────────────────────────────

/** The GTM brain, made the first time anyone asks for it. Idempotent under a race. */
export async function ensureGtmBrain(supabase: SupabaseClient, workspaceId: string): Promise<Brain> {
  const existing = await getBrain(supabase, workspaceId, 'gtm');
  if (existing) return existing;
  const { error } = await supabase.from('brains').insert({
    workspace_id: workspaceId, slug: 'gtm', name: 'GTM Brain', template: 'gtm', charter: DEFAULT_CHARTER,
  });
  // 23505: someone else made it between the read and the write. Theirs is the brain.
  if (error && error.code !== '23505') throw error;
  const made = await getBrain(supabase, workspaceId, 'gtm');
  if (!made) throw new Error('brain_not_created');
  return made;
}

export async function listBrains(supabase: SupabaseClient, workspaceId: string): Promise<Brain[]> {
  await ensureGtmBrain(supabase, workspaceId);
  const { data, error } = await supabase.from('brains').select(BRAIN_COLS)
    .eq('workspace_id', workspaceId).is('archived_at', null).order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as Brain[];
}

export async function getBrain(supabase: SupabaseClient, workspaceId: string, slug: string): Promise<Brain | null> {
  const { data, error } = await supabase.from('brains').select(BRAIN_COLS)
    .eq('workspace_id', workspaceId).eq('slug', slug).maybeSingle();
  if (error) throw error;
  return (data as Brain | null) ?? null;
}

export async function updateBrain(
  supabase: SupabaseClient, workspaceId: string, slug: string, patch: { name?: string; charter?: string },
): Promise<Brain | null> {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof patch.name === 'string' && patch.name.trim()) row.name = patch.name.trim().slice(0, 80);
  if (typeof patch.charter === 'string') row.charter = patch.charter.trim().slice(0, 2000);
  const { data, error } = await supabase.from('brains').update(row)
    .eq('workspace_id', workspaceId).eq('slug', slug).select(BRAIN_COLS).maybeSingle();
  if (error) throw error;
  return (data as Brain | null) ?? null;
}

// ── What the brain is made of, read once per request ────────────────────────

interface Playbook { name: string; section: string; content: string; source: string; updated_at: string | null }

/** A recorded call with only the team on it (GET-443): every attendee the call resolved to is
 *  flagged internal — the same test that routes a call to the team-insight extractor. */
export interface InternalMeeting {
  /** The recording the page is built from. */
  ref: string;
  /** Every recording of this one call (GET-458): Fireflies and Granola on the same call are one meeting. */
  refs: string[];
  path: string;
  title: string;
  date: string | null;
  attendeeIds: string[];
  ownerUserId: string | null;
  transcriptUrl: string | null;
  duration: number | null;
}

interface BrainSnapshot {
  brain: Brain;
  written: DocumentRow[];
  playbooks: Playbook[];
  competitorsIntro: Playbook | null;
  meetings: InternalMeeting[];
  /** The meeting summary of each internal meeting that has one, by source_ref (GET-445). */
  summaries: Map<string, DocumentRow>;
}

const MEETINGS_FOLDER = 'Internal Meetings';
const MEETING_PAGE = 1000;

/**
 * Every internal meeting, newest first. A call's notes are filed once per attendee, so the rows
 * are grouped by the call they came from (`source_ref`), and the call is internal when every one
 * of its attendees is. Only the notes' metadata is read here — the transcript is fetched for the
 * one page that shows it.
 */
export async function listInternalMeetings(supabase: SupabaseClient, workspaceId: string): Promise<InternalMeeting[]> {
  return internalMeetings(supabase, workspaceId);
}

async function internalMeetings(supabase: SupabaseClient, workspaceId: string): Promise<InternalMeeting[]> {
  const internal = new Set(await getInternalEntityIds(supabase, workspaceId));
  if (!internal.size) return [];
  // Our addresses: every login and mailbox, and every email on a teammate's record (a personal
  // Gmail they join from). A call is internal when each address on it is one of these (GET-459).
  const ourEmails = new Set((await getInternalEmails(supabase, workspaceId)).map(e => e.toLowerCase()));
  const { data: idents, error: idErr } = await supabase.from('entity_identifiers').select('value')
    .eq('workspace_id', workspaceId).eq('kind', 'email').in('entity_id', [...internal].slice(0, 200));
  if (idErr) throw idErr;
  for (const i of idents ?? []) for (const e of String(i.value).split(/[,;]+/)) if (e.trim()) ourEmails.add(e.trim().toLowerCase());

  type Row = { entity_id: string; valid_from: string; meta: Record<string, unknown> | null };
  const rows: Row[] = [];
  for (let from = 0; ; from += MEETING_PAGE) {
    const { data, error } = await supabase.from('claims').select('entity_id, valid_from, meta:value->metadata')
      .eq('workspace_id', workspaceId).like('property', 'note.%').is('invalid_at', null)
      .eq('value->metadata->>doc_type', 'meeting_notes')
      .order('valid_from', { ascending: false }).range(from, from + MEETING_PAGE - 1);
    if (error) throw error;
    rows.push(...((data ?? []) as unknown as Row[]));
    if ((data ?? []).length < MEETING_PAGE || rows.length >= 20 * MEETING_PAGE) break;
  }
  const byCall = new Map<string, Row[]>();
  for (const r of rows) {
    const ref = String(r.meta?.source_ref ?? '');
    if (!ref) continue;
    const g = byCall.get(ref) ?? [];
    g.push(r);
    byCall.set(ref, g);
  }

  const calls: InternalMeeting[] = [];
  for (const [ref, g] of byCall) {
    // Marked not internal by hand: a customer call that only looked internal.
    if (g.some(r => r.meta?.internal === false)) continue;
    const emails = [...new Set(g.flatMap(r => (Array.isArray(r.meta?.attendee_emails) ? r.meta!.attendee_emails as unknown[] : []))
      .map(e => String(e).toLowerCase().trim()).filter(Boolean))];
    // With the attendee list, the test is the addresses: one outside address makes it a customer
    // call even when that customer never became a contact. Without it (recorded before GET-459),
    // the attendees on record decide, as before.
    const isInternal = emails.length
      ? emails.every(e => ourEmails.has(e))
      : g.every(r => internal.has(r.entity_id));
    if (!isInternal) continue;
    const m = g[0].meta ?? {};
    calls.push({
      ref, refs: [ref],
      path: '',
      title: String(m.title ?? 'Meeting').replace(/^Meeting notes\s*[—-]\s*/i, '').trim() || 'Meeting',
      date: String(m.date ?? g[0].valid_from ?? '').slice(0, 10) || null,
      attendeeIds: [...new Set(g.map(r => r.entity_id))],
      ownerUserId: (m.owner_user_id as string | null) ?? null,
      // Fireflies files `transcript_url`; Granola, Fellow and the rest file the note's `url`.
      transcriptUrl: ((m.transcript_url ?? m.url ?? m.web_url) as string | null) ?? null,
      duration: typeof m.duration === 'number' ? m.duration : null,
    });
  }

  // ONE MEETING PER CALL (GET-458). Two recorders on the same call (Fireflies and Granola) file
  // two notes with two refs. It is the same call only when the recorders DIFFER — one recorder does
  // not take one call twice, and a day of imported calls can share a date and a title — on the same
  // day, with people in common, and the same title (or one of them untitled).
  const generic = (t: string) => /^(meeting|untitled|call)\b/i.test(t) || /@/.test(t);
  const systemOf = (ref: string) => ref.split('/')[2] ?? '';
  const merged: InternalMeeting[] = [];
  for (const c of calls) {
    const twin = merged.find(x => x.date === c.date
      && !x.refs.some(r => systemOf(r) === systemOf(c.ref))
      && x.attendeeIds.some(id => c.attendeeIds.includes(id))
      && (sameTask(x.title, c.title) || generic(x.title) || generic(c.title)));
    if (!twin) { merged.push(c); continue; }
    twin.refs.push(c.ref);
    twin.attendeeIds = [...new Set([...twin.attendeeIds, ...c.attendeeIds])];
    if (generic(twin.title) && !generic(c.title)) twin.title = c.title;
    twin.transcriptUrl = twin.transcriptUrl ?? c.transcriptUrl;
    twin.duration = twin.duration ?? c.duration;
    twin.ownerUserId = twin.ownerUserId ?? c.ownerUserId;
  }

  // A path is a name a person reads, so it is the date and the title; a clash gets a suffix.
  const taken = new Set<string>();
  for (const m of merged) {
    let name = `${m.date ?? 'Undated'} ${m.title}`.replace(/[\/\\]/g, '-').slice(0, 120);
    for (let i = 2; taken.has(name); i++) name = `${m.date ?? 'Undated'} ${m.title} (${i})`.replace(/[\/\\]/g, '-');
    taken.add(name);
    m.path = `${MEETINGS_FOLDER}/${name}`;
  }
  return merged.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
}

/** A meeting's summary: from whichever of its recordings has one (GET-458). */
function summaryOf(s: BrainSnapshot, m: InternalMeeting): DocumentRow | undefined {
  for (const r of m.refs) { const d = s.summaries.get(r); if (d) return d; }
  return undefined;
}

async function writtenPages(supabase: SupabaseClient, workspaceId: string, brainId: string): Promise<DocumentRow[]> {
  const { data, error } = await supabase.from('documents')
    .select('id, kind, title, headline, sections, body_md, word_count, version, status, written_by, author_user_id, created_at, updated_at, brain_path')
    .eq('workspace_id', workspaceId).eq('brain_id', brainId).eq('kind', 'brain_page').eq('status', 'live')
    .order('brain_path', { ascending: true }).limit(1000);
  if (error) throw error;
  return (data ?? []) as unknown as DocumentRow[];
}

async function playbookFacts(supabase: SupabaseClient, workspaceId: string): Promise<Map<string, Playbook>> {
  const out = new Map<string, Playbook>();
  const entityId = await getWorkspaceEntityId(supabase, workspaceId);
  if (!entityId) return out;
  const sections = [...PLAYBOOK_SECTIONS.map(p => p.section), 'Competitors'];
  const notes = await listNotes(supabase, workspaceId, { entityId, categories: sections, limit: 200 });
  // Newest first; the first live fact per section is the section.
  for (const n of notes) {
    if (out.has(n.category)) continue;
    out.set(n.category, {
      name: n.category, section: n.category, content: n.content, source: n.source,
      updated_at: n.reaffirmed_at || n.created_at,
    });
  }
  return out;
}

async function snapshot(supabase: SupabaseClient, workspaceId: string, brain: Brain): Promise<BrainSnapshot> {
  const [written, facts, meetings] = await Promise.all([
    writtenPages(supabase, workspaceId, brain.id),
    playbookFacts(supabase, workspaceId),
    internalMeetings(supabase, workspaceId).catch((e) => { console.error('[brains] internal meetings', e?.message ?? e); return [] as InternalMeeting[]; }),
  ]);
  const playbooks = PLAYBOOK_SECTIONS.map(p => {
    const f = facts.get(p.section);
    return { name: p.name, section: p.section, content: f?.content ?? '', source: f?.source ?? '', updated_at: f?.updated_at ?? null };
  });
  const c = facts.get('Competitors') ?? null;
  const summaries = await internalMeetingSummaries(supabase, workspaceId, meetings.flatMap(m => m.refs))
    .catch((e) => { console.error('[brains] meeting summaries', e?.message ?? e); return new Map<string, DocumentRow>(); });
  return { brain, written, playbooks, competitorsIntro: c, meetings, summaries };
}

// A brain page is saved as one section holding exactly what was written; read that back
// rather than body_md, which carries the section heading the search index wants.
const textOf = (d: DocumentRow) => (Array.isArray(d.sections) ? d.sections.map(sectionText).join('\n\n') : String(d.body_md ?? ''));
const pathOf = (d: DocumentRow) => String((d as unknown as { brain_path: string }).brain_path ?? '');
const lastSegment = (path: string) => path.split('/').pop() ?? path;
const inFolder = (path: string, folder: string) => path.startsWith(`${folder}/`) && !path.slice(folder.length + 1).includes('/');

// ── The tree ─────────────────────────────────────────────────────────────────

export async function brainTree(supabase: SupabaseClient, workspaceId: string, brain: Brain): Promise<BrainNode[]> {
  const s = await snapshot(supabase, workspaceId, brain);
  return treeOf(s);
}

function treeOf(s: BrainSnapshot): BrainNode[] {
  const writtenIn = (folder: string): BrainNode[] => s.written
    .filter(d => inFolder(pathOf(d), folder))
    .map(d => ({ path: pathOf(d), name: lastSegment(pathOf(d)), kind: 'page' as const, page: 'written' as const, updated_at: d.updated_at }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const decisions = s.written.find(d => pathOf(d) === 'Decisions');
  const folder = (path: string, children: BrainNode[]): BrainNode => ({
    path, name: lastSegment(path), kind: 'folder',
    children: [{ path: `${path}/index`, name: 'index', kind: 'page', page: 'live' }, ...children],
  });
  return [
    { path: 'Overview', name: 'Overview', kind: 'page', page: 'live' },
    { path: 'index', name: 'index', kind: 'page', page: 'live' },
    { path: 'Decisions', name: 'Decisions', kind: 'page', page: 'written', updated_at: decisions?.updated_at ?? null },
    folder('Playbooks', [
      ...s.playbooks.map(p => ({ path: `Playbooks/${p.name}`, name: p.name, kind: 'page' as const, page: 'playbook' as const, updated_at: p.updated_at })),
      folder('Playbooks/Competitors', writtenIn('Playbooks/Competitors')),
    ]),
    folder(MEETINGS_FOLDER, [
      { path: INTERNAL_INSIGHTS, name: 'Internal Insights', kind: 'page' as const, page: 'live' as const },
      ...s.meetings.map(m => ({ path: m.path, name: lastSegment(m.path), kind: 'page' as const, page: 'live' as const, updated_at: m.date })),
    ]),
    folder('Working Documents', writtenIn('Working Documents')),
    folder('Archive', writtenIn('Archive')),
  ];
}

function flatten(nodes: BrainNode[]): BrainNode[] {
  return nodes.flatMap(n => (n.kind === 'folder' ? flatten(n.children ?? []) : [n]));
}

// ── Links ────────────────────────────────────────────────────────────────────

const WIKILINK = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

/** Resolve a link target to a page path: an exact path first, then a unique page name. */
function resolveLink(target: string, pages: BrainNode[]): BrainNode | null {
  const t = target.trim().replace(/\.md$/i, '');
  const exact = pages.find(p => p.path.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  const byName = pages.filter(p => p.name.toLowerCase() === t.toLowerCase());
  return byName[0] ?? null;
}

function linksIn(md: string, pages: BrainNode[]): BrainLink[] {
  const seen = new Set<string>();
  const out: BrainLink[] = [];
  for (const m of md.matchAll(WIKILINK)) {
    const hit = resolveLink(m[1], pages);
    if (!hit || seen.has(hit.path)) continue;
    seen.add(hit.path);
    out.push({ path: hit.path, title: hit.name });
  }
  return out;
}

/** Links written by a person or an agent, keyed by the page they sit on. Live pages link to
 *  everything by construction, so they are not counted as backlinks — except a folder's index,
 *  which is where a page is filed and is the one structural backlink worth showing. */
function authoredText(s: BrainSnapshot): { path: string; title: string; md: string }[] {
  return [
    ...s.written.filter(d => pathOf(d) !== 'Decisions' && !pathOf(d).startsWith(SYNTHESIS) && !pathOf(d).startsWith(PROPOSAL_PREFIX)).map(d => ({ path: pathOf(d), title: lastSegment(pathOf(d)), md: textOf(d) })),
    ...s.playbooks.map(p => ({ path: `Playbooks/${p.name}`, title: p.name, md: p.content })),
    // Decisions and Internal Insights link to the meeting each point came from; those links are the
    // way a meeting shows where its decisions and insights went, so they count as backlinks.
    { path: 'Decisions', title: 'Decisions', md: decisionsPage(s) },
    { path: INTERNAL_INSIGHTS, title: 'Internal Insights', md: internalInsightsPage(s) },
  ];
}

// ── Reading a page ───────────────────────────────────────────────────────────

export async function readBrainPage(
  supabase: SupabaseClient, workspaceId: string, brain: Brain, path: string, ctx?: ReadContext,
): Promise<BrainPage | null> {
  const s = await snapshot(supabase, workspaceId, brain);
  const tree = treeOf(s);
  const pages = flatten(tree);
  // A written page that does not exist yet opens empty, so "new competitor page" is just
  // opening its path and saving.
  const node = pages.find(p => p.path === path)
    ?? (isWritablePath(path) ? { path, name: lastSegment(path), kind: 'page' as const, page: 'written' as const } : null);
  if (!node) return null;

  let body = '';
  let source = 'generated';
  let updated: string | null = null;
  let documentId: string | null = null;
  let version: number | null = null;
  let editable = false;
  let editMd: string | null = null;
  let proposal: BrainPage['proposal'] = null;

  if (path === 'Decisions') {
    // Decisions is the written log plus every company decision from an internal meeting, newest first.
    // The editor edits the written part; the meeting entries come from their meetings.
    const d = s.written.find(w => pathOf(w) === path);
    body = decisionsPage(s);
    editMd = d ? textOf(d) : '';
    source = d ? (d.written_by === 'user' ? 'user' : 'agent') : 'generated';
    updated = d?.updated_at ?? null;
    documentId = d?.id ?? null;
    version = d?.version ?? null;
    editable = true;
  } else if (node.page === 'written') {
    const d = s.written.find(w => pathOf(w) === path);
    body = d ? textOf(d) : '';
    source = d ? (d.written_by === 'user' ? 'user' : 'agent') : 'empty';
    updated = d?.updated_at ?? null;
    documentId = d?.id ?? null;
    version = d?.version ?? null;
    editable = true;
  } else if (node.page === 'playbook') {
    const p = s.playbooks.find(x => `Playbooks/${x.name}` === path)!;
    body = p.content || `_Nothing written about ${p.name.toLowerCase()} yet._`;
    source = p.content ? (p.source || 'agent') : 'empty';
    updated = p.updated_at;
    editable = true;
    // Its proposed next version, when one is waiting (GET-470).
    const draft = s.written.find(w => pathOf(w) === proposalPath(p.name));
    if (draft) proposal = { document_id: draft.id, ...proposalParts(draft), drafted_at: draft.created_at };
  } else {
    body = await livePage(supabase, workspaceId, s, tree, path, ctx);
  }

  const backlinks = new Map<string, BrainLink>();
  for (const t of authoredText(s)) {
    if (t.path === path) continue;
    if (linksIn(t.md, pages).some(l => l.path === path)) backlinks.set(t.path, { path: t.path, title: t.title });
  }
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null;
  if (parent && lastSegment(path) !== 'index') backlinks.set(`${parent}/index`, { path: `${parent}/index`, title: 'index' });
  else if (!parent && path !== 'index') backlinks.set('index', { path: 'index', title: 'index' });

  return {
    path,
    title: node.name === 'index' && parent ? lastSegment(parent) : node.name,
    kind: node.page ?? 'live',
    body_md: body,
    editable,
    edit_md: editMd,
    proposal,
    source,
    updated_at: updated,
    words: body.split(/\s+/).filter(Boolean).length,
    document_id: documentId,
    version,
    outgoing: linksIn(body, pages).filter(l => l.path !== path),
    backlinks: [...backlinks.values()],
  };
}


// ── Writing a page ───────────────────────────────────────────────────────────

/** Is this a path a written page may live at? Decisions, or one level inside a writable folder. */
export function isWritablePath(path: string): boolean {
  if (path === 'Decisions') return true;
  return WRITABLE_FOLDERS.some(f => inFolder(path, f) && lastSegment(path) !== 'index' && lastSegment(path).trim().length > 0);
}

/** The playbook section a page path stands for, if it is one. */
export function playbookSectionFor(path: string): string | null {
  return PLAYBOOK_SECTIONS.find(p => `Playbooks/${p.name}` === path)?.section ?? null;
}

/** Save a written page as its next version. Playbooks are written through the GTM profile. */
export async function writeBrainPage(
  supabase: SupabaseClient, workspaceId: string, brain: Brain,
  input: { path: string; body: string; writtenBy?: 'user' | 'agent'; authorUserId?: string | null },
): Promise<DocumentRow> {
  const path = String(input.path ?? '').trim().replace(/\/+$/, '');
  if (!isWritablePath(path)) throw new Error('path_not_writable');
  return writeDocument(supabase, workspaceId, {
    kind: 'brain_page',
    title: lastSegment(path),
    sections: [{ label: lastSegment(path), body: String(input.body ?? '') }],
    writtenBy: input.writtenBy ?? 'user',
    authorUserId: input.authorUserId ?? null,
    brainId: brain.id,
    brainPath: path,
  });
}

// ── Live pages ───────────────────────────────────────────────────────────────

const ago = (iso: string | null) => {
  if (!iso) return '';
  const d = Math.floor((Date.now() - Date.parse(iso)) / DAY);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d < 60 ? `${d}d ago` : `${Math.floor(d / 30)}mo ago`;
};
// The first line that says something: headings are titles, not summaries.
const firstLine = (md: string, n = 180) => {
  const line = md.split('\n').filter(l => !/^\s*#/.test(l)).map(l => l.replace(/^[>*\-\s]+/, '').replace(/\*\*/g, '').trim()).find(Boolean) ?? '';
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};

async function livePage(supabase: SupabaseClient, workspaceId: string, s: BrainSnapshot, tree: BrainNode[], path: string, ctx?: ReadContext): Promise<string> {
  if (path === 'Overview') return overview(s);
  const meeting = s.meetings.find(m => m.path === path);
  if (meeting) return meetingPage(supabase, workspaceId, meeting, ctx, summaryOf(s, meeting));
  if (path === 'index') return rootIndex(supabase, workspaceId, s, tree);
  if (path === INTERNAL_INSIGHTS) return internalInsightsPage(s, clientMap(s));
  if (path.endsWith('/index')) return folderIndex(s, tree, path.slice(0, -'/index'.length));
  return '';
}

/**
 * The index is the brain's catalog (GET-449): what is in it, one line each with its age, the
 * clients it keeps coming back to, and where things are and where new things go. It is the first
 * thing an agent reads (pages { brain }), so it names every page it can open.
 */
async function rootIndex(supabase: SupabaseClient, workspaceId: string, s: BrainSnapshot, tree: BrainNode[]): Promise<string> {
  const decisions = decisionEntries(s);
  const pageCount = flatten(tree).length;
  const newest = [
    ...s.written.map(d => d.updated_at), ...s.playbooks.map(p => p.updated_at), ...s.meetings.map(m => m.date),
  ].filter((x): x is string => !!x).sort().pop() ?? null;

  // Purely an index: links, counts and dates. What the brain is for lives in its Overview.
  const out: string[] = [`# ${s.brain.name}`, ''];
  out.push(`_${[`${pageCount} pages`, `${decisions.length} decisions`, `${s.meetings.length} internal meetings`,
    newest ? `updated ${ago(newest)}` : ''].filter(Boolean).join(' · ')}_`, '');

  out.push('## Playbooks', '');
  for (const p of s.playbooks) out.push(`- [[Playbooks/${p.name}|${p.name}]] · ${p.content ? ago(p.updated_at) : 'not written yet'}`);
  const competitors = s.written.filter(d => inFolder(pathOf(d), 'Playbooks/Competitors'));
  out.push(`- [[Playbooks/Competitors/index|Competitors]]${competitors.length
    ? `: ${competitors.map(d => `[[${pathOf(d)}|${lastSegment(pathOf(d))}]]`).join(', ')}`
    : ' · none yet'}`, '');

  // Decisions: how many, and the latest five.
  out.push('## Decisions', '');
  if (decisions.length) {
    for (const e of decisions.slice(0, 5)) out.push(`- ${e.date} · ${e.heading}${e.meeting ? ` — [[${e.meeting.path}|${e.meeting.title}]]` : ''}`);
    out.push(`- → [[Decisions|All ${decisions.length} decisions]]`);
  } else out.push('_None recorded yet._');
  out.push('');

  // Internal meetings: the count, the latest five, and what was concluded across them.
  out.push(`## [[${MEETINGS_FOLDER}/index|${MEETINGS_FOLDER}]]`, '');
  out.push(`- [[${INTERNAL_INSIGHTS}|Internal Insights]]`);
  for (const m of s.meetings.slice(0, 5)) out.push(`- [[${m.path}|${m.title}]] · ${m.date ?? 'undated'}`);
  if (s.meetings.length > 5) out.push(`- → [[${MEETINGS_FOLDER}/index|All ${s.meetings.length} meetings]]`);
  if (!s.meetings.length) out.push('_None recorded yet._');
  out.push('');

  // Accounts: every client the internal meetings were about, and what the brain holds on each.
  const { accounts, unmatched } = await accountsAcrossBrain(supabase, workspaceId, s);
  if (accounts.length || unmatched.length) {
    out.push('## Accounts', '');
    for (const a of accounts) {
      out.push(`- **${a.name}**${a.relationship ? ` (${a.relationship})` : ''} · ${a.meetings.slice(0, 8).map(m => `[[${m.path}|${m.date ?? m.title}]]`).join(', ')}${a.meetings.length > 8 ? ` +${a.meetings.length - 8}` : ''}`);
    }
    out.push('');
  }

  const listed = (folder: string) => {
    const pages = s.written.filter(d => inFolder(pathOf(d), folder));
    return pages.length
      ? pages.map(d => `- [[${pathOf(d)}|${lastSegment(pathOf(d))}]] · ${ago(d.updated_at)}`)
      : ['_Empty._'];
  };
  out.push('## [[Working Documents/index|Working Documents]]', '', ...listed('Working Documents'), '');
  out.push('## [[Archive/index|Archive]]', '', ...listed('Archive'), '');

  out.push('## Where things are', '',
    '| Looking for | Page |', '| --- | --- |',
    '| Our positioning, ICP, market, distribution, pricing | Playbooks/<name> |',
    '| A competitor | Playbooks/Competitors/<Name> |',
    '| What we decided, and why | [[Decisions]] |',
    '| What customers and prospects say | the [Insights](/insights) page, not the brain |',
    `| What we concluded in our own meetings | [[${INTERNAL_INSIGHTS}|Internal Insights]] |`,
    '| What happened in one meeting | Internal Meetings/<date title> |',
    '| Where things stand right now | [[Overview]] |');
  return out.join('\n');
}

interface AccountInBrain { name: string; relationship: string | null; context: string | null; meetings: InternalMeeting[]; decisions: number; openIssues: number; insights: number }

/**
 * Every client the internal meeting summaries name, merged onto the account record it resolves to
 * ("Harborline", "Rowan" and "Rowan's company" are one account), most-discussed first. Names that
 * match no account are returned apart, so the section lists real accounts only.
 */
async function accountsAcrossBrain(
  supabase: SupabaseClient, workspaceId: string, s: BrainSnapshot,
): Promise<{ accounts: AccountInBrain[]; unmatched: string[] }> {
  const byName = new Map<string, AccountInBrain>();
  const get = (name: string) => {
    const k = name.trim().toLowerCase();
    if (!byName.has(k)) byName.set(k, { name: name.trim(), relationship: null, context: null, meetings: [], decisions: 0, openIssues: 0, insights: 0 });
    return byName.get(k)!;
  };
  for (const m of s.meetings) {
    const doc = summaryOf(s, m);
    if (!doc) continue;
    const sections = (doc.sections ?? []) as DocumentSection[];
    const named = new Set<string>();
    // "- **Harborline** (customer) — First client; demo Monday…" — meetings are newest first, so the
    // first context seen is the latest.
    for (const line of sectionText(sections.find(x => x.label === 'Accounts') ?? { label: '', body: '' }).split('\n')) {
      const a = /^- \*\*(.+?)\*\*(?: \((.+?)\))? — (.+)$/.exec(line.trim());
      if (!a) continue;
      const acc = get(a[1]);
      acc.relationship = acc.relationship ?? a[2] ?? null;
      acc.context = acc.context ?? a[3];
      named.add(acc.name.toLowerCase());
    }
    for (const g of parseMeetingSummarySections(sections).insights) {
      if (g.scope === OUR_BUSINESS) continue;
      const acc = get(g.scope);
      named.add(acc.name.toLowerCase());
      if (g.group === 'Decisions') acc.decisions += g.points.length;
      else if (g.group === 'Open issues') acc.openIssues += g.points.length;
      else acc.insights += g.points.length;
    }
    for (const k of named) byName.get(k)!.meetings.push(m);
  }

  // The stored map settles names the synthesis job has seen (GET-466); only a name it has not seen
  // yet is resolved live, so the index does not look a dozen names up on every view.
  const known = clientMap(s), notAccount = notAccounts(s);
  const merged = new Map<string, AccountInBrain>();
  const unmatched: string[] = [];
  for (const a of byName.values()) {
    let canonical: string | null = null;
    if (notAccount.has(a.name)) canonical = null;
    else if (known.has(a.name)) canonical = known.get(a.name)!;
    else canonical = (await resolveClientCompany(supabase, workspaceId, a.name).catch(() => null))?.name ?? null;
    if (!canonical) { unmatched.push(a.name); continue; }
    const into = merged.get(canonical);
    if (!into) { merged.set(canonical, { ...a, name: canonical, meetings: [...a.meetings] }); continue; }
    for (const m of a.meetings) if (!into.meetings.includes(m)) into.meetings.push(m);
    into.decisions += a.decisions; into.openIssues += a.openIssues; into.insights += a.insights;
    into.context = into.context ?? a.context; into.relationship = into.relationship ?? a.relationship;
  }
  for (const a of merged.values()) a.meetings.sort((x, y) => String(y.date ?? '').localeCompare(String(x.date ?? '')));
  return {
    accounts: [...merged.values()].sort((a, b) => b.meetings.length - a.meetings.length),
    unmatched: unmatched.filter(n => !/unnamed|unknown/i.test(n)),
  };
}

function folderIndex(s: BrainSnapshot, tree: BrainNode[], folder: string): string {
  const find = (nodes: BrainNode[]): BrainNode | null => {
    for (const n of nodes) {
      if (n.path === folder) return n;
      if (n.children) { const hit = find(n.children); if (hit) return hit; }
    }
    return null;
  };
  const node = find(tree);
  // An index lists what is filed here — a link and its age, nothing else (product decision, 2026-09-25).
  const lines = [`# ${lastSegment(folder)}`, ''];
  const children = (node?.children ?? []).filter(c => c.name !== 'index');
  if (!children.length) {
    lines.push('_Empty._');
    return lines.join('\n');
  }
  for (const c of children) {
    const target = c.kind === 'folder' ? `${c.path}/index` : c.path;
    const unwritten = c.page === 'playbook' && !s.playbooks.find(x => x.name === c.name)?.content;
    const meta = unwritten ? 'not written yet' : c.updated_at ? ago(c.updated_at) : '';
    lines.push(`- [[${target}|${c.name}]]${meta ? ` · ${meta}` : ''}`);
  }
  return lines.join('\n');
}

// The Overview is three things (product decision, 2026-09-25): where each playbook stands, what we decided
// in the last ten months, and what needs a look. Insights and meetings have their own folders;
// repeating them here made the page long and the brain harder to read, not easier.
const DECISION_WINDOW_DAYS = 300;
const DECISION_HEADING = /^##\s+(\d{4}-\d{2}-\d{2})\s*[·\-—:]?\s*(.*)$/;

function overview(s: BrainSnapshot): string {
  const out: string[] = [`# ${s.brain.name}`, '', s.brain.charter || DEFAULT_CHARTER, ''];

  out.push('## Where we stand', '');
  for (const p of s.playbooks) {
    const stale = p.updated_at && Date.now() - Date.parse(p.updated_at) > 45 * DAY;
    out.push(p.content
      ? `- **[[Playbooks/${p.name}|${p.name}]]** — ${firstLine(p.content)} _(${ago(p.updated_at)}${stale ? ', due a look' : ''})_`
      : `- **[[Playbooks/${p.name}|${p.name}]]** — _not written yet_`);
  }
  const competitors = s.written.filter(d => inFolder(pathOf(d), 'Playbooks/Competitors'));
  out.push(`- **[[Playbooks/Competitors/index|Competitors]]** — ${competitors.length
    ? competitors.map(d => `[[${pathOf(d)}|${lastSegment(pathOf(d))}]]`).join(', ')
    : '_no competitor pages yet_'}`, '');

  // Decisions of the last ten months: the written log and the meetings, newest first.
  const since = Date.now() - DECISION_WINDOW_DAYS * DAY;
  const recent = decisionEntries(s).filter(e => Date.parse(e.date) >= since).slice(0, 12);
  out.push('## Latest decisions', '');
  out.push(...(recent.length ? recent.map(e => `- ${e.date} · ${e.heading}${e.meeting ? ` — [[${e.meeting.path}|${e.meeting.title}]]` : ''}`) : ['_None recorded yet._']));
  out.push('', '→ [[Decisions]]');

  const attention = [
    ...s.playbooks.filter(p => s.written.some(w => pathOf(w) === proposalPath(p.name)))
      .map(p => `- [[Playbooks/${p.name}|${p.name}]] has a proposed update waiting for review`),
    ...s.playbooks.filter(p => !p.content).map(p => `- [[Playbooks/${p.name}|${p.name}]] is not written yet`),
    ...s.playbooks.filter(p => p.content && p.updated_at && Date.now() - Date.parse(p.updated_at) > 45 * DAY)
      .map(p => `- [[Playbooks/${p.name}|${p.name}]] last changed ${ago(p.updated_at)}`),
  ];
  if (attention.length) out.push('', '## Needs attention', '', ...attention);
  return out.join('\n');
}

const TRANSCRIPT_SPLIT = /\n*[—-]{3,}\s*Transcript\s*[—-]{3,}\n*/;

/** The recorder behind a `source://<system>/…` ref: its name and its logo in /provider-logos. */
const RECORDERS: Record<string, { name: string; logo: string }> = {
  fireflies: { name: 'Fireflies', logo: 'fireflies.svg' },
  granola: { name: 'Granola', logo: 'granola.svg' },
  fathom: { name: 'Fathom', logo: 'fathom.svg' },
  fellow: { name: 'Fellow', logo: 'fellow.png' },
  ringcentral: { name: 'RingCentral', logo: 'ringcentral.svg' },
};

/** One internal meeting: who was there, the notes (as the raw-visibility rule allows) and what
 *  the team-insight extractor took from it. Read-only — the recording is the source. */
async function meetingPage(supabase: SupabaseClient, workspaceId: string, m: InternalMeeting, ctx?: ReadContext, summary?: DocumentRow): Promise<string> {
  const [labels, notes, insights] = await Promise.all([
    labelEntities(supabase, workspaceId, m.attendeeIds),
    supabase.from('claims').select('content:value->>content').eq('workspace_id', workspaceId)
      .like('property', 'note.%').is('invalid_at', null).eq('value->metadata->>source_ref', m.ref).limit(1),
    supabase.from('insight_items').select('category, statement, quote, speaker')
      .eq('workspace_id', workspaceId).eq('source', 'team').eq('source_ref', m.ref).limit(50),
  ]);
  if (notes.error) throw notes.error;
  if (insights.error) throw insights.error;

  // The host recorded the call and is not an attendee on record ("us"), so add them by name.
  const { data: host } = m.ownerUserId
    ? await supabase.from('users').select('name').eq('id', m.ownerUserId).maybeSingle()
    : { data: null };
  const names = [...new Set([host?.name, ...m.attendeeIds.map(id => labels.get(id)?.name)].filter((n): n is string => !!n))];
  const meta = [m.date, m.duration ? `${Math.round(m.duration)} min` : '', names.join(', ')].filter(Boolean).join(' · ');
  const out = [`# ${m.title}`, '', `_${meta}_`, ''];

  // Under the title: the recorder, and the way to the full transcript. The transcript itself is not
  // on the page (product decision, 2026-09-25) — it is kept as the raw record behind the summary, one click away.
  const visible = rawVisible(m.ownerUserId, ctx);
  const system = RECORDERS[m.ref.split('/')[2] ?? ''];
  if (system) {
    const logo = `![](/provider-logos/${system.logo})`;
    // The meeting as the recorder names it, linked to its transcript there.
    out.push(visible && m.transcriptUrl
      ? `${logo} [${m.title}](${m.transcriptUrl})`
      : `${logo} ${m.title}${visible ? '' : ' · transcript with the host'}`, '');
  }

  if (summary) {
    for (const sec of (summary.sections ?? []) as DocumentSection[]) out.push(`## ${sec.label}`, '', sectionText(sec), '');
    return out.join('\n');
  }

  // No summary yet: what the team-insight extractor took from it, and the recorder's own notes.
  const team = (insights.data ?? []) as { category: string; statement: string; quote: string | null; speaker: string | null }[];
  for (const [key, label] of Object.entries(TEAM_CATEGORY_LABEL)) {
    const list = team.filter(t => t.category === key);
    if (!list.length) continue;
    out.push(`## ${label}`, '');
    for (const t of list) out.push(`- ${t.statement}${t.quote ? `\n  > "${t.quote}"${t.speaker ? ` — ${t.speaker}` : ''}` : ''}`);
    out.push('');
  }
  if (visible) {
    const content = String((notes.data?.[0] as { content?: string } | undefined)?.content ?? '');
    const notesOnly = content.split(TRANSCRIPT_SPLIT)[0].trim();
    if (notesOnly) out.push('## Notes', '', notesOnly.length > 6000 ? `${notesOnly.slice(0, 6000).trimEnd()}…` : notesOnly, '');
  }
  return out.join('\n');
}


/** Internal insights: what the team concluded in its own meetings, by scope then topic — our own
 *  business first, then one section per client — each point linked to the meeting it came from. */
/** Where each topic's "what we believe now" is stored (GET-466, db/insightSynthesis.ts). Hidden from the tree. */
const SYNTHESIS = '_synthesis/';

/**
 * The stored client-name map (summary name → account name), kept current by the synthesis job so
 * a page view never resolves names itself. A name → itself when the map says it is no account.
 */
function clientMap(s: BrainSnapshot): Map<string, string> {
  const doc = s.written.find(d => pathOf(d) === `${SYNTHESIS}_clients`);
  const out = new Map<string, string>();
  try {
    const m = JSON.parse(doc ? textOf(doc) : '{}') as Record<string, string | null>;
    for (const [k, v] of Object.entries(m)) out.set(k, v ?? k);
  } catch { /* an unreadable map is an empty one */ }
  return out;
}

/** Summary names the stored map knows are NOT accounts. */
function notAccounts(s: BrainSnapshot): Set<string> {
  const doc = s.written.find(d => pathOf(d) === `${SYNTHESIS}_clients`);
  try {
    const m = JSON.parse(doc ? textOf(doc) : '{}') as Record<string, string | null>;
    return new Set(Object.entries(m).filter(([, v]) => v == null).map(([k]) => k));
  } catch { return new Set(); }
}

/**
 * Internal Insights: what the team believes now (GET-466). Our business first, then each client;
 * under each, one topic at a time — the stored synthesis (the current position, citing its
 * meetings, and what changed) where there is one, the raw points from the meetings where not yet.
 */
function internalInsightsPage(s: BrainSnapshot, alias: Map<string, string> = new Map()): string {
  const out = ['# Internal Insights', ''];
  const byScope = new Map<string, Map<string, string[]>>();
  for (const m of s.meetings) {
    const doc = summaryOf(s, m);
    if (!doc) continue;
    const link = `[[${m.path}|${m.date ?? m.title}]]`;
    for (const g of parseMeetingSummarySections((doc.sections ?? []) as DocumentSection[]).insights) {
      const scope = alias.get(g.scope) ?? g.scope;
      const groups = byScope.get(scope) ?? new Map<string, string[]>();
      groups.set(g.group, [...(groups.get(g.group) ?? []), ...g.points.map(p => `- ${p} · ${link}`)]);
      byScope.set(scope, groups);
    }
  }
  if (!byScope.size) return [...out, '_Nothing yet._'].join('\n');
  const clean = (v: string) => v.replace(/[\/\\]/g, '-').trim();
  const synthesis = new Map(s.written.filter(d => pathOf(d).startsWith(SYNTHESIS)).map(d => [pathOf(d), d]));
  // Our business first, then the clients the team talks about most.
  const weight = (scope: string) => [...(byScope.get(scope)?.values() ?? [])].reduce((n, pts) => n + pts.length, 0);
  const scopes = [...byScope.keys()].sort((a, b) => (a === OUR_BUSINESS ? -1 : b === OUR_BUSINESS ? 1 : weight(b) - weight(a)));
  for (const scope of scopes) {
    out.push(`## ${scope}`, '');
    const groups = [...byScope.get(scope)!].sort((a, b) => b[1].length - a[1].length);
    for (const [group, pts] of groups) {
      const doc = synthesis.get(`${SYNTHESIS}${clean(scope)}/${clean(group)}`);
      out.push(`### ${group}`, '', ...(doc ? [textOf(doc)] : pts), '');
    }
  }
  return out.join('\n');
}

interface DecisionEntry {
  date: string; heading: string; body: string; meeting: InternalMeeting | null;
  /** For the table (GET-462): the decision in one line, who owns it, and whether it was deferred. */
  description: string; owner: string | null; deferred: boolean;
}

/** Every decision, newest first: the written log's `## YYYY-MM-DD · …` entries and each internal
 *  meeting's company decisions. Client decisions stay with the client in the meeting's Insights. */
function decisionEntries(s: BrainSnapshot): DecisionEntry[] {
  const out: DecisionEntry[] = [];
  const written = s.written.find(d => pathOf(d) === 'Decisions');
  if (written) {
    let cur: DecisionEntry | null = null;
    for (const line of textOf(written).split('\n')) {
      const m = DECISION_HEADING.exec(line.trim());
      if (m) { cur = { date: m[1], heading: m[2] || 'Decision', body: '', meeting: null, description: '', owner: null, deferred: false }; out.push(cur); continue; }
      if (cur) cur.body += `${line}\n`;
    }
    for (const e of out) {
      e.description = firstLine(e.body, 240);
      e.deferred = /\bdeferred\b/i.test(e.body.split('\n').slice(0, 3).join(' '));
    }
  }
  for (const m of s.meetings) {
    const doc = summaryOf(s, m);
    if (!doc || !m.date) continue;
    for (const d of parseMeetingSummarySections((doc.sections ?? []) as DocumentSection[]).decisions) {
      const lines = [d.decision];
      if (d.meta) lines.push(`_${d.meta}_`);
      if (d.quote) lines.push(`> "${d.quote}"`);
      // meta reads "Owner · Deferred · from Harborline", each part optional.
      const parts = (d.meta ?? '').split('·').map(x => x.trim()).filter(Boolean);
      out.push({
        date: m.date, heading: d.topic, body: lines.join('\n\n'), meeting: m,
        description: d.decision.replace(/^\*\*Deferred\.\*\*\s*/, ''),
        owner: parts.find(x => x !== 'Deferred' && !x.startsWith('from ')) ?? null,
        deferred: parts.includes('Deferred'),
      });
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * The Decisions log as tables, one per month, newest first (GET-462): Date · Decision · Description ·
 * Owner · Meeting. 186 headed entries with quotes were a scroll nobody could compare across; the
 * quote stays on the meeting page, one click away, and the editor still edits the written entries.
 */
function decisionsPage(s: BrainSnapshot): string {
  const written = s.written.find(d => pathOf(d) === 'Decisions');
  const entries = decisionEntries(s);
  const out: string[] = [];
  // Anything in the written log that is not a dated entry (a preface, a note) stays on top.
  const preface = written ? textOf(written).split(/\n(?=##\s+\d{4}-\d{2}-\d{2})/)[0] : '';
  if (preface && !DECISION_HEADING.test(preface.trim().split('\n')[0] ?? '')) out.push(preface.trim(), '');
  if (!entries.length) { out.push('_No decisions yet._'); return out.join('\n'); }

  const cell = (v: string | null | undefined) => String(v ?? '').replace(/\|/g, '/').replace(/\s*\n\s*/g, ' ').trim() || '—';
  const monthOf = (d: string) => new Date(`${d.slice(0, 7)}-01T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const dayOf = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  let month = '';
  for (const e of entries) {
    const m = monthOf(e.date);
    if (m !== month) {
      if (month) out.push('');
      month = m;
      out.push(`## ${m}`, '', '| Date | Decision | Description | Owner | Meeting |', '| --- | --- | --- | --- | --- |');
    }
    out.push(`| ${dayOf(e.date)} | **${cell(e.heading)}** | ${e.deferred ? '**Deferred.** ' : ''}${cell(e.description)} | ${cell(e.owner)} | ${e.meeting ? `[[${e.meeting.path}|${cell(e.meeting.title)}]]` : '—'} |`);
  }
  return out.join('\n');
}


/**
 * What a playbook proposal is drafted from (GET-470), and whether one is due: the playbook, what the
 * team believes on its topics, the decisions since it last changed, and the competitor pages.
 * `due` when it is unwritten or 45 days old with no proposal waiting, or when its evidence moved
 * since the playbook changed and since the last proposal.
 */
export async function playbookEvidence(supabase: SupabaseClient, workspaceId: string, brain: Brain) {
  const s = await snapshot(supabase, workspaceId, brain);
  const clean = (v: string) => v.replace(/[\/\\]/g, '-').trim();
  const decisions = decisionEntries(s);
  const competitors = s.written.filter(d => inFolder(pathOf(d), 'Playbooks/Competitors'))
    .map(d => `### ${lastSegment(pathOf(d))}\n${textOf(d).slice(0, 2500)}`).join('\n\n');
  return s.playbooks.map(p => {
    const since = p.updated_at ?? '1970-01-01';
    const beliefDocs = (PLAYBOOK_TOPICS[p.name] ?? []).map(t => s.written.find(d => pathOf(d) === `${SYNTHESIS}Our business/${clean(t)}`)).filter((d): d is DocumentRow => !!d);
    const newDecisions = decisions.filter(e => e.date > since.slice(0, 10));
    const draft = s.written.find(d => pathOf(d) === proposalPath(p.name));
    const evidenceAt = [...beliefDocs.map(d => d.updated_at), ...newDecisions.map(e => e.date)].sort().pop() ?? null;
    const stale = !p.updated_at || Date.now() - Date.parse(p.updated_at) > 45 * DAY;
    const moved = !!evidenceAt && evidenceAt > since && (!draft || evidenceAt > draft.created_at);
    return {
      name: p.name,
      current: p.content,
      due: (!draft && stale) || moved,
      reason: !p.content ? 'not written yet' : moved ? 'new evidence since it last changed' : stale ? `unchanged for ${ago(p.updated_at)}` : null,
      beliefs: beliefDocs.map(d => `### ${String(d.title ?? '').replace(/^Our business · /, '')}\n${textOf(d)}`).join('\n\n'),
      decisions: newDecisions.slice(0, 60).map(e => `- ${e.date} · ${e.heading}: ${e.description}${e.meeting ? ` ([[${e.meeting.path}|${e.meeting.title}]])` : ''}`).join('\n'),
      competitors,
    };
  });
}

export interface BrainSearchHit { path: string; title: string; kind: string; snippet: string; score: number }

/**
 * Search the brain by what it says (GET-471): playbooks, written pages, decisions, each meeting's
 * summary and what the team believes per topic. Every word of the query must appear; a hit in the
 * title counts more. The brain is small (tens of pages), so this reads the snapshot in memory.
 */
export async function searchBrain(supabase: SupabaseClient, workspaceId: string, brain: Brain, query: string, limit = 30): Promise<BrainSearchHit[]> {
  // Words that carry meaning, stemmed so "pricing" finds "priced" and "task" finds "tasks".
  const STOP = new Set(['the', 'and', 'for', 'per', 'with', 'from', 'our', 'we', 'of', 'to', 'in', 'on', 'at', 'by', 'is', 'a', 'an', 'or', 'what', 'did', 'do', 'about']);
  const stem = (t: string) => (t.length > 4 ? t.replace(/(ing|ed|es|s)$/, '') : t);
  const terms = query.toLowerCase().split(/[^a-z0-9$%]+/).map(t => t.trim()).filter(t => t.length >= 2 && !STOP.has(t)).map(stem);
  if (!terms.length) return [];
  const s = await snapshot(supabase, workspaceId, brain);
  const docs: { path: string; title: string; kind: string; text: string }[] = [];
  for (const p of s.playbooks) if (p.content) docs.push({ path: `Playbooks/${p.name}`, title: p.name, kind: 'Playbook', text: p.content });
  for (const d of s.written) {
    const path = pathOf(d);
    if (path === 'Decisions' || path.startsWith(PROPOSAL_PREFIX)) continue;
    if (path.startsWith(SYNTHESIS)) {
      if (path === `${SYNTHESIS}_clients` || path === `${SYNTHESIS}_client_aliases`) continue;
      docs.push({ path: INTERNAL_INSIGHTS, title: `Internal Insights · ${String(d.title ?? '')}`, kind: 'What we believe', text: textOf(d) });
      continue;
    }
    docs.push({ path, title: lastSegment(path), kind: inFolder(path, 'Playbooks/Competitors') ? 'Competitor' : 'Page', text: textOf(d) });
  }
  for (const e of decisionEntries(s)) docs.push({ path: 'Decisions', title: `${e.date} · ${e.heading}`, kind: 'Decision', text: `${e.heading}\n${e.description}${e.owner ? `\n${e.owner}` : ''}` });
  for (const m of s.meetings) {
    const doc = summaryOf(s, m);
    const text = doc ? ((doc.sections ?? []) as DocumentSection[]).map(sectionText).join('\n') : '';
    docs.push({ path: m.path, title: m.title, kind: `Meeting · ${m.date ?? ''}`, text: `${m.title}\n${text}` });
  }
  // Word starts, so "AI" does not match inside "email" (a short word must be whole); the exact
  // phrase ranks first.
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const word = terms.map(t => new RegExp(`(^|[^a-z0-9])${esc(t)}${t.length <= 3 ? '(?=$|[^a-z0-9])' : ''}`, 'gi'));
  const phrase = terms.length > 1 ? query.trim().toLowerCase() : null;
  const hits: BrainSearchHit[] = [];
  for (const d of docs) {
    const hay = d.text.toLowerCase(), title = d.title.toLowerCase();
    if (!word.every(re => { re.lastIndex = 0; const inHay = re.test(hay); re.lastIndex = 0; return inHay || re.test(title); })) continue;
    let score = 0;
    for (const re of word) { score += (hay.match(re) ?? []).length + ((title.match(re) ?? []).length ? 5 : 0); }
    if (phrase && (hay.includes(phrase) || title.includes(phrase))) score += 20;
    const firstAt = (re: RegExp) => { re.lastIndex = 0; const m = re.exec(hay); return m ? m.index : Infinity; };
    const at = phrase && hay.includes(phrase) ? hay.indexOf(phrase) : Math.max(0, Math.min(...word.map(firstAt)));
    const from = Number.isFinite(at) ? Math.max(0, at - 70) : 0;
    const snippet = d.text.slice(from, from + 200).replace(/\s+/g, ' ').replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (_m, a, b) => b || a).trim();
    hits.push({ path: d.path, title: d.title, kind: d.kind, snippet: `${from > 0 ? '…' : ''}${snippet}${d.text.length > from + 200 ? '…' : ''}`, score });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

