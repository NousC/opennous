// The built-in detector automations draft their own email (GET-685).
//
// Three of the locked defaults on the Automations page (frontend lib/templates.ts) promise
// "a follow-up is drafted for you, just hit send": Stale deal detection, Deal risk detection and
// Expansion signals. Until this file the detection ran and the draft did not. Now, once a night,
// for every workspace:
//
//   detect   stale_deal        an open deal that has sat in one stage for 14+ days with no touch
//                              in 14+ days (the stage date from the CRM's stage history, the same
//                              reading the deal page's "days in stage" uses: crmAgent
//                              loadDealCandidates → stageEnteredAt).
//            deal_risk        a customer said the relationship is in question: a fresh
//                              `risk_signal` claim on the account, the same claims that put an
//                              account on the Customers page's at-risk list (csHealth.mjs).
//            expansion_signal a customer asked for more of what we sell: a fresh
//                              `expansion_signal` claim with stance `asked` and a named product
//                              (the Customers page's own rule; `considering` is not an ask).
//   choose   the recipient — the person who said it, else the deal's own people, else the
//            champion, else whoever was in touch most recently; never a teammate, always an active
//            address (pickRecipientEmail).
//   draft    one email with Studio's brief (lib/emailDraft.mjs), the sender's own directives
//            (the same member block Studio uses), the team's email voice (GET-902: the "Email
//            voice" context file of the box that holds the built-in, read once per pass) and the
//            automation's instructions, on the writing tier, metered as 'automation-email-draft'.
//   queue    a pending_actions row (status 'pending'). Nothing is sent: POST
//            /api/actions/:id/approve stays the only way out.
//
// ── The ledger, and how the inbox tells these drafts apart ──────────────────────────────
// One ri_recommendations row per (automation, subject): category 'automation', rec_key
// 'automation.<key>', target the deal (stale) or the account (risk, expansion), status
// 'drafting' | 'drafted' — never 'open', so the row is invisible to every worklist reader
// (Focus, attention, /api/recommendations read status 'open' only). Its evidence carries the
// automation, the trigger, the last draft and its fingerprint; the unique key on
// (workspace, target_type, target_id, rec_key) is what makes a second draft for the same subject
// impossible to insert by accident. The draft itself carries rec_id → that row, a rationale (the
// trigger in one line) and is mirrored into ri_decisions with surface 'automation', agent = the
// automation key and the same origin marker in payload. See ORIGIN CONTRACT below.
//
// No schema change: every column used here exists in production today.

import { getSupabaseClient, getAccountRecord, mirrorDraftAsDecision, loadDealCandidates, getRelationshipOwners,
  effectiveOwnerUserId, getInternalEntityIds, bindingConstraints, filterDerivedForViewer, filterByCitedClaimsForViewer,
  TEAM_VIEWER, builtinEmailVoices, emailVoiceBlock } from '@nous/core';
import { pickRecipientEmail } from './recipientEmail.mjs';
import { EMAIL_DRAFT_SYSTEM, parseEmailDraft, DEFAULT_SUBJECT } from './emailDraft.mjs';

const DAY = 86_400_000;
const PAGE = 1000;

/** The llm_usage feature these drafts are metered under (listed in AI_CREDIT_FEATURES). */
export const DRAFT_FEATURE = 'automation-email-draft';
export const ORIGIN_CATEGORY = 'automation';

// The automations, keyed as the origin marker names them. `templateId` is the id of the locked
// default in frontend lib/templates.ts; `prompt` is that template's agent instruction (the
// "Your instructions" step). The defaults store no instructions of their own — they are locked,
// nobody can edit them — so the template's text IS the instruction.
export const DETECTORS = {
  stale_deal: {
    key: 'stale_deal', templateId: 'stale_deal', name: 'Stale deal detection', targetType: 'deal',
    prompt: 'This deal has had no activity for a while. Draft a short, specific follow-up to the main contact that picks up from the last real conversation and asks for one next step.',
  },
  deal_risk: {
    key: 'deal_risk', templateId: 'deal_risk', name: 'Deal risk detection', targetType: 'account',
    prompt: 'This account just turned at-risk. Say in one line why, then draft a short check-in to the main contact that addresses it directly.',
  },
  expansion_signal: {
    key: 'expansion_signal', templateId: 'expansion', name: 'Expansion signals', targetType: 'account',
    prompt: 'An expansion signal just showed on this account. Draft a short note to the main contact that picks up on it and suggests a conversation.',
  },
  // GET-694: the sales-process signals a call or email just raised (account_signals, GET-686),
  // each with its own next move. The instruction is per signal kind (DEAL_SIGNALS below).
  deal_signal: {
    key: 'deal_signal', templateId: 'deal_signals', name: 'Deal signals', targetType: 'account',
    prompt: 'Something just changed on this deal. Draft a short, specific follow-up to the main contact that responds to it and asks for one next step.',
  },
};

/**
 * The deal signals that earn a drafted next move (GET-694), most urgent first. Churn risk and
 * expansion are not here: Deal risk detection and Expansion signals already draft for those.
 * A next step, a budget mention or a new stakeholder is information, not a reason to write.
 */
export const DEAL_SIGNALS = {
  stakeholder_left: {
    rank: 0, label: 'Stakeholder left',
    why: () => 'Someone on the deal left',
    prompt: 'Someone on this deal has left the company. Write to the most senior remaining contact: acknowledge the change in one line, offer to bring them up to speed, and ask who now owns the decision. Never write to the person who left.',
  },
  objection_raised: {
    rank: 1, label: 'Objection raised',
    why: () => 'Raised an objection',
    prompt: 'The buyer raised an objection. Answer it directly with one concrete point (a fact, a customer example, or an offer), in their terms, then propose the next step. Do not argue or repeat the objection back at length.',
  },
  competitor_evaluating: {
    rank: 2, label: 'Evaluating a competitor',
    why: (s) => `Evaluating ${s.detail?.product || s.title || 'a competitor'}`,
    prompt: 'The buyer is evaluating a competitor. Without naming or disparaging them, draw out the one thing this buyer cares about most and how we handle it, and offer a short call to compare side by side.',
  },
  buying_signal: {
    rank: 3, label: 'Buying signal',
    why: () => 'Showed buying intent',
    prompt: 'The buyer just showed buying intent. Make the next step easy: confirm what they asked for in one line and propose a concrete next step with a time.',
  },
};
// Run order when the day's cap is short: a customer in trouble first, an opening next, a quiet
// deal last (there are many more of those, and they keep).
export const DETECTOR_ORDER = ['deal_risk', 'deal_signal', 'expansion_signal', 'stale_deal'];

export const recKeyOf = (key) => `automation.${key}`;

