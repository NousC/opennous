// Intelligence freshness (GET-1055): how far behind a file is, and what each point rests on.
//
// Three things, all computed in code, never by the model:
// - "behind by N": the in-scope items newer than the file's watermark. The watermark is
//   workspace_living_files.cursor_at, which already is the newest in-scope item a pass actually read
//   (the last close's closed_at, the last claim's valid_from; never the run time), so it is reused
//   as Hindsight's last_memory_seen_at rather than stored a second time.
// - per-point evidence: the model's ops name the items a text rests on (based_on, by item number;
//   livingDoc keeps them on the block as `cites`). Code writes one line under the block: how many
//   items, their trend, the newest date, and one exact quote. The line is recomputed each pass and is
//   byte-identical when its numbers are, so a pass that changes nothing still makes no version.
// - retraction: a cited item since retired (a misread, contradicted, deleted claim; a close that was
//   reversed) puts the file "behind" too, and the next pass first runs a pass that may only remove or
//   trim the points resting on it.
//
// Ported from Hindsight (MIT, Copyright (c) 2025 Vectorize AI, Inc.; see THIRD_PARTY_NOTICES.md):
// memory_engine.py compute_mental_model_is_stale (the watermark idea), reflect/observations.py
// compute_trend (the 30/90-day windows and the 1.5 / 0.5 density ratios) and reflect/prompts.py
// STRUCTURED_RETRACTION_SYSTEM_PROMPT (the retraction rules, adapted in RETRACTION_RULES below).
import { docJson } from './livingDoc.mjs';

const DAY = 86_400_000;
const day = (ts) => String(ts ?? '').slice(0, 10);
const QUOTE_MAX = 160;
const CHUNK = 100;

// ── Trend (GET-1055, from Hindsight compute_trend) ──────────────────────────
//
// Over the cited items' dates (said, for a claim; closed, for a deal), relative to `now`:
// none in the last 90 days -> stale; all within the last 30 -> new; else the per-day density of the
// last 30 days against the 60 before them: > 1.5 strengthening, < 0.5 weakening, else steady. Items
// older than 90 days count toward the total only (so "recent plus very old" reads as strengthening).
export const TRENDS = ['new', 'strengthening', 'steady', 'weakening', 'stale'];
export function trendOf(dates, now = new Date()) {
  const ages = (dates ?? []).map(d => (now.getTime() - Date.parse(d)) / DAY).filter(Number.isFinite);
  if (!ages.length) return 'stale';
  const recent = ages.filter(a => a <= 30).length, prior = ages.filter(a => a > 30 && a <= 90).length;
  if (!recent && !prior) return 'stale';
  if (recent === ages.length) return 'new';
  if (!prior) return 'strengthening';
  const ratio = (recent / 30) / (prior / 60);
  return ratio > 1.5 ? 'strengthening' : ratio < 0.5 ? 'weakening' : 'steady';
}

// ── The evidence line ───────────────────────────────────────────────────────
//
// A blockquote line inside the block (no blank line before it), so it stays with its point in the doc
// model and renders under it: a blockquote interrupts a paragraph and ends a list. Code owns any line
// that starts "> ×<n>,": stripped before the model sees the doc, stripped from whatever it sends,
// written again after every pass.
const EVIDENCE = /^> ×\d+,/;
export const isEvidenceLine = (line) => EVIDENCE.test(line);

/** A block's text without its evidence line(s). Pure. */
export function stripEvidence(text) {
  const lines = String(text ?? '').split('\n');
  const kept = lines.filter(l => !isEvidenceLine(l));
  if (kept.length === lines.length) return String(text ?? '');
  while (kept.length && !kept.at(-1).trim()) kept.pop();
  return kept.length ? kept.join('\n') : String(text ?? '');   // a block that is nothing but the line is left alone
}

/** The doc as the model sees and edits it: every block's evidence line removed, cites kept. Pure. */
export const stripDoc = (doc) => ({ ...doc, sections: (doc?.sections ?? []).map(s => ({ ...s, blocks: s.blocks.map(b => ({ ...b, text: stripEvidence(b.text) })) })) });

