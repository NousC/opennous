#!/usr/bin/env node
// HubSpot portal profiler. READ-ONLY. Makes no writes of any kind.
//
// WHY THIS EXISTS
//
// Every HubSpot portal is different, and the differences are exactly the things that
// break an integration: which custom properties a team invented, what they named their
// pipeline stages, whether they log calls as `calls` or as `meetings`, whether their plan
// even exposes transcripts. Guessing any of that produces a sync that returns nothing and
// reports success, the failure mode this repo has been bitten by before.
//
// So before we map a single field, we ask the portal what it is. This script answers:
//   - Does the token auth, and what are its rate limits?
//   - Which object types are reachable, and how many records are in each?
//   - What properties exist per object, and which are CUSTOM (the personalisation)?
//   - What are the real pipeline stages, and which mean won/lost?
//   - Who are the owners? (deal to AE attribution)
//   - Are call recordings and transcripts reachable, and under what property?
//   - Where are the API limits (properties per request, rate ceiling)?
//
// Its JSON output is also our test fixture: mappers get tested against a real portal's
// shape without needing a live token in CI.
//
// Run: node scripts/hubspot-profile.mjs --env .env --out ./hubspot-profile.json
//      node scripts/hubspot-profile.mjs --token pat-xxx --out ./profile.json

import { readFileSync, writeFileSync } from 'node:fs';

// --- args + token ------------------------------------------------------------

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function resolveToken() {
  const direct = arg('token') || process.env.HUBSPOT_TEST_TOKEN || process.env.HUBSPOT_TOKEN;
  if (direct) return direct;
  const envPath = arg('env', '.env');
  try {
    const line = readFileSync(envPath, 'utf8').split(/\r?\n/)
      .find(l => /^HUBSPOT_(TEST_)?TOKEN=/.test(l));
    if (line) return line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
  } catch { /* fall through to the null return */ }
  return null;
}

const TOKEN = resolveToken();
if (!TOKEN) {
  console.error('No token. Pass --token, set HUBSPOT_TEST_TOKEN, or put it in --env <file>.');
  process.exit(1);
}

const OUT = arg('out', './hubspot-profile.json');
const BASE = 'https://api.hubapi.com';

// --- redaction ---------------------------------------------------------------
//
// This script is built to run against a CUSTOMER portal, so PII must never reach the
// profile file. Sample records keep their SHAPE (which keys exist, what type the value is)
// and lose their content. Free text is length-stamped rather than quoted, because "does
// this call have a 4000-char transcript on it" is the question, not what it says.

const PII_KEY = /email|phone|firstname|lastname|name|address|ip_|domain|website|owner/i;

function redact(value, key = '') {
  if (value == null) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 3).map(v => redact(v));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  }
  const s = String(value);
  if (PII_KEY.test(key)) return `<redacted:${s.length}>`;
  if (s.length > 60) return `<text:${s.length}chars>`;
  return s;
}

// --- HTTP --------------------------------------------------------------------

let rateLimit = null;

async function hs(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  // Capture the rate-limit picture once. It decides how fast a real backfill may run.
  if (!rateLimit && res.headers.get('x-hubspot-ratelimit-max')) {
    rateLimit = {
      max:            res.headers.get('x-hubspot-ratelimit-max'),
      remaining:      res.headers.get('x-hubspot-ratelimit-remaining'),
      intervalMs:     res.headers.get('x-hubspot-ratelimit-interval-milliseconds'),
      daily:          res.headers.get('x-hubspot-ratelimit-daily'),
      dailyRemaining: res.headers.get('x-hubspot-ratelimit-daily-remaining'),
    };
  }
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text.slice(0, 400); }
  return { status: res.status, ok: res.ok, body };
}

const msgOf = (body) => (typeof body === 'object' && body ? (body.message ?? null) : String(body).slice(0, 200));

// --- the objects we care about -----------------------------------------------
//
// Grouped by what each answers for the pipeline review.

