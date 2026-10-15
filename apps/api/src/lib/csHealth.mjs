// The three questions Customer Success actually asks, and the evidence for each answer.
//
//   Active customers       — who is paying us right now
//   Expansion opportunities — who can be sold more, and why we think so
//   At risk                — who we are about to lose, and why we think so
//
// Every "why" on this page is a fact somebody else already recorded. Two sources, and no third:
//
//   1. The CRM's own account-health fields, read by the sync into the `cs.*` vocabulary
//      (packages/core/src/integrations/crm/accountHealth.ts). Account status, MRR, product usage,
//      the customer's own churn model, the priced upgrade their ops team already scoped.
//   2. The conversation layer — what was said on a call or in an email, and when anyone last
//      spoke to them. This is the half a CRM does not have.
//
// Nous computes no health score of its own and writes nothing back. A reason a rep cannot open
// the CRM and verify is a reason that does not ship.
//
// WHY THE OLD DEFINITIONS WERE REPLACED:
//
//   "a customer is an account with a won deal"  → counts every account that ever bought, including
//                                                 the many that have since CANCELLED.
//   "at risk is nobody emailed them in 90 days" → most customers are emailed often, so the list
//                                                 stays mostly empty, while a Client with ZERO
//                                                 active users in 30 days keeps paying unnoticed.
//   "expansion is they have an open deal"       → mostly ordinary NEW BUSINESS deals in the sales
//                                                 pipeline, while Clients carrying a priced
//                                                 upgrade nobody has raised never show up.

const DAY = 86_400_000;
const PAGE = 1000;

// ── thresholds, each with the number that chose it ──────────────────────────────────────────
//
// A paying account with no logins is the single strongest risk the portal holds, and it is not
// rare enough to ignore or common enough to be noise.
const DEAD_USAGE_DAYS = 30;
// A fall this steep is a decision someone made, not a slow month.
const USAGE_DROP = 0.7;
// Product silence. `cs.last_used_at` is the last time the thing they bought did anything at all.
const DARK_DAYS = 60;
// Conversation silence, used only as a tiebreaker. It is NOT risk on its own — an account can be
// perfectly healthy and simply not need a call — which is why it ranks last and never promotes.
const QUIET_DAYS = 90;

/** Every row of a paged PostgREST read. It truncates at 1000 without saying so. */
async function pageAll(make) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await make(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const str = (v) => { const s = v == null ? '' : String(v).trim(); return s || null; };
const list = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : v == null ? [] : [String(v)]);

// The columns the page draws, plus the health bag. Named rather than `select *`: `entity_list_rows`
// is wide and this route reads about a thousand of them on every open.
export const ROW_COLS = 'entity_id, name, domain, industry, people_count, last_activity_at, open_deals, '
  + 'won_deals, won_value, last_lost_at, owner_name, owner_email, child_deals, cs';

/**
 * The customer cohort and everything known about it, in two indexed reads.
 *
 * NOT from `claims`. That was the first design and it does not survive a real workspace: on the
 * first customer's, a claims read for 100 entity ids with `invalid_at is null` hits the statement
 * timeout, and the same read narrowed to the `cs.` property range took over ten seconds to
 * return zero rows. The health facts are projected onto the account row instead
 * (supabase/migrations/2026_09_21_account_health_rows.sql), which is the same move
 * `entity_list_rows` exists to make for every other list in the app.
 *
 * Two reads, unioned, because the two definitions of "customer" disagree in both directions and
 * we want the union rather than either one alone:
 *   · rows that HAVE a health bag — whoever the CRM tracks as an account
 *   · rows with a won deal — whoever bought something
 * A few hundred accounts are marked a customer with no won deal recorded (bought before the CRM,
 * or the deal sits on a sibling location); a handful have a won deal while still marked an
 * opportunity.
 *
 * Returns `null` when the `cs` column does not exist yet, so a deployment that is ahead of its
 * migrations falls back to the deal-only page rather than 500ing.
 */
export async function loadCustomerRows(workspaceId, supabase) {
  const base = () => supabase.from('entity_list_rows').select(ROW_COLS)
    .eq('workspace_id', workspaceId).eq('kind', 'account');

  let withHealth = [];
  let healthColumn = true;
  try {
    withHealth = await pageAll((from, to) => base().not('cs', 'is', null)
      .order('entity_id', { ascending: true }).range(from, to));
  } catch (e) {
    // `column entity_list_rows.cs does not exist` — the API shipped ahead of the migration.
    if (!/does not exist/i.test(String(e?.message ?? ''))) throw e;
    healthColumn = false;
  }

  const cols = healthColumn ? ROW_COLS : ROW_COLS.replace(', cs', '');
  const withDeals = await pageAll((from, to) => supabase.from('entity_list_rows').select(cols)
    .eq('workspace_id', workspaceId).eq('kind', 'account')
    .gt('won_deals', 0).order('entity_id', { ascending: true }).range(from, to));

  const byId = new Map();
  for (const r of [...withHealth, ...withDeals]) byId.set(r.entity_id, r);
  return { rows: [...byId.values()], healthColumn };
}

/** The health bag off a row, keyed the way the reason engines expect. */
export function healthOf(row) {
  const bag = row?.cs;
  if (!bag || typeof bag !== 'object') return {};
  return bag;
}