const cleanQuote = (q) => { const t = String(q ?? '').replace(/\s+/g, ' ').trim(); return t.length > QUOTE_MAX ? `${t.slice(0, QUOTE_MAX - 1).trimEnd()}…` : t; };

/**
 * The evidence for a block from its cites and the sources (id -> { at, quote, label }): the count of
 * cites with a known source, their trend, the newest date, and the quote of the newest cited item that
 * has one (ties: the smaller id, so the pick is stable). null when no cite has a source. Pure.
 */
export function evidenceOf(cites, sources, now = new Date()) {
  const known = [...new Set(cites ?? [])].filter(id => sources?.[id]?.at);
  if (!known.length) return null;
  const at = known.map(id => sources[id].at);
  const newestFirst = [...known].sort((a, b) => String(sources[b].at).localeCompare(String(sources[a].at)) || a.localeCompare(b));
  const q = newestFirst.find(id => cleanQuote(sources[id].quote));
  return { n: known.length, trend: trendOf(at, now), last: day(newestFirst[0] && sources[newestFirst[0]].at), quote: q ? cleanQuote(sources[q].quote) : null };
}

/** "> ×7, strengthening, last 2026-10-20 · "we can't justify it"". Pure. */
export const evidenceLine = (ev) => `> ×${ev.n}, ${ev.trend}, last ${ev.last}${ev.quote ? ` · "${ev.quote}"` : ''}`;

/** A block's text with its evidence line, recomputed: the same text when the numbers are the same. Pure. */
export function stampText(text, cites, sources, now = new Date()) {
  const bare = stripEvidence(text);
  const ev = evidenceOf(cites, sources, now);
  return ev ? `${bare}\n${evidenceLine(ev)}` : bare;
}

/** Every block stamped (GET-1055). Byte-stable: stampDoc(stampDoc(d)) renders as stampDoc(d). Pure. */
export const stampDoc = (doc, sources, now = new Date()) => ({ ...doc, sections: (doc?.sections ?? []).map(s => ({ ...s, blocks: s.blocks.map(b => ({ ...b, text: stampText(b.text, b.cites, sources, now) })) })) });

/** The cites of `from` carried onto `doc` by block id, for a doc re-parsed from the body (a hand edit,
 *  a rebuild): parseDoc keeps ids, not the fields beside them. A block's own cites win. Pure. */
export function carryCites(doc, from) {
  const byId = new Map((from?.sections ?? []).flatMap(s => s.blocks).filter(b => b.cites?.length).map(b => [b.id, b.cites]));
  return { ...doc, sections: (doc?.sections ?? []).map(s => ({ ...s, blocks: s.blocks.map(b => (b.cites || !byId.has(b.id) ? b : { ...b, cites: [...byId.get(b.id)] })) })) };
}

/** Every item id a block of the doc cites. Pure. */
export const citedIds = (doc) => [...new Set((doc?.sections ?? []).flatMap(s => s.blocks.flatMap(b => b.cites ?? [])))];

/** Rewrite cites: drop the ids in `drop`, follow `remap` (a restated fact's old id -> its live one). Pure. */
export function rewriteCites(doc, { drop = new Set(), remap = new Map() } = {}) {
  return { ...doc, sections: (doc?.sections ?? []).map(s => ({ ...s, blocks: s.blocks.map(b => {
    if (!b.cites) return b;
    const cites = [...new Set(b.cites.map(id => remap.get(id) ?? id).filter(id => !drop.has(id)))];
    const { cites: _, ...rest } = b;
    return cites.length ? { ...rest, cites } : rest;
  }) })) };
}

/** The sources still cited by the doc, so the stored map does not grow forever. Pure. */
export function pruneSources(doc, sources) {
  const keep = new Set(citedIds(doc));
  return Object.fromEntries(Object.entries(sources ?? {}).filter(([id]) => keep.has(id)));
}

/**
 * The model's item numbers -> item ids (GET-1055). `ids[i]` is the id of item i+1 in the numbered list,
 * or null when it is not known; a number outside the list, or with no id, is dropped, and an op left
 * with none loses based_on. Pure.
 */