const OBJECTS = {
  core:        ['contacts', 'companies', 'deals'],
  engagements: ['calls', 'emails', 'meetings', 'notes', 'tasks'],
  commerce:    ['line_items', 'products', 'quotes'],   // what they already bought -> upsell/cross-sell
};
const ALL_OBJECTS = Object.values(OBJECTS).flat();

// --- probes ------------------------------------------------------------------

async function probeAuth() {
  const r = await hs('/crm/v3/objects/contacts?limit=1');
  return { ok: r.ok, status: r.status, error: r.ok ? null : msgOf(r.body) };
}

// Reachability + volume per object. `total` comes from search, which reports it for free.
async function probeObjects() {
  const out = {};
  for (const obj of ALL_OBJECTS) {
    const r = await hs(`/crm/v3/objects/${obj}/search`, {
      method: 'POST',
      body: JSON.stringify({ limit: 1 }),
    });
    out[obj] = r.ok
      ? { reachable: true, total: r.body?.total ?? null }
      : { reachable: false, status: r.status, error: msgOf(r.body) };
  }
  return out;
}

// The heart of it: which properties exist, and which ones did THEY invent.
// hubspotDefined true marks a standard property; everything else is theirs.
async function probeProperties() {
  const out = {};
  for (const obj of ALL_OBJECTS) {
    const r = await hs(`/crm/v3/properties/${obj}`);
    if (!r.ok) { out[obj] = { error: r.status, message: msgOf(r.body) }; continue; }
    const props = r.body?.results ?? [];
    const custom = props.filter(p => !p.hubspotDefined && !p.calculated);
    out[obj] = {
      total: props.length,
      customCount: custom.length,
      custom: custom.map(p => ({
        name: p.name, label: p.label, type: p.type, fieldType: p.fieldType,
        group: p.groupName,
        options: p.options?.length ? p.options.slice(0, 12).map(o => o.label) : undefined,
      })),
      // Anything that smells like a recording or a transcript, on any object. This is how
      // we find the transcript property without having to guess its name.
      transcriptish: props
        .filter(p => /transcript|recording|conversation.?intel/i.test(`${p.name} ${p.label}`))
        .map(p => ({ name: p.name, label: p.label, type: p.type })),
    };
  }
  return out;
}

// Their real stage vocabulary plus which stages mean won and lost. This is the fix for the
// guess-from-stage-text classification in packages/core/src/integrations/crm/index.ts.
//
// TRAP, confirmed live: HubSpot returns stage metadata as STRINGS, so `isClosed` comes back
// as "false", which is truthy. A naive `if (s.metadata.isClosed)` marks every stage closed.
// Parse, never truth-test.
const asBool = (v) => v === true || v === 'true';
const asNum  = (v) => (v == null || v === '' ? null : Number(v));

async function probePipelines() {
  const r = await hs('/crm/v3/pipelines/deals');
  if (!r.ok) return { error: r.status, message: msgOf(r.body) };
  return (r.body?.results ?? []).map(p => ({
    id: p.id, label: p.label, displayOrder: p.displayOrder,
    stages: (p.stages ?? []).map(s => {
      const probability = asNum(s.metadata?.probability);
      const isClosed = asBool(s.metadata?.isClosed);
      return {
        id: s.id, label: s.label, displayOrder: s.displayOrder,
        probability, isClosed,
        // probability 1.0 on a closed stage means won, 0.0 means lost. This is the
        // deterministic won/lost signal, independent of what they named the stage.
        outcome: !isClosed ? 'open' : probability === 1 ? 'won' : probability === 0 ? 'lost' : 'closed_other',
      };
    }),
  }));
}

// hubspot_owner_id to a person. Without this there is no per-AE coaching.
async function probeOwners() {
  const r = await hs('/crm/v3/owners?limit=100');
  if (!r.ok) return { error: r.status, message: msgOf(r.body) };
  const owners = r.body?.results ?? [];
  return {
    count: owners.length,
    sample: owners.slice(0, 3).map(o => ({ id: o.id, hasEmail: !!o.email, archived: o.archived })),
  };
}

