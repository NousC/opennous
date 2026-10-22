// Deal Health — one account's contextual health score and the signals behind it.
//
// Lives in core so every surface computes health from ONE implementation: the account page, the
// batch recompute, the deal outlook (/v2/deals, the agent's `deals` tool), and the worker's
// nightly refresh — the API and the worker each have @nous/core, neither has the other's app dir.

import { listNotes, listAccountNotes } from '../db/notes.js';
import { listActivities } from '../db/activities.js';
import { teamReadContext } from '../db/readContext.js';
import { filterDerivedForViewer, TEAM_VIEWER } from '../privacy/messagePrivacy.mjs';
import { windowedCounts, engagementTrend, medianBuyerResponseDays, multiThread, isEvidenceSnapshot, isOutboundActivity, isBuyerResponse } from './engagement.mjs';
import { decisionMakers, committeeRating, selectNextStep } from './accountHealthScore.mjs';
import { computeQualification } from './qualification.mjs';

// Deal Health, computed on read from the SAME intel the record shows — so the four
// "smart signals" are driven by the claim taxonomy (competitor/objection/pain/buying
// signal claims) rather than a browser shadow-computation, and each carries the claim
// ids that justify it (the UI expands them into the real claims). The headline number
// stays the backend's authoritative deal_health_score; only when it's missing do we
// fall back to a blend of the signals so the card is never blank.
//
// `nextSteps` is the account's open and recent next steps (`loadNextSteps`). A caller that has not
// loaded them leaves it undefined, and the Next Step signal is left out rather than read as none.
// `closeDate` is the CRM's close date for a deal, when there is one (qualification reads it).
export function computeDealHealth({ company, notes, activity, stakeholders, nextSteps, closeDate = null }) {
  const intel = (notes || []).filter(n => n.source === 'signal_extraction');
  const byCat = (c) => intel.filter(n => (n.category || '').toLowerCase() === c);
  const competitors = byCat('competitor');
  const objections  = byCat('objection');
  const buying      = byCat('buying_signal');
  // A customer asking for more (onboarding another team, a new use case) is intent too (GET-976).
  // It stays an expansion signal; urgency only cites it as the evidence it is.
  const expansion   = byCat('expansion_signal');
  const intent      = [...buying, ...expansion];
  const timelines   = byCat('timeline');
  const authority   = byCat('authority');
  const budgets     = byCat('budget');
  const departures  = byCat('staff_change').filter(n => (n.metadata?.change || '') === 'left');

  const at = (a) => (a?.activity_type || '').toLowerCase();
  // A conversation snapshot is provenance for a finding, not a second touch (GET-976).
  const acts = (activity || []).filter(a => !isEvidenceSnapshot(a.activity_type));
  const now = Date.now();
  // Real event time (occurred_at), NOT ingest time (created_at) — sorting by ingest made
  // every account read as "responded on the backfill date".
  const tsOf = (a) => a.occurred_at || a.created_at || null;
  const meetings = acts.filter(a => at(a).includes('meeting') && !at(a).includes('scheduled')).length;
  const inbound  = acts.filter(a => /email_received|email_reply/.test(at(a)));   // Buyer Emails count
  const outbound = acts.filter(isOutboundActivity).length;
  // "Last Response" = the most recent BUYER touch on ANY channel — a meeting held, an
  // inbound email/reply, a LinkedIn reply, a call — not just email replies (which missed
  // every meeting). Past events only; a scheduled future meeting is "next", not "last".
  // A message's own direction decides (GET-976): their Slack message is a response, ours is not.
  const isResponse = isBuyerResponse;
  const respMs = acts.filter(isResponse).map(tsOf).filter(Boolean)
    .map(t => new Date(t).getTime()).filter(t => Number.isFinite(t) && t <= now + 60_000);
  const lastInbound = respMs.length ? new Date(Math.max(...respMs)).toISOString() : null;
  const daysSince = lastInbound ? (now - new Date(lastInbound).getTime()) / 86_400_000 : Infinity;

  // Match the real seniority vocabulary (c_suite, not c_level) AND fall back to the job
  // title — a "Chief Product Officer" is a decision-maker even if seniority wasn't tagged.
  const SENIOR = /c[_\s-]?suite|c[_\s-]?level|chief|\bcxo\b|founder|owner|president|partner|\bvp\b|vice[\s-]?president|director|\bhead\b|managing/i;
  const isSenior = (s) => SENIOR.test(s.seniority || '') || SENIOR.test(s.title || '');
  const seniors = (stakeholders || []).filter(isSenior);
  // A senior title is not engagement (GET-976): a senior person counts only once they took part in
  // a conversation in 45 days, the same rule Multi-threading reads.
  const inConversation = new Set(multiThread(stakeholders, now, acts).engaged_ids || []);
  const seniorsInConversation = seniors.filter(s => inConversation.has(s.id));
  const seniorEngaged = seniorsInConversation.length > 0;

  // ── Recency weight: a claim's pull decays with age (~90-day half-life), floored at
  // 0.15 so old-but-real context still counts a little. A concern from months ago
  // shouldn't hold a signal red forever. ──
  const meta = (n) => n.metadata || {};
  const recencyWeight = (n) => {
    const iso = n.created_at || n.updated_at;
    if (!iso) return 0.5;
    const ageDays = Math.max(0, (now - new Date(iso).getTime()) / 86_400_000);
    return Math.max(0.15, Math.pow(0.5, ageDays / 90));
  };

  // ── Competitive Risk — DISTINCT competitors, weighted by STANCE × recency. A vendor
  // they tried and fired (past_failure) counts NEGATIVE (a displacement opening); only
  // live evaluations / incumbents raise risk. 5 mentions of one fired agency ≠ high. ──
  const STANCE_W = { evaluating: 1.0, incumbent: 0.7, mentioned: 0.3, past_failure: -0.4 };
  const compByEntity = new Map();
  for (const n of competitors) {
    const key = String(meta(n).entity || n.label || n.id).trim().toLowerCase() || n.id;
    const stance = STANCE_W[meta(n).stance] != null ? meta(n).stance : 'mentioned';
    const w = STANCE_W[stance] * recencyWeight(n);
    const prev = compByEntity.get(key);
    // Keep the strongest-signal claim per distinct competitor (max |weight|).
    if (!prev || Math.abs(w) > Math.abs(prev.w)) compByEntity.set(key, { n, stance, w, entity: meta(n).entity || n.label });
  }
  const compGroups = [...compByEntity.values()];
  const compScore = compGroups.reduce((s, g) => s + g.w, 0);
  const liveComp = compGroups.filter(g => g.w > 0);
  const firedComp = compGroups.filter(g => g.stance === 'past_failure');
  // Nothing recorded is UNKNOWN, not "Low". Silence about competitors is the absence of
  // evidence, and grading it as good news is how a thin account reads Healthy.
  const [compLevel, compTone] = !compGroups.length ? ['Unknown', 'unknown']
    : compScore > 1.5 ? ['High', 'bad']
    : compScore >= 0.5 ? ['Moderate', 'warn']
    : ['Low', 'good'];
  const compReason =
    !compGroups.length
      ? 'No competitor named in any recorded call or email — we have not heard either way'
      : !liveComp.length && firedComp.length
        ? `No live competitor — ${firedComp.map(g => g.entity).filter(Boolean).slice(0, 2).join(', ') || 'a prior vendor'} was fired (displacement opening)`
        : liveComp.length
          ? `${liveComp.length} live competitor${liveComp.length === 1 ? '' : 's'}: ${liveComp.map(g => g.entity).filter(Boolean).slice(0, 3).join(', ')}`
          : 'Every competitor named here is out of play';

  // ── Blocker Severity — only OPEN objections, weighted by HARDNESS × recency. Resolved
  // ones drop out; a budget/authority/security gate outweighs a soft "send more info". ──
  const HARD_W = { hard: 1.0, soft: 0.5 };
  const openObj = objections.filter(n => (meta(n).status || 'open') === 'open');
  const blockScore = openObj.reduce((s, n) => s + (HARD_W[meta(n).hardness] ?? 0.7) * recencyWeight(n), 0);
  // An account nobody has objected to YET is not an account with no blockers — it is an
  // account we have not heard an objection from. Only resolved objections earn the green.
  const [blockLevel, blockTone] = !objections.length ? ['Unknown', 'unknown']
    : blockScore > 1.5 ? ['Critical', 'bad']
    : blockScore >= 0.5 ? ['Moderate', 'warn']
    : ['Minor', 'good'];
  const resolvedN = objections.length - openObj.length;
  const blockReason = openObj.length
    ? `${openObj.length} open objection${openObj.length === 1 ? '' : 's'}${openObj.some(n => meta(n).hardness === 'hard') ? ' (incl. a hard gate)' : ''}${resolvedN ? `, ${resolvedN} resolved` : ''}`
    : objections.length ? `All ${objections.length} objection${objections.length === 1 ? '' : 's'} resolved`
    : 'No objection recorded yet — nothing has been raised, and nothing has been ruled out';

  const lv = (level, tone, evidence = [], reason = null) => ({ level, tone, evidence, reason });
  const clipText = (t, n = 90) => { const x = String(t || '').replace(/\s+/g, ' ').trim(); return x.length > n ? `${x.slice(0, n - 1)}…` : x; };
  const noteText = (n) => n.content || n.label || '';

  // ── Buying Committee (GET-691) — who is on the deal, from what was said on calls and email:
  // a named champion, an economic buyer or decision-maker, a blocker, and anyone who left. A
  // buying-role holder leaving is the strongest single risk a deal has. With no role named in
  // any conversation, it falls back to seniority, as the old Decision-Maker Buy-In did. ──
  function committeeSignal() {
    const base = { key: 'decision_maker', label: 'Buying Committee' };
    const roleOf = (n) => n.metadata?.role || '';
    const leftIds = new Set(departures.map(n => n.entity_id).filter(Boolean));
    const holders = authority.filter(n => ['champion', 'economic_buyer', 'decision_maker'].includes(roleOf(n)));
    const lostHolders = holders.filter(n => n.entity_id && leftIds.has(n.entity_id));
    const live = holders.filter(n => !lostHolders.includes(n));
    const champions = live.filter(n => roleOf(n) === 'champion');
    const deciders = live.filter(n => roleOf(n) === 'economic_buyer' || roleOf(n) === 'decision_maker');
    const blockers = authority.filter(n => roleOf(n) === 'blocker' && !(n.entity_id && leftIds.has(n.entity_id)));
    if (lostHolders.length) {
      const champ = lostHolders.some(n => roleOf(n) === 'champion');
      const gone = departures.filter(n => lostHolders.some(h => h.entity_id === n.entity_id));
      return { ...base, ...lv(champ ? 'Champion left' : 'Buyer left', 'bad', [...lostHolders, ...gone].map(n => n.id),
        `${champ ? 'The champion' : 'A decision-maker'} has left${gone[0] ? `: ${clipText(noteText(gone[0]))}` : ''}`) };
    }
    if (blockers.length && !champions.length) {
      return { ...base, ...lv('Blocked', 'bad', [...live, ...blockers].map(n => n.id), `A blocker is named and nobody is championing it${deciders.length ? ', though a decision-maker is known' : ''}`) };
    }
    // GET-800: the rating is engaged decision makers over known ones, unnamed roles included, the
    // same rule the account page uses. One of two engaged is Moderate, however senior they are.
    const dms = decisionMakers({ notes: authority, stakeholders, activity: acts, now });
    const rating = committeeRating(dms);
    if (rating.known) {
      const ev = [...dms.flatMap(d => d.evidence)];
      return { ...base, ...lv(rating.level, rating.tone === 'good' && blockers.length ? 'warn' : rating.tone, ev, `${rating.reason}${blockers.length ? ', and a blocker' : ''}`) };
    }
    // One engaged senior is not buy-in when they are the ONLY person on the account: that is a
    // single thread. Strong needs a second person on the account.
    return { ...base,
      ...(!(stakeholders || []).length
            ? lv('Unknown', 'unknown', [], 'Nobody is on this account yet')
        : seniorEngaged && (stakeholders || []).length > 1
            ? lv('Strong', 'good', [], `${seniorsInConversation.length} senior stakeholder${seniorsInConversation.length === 1 ? '' : 's'} in conversation, of ${(stakeholders || []).length} on the account. No buying roles named in a conversation yet`)
        : seniorEngaged
            ? lv('Single-threaded', 'warn', [], `${seniorsInConversation[0]?.title || 'One senior contact'} is engaged, but they are the only person on the account`)
        : seniors.length ? lv('Moderate', 'warn', [], `${seniors.length} senior stakeholder${seniors.length === 1 ? '' : 's'}, but quiet`)
        : lv('Weak', 'bad', [], 'No senior stakeholder identified')) };
  }

  // ── Budget (GET-691) — whether money has come up. The taxonomy records that budget was
  // discussed, not whether it is approved, so this grades the conversation reaching money and
  // shows what was said; a budget problem arrives as an objection and weighs on Blockers. ──
  function budgetSignal() {
    const base = { key: 'budget', label: 'Budget' };
    if (!budgets.length) return { ...base, ...lv('Unknown', 'unknown', [], 'Budget has not come up in any recorded call or email') };
    const latest = [...budgets].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0];
    return { ...base, ...lv('Discussed', 'good', budgets.map(n => n.id), clipText(noteText(latest)) || 'Budget was discussed') };
  }

  // ── Next Step (GET-691) — whether a next step is agreed and still in date. Open steps with a
  // date ahead (or undated and recent) are a deal moving; only overdue ones are a deal slipping;
  // conversations with no step at all are a deal with nothing holding it. ──
  function nextStepSignal() {
    const base = { key: 'next_step', label: 'Next Step' };
    const steps = nextSteps || [];
    const ms = (iso) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };
    const open = steps.filter(x => (x.status || 'open') === 'open');
    const live = open.filter(x => { const due = ms(x.due_at); if (due != null) return due >= now - 86_400_000; const at = ms(x.occurred_at); return at != null && now - at <= 21 * 86_400_000; });
    const overdue = open.filter(x => { const due = ms(x.due_at); return due != null && due < now - 86_400_000; });
    const shortDay = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    // GET-800: the step agreed on the latest conversation (or a meeting booked), never an old task.
    const pick = selectNextStep({ activity: acts, nextSteps: steps, now });
    // Asked for and not yet agreed (GET-976): a live step our side owes, not a plan both sides hold.
    if (pick.status === 'requested' && pick.title) {
      return { ...base, ...lv('Requested', 'warn', [], `${pick.asked_by ? `${pick.asked_by} asked: ` : 'Asked: '}${clipText(pick.title, 70)}. Not agreed or scheduled yet`) };
    }
    if (pick.status !== 'none' && pick.title) {
      return { ...base, ...lv('Agreed', 'good', [], `${clipText(pick.title, 80)}${pick.due_at ? ` (${pick.status === 'scheduled' ? 'on' : 'due'} ${shortDay(pick.due_at)})` : ''}`) };
    }
    if (overdue.length) {
      const worst = Math.max(...overdue.map(x => Math.floor((now - ms(x.due_at)) / 86_400_000)));
      return { ...base, ...lv('Overdue', worst > 14 ? 'bad' : 'warn', [], `${overdue.length} next step${overdue.length === 1 ? '' : 's'} past due, the oldest by ${worst} days: ${clipText(overdue[0].title, 70)}`) };
    }
    if (!steps.length && !lastInbound && !meetings) return { ...base, ...lv('Unknown', 'unknown', [], 'No conversation yet, so no next step to agree') };
    return { ...base, ...lv('None', 'bad', [], live.length
      ? 'No next step from the last call, only older open tasks'
      : open.length
      ? 'The only open steps are undated and old'
      : steps.length ? 'Every step is done, and no new one is agreed' : 'Conversations, but no next step agreed in any of them') };
  }
  const smart = [
    { key: 'competitive_risk', label: 'Competitive Risk', ...lv(compLevel, compTone, compGroups.map(g => g.n.id), compReason) },
    { key: 'blocker_severity', label: 'Blocker Severity', ...lv(blockLevel, blockTone, openObj.map(n => n.id), blockReason) },
    // Urgency reads the DEAL's stated intent, not just how recently they replied: a
    // buying signal or a reply in the last week = High; a stated timeline (or older
    // buying signal) keeps it Moderate even if they've gone quiet ("said urgent, now
    // cooling"). Only no-intent + cold = Low.
    { key: 'buyer_urgency', label: 'Buyer Urgency',
      // Never heard from them AND nothing stated: unknown, not Low. Low is a judgment that
      // needs evidence of silence — which means there has to have been a conversation first.
      // Expansion asks are cited and named, never counted twice (GET-976).
      ...(!lastInbound && !intent.length && !timelines.length
            ? lv('Unknown', 'unknown', [], 'They have not replied yet and have said nothing about timing')
        : (intent.length > 0 && daysSince <= 30) || daysSince <= 7
            ? lv('High', 'good', [...intent, ...timelines].map(n => n.id), `Active intent and recent contact${expansion.length ? `, including ${expansion.length === 1 ? 'an expansion ask' : `${expansion.length} expansion asks`}` : ''}`)
        : daysSince <= 30 || timelines.length > 0 || intent.length > 0
            ? lv('Moderate', 'warn', [...intent, ...timelines].map(n => n.id), (timelines.length && daysSince > 30) ? 'Stated a timeline but has gone quiet' : 'Some recent engagement')
        : lv('Low', 'bad', [], 'No stated intent and no recent replies')) },
    committeeSignal(),
    budgetSignal(),
    ...(nextSteps === undefined ? [] : [nextStepSignal()]),
  ];

  // ── Headline score — reconciled to the SAME contextual signals shown below (not the
  // older s1–s13 engine), so a Low-risk / Strong-buy-in account can't read "At risk",
  // and a WON deal is Healthy by definition. 60% the four smart signals, 40% live
  // engagement (recency of last reply, meetings, outbound). ──
  // 'unknown' scores NEUTRAL, not good: an account we know nothing about must not outrank one
  // we know is going well. It is also what stops silence from reading as health.
  const toneVal = (t) => (t === 'good' ? 85 : t === 'warn' || t === 'unknown' ? 55 : 25);
  const won =
    acts.some(a => /won|closed[_\s-]?won/.test(at(a))) ||
    (stakeholders || []).some(s => ['client', 'closed_won', 'won'].includes((s.pipeline_stage || '').toLowerCase()));
  const smartAvg = smart.reduce((s, x) => s + toneVal(x.tone), 0) / smart.length;
  const engagement = [
    lastInbound ? (daysSince <= 7 ? 85 : daysSince <= 30 ? 55 : 30) : 20,
    meetings > 0 ? 80 : 40,
    outbound > 0 ? 65 : 35,
  ];
  const engAvg = engagement.reduce((a, b) => a + b, 0) / engagement.length;
  let score = Math.round(0.6 * smartAvg + 0.4 * engAvg);
  // Engagement leading indicators — a cooling deal is worse than its point-in-time
  // signals suggest, a rising one better; the trend nudges the score a touch.
  const { recent: eng30, prior: engPrior } = windowedCounts(acts, now);
  const trend = engagementTrend(eng30, engPrior);
  const responseTimeDays = medianBuyerResponseDays(acts);
  const mt = multiThread(stakeholders, now, acts);
  if (!won) score += trend === 'rising' ? 3 : trend === 'cooling' ? -5 : trend === 'cold' ? -8 : 0;
  score = Math.max(0, Math.min(100, score));
  if (won) score = Math.max(score, 90);
  const band = won ? 'Won' : score >= 70 ? 'Healthy' : score >= 40 ? 'Needs attention' : 'At risk';

  const recencyTone = (iso) => {
    if (!iso) return 'bad';
    const d = (now - new Date(iso).getTime()) / 86_400_000;
    return d <= 7 ? 'good' : d <= 30 ? 'warn' : 'bad';
  };
  const shortDate = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
  const TREND_LABEL = { rising: 'Rising', steady: 'Steady', cooling: 'Cooling', cold: 'Cold' };
  const trendTone = trend === 'rising' ? 'good' : trend === 'steady' ? 'good' : trend === 'cooling' ? 'warn' : 'bad';
  const numeric = [
    { key: 'last_response', label: 'Last Response', value: shortDate(lastInbound), tone: recencyTone(lastInbound) },
    { key: 'engagement_trend', label: 'Engagement', value: TREND_LABEL[trend], tone: trendTone },
    // In conversation, not "engaged": product use and people only identified are said apart (GET-976).
    { key: 'multi_threading', label: 'Multi-threading', value: `${mt.engaged}/${mt.total} in conversation`, tone: mt.total === 0 ? 'warn' : mt.single_threaded ? 'bad' : 'good',
      detail: { in_conversation: mt.engaged, product_users: mt.product_users ?? 0, identified: mt.identified ?? 0, total: mt.total } },
    { key: 'response_time', label: 'Buyer response', value: responseTimeDays != null ? `${responseTimeDays}d median` : '—', tone: responseTimeDays == null ? 'warn' : responseTimeDays <= 2 ? 'good' : responseTimeDays <= 7 ? 'warn' : 'bad' },
    { key: 'meetings',      label: 'Meetings',      value: `${meetings} meeting${meetings === 1 ? '' : 's'}`, tone: meetings > 0 ? 'good' : 'warn' },
    { key: 'buyer_emails',  label: 'Buyer Emails',  value: `${inbound.length} received`, tone: inbound.length > 0 ? 'good' : 'warn' },
    { key: 'outbound',      label: 'Outbound',      value: `${outbound} sent`, tone: outbound > 0 ? 'good' : 'bad' },
  ];

  // How much of the score rests on real evidence. Two unknown signals out of four is a very
  // different 70 from four graded ones, and the reader deserves to know which they are looking at.
  const unknownSignals = smart.filter(s => s.tone === 'unknown').map(s => s.label);
  const evidence = {
    graded: smart.length - unknownSignals.length,
    total: smart.length,
    unknown: unknownSignals,
    note: unknownSignals.length
      ? `${unknownSignals.length} of ${smart.length} signals have nothing recorded yet (${unknownSignals.join(', ')}), and count as neutral rather than good.`
      : null,
  };

  // What we know, beside how it feels (GET-1004): MEDDICC from the same intel and people.
  const qualification = computeQualification({ notes: intel, stakeholders, engagedIds: mt.engaged_ids || [], activity: acts, closeDate });

  return { score, band, smart, numeric, evidence, qualification };
}

