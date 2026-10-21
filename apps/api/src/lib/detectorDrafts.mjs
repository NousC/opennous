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
  TEAM_VIEWER, emailVoiceBlock, touchDirection, REPLY_TOUCH_PROPERTIES, quietOpenDeals, staleDealFiring } from '@nous/core';
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
 * A next step or a budget mention is information, not a reason to write. A new stakeholder is
 * one only when they decide (GET-944): a decision maker or economic buyer named on the call is
 * someone to bring in, through whoever named them (the warm path). A champion or a blocker is
 * not: the first is already in the room, the second is not someone to ask for.
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
  stakeholder_identified: {
    rank: 4, label: 'Stakeholder identified',
    roles: ['decision_maker', 'economic_buyer'],
    why: (s) => `${ROLE_LABEL[s.detail?.role] ?? 'A decision maker'} identified`,
    prompt: 'Someone with a say in this decision just came up, and they are not in the conversation yet. Write to the recipient, who is already in it: in one or two lines, ask them to bring that person into the next call, and say why it helps them (the decision moves faster when the person who signs off has heard it first-hand). Name the person if you know their name. Never write as if you know them, and never ask the recipient for an introduction to a stranger: they are the recipient\'s own colleague.',
  },
};
const ROLE_LABEL = { decision_maker: 'Decision maker', economic_buyer: 'Economic buyer' };
// A next step that went wrong (GET-954 detects it, GET-956 plays it). The agreed step itself is a task,
// not a signal; it becomes one when its date passes with nothing done, or when it keeps moving.
Object.assign(DEAL_SIGNALS, {
  next_step_missed: {
    rank: 5, label: 'Next step missed',
    why: (s) => `Next step missed: ${s.title || 'an agreed step'}${s.detail?.due_at ? `, due ${dayLabel(s.detail.due_at)}` : ''}`,
    prompt: 'An agreed next step passed its date and nothing has happened since. If the step was ours (see the owner), own it in one line and either deliver it now or give a firm new date. If it was theirs, check in kindly: name the step and the date it was due, ask whether it is still on, and offer to help it along. Two or three lines, no guilt.',
  },
  next_step_slipped: {
    rank: 6, label: 'Next step slipped',
    why: (s) => `Next step pushed ${s.detail?.pushes ?? 2} times: ${s.title || 'an agreed step'}`,
    prompt: 'The buyer has pushed the same next step more than once. Confirm the step in one line, ask what is in the way, and propose one firm date (or a short call to unblock it). Friendly and direct; never sound annoyed about the delays.',
  },
});
// Product signals from PostHog (GET-751): a reason to write that needs no open deal, because the
// product found the opening before sales did. Ranked after the deal signals.
Object.assign(DEAL_SIGNALS, {
  product_qualified: {
    rank: 7, label: 'Product-qualified', noDealNeeded: true,
    why: (s) => `Product-qualified: ${s.detail?.active_users_30d ?? 'several'} people using the product`,
    prompt: 'Several people at this account now use the product on their own. Write to the most engaged of them: say you noticed the team is using it, ask in one line what they are using it for, and offer a short call on rolling it out to the rest of the team. Helpful, not salesy; never mention tracking or analytics.',
  },
  seats_growing: {
    rank: 8, label: 'Seats growing', noDealNeeded: true,
    why: (s) => `More people using the product: ${s.detail?.active_users_prev_30d ?? '?'} to ${s.detail?.active_users_30d ?? '?'}`,
    prompt: 'More people at this account are using the product than a month ago. Write to the main contact: acknowledge the team is growing into it, ask what changed, and offer the plan or setup that fits a bigger team, with one concrete next step. Never mention tracking or analytics.',
  },
  account_inactive: {
    rank: 9, label: 'Account inactive', noDealNeeded: true,
    why: (s) => `Stopped using the product${s.detail?.days_inactive ? ` ${s.detail.days_inactive} days ago` : ''}`,
    prompt: 'This account has stopped using the product. Write to the main contact: a short, kind check-in that asks whether something got in the way and offers to help them get value from it again, with one easy next step. Never mention tracking or analytics, and never guilt.',
  },
});