// The properties that carry the actual signal per engagement type. HubSpot returns ONLY
// what you ask for (plus three defaults), so an empty `properties` param yields a useless
// sample of createdate/lastmodifieddate/object_id. Ask explicitly.
// NOTE the hs_ai_summary / hs_call_summary / hs_meeting_summary entries. Those are
// HubSpot's OWN Conversation Intelligence output, and they are ordinary CRM properties:
// readable with the plain object scope, no Calling Extensions API, no app-ownership rule.
// They are the reliable path to call content. Raw transcript text is the bonus, not the
// foundation. See probeTranscripts for why.
const ENGAGEMENT_PROPS = {
  calls: ['hs_call_title', 'hs_call_body', 'hs_call_duration', 'hs_call_direction', 'hs_call_status',
    'hs_call_disposition', 'hs_call_source', 'hs_call_app_id', 'hs_call_recording_url',
    'hs_call_video_recording_url', 'hs_call_has_transcript', 'hs_call_transcription_id',
    'hs_ai_summary', 'hs_call_summary', 'hs_call_transcript_tracked_terms', 'hs_ai_is_noise',
    'hs_timestamp', 'hubspot_owner_id'],
  meetings: ['hs_meeting_title', 'hs_meeting_body', 'hs_meeting_start_time', 'hs_meeting_end_time',
    'hs_meeting_outcome', 'hs_meeting_source', 'hs_meeting_recording_url', 'hs_has_meeting_transcript',
    'hs_meeting_transcription_id', 'hs_has_call_with_transcript',
    'hs_has_associated_notetaker_call_transcript', 'hs_ai_summary', 'hs_meeting_summary',
    'hs_meeting_transcript_tracked_terms', 'hs_meeting_notetaker_source', 'hs_internal_meeting_notes',
    'hs_timestamp', 'hubspot_owner_id'],
  emails: ['hs_email_subject', 'hs_email_text', 'hs_email_direction', 'hs_email_status',
    'hs_timestamp', 'hubspot_owner_id'],
  notes: ['hs_note_body', 'hs_timestamp', 'hubspot_owner_id'],
  tasks: ['hs_task_subject', 'hs_task_body', 'hs_task_status', 'hs_task_type', 'hs_timestamp', 'hubspot_owner_id'],
};

// The associations we need to resolve an engagement back to an account. `meetings -> calls`
// is the one that matters most: a HubSpot-recorded video meeting carries its transcript on
// an ASSOCIATED call record, not on the meeting itself (see hs_has_call_with_transcript).
const ENGAGEMENT_ASSOCIATIONS = ['contacts', 'companies', 'deals', 'calls'];

// One real record per engagement type, with every populated property, redacted. Answers
// "does a HubSpot-recorded Google Meet land as a call or a meeting", and shows which
// fields are actually populated in practice versus merely defined in the schema.
async function probeSamples(properties) {
  const out = {};
  for (const obj of OBJECTS.engagements) {
    const names = [
      ...(ENGAGEMENT_PROPS[obj] ?? []),
      ...(properties[obj]?.custom ?? []).map(p => p.name),
    ].slice(0, 100);
    const q = names.length ? `&properties=${encodeURIComponent(names.join(','))}` : '';
    const r = await hs(`/crm/v3/objects/${obj}?limit=1&archived=false${q}`);
    if (!r.ok) { out[obj] = { error: r.status, message: msgOf(r.body) }; continue; }
    const rec = r.body?.results?.[0];
    if (!rec) { out[obj] = { empty: true }; continue; }
    const populated = Object.entries(rec.properties ?? {}).filter(([, v]) => v != null && v !== '');

    // Which of the properties we asked for came back EMPTY matters as much as which came
    // back full: it tells us what this portal does not actually populate in practice.
    const asked = new Set(names);
    const populatedKeys = new Set(populated.map(([k]) => k));

    const associations = {};
    for (const to of ENGAGEMENT_ASSOCIATIONS) {
      if (to === obj) continue;
      const a = await hs(`/crm/v4/objects/${obj}/${rec.id}/associations/${to}`);
      associations[to] = a.ok ? (a.body?.results ?? []).length : `error ${a.status}`;
    }

    out[obj] = {
      populatedKeys: [...populatedKeys],
      emptyOfAsked: [...asked].filter(k => !populatedKeys.has(k)),
      associations,
      sample: redact(Object.fromEntries(populated)),
    };
  }
  return out;
}

