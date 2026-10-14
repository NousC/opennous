// RevBox datasets (GET-874): the database half. A dataset is a table a box's jobs keep
// (`revbox_datasets`, rows in `revbox_dataset_rows`, migration 2026_10_14_revbox_datasets.sql). A
// job's `dataset_append` step adds one row per run; a `dataset_read` step reads a window back for the
// next AI step; the Results tab lists the datasets and shows each as a table.
//
// Access is the box's: anyone who can open the box reads its datasets, an owner or editor creates
// and changes them (loadRevbox). A row about an account or deal (`entity_id`) is shown only to a
// viewer who can see that account: `allowed` is the viewer's visible-account set (the API's
// viewerVisibleAccountSet, the same one the box's accounts and documents use; null = unrestricted),
// and a deal counts as its company. The pure half (columns, coercion, windows, CSV) is
// services/datasetFormats.mjs.

import { loadRevbox } from './revboxes.mjs';
import { normalizeDatasetColumns, coerceDatasetRow, datasetSlug, datasetWindow, datasetRowsCsv, datasetValueText, DATASET_WINDOWS } from '../services/datasetFormats.mjs';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
async function rows(q) { const { data, error } = await q; if (error) throw error; return data ?? []; }
async function one(q) { const { data, error } = await q; if (error) throw error; return data; }
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const now = () => new Date().toISOString();
const DATASET_FIELDS = 'id, workspace_id, revbox_id, key, name, description, columns, created_by, created_at, updated_at';
const ROW_FIELDS = 'id, dataset_id, data, entity_id, source_run_id, source_job_id, dedupe_key, created_at';
/** A box holds at most this many datasets. */
export const MAX_DATASETS_PER_BOX = 20;
/** The most rows one listing returns, and the most an export or a read scans. */
export const DATASET_PAGE_MAX = 200;
export const DATASET_SCAN_MAX = 10_000;
const KEY_RE = /^[a-z][a-z0-9_]{0,62}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)?$/;

/** A dataset as the API returns it. */
const datasetOut = (d, extra = {}) => ({
  id: d.id, revbox_id: d.revbox_id, key: d.key, name: d.name, description: d.description ?? '',
  columns: Array.isArray(d.columns) ? d.columns : [], created_by: d.created_by ?? null, created_at: d.created_at ?? null, updated_at: d.updated_at ?? null, ...extra,
});

/** Name, description and columns from a create/update body, checked. Throws 400. Pure. */
export function checkDatasetBody(body, { partial = false } = {}) {
  if (!isObj(body)) fail(400, 'Send the dataset as an object.');
  const allowed = ['key', 'name', 'description', 'columns'];
  if (Object.keys(body).some(k => !allowed.includes(k))) fail(400, 'Unsupported dataset field.');
  const out = {};
  if (!partial || 'name' in body) {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 120) fail(400, 'Choose a name of up to 120 characters.');
    out.name = body.name.trim();
  }
  if ('description' in body) {
    if (body.description != null && (typeof body.description !== 'string' || body.description.length > 2000)) fail(400, 'The description is up to 2,000 characters.');
    out.description = String(body.description ?? '').trim();
  }
  if (!partial || 'columns' in body) {
    const c = normalizeDatasetColumns(body.columns);
    if (c.error) fail(400, c.error);
    out.columns = c.columns;
  }
  if ('key' in body && body.key != null) {
    if (partial) fail(400, "A dataset's key cannot change: jobs read it by that key.");
    if (typeof body.key !== 'string' || !KEY_RE.test(body.key)) fail(400, 'A key is lowercase letters, digits or underscores, starting with a letter.');
    out.key = body.key;
  }
  return out;
}

/** The box's dataset with this key, or 404. Access: the box's (edit = owner or editor). */
export async function getRevboxDataset(sb, { workspaceId, revboxId, userId, key, edit = false }) {
  await loadRevbox(sb, workspaceId, userId, revboxId, edit);
  const d = await one(sb.from('revbox_datasets').select(DATASET_FIELDS).eq('workspace_id', workspaceId).eq('revbox_id', revboxId).eq('key', String(key ?? '')).maybeSingle());
  if (!d) fail(404, 'Dataset not found.');
  return d;
}

