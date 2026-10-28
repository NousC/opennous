// Repair extracted claims that describe somebody other than the person they sit on.
//
// The extractors used to read a person's name from `contacts` — a projection over
// `claims` that a once-a-minute cron fills in — while firing setImmediate off the
// observation write. Inside that window the name was null, the prompt still ordered
// the model to name its subject, and it reached for the nearest proper noun: the
// greeting of a cold pitch, a teammate quoted in a reply header, the loudest speaker
// on a call. The result is claims like "Theo is a Full-Stack MERN engineer" on the
// record of the person who pitched him, or twelve facts about a job candidate filed
// under a different attendee.
//
// The source material is intact — every one of these came from an observation that is
// still there — so this does not delete intelligence, it re-derives it. For each
// affected (entity, activity) pair: invalidate the off-subject claims, then re-run the
// CURRENT extractor over the same source text, which now resolves the subject properly
// and refuses to write a fact that never names them.
//
// SAFE BY DEFAULT: dry-run. Pass --apply to write.
//
// Usage (worker container):
//   docker compose exec -T worker node apps/worker/src/repairOffSubjectClaims.mjs \
//     --workspace <uuid> [--limit N] [--apply]

import './bootEnv.mjs';
import { getSupabaseClient } from '@nous/core';
import { extractActivitySignals, loadSubject } from './signals/index.mjs';
import { loadSourceText } from './signals/extractionText.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const APPLY      = args.includes('--apply');
const RETIRE_ALL = args.includes('--retire-all');   // also retire claims we cannot rebuild
const WORKSPACE = flag('workspace', process.env.WORKSPACE_ID);
const LIMIT     = Number(flag('limit', '500'));

// Only re-extract what the current extractor can actually read back. A claim whose
// source observation is gone (or was never stamped) can be retired but not rebuilt —
// those are reported, never silently dropped.
const REEXTRACTABLE = new Set([
  'linkedin_message', 'linkedin_reply', 'linkedin_replied',
  'email_received', 'email_reply', 'reply', 'positive_reply',
  'slack_dm', 'slack_message', 'meeting_held',
]);

/** Does this text name the person whose record it is on? Mirrors the live guard in
 *  persistFacts: any name token of 3+ characters counts, because "Lou Ellen Pardiwell"
 *  is fairly written "Lou Ellen", and a surname alone names someone perfectly well. */
function namesSubject(content, name) {
  if (!name) return true;
  const lc = String(content).toLowerCase();
  return name.toLowerCase().split(/\s+/).some(p => p.length >= 3 && lc.includes(p));
}

