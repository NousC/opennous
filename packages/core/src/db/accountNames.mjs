// Account names a job named, resolved to the workspace's accounts (GET-891). A HubSpot read that
// groups by a company name, or a report that lists accounts in a table, names accounts in words
// with no entity id. This turns those words into account ids, exactly: the same name once case,
// punctuation and a legal suffix (Inc, Ltd, LLC, ...) are set aside, and nothing looser. A name no
// account carries is skipped and counted; a name two accounts carry is ambiguous, never guessed.

async function rows(q) { const { data, error } = await q; if (error) throw error; return data ?? []; }

const SUFFIXES = new Set(['inc', 'ltd', 'llc', 'llp', 'corp', 'co', 'limited', 'incorporated', 'corporation', 'plc', 'gmbh']);
/** "Harborline Supply, Inc." -> "harborline supply". Lower case, letters and digits, no trailing legal suffix. Pure. */
export function normalizeAccountName(name) {
  const words = String(name ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  while (words.length > 1 && SUFFIXES.has(words[words.length - 1])) words.pop();
  return words.join(' ');
}

const NOT_A_NAME = new Set(['name', 'total', 'totals', 'account', 'accounts', 'company', 'dealer', 'customer', 'deal']);
const looksLikeName = (s) => {
  const t = String(s ?? '').replace(/\*\*|__|`/g, '').trim();
  if (!t || t.length > 120 || /\(no name\)$/i.test(t)) return null;
  if (!/[a-z]/i.test(t) || /^[\d\s.,%$€£+\-()]+$/.test(t)) return null;
  if (NOT_A_NAME.has(normalizeAccountName(t))) return null;
  return t;
};

/**
 * The account names a job's output states in a structured place (GET-891): the first cell of each
 * table row (a "Name | n | n" table, or a markdown one, past its header row), a **bold** name, and
 * a title's lead before " — " or ": " ("Harborline Supply — closed lost"). Free prose is not
 * scanned word by word: an exact match on any phrase would turn ordinary words into accounts. Pure.
 */
export function accountNamesInText(text, title = null) {
  const out = new Set();
  const add = (s) => { const n = looksLikeName(s); if (n) out.add(n); };
  let inTable = false;
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line.includes('|')) { inTable = false; continue; }
    const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    if (cells.length < 2) { inTable = false; continue; }
    if (cells.every(c => /^:?-{2,}:?$/.test(c) || c === '')) continue;   // a markdown separator row
    if (!inTable) { inTable = true; continue; }                        // the header row
    add(cells[0]);
  }
  for (const m of String(text ?? '').matchAll(/\*\*([^*\n]{2,80})\*\*/g)) if (m[1].trim().split(/\s+/).length <= 8 && !/[:.]$/.test(m[1].trim())) add(m[1]);
  const lead = String(title ?? '').split(/\s+[—–]\s+|:\s/)[0];
  if (lead && lead !== title) add(lead);
  return [...out];
}

/**
 * Resolve names to the workspace's accounts. -> { ids, matched: [{ name, id }], unmatched: [names],
 * ambiguous: [names] }. One PostgREST read per 10 names: a loose ilike on the name's words narrows
 * the candidates, then only an exact normalized match counts.
 */
export async function resolveAccountNames(sb, ws, names, { cap = 200 } = {}) {
  const wanted = new Map();   // normalized -> the first spelling seen
  for (const n of names ?? []) {
    const key = normalizeAccountName(n);
    if (key && !wanted.has(key)) wanted.set(key, String(n).trim());
    if (wanted.size >= cap) break;
  }
  const keys = [...wanted.keys()];
  const found = new Map();   // normalized -> Set(entity ids)
  for (let i = 0; i < keys.length; i += 10) {
    const chunk = keys.slice(i, i + 10);
    const or = chunk.map(k => `name.ilike.*${k.split(' ').join('*')}*`).join(',');
    const hits = await rows(sb.from('entity_list_rows').select('entity_id, name').eq('workspace_id', ws).eq('kind', 'account').or(or).limit(1000));
    for (const h of hits) {
      const key = normalizeAccountName(h.name);
      if (!chunk.includes(key)) continue;
      if (!found.has(key)) found.set(key, new Set());
      found.get(key).add(h.entity_id);
    }
  }
  const matched = [], unmatched = [], ambiguous = [];
  for (const [key, name] of wanted) {
    const ids = found.get(key);
    if (!ids) unmatched.push(name);
    else if (ids.size > 1) ambiguous.push(name);
    else matched.push({ name, id: [...ids][0] });
  }
  return { ids: [...new Set(matched.map(m => m.id))], matched, unmatched, ambiguous };
}