/** Create a dataset on the box (owner or editor). The key is the name slugged unless given; a taken given key is 409. */
export async function createRevboxDataset(sb, { workspaceId, revboxId, userId, body }) {
  const input = checkDatasetBody(body);
  await loadRevbox(sb, workspaceId, userId, revboxId, true);
  const existing = await rows(sb.from('revbox_datasets').select('key').eq('workspace_id', workspaceId).eq('revbox_id', revboxId));
  if (existing.length >= MAX_DATASETS_PER_BOX) fail(400, `A RevBox holds up to ${MAX_DATASETS_PER_BOX} datasets.`);
  const taken = new Set(existing.map(d => d.key));
  let key = input.key;
  if (key && taken.has(key)) fail(409, `This RevBox already has a dataset with the key "${key}".`);
  if (!key) {
    const base = datasetSlug(input.name, 56) || 'dataset';
    key = base; for (let n = 2; taken.has(key); n++) key = `${base}_${n}`;
  }
  try {
    const d = await one(sb.from('revbox_datasets').insert({ workspace_id: workspaceId, revbox_id: revboxId, key, name: input.name, description: input.description ?? '', columns: input.columns, created_by: userId })
      .select(DATASET_FIELDS).single());
    return datasetOut(d, { row_count: 0, last_added_at: null });
  } catch (e) {
    if (e?.code === '23505') fail(409, `This RevBox already has a dataset with the key "${key}".`);
    throw e;
  }
}

/** Rename, describe or change the columns (owner or editor). Rows keep their data; a removed column stops showing. */
export async function updateRevboxDataset(sb, { workspaceId, revboxId, userId, key, body }) {
  const patch = checkDatasetBody(body, { partial: true });
  const d = await getRevboxDataset(sb, { workspaceId, revboxId, userId, key, edit: true });
  if (!Object.keys(patch).length) return datasetOut(d);
  const updated = await one(sb.from('revbox_datasets').update({ ...patch, updated_at: now() }).eq('workspace_id', workspaceId).eq('id', d.id).select(DATASET_FIELDS).maybeSingle());
  if (!updated) fail(404, 'Dataset not found.');
  return datasetOut(updated);
}

/**
 * Which of these rows the viewer may see: a row about no account always; one about an account or
 * person when `allowed` has it; one about a deal (or any entity) when `allowed` has its company.
 * `allowed`: null = unrestricted, a Set of account ids, or false = no account is visible.
 */
export async function visibleDatasetRows(sb, workspaceId, list, allowed) {
  if (allowed === null || allowed === undefined) return list;
  const pending = [...new Set(list.map(r => r.entity_id).filter(id => id && !(allowed instanceof Set && allowed.has(id))))];
  const companyOf = new Map();
  if (allowed instanceof Set) {
    for (let i = 0; i < pending.length; i += 200) {
      for (const e of await rows(sb.from('entity_list_rows').select('entity_id, company_id').eq('workspace_id', workspaceId).in('entity_id', pending.slice(i, i + 200)))) {
        if (e.company_id) companyOf.set(e.entity_id, e.company_id);
      }
    }
  }
  const sees = (id) => allowed instanceof Set && (allowed.has(id) || (companyOf.has(id) && allowed.has(companyOf.get(id))));
  return list.filter(r => !r.entity_id || sees(r.entity_id));
}

/** The box's datasets with how many rows the viewer sees and when the newest was added. View access. */
export async function listRevboxDatasets(sb, { workspaceId, revboxId, userId, allowed = null }) {
  await loadRevbox(sb, workspaceId, userId, revboxId);
  const list = await rows(sb.from('revbox_datasets').select(DATASET_FIELDS).eq('workspace_id', workspaceId).eq('revbox_id', revboxId).order('created_at'));
  return Promise.all(list.map(async (d) => {
    const seen = await scanRows(sb, workspaceId, d.id, { allowed, fields: 'id, entity_id, created_at', max: DATASET_SCAN_MAX });
    return datasetOut(d, { row_count: seen.rows.length, row_count_capped: seen.more, last_added_at: seen.rows[0]?.created_at ?? null });
  }));
}

