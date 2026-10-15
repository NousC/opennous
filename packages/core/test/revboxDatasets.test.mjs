// RevBox datasets (GET-874): the column schema and row coercion, the box's access rules, viewer
// visibility of rows about accounts and deals, paging, search, CSV, and the two workflow-engine
// steps: Add to table (dataset_append) and Read table (dataset_read).
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/revboxDatasets.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDatasetColumns, coerceDatasetRow, parseDatasetRow, datasetRowInstruction, datasetWindow, datasetRowsTable, datasetRowsCsv, csvCell, datasetSlug,
} from '../dist/services/datasetFormats.mjs';
import {
  createRevboxDataset, updateRevboxDataset, listRevboxDatasets, listDatasetRows, exportDatasetCsv, appendDatasetRow, readDatasetRowsForRun, visibleDatasetRows, datasetForBox, decodeDatasetCursor,
} from '../dist/db/revboxDatasets.mjs';
import { runStepsForTest as runSteps, registerStepHandler, datasetDedupeKey, startTestRun } from '../dist/services/automationRun.mjs';
import { registerAnthropicClient } from '../dist/llm/modelDoor.mjs';

const COLUMNS = [
  { key: 'deal', label: 'Deal', type: 'text' },
  { key: 'outcome', label: 'Outcome', type: 'enum', options: ['Won', 'Lost'] },
  { key: 'value', label: 'Value', type: 'number' },
  { key: 'close_date', label: 'Close date', type: 'date' },
  { key: 'icp_fit', label: 'ICP fit', type: 'boolean' },
];
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// ── A fake database: enough of supabase-js (eq/in/gte/lt/or/order/limit, a unique dedupe key) ─────
function database(seed = {}) {
  const tables = {
    workspace_members: [{ workspace_id: 'ws', user_id: 'owner' }, { workspace_id: 'ws', user_id: 'viewer' }, { workspace_id: 'ws', user_id: 'stranger' }],
    revboxes: [{ id: 'box', workspace_id: 'ws', owner_id: 'owner', shared: false, name: 'Closed won/lost analysis', objective: 'Learn why we win and lose.', blocks: [], delivery: [] }],
    revbox_members: [{ workspace_id: 'ws', revbox_id: 'box', user_id: 'viewer', role: 'viewer' }],
    revbox_context: [], revbox_datasets: [], revbox_dataset_rows: [], entity_list_rows: [], documents: [],
    ...seed,
  };
  let seq = 0;
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  // created_at.lt."X",and(created_at.eq."X",id.lt.Y)
  const orFilter = (expr) => {
    const m = expr.match(/^created_at\.lt\."([^"]+)",and\(created_at\.eq\."([^"]+)",id\.lt\.([^)]+)\)$/);
    if (!m) throw new Error(`fake or() cannot read ${expr}`);
    return r => r.created_at < m[1] || (r.created_at === m[2] && r.id < m[3]);
  };
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.orders = []; this.max = null; }
    select() { return this; }
    order(k, o = {}) { this.orders.push([k, o.ascending !== false]); return this; }
    limit(n) { this.max = n; return this; }
    eq(k, v) { this.filters.push(r => r[k] === v); return this; }
    neq(k, v) { this.filters.push(r => r[k] !== v); return this; }
    in(k, vs) { this.filters.push(r => vs.includes(r[k])); return this; }
    gte(k, v) { this.filters.push(r => r[k] >= v); return this; }
    lt(k, v) { this.filters.push(r => r[k] < v); return this; }
    or(expr) { this.filters.push(orFilter(expr)); return this; }
    insert(v) { this.insertValue = v; return this; }
    update(v) { this.updateValue = v; return this; }
    result(single) {
      const all = (tables[this.table] ??= []);
      if (this.insertValue) {
        const row = structuredClone({ id: uuid(++seq), created_at: new Date(Date.UTC(2026, 9, 1) + seq * 60_000).toISOString(), ...this.insertValue });
        if (this.table === 'revbox_dataset_rows' && row.dedupe_key && all.some(r => r.dataset_id === row.dataset_id && r.dedupe_key === row.dedupe_key)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
        if (this.table === 'revbox_datasets' && all.some(r => r.revbox_id === row.revbox_id && r.key === row.key)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
        all.push(row);
        return { data: structuredClone(row), error: null };
      }
      let values = all.filter(r => this.filters.every(f => f(r)));
      if (this.updateValue) for (const row of values) Object.assign(row, structuredClone(this.updateValue));
      for (const [k, asc] of [...this.orders].reverse()) values = [...values].sort((a, b) => (asc ? 1 : -1) * cmp(a[k], b[k]));
      if (this.max != null) values = values.slice(0, this.max);
      return { data: structuredClone(single ? values[0] ?? null : values), error: null };
    }
    maybeSingle() { return Promise.resolve(this.result(true)); }
    single() { return this.maybeSingle(); }
    then(ok, bad) { return Promise.resolve(this.result(false)).then(ok, bad); }
  }
  return { tables, from: t => new Query(t) };
}