const envNum = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** The knobs. Every one has an env override so a bad night can be turned down without a deploy. */
export function detectorOptions(over = {}) {
  return {
    // Drafting spends credits: at most this many automation drafts per workspace per UTC day.
    dailyCap: envNum('DETECTOR_DRAFTS_DAILY_CAP', 20),
    // A subject (deal or account) gets at most one draft per automation this often, whatever changed.
    minGapDays: envNum('DETECTOR_DRAFTS_MIN_GAP_DAYS', 7),
    // The SAME trigger (same stage stint, same signal) is not drafted again for this long after a
    // draft was made, skipped or approved.
    sameTriggerDays: envNum('DETECTOR_DRAFTS_SAME_TRIGGER_DAYS', 30),
    // A deal is stale after this many days in one stage AND this many days without a touch
    // (the default's own trigger: "sits in one stage for 14 days").
    staleDays: envNum('DETECTOR_DRAFTS_STALE_DAYS', 14),
    // ...and only while it is recent: a deal stuck longer than this (in its stage, or since its last
    // touch) is left alone, so long-dead deals never get an automatic nudge (product decision: last 30 days).
    staleMaxDays: envNum('DETECTOR_DRAFTS_STALE_MAX_DAYS', 30),
    // A signal fires when it was said within this window. Nightly runs need one day; the slack
    // covers a missed night or a signal extracted a few days after the call.
    signalLookbackDays: envNum('DETECTOR_DRAFTS_SIGNAL_LOOKBACK_DAYS', 7),
    // A failed draft (model down, insert refused) is retried on later nights, this many times per trigger.
    maxFailures: 3,
    ...over,
  };
}

// ─── Pure: detection ────────────────────────────────────────────────────────────────

const days = (fromIso, now) => {
  const t = fromIso ? Date.parse(fromIso) : NaN;
  return Number.isFinite(t) ? Math.floor((now - t) / DAY) : null;
};
const clipText = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};
const dayLabel = (iso) => {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : null;
};

/**
 * Open deals quiet long enough to be worth a stage-age read: no touch in `staleDays` (or never).
 * Biggest first, so a short day's cap goes to the deals with the most at stake. Pure.
 * @param rows entity_list_rows deal rows: { entity_id, name, company_id, company_name, stage, status, pipeline_value, last_activity_at }
 */
export function quietOpenDeals(rows, { now = Date.now(), staleDays = 14, staleMaxDays = Infinity } = {}) {
  return (rows ?? [])
    .filter((d) => d?.entity_id && d.company_id && String(d.status ?? '').toLowerCase() === 'open')
    .filter((d) => { const q = days(d.last_activity_at, now); return q == null || (q >= staleDays && q <= staleMaxDays); })
    .sort((a, b) => (Number(b.pipeline_value) || 0) - (Number(a.pipeline_value) || 0)
      || String(a.last_activity_at ?? '').localeCompare(String(b.last_activity_at ?? '')));
}

/**
 * A stale-deal firing from one quiet deal row and its CRM candidate (stage entry date, roster,
 * owner), or null when it does not fire. A deal whose stage entry we cannot date does not fire:
 * "sat in one stage for 14 days" is a claim, and an undated stage cannot back it. Pure.
 */
export function staleDealFiring(row, candidate, { now = Date.now(), staleDays = 14, staleMaxDays = Infinity } = {}) {
  if (!row || !candidate) return null;
  if (String(candidate.status ?? row.status ?? '').toLowerCase() !== 'open') return null;
  const inStage = days(candidate.lastStageChangeAt, now);
  if (inStage == null || inStage < staleDays || inStage > staleMaxDays) return null;
  const quiet = days(row.last_activity_at, now);
  if (quiet != null && (quiet < staleDays || quiet > staleMaxDays)) return null;
  const stage = candidate.stage || row.stage || 'its stage';
  const name = candidate.name || row.name || 'This deal';
  return {
    automation: 'stale_deal',
    targetType: 'deal', targetId: row.entity_id,
    accountId: row.company_id, accountName: row.company_name ?? null,
    dealId: row.entity_id, dealName: name,
    fingerprint: `${row.entity_id}|${String(stage).toLowerCase()}|${String(candidate.lastStageChangeAt).slice(0, 10)}`,
    why: `${name} sat in ${stage} for ${inStage} days${quiet != null ? `, no touch in ${quiet} days` : ', never touched'}`,
    trigger: { stage, days_in_stage: inStage, days_quiet: quiet, stage_entered_at: candidate.lastStageChangeAt, value: row.pipeline_value ?? null },
    rosterIds: Array.isArray(candidate.roster) ? candidate.roster : [],
    ownerEmail: candidate.ownerEmail ?? null,
    raisedBy: null, quote: null,
  };
}

/**
 * Risk or expansion firings from claim rows on accounts — one per account, the gravest/newest
 * signal said within the lookback. Mirrors csHealth.loadConversationSignals' reading: `asked` with
 * a product is an ask (`considering` is not), a decline is never an opening, and an undated
 * signal is too old to quote. Pure.
 * @param rows claims: { entity_id, property, value: { category, content, metadata }, last_observed_at }
 */
export function signalFirings(rows, kind, { now = Date.now(), lookbackDays = 7, names = new Map() } = {}) {
  const category = kind === 'deal_risk' ? 'risk_signal' : kind === 'expansion_signal' ? 'expansion_signal' : null;
  if (!category) return [];
  const best = new Map();
  const declined = new Map(); // account → Map(product → newest decline at)
  const RANK = { stated_churn: 0, at_risk: 1, friction: 2 };
  const candidates = [];
  for (const r of rows ?? []) {
    const v = r?.value ?? {};
    if (String(v.category ?? '').toLowerCase() !== category) continue;
    const m = v.metadata ?? {};
    const at = m.occurred_at ?? r.last_observed_at ?? null;
    const age = days(at, now);
    if (age == null) continue;
    const text = String(v.content ?? '').trim();
    // "A customer said it": csHealth drops a signal with no quote, and so does this.
    if (!text || !String(m.quote ?? '').trim()) continue;
    if (category === 'expansion_signal' && m.stance === 'declined') {
      const product = m.product ? String(m.product).toLowerCase() : null;
      if (product) {
        const byProduct = declined.get(r.entity_id) ?? new Map();
        if (!byProduct.has(product) || String(at) > byProduct.get(product)) byProduct.set(product, String(at));
        declined.set(r.entity_id, byProduct);
      }
      continue;
    }
    if (age > lookbackDays) continue;
    if (category === 'expansion_signal' && !(m.stance === 'asked' && m.product)) continue;
    candidates.push({ r, m, at: String(at), text });
  }
  for (const c of candidates) {
    const { r, m, at, text } = c;
    if (category === 'expansion_signal') {
      // They said no to this product after asking: the no stands.
      const no = declined.get(r.entity_id)?.get(String(m.product).toLowerCase());
      if (no && no >= at) continue;
    }
    const prev = best.get(r.entity_id);
    const rank = category === 'risk_signal' ? (RANK[m.severity] ?? 1) : 0;
    if (prev && (prev.rank < rank || (prev.rank === rank && prev.at >= at))) continue;
    best.set(r.entity_id, { r, m, at, text, rank });
  }
  const out = [];
  for (const [accountId, { r, m, at, text }] of best) {
    const when = dayLabel(at);
    const why = category === 'risk_signal'
      ? `Turned at risk${when ? ` on ${when}` : ''}: ${clipText(text, 140)}`
      : `Asked about ${m.product}${when ? ` on ${when}` : ''}: ${clipText(text, 120)}`;
    out.push({
      automation: kind,
      targetType: 'account', targetId: accountId,
      accountId, accountName: names.get(accountId) ?? null,
      dealId: null, dealName: null,
      fingerprint: `${accountId}|${r.property}`,
      why,
      trigger: {
        claim_property: r.property, said_at: at, text: clipText(text, 400),
        ...(m.severity ? { severity: m.severity } : {}), ...(m.product ? { product: String(m.product) } : {}),
      },
      rosterIds: [],
      ownerEmail: null,
      raisedBy: m.speaker ? String(m.speaker) : null,
      quote: m.quote ? clipText(m.quote, 300) : null,
    });
  }
  return out.sort((a, b) => String(b.trigger.said_at).localeCompare(String(a.trigger.said_at)));
}