// Minimal inputs for the contextual score — used by the batch recompute so the board's
// stored score matches the record without loading the whole detail machinery.
/**
 * An account's next steps (GET-691): open `action_item.*` facts on its people and the company, and
 * those closed in the last 30 days. Internal-meeting tasks are ours, not a step agreed with the buyer.
 * The score is shown to the whole team, so a step from one person's private mail is left out.
 */
export async function loadNextSteps(supabase, workspaceId, entityIds) {
  const ids = [...new Set((entityIds || []).filter(Boolean))];
  if (!ids.length) return [];
  const rows = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabase.from('claims')
      .select('entity_id, property, value, supporting_observation_ids, derived_visibility')
      .eq('workspace_id', workspaceId).in('entity_id', ids.slice(i, i + 100))
      .gte('property', 'action_item.').lt('property', 'action_item/')
      .is('invalid_at', null).limit(500);
    if (error) return [];
    rows.push(...(data || []));
  }
  const cutoff = Date.now() - 30 * 86_400_000;
  const mine = rows.filter(r => !r.property.startsWith('action_item.internal_') && r.value && typeof r.value === 'object')
    .filter(r => {
      const st = r.value.status || 'open';
      if (st === 'open') return true;
      const at = Date.parse(r.value.completed_at || r.value.occurred_at || '');
      return st === 'done' && Number.isFinite(at) && at >= cutoff;
    });
  const visible = await filterDerivedForViewer(supabase, workspaceId, mine, TEAM_VIEWER, { isDerived: () => true }).catch(() => []);
  return visible.map(r => ({
    entity_id: r.entity_id, title: r.value.title || '', status: r.value.status || 'open',
    due_at: r.value.due_at || null, occurred_at: r.value.occurred_at || null,
    // Which conversation it came from, so the next step can be read off the latest one (GET-800).
    source_observation_id: (r.supporting_observation_ids || [])[0] ?? null, quote: r.value.quote || null,
    // Who asked, who owes it and whether anyone has said yes (GET-976). A step without a recorded
    // commitment came from a source that only files what was agreed (a call's action items).
    commitment: r.value.commitment || null, asked_by: r.value.asked_by || null, owner_name: r.value.owner_name || null,
    participants: Array.isArray(r.value.participants) ? r.value.participants : [],
    source_type: r.value.source_type || null, source_id: r.value.source_id || null, slack_mentions: r.value.slack_mentions || null,
  }));
}

