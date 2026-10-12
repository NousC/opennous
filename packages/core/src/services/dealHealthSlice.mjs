// Nous deal health for ONE deal, from its slice of the account. Shared by the deal page and the
// nightly job that stores a score on every open deal row (apps/worker dealHealthRefresh.mjs).
//
// The slice used to live only in apps/api (accountDeals.mjs sliceForDeal), and the worker image does
// not contain apps/api. A stored number computed by a second copy of the slicing would drift from
// the number the deal page shows, and a board that disagrees with the page it opens is worse than
// no number at all. So the slice lives here, beside computeDealHealth, and both callers read it.
//
// No LLM anywhere in this file: health is arithmetic over facts already extracted.

import { listAccountNotes } from '../db/notes.js';
import { teamReadContext } from '../db/readContext.js';
import { getDealObservationIds } from '../db/observationDeals.js';
import { loadDealCandidates } from './crmAgent.js';
import { computeDealHealth, loadNextSteps } from './dealHealth.mjs';

const DAY = 86_400_000;
// The same reach the deal page reads (accountDeals.mjs HISTORY_DAYS, listActivities limit 400).
const HISTORY_DAYS = 1095;
const ACTIVITY_LIMIT = 400;

/**
 * Whether a claim's evidence is attributed to the deal. The extractor writes the source
 * observation into `supporting_observation_ids`; older rows carry it only in metadata
 * (`source_activity_id`, `source_observation_ids`). Any of them in `observation_deals` for this
 * deal makes the claim the deal's.
 */
export function claimFiledToDeal(note, attributedIds) {
  if (!attributedIds?.size) return false;
  const m = note?.metadata ?? {};
  const ids = [
    ...(Array.isArray(note?.supporting_observation_ids) ? note.supporting_observation_ids : []),
    ...(Array.isArray(m.source_observation_ids) ? m.source_observation_ids : []),
    ...(m.source_activity_id ? [m.source_activity_id] : []),
  ];
  return ids.some(id => attributedIds.has(String(id)));
}

/**
 * A deal's slice of the account, and its health. `acc` is { company: { id }, contacts, notes,
 * activity }; `deal` is { implied, status, roster }.
 *
 * The people are the deal's roster when the CRM told us one; otherwise the whole account. A person
 * at a paying customer carries pipeline_stage 'client', which computeDealHealth reads as WON (right
 * for the account, wrong for an open expansion on it), so the deal's own status replaces the
 * people's stage here. `healthActivity` is exactly what the score was computed from, so a reason
 * line built beside it describes the same evidence.
 */
export function sliceDealHealth(acc, deal, attributedIds = new Set()) {
  const rosterIds = new Set((deal.roster || []).map(r => (typeof r === 'string' ? r : r.id)));
  const scoped = rosterIds.size > 0 && !deal.implied;
  const inScope = (id) => !scoped || rosterIds.has(id);
  const people = acc.contacts.filter(c => inScope(c.id));
  // A claim is the deal's when its source observation is (GET-404); the roster's other claims stay,
  // marked as the account's. A deal with nothing attributed yet falls back to the roster alone.
  const notes = scoped
    ? acc.notes
        .filter(n => rosterIds.has(n.entity_id) || rosterIds.has(n.metadata?.voiced_by_contact_id) || claimFiledToDeal(n, attributedIds))
        .map(n => ({ ...n, filed_to_deal: claimFiledToDeal(n, attributedIds) }))
    : acc.notes.map(n => ({ ...n, filed_to_deal: false }));
  // The implied deal IS the account, so it reads exactly what the account's Deal Health card reads
  // (its people's latest 100). Two numbers for one account would be a bug on screen.
  const activity = deal.implied
    ? acc.activity.filter(a => a.contact_id !== acc.company.id).slice(0, 100)
    : acc.activity.filter(a => attributedIds.has(a.id) || (a.contact_id !== acc.company.id && inScope(a.contact_id)));
  const dealStage = deal.status === 'won' ? 'won' : null;
  const stakeholders = people.map(c => ({
    id: c.id, title: c.job_title, seniority: c.seniority, last_activity_at: c.last_activity_at,
    pipeline_stage: deal.implied ? c.pipeline_stage : dealStage,
    signal_count: activity.filter(a => a.contact_id === c.id).length,
  }));
  // An open or lost deal is not won because the account once won something (a customer's
  // renewal-lost read 90 "Won" off the account's own deal_won activity).
  const healthActivity = deal.status !== 'won' && !deal.implied
    ? activity.filter(a => !/won|closed[_\s-]?won/i.test(a.activity_type || ''))
    : activity;
  // A deal's next steps are its people's, plus the account's own; undefined when not loaded.
  const nextSteps = acc.nextSteps === undefined ? undefined
    : acc.nextSteps.filter(x => x.entity_id === acc.company.id || inScope(x.entity_id));
  const health = computeDealHealth({ company: acc.company, notes, activity: healthActivity, stakeholders, nextSteps });
  if (deal.status === 'lost') health.band = 'Lost';
  return { people, notes, activity, healthActivity, health };
}

