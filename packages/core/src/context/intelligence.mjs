// The Intelligence files, read for the next action (GET-1042). Registered with the public hook in
// ../intelligenceContext.mjs; see there for who asks and why.
//
// A file is a row in workspace_living_files (key, enabled, file_id, doc) pointing at its
// workspace_context_files row, whose body is the markdown people see. `doc` is the structure
// OpenNous last wrote: sections with stable block ids (api cloud lib/livingDoc.mjs). When someone
// edited the body by hand since, the body wins, read the same way, with the stored ids kept for the
// blocks whose text is unchanged.
//
// For an account, the sections are picked by what is open on it: its unresolved objections and the
// competitors named on it (by their canonical market-entity names when they have one). Win/loss is
// read from the top, because why we win and lose bears on every deal. The ICP's learned block
// (which signals predict a win) comes last.
import { registerIntelligenceSource } from '../intelligenceContext.mjs';
import { learnedBlockOf } from './library.mjs';

// The order a reader sees them in, and what each file is for.
const FILES = [
  { key: 'objections', title: 'Objection playbook', pick: 'objection' },
  { key: 'battlecards', title: 'Battlecards', pick: 'competitor' },
  { key: 'win_loss', title: 'Win/loss', pick: 'top' },
];
const WORD_MIN = 4;
const STOP = new Set(['about', 'after', 'again', 'also', 'because', 'before', 'being', 'buyer', 'buyers', 'could', 'deal', 'deals',
  'does', 'from', 'have', 'into', 'just', 'more', 'most', 'much', 'need', 'needs', 'only', 'other', 'over', 'said', 'same', 'should',
  'some', 'such', 'than', 'that', 'their', 'them', 'then', 'there', 'they', 'this', 'those', 'very', 'want', 'wants', 'were', 'what',
  'when', 'which', 'will', 'with', 'would', 'your', 'ours']);

const missing = (e) => ['42P01', '42703', 'PGRST205', 'PGRST204'].includes(e?.code);

