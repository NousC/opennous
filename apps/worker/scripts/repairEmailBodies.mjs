#!/usr/bin/env node
// Re-fetch the email bodies the importer never asked for (GET-396).
//
// `ENGAGEMENT_PROPERTIES.emails` asked HubSpot for `hs_email_text` and not `hs_email_html`, and
// HubSpot leaves the text field EMPTY for an HTML-only message — which is what a real person's
// mail client sends. Our own sends go out through HubSpot and do populate text, so the damage is
// one-sided: on one customer workspace, a few percent of sent mail lost its body and about a third
// of received did.
//
// Read that third carefully before believing it. Most of it is machine mail we already skip
// (note-taker summaries, dialer logs, HR and phone-system notices). Among senders who are
// actual people — the only ones whose words can ground a claim about them — it is about one in
// ten, and flat month to month rather than rising. Worth repairing; not a crisis.
//
// NO MODEL CALLS. It reads HubSpot and writes a column.
//
// SAFE BY DEFAULT: dry run. --apply writes.
//
// Idempotent: a row that already has a body is never read from HubSpot or written.
//
// USAGE (worker image, prod env):
//   WS_ID=<uuid> node apps/worker/scripts/repairEmailBodies.mjs              # plan only
//   WS_ID=<uuid> node apps/worker/scripts/repairEmailBodies.mjs --apply
//   WS_ID=<uuid> HUBSPOT_TOKEN=... node …                                    # explicit token
//   REPAIR_MACHINE_DOMAINS=jira.example.com,relay.example.com WS_ID=<uuid> node …  # + this workspace's machine domains
//
// The token comes from the workspace's own HubSpot connection unless HUBSPOT_TOKEN is set. It is
// never printed.

import '../src/bootEnv.mjs';
import { getSupabaseClient, messageBodyText } from '@nous/core';
import { decrypt } from '../src/utils/encryption.mjs';

const WS = process.env.WS_ID;
const APPLY = process.argv.includes('--apply');
const LIMIT = Number(process.env.LIMIT ?? 0) || Infinity;
if (!WS) { console.error('WS_ID is required'); process.exit(1); }

const PAGE = 500;          // rows per PostgREST read
const BATCH = 100;         // HubSpot's batch/read ceiling
const supabase = getSupabaseClient();