/**
 * Deal-signal firings from account_signals rows (GET-694) — one per account, the most urgent kind,
 * newest within it. Each row is already a moment (deduped, dated by when it was said, team-readable
 * checked by the signals worker). The fingerprint is the signal itself, so one signal is drafted
 * at most once. Pure.
 * @param rows account_signals: { id, account_id, entity_id, kind, title, content, quote, speaker, detail, occurred_at, team_readable }
 */
export function dealSignalFirings(rows, { now = Date.now(), lookbackDays = 7, names = new Map() } = {}) {
  const best = new Map();
  for (const s of rows ?? []) {
    const def = DEAL_SIGNALS[s?.kind];
    if (!def || !s.account_id || s.team_readable !== true) continue;
    const age = days(s.occurred_at, now);
    if (age == null || age > lookbackDays) continue;
    const prev = best.get(s.account_id);
    if (prev && (DEAL_SIGNALS[prev.kind].rank < def.rank || (DEAL_SIGNALS[prev.kind].rank === def.rank && String(prev.occurred_at) >= String(s.occurred_at)))) continue;
    best.set(s.account_id, s);
  }
  const out = [];
  for (const [accountId, s] of best) {
    const def = DEAL_SIGNALS[s.kind];
    const when = dayLabel(s.occurred_at);
    const text = String(s.content ?? s.title ?? '').trim();
    const left = s.kind === 'stakeholder_left';
    out.push({
      automation: 'deal_signal',
      targetType: 'account', targetId: accountId,
      accountId, accountName: names.get(accountId) ?? null,
      dealId: null, dealName: null,
      fingerprint: `${accountId}|signal:${s.id}`,
      why: `${def.why(s)}${when ? ` on ${when}` : ''}${text ? `: ${clipText(text, 140)}` : ''}`,
      prompt: def.prompt,
      trigger: { signal_id: s.id, kind: s.kind, label: def.label, said_at: s.occurred_at, text: clipText(text, 400) },
      rosterIds: [],
      ownerEmail: null,
      // Who said it is the best person to answer — unless the signal is that they left.
      raisedBy: !left && s.speaker ? String(s.speaker) : null,
      excludeIds: left && s.entity_id ? [s.entity_id] : [],
      quote: s.quote ? clipText(s.quote, 300) : null,
    });
  }
  return out.sort((a, b) => String(b.trigger.said_at).localeCompare(String(a.trigger.said_at)));
}

// ─── Pure: the gate (idempotency, cooldown, cap) ───────────────────────────────────

// Outcomes that close a trigger for sameTriggerDays. Everything else (failed, the person already
// has a draft waiting, the sender switched drafting off, a constraint, no sender) cost nothing or
// may clear by tomorrow, so the trigger is looked at again the next night.
export const HANDLED_OUTCOMES = new Set(['drafted', 'no_recipient']);

/**
 * Whether a firing may be drafted now, given its subject's ledger row. Pure.
 *
 *   open_draft             this automation's last draft for the subject is still pending: never stack.
 *   in_progress            another run claimed it in the last hour.
 *   same_trigger_cooldown  the SAME trigger was already handled within sameTriggerDays: a draft
 *                          was made (whatever the human then did with it: sent, skipped, left),
 *                          or nobody on the account had an address.
 *   min_gap                any draft for the subject in the last minGapDays, whatever changed.
 *   failed_too_often       this trigger failed maxFailures times; it waits for a new trigger.
 *
 * @param state  the ri_recommendations row ({ status, evidence }) or null.
 * @param ctx    { pendingActionIds: Set, now, ...detectorOptions }
 */
export function gateFiring(firing, state, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const o = { minGapDays: 7, sameTriggerDays: 30, maxFailures: 3, ...ctx };
  const ev = state?.evidence ?? {};
  if (ev.action_id && o.pendingActionIds?.has(ev.action_id)) return { ok: false, reason: 'open_draft' };
  if (state?.status === 'drafting' && ev.attempt_at && now - Date.parse(ev.attempt_at) < 3600_000) {
    return { ok: false, reason: 'in_progress' };
  }
  const same = ev.fingerprint && ev.fingerprint === firing.fingerprint;
  if (same && HANDLED_OUTCOMES.has(ev.outcome)) {
    const age = days(ev.outcome_at, now);
    if (age == null || age < o.sameTriggerDays) return { ok: false, reason: 'same_trigger_cooldown' };
  }
  if (same && ev.outcome === 'failed' && (ev.failures ?? 0) >= o.maxFailures) return { ok: false, reason: 'failed_too_often' };
  const gap = days(ev.drafted_at, now);
  if (gap != null && gap < o.minGapDays) return { ok: false, reason: 'min_gap' };
  return { ok: true };
}

/** How many drafts the ledger says this workspace made today (UTC). Pure. */
export function draftedToday(states, now = Date.now()) {
  const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
  const start = dayStart.getTime();
  let n = 0;
  for (const s of states ?? []) {
    const t = Date.parse(s?.evidence?.drafted_at ?? '');
    if (Number.isFinite(t) && t >= start) n += 1;
  }
  return n;
}

/**
 * Which firings to draft tonight, in DETECTOR_ORDER: the gate per firing, then (when given) the
 * day's cap across all of them. Returns { draft: [firing], skipped: [{ firing, reason }], remaining }. Pure.
 */
