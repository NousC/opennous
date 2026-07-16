// e2e-fixture.mjs
//
// End-to-end benchmark: loads synthetic observations into a REAL Nous workspace
// via POST /v2/observations + POST /v2/notes, reconciles identity via
// POST /v2/accounts/merge (the agent-driven path), then reads back via
// POST /v2/context and POST /v2/query and scores five epistemic metrics against
// planted ground truth.
//
// This is the complement to fixture.mjs (which proves the VALUE of a resolved
// graph). This file proves the CORRECTNESS of the Nous engine itself: given
// connector-grade messy input, do identity resolution, staleness detection,
// contradiction handling, confidence ranking, and cross-account querying
// actually work?
//
// Usage (in Claude Code / VS Code terminal):
//
//   # Step 1: load observations + notes, then reconcile identity
//   NOUS_API_URL=https://your-nous-instance.com NOUS_API_KEY=... node e2e-fixture.mjs --load
//
//   # Step 2: score what Nous produced
//   NOUS_API_URL=https://your-nous-instance.com NOUS_API_KEY=... node e2e-fixture.mjs --score
//
//   # Step 3: full run (load + reconcile + score in one pass)
//   NOUS_API_URL=https://your-nous-instance.com NOUS_API_KEY=... node e2e-fixture.mjs --run
//
//   # Dry run: validate payloads and ground truth without hitting the API
//   node e2e-fixture.mjs --dry-run
//
// Run against a FRESH / scratch workspace — the fixture plants a known world and
// scores against it. (--load is safe to re-run: observations dedup on external_id
// and the identity merge is idempotent, but the buried-fact note has no dedup key,
// so repeated --load adds harmless duplicate copies of it.)
//
// The five metrics this file scores:
//   1. Identity resolution   — precision + recall across merged entities + the buried fact
//   2. Staleness detection   — does a 210-day-old title get flagged expired?
//   3. Contradiction handling — does a source conflict produce a confidence penalty?
//   4. Confidence rank       — does corroboration produce higher confidence than thin evidence?
//   5. Focus set (query)     — does /v2/query surface exactly the fresh-intent ICP accounts?
//
// HONEST CAVEATS (keep these; they are what make the number credible):
//   - The fixture is synthetic with planted ground truth. Disclosed, not hidden.
//   - Identity resolution is scored AFTER an explicit merge_contacts, because the
//     REST write path (/v2/observations) mints one entity per unlinked hard
//     identifier — it does not corroborate-merge on write. Auto-merge on ingest is
//     the worker's job (identityMatch.mjs) and isn't exercised here; the
//     agent-driven merge (POST /v2/accounts/merge) is the real product path for
//     "these three identifiers are one person", so that is what we test.
//   - Confidence is scored as rank correlation, NOT calibration. Our confidence
//     is a heuristic, not a calibrated probability. We claim: higher confidence,
//     more often correct. We do NOT claim it is a true probability.
//   - The 180-day flat decay constant (claims.ts) means all fact types decay at
//     the same rate. The staleness test will show this as a score note. That is
//     intentional — the eval surfaces real product gaps so they can be fixed.
//   - Report ALL five metric scores, including ones where the gap is small.
//     Selective reporting kills credibility faster than a small delta.

// ---------------------------------------------------------------------------
// Reference date: 2026-06-30 (matches fixture.mjs — deterministic, no Date.now)
// ---------------------------------------------------------------------------

const REF = '2026-06-30T00:00:00Z';
const DAY = 86_400_000;

function daysAgo(n) {
  const ref = new Date(REF);
  return new Date(ref.getTime() - n * DAY).toISOString().slice(0, 10) + 'T00:00:00Z';
}

// The fixture's freshness is defined "as of REF", but the live /v2/query filters
// `since_days` relative to the real clock (query.ts uses Date.now()). So a fact
// that is 4 days old as of REF is really (REF_AGE_DAYS + 4) days old at run time.
// Shift any freshness window by REF_AGE_DAYS so the eval stays faithful whenever
// it is run, instead of silently aging fresh-intent accounts out of a fixed window.
const REF_AGE_DAYS = Math.max(0, Math.ceil((Date.now() - new Date(REF).getTime()) / DAY));
const FRESH_WINDOW_DAYS = 7;                              // "fresh intent" window, as of REF
const FOCUS_SINCE_DAYS = REF_AGE_DAYS + FRESH_WINDOW_DAYS + 1;   // +1 day of slack

// ---------------------------------------------------------------------------
// GROUND TRUTH — the planted answers the scorer checks against.
// These are facts WE KNOW because we built the world.
// ---------------------------------------------------------------------------

