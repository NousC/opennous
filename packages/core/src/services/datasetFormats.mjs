// RevBox datasets (GET-874): the pure half. A dataset is a table a box's jobs keep: its columns are an
// ordered schema ({ key, label, type, options? }), and each row is one JSON object of those keys.
//
// This file is to datasets what slackFormats.mjs is to Slack layouts: the column types, the check of a
// column list, what the AI step is told to write when a `dataset_append` step reads it (one JSON
// object in the dataset's shape), the parse that checks what came back and coerces it to the column
// types, the window a `dataset_read` step reads, the compact table that step hands the next AI step,
// and the CSV export. No I/O: the database half is db/revboxDatasets.mjs.

import { extractJsonObject } from './slackFormats.mjs';

export const DATASET_COLUMN_TYPES = ['text', 'number', 'date', 'boolean', 'enum'];
export const DATASET_MAX_COLUMNS = 30;
export const DATASET_WINDOWS = ['last_7_days', 'last_30_days', 'last_month', 'last_quarter', 'all'];
const MAX_TEXT = 2000;
const MAX_OPTIONS = 50;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

/** A name as a key: lowercase letters, digits and underscores, starting with a letter. '' for nothing usable. Pure. */
export function datasetSlug(v, max = 40) {
  let k = String(v ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!k) return '';
  if (!/^[a-z]/.test(k)) k = `c_${k}`;
  return k.slice(0, max).replace(/_+$/, '');
}

/**
 * A column list as stored, or { error }. Each column: `key` (slugged; from the label when missing),
 * `label` (from the key when missing), `type` (one of DATASET_COLUMN_TYPES), and for an enum its
 * `options` (1-50 distinct strings). 1-30 columns, keys unique. Pure.
 */
export function normalizeDatasetColumns(input) {
  if (!Array.isArray(input) || !input.length) return { error: 'A dataset needs at least one column.' };
  if (input.length > DATASET_MAX_COLUMNS) return { error: `A dataset holds up to ${DATASET_MAX_COLUMNS} columns.` };
  const out = [];
  const seen = new Set();
  for (const c of input) {
    if (!isObj(c)) return { error: 'Each column needs a key or a label.' };
    const key = datasetSlug(c.key || c.label);
    if (!key) return { error: 'Each column needs a key or a label.' };
    if (seen.has(key)) return { error: `Two columns share the key "${key}".` };
    seen.add(key);
    const type = DATASET_COLUMN_TYPES.includes(c.type) ? c.type : c.type == null ? 'text' : null;
    if (!type) return { error: `Column "${key}" has an unknown type. Use ${DATASET_COLUMN_TYPES.join(', ')}.` };
    const label = str(c.label, 80) || key.replace(/_/g, ' ').replace(/^./, x => x.toUpperCase());
    const col = { key, label, type };
    if (type === 'enum') {
      const options = [...new Set((Array.isArray(c.options) ? c.options : []).map(o => str(String(o ?? ''), 80)).filter(Boolean))];
      if (!options.length) return { error: `Column "${key}" is a choice: give it its options.` };
      if (options.length > MAX_OPTIONS) return { error: `Column "${key}" has more than ${MAX_OPTIONS} options.` };
      col.options = options;
    }
    const description = str(c.description, 300);
    if (description) col.description = description;
    out.push(col);
  }
  return { columns: out };
}

/** "$48,000" -> 48000, "48k" -> 48000, "1.2m" -> 1200000, "45%" -> 45. null when not a number. Pure. */
function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const t = v.trim().toLowerCase().replace(/[\s,]/g, '').replace(/^[^\d+\-.]+/, '').replace(/%$/, '');
  const m = t.match(/^([+-]?\d*\.?\d+)(k|m|bn|b)?$/);
  if (!m) return null;
  const n = Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9, bn: 1e9 }[m[2]] ?? 1);
  return Number.isFinite(n) ? n : null;
}
/** A date as YYYY-MM-DD, or null. Pure. */
function toDate(v) {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const t = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return Number.isNaN(Date.parse(`${t}T00:00:00Z`)) ? null : t;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) || !/\d/.test(t) ? null : d.toISOString().slice(0, 10);
}
const TRUE = new Set(['true', 'yes', 'y', '1']);
const FALSE = new Set(['false', 'no', 'n', '0']);
function toBoolean(v) {
  if (typeof v === 'boolean') return v;
  const t = String(v ?? '').trim().toLowerCase();
  return TRUE.has(t) ? true : FALSE.has(t) ? false : null;
}