/**
 * What the customer actually said, in their own conversations.
 *
 * Two claim categories, whoever wrote them (GET-402): `expansion_signal` and `risk_signal`,
 * the taxonomy's own since GET-401. The CRM-corpus miner (mineExpansionSignals.mjs), a Fellow
 * health read, and Noema on an ordinary inbound email all write the same two categories, so this
 * reader no longer cares who wrote a row — it used to accept only the miner's, keyed on
 * `metadata.mined_from`, and a cancellation Noema extracted from a Gmail thread was invisible to
 * the at-risk list. Three kinds come back:
 *
 *   asked     they asked about a product they do not own — the reason a CRM cannot produce.
 *             `stance = asked`. A `considering` is kept out on purpose: it is a mention, not a
 *             request, and a row that cannot say "they asked" is not a lead.
 *   declined  they said no to one. NOT an expansion signal and not a risk: a suppression fact.
 *             `stance = declined`.
 *   risk      they raised a problem. `severity` ranks it: stated_churn / at_risk / friction.
 *
 * Read off the COMPANY entity only. Both categories are declared `about: company` and are in
 * ACCOUNT_ROLLUP_CATEGORIES, so a signal voiced by a person lands on the account; this is one
 * batched read over the cohort rather than a walk across every contact.
 *
 * Decay is honoured here rather than in the page: an expansion ask goes stale in a quarter
 * (HEALTH_WINDOW_DAYS.expansion = 90) because "could we add the second store" is a live opening for
 * about that long. A decline does NOT decay on the same clock — see DECLINE_WINDOW_DAYS.
 */
const ASK_WINDOW_DAYS = 90;
const RISK_WINDOW_DAYS = 120;
// A "no" outlives a "yes". Re-pitching something a customer turned down four months ago is the
// single fastest way to make this page feel like spam, so a decline suppresses for a full year —
// long enough to respect the answer, short enough that a genuine change of mind gets through.
const DECLINE_WINDOW_DAYS = 365;

export async function loadConversationSignals(workspaceId, supabase, companyIds, now = Date.now()) {
  const out = new Map(companyIds.map(id => [id, { asked: [], declined: [], risks: [] }]));
  if (!companyIds.length) return out;

  // PAGED, not `.limit(5000)`: PostgREST answers at most 1,000 rows whatever the limit says, and
  // says nothing when it stops. While this read ran over every account row, a batch of 100 ids held
  // two or three customers and never reached the cap. Over the customer cohort alone (2026-10-02),
  // a batch is 100 customers, and the busiest ones are exactly where it would cut off.
  const rows = [];
  for (let i = 0; i < companyIds.length; i += 100) {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase.from('claims')
        .select('entity_id, property, value, last_observed_at')
        .eq('workspace_id', workspaceId).is('invalid_at', null)
        .in('entity_id', companyIds.slice(i, i + 100))
        .like('property', 'note.%')
        .in('value->>category', ['expansion_signal', 'risk_signal'])
        .order('entity_id').order('property')
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      rows.push(...(data ?? []));
      if (!data || data.length < PAGE) break;
    }
  }

  for (const r of rows) {
    const v = r.value ?? {};
    const m = v.metadata ?? {};
    const category = String(v.category ?? '').toLowerCase();
    // `occurred_at` is when they said it (the miner and the health read stamp it); a claim from
    // live extraction has only when it was recorded, which for a live ingest is the same day.
    const at = Date.parse(m.occurred_at ?? r.last_observed_at ?? '');
    if (!Number.isFinite(at)) continue;
    const ageDays = (now - at) / DAY;
    const bucket = out.get(r.entity_id);
    if (!bucket) continue;
    const sig = {
      product: m.product ? String(m.product) : null,
      text: String(v.content ?? '').trim(),
      quote: String(m.quote ?? '').trim(),
      at: m.occurred_at ?? r.last_observed_at,
      via: m.conversation_type ? String(m.conversation_type) : (m.signal_type && !/^health_/.test(String(m.signal_type)) ? String(m.signal_type) : null),
      severity: SEVERITIES.has(m.severity) ? m.severity : null,
      ageDays: Math.round(ageDays),
      // The conversation it came from, so two risks read out of the same call count as one piece
      // of evidence rather than two. See `independentCount`.
      ref: m.source_ref ?? m.mined_from ?? null,
    };
    if (!sig.text || !sig.quote) continue;
    // The reader is the second lock on the same door the miner locks first.
    //
    // An ask must SAY it is an ask and must NAME a product. A signal with neither falls through
    // every branch here and is ignored — it does not become an ask by default. That default is
    // the one bug that would matter: a miner can return a refusal with no stance at all, and
    // anything that treats an unlabelled signal as interest turns that into a sales call.
    //
    // A product-less ask is dropped for a duller reason: "they asked to reschedule the meeting"
    // came back as an expansion signal, and a row that cannot say WHAT to sell is not a lead.
    if (category === 'expansion_signal') {
      if (m.stance === 'declined') {
        if (sig.product && ageDays <= DECLINE_WINDOW_DAYS) bucket.declined.push(sig);
      } else if (m.stance === 'asked') {
        if (sig.product && ageDays <= ASK_WINDOW_DAYS) bucket.asked.push(sig);
      }
      // `considering`, or no stance at all, falls through: not an ask, not a decline.
    } else if (category === 'risk_signal') {
      if (ageDays <= RISK_WINDOW_DAYS) bucket.risks.push(sig);
    }
  }

  const newestFirst = (a, b) => String(b.at).localeCompare(String(a.at));
  // A stated cancellation outranks a vendor review, which outranks an invoice complaint — and
  // within a grade, the newest first. An ungraded risk (written before GET-402 graded them) sits
  // with at_risk, which is what the backfill stamped it as.
  const gravestFirst = (a, b) => (SEVERITY_RANK[a.severity ?? 'at_risk'] - SEVERITY_RANK[b.severity ?? 'at_risk']) || newestFirst(a, b);
  for (const b of out.values()) { b.asked.sort(newestFirst); b.declined.sort(newestFirst); b.risks.sort(gravestFirst); }
  return out;
}

const SEVERITIES = new Set(['stated_churn', 'at_risk', 'friction']);
const SEVERITY_RANK = { stated_churn: 0, at_risk: 1, friction: 2 };

/**
 * How old a mined signal is, in days.
 *
 * Taken from the signal's own `at` where it has one, so the windows hold however the signal
 * reached us. A signal we cannot date is treated as infinitely old and therefore expired: an
 * undated quote cannot be put in front of a customer ("you mentioned, at some point, that...").
 */