async function main() {
  if (!WORKSPACE) {
    console.error('--workspace <uuid> is required (or set WORKSPACE_ID)');
    process.exit(1);
  }
  const supabase = getSupabaseClient();
  console.log(`[REPAIR] workspace ${WORKSPACE} — ${APPLY ? 'APPLY' : 'dry run'}`);

  const { data: claims, error } = await supabase
    .from('claims')
    .select('id, entity_id, property, value, computed_at')
    .eq('workspace_id', WORKSPACE)
    .like('property', 'note.%')
    .is('invalid_at', null)
    .is('value->metadata->>side', null)   // GET-1052: our side's facts name no buyer by design
    .order('computed_at', { ascending: false })
    .limit(LIMIT);
  if (error) throw error;

  const extracted = (claims ?? []).filter(c => c.value?.source === 'signal_extraction');
  console.log(`[REPAIR] ${extracted.length} extracted claim(s) to check`);

  // Group by the activity they came from: one re-extraction per source, not per claim.
  // A message that produced three bad facts should be read once, not three times.
  const groups = new Map();   // `${entity}:${activity}` -> { entityId, activityId, signalType, claims[] }
  const subjCache = new Map();
  let checked = 0, orphaned = 0, companyFacts = 0;

  for (const c of extracted) {
    if (!subjCache.has(c.entity_id)) {
      subjCache.set(c.entity_id, await loadSubject(supabase, c.entity_id, '', { retries: 0 }));
    }
    const subj = subjCache.get(c.entity_id);
    const name = subj?.name ?? null;
    checked++;

    // about:"company" facts name the COMPANY by design — "Quillmere has raised funding
    // from Ashgrove Capital" mentions no person and is perfectly correct. Check those
    // against the employer, and abstain when we don't know it. Without this the sweep
    // would retire every well-formed company fact in the workspace.
    if (c.value?.metadata?.about === 'company') {
      companyFacts++;
      // Either name is enough. The about-tag is the model's judgment, and a company-
      // tagged fact that names the PERSON ("Corwin identified account context
      // fragmentation…") is correct — the first prod dry run flagged exactly those.
      // Same rule as the live guard in persistFacts.
      if (!subj?.company) continue;
      if (namesSubject(c.value?.content, subj.company) || namesSubject(c.value?.content, name)) continue;
      // A company fact that doesn't name the company either is still suspect — fall
      // through and let it be reviewed like the rest.
    } else if (namesSubject(c.value?.content, name)) continue;

    const activityId = c.value?.metadata?.source_activity_id ?? null;
    const signalType = c.value?.metadata?.signal_type ?? null;
    if (!activityId) { orphaned++; }
    const key = `${c.entity_id}:${activityId ?? 'none'}`;
    const g = groups.get(key) ?? { entityId: c.entity_id, activityId, signalType, name, claims: [] };
    g.claims.push(c);
    groups.set(key, g);
  }

  const badClaims = [...groups.values()].reduce((n, g) => n + g.claims.length, 0);
  console.log(`[REPAIR] checked ${checked} (${companyFacts} company-scoped) · off-subject ${badClaims} across ${groups.size} source(s) · ${orphaned} with no source activity`);

  // Pre-flight. extractActivitySignals catches everything and returns [], so a bad
  // API key, a revoked token or a network wall is indistinguishable from "this
  // message held no facts" — and a run that cannot reach the model would otherwise
  // retire the whole workspace's claims and put nothing back. Prove the round trip
  // on one known-good source before writing anything.
  if (APPLY) {
    const probe = [...groups.values()].find(g => g.name && REEXTRACTABLE.has(g.signalType));
    if (probe) {
      const { data: obs } = await supabase.from('observations')
        .select('workspace_id, property, source, raw, value').eq('id', probe.activityId).maybeSingle();
      // A meeting's summary is a 12,000-character cut; read the full transcript document.
      const text = await loadSourceText(supabase, obs);
      if (text && text.length > 120) {
        let got = [];
        try {
          got = await extractActivitySignals({
            supabase, workspaceId: WORKSPACE, activityId: probe.activityId,
            contactId: probe.entityId, type: probe.signalType, source: 'repair-preflight',
            summary: text, dryRun: true, strict: true,   // an outage throws instead of reading as "no facts"
          });
        } catch (err) {
          console.error(`[REPAIR] ABORT — the model is unavailable: ${err.message}`);
          console.error('[REPAIR] Refusing to retire claims we cannot replace. Nothing written.');
          process.exit(2);
        }
        if (!got.length) {
          console.error('[REPAIR] ABORT — the pre-flight extraction returned nothing on a substantial source.');
          console.error('[REPAIR] That usually means the extractor cannot reach the model (check ANTHROPIC_API_KEY).');
          console.error('[REPAIR] Refusing to retire claims we may not be able to replace. Nothing written.');
          process.exit(2);
        }
        console.log('[REPAIR] pre-flight OK — the extractor is reaching the model');
      }
    }
  }

  let retired = 0, reextracted = 0, recovered = 0, unrecoverable = 0, barren = 0;

  for (const g of groups.values()) {
    const label = `${g.name ?? '(nameless)'} / ${g.signalType ?? 'unknown'}`;
    for (const c of g.claims) console.log(`  ✗ ${label}: "${String(c.value?.content).slice(0, 110)}"`);

    // The source text, straight from the observation the claim was stamped with.
    let sourceText = null;
    let occurredAt = null;   // when the source was said, so the rebuilt claims keep its date (GET-770)
    if (g.activityId) {
      const { data: obs } = await supabase.from('observations')
        .select('workspace_id, property, source, raw, value, observed_at').eq('id', g.activityId).maybeSingle();
      occurredAt = obs?.observed_at ?? null;
      // A meeting's summary is a 12,000-character cut; read the full transcript document.
      sourceText = await loadSourceText(supabase, obs);
    }
    const why = !g.name ? 'no resolvable subject'
      : !REEXTRACTABLE.has(g.signalType) ? `signal_type ${g.signalType} not re-extractable`
      : !sourceText ? 'source observation carries no text'
      : null;
    const canRebuild = !why;
    if (!canRebuild) unrecoverable += g.claims.length;

    // Default policy: only touch what we can put back. Retiring a claim we cannot
    // rebuild trades a wrong record for an empty one without recovering anything,
    // and for the "no resolvable subject" group it would delete the evidence while
    // leaving the cause in place. Those are listed for review instead. --retire-all
    // opts into the destructive version.
    if (!canRebuild && !RETIRE_ALL) {
      console.log(`    → SKIPPED (${why}) — listed for review, nothing written`);
      continue;
    }

    if (!APPLY) {
      console.log(`    → would retire ${g.claims.length} and re-extract from source`);
      continue;
    }

    // Re-extract FIRST, retire second. The obvious order is the other way round —
    // clear the wrong claim, then write the right one — and it cost us: a bad local
    // ANTHROPIC_API_KEY made every call 401, extractActivitySignals swallowed the
    // error and returned [], and a whole run retired dozens of claims and replaced them
    // with nothing. Retiring is only safe once the replacement exists.
    if (!canRebuild) {
      // --retire-all only: nothing to rebuild, the operator asked for it anyway.
      const { error: e } = await supabase.from('claims')
        .update({ invalid_at: new Date().toISOString() }).in('id', g.claims.map(c => c.id));
      if (e) { console.warn(`    ! retire failed: ${e.message}`); continue; }
      retired += g.claims.length;
      continue;
    }

    const facts = await extractActivitySignals({
      supabase, workspaceId: WORKSPACE,
      activityId: g.activityId, contactId: g.entityId,
      type: g.signalType, source: 'repair', summary: sourceText, occurredAt,
    });
    reextracted++;
    recovered += facts.length;
    for (const f of facts) console.log(`    ✓ "${String(f.content).slice(0, 110)}"`);

    // A source that genuinely yields nothing is a real outcome — a two-line "thanks!"
    // holds no durable fact — but it is indistinguishable from a broken extractor, so
    // keep the old claim and say so. An operator can force it with --retire-all.
    if (!facts.length && !RETIRE_ALL) {
      console.log(`    → re-extraction produced nothing — KEEPING the old claim(s), nothing written`);
      barren += g.claims.length;
      continue;
    }

    const { error: invErr } = await supabase.from('claims')
      .update({ invalid_at: new Date().toISOString() })
      .in('id', g.claims.map(c => c.id));
    if (invErr) { console.warn(`    ! retire failed: ${invErr.message}`); continue; }
    retired += g.claims.length;
  }

  console.log(`[REPAIR] ${APPLY ? 'retired' : 'would retire'} ${APPLY ? retired : badClaims} claim(s)` +
    (APPLY ? ` · re-extracted ${reextracted} source(s) → ${recovered} new fact(s)` : '') +
    ` · ${unrecoverable} not rebuildable` +
    ` · ${barren} kept because re-extraction yielded nothing` +
    ` (${RETIRE_ALL ? '--retire-all: retired anyway' : 'left alone for review'})`);
}

main().catch(err => { console.error('[REPAIR] failed', err); process.exit(1); });