export function planDrafts(firings, statesByKey, ctx = {}) {
  const now = ctx.now ?? Date.now();
  // No dailyCap = gate only: the run charges the cap where a model call is made, not here, so a
  // firing that ends without one (no recipient, a draft already waiting) never takes a slot.
  const cap = ctx.dailyCap ?? Infinity;
  let remaining = Math.max(0, cap - draftedToday([...(statesByKey?.values?.() ?? [])], now));
  const order = (f) => { const i = DETECTOR_ORDER.indexOf(f.automation); return i < 0 ? 99 : i; };
  const sorted = [...(firings ?? [])].map((f, i) => ({ f, i })).sort((a, b) => order(a.f) - order(b.f) || a.i - b.i).map((x) => x.f);
  const draft = [];
  const skipped = [];
  const seen = new Set();
  for (const f of sorted) {
    const key = ledgerKey(f);
    if (seen.has(key)) { skipped.push({ firing: f, reason: 'duplicate' }); continue; }
    seen.add(key);
    const g = gateFiring(f, statesByKey?.get(key) ?? null, { ...ctx, now });
    if (!g.ok) { skipped.push({ firing: f, reason: g.reason }); continue; }
    if (remaining <= 0) { skipped.push({ firing: f, reason: 'daily_cap' }); continue; }
    draft.push(f);
    remaining -= 1;
  }
  return { draft, skipped, remaining };
}

export const ledgerKey = (f) => `${recKeyOf(f.automation)}|${f.targetType}|${f.targetId}`;

// ─── Pure: who it goes to ───────────────────────────────────────────────────────────

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const fullName = (p) => [p.first_name, p.last_name].filter(Boolean).join(' ').trim();

/** Does a signal's speaker label name this person? "Odalys" matches Odalys Fenwick; "Odalys F." too. */
export function speakerMatches(person, speaker) {
  const s = norm(speaker);
  if (!s) return false;
  const name = norm(fullName(person));
  if (!name) return false;
  if (s === name) return true;
  const [first, ...rest] = name.split(' ');
  const [sFirst, ...sRest] = s.split(' ');
  if (first !== sFirst) return false;
  if (!sRest.length) return true;              // a first name alone
  const last = rest.join(' ');
  return !!last && last.startsWith(sRest.join(' ').replace(/ /g, ''));
}

/**
 * The people to write to, best first. Pure.
 *
 * Who said it (a risk, an ask) knows what they meant; then the deal's own people (its CRM
 * contacts), a champion among them first; then the account's champion; then whoever was in touch
 * most recently. Teammates and people with no address on file are never candidates.
 *
 * @param people  contacts rows: { id, first_name, last_name, email, last_interaction_at, last_activity_at }
 */
export function rankRecipients(people, { rosterIds = [], championIds = [], raisedBy = null, internalIds = new Set(), excludeIds = [] } = {}) {
  const roster = new Set(rosterIds);
  const champions = new Set(championIds);
  const excluded = new Set(excludeIds);
  const touched = (p) => String(p.last_interaction_at ?? p.last_activity_at ?? '');
  return (people ?? [])
    .filter((p) => p?.id && !internalIds.has(p.id) && !excluded.has(p.id) && String(p.email ?? '').includes('@'))
    .map((p) => ({
      p,
      score: [
        raisedBy && speakerMatches(p, raisedBy) ? 1 : 0,
        roster.has(p.id) && champions.has(p.id) ? 1 : 0,
        roster.has(p.id) ? 1 : 0,
        champions.has(p.id) ? 1 : 0,
      ],
    }))
    .sort((a, b) => {
      for (let i = 0; i < a.score.length; i += 1) if (a.score[i] !== b.score[i]) return b.score[i] - a.score[i];
      return touched(b.p).localeCompare(touched(a.p));
    })
    .map((x) => x.p);
}

export const personName = (p) => fullName(p) || p?.email || 'there';

// ─── Pure: what the inbox reads ─────────────────────────────────────────────────────

/**
 * THE ORIGIN CONTRACT. The marker every automation draft carries, in two places:
 *   ri_recommendations.evidence (the row pending_actions.rec_id points at) and
 *   ri_decisions.payload (decision_id 'app:<pending_actions.id>', surface 'automation',
 *   agent = automation key).
 * Plus pending_actions.rationale = `why`. Shape:
 *   { source: 'automation', automation: 'stale_deal'|'deal_risk'|'expansion_signal',
 *     automation_name, template_id, why, fingerprint, account_id, account_name,
 *     deal_id, deal_name, contact_id, trigger: {...} }
 */
export function originMarker(firing, { contactId = null } = {}) {
  const d = DETECTORS[firing.automation];
  return {
    source: 'automation',
    automation: firing.automation,
    automation_name: d?.name ?? firing.automation,
    template_id: d?.templateId ?? null,
    why: firing.why,
    fingerprint: firing.fingerprint,
    account_id: firing.accountId ?? null,
    account_name: firing.accountName ?? null,
    deal_id: firing.dealId ?? null,
    deal_name: firing.dealName ?? null,
    contact_id: contactId,
    trigger: firing.trigger ?? {},
  };
}

/**
 * The team's email voice for a firing (GET-902): the "Email voice" file of the box that holds its
 * built-in (the detector's templateId is the built-in's key), from the pass's `voices` map. Pure.
 */
export function voiceFor(firing, voices) {
  const key = DETECTORS[firing?.automation]?.templateId;
  return (key && voices?.get?.(key)?.text) || null;
}

/** A draft's system prompt: the shared house rules, the sender's directives, then the team's voice (GET-902). Pure. */
export function draftSystem({ memberBlock = '', voice = null } = {}) {
  return [EMAIL_DRAFT_SYSTEM, memberBlock, emailVoiceBlock(voice)].filter(Boolean).join('\n\n');
}

/** The model's user turn for one draft. Pure. */
export function draftRequest(firing, { recipient, context }) {
  const d = DETECTORS[firing.automation];
  return [
    `Recipient: ${recipient}`,
    `Why you are writing (OpenNous noticed this): ${firing.why}`,
    firing.quote ? `What they said, in their words: "${firing.quote}"` : null,
    `What to write (the ${d?.name ?? 'automation'} instructions): ${firing.prompt ?? d?.prompt ?? 'a timely, specific follow-up'}`,
    '',
    `Account record:\n${context}`,
  ].filter((l) => l !== null).join('\n');
}

// ─── IO ─────────────────────────────────────────────────────────────────────────────