/** A paging cursor: the last row's created_at and id, base64url. Pure. */
export const encodeDatasetCursor = (r) => Buffer.from(JSON.stringify({ t: r.t ?? r.created_at, i: r.i ?? r.id })).toString('base64url');
export function decodeDatasetCursor(c) {
  if (c == null || c === '') return null;
  try {
    const v = JSON.parse(Buffer.from(String(c), 'base64url').toString('utf8'));
    // Both halves go into a PostgREST or() string. Date.parse alone let a parenthesised comment (and a
    // quote inside it) through, so the time must be a plain ISO timestamp and the id a uuid. The time
    // is kept as Postgres wrote it, not re-serialised: toISOString() would drop the microseconds, and
    // the next page would skip rows inside that millisecond.
    if (typeof v?.t === 'string' && TIMESTAMP_RE.test(v.t) && !Number.isNaN(Date.parse(v.t)) && typeof v?.i === 'string' && UUID_RE.test(v.i)) return { t: v.t, i: v.i };
  } catch { /* fall through */ }
  fail(400, 'Invalid cursor.');
}

/**
 * Rows newest first, visible ones only, from `cursor` on, inside [from, to). Reads pages of the
 * database until `limit` visible rows (or `max` scanned): a viewer who cannot see most rows still
 * gets a full page. `match(row)` filters further (the search box). -> { rows, more, cursor }.
 */
async function scanRows(sb, workspaceId, datasetId, { allowed = null, cursor = null, from = null, to = null, limit = DATASET_SCAN_MAX, max = DATASET_SCAN_MAX, match = null, fields = ROW_FIELDS } = {}) {
  const out = [];
  let after = cursor, scanned = 0;
  const page = Math.min(500, Math.max(50, limit + 1));
  for (;;) {
    let q = sb.from('revbox_dataset_rows').select(fields).eq('workspace_id', workspaceId).eq('dataset_id', datasetId);
    if (from) q = q.gte('created_at', from);
    if (to) q = q.lt('created_at', to);
    if (after) q = q.or(`created_at.lt."${after.t}",and(created_at.eq."${after.t}",id.lt.${after.i})`);
    const got = await rows(q.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(page));
    scanned += got.length;
    for (const r of await visibleDatasetRows(sb, workspaceId, got, allowed)) {
      if (match && !match(r)) continue;
      if (out.length === limit) return { rows: out, more: true, cursor: { t: out.at(-1).created_at, i: out.at(-1).id } };
      out.push(r);
    }
    if (got.length < page) return { rows: out, more: false, cursor: null };
    if (scanned >= max) return { rows: out, more: true, cursor: out.length ? { t: out.at(-1).created_at, i: out.at(-1).id } : { t: got.at(-1).created_at, i: got.at(-1).id } };
    after = { t: got.at(-1).created_at, i: got.at(-1).id };
  }
}

