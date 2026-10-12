// Extract claims from the inbound conversations that never got any.
//
// A source can sit in a workspace with no claims for several reasons, all of them fixed
// upstream now (GET-185/186/187): extraction ran on Haiku while the Anthropic account had
// no credits and every call read as "no facts"; it read a 200-character cut of a message or
// the first 12,000 characters of a call; or the source arrived through a path that never
// extracted at all. This runs the CURRENT pipeline over each one.
//
// What gets picked is exactly what live ingest would extract (extractionSkipReason), from
// someone who is not on our team, with no claim already citing it. Meetings are read once
// per call — all external attendees who lack claims, in one pass — never once per attendee.
//
// SAFE BY DEFAULT: dry run. Every fact that WOULD be written is printed, one JSON line per
// source (BACKFILL_JSON …), so the run can be reviewed before --apply writes anything.
// Batches: --limit N, then --after <observation id> from the previous run's last line.
// --exclude-file <json>: observation ids reviewed out of the dry run (an array, or an object
// keyed by id), never written.
//
// Usage (worker container):
//   docker compose exec -T worker node apps/worker/src/backfillExtraction.mjs \
//     --workspace <uuid> [--types linkedin_message,meeting_held] [--limit N] [--after <id>]
//     [--exclude-file reviewed.json] [--apply]

import './bootEnv.mjs';
import { readFileSync } from 'node:fs';
import { getSupabaseClient, isEntityInternal } from '@nous/core';
import { lockScript, WORKSPACE_WIDE_JOB } from './lib/backfillLock.mjs';
import { extractActivitySignals, extractMeetingSignals, extractionSkipReason, loadSubject, SIGNAL_WORTHY_TYPES } from './signals/index.mjs';
import { activityText, loadSourceText, loadOurSide } from './signals/extractionText.mjs';
import { machineSenderReason } from './utils/emailIdentity.mjs';

const PAGE = 1000;   // PostgREST caps every response at 1000 rows, silently

async function pageAll(makeQuery) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await makeQuery(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) return rows;
  }
}

const typeOf = (obs) => String(obs.property ?? '').replace(/^interaction\./, '');

/**
 * The work list: which sources to extract, as units of work.
 * Pure — every input is already loaded — so the selection is testable without a database.
 *
 * @param observations   interaction observations: { id, entity_id, property, source, raw, value }
 * @param extractedIds   Set of observation ids some live claim already cites
 * @param externalIds    Set of entity ids that are active, external people
 * @returns {{ units: object[], skipped: Record<string, number> }}
 *   unit = { kind: 'message', obs } | { kind: 'meeting', key, observations: obs[] }
 */
export function selectBackfillUnits({ observations, extractedIds, externalIds }) {
  const skipped = {};
  const skip = (why) => { skipped[why] = (skipped[why] ?? 0) + 1; };
  const messages = [];
  const meetings = new Map();

  for (const obs of observations) {
    const type = typeOf(obs);
    if (!SIGNAL_WORTHY_TYPES.has(type)) { skip('not an extracted type'); continue; }
    if (obs.raw?.is_outbound === true || /^You:/.test(obs.value?.summary ?? '')) { skip('sent by us'); continue; }
    if (extractedIds.has(obs.id)) { skip('already has claims'); continue; }
    if (!externalIds.has(obs.entity_id)) { skip('not an active external person'); continue; }
    // The live path has suppressed machine senders since GET-245; this one never has, so a
    // backfill over an imported corpus paid to mine facts out of ticket updates and meeting
    // digests. `bulk` is stamped at ingest by the live path — trust it when it is there, and work
    // it out from the sender when it is not (CRM-imported rows carry no headers and no flag).
    const reason = obs.raw?.bulk === true ? 'machine' : machineSenderReason(obs.raw?.from);
    if (reason) { skip(reason === 'relay' ? 'relayed from a source we already hold' : 'machine sender'); continue; }

    if (type === 'meeting_held' && obs.raw?.meeting_id) {
      // The transcript lives on the call; the short summary check is done on the full text later.
      const key = `${obs.source}:${obs.raw.meeting_id}`;
      if (!meetings.has(key)) meetings.set(key, []);
      meetings.get(key).push(obs);
      continue;
    }
    const why = extractionSkipReason({ type, text: activityText({ summary: obs.value?.summary, description: obs.value?.description, raw: obs.raw }) });
    if (why) { skip(why); continue; }
    messages.push({ kind: 'message', obs });
  }

  const units = [
    ...messages,
    ...[...meetings.entries()].map(([key, list]) => ({ kind: 'meeting', key, observations: list })),
  ].sort((a, b) => unitId(a).localeCompare(unitId(b)));
  return { units, skipped };
}

/**
 * Is this record one of our own teammates? Exact full name, or — when the member's account
 * holds only a first name ("Theo") — the same first name. isEntityInternal catches the
 * flagged records; this catches a teammate's second, unflagged one.
 */
