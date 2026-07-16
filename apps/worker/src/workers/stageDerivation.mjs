// Pipeline-stage derivation — the "Mind made real" for pipeline state.
//
// Most workspaces leave pipeline_stage at its default ('identified') because
// nothing automatically advances it from the substrate. The contact has 5
// LinkedIn replies and held a meeting — but their stage still reads
// 'identified' because that's the backfilled default and no human moved it.
//
// This worker derives pipeline_stage from observation patterns and writes a
// state observation when an entity has advanced. The claim_jobs trigger then
// re-derives the pipeline_stage claim and the agent's queries finally have
// meaningful data to reason about.
//
// Advancement only — never downgrades. Decay is owned by runPipelineDecay
// (separate daily cron). The two are complementary: this one promotes on
// fresh activity, decay demotes on prolonged silence.
//
// Rules (highest precedence wins; client never auto-set):
//   evaluating  ← meeting_held OR proposal_sent in last 60 days
//   interested  ← ≥3 linkedin_message OR any email_replied in last 30 days
//   connected   ← linkedin_connected (accepted connection, no real conversation yet)
//   aware       ← website_visit OR any 1-2 messages in last 30 days
//   (else)      ← no change

import { getSupabaseClient } from '@nous/core';

// Terminal exits (lost/disqualified/churned) rank ABOVE the active ladder so this
// advance-only worker never bumps a terminal account back into the funnel — a
// ladder signal never out-ranks a terminal stage, so the comparison below leaves
// it alone. Reactivation is owned by the real-time activity path (advancePipelineStage).
const STAGE_RANK = { identified: 0, aware: 1, connected: 2, interested: 3, evaluating: 4, client: 5, lost: 6, disqualified: 6, churned: 7 };
const ENTITIES_PER_RUN = 2000;  // sanity cap; loop again on next tick if more
const LOOKBACK_DAYS    = 90;

function deriveStage(observations, currentStage) {
  const now = Date.now();
  const ageDays = obs => (now - new Date(obs.observed_at).getTime()) / 86_400_000;

  const within60 = observations.filter(o => ageDays(o) <= 60);
  const within30 = observations.filter(o => ageDays(o) <= 30);

  // evaluating: meeting held OR proposal sent in last 60 days
  const hasMeetingOrProposal = within60.some(o =>
    o.property === 'interaction.meeting_held' ||
    o.property === 'interaction.proposal_sent',
  );
  if (hasMeetingOrProposal) return 'evaluating';

  // interested: they actually replied. An INBOUND LinkedIn message or an email
  // reply in the last 30 days is a real two-way conversation. Outbound messages
  // (ones WE sent) never count — reaching out to a cold prospect is not interest.
  const isInbound = o => (o.raw?.is_outbound ?? false) !== true;
  const inboundLinkedin30 = within30.some(o =>
    o.property === 'interaction.linkedin_message' && isInbound(o),
  );
  const emailReplied30 = within30.some(o => o.property === 'interaction.email_replied');
  if (inboundLinkedin30 || emailReplied30) return 'interested';

  // connected: an accepted LinkedIn connection. A durable relationship state, not a
  // decaying touch — so look across the whole lookback window, not just 30 days.
  // Ranks above 'aware' but is still kept out of the People page.
  const connectedEver = observations.some(o => o.property === 'interaction.linkedin_connected');
  if (connectedEver) return 'connected';

  // aware: passive low-touch in last 30 days (they engaged with us). An outbound
  // message we sent does NOT make them aware — only signals from THEIR side do.
  const websiteVisit30 = within30.some(o => o.property === 'interaction.website_visit');
  if (websiteVisit30) return 'aware';

  // Nothing fires — leave the current stage alone (decay worker will demote).
  return currentStage;
}

export async function runStageDerivation() {
  const supabase = getSupabaseClient();
  const startedAt = Date.now();

  // Active person entities across every workspace. Companies don't pipeline.
  const { data: entities, error: entErr } = await supabase
    .from('entities')
    .select('id, workspace_id')
    .eq('type', 'person')
    .eq('status', 'active')
    .limit(ENTITIES_PER_RUN);
  if (entErr) {
    if (entErr.code === '42P01' || entErr.code === 'PGRST205') return;  // table missing — skip
    console.error('[stage_derivation] entity scan failed:', entErr.message);
    return;
  }
  if (!entities?.length) return;

  const sinceISO = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();

  // Per-workspace tallies so we can log a single summary line per workspace
  // into workspace_system_log (visible on the Ops page).
  const perWorkspace = new Map();   // workspaceId → { scanned, advanced, by_stage }

  for (const e of entities) {
    const [obsRes, claimRes] = await Promise.all([
      supabase
        .from('observations')
        .select('property, observed_at, raw')
        .eq('workspace_id', e.workspace_id)
        .eq('entity_id', e.id)
        .gte('observed_at', sinceISO)
        .order('observed_at', { ascending: false })
        .limit(200),
      supabase
        .from('claims')
        .select('value')
        .eq('workspace_id', e.workspace_id)
        .eq('entity_id', e.id)
        .eq('property', 'pipeline_stage')
        .is('invalid_at', null)
        .maybeSingle(),
    ]);
    if (obsRes.error || claimRes.error) continue;

    const observations = obsRes.data || [];
    if (observations.length === 0) continue;  // nothing to reason from

    const rawCurrent = claimRes.data?.value;
    const currentStage = (typeof rawCurrent === 'string' ? rawCurrent : 'identified');

    const derived = deriveStage(observations, currentStage);

    // Advancement only — never downgrade, never auto-set 'client'.
    const ranks = { current: STAGE_RANK[currentStage] ?? 0, derived: STAGE_RANK[derived] ?? 0 };
    const bump = perWorkspace.get(e.workspace_id) || { scanned: 0, advanced: 0, by_stage: {} };
    bump.scanned++;

    if (ranks.derived > ranks.current) {
      const { error: insErr } = await supabase
        .from('observations')
        .insert({
          workspace_id: e.workspace_id,
          entity_id:    e.id,
          kind:         'state',
          property:     'pipeline_stage',
          value:        derived,   // PostgREST will encode the bare string as jsonb
          source:       'stage_derivation',
          method:       'cron',
          observed_at:  new Date().toISOString(),
        });
      if (!insErr) {
        bump.advanced++;
        bump.by_stage[derived] = (bump.by_stage[derived] || 0) + 1;
      }
    }
    perWorkspace.set(e.workspace_id, bump);
  }

  // One log row per workspace where anything advanced — keeps the Op Log tidy.
  for (const [wsId, t] of perWorkspace) {
    if (t.advanced === 0) continue;
    const breakdown = Object.entries(t.by_stage)
      .map(([s, n]) => `${n}→${s}`).join(', ');
    try {
      await supabase.from('workspace_system_log').insert({
        workspace_id: wsId,
        source: 'stage_derivation',
        event_type: 'stage.advanced',
        summary: `Stage derivation — advanced ${t.advanced}/${t.scanned} entities (${breakdown})`,
        metadata: { scanned: t.scanned, advanced: t.advanced, by_stage: t.by_stage, lookback_days: LOOKBACK_DAYS },
      });
    } catch { /* logging is best-effort */ }
  }

  const totalAdv = [...perWorkspace.values()].reduce((s, t) => s + t.advanced, 0);
  console.log(`[stage_derivation] scanned ${entities.length} entities · advanced ${totalAdv} · ${Date.now() - startedAt}ms`);
}