function ageOf(sig, now = Date.now()) {
  if (Number.isFinite(sig?.ageDays)) return sig.ageDays;
  const t = sig?.at ? Date.parse(sig.at) : NaN;
  return Number.isFinite(t) ? (now - t) / DAY : Infinity;
}

/** How a conversation reached us, in words a rep recognises. */
const VIA_LABEL = {
  email_received: 'they emailed', call_received: 'they called', call_made: 'on a call',
  meeting_held: 'in a meeting', note_added: 'noted on the account',
};

/**
 * Why this customer is at risk, strongest reason first — or an empty list, which means not at risk.
 *
 * Ranked by how defensible the reason is to the customer, never by a score. A rep opens the call
 * with reason #1, so reason #1 has to be something they can say out loud without hedging.
 */
function riskReasons(a) {
  const out = [];
  const h = a.health ?? {};
  const mrr = num(h.mrr);
  const money = mrr ? `$${Math.round(mrr).toLocaleString()}/mo` : null;

  // 1. They have already told the CRM they are leaving. Nothing outranks a cancellation date.
  const cancelAt = h.cancelled_at ? Date.parse(h.cancelled_at) : NaN;
  if (Number.isFinite(cancelAt)) {
    const days = Math.round((cancelAt - Date.now()) / DAY);
    out.push({
      tier: 1, kind: 'cancelling',
      text: days >= 0 ? `Cancelling in ${days} days` : `Cancellation dated ${new Date(cancelAt).toISOString().slice(0, 10)}`,
      detail: str(h.cancel_reason), evidence: 'crm',
    });
  }

  // 2. The customer's OWN churn model has an open call on them. We do not re-score it, we repeat
  //    it — and we name the signals, because "at risk" with no signal is not worth a rep's time.
  if (str(h.risk_status) === 'open') {
    const signals = list(h.risk_signals).slice(0, 3).map(s => s.replace(/_/g, ' '));
    out.push({ tier: 1, kind: 'churn_flag', text: 'Churn prediction open', detail: signals.join(', ') || null, evidence: 'crm' });
  }

  // 3. Paying and nobody is logging in. The clearest sentence on this page.
  const users = num(h.active_users_30d);
  if (users === 0 && (mrr ?? 0) > 0) {
    out.push({
      tier: 1, kind: 'no_usage',
      text: money ? `Paying ${money}, nobody logged in` : 'Paying, nobody logged in',
      detail: `0 active users in ${DEAD_USAGE_DAYS} days` + (num(h.total_users) ? ` of ${num(h.total_users)} seats` : ''),
      evidence: 'crm',
    });
  }

  // 4. Usage fell off a cliff between quarters. Their number, their definition of a unit.
  const now90 = num(h.units_90d), prev90 = num(h.units_prev_90d);
  if (now90 != null && prev90 != null && prev90 > 0 && now90 < prev90 * USAGE_DROP) {
    const pct = Math.round((1 - now90 / prev90) * 100);
    out.push({ tier: 2, kind: 'usage_drop', text: `Usage down ${pct}% this quarter`, detail: `${prev90} → ${now90} units`, evidence: 'crm' });
  }

  // 5. The product itself has gone silent, whatever the login count says.
  const lastUsed = h.last_used_at ? Date.parse(h.last_used_at) : NaN;
  if (Number.isFinite(lastUsed)) {
    const days = Math.round((Date.now() - lastUsed) / DAY);
    if (days > DARK_DAYS) out.push({ tier: 2, kind: 'dark', text: `No product activity in ${days} days`, detail: null, evidence: 'crm' });
  }

  // 5b. A problem they raised in their own words, out of the conversation corpus. Ranked above
  //     the inferred reasons below because it is the customer speaking, with the quote and the
  //     date attached. "We're moving to another vendor at renewal" is tier 1 — it outranks
  //     everything the CRM infers and sits beside a cancellation date, because it IS one, said
  //     before the CRM records it (GET-402). A vendor review or an escalation is tier 2;
  //     an invoice complaint raised with frustration is tier 3, a warning rather than a reason.
  const SAID_TIER = { stated_churn: 1, at_risk: 2, friction: 3 };
  for (const r of (a.said?.risks ?? []).filter(x => ageOf(x) <= RISK_WINDOW_DAYS).slice(0, 2)) {
    out.push({
      tier: SAID_TIER[r.severity ?? 'at_risk'], kind: r.severity === 'stated_churn' ? 'they_said_leaving' : 'they_said',
      text: r.text, detail: r.quote, evidence: 'said',
      quote: r.quote, at: r.at, via: VIA_LABEL[r.via] ?? null, ref: r.ref ?? null,
    });
  }

  // AN OPEN TO-DO WE OWE THEM IS NOT A RISK, and used to be a tier-2 reason here.
  //
  // "Turn on the usage export", "send the SSO setup steps": that is a customer who is
  // onboarding and talking to us, which is the opposite of one who is leaving. Each open item
  // also counted as its own "independent" reason, so two to-dos off one call met the two-reason
  // bar, so accounts qualified on to-dos alone. What we owe a customer now rides on the row as
  // its own list, `promisedReasons` ("We promised", 2026-10-02), and never counts toward at risk.

  // 5c. The person who chose us has gone (GET-692). A champion, economic buyer or decision-maker
  //     named on a call, then a departure recorded for that same person. The classic churn
  //     signal, and tier 2: strong, but a relationship can re-form, so it needs a second reason
  //     pointing the same way to put a customer on the list. Decays on the risk window.
  for (const r of (a.reasons ?? []).filter(x => x.kind === 'champion_left' && ageOf(x) <= RISK_WINDOW_DAYS).slice(0, 1)) {
    out.push({ tier: 2, kind: 'champion_left', text: r.text, detail: r.detail, evidence: 'said', at: r.at });
  }

  // 6. What they told us, extracted from a call. Undated (only when it was computed), so context.
  for (const r of a.reasons ?? []) {
    if (r.tier === 2 && ['pain', 'objection', 'competitor'].includes(r.kind)) {
      out.push({ tier: 3, kind: r.kind, text: r.text, detail: `they said this on a call`, evidence: 'said' });
    }
  }

  // A LOST DEAL IS NOT A RISK, and used to be listed here as one.
  //
  // It is a closed sales event, not a threat to the relationship. The customer is still a
  // customer and still paying; what was lost was an attempt to sell them more. Churn on this
  // portal is `account_status` and a cancellation date, both of which are tier 1 above.
  //
  // It was also the single biggest source of noise: about a third of the accounts that qualified
  // under the old "any reason" bar carried it, and a deal lost eleven months ago would have kept an
  // account red indefinitely. Nothing to recover, nothing to act on, no reason to show it.

  // 8. On the customer's watchlist but not yet flagged open.
  if (str(h.risk_tier) === 'watch' && str(h.risk_status) !== 'open') {
    out.push({ tier: 3, kind: 'watch', text: 'On the churn watchlist', detail: list(h.risk_signals).slice(0, 2).map(s => s.replace(/_/g, ' ')).join(', ') || null, evidence: 'crm' });
  }

  // 9. Nobody has spoken to them. Last, and never on its own — see QUIET_DAYS.
  if (out.length && (a.daysQuiet == null || a.daysQuiet > QUIET_DAYS)) {
    out.push({ tier: 4, kind: 'quiet', text: a.daysQuiet == null ? 'Never spoken to' : `No contact in ${a.daysQuiet} days`, detail: null, evidence: 'said' });
  }

  return out.sort((x, y) => x.tier - y.tier);
}