export async function loadHealthInputs(supabase, workspaceId, companyId) {
  const { data: contacts } = await supabase
    .from('contacts')
    .select('id, first_name, last_name, email, job_title, seniority, pipeline_stage, last_activity_at')
    .eq('workspace_id', workspaceId).eq('company_id', companyId);
  // The same notes the account page reads, so the stored score matches the record.
  // The stored score and its reasons are shown to the whole team, so they rest on team-readable
  // facts (GET-253). The live record a member opens reads the same facts, for the same reason.
  const notes = await listAccountNotes(supabase, workspaceId, companyId, (contacts || []).map(c => c.id), {}, teamReadContext(workspaceId));
  // Named as the account page names them, so an authority claim that names a person matches the
  // same person in the stored score as on the record (GET-976).
  const stakeholders = (contacts || []).map(c => ({
    id: c.id, name: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || null, title: c.job_title, seniority: c.seniority,
    pipeline_stage: c.pipeline_stage, last_activity_at: c.last_activity_at, signal_count: 0,
  }));
  const contactIds = (contacts || []).map(c => c.id);
  let activity = [];
  if (contactIds.length) {
    const cutoff = new Date(Date.now() - 1095 * 86400000).toISOString();
    activity = await listActivities(supabase, { contactIds, since: cutoff, limit: 200 });
  }
  const nextSteps = await loadNextSteps(supabase, workspaceId, [companyId, ...contactIds]);
  return { notes, activity, stakeholders, nextSteps };
}

