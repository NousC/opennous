// Write each closed deal's record of why it closed (GET-405).
//
// The decision is `buildCloseRecord` in core, pure. This is the loader: for every closed deal in
// `deal_outcomes` that has no `deal.close_record` claim yet (or all of them, with --force), gather
// the evidence the way the deal page does since GET-404 — the deal's own claims and its roster's,
// with the ones whose conversation is attributed to the deal marked as such — plus the touches,
// the CRM's close-date history and the rep's stated reason, and write one claim on the deal.
//
// Runs daily from the worker (a deal that closed today gets its record tomorrow, which is soon
// enough for a record and cheap enough to never think about), and by hand as a script for the
// backfill. No model calls: every event is a claim that already exists, a date the CRM wrote, or
// arithmetic over touches.
//
// Reads by entity id in batches, never by property across the workspace.

import {
  getSupabaseClient, buildCloseRecord, CLOSE_RECORD_PROPERTY, assertClaims,
  withBackfillLock, lockHolder, LockHeldError,
} from '@nous/core';

const PAGE = 1000;
const DEALS_PER_RUN = 400;
const DAY = 86_400_000;

// A real touch: the buyer and us actually talking. Mirrors apps/api/src/lib/activityKinds.mjs,
// which the worker cannot import; the two lists are checked against each other by test.
export const NOT_A_TOUCH = /_opened$|_scheduled$|_cancelled$|_no_show$|_missed$|^added_to_campaign$|^enrichment_run$|^icp_scored$|^contact_created$|^website_visit$|^pricing_page_visit$|^deal_(won|lost|disqualified)$|^signed_up$|^trial_started$|^subscription_|^proposal_viewed$|^meeting_interest$/;
const typeOf = (o) => String(o.property ?? '').replace(/^interaction\./, '');
export const isTouch = (o) => String(o.property ?? '').startsWith('interaction.') && !NOT_A_TOUCH.test(typeOf(o));

/**
 * A read that retries a statement timeout, with a pause. On the first customer the database
 * carries a steady load of short PostgREST transactions, and a cheap, indexed read of the
 * outcomes ledger still hit the timeout twice in a row while several other transactions sat
 * in BEGIN. A retry after a few seconds is the difference between a
 * pass that runs and one that dies on the cheapest query it makes.
 */
async function withRetry(make, { attempts = 4, pauseMs = 4000 } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    const res = await make();
    if (!res.error || !/timeout/i.test(res.error.message)) return res;
    last = res;
    await new Promise(r => setTimeout(r, pauseMs * (i + 1)));
  }
  return last;
}

async function pageAll(make) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await withRetry(() => make(from, from + PAGE - 1));
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

/** A claim row → the shape the builder reads. Pure. */
export function evidenceFromClaim(row, attributedIds) {
  const v = row.value ?? {};
  const m = v.metadata ?? {};
  const ids = [
    ...(Array.isArray(row.supporting_observation_ids) ? row.supporting_observation_ids : []),
    ...(Array.isArray(m.source_observation_ids) ? m.source_observation_ids : []),
    ...(m.source_activity_id ? [m.source_activity_id] : []),
  ].map(String);
  return {
    id: row.id,
    category: String(v.category ?? '').toLowerCase(),
    content: String(v.content ?? '').slice(0, 400),
    quote: m.quote ? String(m.quote).slice(0, 400) : null,
    at: String(m.occurred_at ?? row.valid_from ?? row.computed_at ?? ''),
    status: m.status ?? null, hardness: m.hardness ?? null, stance: m.stance ?? null,
    severity: m.severity ?? null, role: m.role ?? null, entity: m.entity ?? null, product: m.product ?? null,
    filedToDeal: ids.some(id => attributedIds.has(id)),
  };
}

const val = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);

/**
 * Read rows for a list of entity ids in small groups. A group that hits the statement timeout is
 * halved and retried down to a floor, then skipped with a warning rather than taking the whole
 * pass down: a deal read without one person's rows is still a deal read, and the daily pass
 * comes back tomorrow. Both reads here — claims and observations — timed out on the first
 * customer at a hundred ids, the shape the smaller surfaces get away with because they ask
 * for far less per id.
 */