async function pageAll(make) {
  const rows = [];
  for (let from = 0; from < 50_000; from += PAGE) {
    const { data, error } = await make(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

/** The ledger: every automation row for the workspace, keyed like ledgerKey. */
export async function loadLedger(supabase, workspaceId) {
  const rows = await pageAll((from, to) => supabase.from('ri_recommendations')
    .select('id, rec_key, target_type, target_id, status, evidence, updated_at')
    .eq('workspace_id', workspaceId).eq('category', ORIGIN_CATEGORY)
    .order('id').range(from, to));
  return new Map(rows.map((r) => [`${r.rec_key}|${r.target_type}|${r.target_id}`, r]));
}

/** Of these action ids, the ones still waiting on a human. */
async function pendingAmong(supabase, workspaceId, ids) {
  const out = new Set();
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabase.from('pending_actions').select('id')
      .eq('workspace_id', workspaceId).eq('status', 'pending').in('id', ids.slice(i, i + 100));
    if (error) throw new Error(`pending drafts read failed: ${error.message}`);
    for (const r of data ?? []) out.add(r.id);
  }
  return out;
}

async function activeEntityIds(supabase, workspaceId, ids) {
  const out = new Set();
  const uniq = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += 100) {
    const { data, error } = await supabase.from('entities').select('id')
      .eq('workspace_id', workspaceId).eq('status', 'active').in('id', uniq.slice(i, i + 100));
    if (error) throw new Error(`entity status read failed: ${error.message}`);
    for (const r of data ?? []) out.add(r.id);
  }
  return out;
}

async function detectStaleDeals(supabase, workspaceId, { now, staleDays, staleMaxDays, want, dealRows, deps, gate }) {
  const quiet = quietOpenDeals(dealRows, { now, staleDays, staleMaxDays });
  if (!quiet.length || want <= 0) return [];
  // The stage date needs the CRM's stage history, one account at a time. Read only as many
  // accounts as tonight can use (a few spare for the ones that do not fire), biggest deals first.
  const byAccount = new Map();
  for (const d of quiet) {
    if (!byAccount.has(d.company_id)) byAccount.set(d.company_id, []);
    byAccount.get(d.company_id).push(d);
  }
  const out = [];
  let read = 0;
  for (const [companyId, rows] of byAccount) {
    if (out.length >= want || read >= want * 4 + 10) break;
    read += 1;
    let candidates;
    try { candidates = await deps.loadDealCandidates(supabase, workspaceId, companyId); }
    catch (e) { console.warn('[detectorDrafts] deal candidates', companyId, e?.message); continue; }
    const byId = new Map(candidates.map((c) => [c.dealEntityId, c]));
    for (const row of rows) {
      const f = staleDealFiring(row, byId.get(row.entity_id), { now, staleDays, staleMaxDays });
      // Only a firing tonight can act on counts toward `want`; one held by a cooldown would
      // otherwise fill the quota every night and the smaller deals would never be reached.
      if (f && (!gate || gate(f))) out.push(f);
    }
  }
  return out;
}

async function detectSignals(supabase, workspaceId, { now, lookbackDays, deps }) {
  // last_observed_at bounds the read; the signal's own date (metadata.occurred_at) decides.
  const since = new Date(now - (lookbackDays + 30) * DAY).toISOString();
  const rows = await pageAll((from, to) => supabase.from('claims')
    .select('entity_id, property, value, last_observed_at, supporting_observation_ids')
    .eq('workspace_id', workspaceId).is('invalid_at', null)
    .like('property', 'note.%')
    .in('value->>category', ['risk_signal', 'expansion_signal'])
    .gte('last_observed_at', since)
    .order('id').range(from, to));
  // Account-level only: both categories roll up to the company (claimCategories about: company).
  const ids = [...new Set(rows.map((r) => r.entity_id))];
  const names = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabase.from('companies').select('id, name')
      .eq('workspace_id', workspaceId).in('id', ids.slice(i, i + 100));
    if (error) throw new Error(`accounts read failed: ${error.message}`);
    for (const c of data ?? []) names.set(c.id, c.name ?? null);
  }
  // Team-readable only (GET-253): the trigger's words go into a draft, its rationale and the
  // ledger, and GET /api/actions shows a draft to every member. A risk read out of one rep's
  // private email thread must not surface in a teammate's inbox, so it never fires here.
  const onAccounts = await deps.filterDerivedForViewer(supabase, workspaceId, rows.filter((r) => names.has(r.entity_id)), TEAM_VIEWER);
  return [
    ...signalFirings(onAccounts, 'deal_risk', { now, lookbackDays, names }),
    ...signalFirings(onAccounts, 'expansion_signal', { now, lookbackDays, names }),
  ];
}

async function detectDealSignals(supabase, workspaceId, { now, lookbackDays }) {
  // team_readable is set by the signals worker with the message-privacy rules (GET-686); a signal
  // it has not checked yet (null) waits for the next pass.
  const since = new Date(now - lookbackDays * DAY).toISOString();
  let rows;
  try {
    rows = await pageAll((from, to) => supabase.from('account_signals')
      .select('id, account_id, entity_id, kind, title, content, quote, speaker, detail, occurred_at, team_readable')
      .eq('workspace_id', workspaceId).eq('team_readable', true)
      .in('kind', Object.keys(DEAL_SIGNALS)).not('account_id', 'is', null)
      .gte('occurred_at', since)
      .order('id').range(from, to));
  } catch (e) {
    // The table arrived with GET-686's migration; a database without it simply has no signals.
    if (/account_signals|42P01|PGRST205|does not exist/i.test(String(e?.message ?? e))) return [];
    throw e;
  }
  const ids = [...new Set(rows.map((r) => r.account_id))];
  const names = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabase.from('companies').select('id, name')
      .eq('workspace_id', workspaceId).in('id', ids.slice(i, i + 100));
    if (error) throw new Error(`accounts read failed: ${error.message}`);
    for (const c of data ?? []) names.set(c.id, c.name ?? null);
  }
  return dealSignalFirings(rows.filter((r) => names.has(r.account_id)), { now, lookbackDays, names });
}