/**
 * How many tier-N reasons point the same way INDEPENDENTLY.
 *
 * Two quotes out of one call are one piece of evidence, not two: a reason that names the
 * conversation it came from counts once per conversation. Everything else counts once per kind,
 * so "usage down" and "product dark" are two (different measurements), but the same kind twice
 * is one.
 */
function independentCount(reasons, tier) {
  const keys = new Set();
  for (const r of reasons) if (r.tier === tier) keys.add(r.ref ? `ref:${r.ref}` : `kind:${r.kind}`);
  return keys.size;
}

// ── What the CRM's upgrade-stage labels mean ─────────────────────────────────────────────────
//
// The upgrade stage is a field the customer set up in its own CRM, in its own words, so the
// meaning of each label is registered per deployment rather than written here: Cloud hands its
// workspaces' labels over at boot (cloud/index.mjs register(), GET-761). Four roles matter:
//
//   live        the upgrade is in conversation, or a proposal is out
//   onboarding  the account is still being implemented
//   declined    they turned it down
//   untouched   the CRM prices an upgrade nobody has raised
//
// Unregistered, no label has a role: the CRM path adds no reasons and suppresses none, and what
// the customer said still counts.
let upgradeStageRoles = new Map();

/** label → 'live' | 'onboarding' | 'declined' | 'untouched'. Replaces any earlier registration. */
export function registerUpgradeStages(map) {
  upgradeStageRoles = new Map(Object.entries(map ?? {}));
}

const stageRole = stage => (stage ? upgradeStageRoles.get(stage) ?? null : null);

/**
 * Why this customer is worth selling to, strongest reason first.
 *
 * The bar is "a rep could open this conversation tomorrow", and the strongest evidence is the
 * customer's own sentence. A product they lack is not a reason (measured on this portal, owning
 * one product predicts owning another at a lift of ~1.0, which is no signal at all).
 *
 * The CRM's upgrade price is CONTEXT, not a reason (2026-10-01). The upgrade price (`cs.upgrade_value`) is the list
 * price of the next package, set for every client whether or not anyone wants it: small monthly
 * accounts carry an "upside" many times their bill. It led most expansion rows, which made the list a copy of a CRM
 * field the team already distrusts. It still travels on the row so a rep can see the number.
 */