/**
 * The account reads a deal is sliced from, as the WHOLE TEAM may read them. A stored score is
 * shown to everyone, so it rests on team-readable facts (GET-253), the rule loadHealthInputs
 * already follows for the account's stored score. Same people, notes and activity window as the
 * deal page (accountDeals.mjs loadAccountDealContext), minus the owners it shows but health never
 * reads.
 */
export async function loadDealHealthAccount(supabase, workspaceId, companyId) {
  const { data: contactRows, error } = await supabase.from('contacts')
    .select('id, job_title, seniority, pipeline_stage, deal_health_score, last_activity_at')
    .eq('workspace_id', workspaceId).eq('company_id', companyId)
    .order('deal_health_score', { ascending: false, nullsLast: true });
  if (error) throw new Error(error.message);
  const contacts = contactRows || [];
  const contactIds = contacts.map(c => c.id);
  const [notes, activity, nextSteps] = await Promise.all([
    listAccountNotes(supabase, workspaceId, companyId, contactIds, {}, teamReadContext(workspaceId)),
    // The company entity too: an engagement HubSpot tied to no contact lands on the account.
    loadHealthActivity(supabase, workspaceId, [companyId, ...contactIds]),
    loadNextSteps(supabase, workspaceId, [companyId, ...contactIds]),
  ]);
  return { company: { id: companyId }, contacts, notes: notes || [], activity, nextSteps };
}

/**
 * The deal page's activity read (listActivities: interaction.* on these entities, newest 400 in
 * three years) without the message bodies. A team read keeps every row and only redacts content,
 * and health reads nothing but the type, the time and the person, so the rows are the same rows.
 * The bodies are most of the bytes: hundreds of kB for the newest 400 on a large account, read
 * nightly for every account with an open deal, to be thrown away.
 */
export async function loadHealthActivity(supabase, workspaceId, entityIds) {
  if (!entityIds.length) return [];
  const since = new Date(Date.now() - HISTORY_DAYS * DAY).toISOString();
  const { data, error } = await supabase.from('observations')
    .select('id, entity_id, property, observed_at')
    .eq('workspace_id', workspaceId).in('entity_id', entityIds)
    .like('property', 'interaction.%').gte('observed_at', since)
    .order('observed_at', { ascending: false }).limit(ACTIVITY_LIMIT);
  if (error) throw new Error(error.message);
  return (data || []).map(o => ({
    id: o.id, contact_id: o.entity_id,
    activity_type: String(o.property ?? '').replace(/^interaction\./, ''),
    occurred_at: o.observed_at,
  }));
}

/**
 * When the buyer last answered, on any channel. The same rule as computeDealHealth's "Last
 * Response" (dealHealth.mjs isResponse), which returns only a display date; a parity test keeps the
 * two together so the reason line never disagrees with the card.
 */
export function lastBuyerResponseAt(activity, now = Date.now()) {
  let best = -Infinity;
  for (const a of activity || []) {
    const t = (a?.activity_type || '').toLowerCase();
    if (/_sent$|enrichment|deal_won|scheduled|created|updated|scored/.test(t)) continue;
    if (!/meeting|received|reply|inbound|call|linkedin|message/.test(t)) continue;
    const iso = a.occurred_at || a.created_at;
    if (!iso) continue;
    const ms = new Date(iso).getTime();
    if (Number.isFinite(ms) && ms <= now + 60_000 && ms > best) best = ms;
  }
  return Number.isFinite(best) ? new Date(best).toISOString() : null;
}