/**
 * The health TREND: every score ever written for this account, oldest first.
 *
 * No new table and no backfill — `companies` is a view, and its write trigger already records
 * each change to deal_health_score as a state observation. The history was being thrown away by
 * the reader, not by the writer: the chart drew one flat line from today's number.
 *
 * Consecutive identical scores collapse to the first of the run, so the series carries the
 * MOVES; the caller appends today's score as the final point.
 */
export async function loadHealthHistory(supabase, workspaceId, accountId, { days = 180, limit = 500 } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { data } = await supabase.from('observations')
    .select('value, observed_at')
    .eq('workspace_id', workspaceId)
    .eq('entity_id', accountId)
    .eq('property', 'deal_health_score')
    .gte('observed_at', since)
    .order('observed_at', { ascending: true })
    .limit(limit);

  const out = [];
  for (const row of data || []) {
    const raw = row.value && typeof row.value === 'object' ? row.value.value : row.value;
    const score = Number(raw);
    if (!Number.isFinite(score)) continue;
    if (out.length && out[out.length - 1].score === score) continue;   // same score, no move
    out.push({ at: row.observed_at, score });
  }
  return out;
}

/**
 * Health for the account a deal lives on: the COMPANY where its people are linked, else the
 * person themselves (a deal with no company on record). A company's fresh score is written back
 * to the stored column — only when it changed — so the board matches what the agent just said.
 */