export function isTeammateName(name, teamNames) {
  const n = String(name ?? '').trim().toLowerCase();
  if (!n) return false;
  return teamNames.some(t => {
    const tn = String(t).trim().toLowerCase();
    return tn === n || (!tn.includes(' ') && n.split(/\s+/)[0] === tn);
  });
}

/** A demo record from the seeder (seedMarketingData.mjs) — never a real prospect. */
export const isSeedRecord = (name) => /^\[nous-seed\]/i.test(String(name ?? '').trim());

/** A stable id per unit, for --after batching: the smallest observation id it covers. */
export function unitId(unit) {
  return unit.kind === 'message' ? unit.obs.id : unit.observations.map(o => o.id).sort()[0];
}

// ── run ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

async function main() {
  const APPLY = args.includes('--apply');
  const WORKSPACE = flag('workspace', process.env.WORKSPACE_ID);
  const LIMIT = Number(flag('limit', '100000'));
  const AFTER = flag('after', '');
  const CONCURRENCY = Number(flag('concurrency', '4'));
  const TYPES = (flag('types', '') || [...SIGNAL_WORTHY_TYPES].join(',')).split(',').map(s => s.trim()).filter(Boolean);
  if (!WORKSPACE) { console.error('--workspace <uuid> is required'); process.exit(1); }

  const supabase = getSupabaseClient();
  const lock = await lockScript(supabase, WORKSPACE, WORKSPACE_WIDE_JOB, { note: 'backfillExtraction', leaseMinutes: 360 });
  console.log(`[BACKFILL] workspace ${WORKSPACE} — ${APPLY ? 'APPLY' : 'dry run'} — types ${TYPES.join(', ')}`);

  const observations = await pageAll((a, b) => supabase.from('observations')
    .select('id, workspace_id, entity_id, property, source, raw, value, observed_at')
    .eq('workspace_id', WORKSPACE).in('property', TYPES.map(t => `interaction.${t}`))
    .order('id').range(a, b));

  const claims = await pageAll((a, b) => supabase.from('claims')
    .select('id, value')
    .eq('workspace_id', WORKSPACE).like('property', 'note.%').is('invalid_at', null)
    .filter('value->>source', 'eq', 'signal_extraction')
    .order('id').range(a, b));
  const extractedIds = new Set(claims.map(c => c.value?.metadata?.source_activity_id).filter(Boolean));

  const people = await pageAll((a, b) => supabase.from('entities')
    .select('id').eq('workspace_id', WORKSPACE).eq('type', 'person').eq('status', 'active')
    .order('id').range(a, b));
  const active = new Set(people.map(e => e.id));
  // A teammate's own record is not a prospect, whether or not it carries the internal flag
  // (one founder's second record did not, and got a "fact" about accepting his own invite).
  const ourSide = await loadOurSide(supabase, WORKSPACE);
  const teamNames = ourSide.teamNames;
  const externalIds = new Set();
  const involved = [...new Set(observations.map(o => o.entity_id))].filter(id => active.has(id));
  for (const id of involved) {
    if (await isEntityInternal(supabase, WORKSPACE, id).catch(() => false)) continue;
    externalIds.add(id);
  }

  const excludeFile = flag('exclude-file');
  const excluded = new Set();
  if (excludeFile) {
    const raw = JSON.parse(readFileSync(excludeFile, 'utf8'));
    for (const id of Array.isArray(raw) ? raw : Object.keys(raw)) excluded.add(id);
  }
  const { units: selected, skipped } = selectBackfillUnits({ observations, extractedIds, externalIds });
  const all = selected.filter(u => !excluded.has(unitId(u)));
  if (excluded.size) console.log(`[BACKFILL] ${selected.length - all.length} unit(s) excluded by review`);
  const units = all.filter(u => !AFTER || unitId(u) > AFTER).slice(0, LIMIT);
  console.log(`[BACKFILL] ${observations.length} sources · ${claims.length} extracted claims · ${externalIds.size} external people`);
  console.log(`[BACKFILL] skipped: ${Object.entries(skipped).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none'}`);
  console.log(`[BACKFILL] ${all.length} unit(s) to extract (${all.filter(u => u.kind === 'meeting').length} meetings); this run: ${units.length}`);
  if (!units.length) return;

  // Pre-flight, before any write: prove a round trip to the model on a real source. An
  // unreachable model must never read as "these conversations held nothing".
  if (APPLY) {
    const probe = units.find(u => u.kind === 'message' && activityText({ summary: u.obs.value?.summary, description: u.obs.value?.description, raw: u.obs.raw })?.length > 120);
    if (probe) {
      try {
        const subj = await loadSubject(supabase, probe.obs.entity_id, '', { retries: 0 });
        if (subj) {
          await extractActivitySignals({
            supabase, workspaceId: WORKSPACE, activityId: probe.obs.id, contactId: probe.obs.entity_id,
            type: typeOf(probe.obs), source: 'backfill-preflight', summary: await loadSourceText(supabase, probe.obs),
            dryRun: true, strict: true,
          });
        }
      } catch (err) {
        console.error(`[BACKFILL] ABORT — the model is unavailable: ${err.message}. Nothing written.`);
        await lock.exit(2);
      }
      console.log('[BACKFILL] pre-flight OK');
    }
  }

  const totals = { units: 0, facts: 0, empty: 0, failed: 0, skippedNoSubject: 0 };
  const busy = new Set();   // entity ids being written — one unit per person at a time
  let next = 0, lastDone = null;

  async function runUnit(unit) {
    const source = 'backfill';
    if (unit.kind === 'message') {
      const obs = unit.obs;
      const subj = await loadSubject(supabase, obs.entity_id, '', { retries: 0 });
      if (!subj) { totals.skippedNoSubject++; return { id: obs.id, skipped: 'no resolvable name' }; }
      if (isTeammateName(subj.name, teamNames)) return { id: obs.id, skipped: `teammate record (${subj.name})` };
      if (isSeedRecord(subj.name)) return { id: obs.id, skipped: `demo seed record (${subj.name})` };
      const text = await loadSourceText(supabase, obs);
      const facts = await extractActivitySignals({
        supabase, workspaceId: WORKSPACE, activityId: obs.id, contactId: obs.entity_id,
        type: typeOf(obs), source, summary: text, dryRun: !APPLY,
        // Filed under when it was said, not the day the backfill ran (GET-770).
        occurredAt: obs.observed_at,
      });
      return { id: obs.id, kind: 'message', type: typeOf(obs), person: subj.name, company: subj.company ?? null, chars: text?.length ?? 0, text: text?.slice(0, 600) ?? '', facts };
    }

    // A call: every external attendee who lacks claims, in one pass over the full transcript.
    const participants = [];
    for (const obs of unit.observations) {
      const subj = await loadSubject(supabase, obs.entity_id, '', { retries: 0 });
      if (!subj || isTeammateName(subj.name, teamNames) || isSeedRecord(subj.name)) continue;
      participants.push({ contactId: obs.entity_id, activityId: obs.id, name: subj.name, company: subj.company ?? null, companyId: subj.company_id ?? null });
    }
    if (!participants.length) { totals.skippedNoSubject++; return { id: unitId(unit), skipped: 'no resolvable attendee' }; }
    const text = await loadSourceText(supabase, unit.observations[0]);
    const why = extractionSkipReason({ type: 'meeting_held', text });
    if (why) return { id: unitId(unit), skipped: why };
    const facts = await extractMeetingSignals({
      supabase, workspaceId: WORKSPACE, participants, summary: text, source,
      occurredAt: unit.observations[0].observed_at, dryRun: !APPLY, insights: false,
    });
    return { id: unitId(unit), kind: 'meeting', type: 'meeting_held', person: participants.map(p => p.name).join(', '), company: participants[0].company, chars: text?.length ?? 0, text: text?.slice(0, 600) ?? '', facts };
  }

  const entitiesOf = (u) => u.kind === 'message' ? [u.obs.entity_id] : u.observations.map(o => o.entity_id);
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      // Take the next unit whose people are not being written by another worker.
      let idx = -1;
      for (let i = next; i < units.length; i++) {
        if (units[i] && !entitiesOf(units[i]).some(id => busy.has(id))) { idx = i; break; }
      }
      if (idx === -1) {
        if (units.slice(next).every(u => !u)) return;
        await new Promise(r => setTimeout(r, 200));
        continue;
      }
      const unit = units[idx];
      units[idx] = null;
      while (next < units.length && !units[next]) next++;
      const ids = entitiesOf(unit);
      ids.forEach(id => busy.add(id));
      try {
        const r = await runUnit(unit);
        totals.units++;
        if (r.facts) { totals.facts += r.facts.length; if (!r.facts.length) totals.empty++; }
        const facts = (r.facts ?? []).map(f => ({ content: f.content, category: f.category ?? null, about: f.about ?? null, action: f.action ?? null }));
        console.log('BACKFILL_JSON ' + JSON.stringify({ ...r, facts }));
        lastDone = unitId(unit) > (lastDone ?? '') ? unitId(unit) : lastDone;
      } catch (err) {
        totals.failed++;
        console.log('BACKFILL_JSON ' + JSON.stringify({ id: unitId(unit), error: err.message }));
      } finally {
        ids.forEach(id => busy.delete(id));
      }
    }
  }));

  console.log(`[BACKFILL] ${APPLY ? 'wrote' : 'would write'} ${totals.facts} fact(s) from ${totals.units} unit(s) · ${totals.empty} yielded nothing · ${totals.skippedNoSubject} no resolvable name · ${totals.failed} failed`);
  console.log(`[BACKFILL] last unit: ${lastDone}  (continue with --after ${lastDone})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(err); process.exit(1); });
}