/** Significant words of a text, lower case. Pure. */
export function wordsOf(text) {
  return new Set(String(text ?? '').toLowerCase().match(/[a-z0-9][a-z0-9'-]+/g)?.filter(w => w.length >= WORD_MIN && !STOP.has(w)) ?? []);
}

/**
 * Sections of a stored doc, or of the body when it was edited by hand since (or there is no doc).
 * Ids of unchanged blocks are kept; a new block gets a content id, so the same text always has the
 * same id. Pure. → [{ id, heading, blocks: [{ id, text }] }]
 */
export function sectionsOf(doc, body) {
  const stored = Array.isArray(doc?.sections) ? doc.sections : [];
  const render = stored.map(s => [s.heading ? `${'#'.repeat(s.level || 2)} ${s.heading}` : '', ...s.blocks.map(b => b.text)].filter(Boolean).join('\n\n')).join('\n\n');
  if (stored.length && (!body || norm(render) === norm(body))) return stored.map(s => ({ id: s.id, heading: s.heading ?? '', blocks: s.blocks ?? [] }));
  const known = new Map(stored.flatMap(s => s.blocks ?? []).map(b => [norm(b.text), b.id]));
  const out = [];
  let cur = { id: 'preamble', heading: '', blocks: [] };
  for (const chunk of String(body ?? '').split(/\n{2,}/)) {
    const t = chunk.trim();
    if (!t) continue;
    const h = t.match(/^(#{1,6})\s+(.+)$/);
    if (h && !t.includes('\n')) {
      if (cur.heading || cur.blocks.length) out.push(cur);
      cur = { id: slug(h[2]), heading: h[2].trim(), blocks: [] };
      continue;
    }
    cur.blocks.push({ id: known.get(norm(t)) ?? `h${hash(t)}`, text: t });
  }
  if (cur.heading || cur.blocks.length) out.push(cur);
  return out;
}

/**
 * The sections that bear on `terms` (sets of words, one per open objection or competitor), best
 * first: a section scores by how many of a term's words its heading holds (thrice) and its text
 * holds. A section with no score is left out. Pure.
 */
export function pickSections(sections, terms) {
  const scored = [];
  for (const s of sections) {
    if (!s.heading) continue;
    const head = wordsOf(s.heading);
    const body = wordsOf(s.blocks.map(b => b.text).join(' '));
    let score = 0;
    for (const t of terms) {
      let hit = 0;
      for (const w of t) hit += head.has(w) ? 3 : body.has(w) ? 1 : 0;
      score = Math.max(score, hit / Math.max(1, t.size));
    }
    if (score >= 0.5) scored.push({ s, score });
  }
  return scored.sort((a, b) => b.score - a.score).map(x => x.s);
}

/** One section as markdown, each point ending in its id, cut to `room` characters. Pure. */
export function renderSection(key, title, s, room) {
  const head = `### ${title}${s.heading ? ` — ${s.heading}` : ''}`;
  const lines = [head];
  let used = head.length;
  const blocks = [];
  for (const b of s.blocks) {
    const text = String(b.text).replace(/^_.*_$/s, '').trim();   // the italic preamble lines are not points
    if (!text || /^_No .* read yet\._$/.test(b.text.trim())) continue;
    const line = `${text} [${key}:${b.id}]`;
    if (used + line.length + 2 > room) break;
    lines.push(line);
    used += line.length + 2;
    blocks.push(b.id);
  }
  return blocks.length ? { text: lines.join('\n\n'), blocks } : null;
}

/** What is open on the account: words per open objection, per competitor named on it. */
async function openOnAccount(sb, ws, companyId) {
  const { data: rels } = await sb.from('relationships').select('from_entity_id').eq('workspace_id', ws)
    .eq('type', 'works_at').eq('to_entity_id', companyId).is('valid_to', null).limit(200);
  const ids = [companyId, ...(rels ?? []).map(r => r.from_entity_id)];
  const { data } = await sb.from('claims').select('value').eq('workspace_id', ws).in('entity_id', ids)
    .like('property', 'note.%').is('invalid_at', null).in('value->>category', ['objection', 'competitor']).limit(200);
  const objections = [];
  const competitors = [];
  const entityIds = new Set();
  for (const c of data ?? []) {
    const v = c.value ?? {};
    const m = v.metadata ?? {};
    if (m.side === 'ours') continue;
    if (v.category === 'objection') {
      if (m.status && m.status !== 'open') continue;
      objections.push(wordsOf(`${v.label ?? ''} ${v.content ?? ''}`));
    } else {
      if (m.market_entity_id) entityIds.add(m.market_entity_id);
      competitors.push(wordsOf(v.label || v.content));
    }
  }
  if (entityIds.size) {
    const { data: ents } = await sb.from('market_entities').select('canonical_name').eq('workspace_id', ws).in('id', [...entityIds]);
    for (const e of ents ?? []) competitors.push(wordsOf(e.canonical_name));
  }
  return { objection: objections.filter(t => t.size), competitor: competitors.filter(t => t.size) };
}

/** The registered source: see intelligenceFor in ../intelligenceContext.mjs. */
export async function readIntelligence(sb, ws, { companyId = null, purpose = 'brief', budget = 3500 } = {}) {
  const { data: rows, error } = await sb.from('workspace_living_files').select('key, enabled, file_id, doc').eq('workspace_id', ws).eq('enabled', true);
  if (error) { if (missing(error)) return null; throw error; }
  const byKey = new Map((rows ?? []).filter(r => r.file_id).map(r => [r.key, r]));
  const fileIds = [...byKey.values()].map(r => r.file_id);
  const { data: files } = fileIds.length
    ? await sb.from('workspace_context_files').select('id, body').eq('workspace_id', ws).in('id', fileIds)
    : { data: [] };
  const bodyOf = new Map((files ?? []).map(f => [f.id, f.body ?? '']));
  const open = companyId ? await openOnAccount(sb, ws, companyId) : null;

  const parts = [];
  const used = [];
  let room = budget;
  for (const f of FILES) {
    const row = byKey.get(f.key);
    if (!row || room < 200) continue;
    const sections = sectionsOf(row.doc, bodyOf.get(row.file_id));
    // For an account: the objection and competitor sections it bears on; nothing open, nothing
    // picked. Without an account, or for Win/loss: the file from the top.
    const picked = open && f.pick !== 'top' ? pickSections(sections, open[f.pick]) : sections.filter(s => s.heading);
    const share = f.pick === 'top' && open ? Math.min(room, Math.ceil(budget / 3)) : room;
    let left = share;
    for (const s of picked) {
      if (left < 200) break;
      const r = renderSection(f.key, f.title, s, left);
      if (!r) continue;
      parts.push(r.text);
      used.push({ key: f.key, section: s.id, blocks: r.blocks });
      left -= r.text.length + 2;
      room -= r.text.length + 2;
    }
  }
  // The ICP's learned block: what closed deals say predicts a win. Short, and the same for every account.
  if (room >= 300) {
    const { data: icp } = await sb.from('workspace_context_files').select('body').eq('workspace_id', ws).eq('kind', 'icp').maybeSingle();
    const block = learnedBlockOf(icp?.body);
    if (block) {
      const text = block.replace(/<!--[^>]*-->/g, '').trim().slice(0, room - 40);
      if (text) { parts.push(`### What predicts a win (learned from closed deals) [icp:learned]\n\n${text}`); used.push({ key: 'icp', section: 'learned', blocks: ['learned'] }); }
    }
  }
  if (!parts.length) return null;
  const lead = purpose === 'draft'
    ? 'What this workspace has learned, for this account. Use an answer that has worked before; never quote this text to the buyer.'
    : 'What this workspace has learned, for this account.';
  return { text: `## Intelligence\n\n_${lead}_\n\n${parts.join('\n\n')}`, used };
}

registerIntelligenceSource(readIntelligence);

function norm(s) { return String(s ?? '').replace(/\s+/g, ' ').trim(); }
function slug(h) { return String(h).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section'; }
function hash(s) {
  let h = 2166136261;
  for (const ch of norm(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