export const GROUND_TRUTH_E2E = {

  // --- METRIC 1: Identity resolution ---
  // Sarah Chen appears under three identifiers from three sources.
  // Ground truth: ONE entity (after the agent merges them). All three focus
  // values must then resolve to the same entity_id.
  identity: {
    scenario: 'Sarah Chen at Acme Corp — three identifiers, three sources',
    survivor: 'sarah@acme.com',                               // the keep target for the merge
    identifiers: [
      'sarah@acme.com',                                        // Gmail source
      's.chen@acme.com',                                       // Fireflies source
      'https://www.linkedin.com/in/sarahchen-revops',          // Apollo source
    ],
    expectedEntityCount: 1,                   // all three must resolve to ONE entity post-merge
    canonicalName: 'Sarah Chen',
    canonicalTitle: 'VP of Revenue Operations',
    // The buried fact: written as a meeting-notes DOCUMENT on the SECONDARY
    // identifier (s.chen@acme.com). If identity is merged correctly, the merge
    // re-points that document to the survivor and it surfaces in the survivor's
    // context.documents. If not, it stays orphaned on a separate entity.
    buriedFact: {
      surfacedIn: 'documents',                // note.* is stripped from claims; docs carry it
      mustContain: ['cfo', '50k'],            // both must appear (lower-cased) in a document
    },
  },

  // --- METRIC 2: Staleness detection ---
  // James Whitfield at Globex had two job_title observations:
  //   - 'Head of Growth' from Apollo, 210 days ago  → must be freshness: 'expired'
  //   - 'VP Sales' from Gmail, 5 days ago            → must be freshness: 'fresh'
  // Ground truth: current claim = 'VP Sales', old title is not the active claim.
  staleness: {
    scenario: 'James Whitfield at Globex — job change, old title 210 days stale',
    focus: 'james@globex.io',
    currentTitle: 'VP Sales',
    currentFreshness: 'fresh',                // observed 5 days ago
    staleTitle: 'Head of Growth',
    staleFreshness: 'expired',               // 210 days > 180-day DECAY_DAYS constant
    // NOTE: the 180-day flat decay means BOTH job titles and funding rounds get the
    // same half-life. This test will expose that gap. Report it honestly.
  },

  // --- METRIC 3: Contradiction resolution ---
  // Priya Nair at Initech: two sources give different job_title, close in time.
  //   - 'Director of Sales' from Apollo, 12 days ago
  //   - 'VP Sales' from HubSpot, 10 days ago
  // Ground truth: a contradiction penalty is applied (confidence < 0.80).
  // We do NOT mandate which value wins — the engine picks by recency (10d > 12d).
  // We mandate that the confidence penalty is visible.
  contradiction: {
    scenario: 'Priya Nair at Initech — two sources, different titles, 2-day gap',
    focus: 'priya@initech.com',
    property: 'job_title',
    sourceA: { source: 'apollo',   value: 'Director of Sales', daysAgo: 12 },
    sourceB: { source: 'hubspot',  value: 'VP Sales',          daysAgo: 10 },
    expectedWinner: 'VP Sales',               // most recent wins in v1 policy
    maxConfidenceAllowed: 0.80,               // contradiction penalty must drop it below 0.80
  },

  // --- METRIC 4: Confidence rank correlation ---
  // Two company-level facts about Acme Corp with different evidence quality:
  //   - funding_stage: 'Series B' — ONE observation, Apollo, 45 days ago  (thin)
  //   - employee_count: '180'     — THREE observations, three sources, <30 days (corroborated)
  // Ground truth: confidence(employee_count) > confidence(funding_stage)
  confidenceRank: {
    scenario: 'Acme Corp — corroborated employee count vs thin funding stage',
    focus: 'acme.com',
    thin: {
      property: 'funding_stage',
      value: 'Series B',
      observationCount: 1,
    },
    corroborated: {
      property: 'employee_count',
      value: '180',
      observationCount: 3,
    },
    // ground truth: corroborated.confidence MUST be strictly greater than thin.confidence
  },

  // --- METRIC 5: Focus set / intent (scored via /v2/query) ---
  // Accounts with fresh intent (< 7 days as of REF) AND strong ICP signals.
  // Ground truth: Acme, Globex, Pied Piper are IN; Initech (38-day-stale intent)
  // is OUT. Scored by entity-id set membership on the query result.
  focusSet: {
    scenario: 'Focus accounts — high ICP + fresh intent in last 7 days',
    expectedAccounts: ['acme.com', 'globex.io', 'piedpiper.com'],
    excludedAccounts: ['initech.com'],
  },
};

// ---------------------------------------------------------------------------
// OBSERVATION PAYLOADS — what we POST to /v2/observations.
// Each payload is { focus, observations: [...] }.
// The focus is the identifier Nous resolves to (or creates) an entity for.
// external_id values are stable so re-loading the fixture is idempotent.
// ---------------------------------------------------------------------------