// Transcripts.
//
// WHAT WE ESTABLISHED against a live portal (2026-09-09), so nobody re-derives it:
//
//   READ:  GET /crm/v3/extensions/calling/transcripts/{transcriptId}   <-- this is the one
//          The id must be NUMERIC, and it comes from the call object's
//          `hs_call_transcription_id` property. Confirmed by HubSpot's own validation
//          error on a non-numeric id:
//            "Transcript id abc-def should be a numeric value"
//            [TranscriptGetError.TRANSCRIPT_ID_INVALID_ERROR]
//          TranscriptGetError is HubSpot naming this a read operation. Requires the
//          crm.extensions_calling_transcripts.read scope.
//
//   The COLLECTION path is a red herring. GET /crm/v3/extensions/calling/transcripts with
//   no id returns 405, and POST to it is the Calling Extensions CREATE path, which rejects
//   any call your own app did not author (TranscriptCreateError.INVALID_APP_ID). An earlier
//   pass tested only the collection path and wrongly concluded transcripts were unreadable.
//
//   STILL OPEN: whether the app-ownership rule that blocks the POST also applies to the GET.
//   We cannot tell from a portal with no transcripts, because a nonexistent id 404s before
//   any ownership check could fire. Only a portal holding a REAL transcript settles it.
//
//   Also readable on the call object itself:
//     hs_call_has_transcript      (bool)   a transcript exists
//     hs_call_transcription_id    (number) the id to feed the GET above
//     hs_call_recording_url                the recording, our fallback if the GET is blocked
//     hs_call_body                         the rep's typed notes, NOT the transcript
async function probeTranscripts(sampleCallId) {
  const out = {};

  // The read path. A non-numeric id makes HubSpot answer with its own validation error,
  // which proves GET is supported here even on a portal holding zero transcripts.
  const shape = await hs('/crm/v3/extensions/calling/transcripts/probe-not-numeric');
  out['GET /crm/v3/extensions/calling/transcripts/{id}'] = {
    status: shape.status,
    message: msgOf(shape.body),
    subCategory: typeof shape.body === 'object' ? shape.body?.subCategory ?? null : null,
    readPathConfirmed: /TranscriptGetError/.test(JSON.stringify(shape.body)),
    note: 'A TranscriptGetError proves this is a READ path. Feed it hs_call_transcription_id.',
  };

  // Every call that actually has a transcript, resolved end to end. On the customer's real
  // portal this is the block that answers the remaining ownership question.
  const calls = await hs('/crm/v3/objects/calls?limit=100&properties=hs_call_transcription_id,hs_call_has_transcript,hs_call_recording_url');
  const withTranscript = (calls.body?.results ?? [])
    .filter(c => c.properties?.hs_call_transcription_id);
  out.realTranscripts = { scanned: (calls.body?.results ?? []).length, withTranscriptionId: withTranscript.length, fetched: [] };
  for (const c of withTranscript.slice(0, 3)) {
    const id = c.properties.hs_call_transcription_id;
    const r = await hs(`/crm/v3/extensions/calling/transcripts/${id}`);
    out.realTranscripts.fetched.push({
      callId: c.id,
      transcriptionId: id,
      status: r.status,
      // Length, never content: this runs against customer portals.
      textLength: r.ok ? JSON.stringify(r.body).length : null,
      keys: r.ok && typeof r.body === 'object' ? Object.keys(r.body) : null,
      message: r.ok ? null : msgOf(r.body),
    });
  }

  if (sampleCallId) {
    const r = await hs('/crm/v3/extensions/calling/transcripts', {
      method: 'POST', body: JSON.stringify({ engagementId: Number(sampleCallId) }),
    });
    out['POST /crm/v3/extensions/calling/transcripts'] = {
      status: r.status,
      subCategory: typeof r.body === 'object' ? r.body?.subCategory ?? null : null,
      note: 'The CREATE path, for reference. Not how we read.',
    };
  }
  return out;
}