/** Every firing for one workspace tonight, eligible accounts only. */
export async function detectFirings(supabase, workspaceId, { now = Date.now(), opts = detectorOptions(), want = 20, deps = CORE_DEPS, gate = null } = {}) {
  const dealRows = await pageAll((from, to) => supabase.from('entity_list_rows')
    .select('entity_id, name, company_id, company_name, stage, status, pipeline_value, last_activity_at')
    .eq('workspace_id', workspaceId).eq('kind', 'deal')
    .order('entity_id').range(from, to));
  // `opts.only` narrows a pass to some automations (the hourly deal-signal pass): the others are
  // not read at all, so a frequent pass costs only what it drafts for.
  const wants = (k) => !opts.only || opts.only.includes(k);
  const [stale, claimSignals, dealSignals] = await Promise.all([
    wants('stale_deal')
      ? detectStaleDeals(supabase, workspaceId, { now, staleDays: opts.staleDays, staleMaxDays: opts.staleMaxDays, want, dealRows, deps, gate })
      : [],
    wants('deal_risk') || wants('expansion_signal')
      ? detectSignals(supabase, workspaceId, { now, lookbackDays: opts.signalLookbackDays, deps })
      : [],
    wants('deal_signal') ? detectDealSignals(supabase, workspaceId, { now, lookbackDays: opts.signalLookbackDays }) : [],
  ]);
  const signals = [...claimSignals, ...dealSignals].filter((f) => wants(f.automation));
  // Never an archived or merged deal/account. Never a closed account: when the workspace has a
  // deal spine, a risk or an ask counts only on an account with a won or an open deal (a lost
  // prospect is not a customer to check in with).
  const live = await activeEntityIds(supabase, workspaceId, [...stale, ...signals].flatMap((f) => [f.accountId, f.dealId]));
  const hasSpine = dealRows.length > 0;
  const working = new Set(dealRows.filter((d) => /^(open|won)$/i.test(String(d.status ?? ''))).map((d) => d.company_id));
  let internalCompanies = new Set();
  const internalIds = await deps.getInternalEntityIds(supabase, workspaceId).catch(() => new Set());
  // Our own team's accounts (a company is internal when its people are, as the worklist reads it).
  const internal = [...internalIds];
  for (let i = 0; i < internal.length && i < 1000; i += 100) {
    const { data, error } = await supabase.from('contacts').select('company_id').eq('workspace_id', workspaceId)
      .in('id', internal.slice(i, i + 100)).not('company_id', 'is', null);
    if (error) throw new Error(`internal accounts read failed: ${error.message}`);
    for (const c of data ?? []) internalCompanies.add(c.company_id);
  }
  // A deal signal needs a deal in motion: an open one (or no deal spine at all). A won account's
  // objection is account health's business, and a lost prospect is not chased.
  const openOn = new Set(dealRows.filter((d) => /^open$/i.test(String(d.status ?? ''))).map((d) => d.company_id));
  const eligible = (f) => live.has(f.accountId) && (!f.dealId || live.has(f.dealId)) && !internalCompanies.has(f.accountId)
    && (f.automation === 'stale_deal' || !hasSpine || (f.automation === 'deal_signal' ? openOn.has(f.accountId) : working.has(f.accountId)));
  return { firings: [...stale, ...signals].filter(eligible), internalIds };
}

/** Who the draft is sent as: the account's owner, else the deal's CRM owner, else the first member. */
async function resolveSender(supabase, workspaceId, firing, members, deps) {
  const memberIds = new Set(members.map((m) => m.user_id));
  const owners = await deps.getRelationshipOwners(supabase, workspaceId, [firing.accountId]).catch(() => new Map());
  const owner = effectiveOwnerUserId(owners.get(firing.accountId));
  if (owner && memberIds.has(owner)) return owner;
  if (firing.ownerEmail) {
    const email = String(firing.ownerEmail).trim().toLowerCase();
    const { data, error } = await supabase.from('users').select('id, email').in('id', [...memberIds]);
    if (error) throw new Error(`members' emails read failed: ${error.message}`);
    const hit = (data ?? []).find((u) => String(u.email ?? '').trim().toLowerCase() === email);
    if (hit) return hit.id;
  }
  return members[0]?.user_id ?? null;
}

async function accountPeople(supabase, workspaceId, accountId, deps) {
  // Champions are graph edges (person CHAMPIONS company) in workspace_graph_edges, as the account
  // page reads them (companies.mjs), each citing the claim it was read out of.
  const [{ data: people, error }, { data: champs, error: ce }] = await Promise.all([
    supabase.from('contacts').select('id, first_name, last_name, email, last_interaction_at, last_activity_at')
      .eq('workspace_id', workspaceId).eq('company_id', accountId).limit(300),
    supabase.from('workspace_graph_edges').select('subject_id, source_memory_id')
      .eq('workspace_id', workspaceId).eq('object_id', accountId).eq('relationship', 'CHAMPIONS').limit(50),
  ]);
  if (error) throw new Error(`account people read failed: ${error.message}`);
  if (ce) console.warn('[detectorDrafts] champions read failed:', ce.message);
  const readable = await deps.filterByCitedClaimsForViewer(supabase, workspaceId, champs ?? [], TEAM_VIEWER, (e) => [e.source_memory_id]);
  return { people: people ?? [], championIds: readable.map((c) => c.subject_id).filter(Boolean) };
}

/** Write the ledger row's claim on this subject before spending anything. Returns the row id, or null if another run holds it. */
async function claimSubject(supabase, workspaceId, firing, state, now) {
  const d = DETECTORS[firing.automation];
  const at = new Date(now).toISOString();
  const evidence = {
    ...(state?.evidence ?? {}),
    ...originMarker(firing),
    attempt_fingerprint: firing.fingerprint, attempt_at: at,
  };
  // The ledger's fingerprint stays the last HANDLED trigger until this attempt has an outcome.
  evidence.fingerprint = state?.evidence?.fingerprint ?? null;
  if (!state) {
    const { data, error } = await supabase.from('ri_recommendations').insert({
      workspace_id: workspaceId, category: ORIGIN_CATEGORY, rec_key: recKeyOf(firing.automation),
      target_type: firing.targetType, target_id: String(firing.targetId),
      // The automation's name, alone: #606's origin lookup (lib/actionOrigin.mjs) falls back to a
      // rec's text for its name and reads evidence.why for the reason, so the inbox already says
      // "Stale deal detection · <why>" with no wiring.
      text: d.name, evidence, status: 'drafting', updated_at: at,
    }).select('id').maybeSingle();
    if (error) {
      // 23505: another run inserted it first. Anything else is a real failure.
      if (String(error.code) === '23505') return null;
      throw new Error(`ledger insert failed: ${error.message}`);
    }
    return data?.id ?? null;
  }
  // Optimistic lock on updated_at: two overlapping runs cannot both claim the same subject.
  const { data, error } = await supabase.from('ri_recommendations')
    .update({ evidence, status: 'drafting', text: d.name, updated_at: at })
    .eq('id', state.id).eq('updated_at', state.updated_at).select('id');
  if (error) throw new Error(`ledger claim failed: ${error.message}`);
  return data?.[0]?.id ?? null;
}

async function settleSubject(supabase, id, firing, prevEvidence, outcome, now, extra = {}) {
  const at = new Date(now).toISOString();
  const sameAsBefore = prevEvidence?.fingerprint === firing.fingerprint && prevEvidence?.outcome === 'failed';
  const evidence = {
    ...(prevEvidence ?? {}),
    ...originMarker(firing, { contactId: extra.contact_id ?? null }),
    fingerprint: firing.fingerprint,
    outcome, outcome_at: at,
    failures: outcome === 'failed' ? ((sameAsBefore ? prevEvidence?.failures ?? 0 : 0) + 1) : 0,
    ...extra,
  };
  delete evidence.attempt_fingerprint; delete evidence.attempt_at;
  const { error } = await supabase.from('ri_recommendations')
    .update({ evidence, status: outcome === 'drafted' ? 'drafted' : 'settled', decided_at: at, updated_at: at })
    .eq('id', id);
  if (error) throw new Error(`ledger settle failed: ${error.message}`);
}

/**
 * Draft and queue one firing. Returns { outcome, action_id?, reason? }. The ledger row must
 * already be claimed (claimSubject).
 */