function expansionReasons(a) {
  const out = [];
  const h = a.health ?? {};
  const said = a.said ?? { asked: [], declined: [], risks: [] };
  const stage = str(h.upgrade_stage);
  const role = stageRole(stage);
  const value = num(h.upgrade_value);
  const money = value ? `$${Math.round(value).toLocaleString()}/mo` : null;
  const products = list(h.upgrade_products);
  const owned = new Set(list(h.products).map(p => p.toLowerCase()));
  // A decline suppresses only while it is still current. Both windows are re-checked HERE rather
  // than trusted from the reader, because this function is what decides what a rep is shown and
  // a guard that lives only in the query is a guard the next caller forgets.
  const refused = new Set(said.declined
    .filter(d => ageOf(d) <= DECLINE_WINDOW_DAYS)
    .map(d => String(d.product ?? '').toLowerCase()).filter(Boolean));

  // ── 0. THEY ASKED. Nothing the CRM holds outranks the customer's own sentence. ──
  //
  // This is the whole point of reading the conversations: the CRM can say an upgrade is available
  // and priced, but only a call or an email can say they wanted it. Measured on the first
  // customer's corpus before any of this was built, a crude scan found such a conversation on about
  // one active account in five, and most of those carried an upgrade the CRM said nobody had raised.
  //
  // It survives a `declined` stage, which the CRM path below does not. That field is a state
  // somebody set once; a dated quote is evidence. When they disagree the quote wins and the
  // disagreement is shown, because "your CRM says this was dropped and they asked again in
  // August" is the most useful row on the page — not something to hide.
  for (const ask of said.asked.filter(a => a.product && ageOf(a) <= ASK_WINDOW_DAYS).slice(0, 2)) {
    const p = String(ask.product).toLowerCase();
    if (owned.has(p)) continue;                   // they have it now; the ask is history
    if (refused.has(p)) continue;                 // they asked, then said no. The no wins
    const stale = role === 'declined' || role === 'untouched';
    out.push({
      tier: 1, kind: 'they_asked',
      text: `Asked about ${ask.product}`,
      detail: ask.quote, evidence: 'said',
      quote: ask.quote, at: ask.at, via: VIA_LABEL[ask.via] ?? null, product: ask.product,
      // Shown as a conflict chip, not buried. The CRM field and the customer disagree.
      conflict: stale ? `CRM says "${stage}"` : null,
    });
  }

  // Two CRM states stop the inferred reasons below, and neither stops a dated ask above.
  //
  //   onboarding   an account still onboarding is not an expansion target, it is an
  //                implementation. But if they ASKED for something during onboarding that
  //                is the best kind of signal there is, so the ask survives and this only
  //                suppresses the reasons we would have inferred.
  //   declined     they turned it down. Same rule: respected, unless they asked again.
  //
  // This is the "conversation wins, flag the conflict" rule applied consistently. A field is a
  // state somebody set once; a quote has a date on it.
  if ((role === 'onboarding' || role === 'declined') && !out.length) return out;
  if (role === 'onboarding' || role === 'declined') return out.slice(0, 2);

  // 1. Already in motion: a rep has the upgrade in conversation or a proposal out. A real event
  //    somebody acted on, so it counts, but it is the CRM's word, so it needs a second reason.
  if (role === 'live') {
    out.push({ tier: 2, kind: 'upgrade_live', text: `Upgrade ${stage.toLowerCase()}`, detail: money, evidence: 'crm' });
  }

  // 2. Heavy use of a small plan. Usage is measured, not typed in by a rep, so it counts as a
  //    reason, but on its own it is a pattern rather than an opening.
  const usage = num(h.usage_30d), mrr = num(h.mrr);
  if (usage != null && mrr != null && mrr > 0 && usage > 0) {
    const perLead = mrr / usage;
    if (usage >= 100 && perLead < 2) {
      out.push({ tier: 2, kind: 'heavy_use', text: `${usage} leads a month on $${Math.round(mrr)}/mo`, detail: 'using it hard, paying little', evidence: 'crm' });
    }
  }

  // 3. The CRM prices an upgrade nobody has raised. CONTEXT ONLY (see the function comment): it is
  //    on every client whether or not they want it. A $0 upgrade is not an upgrade and is dropped.
  if (role === 'untouched' && value && value > 0) {
    out.push({
      tier: 3, kind: 'upgrade_untouched',
      text: `CRM prices an upgrade at ${money}, never discussed`,
      detail: [str(h.upgrade_target), products.slice(0, 3).join(', ')].filter(Boolean).join(' · ') || null,
      evidence: 'crm',
    });
  }

  // An extracted goal, budget or timeline from a call. Undated (only when it was computed) and not
  // necessarily about buying more from us, so context rather than a reason.
  for (const r of a.reasons ?? []) {
    if (r.tier === 2 && ['goal', 'budget', 'timeline'].includes(r.kind)) {
      out.push({ tier: 3, kind: r.kind, text: r.text, detail: 'they said this on a call', evidence: 'said' });
    }
  }

  // 4. Named products they could have, with no upgrade conversation recorded at all. Context. A product
  //    they have TURNED DOWN is filtered out here — the one thing a rep must never be handed.
  if (!stage && products.length) {
    const open = products.filter(p => !refused.has(p.toLowerCase()));
    if (open.length) {
      out.push({ tier: 3, kind: 'products_available', text: `Could add ${open.slice(0, 2).join(' and ')}`, detail: money, evidence: 'crm' });
    }
  }

  // 5. A sibling location in the same company group already buys. Group-level, context.
  if (a.groupSiblingBuys) {
    out.push({ tier: 3, kind: 'group', text: `Other locations in ${a.groupSiblingBuys.group} already buy`, detail: `${a.groupSiblingBuys.n} of them`, evidence: 'crm' });
  }

  return out.sort((x, y) => x.tier - y.tier);
}

/**
 * Build the three lists.
 *
 * `accounts` is the spine from csAccounts (name, domain, roster, last activity, deal counts and
 * the conversation reasons). `health` is the CRM's account-health bag. This joins them and
 * classifies; it does no I/O of its own so it stays testable.
 */