/** One value coerced to its column's type, or null (left empty). Pure. */
export function coerceDatasetValue(col, v) {
  if (v == null || v === '') return null;
  switch (col?.type) {
    case 'number': return toNumber(v);
    case 'date': return toDate(v);
    case 'boolean': return toBoolean(v);
    case 'enum': {
      const t = String(v).trim().toLowerCase();
      return (col.options ?? []).find(o => o.toLowerCase() === t) ?? null;
    }
    default: {
      if (isObj(v) || Array.isArray(v)) return str(Array.isArray(v) ? v.map(String).join(', ') : JSON.stringify(v), MAX_TEXT) || null;
      return String(v).trim().slice(0, MAX_TEXT) || null;
    }
  }
}

/**
 * A row's data checked against the columns: only known keys, each coerced to its type, empties left
 * out. -> { ok, data, filled } ; ok is false when nothing usable is left. Pure.
 */
export function coerceDatasetRow(columns, data) {
  if (!isObj(data)) return { ok: false, data: {}, filled: 0 };
  const out = {};
  for (const col of columns ?? []) {
    // The model may answer with the label instead of the key.
    const raw = col.key in data ? data[col.key] : data[col.label];
    const v = coerceDatasetValue(col, raw);
    if (v !== null) out[col.key] = v;
  }
  const filled = Object.keys(out).length;
  return { ok: filled > 0, data: out, filled };
}

const TYPE_HINT = { text: 'short text', number: 'a number, no currency sign or commas', date: 'a date, YYYY-MM-DD', boolean: 'true or false' };

/**
 * The instruction appended to the AI step's system prompt when a `dataset_append` step after it adds
 * its row (the way a Slack layout makes the AI write JSON). Also the shape call's, for words that were
 * not written as JSON (an account brief). Pure.
 */