export function resolveRefs(ops, ids) {
  return (ops ?? []).map(op => {
    if (!('based_on' in op)) return op;
    const { based_on: refs, ...rest } = op;
    const mapped = [...new Set((refs ?? []).map(n => ids[Number(n) - 1]).filter(Boolean))];
    return mapped.length ? { ...rest, based_on: mapped } : rest;
  });
}

// ── Retraction (GET-1055, from Hindsight STRUCTURED_RETRACTION_SYSTEM_PROMPT) ─────────────
export const RETRACTION_OPS = new Set(['remove_block', 'replace_block']);

const RETRACTION_RULES = `RULES
- Remove only what the retired items support. If a bullet, row or sentence states a retired item, remove the block (remove_block), or rewrite the block to drop just that detail (replace_block) when it also carries what survives.
- When in doubt, keep it. The file was written from far more items than you are shown. Content that only looks related to a retired item, or could rest on items you cannot see, stays exactly as it is. Removing something still true is worse than leaving something stale: no later pass can restore it.
- A restated fact was not retracted. If a retired item's content also appears among the STILL-SUPPORTED items, it was re-read, not withdrawn: keep it.
- Counts follow: when you drop an account from a point, fix the count beside it ("3 accounts" becomes "2 accounts").
- Do not add anything. This pass only takes away.
- Do not tidy. No rewording, reordering or reformatting of what survives. Never leave a note that something was removed.
- Copy section_id and block_id exactly from the document.
- Answer {"operations": []} when nothing in the file rests on the retired items. That is a normal answer.

ALLOWED OPERATIONS (each carries exactly the keys shown, no others)
{"op": "remove_block", "section_id": "...", "block_id": "..."}
{"op": "replace_block", "section_id": "...", "block_id": "...", "text": "..."}`;

/**
 * The retraction prompt: the file (no evidence lines), the retired items with why, the blocks resting
 * on them with the items that still support each, and the rules. `affected` empty means the retired
 * items are not tied to any block (they came from a version's based_on only): the whole file is in
 * scope, and the rules lean on "when in doubt, keep it". Pure.
 */
export function buildRetractionPrompt({ topic, doc, retired, affected, supported }) {
  const r = retired.map((x, i) => `R${i + 1}. ${x.label ?? '(no longer on file)'}${x.why ? ` · retired: ${x.why}` : ''}`).join('\n');
  const s = supported.length ? supported.map((x, i) => `S${i + 1}. ${x.label}`).join('\n') : '(none)';
  const ref = (list, id, p) => `${p}${list.findIndex(x => x.id === id) + 1}`;
  const a = affected.length
    ? affected.map(b => `- block ${b.block_id} in section ${b.section_id}: rests on ${b.retired.map(id => ref(retired, id, 'R')).join(', ')}${b.supported.length ? `; still supported by ${b.supported.map(id => ref(supported, id, 'S')).join(', ')}` : '; nothing else supports it'}`).join('\n')
    : '- Not recorded: any block may rest on them. Keep everything you cannot tie to a retired item.';
  return `You keep a living file: ${topic}

Some items the file was written from have since been retired: they were misread, contradicted, deleted or reversed. You are removing what rests on them from the file, and nothing else.

THE FILE AS IT STANDS (JSON: sections, each with an id, a heading and its blocks, each block with an id and its markdown text):
${docJson(doc)}

RETIRED ITEMS:
${r}

THE BLOCKS THAT REST ON THEM:
${a}

STILL-SUPPORTED ITEMS (other items those blocks rest on, still on file):
${s}

${RETRACTION_RULES}

Answer with ONLY a JSON object: {"operations": [...]}`;
}

/**
 * Keep only what a retraction pass may do (GET-1055): remove_block and replace_block, on a block that
 * rests on a retired item (when that is known: `scope` is the set of such block ids, or null for the
 * whole file), never with based_on (a retraction adds no evidence). -> { ops, refused: [{ index, op, reason }] }. Pure.
 */