export function classifyCustomers(accounts, health, { hasHealth, said = new Map(), promises = new Map(), groupBuyers = null } = {}) {
  // Whose group already buys, for the expansion group reason. One account classified alone
  // (the account page) passes the counts in, since its siblings are not in `accounts`.
  const buyersByGroup = groupBuyers ?? new Map();
  for (const a of groupBuyers ? [] : accounts) {
    const g = str((health.get(a.companyId) ?? {}).group);
    if (!g) continue;
    const h = health.get(a.companyId) ?? {};
    if (str(h.status) === 'client') buyersByGroup.set(g, (buyersByGroup.get(g) ?? 0) + 1);
  }

  const rows = accounts.map(a => {
    const h = health.get(a.companyId) ?? {};
    const group = str(h.group);
    const siblings = group ? (buyersByGroup.get(group) ?? 0) - (str(h.status) === 'client' ? 1 : 0) : 0;
    return {
      ...a,
      health: h,
      said: said.get(a.companyId) ?? { asked: [], declined: [], risks: [] },
      status: str(h.status),
      mrr: num(h.mrr),
      tier: str(h.tier),
      csOwnerExternalId: str(h.owner_external_id),
      products: list(h.products).length ? list(h.products).map(p => ({ key: p, label: p })) : a.products,
      activeUsers: num(h.active_users_30d),
      totalUsers: num(h.total_users),
      lastUsedAt: h.last_used_at ?? null,
      groupSiblingBuys: siblings > 0 ? { group, n: siblings } : null,
    };
  });

  for (const r of rows) {
    r.riskReasons = riskReasons(r);
    r.expansionReasons = expansionReasons(r);
    // Its own list, read by nothing below: what we owe them never decides which list they are on.
    const owed = rankPromises(promises.get(r.companyId) ?? []);
    r.promisedReasons = owed.slice(0, MAX_PROMISES_ON_ROW);
    r.promisedTotal = owed.length;
  }

  // A customer, by the CRM's own word.
  //
  // THE FALLBACK IS ABOUT THE WORKSPACE, NOT THE ROW. It exists for a workspace whose CRM keeps
  // none of these fields, or whose health sync has not run: there, "they bought something" is the
  // only fact available and the page still works with fewer reasons.
  //
  // Evaluating it per row instead was a real bug, live on the first customer. An account with a
  // won deal and no `cs.status` quietly fell through to the deal rule, so the list read half again
  // what the CRM says — it re-admitted hundreds of accounts their own ops team does not call customers,
  // which is the exact thing this page was rewritten to stop doing. When the workspace HAS health
  // data, a missing status means not a customer, not "ask a different question".
  const isCustomer = (r) => (hasHealth ? r.status === 'client' : r.wonDeals > 0);
  const active = rows.filter(isCustomer);
  const activeIds = new Set(active.map(r => r.companyId));

  // WHAT EARNS A PLACE ON A WORKLIST.
  //
  // "Has at least one reason" is not a bar, it is a description. Measured on the first customer it
  // put more than four in five customers on the at-risk list, which is not a worklist, it is the book
  // with a red label on it. A CS lead who opens that closes it.
  //
  // So: one tier-1 reason, or two INDEPENDENT tier-2 ones (two quotes off one call are one).
  //
  // Tier 1 is unambiguous and single-source-sufficient — a cancellation date, their own churn
  // model open, paying us while nobody logs in, or the customer saying they are leaving. Tier 2 is
  // strong but survivable alone: usage down a third, the product gone quiet, a risk they raised on
  // a call or in an email. Two of those pointing the same way is a pattern; one is a Tuesday.
  // Tier 3 and below (the watchlist, a stale extracted claim, silence) are context on a row, never
  // the reason for it. A promise we owe them is not on this list at all: it is `promisedReasons`,
  // shown beside the row as "We promised", never counted.
  //
  // The same bar applies to expansion (2026-10-01). It used to be "any reason at all", which let a
  // CRM price field alone fill the list: tier 1 is the customer asking, tier 2 is an upgrade
  // already in motion or heavy use of a small plan.
  const earnsAPlace = (reasons) => reasons.some(x => x.tier === 1) || independentCount(reasons, 2) >= 2;
  const seriouslyAtRisk = (r) => earnsAPlace(r.riskReasons);

  // AT RISK TAKES PRECEDENCE OVER EXPANSION.
  //
  // An account that is about to leave is not this week's upsell, and showing it on both lists
  // makes each one less trustworthy: the two counts stop summing to anything and a rep cannot
  // tell which list is the instruction. Save it first, sell to it after. The expansion reasons are
  // still computed and still travel on the row, so an account that recovers surfaces immediately.
  const atRisk = active.filter(seriouslyAtRisk);
  const atRiskIds = new Set(atRisk.map(r => r.companyId));

  return {
    active,
    // Cancelled accounts are not expansion targets and not "at risk" — they are already gone.
    // They stay out of all three lists and are counted separately, because a CS lead asking
    // "how many did we lose" deserves the number rather than a silently shorter list.
    expansion: active.filter(r => earnsAPlace(r.expansionReasons) && !atRiskIds.has(r.companyId)),
    atRisk,
    churned: rows.filter(r => r.status === 'cancelled'),
  };
}

export const CS_THRESHOLDS = { DEAD_USAGE_DAYS, USAGE_DROP, DARK_DAYS, QUIET_DAYS };

// ── "We promised" (2026-10-02) ──────────────────────────────────────────────────────────────
//
// Back as its OWN reason, by founder decision, after it was taken out of the risk list on
// 2026-10-01 (see riskReasons). An open commitment is a customer who is talking to us, not one who
// is leaving, so it never counts toward at risk. But a CS rep about to ring an account needs to
// know what we owe them before they dial, and a handoff card needs the promises made during the
// sale. So it travels on the row as `promisedReasons`, a separate list the page labels "We promised".
//
// What qualifies: an open action item that is OURS (owner_kind user) and not a chase (awaiting_them
// marks "they owe us, we follow up", GET-425), and that is either past its due date or came out of a
// call. An email to-do with no date that has not slipped is a to-do, and it stays on the Tasks page.

const ACTION_LO = 'action_item.';
// '/' is the byte after '.', so the half-open range is exactly the prefix and can use the
// (workspace_id, property) index, where a LIKE cannot (GET-396, measured in routes/api/tasks.mjs).
const ACTION_HI = 'action_item/';
const PROMISE_PAGE = 1000;
const PROMISE_MAX = 10_000;
const CALL_SOURCES = new Set(['meeting', 'call', 'follow_up']);
const MAX_PROMISES_ON_ROW = 5;

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * One action-item claim as a "We promised" reason, or null when it is not one. Pure.
 *
 * Ranked within its own list only: overdue first (tier 2), then promises from a call (tier 3). The
 * tier never meets the risk bar because this list is never read by it.
 */
export function promiseOf(row, now = Date.now()) {
  const v = row?.value ?? {};
  const property = String(row?.property ?? '');
  if (!property.startsWith(ACTION_LO)) return null;
  if (v.owner_kind !== 'user' || (v.status ?? 'open') !== 'open' || v.awaiting_them === true) return null;
  const title = String(v.title ?? '').trim();
  if (!title) return null;

  const dueDay = typeof v.due_at === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v.due_at) ? v.due_at.slice(0, 10) : null;
  const today = utcDay(now);
  const overdueDays = dueDay && dueDay < today ? Math.round((Date.parse(today) - Date.parse(dueDay)) / DAY) : null;
  const fromCall = CALL_SOURCES.has(String(v.source_type ?? '').toLowerCase()) || /^action_item\.(meeting|followup)_/.test(property);
  if (!overdueDays && !fromCall) return null;

  return {
    tier: overdueDays ? 2 : 3,
    kind: 'promised',
    text: title.slice(0, 200),
    detail: overdueDays
      ? `${overdueDays} day${overdueDays === 1 ? '' : 's'} overdue`
      : v.due_phrase ? `due ${String(v.due_phrase)}` : 'promised on a call',
    evidence: 'said',
    quote: typeof v.quote === 'string' && v.quote.trim() ? v.quote.trim() : null,
    // When it was SAID where the writer knew it; otherwise when we extracted it.
    at: v.occurred_at ?? row.computed_at ?? null,
    via: fromCall ? 'on a call' : 'by email',
    due_at: dueDay,
    overdue_days: overdueDays,
    task: property,
  };
}