export const OBSERVATION_PAYLOADS = [

  // =========================================================================
  // SCENARIO 1: Identity resolution — Sarah Chen, three identifiers
  // =========================================================================

  // Fragment 1: Gmail sees sarah@acme.com reply to an outbound email.
  {
    focus: 'sarah@acme.com',
    observations: [
      {
        kind: 'state',
        property: 'job_title',
        value: 'VP of Revenue Operations',
        source: 'gmail',
        method: 'extraction',
        observed_at: daysAgo(9),
        external_id: 'gmail_sarah_title_v1',
        raw: { thread: 'Re: technical overview', from: 'sarah@acme.com' },
      },
      {
        kind: 'state',
        property: 'company_name',
        value: 'Acme Corp',
        source: 'gmail',
        method: 'extraction',
        observed_at: daysAgo(9),
        external_id: 'gmail_sarah_company_v1',
      },
      {
        kind: 'event',
        property: 'interaction.email_reply',
        value: 'Interested in resolving fragmented account data across GTM tools. Asked for a technical overview.',
        source: 'gmail',
        method: 'webhook',
        observed_at: daysAgo(9),
        external_id: 'gmail_sarah_reply_v1',
      },
    ],
  },

  // Fragment 2: Fireflies sees s.chen@acme.com in a meeting transcript.
  // This is a DIFFERENT identifier — identity resolution (via merge) must link these.
  // The buried procurement fact from this thread is loaded separately via
  // /v2/notes (see NOTE_PAYLOADS) — a raw `note.procurement` observation would be
  // stripped from every agent-facing read, so it must be a document, not a claim.
  {
    focus: 's.chen@acme.com',
    observations: [
      {
        kind: 'state',
        property: 'job_title',
        value: 'VP RevOps',                   // abbreviated — same role, different string
        source: 'fireflies',
        method: 'extraction',
        observed_at: daysAgo(6),
        external_id: 'fireflies_sarah_title_v1',
        raw: { transcript_id: 'ff_acme_discovery', speaker: 'S. Chen' },
      },
      {
        kind: 'state',
        property: 'company_name',
        value: 'Acme Corp',
        source: 'fireflies',
        method: 'extraction',
        observed_at: daysAgo(6),
        external_id: 'fireflies_sarah_company_v1',
      },
      {
        kind: 'event',
        property: 'interaction.meeting_held',
        value: 'Discovery call. Walked through identity-resolution problem. She confirmed they run three overlapping outbound tools.',
        source: 'fireflies',
        method: 'webhook',
        observed_at: daysAgo(6),
        external_id: 'fireflies_sarah_meeting_v1',
      },
    ],
  },

  // Fragment 3: Apollo CRM has a row keyed only to the LinkedIn URL — no email.
  // This is the hardest merge: no shared identifier with Fragments 1 or 2.
  {
    focus: 'https://www.linkedin.com/in/sarahchen-revops',
    observations: [
      {
        kind: 'state',
        property: 'job_title',
        value: 'VP Rev Ops',                  // third variant of the same title
        source: 'apollo',
        method: 'api',
        observed_at: daysAgo(14),
        external_id: 'apollo_sarah_title_v1',
        raw: { apollo_id: 'ap_sarah_chen_001' },
      },
      {
        kind: 'state',
        property: 'company_name',
        value: 'Acme Corp',
        source: 'apollo',
        method: 'api',
        observed_at: daysAgo(14),
        external_id: 'apollo_sarah_company_v1',
      },
    ],
  },

  // =========================================================================
  // SCENARIO 2: Staleness — James Whitfield at Globex, job change
  // =========================================================================

  // Old title: observed 210 days ago. This MUST come first (chronologically older).
  // 210 days > 180-day DECAY_DAYS → freshness should be 'expired'.
  {
    focus: 'james@globex.io',
    observations: [
      {
        kind: 'state',
        property: 'job_title',
        value: 'Head of Growth',
        source: 'apollo',
        method: 'api',
        observed_at: daysAgo(210),            // 210 days ago → should go 'expired'
        external_id: 'apollo_james_title_old_v1',
        raw: { note: 'Apollo enrichment snapshot, Dec 2025' },
      },
      {
        kind: 'state',
        property: 'company_name',
        value: 'Globex',
        source: 'apollo',
        method: 'api',
        observed_at: daysAgo(210),
        external_id: 'apollo_james_company_v1',
      },
    ],
  },

  // New title: observed 5 days ago. This is the CURRENT fact.
  // freshness should be 'fresh'. Nous must pick this over the older value.
  {
    focus: 'james@globex.io',
    observations: [
      {
        kind: 'state',
        property: 'job_title',
        value: 'VP Sales',
        source: 'gmail',
        method: 'extraction',
        observed_at: daysAgo(5),              // 5 days ago → should be 'fresh'
        external_id: 'gmail_james_title_new_v1',
        raw: { thread: 'Re: self-hosting pricing', from: 'james@globex.io' },
      },
      {
        kind: 'event',
        property: 'interaction.email_reply',
        value: 'James asked about self-hosting and pricing. Actively evaluating this quarter.',
        source: 'gmail',
        method: 'webhook',
        observed_at: daysAgo(3),
        external_id: 'gmail_james_reply_v1',
      },
    ],
  },

  // =========================================================================
  // SCENARIO 3: Contradiction — Priya Nair at Initech, two sources disagree
  // =========================================================================

  // Source A: Apollo, 12 days ago.
  {
    focus: 'priya@initech.com',
    observations: [
      {
        kind: 'state',
        property: 'job_title',
        value: 'Director of Sales',
        source: 'apollo',
        method: 'api',
        observed_at: daysAgo(12),
        external_id: 'apollo_priya_title_v1',
        raw: { apollo_id: 'ap_priya_nair_001' },
      },
      {
        kind: 'state',
        property: 'company_name',
        value: 'Initech',
        source: 'apollo',
        method: 'api',
        observed_at: daysAgo(12),
        external_id: 'apollo_priya_company_v1',
      },
    ],
  },

  // Source B: HubSpot, 10 days ago — DIFFERENT value for same property.
  // This triggers a contradiction penalty in recomputeClaim.
  // Most recent wins on value; confidence takes a penalty.
  {
    focus: 'priya@initech.com',
    observations: [
      {
        kind: 'state',
        property: 'job_title',
        value: 'VP Sales',                    // different from Apollo's value
        source: 'hubspot',
        method: 'webhook',
        observed_at: daysAgo(10),             // more recent — this value should win
        external_id: 'hubspot_priya_title_v1',
        raw: { hubspot_contact_id: 'hs_priya_001' },
      },
    ],
  },

  // =========================================================================
  // SCENARIO 4: Confidence rank — Acme Corp, thin vs corroborated facts
  // =========================================================================

  // Thin fact: funding_stage — ONE observation, ONE source, 45 days ago.
  // Expected: lower confidence than the corroborated fact.
  {
    focus: 'acme.com',
    observations: [
      {
        kind: 'state',
        property: 'funding_stage',
        value: 'Series B',
        source: 'apollo',
        method: 'api',
        observed_at: daysAgo(45),             // aging, single source
        external_id: 'apollo_acme_funding_v1',
        raw: { crunchbase_ref: 'acme-corp-series-b' },
      },
    ],
  },

  // Corroborated fact: employee_count — THREE observations from THREE distinct sources,
  // all within the last 30 days. Expected: higher confidence than the thin fact.
  {
    focus: 'acme.com',
    observations: [
      {
        kind: 'state',
        property: 'employee_count',
        value: '180',
        source: 'apollo',
        method: 'api',
        observed_at: daysAgo(28),
        external_id: 'apollo_acme_headcount_v1',
      },
    ],
  },
  {
    focus: 'acme.com',
    observations: [
      {
        kind: 'state',
        property: 'employee_count',
        value: '180',
        source: 'linkedin',
        method: 'api',
        observed_at: daysAgo(20),
        external_id: 'linkedin_acme_headcount_v1',
      },
    ],
  },
  {
    focus: 'acme.com',
    observations: [
      {
        kind: 'state',
        property: 'employee_count',
        value: '180',
        source: 'clay',
        method: 'api',
        observed_at: daysAgo(12),
        external_id: 'clay_acme_headcount_v1',
      },
    ],
  },

  // =========================================================================
  // SCENARIO 5: Focus set — intent signals + ICP, Acme / Globex / Pied Piper
  // =========================================================================

  // Acme: ICP signals + fresh interaction events
  {
    focus: 'acme.com',
    observations: [
      {
        kind: 'state',
        property: 'icp.industry',
        value: 'B2B SaaS',
        source: 'apollo',
        method: 'api',
        observed_at: daysAgo(30),
        external_id: 'apollo_acme_industry_v1',
      },
      {
        kind: 'state',
        property: 'icp.employee_range',
        value: '51-200',
        source: 'apollo',
        method: 'api',
        observed_at: daysAgo(30),
        external_id: 'apollo_acme_emprange_v1',
      },
      {
        kind: 'event',
        property: 'signal.intent',
        value: 'Repeated visits to pricing and self-host docs.',
        source: 'clearbit',
        method: 'webhook',
        observed_at: daysAgo(4),
        external_id: 'clearbit_acme_intent_v1',
      },
    ],
  },

  // Globex: fresh Series A + intent
  {
    focus: 'globex.io',
    observations: [
      {
        kind: 'state',
        property: 'icp.industry',
        value: 'B2B SaaS',
        source: 'apollo',
        method: 'api',
        observed_at: daysAgo(30),
        external_id: 'apollo_globex_industry_v1',
      },
      {
        kind: 'state',
        property: 'funding_stage',
        value: 'Series A',
        source: 'apollo',
        method: 'api',
        observed_at: daysAgo(15),
        external_id: 'apollo_globex_funding_v1',
      },
      {
        kind: 'event',
        property: 'signal.intent',
        value: 'Downloaded integration guide, opened three emails.',
        source: 'clearbit',
        method: 'webhook',
        observed_at: daysAgo(3),
        external_id: 'clearbit_globex_intent_v1',
      },
    ],
  },

  // Pied Piper: demo booked, active on docs
  {
    focus: 'piedpiper.com',
    observations: [
      {
        kind: 'state',
        property: 'icp.industry',
        value: 'B2B SaaS',
        source: 'apollo',
        method: 'api',
        observed_at: daysAgo(30),
        external_id: 'apollo_pied_industry_v1',
      },
      {
        kind: 'event',
        property: 'signal.intent',
        value: 'Booked a demo. Active on the docs. Said current stack cannot join data across tools.',
        source: 'clearbit',
        method: 'webhook',
        observed_at: daysAgo(2),
        external_id: 'clearbit_pied_intent_v1',
      },
    ],
  },

  // Initech: stale intent, no recent activity — should NOT be in focus set
  {
    focus: 'initech.com',
    observations: [
      {
        kind: 'event',
        property: 'signal.intent',
        value: 'A single doc view over a month ago.',
        source: 'clearbit',
        method: 'webhook',
        observed_at: daysAgo(38),             // stale — outside the 7-day fresh window
        external_id: 'clearbit_initech_intent_v1',
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// NOTE PAYLOADS — what we POST to /v2/notes (documents kept on a contact).
// The buried procurement fact lives here, not in OBSERVATION_PAYLOADS: a note
// written via the API always carries a doc_type, so it surfaces in
// context.documents. A raw `note.*` observation would be stripped from every
// agent-facing read (context.ts / claims.ts drop `note.` properties), so it must
// be a document. It is attached to the SECONDARY identifier (s.chen@acme.com) so
// the identity merge has to re-point it onto the survivor for it to surface.
// ---------------------------------------------------------------------------

export const NOTE_PAYLOADS = [
  {
    focus: 's.chen@acme.com',
    type: 'meeting_notes',
    title: 'Discovery call — procurement',
    date: daysAgo(4),
    content: 'Budget owner is the CFO (David Okafor). Any purchase over $50k requires CFO sign-off.',
  },
];

// The identity merge: fold the two secondary identifiers into the survivor.
// This is the agent-driven reconciliation (merge_contacts) — the real product
// path for "these identifiers are one person". See the caveat in the header.
const IDENTITY_SURVIVOR = GROUND_TRUTH_E2E.identity.survivor;
const IDENTITY_DROPS = GROUND_TRUTH_E2E.identity.identifiers.filter(id => id !== IDENTITY_SURVIVOR);

// ---------------------------------------------------------------------------
// Small fetch helpers
// ---------------------------------------------------------------------------

function baseUrl(apiUrl) {
  return apiUrl.replace(/\/$/, '');
}
function headers(apiKey) {
  return { 'Content-Type': 'application/json', 'x-api-key': apiKey };
}

// ---------------------------------------------------------------------------
// LOADER — POSTs every observation payload to POST /v2/observations.
// ---------------------------------------------------------------------------

export async function loadFixture(apiUrl, apiKey, { verbose = false } = {}) {
  const url = `${baseUrl(apiUrl)}/v2/observations`;
  const results = { loaded: 0, skipped: 0, errors: [] };

  for (const payload of OBSERVATION_PAYLOADS) {
    try {
      const res = await fetch(url, { method: 'POST', headers: headers(apiKey), body: JSON.stringify(payload) });
      const json = await res.json();

      if (!res.ok) {
        results.errors.push({ focus: payload.focus, status: res.status, error: json });
        if (verbose) console.error('[LOAD ERROR]', payload.focus, json);
        continue;
      }

      results.loaded += json.recorded ?? 0;
      results.skipped += (payload.observations.length - (json.recorded ?? 0));
      if (verbose) console.log('[LOAD]', payload.focus, '→ recorded:', json.recorded, '| claims recomputed:', json.claims_recomputed);
    } catch (err) {
      results.errors.push({ focus: payload.focus, error: err.message });
      if (verbose) console.error('[LOAD EXCEPTION]', payload.focus, err.message);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// NOTES LOADER — POSTs each document to POST /v2/notes.
// ---------------------------------------------------------------------------

export async function loadNotes(apiUrl, apiKey, { verbose = false } = {}) {
  const url = `${baseUrl(apiUrl)}/v2/notes`;
  const results = { loaded: 0, errors: [] };

  for (const note of NOTE_PAYLOADS) {
    try {
      const res = await fetch(url, { method: 'POST', headers: headers(apiKey), body: JSON.stringify(note) });
      const json = await res.json();

      if (!res.ok) {
        results.errors.push({ focus: note.focus, status: res.status, error: json });
        if (verbose) console.error('[NOTE ERROR]', note.focus, json);
        continue;
      }

      results.loaded++;
      if (verbose) console.log('[NOTE]', note.focus, '→ doc_type:', json.doc_type, '| entity:', json.entity_id);
    } catch (err) {
      results.errors.push({ focus: note.focus, error: err.message });
      if (verbose) console.error('[NOTE EXCEPTION]', note.focus, err.message);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// IDENTITY MERGE — folds Sarah's secondary identifiers into the survivor via
// POST /v2/accounts/merge. Idempotent: once merged, both focuses resolve to the
// same entity, so a repeat call returns `same_entity` / `already merged`, which
// we treat as success.
// ---------------------------------------------------------------------------

export async function mergeFixture(apiUrl, apiKey, { verbose = false } = {}) {
  const url = `${baseUrl(apiUrl)}/v2/accounts/merge`;
  const results = { merged: 0, alreadyMerged: 0, errors: [] };

  for (const drop of IDENTITY_DROPS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: headers(apiKey),
        body: JSON.stringify({ keep: IDENTITY_SURVIVOR, drop }),
      });
      const json = await res.json();

      if (res.ok && json.status === 'merged') {
        results.merged++;
        if (verbose) console.log('[MERGE]', drop, '→', IDENTITY_SURVIVOR, '| identifiers moved:', json.identifiers_moved);
        continue;
      }
      // Idempotent re-run: the two focuses already resolve to one entity.
      const msg = String(json?.error ?? '');
      if (res.status === 400 && /same_entity|already merged/.test(msg)) {
        results.alreadyMerged++;
        if (verbose) console.log('[MERGE] already merged:', drop);
        continue;
      }
      results.errors.push({ drop, status: res.status, error: json });
      if (verbose) console.error('[MERGE ERROR]', drop, json);
    } catch (err) {
      results.errors.push({ drop, error: err.message });
      if (verbose) console.error('[MERGE EXCEPTION]', drop, err.message);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// READER — calls /v2/context for each entity + one /v2/query for the focus set.
// Returns { responses, focusQuery }.
// ---------------------------------------------------------------------------

export async function readFixture(apiUrl, apiKey) {
  const focuses = [
    // Identity (three identifiers — all should resolve to the same entity post-merge)
    'sarah@acme.com',
    's.chen@acme.com',
    'https://www.linkedin.com/in/sarahchen-revops',
    // Staleness
    'james@globex.io',
    // Contradiction
    'priya@initech.com',
    // Confidence rank + focus set
    'acme.com',
    'globex.io',
    'piedpiper.com',
    'initech.com',
  ];

  const ctxUrl = `${baseUrl(apiUrl)}/v2/context`;
  const responses = {};

  for (const focus of focuses) {
    try {
      const res = await fetch(ctxUrl, {
        method: 'POST',
        headers: headers(apiKey),
        body: JSON.stringify({ focus, intent: 'account_review' }),
      });
      responses[focus] = { status: res.status, body: await res.json() };
    } catch (err) {
      responses[focus] = { status: 'exception', error: err.message };
    }
  }

  // Metric 5: one cross-account query for accounts with fresh intent.
  let focusQuery;
  try {
    const res = await fetch(`${baseUrl(apiUrl)}/v2/query`, {
      method: 'POST',
      headers: headers(apiKey),
      body: JSON.stringify({
        scope: { kind: 'event', property: 'signal.intent', since_days: FOCUS_SINCE_DAYS },
        return: 'entities',
      }),
    });
    focusQuery = { status: res.status, body: await res.json() };
  } catch (err) {
    focusQuery = { status: 'exception', error: err.message };
  }

  return { responses, focusQuery };
}

// ---------------------------------------------------------------------------
// SCORER — grades Nous's output against GROUND_TRUTH_E2E.
// Returns five metric scores + detailed breakdown per scenario.
// ---------------------------------------------------------------------------

export function scoreFixture(responses, focusQuery) {
  const results = { metrics: {}, scenarios: {}, summary: '' };

  // --- METRIC 1: Identity resolution ---
  // Bug A fix: the /v2/context response nests the id under `entity.id`
  // (context.ts AssembledContext), NOT a top-level `entity_id`.
  const ids = [
    responses['sarah@acme.com']?.body?.entity?.id,
    responses['s.chen@acme.com']?.body?.entity?.id,
    responses['https://www.linkedin.com/in/sarahchen-revops']?.body?.entity?.id,
  ];
  const validIds = ids.filter(Boolean);
  const uniqueIds = new Set(validIds);
  const identityPrecision = validIds.length === 3 && uniqueIds.size === 1 ? 1.0 : uniqueIds.size === 1 ? 0.5 : 0.0;
  const identityRecall = validIds.length / 3;  // how many of the three resolved at all

  // Buried fact: a note written via /v2/notes always carries a doc_type, so it
  // surfaces in context.documents (as a snippet), not in claims/facts. After the
  // merge it re-points onto the survivor, so read the survivor's documents.
  const survivorDocs = responses[GROUND_TRUTH_E2E.identity.survivor]?.body?.documents ?? [];
  const docText = survivorDocs
    .map(d => `${d.title ?? ''} ${d.snippet ?? ''}`)
    .join(' ')
    .toLowerCase();
  const buriedFactHit = GROUND_TRUTH_E2E.identity.buriedFact.mustContain.every(t => docText.includes(t));

  results.scenarios.identity = {
    entityIds: ids,
    uniqueEntityIds: [...uniqueIds],
    merged: uniqueIds.size === 1,
    buriedFactSurfaced: buriedFactHit,
    precision: identityPrecision,
    recall: identityRecall,
    pass: uniqueIds.size === 1 && buriedFactHit,
  };
  results.metrics.identity_precision = identityPrecision;
  results.metrics.identity_recall = identityRecall;

  // --- METRIC 2: Staleness detection ---
  const jamesClaims = responses['james@globex.io']?.body?.claims ?? [];
  const jamesTitleClaim = jamesClaims.find(c => c.property === 'job_title');
  const stalenessCurrentCorrect = jamesTitleClaim?.value === GROUND_TRUTH_E2E.staleness.currentTitle;
  const stalenessFreshnessCorrect = jamesTitleClaim?.freshness === GROUND_TRUTH_E2E.staleness.currentFreshness;
  const stalenessScore = (stalenessCurrentCorrect ? 0.5 : 0) + (stalenessFreshnessCorrect ? 0.5 : 0);

  results.scenarios.staleness = {
    claimedTitle: jamesTitleClaim?.value ?? null,
    claimedFreshness: jamesTitleClaim?.freshness ?? null,
    expectedTitle: GROUND_TRUTH_E2E.staleness.currentTitle,
    expectedFreshness: GROUND_TRUTH_E2E.staleness.currentFreshness,
    currentValueCorrect: stalenessCurrentCorrect,
    freshnessCorrect: stalenessFreshnessCorrect,
    score: stalenessScore,
    note: 'Flat 180-day decay constant (claims.ts DECAY_DAYS) applies equally to all fact types. Per-fact-type calibration is a known roadmap item.',
    pass: stalenessScore === 1.0,
  };
  results.metrics.staleness_detection = stalenessScore;

  // --- METRIC 3: Contradiction resolution ---
  const priyaClaims = responses['priya@initech.com']?.body?.claims ?? [];
  const priyaTitleClaim = priyaClaims.find(c => c.property === 'job_title');
  const contradictionWinnerCorrect = priyaTitleClaim?.value === GROUND_TRUTH_E2E.contradiction.expectedWinner;
  const contradictionPenaltyApplied = (priyaTitleClaim?.confidence ?? 1.0) <= GROUND_TRUTH_E2E.contradiction.maxConfidenceAllowed;
  const contradictionScore = (contradictionWinnerCorrect ? 0.5 : 0) + (contradictionPenaltyApplied ? 0.5 : 0);

  results.scenarios.contradiction = {
    claimedTitle: priyaTitleClaim?.value ?? null,
    claimedConfidence: priyaTitleClaim?.confidence ?? null,
    expectedWinner: GROUND_TRUTH_E2E.contradiction.expectedWinner,
    maxConfidenceAllowed: GROUND_TRUTH_E2E.contradiction.maxConfidenceAllowed,
    winnerCorrect: contradictionWinnerCorrect,
    penaltyApplied: contradictionPenaltyApplied,
    score: contradictionScore,
    pass: contradictionScore === 1.0,
  };
  results.metrics.contradiction_resolution = contradictionScore;

  // --- METRIC 4: Confidence rank correlation ---
  const acmeClaims = responses['acme.com']?.body?.claims ?? [];
  const thinClaim = acmeClaims.find(c => c.property === GROUND_TRUTH_E2E.confidenceRank.thin.property);
  const corrClaim = acmeClaims.find(c => c.property === GROUND_TRUTH_E2E.confidenceRank.corroborated.property);
  const thinConf = thinClaim?.confidence ?? null;
  const corrConf = corrClaim?.confidence ?? null;
  const rankCorrect = thinConf !== null && corrConf !== null && corrConf > thinConf;
  const rankScore = rankCorrect ? 1.0 : 0.0;

  results.scenarios.confidenceRank = {
    thin: { property: GROUND_TRUTH_E2E.confidenceRank.thin.property, confidence: thinConf },
    corroborated: { property: GROUND_TRUTH_E2E.confidenceRank.corroborated.property, confidence: corrConf },
    rankCorrect,
    score: rankScore,
    note: 'Confidence rank only — not calibration. Higher confidence correlates with stronger evidence, not a precise probability.',
    pass: rankCorrect,
  };
  results.metrics.confidence_rank = rankScore;

  // --- METRIC 5: Focus set (cross-account query) ---
  // Resolve the expected/excluded domains to their entity ids (from the context
  // reads), then check the /v2/query result's entity-id set: all expected IN,
  // none excluded.
  const focusItems = Array.isArray(focusQuery?.body?.items) ? focusQuery.body.items : [];
  const foundIds = new Set(focusItems.map(i => i.entity_id).filter(Boolean));
  const expectedIds = GROUND_TRUTH_E2E.focusSet.expectedAccounts
    .map(d => responses[d]?.body?.entity?.id).filter(Boolean);
  const excludedIds = GROUND_TRUTH_E2E.focusSet.excludedAccounts
    .map(d => responses[d]?.body?.entity?.id).filter(Boolean);
  const allExpectedResolved = expectedIds.length === GROUND_TRUTH_E2E.focusSet.expectedAccounts.length;
  const allIncluded = allExpectedResolved && expectedIds.every(id => foundIds.has(id));
  const noneExcluded = excludedIds.every(id => !foundIds.has(id));
  const focusScore = allIncluded && noneExcluded ? 1.0 : 0.0;

  results.scenarios.focusSet = {
    sinceDays: FOCUS_SINCE_DAYS,
    expectedAccounts: GROUND_TRUTH_E2E.focusSet.expectedAccounts,
    excludedAccounts: GROUND_TRUTH_E2E.focusSet.excludedAccounts,
    returnedEntityCount: foundIds.size,
    allExpectedResolved,
    allIncluded,
    noneExcluded,
    score: focusScore,
    pass: focusScore === 1.0,
  };
  results.metrics.focus_set = focusScore;

  // --- Overall ---
  const metricValues = Object.values(results.metrics);
  const overall = metricValues.reduce((a, b) => a + b, 0) / metricValues.length;
  results.metrics.overall = parseFloat(overall.toFixed(3));

  results.summary = [
    `Identity resolution:     precision=${identityPrecision.toFixed(2)}  recall=${identityRecall.toFixed(2)}  buried_fact=${buriedFactHit ? 'yes' : 'no'}`,
    `Staleness detection:     ${stalenessScore.toFixed(2)} / 1.00`,
    `Contradiction handling:  ${contradictionScore.toFixed(2)} / 1.00`,
    `Confidence rank:         ${rankScore.toFixed(2)} / 1.00`,
    `Focus set (query):       ${focusScore.toFixed(2)} / 1.00`,
    `─────────────────────────────────────────`,
    `Overall (mean):          ${results.metrics.overall}`,
  ].join('\n');

  return results;
}

// ---------------------------------------------------------------------------
// DRY-RUN VALIDATOR — confirms payloads are well-formed and ground truth is
// internally consistent. Runs without hitting the API.
// ---------------------------------------------------------------------------

function dryRun() {
  console.log('Running dry-run validation...\n');
  let pass = true;

  // 1. Every observation payload has a non-empty focus + well-formed observations
  for (const p of OBSERVATION_PAYLOADS) {
    if (!p.focus || typeof p.focus !== 'string') {
      console.error('[FAIL] Payload missing focus:', p);
      pass = false;
    }
    if (!Array.isArray(p.observations) || p.observations.length === 0) {
      console.error('[FAIL] Payload has no observations:', p.focus);
      pass = false;
    }
    for (const o of p.observations ?? []) {
      if (!['state', 'event'].includes(o.kind)) {
        console.error('[FAIL] Invalid kind on', p.focus, ':', o.kind);
        pass = false;
      }
      if (!o.property || !o.source || !o.method) {
        console.error('[FAIL] Missing required field on', p.focus, ':', o);
        pass = false;
      }
    }
  }

  // 2. Sarah Chen identifiers in GROUND_TRUTH_E2E match payload focuses, and the
  //    survivor is one of them.
  const identityFocuses = new Set(OBSERVATION_PAYLOADS.map(p => p.focus));
  for (const id of GROUND_TRUTH_E2E.identity.identifiers) {
    if (!identityFocuses.has(id)) {
      console.error('[FAIL] Identity identifier missing from payloads:', id);
      pass = false;
    }
  }
  if (!GROUND_TRUTH_E2E.identity.identifiers.includes(IDENTITY_SURVIVOR)) {
    console.error('[FAIL] Survivor is not one of the identity identifiers:', IDENTITY_SURVIVOR);
    pass = false;
  }
  if (IDENTITY_DROPS.length !== GROUND_TRUTH_E2E.identity.identifiers.length - 1) {
    console.error('[FAIL] Expected 2 merge drops, got:', IDENTITY_DROPS);
    pass = false;
  }

  // 3. Buried fact is a NOTE (document), attached to the secondary identifier,
  //    and contains the required terms.
  const buried = NOTE_PAYLOADS.find(n => /cfo/i.test(n.content) && /50k/i.test(n.content));
  if (!buried) {
    console.error('[FAIL] Buried-fact note missing (must contain CFO + 50k)');
    pass = false;
  } else if (buried.focus === IDENTITY_SURVIVOR) {
    console.error('[FAIL] Buried fact must be on a SECONDARY identifier, not the survivor, to test the merge');
    pass = false;
  } else if (!GROUND_TRUTH_E2E.identity.identifiers.includes(buried.focus)) {
    console.error('[FAIL] Buried-fact focus is not one of the identity identifiers:', buried.focus);
    pass = false;
  }
  for (const n of NOTE_PAYLOADS) {
    if (!n.focus || !n.content || !String(n.content).trim()) {
      console.error('[FAIL] Note payload missing focus/content:', n);
      pass = false;
    }
  }

  // 4. Staleness: old observation must be older than new observation, and > 180d.
  const jamesTitleObs = OBSERVATION_PAYLOADS
    .filter(p => p.focus === 'james@globex.io')
    .flatMap(p => p.observations.filter(o => o.property === 'job_title'));
  if (jamesTitleObs.length !== 2) {
    console.error('[FAIL] Expected 2 job_title observations for james@globex.io, got:', jamesTitleObs.length);
    pass = false;
  } else {
    const dates = jamesTitleObs.map(o => new Date(o.observed_at).getTime()).sort((a, b) => a - b);
    if (dates[0] >= dates[1]) {
      console.error('[FAIL] Staleness scenario: old date is not older than new date');
      pass = false;
    }
    const ageDays = (new Date(REF).getTime() - dates[0]) / DAY;
    if (ageDays < 180) {
      console.error('[FAIL] Staleness scenario: old observation is', ageDays.toFixed(0), 'days old — must exceed 180-day decay threshold');
      pass = false;
    }
  }

  // 5. Contradiction: both sources present, different values
  const priyaTitleObs = OBSERVATION_PAYLOADS
    .filter(p => p.focus === 'priya@initech.com')
    .flatMap(p => p.observations.filter(o => o.property === 'job_title'));
  const priyaSources = new Set(priyaTitleObs.map(o => o.source));
  const priyaValues = new Set(priyaTitleObs.map(o => o.value));
  if (priyaSources.size < 2) {
    console.error('[FAIL] Contradiction scenario: need ≥2 distinct sources, got:', [...priyaSources]);
    pass = false;
  }
  if (priyaValues.size < 2) {
    console.error('[FAIL] Contradiction scenario: need ≥2 distinct values, got:', [...priyaValues]);
    pass = false;
  }

  // 6. Confidence rank: corroborated fact has 3x observations from distinct sources
  const acmeObs = OBSERVATION_PAYLOADS.filter(p => p.focus === 'acme.com');
  const fundingObs = acmeObs.flatMap(p => p.observations.filter(o => o.property === 'funding_stage'));
  const headcountObs = acmeObs.flatMap(p => p.observations.filter(o => o.property === 'employee_count'));
  if (fundingObs.length !== 1) {
    console.error('[FAIL] Confidence rank: expected exactly 1 funding_stage observation, got:', fundingObs.length);
    pass = false;
  }
  if (headcountObs.length !== 3) {
    console.error('[FAIL] Confidence rank: expected exactly 3 employee_count observations, got:', headcountObs.length);
    pass = false;
  }
  if (new Set(headcountObs.map(o => o.source)).size < 3) {
    console.error('[FAIL] Confidence rank: corroborated fact needs ≥3 distinct sources');
    pass = false;
  }

  // 7. Focus set: expected accounts have a fresh (<7d as of REF) signal.intent,
  //    excluded accounts have only a stale one.
  const intentAgeByFocus = {};
  for (const p of OBSERVATION_PAYLOADS) {
    for (const o of p.observations) {
      if (o.property === 'signal.intent') {
        const age = (new Date(REF).getTime() - new Date(o.observed_at).getTime()) / DAY;
        intentAgeByFocus[p.focus] = Math.min(intentAgeByFocus[p.focus] ?? Infinity, age);
      }
    }
  }
  for (const d of GROUND_TRUTH_E2E.focusSet.expectedAccounts) {
    if (!(intentAgeByFocus[d] <= FRESH_WINDOW_DAYS)) {
      console.error('[FAIL] Focus set: expected account has no fresh intent (<7d as of REF):', d, intentAgeByFocus[d]);
      pass = false;
    }
  }
  for (const d of GROUND_TRUTH_E2E.focusSet.excludedAccounts) {
    if (intentAgeByFocus[d] <= FRESH_WINDOW_DAYS) {
      console.error('[FAIL] Focus set: excluded account should NOT have fresh intent:', d, intentAgeByFocus[d]);
      pass = false;
    }
  }

  if (pass) {
    console.log('✓ All observation payloads well-formed');
    console.log('✓ Identity: 3 identifiers present; survivor =', IDENTITY_SURVIVOR, '; drops =', IDENTITY_DROPS.length);
    console.log('✓ Buried fact is a document on the secondary identifier (' + buried.focus + ')');
    console.log('✓ Staleness dates valid (old =', Math.round((new Date(REF).getTime() - new Date(daysAgo(210)).getTime()) / DAY), 'days ago as of REF)');
    console.log('✓ Contradiction: 2 sources, 2 values');
    console.log('✓ Confidence rank: 1 thin observation vs 3 corroborated from distinct sources');
    console.log('✓ Focus set: 3 fresh-intent accounts IN, 1 stale account OUT');
    console.log('  (focus-set query window: since_days =', FOCUS_SINCE_DAYS, '— REF is', REF_AGE_DAYS, 'days ago)');
    console.log('\nTotal observation payloads:', OBSERVATION_PAYLOADS.length);
    console.log('Total observations:', OBSERVATION_PAYLOADS.reduce((n, p) => n + p.observations.length, 0));
    console.log('Total notes:', NOTE_PAYLOADS.length);
    console.log('\nDry run PASSED. Run with --load to POST to Nous.\n');
  } else {
    console.error('\nDry run FAILED. Fix errors above before loading.\n');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// CLI ENTRY POINT
// ---------------------------------------------------------------------------

function requireEnv(apiUrl, apiKey) {
  if (!apiUrl || !apiKey) {
    console.error('NOUS_API_URL and NOUS_API_KEY must be set.\n');
    process.exit(1);
  }
}

async function doLoad(apiUrl, apiKey) {
  console.log('Loading observations into Nous at', apiUrl, '...\n');
  const obs = await loadFixture(apiUrl, apiKey, { verbose: true });
  console.log('\nLoading notes (documents)...');
  const notes = await loadNotes(apiUrl, apiKey, { verbose: true });
  console.log('\nReconciling identity (merge_contacts)...');
  const merge = await mergeFixture(apiUrl, apiKey, { verbose: true });
  console.log('\n--- Load complete ---');
  console.log('Observations recorded:', obs.loaded, '| skipped (dedup):', obs.skipped);
  console.log('Notes loaded:', notes.loaded);
  console.log('Merges:', merge.merged, '| already merged:', merge.alreadyMerged);
  const allErrors = [...obs.errors, ...notes.errors, ...merge.errors];
  if (allErrors.length) console.error('Errors:', JSON.stringify(allErrors, null, 2));
  return allErrors.length === 0;
}

async function doScore(apiUrl, apiKey) {
  console.log('Reading Nous context + query for all fixture entities...\n');
  const { responses, focusQuery } = await readFixture(apiUrl, apiKey);
  const scored = scoreFixture(responses, focusQuery);
  console.log('=== BENCHMARK RESULTS ===');
  console.log(scored.summary);
  console.log('\n--- Scenario detail ---');
  console.log(JSON.stringify(scored.scenarios, null, 2));
  return scored;
}

if (process.argv[1] && process.argv[1].endsWith('e2e-fixture.mjs')) {
  const mode = process.argv[2];
  const apiUrl = process.env.NOUS_API_URL;
  const apiKey = process.env.NOUS_API_KEY;

  if (mode === '--dry-run') {
    dryRun();

  } else if (mode === '--load') {
    requireEnv(apiUrl, apiKey);
    await doLoad(apiUrl, apiKey);

  } else if (mode === '--score') {
    requireEnv(apiUrl, apiKey);
    await doScore(apiUrl, apiKey);

  } else if (mode === '--run') {
    requireEnv(apiUrl, apiKey);
    dryRun();
    await doLoad(apiUrl, apiKey);
    console.log('\nReading back and scoring...\n');
    await doScore(apiUrl, apiKey);

  } else {
    console.log('Usage:');
    console.log('  node e2e-fixture.mjs --dry-run');
    console.log('  NOUS_API_URL=... NOUS_API_KEY=... node e2e-fixture.mjs --load');
    console.log('  NOUS_API_URL=... NOUS_API_KEY=... node e2e-fixture.mjs --score');
    console.log('  NOUS_API_URL=... NOUS_API_KEY=... node e2e-fixture.mjs --run');
  }
}