export function restrictRetraction(ops, scope = null) {
  const out = [], refused = [];
  (ops ?? []).forEach((op, index) => {
    if (!RETRACTION_OPS.has(op.op)) return refused.push({ index, op, reason: `${op.op} is not allowed in a retraction pass` });
    if (scope && !scope.has(op.block_id)) return refused.push({ index, op, reason: `block ${op.block_id} does not rest on a retired item` });
    const { based_on: _, ...rest } = op;
    out.push(rest);
  });
  return { ops: out, refused };
}

// ── Reading the record ──────────────────────────────────────────────────────
const isClaims = (key) => key !== 'win_loss';
const CATEGORY = { battlecards: 'competitor', objections: 'objection' };
const WHY = ['objection', 'competitor', 'blocker', 'buying_signal', 'risk_signal', 'budget', 'timeline', 'authority', 'requirement', 'pain', 'goal'];
const chunks = (xs) => { const out = []; for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK)); return out; };
async function byIds(sb, table, cols, ws, col, ids) {
  const out = [];
  for (const c of chunks(ids)) { const { data, error } = await sb.from(table).select(cols).eq('workspace_id', ws).in(col, c); if (error) throw error; out.push(...(data ?? [])); }
  return out;
}

/** How many in-scope items are newer than the watermark: closes for win/loss, live claims of the
 *  file's category otherwise. A head count, no rows. */
export async function countNew(sb, ws, key, since) {
  if (!since) return 0;
  const q = key === 'win_loss'
    ? sb.from('deal_outcomes').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).in('outcome', ['won', 'lost']).gt('closed_at', since)
    : sb.from('claims').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).like('property', 'note.%').is('invalid_at', null).eq('value->>category', CATEGORY[key]).gt('valid_from', since);
  const { data, count, error } = await q;
  if (error) throw error;
  return count ?? data?.length ?? 0;
}

/** The item ids the latest OpenNous version says it read (GET-1054 based_on). [] before the column. */
async function latestBasedOn(sb, ws, fileId) {
  if (!fileId) return [];
  try {
    const { data, error } = await sb.from('workspace_context_file_versions').select('based_on').eq('workspace_id', ws).eq('file_id', fileId).eq('author_kind', 'opennous').order('created_at', { ascending: false }).limit(1);
    if (error) return [];
    const b = data?.[0]?.based_on ?? {};
    return [...(b.claims ?? []), ...(b.deals ?? [])].map(String);
  } catch { return []; }
}