/** Most overdue first, then the newest promise. Pure. */
export function rankPromises(list) {
  return [...(list ?? [])].sort((x, y) =>
    (y.overdue_days ?? 0) - (x.overdue_days ?? 0)
    || String(y.at ?? '').localeCompare(String(x.at ?? '')));
}

/**
 * What we owe each customer: companyId → promise reasons (unranked; classifyCustomers ranks them).
 *
 * One workspace-wide read of the live action items by property range (one customer holds over a thousand,
 * two pages), then a works_at lookup for the people they hang on: email commitments sit on the person,
 * meeting commitments on the account (GET-357). Cheaper than walking every customer's roster, which
 * is what loadCsReasons does for the claims it reads.
 */
export async function loadPromises(workspaceId, supabase, companyIds, now = Date.now()) {
  const cohort = new Set(companyIds);
  const out = new Map(companyIds.map(id => [id, []]));
  if (!companyIds.length) return out;

  const rows = [];
  for (let from = 0; from < PROMISE_MAX; from += PROMISE_PAGE) {
    const { data, error } = await supabase.from('claims')
      .select('entity_id, property, value, computed_at')
      .eq('workspace_id', workspaceId).gte('property', ACTION_LO).lt('property', ACTION_HI)
      .is('invalid_at', null)
      .order('entity_id').order('property')
      .range(from, from + PROMISE_PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < PROMISE_PAGE) break;
  }

  const kept = [];
  for (const r of rows) { const p = promiseOf(r, now); if (p) kept.push({ entityId: r.entity_id, p }); }

  const people = [...new Set(kept.map(k => k.entityId).filter(id => !cohort.has(id)))];
  const companyOf = new Map();
  for (let i = 0; i < people.length; i += 200) {
    const { data, error } = await supabase.from('relationships').select('from_entity_id, to_entity_id')
      .eq('workspace_id', workspaceId).eq('type', 'works_at')
      .in('from_entity_id', people.slice(i, i + 200));
    if (error) throw new Error(error.message);
    for (const e of data ?? []) if (cohort.has(e.to_entity_id) && !companyOf.has(e.from_entity_id)) companyOf.set(e.from_entity_id, e.to_entity_id);
  }

  for (const { entityId, p } of kept) {
    const cid = cohort.has(entityId) ? entityId : companyOf.get(entityId);
    if (cid) out.get(cid).push(p);
  }
  return out;
}

// ── What they told us on a call (the extraction half) ───────────────────────────────────────
//
// The tier-2 claims the reason engines read from `a.reasons`: a pain, objection or competitor
// (risk context) or a goal, budget or timeline (an expansion reason), extracted from a call or an
// email and voiced by the account or anyone who works there. This used to come from
// csAccounts.mjs loadCsReasons, which also read every open action item for the "owed" reason. Owed
// is now loadPromises' job, so this reads only the notes, and does two things loadCsReasons did not:
//
//   · it is asked for the customer cohort only (csReport.mjs inCustomerCohort), not all of its tens of
//     thousands of account rows, which is where nearly all of the page load went (measured 2026-10-02);
//   · its paged reads are ORDERED. loadCsReasons pages `.range()` with no ORDER BY, which is only
//     safe while a batch fits in one page. Over 200 customers and their people a batch does not,
//     and unordered pages skip and repeat rows: two identical runs over the cohort disagreed on
//     a dozen-odd accounts and lost reasons on a few dozen (measured). Same trap as "a read that returns less than it
//     was asked for reports success" in docs/customer-success.md.

const SAYS_SOMETHING = new Set(['pain', 'goal', 'objection', 'competitor', 'budget', 'timeline']);