async function readInGroups(label, entityIds, make, { size = 20, floor = 5 } = {}) {
  const out = [];
  for (let i = 0; i < entityIds.length; i += size) {
    const ids = entityIds.slice(i, i + size);
    const { data, error } = await withRetry(() => make(ids), { attempts: 2, pauseMs: 3000 });
    if (error) {
      if (/timeout/i.test(error.message) && size > floor) {
        out.push(...await readInGroups(label, ids, make, { size: Math.max(floor, Math.ceil(size / 2)), floor }));
        continue;
      }
      if (/timeout/i.test(error.message)) { console.warn(`[CLOSE_RECORDS] ${label} skipped for ${ids.length} entities (timeout)`); continue; }
      throw new Error(error.message);
    }
    out.push(...(data ?? []));
  }
  return out;
}

/**
 * Build and write records for one workspace. Returns counts. `dryRun` builds and reports without
 * writing; `force` rebuilds deals that already have a record.
 */
export async function buildCloseRecordsForWorkspace(supabase, workspaceId, { force = false, dryRun = false, limit = DEALS_PER_RUN, log = () => {} } = {}) {
  const counts = { closed: 0, todo: 0, written: 0, explained: 0, unexplained: 0, failed: 0 };

  const outcomes = await pageAll((f, t) => supabase.from('deal_outcomes')
    .select('deal_id, entity_id, outcome, opened_at, closed_at')
    .eq('workspace_id', workspaceId).not('deal_id', 'is', null)
    .order('closed_at', { ascending: false }).range(f, t));
  counts.closed = outcomes.length;
  if (!outcomes.length) return counts;

  // Which already have a record.
  const have = new Set();
  if (!force) {
    const dealIds = outcomes.map(o => o.deal_id);
    for (let i = 0; i < dealIds.length; i += 200) {
      const { data } = await supabase.from('claims').select('entity_id')
        .eq('workspace_id', workspaceId).eq('property', CLOSE_RECORD_PROPERTY).is('invalid_at', null)
        .in('entity_id', dealIds.slice(i, i + 200));
      for (const r of data ?? []) have.add(r.entity_id);
    }
  }
  const todo = outcomes.filter(o => !have.has(o.deal_id)).slice(0, limit);
  counts.todo = todo.length;
  if (!todo.length) return counts;

  for (let b = 0; b < todo.length; b += 50) {
    const batch = todo.slice(b, b + 50);
    const dealIds = batch.map(o => o.deal_id);

    // Roster (stakeholder_of), attribution (observation_deals), close-date history and the rep's
    // word, one read each for the batch.
    const [{ data: roster }, { data: attributed }, { data: history }, { data: repRows }] = await Promise.all([
      withRetry(() => supabase.from('relationships').select('from_entity_id, to_entity_id')
        .eq('workspace_id', workspaceId).eq('type', 'stakeholder_of').in('to_entity_id', dealIds)),
      withRetry(() => supabase.from('observation_deals').select('observation_id, deal_entity_id')
        .eq('workspace_id', workspaceId).in('deal_entity_id', dealIds).limit(20000)),
      withRetry(() => supabase.from('observations').select('entity_id, value, observed_at')
        .eq('workspace_id', workspaceId).eq('property', 'close_date').in('entity_id', dealIds)
        .order('observed_at', { ascending: true }).limit(5000)),
      withRetry(() => supabase.from('claims').select('entity_id, property, value')
        .eq('workspace_id', workspaceId).is('invalid_at', null).in('entity_id', dealIds)
        .in('property', ['lost_reason_stated', 'lost_reason_note', 'won_reason_stated'])),
    ]);
    const rosterOf = new Map(dealIds.map(id => [id, new Set([id])]));
    for (const r of roster ?? []) rosterOf.get(r.to_entity_id)?.add(r.from_entity_id);
    for (const o of batch) rosterOf.get(o.deal_id).add(o.entity_id); // the account itself
    const attributedOf = new Map(dealIds.map(id => [id, new Set()]));
    for (const a of attributed ?? []) attributedOf.get(a.deal_entity_id)?.add(String(a.observation_id));
    const historyOf = new Map(dealIds.map(id => [id, []]));
    for (const h of history ?? []) historyOf.get(h.entity_id)?.push({ at: h.observed_at, value: val(h.value) == null ? null : String(val(h.value)) });
    const repOf = new Map();
    for (const r of repRows ?? []) {
      const cur = repOf.get(r.entity_id) ?? {};
      cur[r.property] = val(r.value);
      repOf.set(r.entity_id, cur);
    }

    // Claims and touches on every entity any deal in the batch reads, then indexed.
    const entityIds = [...new Set([...rosterOf.values()].flatMap(s => [...s]))];
    const earliest = Math.min(...batch.map(o => Date.parse(o.opened_at ?? o.closed_at)).filter(Number.isFinite));
    const lookback = new Date(earliest - 30 * DAY).toISOString();
    // No date floor on the claims read: the lookback is 30 days before the batch's EARLIEST
    // open, which on a CRM-sized workspace is years, so the floor bought nothing and cost the
    // planner an index. The window is applied per deal by the builder. No property pattern on
    // the observations read: `like 'interaction.%'` over a CRM-sized observations table was the first timeout, and
    // the prefix is cheap to test here.
    const claims = (await readInGroups('claims', entityIds, (ids) => supabase.from('claims')
      .select('id, entity_id, value, valid_from, computed_at, supporting_observation_ids')
      .eq('workspace_id', workspaceId).is('invalid_at', null).in('entity_id', ids)
      .like('property', 'note.%').limit(4000)))
      .filter(c => !c.valid_from || c.valid_from >= lookback);
    const touches = (await readInGroups('touches', entityIds, (ids) => supabase.from('observations')
      .select('entity_id, property, observed_at')
      .eq('workspace_id', workspaceId).in('entity_id', ids).gte('observed_at', lookback)
      .order('observed_at', { ascending: false }).limit(4000)))
      .filter(isTouch);
    const claimsByEntity = new Map(), touchesByEntity = new Map();
    for (const c of claims) { if (!claimsByEntity.has(c.entity_id)) claimsByEntity.set(c.entity_id, []); claimsByEntity.get(c.entity_id).push(c); }
    for (const o of touches) { if (!touchesByEntity.has(o.entity_id)) touchesByEntity.set(o.entity_id, []); touchesByEntity.get(o.entity_id).push(o.observed_at); }

    for (const o of batch) {
      const members = rosterOf.get(o.deal_id);
      const attr = attributedOf.get(o.deal_id) ?? new Set();
      const rep = repOf.get(o.deal_id) ?? {};
      const record = buildCloseRecord({
        outcome: o.outcome, openedAt: o.opened_at, closedAt: o.closed_at,
        claims: [...members].flatMap(id => (claimsByEntity.get(id) ?? []).map(c => evidenceFromClaim(c, attr))),
        touches: [...members].flatMap(id => touchesByEntity.get(id) ?? []),
        closeDateChanges: historyOf.get(o.deal_id) ?? [],
        repReason: rep.lost_reason_stated ?? rep.won_reason_stated ?? rep.lost_reason_note ?? null,
      });
      if (record.explained) counts.explained++; else counts.unexplained++;
      log(o, record);
      if (dryRun) continue;
      try {
        await assertClaims(supabase, workspaceId, o.deal_id, { values: { [CLOSE_RECORD_PROPERTY]: record } });
        counts.written++;
      } catch (err) {
        counts.failed++;
        console.warn(`[CLOSE_RECORDS] ${o.deal_id}: ${err?.message ?? err}`);
      }
    }
  }
  return counts;
}