// ── The pure half ──────────────────────────────────────────────────────────────────────────────

test('columns are slugged, typed, capped at 30 and unique; an enum needs its options', () => {
  const r = normalizeDatasetColumns([{ label: 'Primary reason' }, { key: 'Deal Value!', type: 'number' }, { label: 'Outcome', type: 'enum', options: ['Won', 'Lost', 'Won', ''] }]);
  assert.deepEqual(r.columns.map(c => [c.key, c.type]), [['primary_reason', 'text'], ['deal_value', 'number'], ['outcome', 'enum']]);
  assert.deepEqual(r.columns[2].options, ['Won', 'Lost']);
  assert.equal(r.columns[1].label, 'Deal value');
  assert.match(normalizeDatasetColumns([{ key: 'a' }, { label: 'A' }]).error, /share the key "a"/);
  assert.match(normalizeDatasetColumns(Array.from({ length: 31 }, (_, i) => ({ key: `c${i}` }))).error, /up to 30/);
  assert.match(normalizeDatasetColumns([{ key: 'x', type: 'enum' }]).error, /options/);
  assert.match(normalizeDatasetColumns([{ key: 'x', type: 'money' }]).error, /unknown type/);
  assert.match(normalizeDatasetColumns([]).error, /at least one/);
  assert.equal(datasetSlug('2026 pipeline'), 'c_2026_pipeline');
});

test('a row is coerced to the column types, unknown keys dropped, labels accepted as keys', () => {
  const r = coerceDatasetRow(COLUMNS, { deal: 'Harborline renewal', outcome: 'won', value: '$48k', 'Close date': '12 Oct 2026', icp_fit: 'yes', secret: 'x' });
  assert.deepEqual(r.data, { deal: 'Harborline renewal', outcome: 'Won', value: 48000, close_date: '2026-10-12', icp_fit: true });
  assert.deepEqual(coerceDatasetRow(COLUMNS, { outcome: 'maybe', value: 'lots' }), { ok: false, data: {}, filled: 0 });
  assert.equal(coerceDatasetRow(COLUMNS, { value: '1,250,000.50' }).data.value, 1250000.5);
});