export async function loadSaidReasons(workspaceId, supabase, companyIds) {
  const reasons = new Map(companyIds.map(id => [id, []]));
  if (!companyIds.length) return reasons;
  const paged = async (make) => {
    const out = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await make(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      out.push(...(data ?? []));
      if (!data || data.length < PAGE) return out;
    }
  };
  const chunks = (ids, n) => { const c = []; for (let i = 0; i < ids.length; i += n) c.push(ids.slice(i, i + n)); return c; };
  // A few batches at a time: independent reads against the pool every other route shares.
  const lanes = async (items, fn, width = 6) => {
    const out = [];
    for (let i = 0; i < items.length; i += width) out.push(...(await Promise.all(items.slice(i, i + width).map(fn))).flat());
    return out;
  };

  // Who works at each customer, so a fact voiced by a person lands on their account.
  const staff = await lanes(chunks(companyIds, 200), (ids) => paged((from, to) => supabase
    .from('relationships').select('from_entity_id, to_entity_id')
    .eq('workspace_id', workspaceId).eq('type', 'works_at').in('to_entity_id', ids)
    .order('from_entity_id').order('to_entity_id').range(from, to)));
  const companyOfPerson = new Map(staff.map(r => [r.from_entity_id, r.to_entity_id]));
  const entities = [...new Set([...companyIds, ...companyOfPerson.keys()])];

  const claims = await lanes(chunks(entities, 200), (ids) => paged((from, to) => supabase
    .from('claims').select('entity_id, property, value, computed_at')
    .eq('workspace_id', workspaceId).is('invalid_at', null)
    .in('entity_id', ids).like('property', 'note.%').eq('value->>source', 'signal_extraction')
    .order('entity_id').order('property').range(from, to)));

  // Who held a buying role, and who left (GET-692): a departure is only a risk reason when the
  // person who left is one a call named as champion, economic buyer or decision-maker.
  const BUYING_ROLES = new Set(['champion', 'economic_buyer', 'decision_maker']);
  const roleOf = new Map();
  for (const c of claims) {
    const v = c.value ?? {};
    if (String(v.category ?? '').toLowerCase() === 'authority' && BUYING_ROLES.has(v.metadata?.role)) roleOf.set(c.entity_id, v.metadata.role);
  }
  const ROLE_WORD = { champion: 'champion', economic_buyer: 'economic buyer', decision_maker: 'decision-maker' };
  for (const c of claims) {
    const v = c.value ?? {};
    if (String(v.category ?? '').toLowerCase() !== 'staff_change' || v.metadata?.change !== 'left') continue;
    const role = roleOf.get(c.entity_id);
    const cid = companyOfPerson.get(c.entity_id);
    if (!role || !cid || !reasons.has(cid)) continue;
    const text = String(v.content ?? '').trim();
    reasons.get(cid).push({
      tier: 2, kind: 'champion_left', text: `Their ${ROLE_WORD[role]} left`, detail: text.slice(0, 200) || null,
      at: v.metadata?.occurred_at ?? c.computed_at ?? null,
    });
  }

  for (const c of claims) {
    const cid = companyOfPerson.get(c.entity_id) ?? (reasons.has(c.entity_id) ? c.entity_id : null);
    if (!cid || !reasons.has(cid)) continue;
    const v = c.value ?? {};
    const kind = String(v.category ?? '').toLowerCase();
    if (v.source !== 'signal_extraction' || !SAYS_SOMETHING.has(kind)) continue;
    const text = String(v.content ?? '').trim();
    if (!text) continue;
    reasons.get(cid).push({ tier: 2, kind, text: text.slice(0, 200), detail: null, at: c.computed_at ?? null });
  }
  return reasons;
}

// ── Renewal and the active-users trend (Phase 5, 2026-10-02) ─────────────────────────────────

/**
 * The renewal date off the health bag, only while it is still ahead. Pure.
 *
 * `cs.renewal_date` is the end of a committed subscription term (accountHealth.ts
 * renewalFromSubscriptions). One that has passed is a sync that has not caught up yet, not a
 * renewal, and a month-to-month customer has none at all (`term_months` 1).
 */
export function upcomingRenewal(bag, now = Date.now()) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(str(bag?.renewal_date) ?? '');
  if (!m) return null;
  return m[1] >= utcDay(now) ? m[1] : null;
}

// "This month against last month". A snapshot within a few days of 30 days ago stands in for it,
// because the job that writes them can miss a day; further off than that is a different question.
export const TREND_DAYS = 30;
const TREND_SLACK_DAYS = 4;

/**
 * Active users now, minus the count ~30 days earlier. Null until a month of history exists, and
 * never a guess. Pure.
 *
 * @param current  today's value (the bag's active_users_30d)
 * @param history  [{ captured_on: 'YYYY-MM-DD', value }] for this account
 */
export function activeUsersTrend(current, history, now = Date.now()) {
  // num(null) is 0, and "no figure" must not read as "nobody".
  const cur = current == null || current === '' ? null : num(current);
  if (cur == null || !history?.length) return null;
  const target = Date.parse(utcDay(now)) - TREND_DAYS * DAY;
  let best = null;
  for (const s of history) {
    const t = Date.parse(String(s?.captured_on ?? ''));
    const v = num(s?.value);
    if (!Number.isFinite(t) || v == null || s?.value == null) continue;
    const off = Math.abs(t - target) / DAY;
    if (off > TREND_SLACK_DAYS) continue;
    // Nearest to 30 days wins; between two equally near, the older one (a full month).
    if (!best || off < best.off || (off === best.off && t < best.t)) best = { off, t, v };
  }
  return best ? cur - best.v : null;
}

/** The days the trend reads, inclusive. */
export function trendWindow(now = Date.now()) {
  const target = Date.parse(utcDay(now)) - TREND_DAYS * DAY;
  return { fromDay: utcDay(target - TREND_SLACK_DAYS * DAY), toDay: utcDay(target + TREND_SLACK_DAYS * DAY) };
}

const isMissingTable = (e) => /cs_metric_snapshots|42P01|does not exist|PGRST205/i.test(String(e?.message ?? e) + String(e?.code ?? ''));

/**
 * The snapshots of one metric across a window of days, by account: entity → [{ captured_on, value }].
 *
 * A database without the table (2026_10_02_cs_metric_snapshots.sql is applied by hand) answers an
 * empty map: the trend column reads "—", the page does not fall over.
 */
export async function loadMetricHistory(workspaceId, supabase, metric, { fromDay, toDay, entityIds = null } = {}) {
  const out = new Map();
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from('cs_metric_snapshots').select('entity_id, captured_on, value')
      .eq('workspace_id', workspaceId).eq('metric', metric)
      .gte('captured_on', fromDay).lte('captured_on', toDay);
    if (entityIds) q = q.in('entity_id', entityIds);
    const { data, error } = await q.order('entity_id').order('captured_on').range(from, from + PAGE - 1);
    if (error) {
      if (isMissingTable(error)) return out;
      throw new Error(error.message);
    }
    for (const r of data ?? []) (out.get(r.entity_id) ?? out.set(r.entity_id, []).get(r.entity_id)).push({ captured_on: r.captured_on, value: r.value });
    if (!data || data.length < PAGE) return out;
  }
}

/** One account's trend, for a page that shows a single customer (the account strip). */
export async function activeUsersTrendFor(supabase, workspaceId, companyId, current, now = Date.now()) {
  if (current == null || current === '' || num(current) == null) return null;
  const hist = await loadMetricHistory(workspaceId, supabase, 'active_users_30d', { ...trendWindow(now), entityIds: [companyId] });
  return activeUsersTrend(current, hist.get(companyId) ?? [], now);
}
