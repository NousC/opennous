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
// Rules (highest precedence wins):
//   outcome        ← a deal-ending activity (won / lost / disqualified / churned),
//                    at ANY age. Outcomes are not windowed: a deal that closed last
//                    year is still closed. Everything below is windowed to recent
//                    activity, because a ladder rung describes momentum and momentum
//                    decays — an outcome does not.
//   negotiation    ← a fresh buying_signal claim in last 60 days (asked for the
//                    agreement, agreed pricing, verbal commit — the account actively
//                    closing), OR proposal_sent in last 60 days. This is the
//                    CONTENT-DRIVEN rung: it reads what the extractor learned, not
//                    just which event types fired.
//   discovery      ← meeting_held in last 60 days (a call actually happened)
//   meeting_booked ← a LIVE meeting_scheduled in last 60 days (it's on the calendar;
//                    cancelled and declined slots don't count)
//   interested     ← an engaged inbound linkedin_message OR email reply in last 30 days
//   connected      ← linkedin_connected, OR website_visit in last 30 days
//   (else)         ← no change

import { getSupabaseClient, normalizeStage, stageRank, transitionAt, claimDomainOf,
         terminalStageForType, TERMINAL_DRIVING_PROPERTIES, STAGE_RANK } from '@nous/core';

// The rung past which 'disqualified' is no longer a valid conclusion (see deriveStage).
const STAGE_RANK_MEETING_BOOKED = STAGE_RANK.meeting_booked;

// Ranks come from the canonical funnel (packages/core/src/pipeline.ts) — never a
// local copy. Terminal exits (closed_lost/disqualified/churned) rank ABOVE the
// active ladder so this advance-only worker never bumps a terminal account back
// into the funnel — a ladder signal never out-ranks a terminal stage, so the
// comparisons below leave it alone. Reactivation is owned by the real-time
// activity path (advancePipelineStage).

const ENTITIES_PER_RUN = 2000;  // sanity cap; loop again on next tick if more
const LOOKBACK_DAYS    = 90;

