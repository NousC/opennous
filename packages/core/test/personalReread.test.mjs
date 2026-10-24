// A personal mark skips what its person says, and a Slack conversation read while it was on stays
// read. Unmarking queues those conversations for a fresh read, and only those (GET-1024).
//
// Run: cd packages/core && npm run build && node --test test/personalReread.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rereadSlackSince, slackConversations } from '../dist/db/personalReread.js';

const WS = 'ws-1';
const MARKED = '2026-10-22T21:19:00Z';

// A Supabase stand-in over in-memory tables: the filters the module uses, and update().
function fakeDb(tables) {
  return {
    tables,
    from(table) {
      const preds = [];
      let patch = null;
      const q = {
        select: () => q, limit: () => q,
        eq: (k, v) => { preds.push(r => r[k] === v); return q; },
        in: (k, vs) => { preds.push(r => vs.includes(r[k])); return q; },
        gte: (k, v) => { preds.push(r => r[k] != null && r[k] >= v); return q; },
        update: (p) => { patch = p; return q; },
        then: (resolve) => {
          const hit = (tables[table] ?? []).filter(r => preds.every(f => f(r)));
          if (patch) for (const r of hit) Object.assign(r, patch);
          resolve({ data: hit.map(r => ({ ...r })), error: null });
        },
      };
      return q;
    },
  };
}

const msg = (entity_id, conv, created_at, property = 'interaction.slack_dm') =>
  ({ workspace_id: WS, entity_id, property, created_at, raw: { source_ref: `source://slack/T1/D1/${conv}/fp-${conv}` } });
const read = (conversation_id, processed_at) => ({ source_id: 'src-1', conversation_id, fingerprint: `fp-${conversation_id}`, processed_at });
const db = () => fakeDb({
  entity_list_rows: [{ workspace_id: WS, entity_id: 'p-nell', kind: 'person', company_id: 'co-arden' }],
  slack_ingestion_sources: [{ id: 'src-1', workspace_id: WS, slack_team_id: 'T1', slack_channel_id: 'D1' }],
  observations: [
    msg('p-nell', 'hour-2', '2026-10-22T21:26:00Z'),
    msg('p-nell', 'hour-2', '2026-10-22T21:27:00Z'),
    msg('p-nell', 'hour-1', '2026-10-22T20:00:00Z'),
    msg('p-ivo', 'hour-3', '2026-10-22T21:30:00Z'),
  ],
  slack_ingestion_reads: [read('hour-1', '2026-10-22T20:05:00Z'), read('hour-2', '2026-10-22T21:26:41Z'), read('hour-3', '2026-10-22T21:31:00Z')],
});

test('a conversation read while the mark was on is read again; one read before it is not', async () => {
  const sb = db();
  assert.equal(await rereadSlackSince(sb, WS, 'p-nell', MARKED), 1);
  const fp = Object.fromEntries(sb.tables.slack_ingestion_reads.map(r => [r.conversation_id, r.fingerprint]));
  assert.deepEqual(fp, { 'hour-1': 'fp-hour-1', 'hour-2': null, 'hour-3': 'fp-hour-3' });
});

test('unmarking a company re-reads what its people said', async () => {
  const sb = db();
  assert.equal(await rereadSlackSince(sb, WS, 'co-arden', MARKED), 1);
  assert.equal(sb.tables.slack_ingestion_reads.find(r => r.conversation_id === 'hour-2').fingerprint, null);
});

test('a source ref names its Slack conversation once; anything else is ignored', () => {
  assert.deepEqual(slackConversations(['source://slack/T1/C9/hour-7/abc', 'source://slack/T1/C9/hour-7/def', 'source://fireflies/x', null]),
    [{ teamId: 'T1', channelId: 'C9', conversationId: 'hour-7' }]);
});

test('a failure never blocks the unmark', async () => {
  const broken = { from: () => { throw new Error('down'); } };
  assert.equal(await rereadSlackSince(broken, WS, 'p-nell', MARKED), 0);
});
