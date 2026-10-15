// GET-897: the after-call follow-up reads any connected recorder's meeting. Granola, Fireflies and
// Fathom keep a meeting's notes + transcript in a meeting_notes document keyed by source_ref; the
// builder finds it there (the activity rows carry no text, so before this only Fellow and HubSpot
// meetings ever got a card).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

// The follow-up engine is the Workspace layer's (src/cloud); the open-source export has none.
const builder = new URL('../src/cloud/workers/followUpBuilder.mjs', import.meta.url);
const { recorderNotes } = existsSync(builder) ? await import(builder.href) : {};

function claims(rows) {
  const calls = [];
  const q = {
    filters: [],
    select() { return this; }, gte() { return this; }, lt() { return this; },
    eq(k, v) { this.filters.push([k, v]); return this; },
    limit() { calls.push(this.filters); const ref = this.filters.find(([k]) => k === 'value->metadata->>source_ref')?.[1]; const ws = this.filters.find(([k]) => k === 'workspace_id')?.[1];
      return Promise.resolve({ data: rows.filter(r => r.ws === ws && r.value.metadata.source_ref === ref).map(r => ({ value: r.value })), error: null }); },
  };
  return { calls, from: () => ({ ...q, filters: [] }) };
}

test('a recorder meeting\'s notes are the longest meeting_notes copy under its source_ref', { skip: !recorderNotes && 'no Workspace layer in this checkout' }, async () => {
  const sb = claims([
    { ws: 'ws', value: { content: 'short copy', metadata: { source_ref: 'source://fireflies/01M0SV9', attendee_emails: ['buyer@client.example'] } } },
    { ws: 'ws', value: { content: 'Summary. Next steps: send pricing by Friday. Transcript follows.', metadata: { source_ref: 'source://fireflies/01M0SV9', attendee_emails: ['buyer@client.example', 'rep@us.example'] } } },
    { ws: 'other', value: { content: 'another workspace', metadata: { source_ref: 'source://fireflies/01M0SV9' } } },
  ]);
  const n = await recorderNotes(sb, 'ws', 'source://fireflies/01M0SV9');
  assert.match(n.text, /send pricing by Friday/);
  assert.deepEqual(n.attendeeEmails, ['buyer@client.example', 'rep@us.example']);
  assert.equal(await recorderNotes(sb, 'ws', 'source://granola/none'), null);
  assert.equal(await recorderNotes(sb, 'ws', null), null);
});