// Exported and `now`-injectable so the rung rules and the evidence timestamps can be
// asserted against fixtures without a database or a frozen system clock — the same
// pattern scoreIntent uses.
export function deriveStage(observations, currentStage, buyingSignals = [], { now = Date.now() } = {}) {
  const ageDays = obs => (now - new Date(obs.observed_at).getTime()) / 86_400_000;
  const claimAgeDays = c => (now - new Date(c.last_observed_at || c.computed_at || 0).getTime()) / 86_400_000;

  const within60 = observations.filter(o => ageDays(o) <= 60);
  const within30 = observations.filter(o => ageDays(o) <= 30);

  // ── outcome first, and deliberately UNWINDOWED ────────────────────────────
  //
  // Every rule below this point is scoped to the last 30-60 days, which is right
  // for ladder rungs (they describe momentum, and momentum decays) and wrong for
  // an outcome: a deal that closed eight months ago is still closed. This worker
  // used to have no outcome rung at all, so it could only ever reach 'negotiation'
  // — meaning any account whose close was replayed rather than observed live
  // (a backfill, an import, a history replay) parked at 'negotiation' forever and
  // its real result was lost. Checked against ALL supplied observations.
  //
  // The two guards mirror advancePipelineStage so the batch path cannot conclude
  // something the live path would have refused:
  //   • churned only follows a win — you cannot churn an account that never bought.
  //   • disqualified cannot apply once a deal is real (meeting booked or beyond);
  //     past that point a dead deal is a LOSS, not an unqualified lead.
  const terminalHit = observations
    .map(o => ({ o, stage: terminalStageForType(String(o.property || '').replace(/^interaction\./, '')) }))
    .filter(x => x.stage)
    .sort((a, b) => new Date(a.o.observed_at) - new Date(b.o.observed_at))[0];
  if (terminalHit) {
    const t = terminalHit.stage;
    const blocked =
      (t === 'churned' && currentStage !== 'closed_won') ||
      (t === 'disqualified' && stageRank(currentStage) >= STAGE_RANK_MEETING_BOOKED);
    if (!blocked) return { stage: t, at: terminalHit.o.observed_at };
  }

  // When the account ENTERED the rung: the EARLIEST qualifying evidence in the window,
  // not the latest and not "whenever the cron happened to look". An account that
  // advanced 40 days ago and went unnoticed until tonight advanced 40 days ago — that
  // is what time-in-stage and the survival curves have to read. Returns null when
  // nothing parses, and the caller falls back to now.
  const earliest = (rows, pick = o => o.observed_at) => {
    let best = null;
    for (const r of rows) {
      const t = new Date(pick(r)).getTime();
      if (!Number.isFinite(t)) continue;
      if (best === null || t < best) best = t;
    }
    return best === null ? null : new Date(best).toISOString();
  };

  // Content-driven rung: a fresh buying signal (asked for a proposal/deck/pricing,
  // agreed pricing, verbal yes) OR an offer we already sent means terms are on the
  // table. This used to be tiered — a STRONG signal derived negotiation and a SOFT
  // one derived proposal — but 'proposal' is folded into 'negotiation' in this
  // funnel, so both tiers land on the same rung and there is nothing left to tier.
  const freshBuying = buyingSignals.filter(c => claimAgeDays(c) <= 60);
  const proposalsSent = within60.filter(o => o.property === 'interaction.proposal_sent');
  if (freshBuying.length || proposalsSent.length) {
    return { stage: 'negotiation', at: earliest([
      ...freshBuying.map(c => ({ observed_at: c.last_observed_at || c.computed_at })),
      ...proposalsSent,
    ]) };
  }

  // discovery: a meeting was actually HELD in last 60 days. Every first call lands here.
  const meetingsHeld = within60.filter(o => o.property === 'interaction.meeting_held');
  if (meetingsHeld.length) return { stage: 'discovery', at: earliest(meetingsHeld) };

  // meeting_booked: a meeting is on the calendar. A held meeting already returned
  // above, so reaching here means it is booked and has not happened yet. A cancelled
  // or declined booking must NOT promote — this worker only advances, so a false
  // promotion parks the account at meeting_booked for good.
  //
  // Cancellation is SLOT-based, never "whichever row is newest". observed_at on a
  // meeting is the meeting's START time, not when we recorded it, and a reschedule
  // drops its cancellation marker on the OLD start (pollers/calendar.mjs,
  // webhooks/calcom.mjs). Comparing newest-scheduled against newest-cancelled
  // therefore gets a meeting moved EARLIER exactly backwards: the marker sitting on
  // the later old slot out-ranks the live booking and the account never promotes.
  // So match the read layer (collapseMeetingDupes in packages/core/src/db/
  // activities.ts): a slot is entity + start-minute, and it is dead if a
  // cancellation lands on that same slot, or if the scheduled row's own label says
  // (Declined)/(Cancelled) — the calendar poller writes a declined invite as a
  // scheduled row with a "(Declined)" label and no cancellation row at all. One
  // entity per call here, so the start-minute alone is the slot key.
  const slotKey = o => Math.floor(new Date(o.observed_at).getTime() / 60_000);
  const meetingLabel = o => String(o.value?.summary || o.value?.description || '');
  const deadSlots = new Set();
  for (const o of within60) {
    if (o.property === 'interaction.meeting_cancelled') deadSlots.add(slotKey(o));
    else if (o.property === 'interaction.meeting_scheduled'
      && /\((declined|cancell?ed)\)/i.test(meetingLabel(o))) deadSlots.add(slotKey(o));
  }
  // NOTE on the timestamp: observed_at on a booking is the meeting's START time, so it
  // can sit in the FUTURE. The booking itself happened earlier, but that moment is not
  // recorded anywhere — the start time is the best evidence we hold. transitionAt()
  // clamps it to now on write, so a call booked today for next week stamps the hop
  // today rather than dating it forward.
  const liveBookings = within60.filter(o =>
    o.property === 'interaction.meeting_scheduled' && !deadSlots.has(slotKey(o)));
  if (liveBookings.length) {
    return { stage: 'meeting_booked', at: earliest(liveBookings) };
  }

  // interested: they actually replied. An INBOUND LinkedIn message or an email
  // reply in the last 30 days is a real two-way conversation. Outbound messages
  // (ones WE sent) never count — reaching out to a cold prospect is not interest.
  // A reply only counts when it's genuine ENGAGEMENT: an opt-out, an out-of-office,
  // or a bounce is the opposite of interest and must never promote to 'interested'.
  const isInbound = o => (o.raw?.is_outbound ?? false) !== true;
  const NON_ENGAGED_REPLY = new Set(['unsubscribe', 'do_not_contact', 'auto_reply', 'bounce']);
  const isEngagedReply = (o) => {
    const sig = o.raw?.reply_signal ?? o.raw?.provider_signal ?? null;
    return o.raw?.sentiment !== 'negative' && !NON_ENGAGED_REPLY.has(sig);
  };
  const inboundLinkedin30 = within30.filter(o =>
    o.property === 'interaction.linkedin_message' && isInbound(o) && isEngagedReply(o),
  );
  // Cold-email replies land as interaction.email_received (Instantly/Smartlead/etc.);
  // the older interaction.email_replied spelling is kept for back-compat. Reading
  // only email_replied meant cold-email repliers never promoted here.
  const emailReplied30 = within30.filter(o =>
    (o.property === 'interaction.email_received' || o.property === 'interaction.email_replied')
    && isEngagedReply(o));
  // A meeting_interest is a provider "meeting booked" disposition — strong intent,
  // but NOT a confirmed calendar meeting, so it promotes to 'interested', never
  // 'meeting_booked' (that rung is reserved for a real meeting_scheduled above).
  const meetingInterest30 = within30.filter(o => o.property === 'interaction.meeting_interest');
  const interestEvidence = [...inboundLinkedin30, ...emailReplied30, ...meetingInterest30];
  if (interestEvidence.length) return { stage: 'interested', at: earliest(interestEvidence) };

  // connected: any lead-side activity short of a real reply. An accepted LinkedIn
  // connection is a durable relationship state, not a decaying touch — so look
  // across the whole lookback window, not just 30 days. A website visit is passive
  // low-touch and used to derive its own 'aware' rung; that rung is gone (a visit is
  // not a funnel position of its own) and lands on 'connected' with everything else
  // the lead did. An outbound message we sent still counts for nothing here — only
  // signals from THEIR side do. Kept out of the People page either way.
  const connectedEver = observations.filter(o => o.property === 'interaction.linkedin_connected');
  const websiteVisit30 = within30.filter(o => o.property === 'interaction.website_visit');
  const connectEvidence = [...connectedEver, ...websiteVisit30];
  if (connectEvidence.length) return { stage: 'connected', at: earliest(connectEvidence) };

  // Nothing fires — leave the current stage alone (decay worker will demote).
  return { stage: currentStage, at: null };
}