export async function loadAccountHealth(supabase, workspaceId, accountId, { persist = true } = {}) {
  const { data: company } = await supabase.from('companies')
    .select('id, deal_health_score').eq('workspace_id', workspaceId).eq('id', accountId).maybeSingle();

  let inputs;
  if (company) {
    inputs = await loadHealthInputs(supabase, workspaceId, accountId);
  } else {
    const { data: person } = await supabase.from('contacts')
      .select('id, job_title, seniority, pipeline_stage, last_activity_at')
      .eq('workspace_id', workspaceId).eq('id', accountId).maybeSingle();
    if (!person) return null;
    const cutoff = new Date(Date.now() - 1095 * 86400000).toISOString();
    inputs = {
      notes: await listNotes(supabase, workspaceId, { entityId: accountId, limit: 200 }, teamReadContext(workspaceId)),
      activity: await listActivities(supabase, { contactIds: [accountId], since: cutoff, limit: 200 }),
      nextSteps: await loadNextSteps(supabase, workspaceId, [accountId]),
      stakeholders: [{
        id: person.id, title: person.job_title, seniority: person.seniority,
        pipeline_stage: person.pipeline_stage, last_activity_at: person.last_activity_at, signal_count: 0,
      }],
    };
  }

  const dh = computeDealHealth({ company, ...inputs });
  if (persist && company && dh.score != null && dh.score !== company.deal_health_score) {
    await supabase.from('companies')
      .update({ deal_health_score: dh.score, deal_health_computed_at: new Date().toISOString() })
      .eq('id', accountId)
      .then(null, () => {});
  }
  return dh;
}