async function draftOne(supabase, workspaceId, firing, ctx) {
  const { deps, members, internalIds, now } = ctx;
  const sender = await resolveSender(supabase, workspaceId, firing, members, deps);
  if (!sender) return { outcome: 'no_sender' };

  // The sender's own switches: Home's "draft follow-ups for me" (agent_prefs.home.auto_draft —
  // drafting spends credits), and anything they have ruled out for email.
  const prefs = members.find((m) => m.user_id === sender)?.agent_prefs ?? null;
  if (prefs?.home?.auto_draft === false) return { outcome: 'sender_opted_out' };
  try {
    const binding = await deps.bindingConstraints(supabase, workspaceId, { userId: sender, actionType: 'email_send', category: 'outreach' });
    if (binding.length) return { outcome: 'blocked_by_constraint' };
  } catch (e) {
    console.warn('[detectorDrafts] constraint check failed, allowing:', e?.message); // fail open, as the agent does
  }

  const { people, championIds } = await accountPeople(supabase, workspaceId, firing.accountId, deps);
  const ranked = rankRecipients(people, { rosterIds: firing.rosterIds, championIds, raisedBy: firing.raisedBy, internalIds, excludeIds: firing.excludeIds ?? [] });
  let person = null;
  let toEmail = null;
  for (const p of ranked.slice(0, 4)) {
    const e = await deps.pickRecipientEmail(supabase, workspaceId, p.id);
    if (e) { person = p; toEmail = e; break; }
  }
  if (!person) return { outcome: 'no_recipient' };

  // Never stack on a person: an email draft already waiting for them, whoever wrote it, wins.
  const { data: waiting, error: we } = await supabase.from('pending_actions').select('id')
    .eq('workspace_id', workspaceId).eq('entity_id', person.id).eq('kind', 'email').eq('status', 'pending').limit(1);
  if (we) throw new Error(`open drafts read failed: ${we.message}`);
  if (waiting?.length) return { outcome: 'recipient_has_open_draft', contact_id: person.id, existing_action_id: waiting[0].id };

  // Grounded as the sender may read it (GET-253), and team-only for the derived facts: the draft
  // is listed to every member (GET /api/actions), so it must not quote what only one rep may read.
  const readCtx = { workspaceId, viewerUserId: sender, viewerScope: 'member', openVisibility: true, teamOnly: true };
  const acc = await deps.getAccountRecord(supabase, workspaceId, person.id, readCtx);
  const claims = acc?.claims ?? {};
  const val = (k) => claims[k]?.value ?? null;
  const recipient = val('name') ?? ([val('first_name'), val('last_name')].filter(Boolean).join(' ') || personName(person));
  const context = JSON.stringify({
    recipient,
    job_title: val('job_title'),
    company: val('company') ?? firing.accountName,
    deal: firing.dealName ? { name: firing.dealName, stage: firing.trigger?.stage ?? null } : undefined,
    claims: Object.fromEntries(Object.entries(claims).slice(0, 40).map(([k, c]) => [k, c?.value ?? c])),
    facts: (acc?.facts ?? []).slice(0, 15),
    documents: (acc?.documents ?? []).slice(0, 4),
  }).slice(0, 8000);

  const profile = await deps.loadMemberProfile(supabase, workspaceId, sender);
  const memberBlock = deps.buildMemberBlock(profile, { includePrefs: false });
  ctx.onSpend?.();
  const resp = await deps.createMessage({
    feature: DRAFT_FEATURE, tier: 'writing', max_tokens: 1000,
    system: draftSystem({ memberBlock, voice: voiceFor(firing, ctx.voices) }),
    messages: [{ role: 'user', content: draftRequest(firing, { recipient, context }) }],
  });
  deps.trackLlmUsage(supabase, { workspaceId, userId: sender, feature: DRAFT_FEATURE, model: resp.model, usage: resp.usage });
  const { subject, body } = parseEmailDraft(deps.messageText(resp));
  if (!body) return { outcome: 'failed', reason: 'empty_draft' };

  const row = {
    workspace_id: workspaceId,
    user_id: sender,
    kind: 'email',
    entity_id: person.id,
    recipient,
    recipient_email: toEmail,
    subject: subject || DEFAULT_SUBJECT,
    body,
    rationale: firing.why,
    rec_id: ctx.recId,
  };
  let { data: action, error } = await supabase.from('pending_actions').insert(row).select('*').single();
  // pending_actions.rec_id was added by hand (Studio writes it; no migration in the repo). Where it
  // is missing, keep the draft the credit already paid for: the ledger still points at it by id.
  if (error && /rec_id|42703|PGRST204/i.test(`${error.message} ${error.code ?? ''}`)) {
    const { rec_id: _drop, ...rest } = row;
    ({ data: action, error } = await supabase.from('pending_actions').insert(rest).select('*').single());
  }
  if (error) return { outcome: 'failed', reason: `insert: ${error.message}` };
  await deps.mirrorDraftAsDecision(supabase, workspaceId, action, {
    actionType: 'email_send', category: 'outreach', surface: 'automation', agent: firing.automation,
    payload: originMarker(firing, { contactId: person.id }),
  });
  return { outcome: 'drafted', action_id: action.id, contact_id: person.id, sender };
}

// Everything with a side effect or a network hop, injectable so the tests can run the whole pass
// against an in-memory database and a fake model. The graph reads come from core; the model,
// metering, credits and directives are the API's own, imported lazily so a dry run (and a test)
// never registers a model client.
export const CORE_DEPS = {
  getAccountRecord, mirrorDraftAsDecision, loadDealCandidates, getRelationshipOwners,
  getInternalEntityIds, bindingConstraints, pickRecipientEmail, filterDerivedForViewer, filterByCitedClaimsForViewer,
  emailVoices: builtinEmailVoices,
};
async function apiDeps() {
  const [{ createMessage, messageText }, { trackLlmUsage }, { requireAiCredits }, { loadMemberProfile, buildMemberBlock }] = await Promise.all([
    import('./llm.mjs'), import('./llmUsage.mjs'), import('./plans.mjs'), import('./agentDirectives.mjs'),
  ]);
  return { createMessage, messageText, trackLlmUsage, requireAiCredits, loadMemberProfile, buildMemberBlock };
}

/**
 * One workspace, one pass. `dryRun` detects and plans and writes nothing — no ledger row, no
 * model call, no draft — so the plan can be read against production safely.
 */