// The one category that advances a stage on content. It MUST be in the deal domain: stage is a
// sales-motion fact, and a category from any other domain advancing it is the bug GET-401 found —
// a customer's expansion ask, filed as buying_signal for a fortnight, nudging a pipeline the
// account is not in. Asserted at load so a taxonomy change that moved it would fail the worker
// at startup rather than silently at the next cron (GET-409).
const STAGE_CATEGORY = 'buying_signal';
if (claimDomainOf(STAGE_CATEGORY) !== 'deal') {
  throw new Error(`stageDerivation reads ${STAGE_CATEGORY}, which is not in the deal domain`);
}

// Real-time single-entity recompute. The extractor calls this the instant a
// buying_signal claim lands, so stage advances to negotiation immediately instead
// of waiting for the daily cron. Same advance-only semantics and write path as the
// cron loop below; safe to call fire-and-forget.
export async function recomputeEntityStage(supabase, workspaceId, entityId, { now = Date.now() } = {}) {
  const sinceISO = new Date(now - LOOKBACK_DAYS * 86_400_000).toISOString();
  const [obsRes, claimRes, buyRes, termRes] = await Promise.all([
    // `value` carries the meeting label — the declined/cancelled check below reads it.
    supabase.from('observations').select('property, observed_at, raw, value')
      .eq('workspace_id', workspaceId).eq('entity_id', entityId)
      .gte('observed_at', sinceISO).order('observed_at', { ascending: false }).limit(200),
    supabase.from('claims').select('value')
      .eq('workspace_id', workspaceId).eq('entity_id', entityId)
      .eq('property', 'pipeline_stage').is('invalid_at', null).maybeSingle(),
    supabase.from('claims').select('last_observed_at, computed_at, value')
      .eq('workspace_id', workspaceId).eq('entity_id', entityId)
      .like('property', 'note.%').eq('value->>category', STAGE_CATEGORY)
      .is('invalid_at', null),
    // Outcome rows, NO date floor: the ladder query above is windowed to
    // LOOKBACK_DAYS, which would hide a deal that closed before it. Tiny and
    // indexed on (entity_id, property), so this costs almost nothing.
    supabase.from('observations').select('property, observed_at, raw, value')
      .eq('workspace_id', workspaceId).eq('entity_id', entityId)
      .in('property', TERMINAL_DRIVING_PROPERTIES)
      .order('observed_at', { ascending: true }).limit(20),
  ]);
  if (obsRes.error) return null;
  const observations = [...(obsRes.data || []), ...(termRes?.error ? [] : (termRes?.data || []))];
  const buyingSignals = buyRes?.error ? [] : (buyRes?.data || []);
  const rawCurrent = claimRes.data?.value;
  // Normalize on read: rows still hold pre-migration stages ('aware', 'evaluating',
  // 'proposal', 'client'). A raw legacy string has no rank, so it would score 0 and
  // let this advance-only worker "advance" an account that is already further along.
  const currentStage = normalizeStage(rawCurrent) ?? 'identified';
  const { stage: derived, at: evidenceAt } = deriveStage(observations, currentStage, buyingSignals, { now });
  if (stageRank(derived) <= stageRank(currentStage)) return { advanced: false, stage: currentStage };
  const { error } = await supabase.from('observations').insert({
    workspace_id: workspaceId, entity_id: entityId, kind: 'state',
    property: 'pipeline_stage', value: derived, source: 'stage_derivation',
    // The evidence's own time, not the recompute's. `ingested_at` still records when we
    // noticed, so nothing is lost by dating the hop to when it actually happened.
    method: 'claim_recompute', observed_at: transitionAt(evidenceAt, now),
  });
  return { advanced: !error, from: currentStage, stage: error ? currentStage : derived };
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
    const [obsRes, claimRes, buyRes, termRes] = await Promise.all([
      supabase
        .from('observations')
        // `value` carries the meeting label (see the declined/cancelled check).
        .select('property, observed_at, raw, value')
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
      // Fresh buying_signal note claims — the content-driven signal for the
      // negotiation rung. Category lives in the JSONB value (see saveNote).
      supabase
        .from('claims')
        .select('last_observed_at, computed_at, value')
        .eq('workspace_id', e.workspace_id)
        .eq('entity_id', e.id)
        .like('property', 'note.%')
        .eq('value->>category', STAGE_CATEGORY)
        .is('invalid_at', null),
      // Outcome rows, NO date floor — see recomputeEntityStage. An outcome is not
      // subject to the recency window the ladder rungs use.
      supabase
        .from('observations')
        .select('property, observed_at, raw, value')
        .eq('workspace_id', e.workspace_id)
        .eq('entity_id', e.id)
        .in('property', TERMINAL_DRIVING_PROPERTIES)
        .order('observed_at', { ascending: true })
        .limit(20),
    ]);
    if (obsRes.error || claimRes.error) continue;

    const observations = [...(obsRes.data || []), ...(termRes?.error ? [] : (termRes?.data || []))];
    const buyingSignals = buyRes?.error ? [] : (buyRes?.data || []);
    if (observations.length === 0 && buyingSignals.length === 0) continue;  // nothing to reason from

    const rawCurrent = claimRes.data?.value;
    // Same normalize-on-read as recomputeEntityStage above: an un-migrated legacy
    // stage must rank where it belongs, not at the 0 floor.
    const currentStage = normalizeStage(rawCurrent) ?? 'identified';

    const { stage: derived, at: evidenceAt } = deriveStage(observations, currentStage, buyingSignals);

    // Advancement only — never downgrade. Outcomes DO promote here (they outrank
    // every ladder rung), which is what lets replayed history keep its result.
    const ranks = { current: stageRank(currentStage), derived: stageRank(derived) };
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
          // Dated to the evidence that drove the hop, not to this cron tick — see the
          // note on `earliest` in deriveStage. `ingested_at` still holds the tick time.
          observed_at:  transitionAt(evidenceAt, Date.now()),
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