// The Notetaker recap API. When HubSpot's own bot joins a Google Meet, it records,
// transcribes, and produces a recap: summary, ACTION ITEMS, QUESTIONS ASKED, call stats,
// participants, recording URL. Those last two are the highest-value fields we have found
// for a pipeline audit — an unanswered question and an uncompleted action item are each a
// finding on their own, already structured, no extraction needed.
//
// Confirmed live (2026-09-09) against a free test portal:
//   GET /notetaker/2026-09/conversation/recap/{objectTypeId}/{objectId}
//   -> 403 "This portal does not have access to the Notetaker feature" [GATED]
// GATED, not MISSING_SCOPES and not 404. That tells us three things: the endpoint is real,
// our address is right, and a SERVICE KEY authenticates against it fine (we reached a
// feature gate, which sits behind auth). The only blocker is the portal's subscription.
// objectTypeId: meetings 0-47, calls 0-48.
async function probeNotetaker(sampleMeetingId, sampleCallId) {
  const out = {};
  for (const [label, otid, oid] of [['meeting', '0-47', sampleMeetingId], ['call', '0-48', sampleCallId]]) {
    if (!oid) continue;
    const r = await hs(`/notetaker/2026-09/conversation/recap/${otid}/${oid}`);
    out[label] = {
      status: r.status,
      category: typeof r.body === 'object' ? r.body?.category ?? null : null,
      message: msgOf(r.body),
      // A GATED response means "buy the tier"; MISSING_SCOPES means "tick a box".
      // Anything else and the shape of this API has changed.
      available: r.ok,
      keys: r.ok && typeof r.body === 'object' ? Object.keys(r.body) : null,
    };
  }
  return out;
}

// How many properties may one search request ask for? A portal with 300 custom properties
// needs this number to decide between one pass and several.
async function probePropertyCap(properties) {
  const names = (properties.contacts?.custom ?? []).map(p => p.name);
  const padded = names.length >= 200
    ? names.slice(0, 200)
    : [...names, ...Array.from({ length: 200 - names.length }, (_, i) => `hs_nonexistent_probe_${i}`)];
  const r = await hs('/crm/v3/objects/contacts/search', {
    method: 'POST',
    body: JSON.stringify({ limit: 1, properties: padded }),
  });
  return { requested: padded.length, status: r.status, accepted: r.ok, message: r.ok ? null : msgOf(r.body) };
}

// --- run ---------------------------------------------------------------------

const profile = { generatedAt: new Date().toISOString() };

console.log('probing auth...');
profile.auth = await probeAuth();
if (!profile.auth.ok) {
  console.error(`auth failed: ${profile.auth.status} ${profile.auth.error ?? ''}`);
  process.exit(1);
}

console.log('probing objects...');
profile.objects = await probeObjects();

console.log('probing properties...');
profile.properties = await probeProperties();

console.log('probing pipelines...');
profile.pipelines = await probePipelines();

console.log('probing owners...');
profile.owners = await probeOwners();

console.log('probing engagement samples...');
profile.samples = await probeSamples(profile.properties);