test('the AI is told the row shape; its answer parses from { row, summary }, fenced or bare, never as a JSON dump', () => {
  const ds = { name: 'Win/loss deals', key: 'win_loss', columns: COLUMNS };
  const ins = datasetRowInstruction(ds);
  assert.match(ins, /ONE JSON object/);
  assert.match(ins, /"outcome": "Won" \| "Lost"/);
  assert.match(ins, /"close_date": "a date, YYYY-MM-DD"/);
  const p = parseDatasetRow(ds, '```json\n{"row": {"deal": "Fernpoint", "outcome": "Lost", "value": 12000}, "summary": "Lost on price."}\n```');
  assert.equal(p.ok, true);
  assert.deepEqual(p.data, { deal: 'Fernpoint', outcome: 'Lost', value: 12000 });
  assert.match(p.text, /^Lost on price\.\n\nDeal: Fernpoint\nOutcome: Lost\nValue: 12000$/);
  assert.equal(parseDatasetRow(ds, { deal: 'Bare' }).data.deal, 'Bare');
  const bad = parseDatasetRow(ds, '{"nothing": 1}');
  assert.equal(bad.ok, false);
  assert.doesNotMatch(bad.text, /\{/);
});

test('windows: last month and last quarter are calendar periods, the rolling ones end now', () => {
  const now = Date.UTC(2026, 9, 14, 8);
  assert.deepEqual(datasetWindow('last_month', now), { from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' });
  assert.deepEqual(datasetWindow('last_quarter', now), { from: '2026-07-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' });
  assert.deepEqual(datasetWindow('last_quarter', Date.UTC(2026, 1, 3)), { from: '2025-10-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' });
  assert.equal(datasetWindow('last_7_days', now).from, '2026-10-07T08:00:00.000Z');
  assert.equal(datasetWindow('all', now), null);
});

test('the compact table reads oldest first, says the period, and says when it is cut', () => {
  const ds = { name: 'Win/loss deals', columns: COLUMNS.slice(0, 3) };
  const rows = [{ created_at: '2026-09-20T00:00:00Z', data: { deal: 'B | two', outcome: 'Lost', value: 5 } }, { created_at: '2026-09-02T00:00:00Z', data: { deal: 'A', outcome: 'Won', value: 10 } }];
  const t = datasetRowsTable(ds, rows, { window: 'last_month', range: datasetWindow('last_month', Date.UTC(2026, 9, 14)) });
  assert.match(t, /^Table "Win\/loss deals": 2 rows added in last month \(2026-09-01 to 2026-09-30\)\./);
  assert.deepEqual(t.split('\n').slice(1), ['Added | Deal | Outcome | Value', '2026-09-02 | A | Won | 10', '2026-09-20 | B / two | Lost | 5']);
  assert.match(datasetRowsTable(ds, rows, { maxChars: 140 }), /1 more rows not shown/);
  assert.match(datasetRowsTable(ds, []), /No rows in this period/);
});

test('CSV quotes what needs quoting and neutralises a formula', () => {
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell('-12.5'), '-12.5');
  assert.equal(csvCell('a, b'), '"a, b"');
  const csv = datasetRowsCsv({ columns: COLUMNS.slice(0, 2) }, [{ data: { deal: 'A', outcome: 'Won' }, created_at: '2026-10-01T00:00:00Z', source_run_id: 'r1' }]);
  assert.equal(csv, 'Deal,Outcome,Added,Source run\r\nA,Won,2026-10-01T00:00:00Z,r1\r\n');
});

// ── The database half ──────────────────────────────────────────────────────────────────────────

test('only an owner or editor creates or changes a dataset; the key comes from the name and never changes', async () => {
  const sb = database();
  const d = await createRevboxDataset(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', body: { name: 'Win/loss deals', columns: COLUMNS } });
  assert.equal(d.key, 'win_loss_deals');
  assert.equal(d.row_count, 0);
  const again = await createRevboxDataset(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', body: { name: 'Win/loss deals', columns: COLUMNS } });
  assert.equal(again.key, 'win_loss_deals_2');
  await assert.rejects(createRevboxDataset(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', body: { key: 'win_loss_deals', name: 'X', columns: COLUMNS } }), e => e.status === 409);
  await assert.rejects(createRevboxDataset(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'viewer', body: { name: 'X', columns: COLUMNS } }), e => e.status === 403);
  await assert.rejects(createRevboxDataset(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'stranger', body: { name: 'X', columns: COLUMNS } }), e => e.status === 404);
  await assert.rejects(createRevboxDataset(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', body: { name: 'X', columns: [], extra: 1 } }), e => e.status === 400);
  const renamed = await updateRevboxDataset(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', key: 'win_loss_deals', body: { name: 'Deals won and lost', columns: [...COLUMNS, { label: 'Competitor' }] } });
  assert.equal(renamed.name, 'Deals won and lost');
  assert.equal(renamed.columns.at(-1).key, 'competitor');
  await assert.rejects(updateRevboxDataset(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', key: 'win_loss_deals', body: { key: 'other' } }), e => e.status === 400);
  await assert.rejects(updateRevboxDataset(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'viewer', key: 'win_loss_deals', body: { name: 'No' } }), e => e.status === 403);
});

test('append coerces, dedupes on the key, and refuses a row with nothing usable', async () => {
  const sb = database();
  await createRevboxDataset(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', body: { name: 'Win/loss', columns: COLUMNS } });
  const ds = await datasetForBox(sb, { workspaceId: 'ws', revboxId: 'box', key: 'win_loss' });
  const a = await appendDatasetRow(sb, { workspaceId: 'ws', dataset: ds, data: { deal: 'A', value: '10' }, dedupeKey: 'deal:1:closed_won', sourceRunId: uuid(901), entityId: 'not-a-uuid' });
  assert.equal(a.duplicate, false);
  assert.deepEqual(a.row.data, { deal: 'A', value: 10 });
  assert.equal(a.row.source_run_id, uuid(901));
  assert.equal(a.row.entity_id, null);
  const b = await appendDatasetRow(sb, { workspaceId: 'ws', dataset: ds, data: { deal: 'A again' }, dedupeKey: 'deal:1:closed_won' });
  assert.equal(b.duplicate, true);
  assert.equal(b.row.data.deal, 'A');
  assert.equal(sb.tables.revbox_dataset_rows.length, 1);
  await assert.rejects(appendDatasetRow(sb, { workspaceId: 'ws', dataset: ds, data: { nope: 1 } }), e => e.status === 400);
});

/** A box with a dataset and rows about accounts c1/c2 and a deal of c2; c3 has no rows. */
async function seeded() {
  const sb = database({ entity_list_rows: [{ workspace_id: 'ws', entity_id: uuid(501), company_id: uuid(102), kind: 'deal' }] });
  await createRevboxDataset(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', body: { name: 'Win/loss', columns: COLUMNS } });
  const ds = await datasetForBox(sb, { workspaceId: 'ws', revboxId: 'box', key: 'win_loss' });
  for (let i = 0; i < 12; i++) await appendDatasetRow(sb, { workspaceId: 'ws', dataset: ds, data: { deal: `Deal ${i}`, outcome: i % 3 ? 'Won' : 'Lost' }, entityId: i % 2 ? uuid(101) : null });
  await appendDatasetRow(sb, { workspaceId: 'ws', dataset: ds, data: { deal: 'Deal on c2' }, entityId: uuid(501) });
  return { sb, ds };
}

test('a viewer sees rows about no account, and rows about accounts (or a deal of an account) they can see', async () => {
  const { sb } = await seeded();
  const rows = sb.tables.revbox_dataset_rows;
  assert.equal((await visibleDatasetRows(sb, 'ws', rows, null)).length, 13);
  assert.equal((await visibleDatasetRows(sb, 'ws', rows, new Set())).length, 6);
  assert.equal((await visibleDatasetRows(sb, 'ws', rows, false)).length, 6);
  assert.equal((await visibleDatasetRows(sb, 'ws', rows, new Set([uuid(101)]))).length, 12);
  const withDeal = await visibleDatasetRows(sb, 'ws', rows, new Set([uuid(102)]));
  assert.equal(withDeal.length, 7);
  assert.ok(withDeal.some(r => r.data.deal === 'Deal on c2'));
  const list = await listRevboxDatasets(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'viewer', allowed: new Set() });
  assert.equal(list[0].row_count, 6);
  assert.ok(list[0].last_added_at);
});

test('rows page newest first by cursor, filter by search, and export as CSV, all with the viewer\'s visibility', async () => {
  const { sb } = await seeded();
  const p1 = await listDatasetRows(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'viewer', key: 'win_loss', limit: 5 });
  assert.deepEqual(p1.rows.map(r => r.data.deal), ['Deal on c2', 'Deal 11', 'Deal 10', 'Deal 9', 'Deal 8']);
  const p2 = await listDatasetRows(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'viewer', key: 'win_loss', limit: 5, cursor: p1.next_cursor });
  assert.deepEqual(p2.rows.map(r => r.data.deal), ['Deal 7', 'Deal 6', 'Deal 5', 'Deal 4', 'Deal 3']);
  const p3 = await listDatasetRows(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'viewer', key: 'win_loss', limit: 5, cursor: p2.next_cursor });
  assert.equal(p3.rows.length, 3);
  assert.equal(p3.next_cursor, null);
  // Restricted: full pages of what they can see.
  const r1 = await listDatasetRows(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'viewer', key: 'win_loss', limit: 4, allowed: new Set() });
  assert.deepEqual(r1.rows.map(r => r.data.deal), ['Deal 10', 'Deal 8', 'Deal 6', 'Deal 4']);
  const found = await listDatasetRows(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'viewer', key: 'win_loss', q: 'lost' });
  assert.deepEqual(found.rows.map(r => r.data.deal), ['Deal 9', 'Deal 6', 'Deal 3', 'Deal 0']);
  await assert.rejects(listDatasetRows(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'viewer', key: 'win_loss', cursor: 'junk' }), e => e.status === 400);
  await assert.rejects(listDatasetRows(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'stranger', key: 'win_loss' }), e => e.status === 404);
  await assert.rejects(listDatasetRows(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'viewer', key: 'nope' }), e => e.status === 404);
  const out = await exportDatasetCsv(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'viewer', key: 'win_loss', allowed: new Set() });
  assert.equal(out.csv.trim().split('\r\n').length, 7);
  assert.match(out.filename, /^win_loss-\d{4}-\d{2}-\d{2}\.csv$/);
});