/** "11 days" / "3 months" / "over a year": a gap a person would say out loud. */
function spokenDays(days) {
  if (days < 45) return `${days} days`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} months`;
  const years = Math.floor(days / 365);
  return years <= 1 ? 'over a year' : `over ${years} years`;
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const uniq = (xs) => [...new Set(xs)];

/**
 * The one line a list shows beside a deal's health number: what is pulling it down, or holding it
 * up. Pure. Built from the same signals the deal page's card shows, never from a model.
 *
 * A deal below Healthy is explained by its two strongest problems, strongest first; a Healthy deal
 * by its two strongest supports. A deal we know nothing about says so, rather than inventing a
 * cause: silence is the absence of evidence, and the score already treats it that way.
 *
 * @param health   computeDealHealth's result ({ score, band, smart, numeric, evidence })
 * @param opts     notes: the slice's notes (names a competitor, spots a hard objection)
 *                 lastResponseAt: lastBuyerResponseAt over the slice's healthActivity
 * @returns string | null
 */
export function dealHealthReason(health, { notes = [], lastResponseAt = null, now = Date.now() } = {}) {
  if (!health || health.score == null) return null;
  if (health.band === 'Won') return 'Won';
  if (health.band === 'Lost') return 'Lost';

  const sig = Object.fromEntries((health.smart || []).map(s => [s.key, s]));
  const num = Object.fromEntries((health.numeric || []).map(s => [s.key, s]));
  const byId = new Map((notes || []).map(n => [n.id, n]));
  const ofIds = (ids) => (ids || []).map(id => byId.get(id)).filter(Boolean);
  const lastMs = lastResponseAt ? Date.parse(lastResponseAt) : NaN;
  const days = Number.isFinite(lastMs) ? Math.max(0, Math.floor((now - lastMs) / DAY)) : null;

  // rank: lower is stronger. Problems and supports are ranked separately.
  const against = [];
  const for_ = [];

  const blk = sig.blocker_severity;
  if (blk && blk.tone !== 'unknown') {
    const open = (blk.evidence || []).length;
    const hard = ofIds(blk.evidence).filter(n => n.metadata?.hardness === 'hard').length;
    const gates = !hard ? '' : open === 1 ? ' (a hard gate)' : hard === 1 ? ', one a hard gate' : `, ${hard} of them hard gates`;
    const text = `${open} open objection${open === 1 ? '' : 's'}${gates}`;
    if (blk.tone === 'bad') against.push({ rank: 1, text });
    else if (blk.tone === 'warn') against.push({ rank: 7, text });
    else for_.push({ rank: 4, text: open ? 'Only minor objections open' : 'Every objection resolved' });
  }

  const comp = sig.competitive_risk;
  if (comp && comp.tone !== 'unknown') {
    const live = uniq(ofIds(comp.evidence)
      .filter(n => n.metadata?.stance !== 'past_failure')
      .map(n => String(n.metadata?.entity || n.label || '').trim())
      .filter(Boolean));
    const text = live.length
      ? `${live.length === 1 ? 'Competitor' : 'Competitors'} in play: ${live.slice(0, 2).map(x => clip(x, 32)).join(', ')}`
      : 'A competitor is in play';
    if (comp.tone === 'bad') against.push({ rank: 2, text });
    else if (comp.tone === 'warn') against.push({ rank: 8, text });
    else for_.push({ rank: 5, text: 'Low competitive risk' });
  }

  if (days == null) against.push({ rank: 3, text: 'No reply from the buyer yet' });
  else if (days > 30) against.push({ rank: 3, text: `No reply in ${spokenDays(days)}` });
  else if (days > 7) against.push({ rank: 10, text: `Quiet ${days} days` });
  else for_.push({ rank: 2, text: days === 0 ? 'Buyer replied today' : days === 1 ? 'Buyer replied yesterday' : `Buyer replied ${days} days ago` });

  const dm = sig.decision_maker;
  // The buying roles named in conversations (GET-691) outrank the seniority fallback below.
  if (dm?.level === 'Champion left') against.push({ rank: 0, text: 'The champion left' });
  else if (dm?.level === 'Buyer left') against.push({ rank: 0.5, text: 'A decision-maker left' });
  else if (dm?.level === 'Blocked') against.push({ rank: 1.5, text: 'A blocker and no champion' });
  else if (dm?.level === 'Partial') against.push({ rank: 11, text: /champion,/i.test(dm.reason || '') ? 'No economic buyer named' : 'Nobody championing it' });
  else if (dm?.level === 'Weak') against.push({ rank: 4, text: 'No senior contact on the deal' });
  else if (dm?.level === 'Single-threaded') against.push({ rank: 9, text: 'Single-threaded' });
  else if (dm?.level === 'Moderate') against.push({ rank: 12, text: 'Senior contacts have gone quiet' });
  else if (dm?.level === 'Unknown') against.push({ rank: 13, text: 'Nobody on the deal yet' });
  else if (dm?.level === 'Strong') for_.push({ rank: 3, text: 'Senior buyer engaged' });

  const step = sig.next_step;
  if (step?.level === 'None') against.push({ rank: 5.5, text: 'No next step agreed' });
  else if (step?.level === 'Overdue') against.push({ rank: step.tone === 'bad' ? 4.5 : 9.5, text: 'Next step overdue' });
  else if (step?.level === 'Agreed') for_.push({ rank: 2.5, text: 'Next step agreed' });

  if (sig.budget?.level === 'Discussed') for_.push({ rank: 6, text: 'Budget discussed' });

  const urg = sig.buyer_urgency;
  const stated = ofIds(urg?.evidence);
  if (urg?.level === 'Low') against.push({ rank: 5, text: 'No buying intent stated' });
  else if (urg?.level === 'Moderate' && /gone quiet/i.test(urg.reason || '')) against.push({ rank: 6, text: 'Gave a timeline, then went quiet' });
  else if (urg?.level === 'High' && stated.some(n => (n.category || '').toLowerCase() === 'buying_signal')) for_.push({ rank: 1, text: 'Active buying intent' });

  const trend = String(num.engagement_trend?.value || '').toLowerCase();
  if (trend === 'cooling') against.push({ rank: 11, text: 'Engagement cooling' });
  else if (trend === 'cold') against.push({ rank: 11, text: 'Engagement gone cold' });
  else if (trend === 'rising') for_.push({ rank: 6, text: 'Engagement rising' });

  const healthy = health.score >= 70;
  // Nothing graded and nobody has answered: the number rests on absence, and the line says so.
  if (!healthy && (health.evidence?.graded ?? 1) === 0 && days == null) {
    return 'Nothing recorded on this deal yet: no reply, no stated intent, no objections';
  }
  const chosen = (healthy ? for_ : against).sort((a, b) => a.rank - b.rank).slice(0, 2).map(x => x.text);
  if (!chosen.length) {
    const unknown = health.evidence?.unknown?.length ?? 0;
    return unknown ? `${unknown} of ${health.evidence.total} signals have nothing recorded yet` : null;
  }
  const line = chosen.map((t, i) => (i === 0 ? t : t.charAt(0).toLowerCase() + t.slice(1))).join('; ');
  return clip(line, 140);
}

/**
 * Health for the OPEN deals on one account: one set of account reads, one attribution read per
 * deal. The deal page's reading of each deal (loadDealCandidates, status null = open), so a deal
 * the page shows as won or lost gets no score here.
 *
 * @param opts.dealIds  only these deals (the job's batch); null = every deal on the account
 * @returns Map<dealId, { status, score, band, reason }>, a row for every requested deal found
 */
export async function dealHealthForAccount(supabase, workspaceId, companyId, { dealIds = null, now = Date.now() } = {}) {
  const [acc, candidates] = await Promise.all([
    loadDealHealthAccount(supabase, workspaceId, companyId),
    loadDealCandidates(supabase, workspaceId, companyId),
  ]);
  const want = dealIds ? new Set(dealIds) : null;
  const out = new Map();
  for (const c of candidates) {
    if (want && !want.has(c.dealEntityId)) continue;
    const status = c.status || 'open';
    if (status !== 'open') { out.set(c.dealEntityId, { status, score: null, band: null, reason: null }); continue; }
    // A failed attribution read degrades exactly as the deal page's does: the roster alone.
    const rows = await getDealObservationIds(supabase, workspaceId, c.dealEntityId).catch(() => []);
    const attributed = new Set(rows.map(r => r.observation_id));
    const { health, notes, healthActivity } = sliceDealHealth(acc, { implied: false, status, roster: c.roster }, attributed);
    const reason = dealHealthReason(health, { notes, lastResponseAt: lastBuyerResponseAt(healthActivity, now), now });
    out.set(c.dealEntityId, { status, score: health.score, band: health.band, reason });
  }
  return out;
}