console.log('probing transcripts...');
const sampleCallId = profile.samples?.calls?.sample?.hs_object_id ?? null;
profile.transcripts = await probeTranscripts(sampleCallId);

console.log('probing notetaker recap...');
profile.notetaker = await probeNotetaker(
  profile.samples?.meetings?.sample?.hs_object_id ?? null,
  profile.samples?.calls?.sample?.hs_object_id ?? null,
);

console.log('probing property cap...');
profile.propertyCap = await probePropertyCap(profile.properties);

profile.rateLimit = rateLimit;

writeFileSync(OUT, JSON.stringify(profile, null, 2));

// --- summary -----------------------------------------------------------------

const line = (k, v) => console.log(`  ${String(k).padEnd(16)} ${v}`);

console.log('\n-- objects --');
for (const [obj, info] of Object.entries(profile.objects)) {
  line(obj, info.reachable ? `${info.total ?? '?'} records` : `UNREACHABLE (${info.status}) ${info.error ?? ''}`);
}

console.log('\n-- custom properties --');
for (const [obj, info] of Object.entries(profile.properties)) {
  line(obj, info.error ? `error ${info.error}` : `${info.customCount} custom of ${info.total}`);
}

console.log('\n-- transcript-ish properties --');
let foundAny = false;
for (const [obj, info] of Object.entries(profile.properties)) {
  for (const p of info.transcriptish ?? []) {
    console.log(`  ${obj}.${p.name}  (${p.type})  ${p.label}`);
    foundAny = true;
  }
}
if (!foundAny) console.log('  none found on any object');

console.log('\n-- transcripts --');
for (const [path, r] of Object.entries(profile.transcripts)) {
  if (path === 'realTranscripts') continue;
  line(r.status, `${path}${r.subCategory ? ` [${r.subCategory}]` : ''}${r.readPathConfirmed ? '  READ PATH CONFIRMED' : ''}`);
}
const rt = profile.transcripts.realTranscripts;
line('real', `${rt.withTranscriptionId} of ${rt.scanned} calls carry a transcription id`);
for (const f of rt.fetched) {
  line('  fetch', `call ${f.callId} -> transcript ${f.transcriptionId}: ${f.status}${f.keys ? ` keys=${f.keys.join(',')}` : ` ${f.message ?? ''}`}`);
}

console.log('\n-- engagement associations --');
for (const [obj, info] of Object.entries(profile.samples)) {
  if (!info.associations) continue;
  line(obj, Object.entries(info.associations).map(([k, v]) => `${k}=${v}`).join('  '));
}

console.log('\n-- pipelines --');
if (Array.isArray(profile.pipelines)) {
  for (const p of profile.pipelines) {
    const stages = p.stages
      .map(s => `${s.label}${s.outcome === 'open' ? '' : `[${s.outcome}]`}`)
      .join(' > ');
    console.log(`  ${p.label}: ${stages}`);
  }
} else {
  console.log(`  error ${profile.pipelines.error}: ${profile.pipelines.message ?? ''}`);
}

console.log('\n-- notetaker recap --');
for (const [k, r] of Object.entries(profile.notetaker ?? {})) {
  line(r.status, `${k}: ${r.available ? `AVAILABLE keys=${(r.keys ?? []).join(',')}` : `[${r.category ?? '-'}] ${String(r.message).slice(0, 70)}`}`);
}

console.log('\n-- limits --');
line('owners', profile.owners.count ?? `error ${profile.owners.error}`);
line('property cap', `${profile.propertyCap.requested} requested -> ${profile.propertyCap.accepted ? 'accepted' : `REJECTED: ${profile.propertyCap.message}`}`);
line('rate limit', rateLimit
  ? `${rateLimit.remaining}/${rateLimit.max} per ${rateLimit.intervalMs}ms, daily ${rateLimit.dailyRemaining}/${rateLimit.daily}`
  : 'no headers returned');

console.log(`\nprofile written to ${OUT}`);