// Senders whose mail is a notification, not a person.
//
// These are SKIPPED by default, and that is a decision the first dry run made for us: most of the
// first fifty empty rows were machine mail, and what came back was a long note-taker activity
// summary per row. The thread selector drops those threads on the sender alone,
// so the body will never be read by anything — repairing all of them would write tens of megabytes of
// text nobody can ever use, and make the run several times longer. --all includes them anyway.
// A workspace's own machine domains (its Jira, its Intercom relay) are per client, so they come
// from REPAIR_MACHINE_DOMAINS (comma-separated) rather than this file (GET-761).
const MACHINE = new Set(['fellow.app', 'justcall.io', 'app.bamboohr.com', 'ringcentral.com',
  'fyxer.com', 'hubspot.com',
  ...String(process.env.REPAIR_MACHINE_DOMAINS ?? '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean)]);
const isMachine = (from) => MACHINE.has(String(from ?? '').toLowerCase().split('@')[1] ?? '');
const ALL = process.argv.includes('--all');

async function hubspotToken() {
  if (process.env.HUBSPOT_TOKEN) return process.env.HUBSPOT_TOKEN;
  const { data: cfg } = await supabase.from('crm_sync_configs')
    .select('connection_id').eq('workspace_id', WS).eq('provider', 'hubspot').maybeSingle();
  if (!cfg?.connection_id) return null;
  const { data: conn } = await supabase.from('workflow_provider_connections')
    .select('encrypted_credentials').eq('id', cfg.connection_id).maybeSingle();
  const creds = {};
  for (const [k, v] of Object.entries(conn?.encrypted_credentials ?? {})) {
    if (typeof v !== 'string') continue;
    try { creds[k] = decrypt(v); } catch { creds[k] = v; }
  }
  return creds.access_token || creds.api_key
    || Object.values(creds).find(v => typeof v === 'string' && v.length > 0) || null;
}

/** Every email row with no body anywhere, keyset-paged so it never pays offset's linear cost. */
let skippedMachine = 0;

// The two email properties, named rather than matched.
//
// `property LIKE 'interaction.email%'` cost seconds for the FIRST page and the run died on the
// 8s statement timeout before printing a line. A prefix LIKE cannot use the btree under the
// default collation, so it degrades into a filtered walk of the primary key. Naming both values
// takes the same page to tens of milliseconds — fifty times faster — because `property = ANY (...)` is an index condition.
//
// Third time today this shape has cost a run: GET-329's read marker did it with
// 'noema.read.gmail_%', over half a million rows in seconds. A prefix match on an indexed column is not a
// filter, it is a scan wearing one.
const EMAIL_PROPERTIES = ['interaction.email_sent', 'interaction.email_received'];

// And NOT `raw->>'text' is null` in the query, tempting as that is: pushing the emptiness test
// into SQL forces a detoast of every body to evaluate it, and takes the same page to
// over a minute. Reading the page and deciding in JS is the cheap half.

async function findEmptyRows() {
  const out = [];
  let cursor = null;
  let pageSize = PAGE;
  for (;;) {
    let q = supabase.from('observations')
      // Project the three jsonb fields rather than `raw`: the bodies we DO have are up to 20k
      // each and there are six figures of them, and this pass needs to know only that they are absent.
      .select('id, hs:raw->>hubspot_id, from:raw->>from, t:raw->>text, b:raw->>body')
      .eq('workspace_id', WS).in('property', EMAIL_PROPERTIES)
      .order('id', { ascending: true }).limit(pageSize);
    if (cursor) q = q.gt('id', cursor);
    const { data, error } = await q;
    // A page that times out anyway is halved and retried rather than killing the run. The scan
    // is resumable by construction — the cursor is the last id seen — so this costs one retry,
    // not a restart.
    if (error?.code === '57014' && pageSize > 25) {
      pageSize = Math.floor(pageSize / 2);
      console.warn(`[EMAIL-BODY] page timed out, retrying at ${pageSize}`);
      continue;
    }
    if (error) throw error;
    const rows = data ?? [];
    if (!rows.length) return out;
    for (const r of rows) {
      if ((r.t ?? '').length || (r.b ?? '').length) continue;   // already has something to read
      if (!r.hs) continue;                                      // no HubSpot id: nothing to fetch
      if (!ALL && isMachine(r.from)) { skippedMachine++; continue; }
      out.push(r);
      if (out.length >= LIMIT) return out;
    }
    cursor = rows[rows.length - 1].id;
    if (rows.length < pageSize) return out;
  }
}

/** hs_email_text and hs_email_html for up to 100 engagements. */
async function readEmails(token, ids) {
  const res = await fetch('https://api.hubapi.com/crm/v3/objects/emails/batch/read', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      properties: ['hs_email_text', 'hs_email_html'],
      inputs: ids.map(id => ({ id: String(id) })),
    }),
  });
  if (!res.ok) throw new Error(`HubSpot ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const byId = new Map();
  for (const r of json.results ?? []) byId.set(String(r.id), r.properties ?? {});
  return byId;
}

const rows = await findEmptyRows();
console.log(`[EMAIL-BODY] ${rows.length} row(s) to repair` +
  (ALL ? ' (people and machines)' : ` · ${skippedMachine} machine-sender row(s) left alone — pass --all to include them`));
if (!rows.length) process.exit(0);

const token = await hubspotToken();
if (!token) { console.error('[EMAIL-BODY] no HubSpot token — set HUBSPOT_TOKEN or connect HubSpot'); process.exit(1); }

let fetched = 0, recovered = 0, stillEmpty = 0, written = 0, failed = 0, chars = 0;
const samples = [];

for (let i = 0; i < rows.length; i += BATCH) {
  const chunk = rows.slice(i, i + BATCH);
  let props;
  try {
    props = await readEmails(token, chunk.map(r => r.hs));
  } catch (err) {
    failed += chunk.length;
    console.warn(`[EMAIL-BODY] batch at ${i} failed: ${err.message}`);
    continue;
  }
  fetched += chunk.length;

  for (const r of chunk) {
    const p = props.get(String(r.hs));
    // Same derivation as the importer, deliberately: two ways to turn a HubSpot email into text
    // is the bug shape that costs most, and this one has to agree with hubspotEngagementToActivity
    // exactly or a repaired row reads differently from a freshly imported one.
    const body = messageBodyText(p?.hs_email_text || p?.hs_email_html, { preview: true });
    if (!body) { stillEmpty++; continue; }             // genuinely empty in HubSpot too
    recovered++; chars += body.length;
    if (samples.length < 3) samples.push({ id: r.id, from: r.from, text: body.slice(0, 90) });
    if (!APPLY) continue;

    const { data: cur, error: readErr } = await supabase.from('observations')
      .select('value, raw').eq('id', r.id).maybeSingle();
    if (readErr || !cur) { failed++; continue; }
    const value = { ...(cur.value ?? {}) };
    if (value.summary == null || value.summary === '') value.summary = body.slice(0, 300);
    const { error: upErr } = await supabase.from('observations')
      .update({ value, raw: { ...(cur.raw ?? {}), text: body.slice(0, 20_000), body: body.slice(0, 20_000) } })
      .eq('id', r.id);
    if (upErr) { failed++; console.warn(`[EMAIL-BODY] update ${r.id} failed: ${upErr.message}`); }
    else written++;
  }
  if ((i / BATCH) % 10 === 0) console.log(`[EMAIL-BODY] … ${fetched}/${rows.length} fetched · ${recovered} recovered`);
}

for (const s of samples) console.log(`[EMAIL-BODY] sample ${s.from}: ${JSON.stringify(s.text)}`);
console.log(`[EMAIL-BODY] ${fetched} fetched · ${recovered} had a body in HubSpot · ${stillEmpty} empty there too · ` +
  `${written} written · ${failed} failed · ${Math.round(chars / Math.max(1, recovered))} avg chars · ` +
  `${APPLY ? 'APPLIED' : 'DRY RUN — nothing written'}`);
if (failed) process.exitCode = 1;