/** The daily pass over every workspace. */
export async function runCloseRecords({ supabase = getSupabaseClient(), workspaceId = null, force = false, dryRun = false, limit = DEALS_PER_RUN } = {}) {
  const ws = workspaceId ? [{ id: workspaceId }]
    : (await supabase.from('workspaces').select('id').order('id')).data ?? [];
  const totals = { closed: 0, todo: 0, written: 0, explained: 0, unexplained: 0, failed: 0 };
  for (const w of ws) {
    try {
      // One writer at a time (GET-412): a backfill holding the workspace skips this pass; the
      // deals it would have built get their record tomorrow.
      const c = await withBackfillLock(supabase, w.id, 'closeRecords', { holder: lockHolder('closeRecords'), leaseMinutes: 60 },
        () => buildCloseRecordsForWorkspace(supabase, w.id, { force, dryRun, limit }));
      for (const k of Object.keys(totals)) totals[k] += c[k];
      if (c.todo) console.log(`[CLOSE_RECORDS] ${w.id}: ${c.closed} closed · ${c.todo} built · ${c.explained} explained, ${c.unexplained} unexplained · ${dryRun ? 'dry run' : `written ${c.written}, failed ${c.failed}`}`);
    } catch (err) {
      if (err instanceof LockHeldError) { console.log(`[CLOSE_RECORDS] ${w.id}: skipped — ${err.message}`); continue; }
      console.error(`[CLOSE_RECORDS] ${w.id}: ${err?.message ?? err}`);
    }
  }
  return totals;
}