export async function runDetectorDraftsForWorkspace(supabase, workspaceId, { now = Date.now(), dryRun = false, deps: given = null, opts = detectorOptions() } = {}) {
  let deps = { ...CORE_DEPS, ...(given ?? {}) };
  const ledger = await loadLedger(supabase, workspaceId);
  const room = Math.max(0, opts.dailyCap - draftedToday([...ledger.values()], now));
  const summary = { workspaceId, firings: 0, drafted: 0, skipped: {}, outcomes: {}, plan: [] };
  if (!room && !dryRun) { summary.skipped.daily_cap = 'reached'; return summary; }

  const actionIds = [...ledger.values()].map((r) => r.evidence?.action_id).filter(Boolean);
  const pendingActionIds = await pendingAmong(supabase, workspaceId, actionIds);
  const gateCtx = { ...opts, now, pendingActionIds };
  const gate = (f) => gateFiring(f, ledger.get(ledgerKey(f)) ?? null, gateCtx).ok;

  const { firings, internalIds } = await detectFirings(supabase, workspaceId, { now, opts, want: Math.max(room, 1), deps, gate });
  summary.firings = firings.length;
  if (!firings.length) return summary;

  // Gate only here; the cap is charged in the loop below, where a model call is made.
  const { draft, skipped } = planDrafts(firings, ledger, { ...gateCtx, dailyCap: undefined });
  for (const s of skipped) summary.skipped[s.reason] = (summary.skipped[s.reason] ?? 0) + 1;
  if (dryRun) {
    summary.room = room;
    summary.plan = draft.map((f) => ({ automation: f.automation, target: `${f.targetType}:${f.targetId}`, account: f.accountName, why: f.why }));
    return summary;
  }
  if (!draft.length) return summary;

  if (!given?.createMessage) deps = { ...(await apiDeps()), ...deps };
  // Credits: the same hard gate every AI action uses, once, before the first model call.
  const credit = await deps.requireAiCredits(supabase, workspaceId);
  if (!credit.ok) { summary.skipped.credits = draft.length; return summary; }

  let { data: members, error: me } = await supabase.from('workspace_members')
    .select('user_id, agent_prefs, created_at').eq('workspace_id', workspaceId).order('created_at', { ascending: true });
  // agent_prefs is a hand-applied column (home.mjs reads it); without it nobody has opted out.
  if (me && /agent_prefs|42703|PGRST204/i.test(`${me.message} ${me.code ?? ''}`)) {
    ({ data: members, error: me } = await supabase.from('workspace_members')
      .select('user_id, created_at').eq('workspace_id', workspaceId).order('created_at', { ascending: true }));
  }
  if (me) throw new Error(`members read failed: ${me.message}`);
  if (!members?.length) { summary.skipped.no_members = draft.length; return summary; }
  // The team's email voice per built-in (GET-902), read once for the pass. Unreadable: none, and the
  // drafts read as they always did.
  let voices = new Map();
  try { voices = (await deps.emailVoices?.(supabase, workspaceId)) ?? new Map(); }
  catch (e) { console.warn('[detectorDrafts] email voice unreadable:', e?.message); }

  // The day's cap is charged where a model call is made. A firing that ends before one (nobody to
  // write to, a draft already waiting, the sender opted out) costs nothing and takes no slot.
  let spent = 0;
  for (const firing of draft) {
    if (spent >= room) { summary.skipped.daily_cap = (summary.skipped.daily_cap ?? 0) + 1; continue; }
    const state = ledger.get(ledgerKey(firing)) ?? null;
    const recId = await claimSubject(supabase, workspaceId, firing, state, now);
    if (!recId) { summary.skipped.in_progress = (summary.skipped.in_progress ?? 0) + 1; continue; }
    const prev = { ...(state?.evidence ?? {}), attempt_fingerprint: firing.fingerprint };
    let r;
    try {
      r = await draftOne(supabase, workspaceId, firing, { deps, members, internalIds, now, recId, voices, onSpend: () => { spent += 1; } });
    } catch (e) {
      console.error('[detectorDrafts] draft failed', workspaceId, firing.automation, firing.targetId, e?.message);
      r = { outcome: 'failed', reason: String(e?.message ?? e).slice(0, 200) };
    }
    const extra = {};
    if (r.action_id) { extra.action_id = r.action_id; extra.drafted_at = new Date(now).toISOString(); }
    if (r.contact_id) extra.contact_id = r.contact_id;
    if (r.reason) extra.reason = r.reason;
    try { await settleSubject(supabase, recId, firing, prev, r.outcome, now, extra); }
    catch (e) {
      // The row stays 'drafting' and holds the subject for an hour; the person-level check (a draft
      // already waiting for them) stops a second one after that.
      console.error('[detectorDrafts] ledger settle failed', workspaceId, firing.automation, firing.targetId, e?.message);
    }
    summary.outcomes[r.outcome] = (summary.outcomes[r.outcome] ?? 0) + 1;
    if (r.outcome === 'drafted') summary.drafted += 1;
  }
  return summary;
}

/**
 * The staged rollout: which workspaces the pass may draft for, from DETECTOR_DRAFTS_WORKSPACES
 * (comma-separated workspace ids, or "*" for all). Unset or empty = none — nothing is detected
 * to draft and no model is called anywhere until a workspace is listed. Pure.
 * @returns {'*' | Set<string>}
 */
export function allowedWorkspaces(raw = process.env.DETECTOR_DRAFTS_WORKSPACES) {
  const ids = String(raw ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (ids.includes('*')) return '*';
  return new Set(ids);
}
const isAllowed = (allow, ws) => allow === '*' || allow.has(ws);

/**
 * Every allowlisted workspace (or one), sequentially. One workspace failing never stops the rest.
 * A dry run for one named workspace ignores the allowlist: it writes nothing and calls no model,
 * so a workspace can be previewed before it is turned on.
 */
export async function runDetectorDrafts({ supabase = getSupabaseClient(), onlyWorkspace = null, dryRun = false, now = Date.now(), deps = null, opts = detectorOptions(), allow = allowedWorkspaces(), only = null } = {}) {
  if (only?.length) opts = { ...opts, only };
  let ids;
  if (onlyWorkspace) {
    if (!(dryRun || isAllowed(allow, onlyWorkspace))) {
      return { workspaces: 0, drafted: 0, errors: 0, results: [{ workspaceId: onlyWorkspace, skipped: 'not_allowlisted' }] };
    }
    ids = [onlyWorkspace];
  } else if (allow !== '*' && !allow.size) {
    ids = [];
  } else {
    ids = (await pageAll((from, to) => supabase.from('workspaces').select('id').order('id').range(from, to)))
      .map((w) => w.id).filter((ws) => isAllowed(allow, ws));
  }
  const results = [];
  for (const ws of ids) {
    try { results.push(await runDetectorDraftsForWorkspace(supabase, ws, { now, dryRun, deps, opts })); }
    catch (e) {
      console.error('[detectorDrafts] workspace failed', ws, e?.message);
      results.push({ workspaceId: ws, error: String(e?.message ?? e).slice(0, 300) });
    }
  }
  return {
    workspaces: ids.length,
    drafted: results.reduce((n, r) => n + (r.drafted ?? 0), 0),
    errors: results.filter((r) => r.error).length,
    results: dryRun || onlyWorkspace ? results : results.filter((r) => r.drafted || r.error),
  };
}