export function datasetRowInstruction(dataset) {
  const cols = dataset?.columns ?? [];
  const lines = cols.map(c => `    "${c.key}": ${c.type === 'enum' ? (c.options ?? []).map(o => JSON.stringify(o)).join(' | ') : `"${TYPE_HINT[c.type] ?? 'short text'}"`}${c.label && c.label !== c.key ? `   // ${c.label}${c.description ? `: ${c.description}` : ''}` : c.description ? `   // ${c.description}` : ''}`);
  return `This run adds one row to the table "${str(dataset?.name, 120) || 'Dataset'}". Answer with ONE JSON object in exactly this shape, and nothing else (no prose, no code fence):

{
  "row": {
${lines.join(',\n')}
  },
  "summary": "two or three sentences a person reads: what this row says and why"
}

Rules for the JSON: use only what the material says; never invent a number, a name or a date. A field you have no data for is null. A choice field is exactly one of its options, or null. The comments are for you; do not write them.`;
}

/**
 * The model's answer as a row: { ok, data, summary, text }. Accepts { row, summary } or a bare object of
 * the columns. `text` is what a person reads instead of JSON (the summary, then "Label: value" lines);
 * when the answer is unusable it is the words themselves, never a JSON dump. Pure.
 */
export function parseDatasetRow(dataset, raw) {
  const obj = isObj(raw) ? raw : extractJsonObject(raw);
  const row = isObj(obj?.row) ? obj.row : obj;
  const checked = coerceDatasetRow(dataset?.columns ?? [], row);
  const summary = str(typeof obj?.summary === 'string' ? obj.summary : '', 4000);
  if (!checked.ok) {
    const words = String(raw ?? '').trim();
    return { ok: false, data: {}, summary: '', text: /^[{[]/.test(words) ? summary : words };
  }
  return { ok: true, data: checked.data, summary, text: [summary, datasetRowText(dataset, checked.data)].filter(Boolean).join('\n\n') };
}

/** One value as a person reads it. Pure. */
export function datasetValueText(col, v) {
  if (v == null || v === '') return '';
  if (col?.type === 'boolean') return v === true ? 'Yes' : v === false ? 'No' : String(v);
  if (col?.type === 'number' && typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  return String(v);
}

/** A row as "Label: value" lines, columns in order. Pure. */
export function datasetRowText(dataset, data) {
  return (dataset?.columns ?? []).filter(c => data?.[c.key] != null && data[c.key] !== '')
    .map(c => `${c.label}: ${datasetValueText(c, data[c.key])}`).join('\n');
}

/**
 * The window a `dataset_read` step reads, by when the row was added: { from, to } as ISO strings
 * (`to` exclusive), or null for 'all'. Calendar months and quarters are UTC. Pure.
 */
export function datasetWindow(window, now = Date.now()) {
  const at = new Date(now);
  const y = at.getUTCFullYear(), m = at.getUTCMonth();
  const iso = (d) => d.toISOString();
  switch (window) {
    case 'last_7_days': return { from: iso(new Date(+at - 7 * 86_400_000)), to: iso(new Date(+at + 1)) };
    case 'last_30_days': return { from: iso(new Date(+at - 30 * 86_400_000)), to: iso(new Date(+at + 1)) };
    case 'last_month': return { from: iso(new Date(Date.UTC(y, m - 1, 1))), to: iso(new Date(Date.UTC(y, m, 1))) };
    case 'last_quarter': { const q = Math.floor(m / 3) * 3; return { from: iso(new Date(Date.UTC(y, q - 3, 1))), to: iso(new Date(Date.UTC(y, q, 1))) }; }
    default: return null;
  }
}
const WINDOW_WORDS = { last_7_days: 'the last 7 days', last_30_days: 'the last 30 days', last_month: 'last month', last_quarter: 'last quarter', all: 'all time' };

/**
 * Rows as the compact table a `dataset_read` step hands the next AI step (and {{steps.<id>.output}}):
 * a heading line with the count and period, then a pipe table, oldest first so a report reads in
 * order. Capped at `maxChars`; the cut is said, never silent. Pure.
 */
// How much of a table a Read table step hands the next AI step (GET-883): a quarter of a busy
// ten-column win/loss table (~410 rows), and still under the AI step's material limit
// (automationRun MATERIAL_CHARS, 100k) with room for the box context.
export const DATASET_READ_CHARS = 85_000;

export function datasetRowsTable(dataset, rows, { window = 'all', range = null, total = null, maxChars = DATASET_READ_CHARS } = {}) {
  const cols = dataset?.columns ?? [];
  const cell = (t) => String(t ?? '').replace(/\s*\n\s*/g, ' ').replace(/\|/g, '/').trim();
  const period = range ? `${range.from.slice(0, 10)} to ${new Date(Date.parse(range.to) - 1).toISOString().slice(0, 10)}` : WINDOW_WORDS[window] ?? 'all time';
  const n = rows.length;
  const head = `Table "${cell(dataset?.name) || 'Dataset'}": ${n} row${n === 1 ? '' : 's'} added in ${WINDOW_WORDS[window] ?? 'all time'} (${period})${total != null && total > n ? `, the newest ${n} of ${total}` : ''}.`;
  if (!n) return `${head}\nNo rows in this period.`;
  const lines = [head, ['Added', ...cols.map(c => cell(c.label))].join(' | ')];
  const ordered = [...rows].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  let used = lines.join('\n').length, shown = 0;
  for (const r of ordered) {
    const line = [String(r.created_at ?? '').slice(0, 10), ...cols.map(c => cell(datasetValueText(c, r.data?.[c.key])))].join(' | ');
    if (used + line.length + 1 > maxChars) break;
    lines.push(line); used += line.length + 1; shown++;
  }
  if (shown < n) lines.push(`(${n - shown} more rows not shown: the table is longer than this step passes on.)`);
  return lines.join('\n');
}

/** A CSV cell: quoted when needed, and a leading = + - @ neutralised so a spreadsheet never runs it. Pure. */
export function csvCell(v) {
  let t = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(t) && !/^-?\d+(\.\d+)?$/.test(t)) t = `'${t}`;
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

/** Rows as CSV: the columns in order, then when each row was added and the run that added it. Pure. */
export function datasetRowsCsv(dataset, rows) {
  const cols = dataset?.columns ?? [];
  const lines = [[...cols.map(c => c.label), 'Added', 'Source run'].map(csvCell).join(',')];
  for (const r of rows) lines.push([...cols.map(c => datasetValueText(c, r.data?.[c.key])), String(r.created_at ?? ''), r.source_run_id ?? ''].map(csvCell).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
