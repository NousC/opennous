// Flag Sweep — the change-detection engine behind the "accounts to re-engage" worklist.
// Runs each detector over a workspace's in-touch companies, raising/refreshing/deduping
// persisted flags (upsertFlag respects snooze/dismiss) and auto-resolving flags whose
// condition no longer holds. v1 detectors use only stored substrate (no LLM):
//   fit_cold      — strong ICP fit but deal health cold and quiet (the "great fit gone cold")
//   buying_signal — a fresh buying-signal claim fired (act now)
//   went_dark     — an engaged, in-play account that's gone quiet
// See docs/accounts-flagging-brief.md.
import { getSupabaseClient, getRelationshipOwners, upsertFlag, resolveFlagIfOpen } from '@nous/core';

const DAY = 86_400_000;
const FLAG_TYPES = ['fit_cold', 'buying_signal', 'went_dark', 'engagement_cooling'];

const isEng = (t) => { const s = (t || '').toLowerCase(); if (/enrichment|scored|created|updated|deal_won|import/.test(s)) return false; return /meeting|received|reply|sent|linkedin|call|message|email/.test(s); };
const trendOf = (r, p) => (!r && !p ? 'cold' : !r ? 'cooling' : !p ? 'rising' : r / p >= 1.25 ? 'rising' : r / p <= 0.6 ? 'cooling' : 'steady');

