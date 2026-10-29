// Intelligence v2, "edit, don't rewrite" (GET-1054): the document model behind a living file, and
// the edit operations the writing model sends instead of a whole new file.
//
// Why: each hourly pass used to ask the model to rewrite the whole file around a dozen new items.
// Every rewrite could quietly drop or reword what earlier items (and the people who hand-edit the
// file) had put there, because the model only ever saw the new batch. Now the file is a list of
// sections, each a list of blocks with a persistent id, and the model answers with small operations
// on those ids. Anything no operation touches stays byte-for-byte.
//
// Ported from Hindsight (MIT, Copyright (c) 2025 Vectorize AI, Inc.; see THIRD_PARTY_NOTICES.md):
// hindsight_api/engine/reflect/structured_doc.py (the splitter, renderer and id scheme),
// delta_ops.py (the operation shapes and how they are applied) and prompts.py
// STRUCTURED_DELTA_SYSTEM_PROMPT (the editing rules, adapted in EDIT_RULES below).
//
// Everything here is pure: no database, no model. livingFiles.mjs wires it into the pass.
import { createHash } from 'node:crypto';

const HEADING = /^(#{1,6})\s+(.*\S)\s*$/;
const FENCE = /^\s*(```+|~~~+)/;
// The section that holds what comes before the first heading (none in a file OpenNous made).
export const PREAMBLE_ID = 'preamble';

const sha8 = (text) => createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 8);
/** A heading's section id: "Why we lose" -> "why-we-lose". Pure. */
export const slugify = (heading) => String(heading ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
function unique(base, used) {
  let id = base;
  for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
  used.add(id);
  return id;
}
/** A new block's id: "b" + sha1(text)[:8], made unique in the doc. Assigned once, kept when the text
 *  changes (GET-1054), so an id never shifts under an edit the way an index would. */
export const newBlockId = (text, used) => unique(`b${sha8(text)}`, used);

// Blank lines around a fragment are separators, not content; the renderer puts them back. Inside,
// every byte is kept (trailing double spaces, code indents).
function trimBlankLines(text) {
  const lines = String(text ?? '').split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  return lines.join('\n');
}

// A fence closes only on the same character, at least as long as the one that opened it (CommonMark).
const fenceStep = (open, mark) => open === null ? mark : (mark[0] === open[0] && mark.length >= open.length ? null : open);
/** Whether a fragment leaves a code fence open (it would swallow every heading after it). Pure. */
export function unclosedFence(text) {
  let open = null;
  for (const line of String(text ?? '').split('\n')) { const m = FENCE.exec(line); if (m) open = fenceStep(open, m[1]); }
  return open !== null;
}

// The only place markdown is inspected: ATX headings (section boundaries) and blank lines (block
// boundaries), neither honoured inside a fenced code block. A paragraph, a list, a table or a code
// block is one block each; nothing is "understood", so nothing can be retyped.
function splitRaw(markdown) {
  const sections = [];
  let current = null, pending = [], fence = null;
  const blocksOf = (lines) => {
    const out = []; let buf = [], f = null;
    const flush = () => { const t = trimBlankLines(buf.join('\n')); buf = []; if (t.trim()) out.push(t); };
    for (const line of lines) {
      const m = FENCE.exec(line);
      if (m) { f = fenceStep(f, m[1]); buf.push(line); continue; }
      if (f === null && !line.trim()) { flush(); continue; }
      buf.push(line);
    }
    flush();
    return out;
  };
  const close = (s) => { s.blocks = blocksOf(pending); pending = []; sections.push(s); };
  for (const line of String(markdown ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const m = FENCE.exec(line);
    if (m) { fence = fenceStep(fence, m[1]); pending.push(line); continue; }
    const h = fence === null ? HEADING.exec(line) : null;
    if (!h) { pending.push(line); continue; }
    if (current) close(current);
    else if (pending.some(l => l.trim())) close({ heading: '', level: 2 });
    else pending = [];
    current = { heading: h[2].trim(), level: h[1].length };
  }
  if (current) close(current);
  else if (pending.some(l => l.trim())) close({ heading: '', level: 2 });
  return sections;
}

/** A fragment of model text as blocks: "a\n\nb" is two. Pure. */
export const fragments = (text) => splitRaw(String(text ?? '')).flatMap(s => s.blocks);

/**
 * Markdown -> { sections: [{ id, heading, level, blocks: [{ id, text }] }] }. Pure.
 * With `prior` (the doc as OpenNous last wrote it), ids are kept wherever they can be: a section whose
 * heading is unchanged keeps its id; a block whose text is unchanged keeps its id (same section first,
 * then anywhere, so a moved block keeps it too); a block edited in place (same section, same position,
 * its old text gone) keeps its id. That is how a hand edit is taken in (GET-1054) without every id
 * the model has seen moving. Everything else gets a new id.
 */
export function parseDoc(markdown, prior = null) {
  const raw = splitRaw(markdown);
  const priorSections = prior?.sections ?? [];
  const used = new Set();
  // Sections: same heading (case-insensitive) first, in order.
  const freeSec = new Map();
  for (const s of priorSections) { const k = s.heading.trim().toLowerCase(); if (!freeSec.has(k)) freeSec.set(k, []); freeSec.get(k).push(s); }
  const matched = raw.map(s => { const q = freeSec.get(s.heading.trim().toLowerCase()); const p = q?.shift() ?? null; if (p) used.add(p.id); return p; });
  const sections = raw.map((s, i) => ({ id: matched[i]?.id ?? null, heading: s.heading, level: s.level, blocks: s.blocks.map(text => ({ id: null, text })) }));
  for (const s of sections) if (!s.id) s.id = unique(s.heading ? slugify(s.heading) : PREAMBLE_ID, used);
  // Blocks, pass 1: unchanged text in the matched section; pass 2: unchanged text anywhere.
  const taken = new Set();
  const take = (b, p) => { b.id = p.id; taken.add(p.id); used.add(p.id); };
  sections.forEach((s, i) => {
    const p = matched[i]; if (!p) return;
    for (const b of s.blocks) { const hit = p.blocks.find(pb => !taken.has(pb.id) && pb.text === b.text); if (hit) take(b, hit); }
  });
  const anywhere = priorSections.flatMap(s => s.blocks);
  for (const s of sections) for (const b of s.blocks) if (!b.id) { const hit = anywhere.find(pb => !taken.has(pb.id) && pb.text === b.text); if (hit) take(b, hit); }
  // Pass 3: edited in place: the prior block at the same position, if its text is no longer anywhere.
  const stillThere = new Set(sections.flatMap(s => s.blocks.map(b => b.text)));
  sections.forEach((s, i) => {
    const p = matched[i]; if (!p) return;
    s.blocks.forEach((b, j) => { const pb = p.blocks[j]; if (!b.id && pb && !taken.has(pb.id) && !stillThere.has(pb.text)) take(b, pb); });
  });
  for (const s of sections) for (const b of s.blocks) if (!b.id) b.id = newBlockId(b.text, used);
  return { sections };
}

/** The doc as markdown: heading, then blocks, blank-line separated; one trailing newline. Byte-stable:
 *  renderDoc(parseDoc(renderDoc(d))) === renderDoc(d), and a block's text is written as stored. Pure. */
export function renderDoc(doc) {
  const parts = (doc?.sections ?? []).map(s => [s.heading.trim() ? `${'#'.repeat(s.level)} ${s.heading.trim()}` : null, ...s.blocks.map(b => b.text).filter(t => t.trim())].filter(Boolean).join('\n\n')).filter(Boolean);
  return parts.length ? `${parts.join('\n\n')}\n` : '';
}

// ── Operations ──────────────────────────────────────────────────────────────
//
// Each op carries exactly these keys (Hindsight delta_ops.py). 'id' a string id; 'id?' optional, may be
// null; 'id|null' required, may be null; 'text' a non-empty markdown fragment; 'texts' a non-empty list
// of them (empty for replace_section_blocks means "empty the section", which is a removal, so it is
// refused: use remove_block); 'heading' a non-empty line; 'level' an integer 1..6.
// 'refs?' (GET-1055): optional, the numbers of the new items the text rests on ([1, 3]). Code maps them
// to item ids, keeps them on the blocks as `cites`, and writes the evidence line from them; the model
// never writes counts, trends or quotes as evidence.
export const OP_SHAPES = {
  append_block: { section_id: 'id', text: 'text', based_on: 'refs?' },
  insert_block: { section_id: 'id', after_block_id: 'id|null', text: 'text', based_on: 'refs?' },
  replace_block: { section_id: 'id', block_id: 'id', text: 'text', based_on: 'refs?' },
  remove_block: { section_id: 'id', block_id: 'id' },
  add_section: { heading: 'heading', level: 'level', blocks: 'texts', after_section_id: 'id?', based_on: 'refs?' },
  remove_section: { section_id: 'id' },
  replace_section_blocks: { section_id: 'id', blocks: 'texts', based_on: 'refs?' },
  rename_section: { section_id: 'id', new_heading: 'heading' },
};
const OPTIONAL = new Set(['id?', 'refs?']);

function checkValue(kind, v, where) {
  const str = (x) => typeof x === 'string' && x.trim().length > 0;
  if (kind === 'id') return str(v) ? null : `${where} must be an id string copied from the document`;
  if (kind === 'id?' || kind === 'id|null') return v === null || str(v) ? null : `${where} must be an id string or null`;
  if (kind === 'heading') return str(v) && !/\n/.test(v) ? (/^#/.test(v.trim()) ? `${where} is the heading text without the leading #` : null) : `${where} must be one non-empty line`;
  // An item number, as an integer or a digit string ("3"): the model writes both.
  if (kind === 'refs?') return v === null || (Array.isArray(v) && v.length <= 50 && v.every(n => (Number.isInteger(n) && n >= 1) || (typeof n === 'string' && /^\d+$/.test(n)))) ? null : `${where} must be a list of the numbers of the new items the text rests on, e.g. [1, 3]`;
  if (kind === 'level') return Number.isInteger(v) && v >= 1 && v <= 6 ? null : `${where} must be an integer from 1 to 6`;
  const textErr = (t, w) => !str(t) ? `${w} must be non-empty markdown text` : (splitRaw(t).some(s => s.heading) ? `${w} holds a heading line; add a section with add_section instead` : unclosedFence(t) ? `${w} opens a code fence it does not close` : null);
  if (kind === 'text') return textErr(v, where);
  if (kind === 'texts') {
    if (!Array.isArray(v) || !v.length) return `${where} must be a non-empty list of markdown texts`;
    for (let i = 0; i < v.length; i++) { const e = textErr(v[i], `${where}[${i}]`); if (e) return e; }
    return null;
  }
  return `${where}: unknown kind`;
}

/**
 * The model's reply -> { ops } or { errors }. Strict (GET-1054): the reply must be a JSON object
 * {"operations": [...]}, and every op must be exactly one of OP_SHAPES, with exactly its keys. Any
 * error rejects the whole reply (a half-understood reply is not applied); the errors are quoted back
 * in the one retry. Pure.
 */
export function parseOps(text) {
  const s = String(text ?? '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return { errors: ['The reply is not a JSON object.'] };
  let o;
  try { o = JSON.parse(s.slice(a, b + 1)); } catch (e) { return { errors: [`The reply is not valid JSON (${String(e?.message ?? e).slice(0, 120)}).`] }; }
  if (!o || typeof o !== 'object' || !Array.isArray(o.operations)) return { errors: ['The reply must be {"operations": [...]}.'] };
  const errors = [];
  o.operations.forEach((op, i) => {
    const at = `operations[${i}]`;
    if (!op || typeof op !== 'object' || Array.isArray(op)) { errors.push(`${at} is not an object`); return; }
    const shape = OP_SHAPES[op.op];
    if (!shape) { errors.push(`${at}: unknown op ${JSON.stringify(op.op ?? null)}; the ops are ${Object.keys(OP_SHAPES).join(', ')}`); return; }
    for (const k of Object.keys(op)) if (k !== 'op' && !(k in shape)) errors.push(`${at} (${op.op}) has a key it does not take: ${k}`);
    for (const [k, kind] of Object.entries(shape)) {
      if (!(k in op)) { if (!OPTIONAL.has(kind)) errors.push(`${at} (${op.op}) is missing ${k}`); continue; }
      const e = checkValue(kind, op[k], `${at}.${k}`); if (e) errors.push(e);
    }
  });
  return errors.length ? { errors } : { ops: o.operations };
}

const clone = (doc) => ({ sections: (doc?.sections ?? []).map(s => ({ ...s, blocks: s.blocks.map(b => ({ ...b, ...(b.cites ? { cites: [...b.cites] } : {}) })) })) });
// GET-1055: an op's based_on, by the time it is applied, is a list of item ids (livingFiles maps the
// model's item numbers to ids first). Kept on each block it makes as `cites`; a replace adds to the
// block's cites, since the rules ask for the old detail to be re-emitted with the new.
const citesOf = (op) => Array.isArray(op.based_on) && op.based_on.length ? [...new Set(op.based_on.map(String))] : null;
const unionCites = (a, b) => { const out = [...new Set([...(a ?? []), ...(b ?? [])])]; return out.length ? out : null; };
const isRequired = (heading, required) => required.some(r => r.trim().toLowerCase() === String(heading ?? '').trim().toLowerCase());

/**
 * Apply ops in order to a COPY of `doc` (the input is never touched). An op that names an unknown id,
 * a block in another section, or would remove/rename a required section is skipped with its reason;
 * the rest still apply. A replace that changes nothing is skipped as "no change", so it never makes a
 * version. -> { doc, applied: [{ op, section, added, updated, removed, ... }], skipped: [{ index, op, reason }] }
 * Pure. `required`: the headings the file must keep (its build*Prompt section list).
 */
export function applyOps(doc, ops, { required = [] } = {}) {
  const next = clone(doc);
  const used = new Set(next.sections.flatMap(s => [s.id, ...s.blocks.map(b => b.id)]));
  const applied = [], skipped = [];
  const mint = (text, cites = null) => fragments(text).map(t => ({ id: newBlockId(t, used), text: t, ...(cites ? { cites: [...cites] } : {}) }));
  const section = (id) => next.sections.find(s => s.id === id);
  const label = (s) => s.heading || 'the intro';
  ops.forEach((op, index) => {
    // A "no change" skip is the model saying the item is already there, not a mistake: it is not
    // retried, and counts as nothing to do (GET-1054).
    const skip = (reason) => skipped.push({ index, op, reason, ...(reason.startsWith('no change') ? { no_change: true } : {}) });
    if (op.op === 'add_section') {
      if (next.sections.some(s => s.heading.trim().toLowerCase() === op.heading.trim().toLowerCase())) return skip(`a section "${op.heading}" already exists (id ${next.sections.find(s => s.heading.trim().toLowerCase() === op.heading.trim().toLowerCase()).id}); add to it instead`);
      let at = next.sections.length;
      if (op.after_section_id != null) { const i = next.sections.findIndex(s => s.id === op.after_section_id); if (i === -1) return skip(`unknown after_section_id ${op.after_section_id}`); at = i + 1; }
      const blocks = op.blocks.flatMap(t => mint(t, citesOf(op)));
      const s = { id: unique(slugify(op.heading), used), heading: op.heading.trim(), level: op.level, blocks };
      next.sections.splice(at, 0, s);
      return applied.push({ op: op.op, section: s.heading, added: blocks.length, updated: 0, removed: 0, new_section: true });
    }
    const s = section(op.section_id);
    if (!s) return skip(`unknown section_id ${op.section_id}`);
    const findBlock = (id) => {
      const i = s.blocks.findIndex(b => b.id === id);
      if (i !== -1) return { i };
      const elsewhere = next.sections.find(x => x.blocks.some(b => b.id === id));
      return { reason: elsewhere ? `block ${id} is in section ${elsewhere.id}, not ${s.id}` : `unknown block_id ${id} in section ${s.id}` };
    };
    switch (op.op) {
      case 'append_block': { const nb = mint(op.text, citesOf(op)); s.blocks.push(...nb); return applied.push({ op: op.op, section: label(s), added: nb.length, updated: 0, removed: 0 }); }
      case 'insert_block': {
        let at = 0;
        if (op.after_block_id !== null) { const f = findBlock(op.after_block_id); if (f.reason) return skip(f.reason); at = f.i + 1; }
        const nb = mint(op.text, citesOf(op)); s.blocks.splice(at, 0, ...nb);
        return applied.push({ op: op.op, section: label(s), added: nb.length, updated: 0, removed: 0 });
      }
      case 'replace_block': {
        const f = findBlock(op.block_id); if (f.reason) return skip(f.reason);
        const [first, ...rest] = fragments(op.text);
        const old = s.blocks[f.i], c = citesOf(op), cites = unionCites(old.cites, c);
        // The same text with a new item behind it is the model counting that item (GET-1055): the
        // text stays, the cites grow, and the evidence line's count with them.
        const grows = (cites?.length ?? 0) > (old.cites?.length ?? 0);
        if (first === old.text && !rest.length && !grows) return skip(`no change: block ${op.block_id} already says this`);
        s.blocks[f.i] = { id: old.id, text: first, ...(cites ? { cites } : {}) };   // the id is kept when the text changes
        const nb = rest.map(t => ({ id: newBlockId(t, used), text: t, ...(c ? { cites: [...c] } : {}) }));
        s.blocks.splice(f.i + 1, 0, ...nb);
        return applied.push({ op: op.op, section: label(s), added: nb.length, updated: 1, removed: 0 });
      }
      case 'remove_block': { const f = findBlock(op.block_id); if (f.reason) return skip(f.reason); s.blocks.splice(f.i, 1); return applied.push({ op: op.op, section: label(s), added: 0, updated: 0, removed: 1 }); }
      case 'remove_section': {
        if (isRequired(s.heading, required) || !s.heading) return skip(`section ${s.id} is required and cannot be removed`);
        next.sections.splice(next.sections.indexOf(s), 1);
        return applied.push({ op: op.op, section: label(s), added: 0, updated: 0, removed: s.blocks.length, removed_section: true });
      }
      case 'replace_section_blocks': {
        // Blocks re-sent with the same text keep their ids, so only what really changed is new.
        const old = s.blocks, free = [...old];
        const texts = op.blocks.flatMap(fragments);
        const blocks = texts.map(t => { const i = free.findIndex(b => b.text === t); return i === -1 ? null : free.splice(i, 1)[0]; });
        const c = citesOf(op);
        const fresh = texts.map((t, i) => blocks[i] ?? { id: newBlockId(t, used), text: t, ...(c ? { cites: [...c] } : {}) });
        if (fresh.length === old.length && fresh.every((b, i) => b.id === old[i].id)) return skip(`no change: section ${s.id} already says this`);
        const kept = blocks.filter(Boolean).length, added = fresh.length - kept, removed = old.length - kept, updated = Math.min(added, removed);
        s.blocks = fresh;
        return applied.push({ op: op.op, section: label(s), added: added - updated, updated, removed: removed - updated });
      }
      case 'rename_section': {
        if (s.heading.toLowerCase() === op.new_heading.trim().toLowerCase()) return skip(`no change: section ${s.id} is already "${s.heading}"`);
        if (isRequired(s.heading, required)) return skip(`section ${s.id} is required; its heading stays "${s.heading}"`);
        const from = s.heading; s.heading = op.new_heading.trim();   // the id is kept
        return applied.push({ op: op.op, section: s.heading, from, added: 0, updated: 0, removed: 0, renamed: true });
      }
      default: return skip(`unknown op ${op.op}`);
    }
  });
  return { doc: next, applied, skipped };
}

/**
 * The changelog, written in code from what was applied (GET-1054), never by the model:
 * "+2 points under Why we lose, 1 updated under By competitor, new section Brightlist (+3)". Under
 * 120 characters; what does not fit is counted ("and 2 more"). Pure.
 */
export function changelogOf(applied) {
  const bySection = new Map(), parts = [];
  for (const a of applied) {
    if (a.new_section) { parts.push({ key: `new:${a.section}`, text: `new section ${a.section}${a.added ? ` (+${a.added})` : ''}` }); continue; }
    if (a.removed_section) { parts.push({ key: `rm:${a.section}`, text: `removed section ${a.section}` }); continue; }
    if (a.renamed) { parts.push({ key: `mv:${a.section}`, text: `renamed ${a.from} to ${a.section}` }); continue; }
    if (!bySection.has(a.section)) { const e = { added: 0, updated: 0, removed: 0 }; bySection.set(a.section, e); parts.push({ key: `s:${a.section}`, section: a.section, e }); }
    const e = bySection.get(a.section); e.added += a.added; e.updated += a.updated; e.removed += a.removed;
  }
  const texts = parts.flatMap(p => {
    if (!p.e) return [p.text];
    const { added, updated, removed } = p.e, out = [];
    if (added) out.push(`+${added} point${added === 1 ? '' : 's'} under ${p.section}`);
    if (updated) out.push(`${updated} updated under ${p.section}`);
    if (removed) out.push(`${removed} removed under ${p.section}`);
    return out;
  });
  if (!texts.length) return 'No change';
  let line = '';
  for (let i = 0; i < texts.length; i++) {
    const more = texts.length - i - 1;
    const cand = line ? `${line}, ${texts[i]}` : texts[i];
    const tail = more ? `, and ${more} more` : '';
    if ((cand + tail).length > 120) return `${line || texts[i].slice(0, 100)}, and ${texts.length - i} more`.slice(0, 120);
    line = cand;
  }
  return line;
}

/** The doc as the model sees it: ids to copy verbatim. Pure. */
export const docJson = (doc) => JSON.stringify({ sections: (doc?.sections ?? []).map(s => ({ id: s.id, heading: s.heading, level: s.level, blocks: s.blocks.map(b => ({ id: b.id, text: b.text })) })) }, null, 1);

// The editing rules, adapted from Hindsight's STRUCTURED_DELTA_SYSTEM_PROMPT (MIT; THIRD_PARTY_NOTICES.md).
const EDIT_RULES = `RULES
- The new items are genuinely new: they were not available when the document was written. The document was built from earlier items you cannot see. Preserve it: never remove or replace a section or a block just because the new items do not mention it.
- Absence is not contradiction. An account, count or reason missing from the new items is not thereby wrong. "The batch does not mention X" and "X did not happen" are different statements; only the second would justify an edit.
- An item about one account never refutes a point about another. Add it beside the point.
- Overwrite or remove existing text only when a new item explicitly refutes or corrects that exact detail, or is a later-dated statement about the same point (a status or count that has since changed). Compare the dates the items give, not the order they arrive in. Otherwise keep the existing text: add a block, or re-emit the block with the new detail merged in so it still carries the old one.
- Merge, do not duplicate: when a new item fits a point already in the document, update that block (replace_block, re-emitting it with the addition) instead of adding a second one. Extend an existing section rather than making a new one.
- Prefer the smallest operation. Replacing one block leaves every other block byte-identical; replace_section_blocks retypes the whole section and risks losing detail.
- Never emit an operation whose only effect is to reword or reformat unchanged content.
- Every operation must be justified by a specific new item.
- Copy section_id and block_id values exactly from the document. Never invent one, never use a heading as an id. An operation naming an id that does not exist is dropped.
- Each "text" (and each entry of "blocks") is ONE markdown fragment: one paragraph, one list, one table or one code block, with real line breaks written as \\n (a list is "- one\\n- two"). No headings inside a text: a new heading is add_section. To add a bullet to an existing list, or a row to a table, replace_block that block with the addition.
- based_on: every op that writes text carries the numbers of the new items it rests on, from the numbered list (e.g. [1, 3]). Code counts, dates and quotes those items under the point. A point another new item also supports, with nothing new to say, is replace_block with its text unchanged and that item in based_on: that counts it.
- A line starting "> ×" under a point (e.g. "> ×4, steady, last 2026-10-20 · \"quote\"") is written by code from based_on. Never write, copy or edit one.
- Answer {"operations": []} only when every new item is already reflected in the document.

OPERATIONS (each carries exactly the keys shown, no others; no null stand-ins for keys an op does not take; based_on may be left out only when no new item is behind the text)
{"op": "append_block", "section_id": "...", "text": "...", "based_on": [1]}
{"op": "insert_block", "section_id": "...", "after_block_id": "..." or null (null = first in the section), "text": "...", "based_on": [1]}
{"op": "replace_block", "section_id": "...", "block_id": "...", "text": "...", "based_on": [1, 2]}
{"op": "remove_block", "section_id": "...", "block_id": "..."}
{"op": "add_section", "heading": "...", "level": 2, "blocks": ["...", "..."], "after_section_id": "...", "based_on": [3]}   (after_section_id may be left out: the section goes last)
{"op": "remove_section", "section_id": "..."}
{"op": "replace_section_blocks", "section_id": "...", "blocks": ["...", "..."], "based_on": [1]}
{"op": "rename_section", "section_id": "...", "new_heading": "..."}`;

/**
 * The edit prompt (GET-1054): the topic, the document as JSON with its ids, ONLY the new items since
 * the cursor, the file's own rules (its sections, from the whole-file prompt) and the op rules. The
 * model answers {"operations": [...]}. Pure.
 */
export function buildEditPrompt({ topic, doc, itemsHeader, itemsText, fileRules }) {
  return `You keep a living file: ${topic}

You are folding NEW items into the file as it stands, by editing it, not rewriting it.

THE FILE AS IT STANDS (JSON: sections in order, each with an id, a heading, a level and its blocks, each block with an id and its markdown text):
${docJson(doc)}

${itemsHeader}
${itemsText}

WHAT THE FILE MUST BE
${fileRules}

${EDIT_RULES}

Answer with ONLY a JSON object: {"operations": [...]}`;
}

/** The one retry after a reply with shape errors: the errors, quoted. Pure. */
export const shapeRetryPrompt = (errors) => `Your reply could not be used. Nothing was applied. The errors:\n${errors.slice(0, 20).map(e => `- ${e}`).join('\n')}\n\nSend the whole reply again, corrected, as ONLY {"operations": [...]}.`;

/** The one retry after ops were skipped: why, and the real ids. Pure. */
export function skippedRetryPrompt(skipped, doc) {
  const ids = (doc?.sections ?? []).map(s => `- section ${s.id} "${s.heading || '(intro)'}": blocks ${s.blocks.map(b => b.id).join(', ') || '(none)'}`).join('\n');
  return `Some operations could not be applied:\n${skipped.slice(0, 20).map(s => `- operations[${s.index}] (${s.op.op}): ${s.reason}`).join('\n')}\n\nThe ids that exist:\n${ids}\n\nSend the whole list of operations again (all of them, not only the fixed ones), against the file as it stood, as ONLY {"operations": [...]}.`;
}