const claimLabel = (c) => String(c?.value?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
const claimSource = (c) => ({ at: c.valid_from, quote: c.value?.metadata?.quote ?? null, label: claimLabel(c) });
// Why a claim was retired, as retireNote records it. 'resolved' is not a retraction: an objection
// that was answered was still raised.
const retiredWhy = (c) => { const m = c?.value?.metadata ?? {}; return m.superseded_why ?? ({ misread: 'misread', contradicted: 'contradicted', updated: 'replaced' }[m.superseded_reason] ?? 'retired'); };

/**
 * What became of the cited ids (GET-1055). For claims: live, or retired with a reason; a claim retired
 * as 'updated' whose successor (value.metadata.superseded_by, followed up to 3 hops) is live was
 * restated, not retracted: its cite moves to the successor (`remap`). A 'resolved' claim stays live.
 * A missing claim was deleted: retracted. For deals: a cited deal_outcomes id (or, from GET-1054's
 * based_on, a deal_id) that is gone or no longer won/lost was reversed: retracted.
 * -> { retracted: Map<id, { label, why }>, remap: Map<oldId, newId>, sources: { [newId]: source } }
 */
export async function checkCited(sb, ws, key, ids) {
  const retracted = new Map(), remap = new Map(), sources = {};
  if (!ids.length) return { retracted, remap, sources };
  if (!isClaims(key)) {
    const rows = [...await byIds(sb, 'deal_outcomes', 'id, deal_id, outcome', ws, 'id', ids), ...await byIds(sb, 'deal_outcomes', 'id, deal_id, outcome', ws, 'deal_id', ids)];
    // One close, one entry: a GET-1054 based_on deal_id is folded into the deal_outcomes id a block
    // cites, so a reversed close is counted once; `ids` keeps every spelling, for `cleared`.
    const canon = (id) => String(rows.find(r => String(r.id) === id || String(r.deal_id ?? '') === id)?.id ?? id);
    const live = new Set(rows.filter(r => ['won', 'lost'].includes(r.outcome)).map(r => String(r.id)));
    for (const id of ids) {
      const c = canon(id);
      if (live.has(c)) continue;
      const prev = retracted.get(c);
      if (prev) { prev.ids.push(id); continue; }
      retracted.set(c, { label: null, why: rows.some(r => String(r.id) === c) ? 'the close was reversed' : 'the close was removed', ids: [id] });
    }
    return { retracted, remap, sources };
  }
  const rows = new Map((await byIds(sb, 'claims', 'id, invalid_at, valid_from, value', ws, 'id', ids)).map(r => [String(r.id), r]));
  const successorOf = (r) => (!r?.invalid_at || r.value?.metadata?.superseded_reason !== 'updated') ? null : r.value?.metadata?.superseded_by ?? null;
  for (let hop = 0; hop < 3; hop++) {
    const want = [...rows.values()].map(successorOf).filter(id => id && !rows.has(String(id)));
    if (!want.length) break;
    for (const r of await byIds(sb, 'claims', 'id, invalid_at, valid_from, value', ws, 'id', want)) rows.set(String(r.id), r);
  }
  const isLive = (r) => r && (!r.invalid_at || r.value?.metadata?.superseded_reason === 'resolved');
  for (const id of ids) {
    const r = rows.get(id);
    if (isLive(r)) continue;
    let cur = r, seen = 0;
    while (cur && !isLive(cur) && successorOf(cur) && seen++ < 3) cur = rows.get(String(successorOf(cur)));
    if (cur && cur !== r && isLive(cur)) { remap.set(id, String(cur.id)); sources[String(cur.id)] = claimSource(cur); continue; }
    retracted.set(id, { label: r ? claimLabel(r) : null, why: r ? retiredWhy(r) : 'deleted' });
  }
  return { retracted, remap, sources };
}

/**
 * The file's cited ids that are no longer supported, not yet handled by a retraction pass: the doc's
 * block cites plus the latest version's based_on, less `cleared` (ids a retraction pass already took
 * out, so a retired item is handled once, not every hour). -> checkCited's result, plus `legacy`: the
 * retracted ids no block cites (from based_on only).
 */
export async function citedState(sb, ws, key, { doc, fileId, cleared = new Set() }) {
  const fromBlocks = citedIds(doc);
  const ids = [...new Set([...fromBlocks, ...await latestBasedOn(sb, ws, fileId)])].filter(id => !cleared.has(id));
  const out = await checkCited(sb, ws, key, ids);
  const inBlocks = new Set(fromBlocks);
  return { ...out, legacy: [...out.retracted.keys()].filter(id => !inBlocks.has(id)) };
}

/** How many blocks rest on at least one of `ids`. Pure. */
export const pointsOn = (doc, ids) => (doc?.sections ?? []).flatMap(s => s.blocks).filter(b => (b.cites ?? []).some(id => ids.has(id))).length;

/**
 * The card's "behind" (GET-1055): { new: items newer than the watermark, retracted: cited items since
 * retired, points: blocks resting on one }. A few cheap queries; null when it cannot be read.
 */
export async function behindOf(sb, ws, row) {
  try {
    const doc = row.doc?.sections ? row.doc : null;
    const cleared = new Set(row.doc?.cleared ?? []);
    const [n, state] = await Promise.all([countNew(sb, ws, row.key, row.cursor_at), citedState(sb, ws, row.key, { doc, fileId: row.file_id, cleared })]);
    const ids = new Set(state.retracted.keys());
    return { new: n, retracted: ids.size, points: pointsOn(doc, ids) };
  } catch { return null; }
}

/**
 * The sources for this pass's items (GET-1055), by item number: ids[i] and sources[ids[i]] for item i+1.
 * Read beside SPECS.gather, not inside it (GET-1052 owns those bodies): the same window (since, cursor],
 * matched back to the gathered items: a claim by its said time and content, a close by its position
 * and close time (gather reads them in close order, as this does). An item that cannot be matched has
 * no id, and a based_on naming it is dropped.
 */
export async function itemSources(sb, ws, key, since, cursor, items) {
  const ids = items.map(() => null), sources = {};
  if (!cursor || !items.length) return { ids, sources };
  try {
    if (isClaims(key)) {
      const { data } = await sb.from('claims').select('id, entity_id, value, valid_from').eq('workspace_id', ws).like('property', 'note.%').is('invalid_at', null)
        .eq('value->>category', CATEGORY[key]).gt('valid_from', since).lte('valid_from', cursor).order('valid_from', { ascending: true }).limit(items.length * 2 + 10);
      const free = (data ?? []).filter(c => c.value?.content);
      items.forEach((it, i) => {
        const j = free.findIndex(c => c.valid_from === it.said_at && String(c.value.content).slice(0, 300) === it.content);
        if (j === -1) return;
        const [c] = free.splice(j, 1);
        ids[i] = String(c.id); sources[ids[i]] = claimSource(c);
      });
      return { ids, sources };
    }
    // By id where the items carry it (GET-1078: a pass reads one item per company, so rows and items no
    // longer line up one to one); by position otherwise.
    if (items.every(it => it.outcome_id)) {
      const rows = await byIds(sb, 'deal_outcomes', 'id, entity_id, outcome, closed_at', ws, 'id', items.map(it => it.outcome_id));
      const byId = new Map(rows.map(r => [String(r.id), r]));
      for (const [i, it] of items.entries()) {
        const d = byId.get(String(it.outcome_id));
        if (!d) continue;
        ids[i] = String(d.id);
        sources[ids[i]] = { at: d.closed_at, quote: await topQuote(sb, ws, it.entity_id ?? d.entity_id), label: `${String(it.outcome ?? d.outcome).toUpperCase()} · ${it.account ?? 'An account'} · closed ${day(d.closed_at)}` };
      }
      return { ids, sources };
    }
    const { data } = await sb.from('deal_outcomes').select('id, entity_id, outcome, closed_at').eq('workspace_id', ws).in('outcome', ['won', 'lost'])
      .gt('closed_at', since).lte('closed_at', cursor).order('closed_at', { ascending: true }).order('id', { ascending: true }).limit(items.length);
    for (const [i, it] of items.entries()) {
      const d = data?.[i];
      if (!d || d.closed_at !== it.closed_at) continue;
      ids[i] = String(d.id);
      sources[ids[i]] = { at: d.closed_at, quote: await topQuote(sb, ws, d.entity_id), label: `${String(it.outcome ?? d.outcome).toUpperCase()} · ${it.account ?? 'An account'} · closed ${day(d.closed_at)}` };
    }
  } catch { /* best-effort: no ids, no evidence lines this pass */ }
  return { ids, sources };
}

/** A close's quote: the newest live note on the account, or its people, that says why (WHY) and keeps
 *  the buyer's own words (value.metadata.quote). null when none does. */
async function topQuote(sb, ws, entityId) {
  if (!entityId) return null;
  const { data: people } = await sb.from('entity_list_rows').select('entity_id').eq('workspace_id', ws).eq('kind', 'person').eq('company_id', entityId).limit(50);
  const { data } = await sb.from('claims').select('value, valid_from').eq('workspace_id', ws).in('entity_id', [entityId, ...(people ?? []).map(p => p.entity_id)])
    .like('property', 'note.%').is('invalid_at', null).order('valid_from', { ascending: false }).limit(100);
  const hit = (data ?? []).find(c => WHY.includes(c.value?.category) && typeof c.value?.metadata?.quote === 'string' && c.value.metadata.quote.trim());
  return hit ? hit.value.metadata.quote : null;
}