export async function runFlagSweep(supabase, workspaceId) {
  const now = Date.now();

  // In-touch companies = those with at least one contact.
  const { data: cRows } = await supabase.from('contacts')
    .select('id, company_id').eq('workspace_id', workspaceId).not('company_id', 'is', null);
  const companyIds = [...new Set((cRows || []).map(r => r.company_id))];
  if (!companyIds.length) return { raised: 0, resolved: 0 };
  const personCompany = new Map((cRows || []).map(r => [r.id, r.company_id]));

  const { data: companies } = await supabase.from('companies')
    .select('id, name, icp_score, deal_health_score, last_activity_at').in('id', companyIds);
  const owners = await getRelationshipOwners(supabase, workspaceId, companyIds);

  // Fresh buying-signal claims (last 14d) → the companies they belong to.
  const cutoff = new Date(now - 14 * DAY).toISOString();
  const { data: bsClaims } = await supabase.from('claims')
    .select('entity_id, value')
    .eq('workspace_id', workspaceId).like('property', 'note.%')
    .is('invalid_at', null).gte('valid_from', cutoff)
    .filter('value->>category', 'eq', 'buying_signal');
  const buyingByCompany = new Map();
  for (const c of bsClaims || []) {
    const compId = companyIds.includes(c.entity_id) ? c.entity_id : personCompany.get(c.entity_id);
    if (!compId) continue;
    const g = buyingByCompany.get(compId) || { ids: [], labels: [] };
    g.ids.push(c.entity_id);
    if (c.value?.label) g.labels.push(c.value.label);
    buyingByCompany.set(compId, g);
  }

  // Engagement trend: recent-30 vs prior-30 interaction events per company.
  const engCutoff = new Date(now - 60 * DAY).toISOString();
  const { data: evRows } = await supabase.from('observations')
    .select('entity_id, property, observed_at')
    .eq('workspace_id', workspaceId).eq('kind', 'event').gte('observed_at', engCutoff).limit(20000);
  const engByCompany = new Map();
  for (const ev of evRows || []) {
    if (!isEng(String(ev.property || '').replace(/^interaction\./, ''))) continue;
    const compId = companyIds.includes(ev.entity_id) ? ev.entity_id : personCompany.get(ev.entity_id);
    if (!compId) continue;
    const g = engByCompany.get(compId) || { recent: 0, prior: 0 };
    const age = (now - new Date(ev.observed_at).getTime()) / DAY;
    if (age <= 30) g.recent++; else if (age <= 60) g.prior++;
    engByCompany.set(compId, g);
  }

  let raised = 0, resolved = 0;
  const raise = async (entityId, flagType, p) => {
    const f = await upsertFlag(supabase, workspaceId, { entityId, flagType, source: 'sweep', ...p });
    if (f) raised++;
  };
  const clear = async (entityId, flagType) => { await resolveFlagIfOpen(supabase, workspaceId, entityId, flagType); resolved++; };

  for (const co of companies || []) {
    const fit = co.icp_score ?? 0;
    const health = co.deal_health_score;                 // contextual, persisted
    const won = health != null && health >= 90;          // band "Won"/Healthy
    const lastAct = co.last_activity_at ? new Date(co.last_activity_at).getTime() : null;
    const daysQuiet = lastAct ? Math.round((now - lastAct) / DAY) : null;
    const ownerId = owners.get(co.id)?.primary ?? null;

    const fired = new Set();

    // Buying signal — most urgent; overrides the "cold" story.
    const bs = buyingByCompany.get(co.id);
    if (bs) {
      fired.add('buying_signal');
      const tags = bs.labels.slice(0, 3).join(', ');
      await raise(co.id, 'buying_signal', {
        reason: `Buying signal in the last 2 weeks${tags ? ` — ${tags}` : ''}. Reach out now.`,
        evidence: { claim_entity_ids: [...new Set(bs.ids)] },
        fitScore: fit, momentumScore: 90, priority: 90 + Math.round(fit * 0.1), ownerUserId: ownerId,
      });
    }

    // Fit gone cold — strong fit, health cold, quiet.
    if (!won && fit >= 55 && health != null && health < 50 && daysQuiet != null && daysQuiet >= 30) {
      fired.add('fit_cold');
      await raise(co.id, 'fit_cold', {
        reason: `Strong fit (ICP ${fit}) but deal health is ${health} and quiet ${daysQuiet}d — a great fit gone cold.`,
        fitScore: fit, momentumScore: 35, priority: 50 + Math.round(fit * 0.3), ownerUserId: ownerId,
      });
    }

    // Went dark — engaged in-play account gone quiet (only if not already fit_cold, to
    // avoid double-flagging the same account).
    if (!won && !fired.has('fit_cold') && daysQuiet != null && daysQuiet >= 45 && daysQuiet <= 200) {
      fired.add('went_dark');
      await raise(co.id, 'went_dark', {
        reason: `In-play but quiet ${daysQuiet}d — no recent contact. Re-engage before it goes cold.`,
        fitScore: fit, momentumScore: 25, priority: 30 + Math.round(fit * 0.2), ownerUserId: ownerId,
      });
    }

    // Engagement cooling — still active but declining sharply (recent 30d << prior 30d).
    // A leading indicator that fires BEFORE the account goes dark. Skip if already
    // flagged cold/dark (that's a stronger, later state).
    const eng = engByCompany.get(co.id) || { recent: 0, prior: 0 };
    if (!won && !fired.has('fit_cold') && !fired.has('went_dark') && trendOf(eng.recent, eng.prior) === 'cooling' && eng.recent > 0) {
      fired.add('engagement_cooling');
      await raise(co.id, 'engagement_cooling', {
        reason: `Engagement is cooling — ${eng.recent} interactions in the last 30d vs ${eng.prior} the month before. Re-engage before it stalls.`,
        fitScore: fit, momentumScore: 40, priority: 40 + Math.round(fit * 0.2), ownerUserId: ownerId,
      });
    }

    // Auto-resolve any open flag whose condition no longer holds this run.
    for (const t of FLAG_TYPES) if (!fired.has(t)) await clear(co.id, t);
  }

  return { raised, resolved };
}

export async function runFlagSweepCron() {
  const supabase = getSupabaseClient();
  const { data: workspaces } = await supabase.from('workspaces').select('id');
  let raised = 0, resolved = 0;
  for (const ws of workspaces || []) {
    try {
      const r = await runFlagSweep(supabase, ws.id);
      raised += r.raised; resolved += r.resolved;
    } catch (err) {
      console.error(`[FLAG_SWEEP] workspace ${ws.id} error:`, err.message);
    }
  }
  console.log(`[FLAG_SWEEP] done — ${raised} raised/refreshed, ${resolved} resolved`);
  return { raised, resolved };
}