test('readDatasetRowsForRun takes a window and the newest `limit` rows', async () => {
  const { sb, ds } = await seeded();
  const r = await readDatasetRowsForRun(sb, { workspaceId: 'ws', dataset: ds, window: 'last_month', limit: 3, now: Date.UTC(2026, 10, 3) });
  assert.equal(r.total, 13);
  assert.deepEqual(r.rows.map(x => x.data.deal), ['Deal on c2', 'Deal 11', 'Deal 10']);
  assert.equal((await readDatasetRowsForRun(sb, { workspaceId: 'ws', dataset: ds, window: 'last_month', now: Date.UTC(2026, 9, 3) })).total, 0);
});

// ── The workflow-engine steps ──────────────────────────────────────────────────────────────────

async function withModel(answers, fn) {
  const before = process.env.WRITING_MODEL;
  process.env.WRITING_MODEL = 'claude-haiku-4-5-20251001';
  const asks = [];
  const queue = [...answers];
  registerAnthropicClient({ messages: { create: async (a) => { asks.push(a); return { model: 'm', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: queue.shift() ?? '' }] }; } } }, { acceptsFeature: false });
  const meters = [];
  registerStepHandler('meter', async (m) => { meters.push(m); });
  registerStepHandler('revbox_visible_accounts', async () => null);
  try { return await fn({ asks, meters }); } finally {
    if (before === undefined) delete process.env.WRITING_MODEL; else process.env.WRITING_MODEL = before;
    registerAnthropicClient(null);
  }
}
const sys = (a) => (typeof a.system === 'string' ? a.system : JSON.stringify(a.system));
const job = (steps, extra = {}) => ({ id: uuid(700), name: 'Win/loss analysis', user_id: 'owner', revbox_id: 'box', trigger_kind: 'deal_closed_won', steps, ...extra });