/** The search box: every word appears somewhere in the row's values (case-insensitive). Pure. */
export function datasetRowMatcher(dataset, q) {
  const words = String(q ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  if (!words.length) return null;
  const cols = dataset?.columns ?? [];
  return (r) => {
    const hay = cols.map(c => datasetValueText(c, r.data?.[c.key])).join(' \u0001 ').toLowerCase();
    return words.every(w => hay.includes(w));
  };
}

/** The [from, to) of a listing: a named window, or explicit ISO dates. Throws 400. */
function rangeOf({ window = null, from = null, to = null, now: at = Date.now() } = {}) {
  if (window != null && window !== '') {
    if (!DATASET_WINDOWS.includes(window)) fail(400, `Choose a window: ${DATASET_WINDOWS.join(', ')}.`);
    return datasetWindow(window, at) ?? { from: null, to: null };
  }
  const d = (v) => { if (v == null || v === '') return null; const t = Date.parse(String(v)); if (Number.isNaN(t)) fail(400, 'Use ISO dates for from and to.'); return new Date(t).toISOString(); };
  return { from: d(from), to: d(to) };
}

/**
 * One page of the dataset's rows for the Results table: newest first, the viewer's visible ones,
 * optionally inside a window or a search. -> { dataset, rows, next_cursor }. View access.
 */
export async function listDatasetRows(sb, { workspaceId, revboxId, userId, key, cursor = null, limit = 50, window = null, from = null, to = null, q = null, allowed = null, now: at = Date.now() }) {
  const d = await getRevboxDataset(sb, { workspaceId, revboxId, userId, key });
  const n = Math.min(DATASET_PAGE_MAX, Math.max(1, Math.floor(Number(limit) || 50)));
  const range = rangeOf({ window, from, to, now: at });
  const match = datasetRowMatcher(d, q);
  const page = await scanRows(sb, workspaceId, d.id, { allowed, cursor: decodeDatasetCursor(cursor), ...range, limit: n, max: match ? 5000 : DATASET_SCAN_MAX, match });
  return { dataset: datasetOut(d), rows: page.rows.map(rowOut), next_cursor: page.more && page.cursor ? encodeDatasetCursor(page.cursor) : null };
}
const rowOut = (r) => ({ id: r.id, data: isObj(r.data) ? r.data : {}, entity_id: r.entity_id ?? null, source_run_id: r.source_run_id ?? null, source_job_id: r.source_job_id ?? null, created_at: r.created_at });

/** Every visible row (up to 10,000, newest first) as CSV. -> { dataset, csv, filename }. View access. */
export async function exportDatasetCsv(sb, { workspaceId, revboxId, userId, key, window = null, q = null, allowed = null, now: at = Date.now() }) {
  const d = await getRevboxDataset(sb, { workspaceId, revboxId, userId, key });
  const all = await scanRows(sb, workspaceId, d.id, { allowed, ...rangeOf({ window, now: at }), match: datasetRowMatcher(d, q) });
  return { dataset: datasetOut(d), csv: datasetRowsCsv(d, all.rows), filename: `${d.key}-${new Date(at).toISOString().slice(0, 10)}.csv` };
}

// ── The workflow engine's side (services/automationRun.mjs) ──────────────────────────────────
// A job reads and writes its own box's datasets as its owner; the step has already checked the
// owner can open the box (revboxRoutineContext), so these take the box id, not a user.

/** The box's dataset with this key, or null. No access check: the caller is the box's job. */
export async function datasetForBox(sb, { workspaceId, revboxId, key }) {
  if (!revboxId || !key) return null;
  return one(sb.from('revbox_datasets').select(DATASET_FIELDS).eq('workspace_id', workspaceId).eq('revbox_id', revboxId).eq('key', String(key)).maybeSingle());
}

/**
 * Add one row: the data checked against the columns and coerced to their types (unknown keys
 * dropped). With a `dedupeKey` already in the dataset nothing is added. Throws 400 when nothing
 * usable is left. -> { row, duplicate }.
 */
export async function appendDatasetRow(sb, { workspaceId, dataset, data, entityId = null, sourceRunId = null, sourceJobId = null, dedupeKey = null }) {
  if (!dataset?.id) fail(404, 'Dataset not found.');
  const checked = coerceDatasetRow(dataset.columns, data);
  if (!checked.ok) fail(400, `Nothing in that row fits the columns of "${dataset.name}".`);
  const dk = dedupeKey ? String(dedupeKey).slice(0, 300) : null;
  const uuid = (v) => (typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v) ? v : null);
  const { data: row, error } = await sb.from('revbox_dataset_rows').insert({
    dataset_id: dataset.id, workspace_id: workspaceId, data: checked.data, entity_id: uuid(entityId),
    source_run_id: uuid(sourceRunId), source_job_id: uuid(sourceJobId), dedupe_key: dk,
  }).select(ROW_FIELDS).single();
  if (error?.code === '23505' && dk) {
    const kept = await one(sb.from('revbox_dataset_rows').select(ROW_FIELDS).eq('dataset_id', dataset.id).eq('dedupe_key', dk).maybeSingle());
    return { row: kept ? rowOut(kept) : null, duplicate: true };
  }
  if (error) throw error;
  return { row: rowOut(row), duplicate: false };
}

/**
 * The rows a `dataset_read` step passes on: a window (by when they were added), newest `limit`
 * of them, visible to the job's owner. -> { rows, total, range }.
 */
export async function readDatasetRowsForRun(sb, { workspaceId, dataset, window = 'all', limit = 200, allowed = null, now: at = Date.now() }) {
  const range = datasetWindow(DATASET_WINDOWS.includes(window) ? window : 'all', at);
  const n = Math.min(500, Math.max(1, Math.floor(Number(limit) || 200)));
  const all = await scanRows(sb, workspaceId, dataset.id, { allowed, ...(range ?? {}), limit: DATASET_SCAN_MAX });
  return { rows: all.rows.slice(0, n).map(rowOut), total: all.rows.length, range };
}