// Run order when the day's cap is short: a customer in trouble first, an opening next, a quiet
// deal last (there are many more of those, and they keep).
export const DETECTOR_ORDER = ['deal_risk', 'deal_signal', 'expansion_signal', 'stale_deal'];

export const recKeyOf = (key) => `automation.${key}`;

/**
 * The detectors whose drafts are a signal's next move (GET-953): listed under From signals, snoozed,
 * tracked after Send and nudged once (GET-949). Stale deals are not a signal anyone raised.
 */
export const SIGNAL_DETECTORS = ['deal_signal', 'deal_risk', 'expansion_signal'];
export const SIGNAL_REC_KEYS = new Set(SIGNAL_DETECTORS.map(recKeyOf));

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

// The stale-deal rule (quietOpenDeals, staleDealFiring) lives in core since GET-950, so the
// deal.stalled event and this automation read a stale deal the same way.
export { quietOpenDeals, staleDealFiring };

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
        // What the From signals pane reads back (GET-953), as for a deal signal.
        kind: category === 'risk_signal' ? 'churn_risk' : 'expansion_signal',
        label: category === 'risk_signal' ? 'Churn risk' : 'Expansion signal',
        quote: m.quote ? clipText(m.quote, 300) : null, speaker: m.speaker ? String(m.speaker) : null,
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
export function dealSignalFirings(rows, { now = Date.now(), lookbackDays = 7, names = new Map(), domains = new Map() } = {}) {
  const best = new Map();
  for (const s of rows ?? []) {
    const def = DEAL_SIGNALS[s?.kind];
    if (!def || !s.account_id || s.team_readable !== true) continue;
    if (def.roles && !def.roles.includes(s.detail?.role)) continue;
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
      trigger: {
        signal_id: s.id, kind: s.kind, label: def.label, said_at: s.occurred_at, text: clipText(text, 400),
        // What the inbox's From signals pane reads back (GET-944): who said it, in their words.
        quote: s.quote ? clipText(s.quote, 300) : null, speaker: s.speaker ? String(s.speaker) : null,
        role: s.detail?.role ?? null, domain: domains.get(accountId) ?? null,
        // A next step's own facts (GET-956): what it is, who owned it, when it was due, how often it moved.
        ...(s.kind.startsWith('next_step_') ? {
          step: s.title ?? null, owner: s.detail?.owner ?? null, due_at: s.detail?.due_at ?? null,
          ...(s.detail?.pushes ? { pushes: s.detail.pushes, first_due_at: s.detail.first_due_at ?? null } : {}),
        } : {}),
      },
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
// already_handled: the person a play would bring in has been in touch since the signal (GET-944).
export const HANDLED_OUTCOMES = new Set(['drafted', 'no_recipient', 'already_handled']);

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
 * Is this contact the person the research named (GET-944)? Stricter than a speaker label: the
 * research gives a full name, so the last names must agree, and the first names too, or one be
 * the short form of the other (Bob / Robert). Middle names and initials are ignored. A one-word
 * name never matches: "Andrew" is not a person. Pure.
 */
export function researchedNameMatches(person, name) {
  const tokens = (s) => norm(s).split(' ').filter((t) => t.length > 1);
  const n = tokens(name);
  const p = tokens(fullName(person));
  if (n.length < 2 || p.length < 2) return false;
  if (n[n.length - 1] !== p[p.length - 1]) return false;
  const [a, b] = [n[0], p[0]];
  return a === b || (a.length >= 3 && b.length >= 3 && a.slice(0, 3) === b.slice(0, 3));
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

/** What the play found out about the person a signal named (GET-944), as the brief says it. Pure. */
export function researchLine(r) {
  if (!r?.name) return null;
  const who = [r.name, r.title].filter(Boolean).join(', ');
  return `Who that person is (researched${r.source_url ? `, source ${r.source_url}` : ''}): ${who}${r.contact_id ? ' (already a contact on this account)' : ''}`;
}

/** The next step a missed or slipped signal is about (GET-956), as the brief says it. Pure. */
export function stepLine(t) {
  if (!t?.step) return null;
  return [`The next step: ${t.step}`, t.owner ? `owner: ${t.owner}` : null, t.due_at ? `due ${dayLabel(t.due_at)}` : null,
    t.pushes ? `pushed ${t.pushes} times (first due ${dayLabel(t.first_due_at)})` : null].filter(Boolean).join('; ');
}

/** The model's user turn for one draft. Pure. */
export function draftRequest(firing, { recipient, context }) {
  const d = DETECTORS[firing.automation];
  return [
    `Recipient: ${recipient}`,
    `Why you are writing (OpenNous noticed this): ${firing.why}`,
    firing.quote ? `What they said, in their words: "${firing.quote}"` : null,
    researchLine(firing.trigger?.research),
    stepLine(firing.trigger),
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
  const domains = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabase.from('companies').select('id, name, domain')
      .eq('workspace_id', workspaceId).in('id', ids.slice(i, i + 100));
    if (error) throw new Error(`accounts read failed: ${error.message}`);
    for (const c of data ?? []) { names.set(c.id, c.name ?? null); domains.set(c.id, c.domain ?? null); }
  }
  return dealSignalFirings(rows.filter((r) => names.has(r.account_id)), { now, lookbackDays, names, domains });
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
    && (f.automation === 'stale_deal' || !hasSpine
      || (f.automation === 'deal_signal' ? openOn.has(f.accountId) || DEAL_SIGNALS[f.trigger?.kind]?.noDealNeeded === true : working.has(f.accountId)));
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

/**
 * Who the person a stakeholder signal named is (GET-944): the research hook's answer (Cloud's web
 * search, registerSignalResearch), matched against the account's contacts. Writes the finding onto
 * the firing's trigger, so the ledger, the draft's origin and the inbox read it back. Returns the
 * matching contact, or null. Research that fails leaves the play drafting from the graph alone.
 */
async function researchStakeholder(supabase, workspaceId, firing, people, deps, cached) {
  // One search per signal: a retry of the same trigger (a draft already waiting for the recipient,
  // a sender who switched drafting off) reuses what the ledger kept, found or not.
  let found = cached !== undefined ? cached : null;
  if (cached === undefined && deps.signalResearch) {
    try { found = await deps.signalResearch(supabase, workspaceId, { firing, people }); }
    catch (e) { console.warn('[detectorDrafts] signal research failed:', e?.message); }
    firing.trigger = { ...firing.trigger, research: found?.name ? found : { name: null } };
  }
  if (!found?.name) return null;
  const known = (people ?? []).find((p) => researchedNameMatches(p, found.name)) ?? null;
  firing.trigger = { ...firing.trigger, research: { ...found, contact_id: known?.id ?? null } };
  return known;
}

// A conversation with them that started this long after the signal was said is one the play did
// not need to bring about. The slack keeps the call the signal came from (it ends after it was said) out.
const HANDLED_SLACK_MS = 12 * 3600_000;

/** In a conversation since the signal was said: the play has nothing to bring about. Pure. */
export function isAlreadyHandled(person, saidAt) {
  // Their own conversations only: last_activity_at also moves on a CRM sync or our own outbound.
  const touched = Date.parse(person?.last_interaction_at ?? '');
  const said = Date.parse(saidAt ?? '');
  return Number.isFinite(touched) && Number.isFinite(said) && touched > said + HANDLED_SLACK_MS;
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
  // A snooze was on the last draft (GET-944); a new draft starts awake.
  // A new draft is a new case (GET-949): the last one's tracking stays with the last one.
  if (outcome === 'drafted') { delete evidence.snoozed_until; delete evidence.snoozed_action_id; delete evidence.tracking; }
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
  // A play that brings someone in (GET-944): find out who they are, and stop if they are already in.
  let excludeIds = firing.excludeIds ?? [];
  if (firing.trigger?.kind === 'stakeholder_identified') {
    const known = await researchStakeholder(supabase, workspaceId, firing, people, deps, ctx.cachedResearch);
    if (known && isAlreadyHandled(known, firing.trigger.said_at)) return { outcome: 'already_handled', contact_id: known.id };
    if (known) excludeIds = [...excludeIds, known.id];
  }
  const ranked = rankRecipients(people, { rosterIds: firing.rosterIds, championIds, raisedBy: firing.raisedBy, internalIds, excludeIds });
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
    meter: false,
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

// ─── After Send: did the signal's move work? (GET-949) ──────────────────────────────
//
// A Deal signals draft that was sent is tracked on its ledger row (evidence.tracking):
//   moved    the recipient answered (any inbound message), a meeting with them was held or
//            booked, or, for a stakeholder play, the person it set out to bring in showed up in
//            any conversation. The case closes and says how.
//   nudged   nothing moved in NUDGE_DAYS: one short follow-up is drafted to the same person and
//            lands in From signals again. One nudge per case, never a loop.
//   quiet    the nudge was sent and nothing moved in another NUDGE_DAYS: the case closes.
// A nudge that is skipped (Not relevant) closes the case too.

export const NUDGE_DAYS = 5;
const MEETING_TOUCHES = new Set(['interaction.meeting_held', 'interaction.meeting_scheduled', 'interaction.meeting_booked', 'interaction.call_held']);
const TRACK_TOUCHES = [...new Set([...REPLY_TOUCH_PROPERTIES, ...MEETING_TOUCHES])];

/**
 * Where a sent move stands. Pure.
 * @param touches observations: { entity_id, property, observed_at, is_outbound, source }
 * @returns {{ state: 'moved', how: 'replied'|'meeting'|'joined', at } | { state: 'due' } | { state: 'waiting' }}
 */
export function trackMove({ sentAt, dueFrom = null, recipientId, joinerId = null, touches = [], now = Date.now(), days = NUDGE_DAYS }) {
  const since = Date.parse(sentAt ?? '');
  if (!Number.isFinite(since)) return { state: 'waiting' };
  const after = (touches ?? []).filter((t) => Date.parse(t.observed_at ?? '') > since && t.source !== 'motion')
    .sort((a, b) => String(a.observed_at).localeCompare(String(b.observed_at)));
  for (const t of after) {
    if (joinerId && t.entity_id === joinerId) return { state: 'moved', how: 'joined', at: t.observed_at };
    if (t.entity_id !== recipientId) continue;
    if (MEETING_TOUCHES.has(t.property)) return { state: 'moved', how: 'meeting', at: t.observed_at };
    if (touchDirection(t) === 'in') return { state: 'moved', how: 'replied', at: t.observed_at };
  }
  const from = Date.parse(dueFrom ?? '') || since;
  return now - from >= days * DAY ? { state: 'due' } : { state: 'waiting' };
}

/** The model's turn for a nudge: the email that went unanswered, and the one-line ask. Pure. */
export function nudgeRequest(action, { days = NUDGE_DAYS } = {}) {
  return [
    `Recipient: ${action.recipient ?? 'there'}`,
    `You emailed them ${days} days ago and heard nothing back. Write a short follow-up: two or three lines, no guilt, restate the one ask in plain words, make it easy to say yes. Do not repeat the first email.`,
    '',
    `The first email (subject "${action.subject ?? ''}"):`,
    String(action.body ?? '').slice(0, 3000),
  ].join('\n');
}

const reSubject = (s) => (/^re:/i.test(String(s ?? '').trim()) ? String(s).trim() : `Re: ${String(s ?? '').trim() || DEFAULT_SUBJECT}`);

async function loadActions(supabase, workspaceId, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabase.from('pending_actions')
      .select('id, user_id, kind, entity_id, recipient, recipient_email, subject, body, status, decided_at, created_at')
      .eq('workspace_id', workspaceId).in('id', ids.slice(i, i + 100));
    if (error) throw new Error(`signal drafts read failed: ${error.message}`);
    for (const a of data ?? []) out.set(a.id, a);
  }
  return out;
}

async function loadTouches(supabase, workspaceId, entityIds, since) {
  const ids = [...new Set(entityIds.filter(Boolean))];
  const rows = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabase.from('observations')
      .select('entity_id, property, observed_at, source, is_outbound:raw->is_outbound')
      .eq('workspace_id', workspaceId).in('entity_id', ids.slice(i, i + 100))
      .in('property', TRACK_TOUCHES).gte('observed_at', since)
      .order('observed_at', { ascending: false }).limit(1000);
    if (error) throw new Error(`touches read failed: ${error.message}`);
    rows.push(...(data ?? []));
  }
  return rows;
}

async function setTracking(supabase, rec, patch, now) {
  const at = new Date(now).toISOString();
  const evidence = { ...(rec.evidence ?? {}), ...patch, tracking: { ...(rec.evidence?.tracking ?? {}), ...(patch.tracking ?? {}), updated_at: at } };
  // Optimistic lock on updated_at, as claimSubject: of two overlapping passes only one writes.
  const { data, error } = await supabase.from('ri_recommendations').update({ evidence, updated_at: at })
    .eq('id', rec.id).eq('updated_at', rec.updated_at).select('id');
  if (error) throw new Error(`tracking write failed: ${error.message}`);
  if (!data?.length) return false;
  rec.evidence = evidence; rec.updated_at = at;
  return true;
}

// The ledger fields that are the case's bookkeeping, not its origin: never copied onto a nudge's decision.
const BOOKKEEPING = ['action_id', 'outcome', 'outcome_at', 'failures', 'tracking', 'attempt_fingerprint', 'attempt_at', 'reason', 'drafted_at', 'snoozed_until', 'snoozed_action_id', 'existing_action_id'];

/**
 * May this nudge be written now, by the first draft's sender? The same gates a first draft passes
 * (draftOne): still a member, drafting not switched off, no rule against email outreach, no email
 * already waiting for the person. Returns null when it may, else the reason.
 */
async function nudgeBlocked(supabase, workspaceId, first, deps, members) {
  const m = members.find((x) => x.user_id === first.user_id);
  if (!m) return 'no_sender';
  if (m.agent_prefs?.home?.auto_draft === false) return 'sender_opted_out';
  try {
    const binding = await deps.bindingConstraints(supabase, workspaceId, { userId: first.user_id, actionType: 'email_send', category: 'outreach' });
    if (binding.length) return 'blocked_by_constraint';
  } catch (e) {
    console.warn('[detectorDrafts] constraint check failed, allowing:', e?.message);
  }
  const { data: waiting, error } = await supabase.from('pending_actions').select('id')
    .eq('workspace_id', workspaceId).eq('entity_id', first.entity_id).eq('kind', 'email').eq('status', 'pending').limit(1);
  if (error) throw new Error(`open drafts read failed: ${error.message}`);
  if (waiting?.length) return 'recipient_has_open_draft';
  return null;
}

/** Draft the one nudge for a case. Returns the new action, or null when it could not be drafted. */
async function draftNudge(supabase, workspaceId, rec, first, deps, voices) {
  // (The caller has claimed the case and checked nudgeBlocked.)
  const profile = await deps.loadMemberProfile(supabase, workspaceId, first.user_id);
  const memberBlock = deps.buildMemberBlock(profile, { includePrefs: false });
  const resp = await deps.createMessage({
    meter: false,
    feature: DRAFT_FEATURE, tier: 'writing', max_tokens: 600,
    system: draftSystem({ memberBlock, voice: voiceFor({ automation: rec.rec_key.replace(/^automation\./, '') }, voices) }),
    messages: [{ role: 'user', content: nudgeRequest(first) }],
  });
  deps.trackLlmUsage(supabase, { workspaceId, userId: first.user_id, feature: DRAFT_FEATURE, model: resp.model, usage: resp.usage });
  const { body } = parseEmailDraft(deps.messageText(resp));
  if (!body) return null;
  const row = {
    workspace_id: workspaceId, user_id: first.user_id, kind: 'email', entity_id: first.entity_id,
    recipient: first.recipient, recipient_email: first.recipient_email, subject: reSubject(first.subject), body,
    rationale: `No reply in ${NUDGE_DAYS} days to "${first.subject ?? 'your email'}"`, rec_id: rec.id,
  };
  let { data: action, error } = await supabase.from('pending_actions').insert(row).select('*').single();
  // pending_actions.rec_id is hand-applied (see draftOne): without it the nudge cannot point at its case.
  if (error && /rec_id|42703|PGRST204/i.test(`${error.message} ${error.code ?? ''}`)) return { blocked: 'no_rec_id' };
  if (error) throw new Error(`nudge insert failed: ${error.message}`);
  return action;
}

/**
 * Track every sent Deal signals move in the workspace: close the ones that moved, nudge the ones
 * that went quiet, close a nudge that went quiet too. `room` is how many model calls the day's cap
 * still allows. Returns { moved, nudged, quiet, waiting, spent }.
 */
export async function trackSignalMoves(supabase, workspaceId, { ledger, now = Date.now(), loadDeps, room = Infinity, loadVoices = async () => null }) {
  const out = { moved: 0, nudged: 0, quiet: 0, waiting: 0, spent: 0 };
  const open = [...ledger.values()].filter((r) => SIGNAL_REC_KEYS.has(r.rec_key) && r.evidence?.action_id
    && r.evidence?.outcome === 'drafted' && !CLOSED.has(r.evidence?.tracking?.state));
  if (!open.length) return out;
  const actions = await loadActions(supabase, workspaceId,
    open.flatMap((r) => [r.evidence.action_id, r.evidence.tracking?.first_action_id]).filter(Boolean));
  const firstOf = ({ rec, action }) => actions.get(rec.evidence?.tracking?.first_action_id) ?? action;
  const cases = open.map((rec) => ({ rec, action: actions.get(rec.evidence.action_id) })).filter(({ action }) => action);
  const at = new Date(now).toISOString();

  // Closed without a send: the first draft skipped or failed (the case never started), or the
  // nudge skipped or failed (the case ends there). Neither is tracked again.
  for (const c of cases.filter(({ action }) => ['rejected', 'failed'].includes(action.status))) {
    const nudged = c.rec.evidence?.tracking?.state === 'nudged';
    const state = nudged ? 'quiet' : 'skipped';
    const reason = `${nudged ? 'nudge' : 'draft'}_${c.action.status === 'rejected' ? 'skipped' : 'failed'}`;
    try { if (await setTracking(supabase, c.rec, { tracking: { state, reason, closed_at: at } }, now)) out.quiet += nudged ? 1 : 0; }
    catch (e) { console.error('[detectorDrafts] tracking failed', workspaceId, c.rec.id, e?.message); }
  }

  const live = cases.filter(({ action }) => action.status === 'sent');
  if (!live.length) return out;
  const since = live.map((x) => { const f = firstOf(x); return f.decided_at ?? f.created_at; }).sort()[0];
  const touches = await loadTouches(supabase, workspaceId,
    live.flatMap(({ rec, action }) => [action.entity_id, rec.evidence?.trigger?.research?.contact_id]), since);
  let deps = null;
  let members = null;
  let credited = null;
  for (const c of live) {
    const { rec, action } = c;
    const nudged = rec.evidence?.tracking?.state === 'nudged';
    try {
      // Anything since the FIRST send counts as the move; the quiet window runs from the latest send.
      const first = firstOf(c);
      const t = trackMove({
        sentAt: first.decided_at ?? first.created_at, dueFrom: action.decided_at ?? action.created_at,
        recipientId: action.entity_id, joinerId: rec.evidence?.trigger?.research?.contact_id ?? null, touches, now,
      });
      if (t.state === 'moved') {
        if (await setTracking(supabase, rec, { tracking: { state: 'moved', how: t.how, at: t.at, closed_at: at } }, now)) out.moved += 1;
        continue;
      }
      if (t.state !== 'due') { out.waiting += 1; continue; }
      if (nudged) {
        if (await setTracking(supabase, rec, { tracking: { state: 'quiet', reason: 'no_reply', closed_at: at } }, now)) out.quiet += 1;
        continue;
      }
      if (out.spent >= room) { out.waiting += 1; continue; }
      deps ??= await loadDeps();
      members ??= await loadMembers(supabase, workspaceId);
      const blocked = await nudgeBlocked(supabase, workspaceId, action, deps, members);
      if (blocked) {
        // Nothing to write today. The person already has a draft waiting or the sender switched
        // drafting off: look again next pass, at no cost. Anything else closes the case.
        if (blocked === 'recipient_has_open_draft' || blocked === 'sender_opted_out') { out.waiting += 1; continue; }
        if (await setTracking(supabase, rec, { tracking: { state: 'quiet', reason: blocked, closed_at: at } }, now)) out.quiet += 1;
        continue;
      }
      credited ??= await deps.requireAiCredits(supabase, workspaceId);
      if (!credited.ok) { out.waiting += 1; continue; }
      // Claim the case before spending: of two overlapping passes only one drafts the nudge.
      if (!(await setTracking(supabase, rec, { tracking: { state: 'nudging', first_action_id: action.id, claimed_at: at } }, now))) continue;
      out.spent += 1;
      let nudge = null;
      try { nudge = await draftNudge(supabase, workspaceId, rec, action, deps, await loadVoices()); }
      catch (e) { console.error('[detectorDrafts] nudge failed', workspaceId, rec.id, e?.message); }
      if (!nudge?.id) {
        // One try per case: a nudge that cannot be written closes the case rather than paying again every hour.
        await setTracking(supabase, rec, { tracking: { state: 'quiet', reason: nudge?.blocked ?? 'nudge_failed', closed_at: at } }, now);
        out.quiet += 1;
        continue;
      }
      await setTracking(supabase, rec, {
        action_id: nudge.id, drafted_at: at,
        tracking: { state: 'nudged', first_action_id: action.id, nudge_action_id: nudge.id, nudged_at: at },
      }, now);
      out.nudged += 1;
      try {
        const payload = Object.fromEntries(Object.entries(rec.evidence ?? {}).filter(([k]) => !BOOKKEEPING.includes(k)));
        await deps.mirrorDraftAsDecision(supabase, workspaceId, nudge, {
          actionType: 'email_send', category: 'outreach', surface: 'automation', agent: rec.rec_key.replace(/^automation\./, ''),
          payload: { ...payload, contact_id: action.entity_id, nudge: true },
        });
      } catch (e) {
        console.warn('[detectorDrafts] nudge decision mirror failed:', e?.message);
      }
    } catch (e) {
      console.error('[detectorDrafts] tracking failed', workspaceId, rec.id, e?.message);
    }
  }
  return out;
}

const CLOSED = new Set(['moved', 'quiet', 'skipped']);

async function loadMembers(supabase, workspaceId) {
  let { data, error } = await supabase.from('workspace_members').select('user_id, agent_prefs').eq('workspace_id', workspaceId);
  // agent_prefs is hand-applied (see the pass below); without it nobody has opted out.
  if (error && /agent_prefs|42703|PGRST204/i.test(`${error.message} ${error.code ?? ''}`)) {
    ({ data, error } = await supabase.from('workspace_members').select('user_id').eq('workspace_id', workspaceId));
  }
  if (error) throw new Error(`members read failed: ${error.message}`);
  return data ?? [];
}

// Everything with a side effect or a network hop, injectable so the tests can run the whole pass
// against an in-memory database and a fake model. The graph reads come from core; the model,
// metering, credits and directives are the API's own, imported lazily so a dry run (and a test)
// never registers a model client.
export const CORE_DEPS = {
  getAccountRecord, mirrorDraftAsDecision, loadDealCandidates, getRelationshipOwners,
  getInternalEntityIds, bindingConstraints, pickRecipientEmail, filterDerivedForViewer, filterByCitedClaimsForViewer,
  // The team's email voice per built-in (GET-902): Cloud's (registerEmailVoices), none without it.
  emailVoices: null,
  // Who a stakeholder signal named (GET-944): Cloud's web research (registerSignalResearch), none without it.
  signalResearch: null,
};
/** Where the built-in drafters' email voices come from (GET-910): (supabase, workspaceId) -> Map(key -> { text }). */
export function registerEmailVoices(fn) { CORE_DEPS.emailVoices = fn ?? null; }
/**
 * Where a stakeholder play's research comes from (GET-944):
 * (supabase, workspaceId, { firing, people }) -> { name, title, source_url, source_title } | null.
 */
export function registerSignalResearch(fn) { CORE_DEPS.signalResearch = fn ?? null; }
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
  // After Send (GET-949): the sent signal moves are tracked first, on the Deal signals pass. A nudge
  // is a model call, so it shares the day's cap with the drafts below.
  // The team's email voice per built-in (GET-902), read at most once for the pass, when a draft
  // needs it. Unreadable: none, and the drafts read as they always did.
  let voicesP = null;
  const loadVoices = () => (voicesP ??= Promise.resolve().then(() => deps.emailVoices?.(supabase, workspaceId))
    .then((v) => v ?? new Map(), (e) => { console.warn('[detectorDrafts] email voice unreadable:', e?.message); return new Map(); }));
  let room2 = room;
  if (!dryRun && (!opts.only || opts.only.includes('deal_signal'))) {
    // The model client loads only when a nudge is actually due.
    const loadDeps = async () => (given?.createMessage ? deps : { ...(await apiDeps()), ...deps });
    summary.tracking = await trackSignalMoves(supabase, workspaceId, { ledger, now, loadDeps, room, loadVoices });
    room2 = Math.max(0, room - summary.tracking.spent);
  }
  if (!room2 && !dryRun) { summary.skipped.daily_cap = 'reached'; return summary; }

  const actionIds = [...ledger.values()].map((r) => r.evidence?.action_id).filter(Boolean);
  const pendingActionIds = await pendingAmong(supabase, workspaceId, actionIds);
  const gateCtx = { ...opts, now, pendingActionIds };
  const gate = (f) => gateFiring(f, ledger.get(ledgerKey(f)) ?? null, gateCtx).ok;

  const { firings, internalIds } = await detectFirings(supabase, workspaceId, { now, opts, want: Math.max(room2, 1), deps, gate });
  summary.firings = firings.length;
  if (!firings.length) return summary;

  // Gate only here; the cap is charged in the loop below, where a model call is made.
  const { draft, skipped } = planDrafts(firings, ledger, { ...gateCtx, dailyCap: undefined });
  for (const s of skipped) summary.skipped[s.reason] = (summary.skipped[s.reason] ?? 0) + 1;
  if (dryRun) {
    summary.room = room2;
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
  const voices = await loadVoices();

  // The day's cap is charged where a model call is made. A firing that ends before one (nobody to
  // write to, a draft already waiting, the sender opted out) costs nothing and takes no slot.
  let spent = 0;
  for (const firing of draft) {
    if (spent >= room2) { summary.skipped.daily_cap = (summary.skipped.daily_cap ?? 0) + 1; continue; }
    const state = ledger.get(ledgerKey(firing)) ?? null;
    const recId = await claimSubject(supabase, workspaceId, firing, state, now);
    if (!recId) { summary.skipped.in_progress = (summary.skipped.in_progress ?? 0) + 1; continue; }
    const prev = { ...(state?.evidence ?? {}), attempt_fingerprint: firing.fingerprint };
    let r;
    try {
      // The same trigger's research, kept on the ledger from an earlier attempt (GET-944).
      const cachedResearch = state?.evidence?.fingerprint === firing.fingerprint ? state.evidence.trigger?.research : undefined;
      r = await draftOne(supabase, workspaceId, firing, { deps, members, internalIds, now, recId, voices, cachedResearch, onSpend: () => { spent += 1; } });
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