test('Add to table: a deal brief (no JSON) is shaped into one row by one metered call; the deal is the row\'s entity; a re-run adds nothing', () => withModel(
  // The re-run shapes again (it does not know yet), then the dedupe key keeps the first row.
  [1, 2].map(() => JSON.stringify({ row: { deal: 'Harborline platform', outcome: 'Won', value: '48000', close_date: '2026-10-12', icp_fit: true }, summary: 'Won on reporting.' })),
  async ({ asks, meters }) => {
    const sb = database();
    await createRevboxDataset(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', body: { name: 'Win/loss', columns: COLUMNS } });
    const brief = { id: 'd1', title: 'Harborline — closed won', sections: [{ label: 'Why they bought', body: 'Reporting and SSO. $48,000 ARR, signed 12 Oct.' }] };
    const steps = [{ id: 'analyse', type: 'agent', config: { mode: 'write', prompt: 'Analyse the deal against our ICP.' } }, { id: 'row', type: 'dataset_append', config: { dataset_key: 'win_loss', dedupe_from: 'deal' } }];
    const opts = { stage: 'closed_won', ctx: { supabase: sb, workspaceId: 'ws', runId: uuid(801), entityId: uuid(101), dealId: uuid(501) } };
    const r = await runSteps(job(steps), brief, opts);
    assert.equal(r.failed, undefined, r.message);
    assert.equal(asks.length, 1);
    assert.match(sys(asks[0]), /table "Win\/loss"[\s\S]*ONE JSON object/);
    assert.match(asks[0].messages[0].content, /Reporting and SSO/);
    assert.equal(meters.length, 1);
    assert.equal(meters[0].requestId, `automation-run:${uuid(801)}:dataset:row`);
    const [row] = sb.tables.revbox_dataset_rows;
    assert.deepEqual(row.data, { deal: 'Harborline platform', outcome: 'Won', value: 48000, close_date: '2026-10-12', icp_fit: true });
    assert.equal(row.entity_id, uuid(501));
    assert.equal(row.source_run_id, uuid(801));
    assert.equal(row.source_job_id, uuid(700));
    assert.equal(row.dedupe_key, `deal:${uuid(501)}:closed_won`);
    assert.equal(r.log.at(-1).detail, 'Added a row to Win/loss');
    const again = await runSteps(job(steps), brief, { ...opts, ctx: { ...opts.ctx, runId: uuid(802) } });
    assert.equal(again.log.at(-1).detail, 'Already in the table: nothing added');
    assert.equal(sb.tables.revbox_dataset_rows.length, 1);
  }));

test('Add to table: an AI step written in the loop writes the row JSON itself (one call); the document keeps words, not JSON', () => withModel(
  [JSON.stringify({ row: { deal: 'Fernpoint', outcome: 'Lost', value: 9000 }, summary: 'Lost to a cheaper tool.' })],
  async ({ asks }) => {
    const sb = database();
    await createRevboxDataset(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', body: { name: 'Win/loss', columns: COLUMNS } });
    const r = await runSteps(job([
      { id: 'analyse', type: 'agent', config: { mode: 'write', prompt: 'Analyse it.' } },
      { id: 'row', type: 'dataset_append', config: { dataset_key: 'win_loss', dedupe_from: 'none' } },
    ], { trigger_kind: 'clock' }), null, { stage: 'scheduled', ctx: { supabase: sb, workspaceId: 'ws', runId: uuid(803), writeAllInLoop: true, seedData: [{ id: 'x', step: 0, label: 'CRM', text: 'Fernpoint lost, $9k' }] } });
    assert.equal(r.failed, undefined, r.message);
    assert.equal(asks.length, 1, 'no second shaping call');
    assert.match(sys(asks[0]), /ONE JSON object[\s\S]*"row"/);
    assert.deepEqual(sb.tables.revbox_dataset_rows[0].data, { deal: 'Fernpoint', outcome: 'Lost', value: 9000 });
    assert.equal(sb.tables.revbox_dataset_rows[0].dedupe_key, null);
    const saved = sb.tables.documents?.[0];
    if (saved) assert.doesNotMatch(JSON.stringify(saved.sections ?? saved), /"row"/);
  }));

test('Read table hands the next AI step the month\'s rows (as {{steps.<id>.output}} too), and the AI writes the report', () => withModel(['## Win/loss, September\n\nWon 8, lost 4.'], async ({ asks }) => {
  const { sb } = await seeded();
  const realNow = Date.now;
  Date.now = () => Date.UTC(2026, 10, 1, 9);   // 1 Nov: last month is October, when the fake rows were added
  try {
    const r = await runSteps(job([
      { id: 'rows', type: 'dataset_read', config: { dataset_key: 'win_loss', window: 'last_month', limit: 50 } },
      { id: 'report', type: 'agent', config: { mode: 'write', prompt: 'Write the monthly win/loss report. Rows: {{steps.rows.output}}' } },
    ], { trigger_kind: 'clock' }), null, { stage: 'scheduled', ctx: { supabase: sb, workspaceId: 'ws', runId: uuid(804) } });
    assert.equal(r.failed, undefined, r.message);
    assert.equal(r.log[0].detail, 'Read 13 rows from the table');
    assert.equal(asks.length, 1);
    assert.match(asks[0].messages[0].content, /Table "Win\/loss": 13 rows added in last month \(2026-10-01 to 2026-10-31\)/);
    assert.match(sys(asks[0]), /Rows: Table "Win\/loss"/);
  } finally { Date.now = realNow; }
}));

test('Read table as an owner who sees no accounts leaves out rows about accounts', () => withModel(['ok'], async ({ asks }) => {
  const { sb } = await seeded();
  registerStepHandler('revbox_visible_accounts', async () => new Set());
  const r = await runSteps(job([
    { id: 'rows', type: 'dataset_read', config: { dataset_key: 'win_loss' } },
    { id: 'report', type: 'agent', config: { mode: 'write', prompt: 'Report.' } },
  ], { trigger_kind: 'clock' }), null, { stage: 'scheduled', ctx: { supabase: sb, workspaceId: 'ws', runId: uuid(805) } });
  assert.equal(r.log[0].detail, 'Read 6 rows from the table');
  assert.doesNotMatch(asks[0].messages[0].content, /Deal 11|Deal on c2/);
}));

test('the table steps only run in a RevBox job, on a table the box has', () => withModel([], async () => {
  const sb = database();
  const notBox = await runSteps({ ...job([{ id: 'rows', type: 'dataset_read', config: { dataset_key: 'win_loss' } }]), revbox_id: null }, null, { stage: 'scheduled', ctx: { supabase: sb, workspaceId: 'ws' } });
  assert.match(notBox.message, /isn't a RevBox job/);
  const missing = await runSteps(job([{ id: 'rows', type: 'dataset_read', config: { dataset_key: 'nope' } }]), null, { stage: 'scheduled', ctx: { supabase: sb, workspaceId: 'ws' } });
  assert.match(missing.message, /no table with that key/);
  const unset = await runSteps(job([{ id: 'row', type: 'dataset_append', config: {} }]), { id: 'd', title: 't', sections: [{ label: 'A', body: 'b' }] }, { stage: 'x', ctx: { supabase: sb, workspaceId: 'ws' } });
  assert.match(unset.message, /pick the table/);
  // A stranger's box: the owner can no longer open it, so nothing runs.
  const lost = await runSteps(job([{ id: 'rows', type: 'dataset_read', config: { dataset_key: 'win_loss' } }], { user_id: 'stranger' }), null, { stage: 'scheduled', ctx: { supabase: sb, workspaceId: 'ws' } });
  assert.match(lost.message, /can no longer open its RevBox/);
}));

test('dedupe keys: one row per deal and outcome by default, per account, or none', () => {
  assert.equal(datasetDedupeKey(undefined, { dealId: 'd1', entityId: 'a1', stage: 'closed_lost' }), 'deal:d1:closed_lost');
  assert.equal(datasetDedupeKey('deal', { entityId: 'a1', stage: 'closed_won' }), 'account:a1:closed_won');
  assert.equal(datasetDedupeKey('account', { dealId: 'd1', entityId: 'a1' }), 'account:a1');
  assert.equal(datasetDedupeKey('none', { dealId: 'd1' }), null);
  assert.equal(datasetDedupeKey('deal', {}), null);
});

// ── Review fixes: a test writes no row, dedupe per event, a clean cursor ───────────────────────

const ROW_ANSWER = JSON.stringify({ row: { deal: 'Harborline platform', outcome: 'Won', value: '48000' }, summary: 'Won on reporting.' });
const BRIEF = { id: 'd1', title: 'Harborline — closed won', sections: [{ label: 'Why they bought', body: 'Reporting and SSO. $48,000 ARR.' }] };
const APPEND = [{ id: 'analyse', type: 'agent', config: { mode: 'write', prompt: 'Analyse the deal.' } }, { id: 'row', type: 'dataset_append', config: { dataset_key: 'win_loss' } }];

test('a held Test shapes the row and shows it, but adds nothing to the table', () => withModel([ROW_ANSWER], async ({ asks }) => {
  const sb = database();
  await createRevboxDataset(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', body: { name: 'Win/loss', columns: COLUMNS } });
  const r = await runSteps(job(APPEND), BRIEF, { stage: 'closed_won', ctx: { supabase: sb, workspaceId: 'ws', runId: uuid(811), entityId: uuid(101), dealId: uuid(501), holdSends: true } });
  assert.equal(r.failed, undefined, r.message);
  assert.equal(asks.length, 1, 'the row is still shaped');
  assert.equal(sb.tables.revbox_dataset_rows.length, 0);
  const line = r.log.at(-1);
  assert.equal(line.status, 'held');
  assert.equal(line.held, true);
  assert.equal(line.detail, 'Would add a row to Win/loss');
  assert.ok(line.preview.some(x => x.label === 'Deal' && x.value === 'Harborline platform'));
  assert.ok(line.preview.some(x => x.label === 'Value' && x.value === '48000'));
}));

test('a test run that sends for real (Run now) still never writes a table row', () => withModel([ROW_ANSWER], async () => {
  const sb = database();
  await createRevboxDataset(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', body: { name: 'Win/loss', columns: COLUMNS } });
  const r = await runSteps(job(APPEND), BRIEF, { stage: 'closed_won', ctx: { supabase: sb, workspaceId: 'ws', runId: uuid(812), entityId: uuid(101), dealId: uuid(501), test: true } });
  assert.equal(r.failed, undefined, r.message);
  assert.equal(sb.tables.revbox_dataset_rows.length, 0);
  assert.equal(r.log.at(-1).detail, 'Would add a row to Win/loss');
}));

test('startTestRun marks the run a test, so its table step adds no row', () => withModel([ROW_ANSWER], async () => {
  const sb = database({ agent_routines: [{ ...job(APPEND, { trigger_kind: 'clock' }), workspace_id: 'ws' }], agent_routine_runs: [] });
  await createRevboxDataset(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', body: { name: 'Win/loss', columns: COLUMNS } });
  const out = await startTestRun(sb, 'ws', uuid(700));
  assert.equal(out.ok, true, out.message);
  const run = () => sb.tables.agent_routine_runs.find(x => x.id === out.run_id);
  for (let i = 0; i < 200 && run().status === 'running'; i++) await new Promise(res => setTimeout(res, 2));
  assert.notEqual(run().status, 'running');
  assert.equal(sb.tables.revbox_dataset_rows.length, 0);
  assert.equal(run().step_log.at(-1).detail, 'Would add a row to Win/loss');
}));

test('dedupe keys: the default keys by deal only when the run has one; otherwise by the event', () => {
  // A deal run: one row per deal and outcome, as before; a close with no deal id is the account's close.
  assert.equal(datasetDedupeKey(undefined, { dealId: 'd1', entityId: 'a1', stage: 'closed_won', event: 'call:m1' }), 'deal:d1:closed_won');
  assert.equal(datasetDedupeKey(undefined, { entityId: 'a1', stage: 'closed_won' }), 'account:a1:closed_won');
  // No deal: one row per call, signal or run, never one per account.
  assert.equal(datasetDedupeKey(undefined, { entityId: 'a1', stage: 'call_ended', event: 'call:m1' }), 'call:m1');
  assert.equal(datasetDedupeKey('deal', { entityId: 'a1', stage: 'call_ended', event: 'call:m2' }), 'call:m2');
  assert.equal(datasetDedupeKey(undefined, { entityId: 'a1', stage: 'scheduled', event: null }), null);
  assert.equal(datasetDedupeKey('account', { entityId: 'a1', event: 'call:m1' }), 'account:a1');
});

test('Add to table on two calls with the same account keeps both rows; the same call twice keeps one', () => withModel([ROW_ANSWER, ROW_ANSWER, ROW_ANSWER], async () => {
  const sb = database();
  await createRevboxDataset(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', body: { name: 'Win/loss', columns: COLUMNS } });
  const onCall = (m, n) => runSteps(job(APPEND, { trigger_kind: 'call_ended' }), BRIEF, { stage: 'call_ended', ctx: { supabase: sb, workspaceId: 'ws', runId: uuid(820 + n), entityId: uuid(101), dealId: null, call: { meetingId: m } } });
  await onCall('m1', 1);
  await onCall('m2', 2);
  const again = await onCall('m2', 3);
  assert.deepEqual(sb.tables.revbox_dataset_rows.map(x => x.dedupe_key), ['call:m1', 'call:m2']);
  assert.equal(again.log.at(-1).detail, 'Already in the table: nothing added');
}));

test('Add to table on account signals keys by the signal and its conversation', () => withModel([ROW_ANSWER, ROW_ANSWER], async () => {
  const sb = database();
  await createRevboxDataset(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', body: { name: 'Win/loss', columns: COLUMNS } });
  const sig = (id, ref) => ({ id, kind: 'churn_risk', account_id: uuid(101), source_ref: ref, occurred_at: '2026-10-10T10:00:00Z' });
  for (const [n, s] of [[1, sig('s1', 'source://gmail/t1')], [2, sig('s2', 'source://gmail/t2')]]) {
    await runSteps(job(APPEND, { trigger_kind: 'account_signal' }), BRIEF, { stage: 'churn_risk', ctx: { supabase: sb, workspaceId: 'ws', runId: uuid(830 + n), entityId: uuid(101), dealId: null, signal: s } });
  }
  assert.deepEqual(sb.tables.revbox_dataset_rows.map(x => x.dedupe_key), ['signal:s1:ref:source://gmail/t1', 'signal:s2:ref:source://gmail/t2']);
}));

test('a cursor is checked: a time with a comment or quote, or an id that is not a uuid, never reaches the filter', () => {
  const enc = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const id = uuid(5);
  // Date.parse reads a parenthesised comment as a comment, so this used to pass through whole.
  const evil = '2026-10-01 (",id.gt.0)';
  assert.ok(!Number.isNaN(Date.parse(evil)));
  assert.throws(() => decodeDatasetCursor(enc({ t: evil, i: id })), e => e.status === 400);
  // What Postgres writes passes as it is, microseconds kept, so the next page starts exactly there.
  assert.deepEqual(decodeDatasetCursor(enc({ t: '2026-10-01T00:00:00.123456+00:00', i: id })), { t: '2026-10-01T00:00:00.123456+00:00', i: id });
  assert.deepEqual(decodeDatasetCursor(enc({ t: '2026-10-01T00:00:00.000Z', i: id })), { t: '2026-10-01T00:00:00.000Z', i: id });
  assert.throws(() => decodeDatasetCursor(enc({ t: '2026-10-01T00:00:00Z', i: '-'.repeat(36) })), e => e.status === 400);
  assert.throws(() => decodeDatasetCursor(enc({ t: 'nope', i: id })), e => e.status === 400);
});

// GET-883: a Read table step hands the next AI step a whole quarter of a busy win/loss table
// (~320 rows of 10 columns), and the table still fits the AI step's material limit.
test('Read table fits a quarter of a ten-column win/loss table, within the material limit', async () => {
  const { DATASET_READ_CHARS } = await import('../dist/services/datasetFormats.mjs');
  const { MATERIAL_CHARS } = await import('../dist/services/automationRun.mjs');
  const ds = { name: 'Win/loss deals', columns: normalizeDatasetColumns([
    { label: 'Deal' }, { label: 'Account' }, { label: 'Outcome', type: 'enum', options: ['Won', 'Lost'] }, { label: 'Value (USD)', type: 'number' },
    { label: 'Close date', type: 'date' }, { label: 'Sales cycle days', type: 'number' }, { label: 'ICP fit', type: 'enum', options: ['Strong', 'Partial', 'Weak'] },
    { label: 'Reason category' }, { label: 'Primary reason' }, { label: 'Competitor' },
  ]).columns };
  const rows = Array.from({ length: 380 }, (_, i) => ({ created_at: '2026-08-15T12:00:00Z', data: {
    deal: `Brackenridge Motor Group ${i} - Credit Platform`, account: `Brackenridge Motor Group ${i}`, outcome: i % 4 ? 'Lost' : 'Won', value_usd: 11988,
    close_date: '2026-08-14', sales_cycle_days: 64, icp_fit: 'Partial', reason_category: 'Product fit', primary_reason: 'Needed an integration we do not offer yet', competitor: 'Rivalsoft' } }));
  const text = datasetRowsTable(ds, rows, { window: 'last_quarter', total: 380 });
  assert.doesNotMatch(text, /more rows not shown/, `${text.length} characters`);
  assert.ok(DATASET_READ_CHARS < MATERIAL_CHARS, 'leaves room in the AI step material for the box context');
});
