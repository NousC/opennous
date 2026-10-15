import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCustomers, registerUpgradeStages } from '../src/lib/csHealth.mjs';

// A CRM's upgrade-stage labels are the customer's own words, registered per deployment. These
// are invented; the Cloud set lives in src/cloud/lib/upgradeStages.mjs.
registerUpgradeStages({
  'Under Discussion': 'live',
  'Quote Out': 'live',
  'Onboarding-60 Days': 'onboarding',
  'Passed On': 'declined',
  'Never Raised': 'untouched',
});

// Who the Customer Success page calls a customer, and what it is allowed to say about them.
//
// These are invariants, not thresholds. The numbers inside the reason engine will move as the
// customer's own fields move; what must not move is WHO ends up on a list and whether every row
// on it can explain itself. The four rules this file defends:
//
//   1. The CRM's word beats our derivation. A cancelled account is not a customer, whatever its
//      deal history says. We shipped hundreds of cancelled accounts as customers by ignoring this.
//   2. No row without a reason. "At risk" and "Expansion" are claims about somebody's business;
//      an empty `why` column is how a CS team learns to stop opening the tab.
//   3. Nobody is sold to on their way out. A cancelled or still-onboarding account is never an
//      expansion opportunity, however good the upgrade looks on paper.
//   4. It fails OPEN. A workspace whose CRM keeps none of these fields still gets a page, built
//      from the only fact every CRM has — they bought something.

const acct = (id, over = {}) => ({
  companyId: id, name: id, domain: `${id}.com`, wonDeals: 1, openDeals: 0,
  daysQuiet: 10, reasons: [], products: [], ...over,
});
const h = (entries) => new Map(Object.entries(entries));

test('the CRM decides who is a customer, not the deal history', () => {
  const accounts = [acct('paying'), acct('gone'), acct('never-bought', { wonDeals: 0 })];
  const health = h({
    paying: { status: 'client', mrr: 500 },
    gone: { status: 'cancelled', mrr: 500 },
    'never-bought': { status: 'client', mrr: 90 },
  });
  const { active, churned } = classifyCustomers(accounts, health, { hasHealth: true });
  assert.deepEqual(active.map(a => a.companyId).sort(), ['never-bought', 'paying']);
  assert.deepEqual(churned.map(a => a.companyId), ['gone']);
});

test('with no health fields at all it falls back to won deals rather than emptying the page', () => {
  const accounts = [acct('bought'), acct('prospect', { wonDeals: 0 })];
  const { active } = classifyCustomers(accounts, new Map(), { hasHealth: false });
  assert.deepEqual(active.map(a => a.companyId), ['bought']);
});

test('one tier-1 reason is enough; one tier-2 reason is not', () => {
  // The bar is what makes this a worklist rather than the book with a red label on it. With
  // "any reason at all", most of the first customer's accounts qualified.
  const accounts = [acct('fine'), acct('dead'), acct('dropping')];
  const health = h({
    fine: { status: 'client', mrr: 400, active_users_30d: 6, total_users: 8 },
    // tier 1: paying us while nobody logs in. Sufficient alone.
    dead: { status: 'client', mrr: 400, active_users_30d: 0, total_users: 8 },
    // tier 2 only: usage down 90%. Serious, shown on the row, not enough on its own.
    dropping: { status: 'client', mrr: 400, active_users_30d: 4, units_90d: 10, units_prev_90d: 100 },
  });
  const { atRisk, active } = classifyCustomers(accounts, health, { hasHealth: true });
  assert.deepEqual(atRisk.map(a => a.companyId), ['dead']);
  // ...but the reason is still computed and still travels on the row.
  const dropping = active.find(a => a.companyId === 'dropping');
  assert.ok(dropping.riskReasons.some(r => r.kind === 'usage_drop'));
  // The strongest reason leads, and it says the thing a rep can repeat down the phone.
  assert.match(atRisk[0].riskReasons[0].text, /nobody logged in/i);
});

test('two tier-2 reasons pointing the same way are a pattern', () => {
  const accounts = [acct('two')];
  const health = h({
    two: { status: 'client', mrr: 400, active_users_30d: 3,
           units_90d: 10, units_prev_90d: 100,                       // usage_drop
           last_used_at: new Date(Date.now() - 200 * 86_400_000).toISOString() },  // dark
  });
  const { atRisk } = classifyCustomers(accounts, health, { hasHealth: true });
  assert.equal(atRisk.length, 1);
  assert.ok(atRisk[0].riskReasons.filter(r => r.tier === 2).length >= 2);
});

test('silence alone is never a risk — it only ever rides along with a real one', () => {
  const quiet = [acct('quiet', { daysQuiet: 400 }), acct('quiet-and-dead', { daysQuiet: 400 })];
  const health = h({
    quiet: { status: 'client', mrr: 300, active_users_30d: 5 },
    'quiet-and-dead': { status: 'client', mrr: 300, active_users_30d: 0 },
  });
  const { atRisk } = classifyCustomers(quiet, health, { hasHealth: true });
  assert.deepEqual(atRisk.map(a => a.companyId), ['quiet-and-dead']);
  assert.ok(atRisk[0].riskReasons.some(r => r.kind === 'quiet'));
});

test('nobody is sold to on their way out, or before they have onboarded', () => {
  // Every account here would otherwise qualify on two independent tier-2 reasons: heavy use of a
  // small plan, and an upgrade in motion (or an onboarding / refused stage in its place).
  const heavy = { mrr: 150, usage_30d: 400, upgrade_value: 900 };
  const accounts = [acct('leaving'), acct('new'), acct('ready'), acct('refused')];
  const health = h({
    leaving: { status: 'cancelled', upgrade_stage: 'Under Discussion', ...heavy },
    new: { status: 'client', upgrade_stage: 'Onboarding-60 Days', ...heavy },
    ready: { status: 'client', upgrade_stage: 'Under Discussion', upgrade_target: 'Growth', ...heavy },
    refused: { status: 'client', upgrade_stage: 'Passed On', ...heavy },
  });
  const { expansion } = classifyCustomers(accounts, health, { hasHealth: true });
  assert.deepEqual(expansion.map(a => a.companyId), ['ready']);
  assert.match(expansion[0].expansionReasons[0].text, /under discussion/i);
});

test('an extracted goal is context marked as said, never an expansion row on its own', () => {
  // Undated (only when it was computed) and not necessarily about buying more from us.
  const accounts = [acct('talked', {
    reasons: [{ tier: 2, kind: 'goal', text: 'Wants to grow seat count next quarter', detail: null }],
  })];
  const health = h({ talked: { status: 'client', mrr: 200 } });
  const { expansion, active } = classifyCustomers(accounts, health, { hasHealth: true });
  assert.deepEqual(expansion, []);
  const r = active[0].expansionReasons[0];
  assert.equal(r.evidence, 'said');
  assert.equal(r.tier, 3);
});

test('an account about to leave is not this week’s upsell', () => {
  // Decision changed 2026-09-21. It used to appear on both lists, which made the two counts sum
  // to more than the customer base and left a rep unable to tell which list was the instruction.
  // Save it first, sell to it after.
  const accounts = [acct('both')];
  const health = h({
    both: { status: 'client', mrr: 800, active_users_30d: 0, upgrade_stage: 'Never Raised', upgrade_value: 400 },
  });
  const { active, expansion, atRisk } = classifyCustomers(accounts, health, { hasHealth: true });
  assert.equal(active.length, 1);
  assert.equal(atRisk.length, 1);
  assert.deepEqual(expansion, [], 'an at-risk account must not also be an expansion opportunity');
  // The opening is still computed, so it surfaces the moment the risk clears.
  assert.ok(active[0].expansionReasons.length > 0);
});

test('the two lists never add up to more than the customer base', () => {
  const accounts = ['a', 'b', 'c', 'd'].map(id => acct(id));
  const health = h({
    a: { status: 'client', mrr: 100, active_users_30d: 0 },                                  // at risk
    b: { status: 'client', mrr: 100, active_users_30d: 5, upgrade_stage: 'Never Raised', upgrade_value: 50 },
    c: { status: 'client', mrr: 100, active_users_30d: 0, upgrade_stage: 'Never Raised', upgrade_value: 50 },
    d: { status: 'client', mrr: 100, active_users_30d: 5 },                                  // steady
  });
  const { active, expansion, atRisk } = classifyCustomers(accounts, health, { hasHealth: true });
  assert.equal(active.length, 4);
  assert.ok(expansion.length + atRisk.length <= active.length,
    `${expansion.length} + ${atRisk.length} must not exceed ${active.length}`);
  // And not every customer is on a list: some are simply fine.
  assert.ok(expansion.length + atRisk.length < active.length);
});

test('the churn flag is repeated, never re-scored, and names its signals', () => {
  const accounts = [acct('flagged')];
  const health = h({
    flagged: { status: 'client', mrr: 250, active_users_30d: 3,
      risk_status: 'open', risk_signals: ['usage_drop', 'feature_adoption_drop'] },
  });
  const { atRisk } = classifyCustomers(accounts, health, { hasHealth: true });
  const top = atRisk[0].riskReasons[0];
  assert.equal(top.kind, 'churn_flag');
  assert.match(top.detail, /usage drop/);
  assert.equal(top.evidence, 'crm');
});

// ── what the customer actually said ─────────────────────────────────────────────────────────
//
// The conversation layer is the half a CRM cannot produce, and it is also the half that can do
// real damage. A mis-read refusal becomes a rep phoning a customer to sell them the thing they
// turned down last month. These tests are the guard rails on that.

const saidMap = (entries) => new Map(Object.entries(entries).map(([k, v]) => [k, {
  asked: v.asked ?? [], declined: v.declined ?? [], risks: v.risks ?? [],
}]));
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

test('a customer asking for something they do not own leads the expansion list', () => {
  const accounts = [acct('asked')];
  const health = h({ asked: { status: 'client', mrr: 400, products: ['Ledger'] } });
  const said = saidMap({ asked: { asked: [{
    product: 'Lumen Verify', text: 'Asked what Lumen Verify costs',
    quote: 'Roughly what would that add to the monthly bill for us?',
    at: iso(4), via: 'email_received', ageDays: 4,
  }] } });
  const { expansion } = classifyCustomers(accounts, health, { hasHealth: true, said });
  const top = expansion[0].expansionReasons[0];
  assert.equal(top.kind, 'they_asked');
  assert.equal(top.tier, 1);
  assert.equal(top.evidence, 'said');
  // The quote travels with it. A row a rep cannot read out loud is not worth showing.
  assert.match(top.quote, /add to the monthly bill/);
  assert.equal(top.via, 'they emailed');
});

test('a product they DECLINED is never pitched back to them', () => {
  const accounts = [acct('refused')];
  // The CRM says Lumen Value is available and unpriced-but-open. The customer said no on a call.
  const health = h({ refused: { status: 'client', mrr: 400, upgrade_products: ['Lumen Value', 'Lumen Bridge'] } });
  const said = saidMap({ refused: { declined: [{
    product: 'Lumen Value', text: 'Said they price everything in-house and have no need for it',
    quote: 'we already handle that part ourselves, thanks', at: iso(30), ageDays: 30,
  }] } });
  // Read off the row, not the list: products available is context and does not put an account on
  // the list by itself any more, but whatever the row shows a rep must not include the refusal.
  const { active } = classifyCustomers(accounts, health, { hasHealth: true, said });
  const text = active.flatMap(r => r.expansionReasons).map(x => x.text).join(' | ');
  assert.ok(!/\bLumen Value\b/.test(text), `Lumen Value was declined but still suggested: ${text}`);
  // ...and the other product they never refused is still fair game.
  assert.ok(/Lumen Bridge/.test(text), `the un-refused product should survive: ${text}`);
});

test('an ask outranks a stale CRM field, and the disagreement is shown not hidden', () => {
  // This is the case the whole mining pass exists for: the CRM says the upgrade was dropped or
  // never raised, and the customer asked anyway. The quote is dated; the field is not.
  for (const stage of ['Passed On', 'Never Raised']) {
    const accounts = [acct('conflict')];
    const health = h({ conflict: { status: 'client', mrr: 900, upgrade_stage: stage, upgrade_value: 250 } });
    const said = saidMap({ conflict: { asked: [{
      product: 'Lumen Bridge', text: 'Asked about adding Lumen Bridge for their second site',
      quote: 'is it possible to turn that on for our other office too', at: iso(10), via: 'call_made', ageDays: 10,
    }] } });
    const { expansion } = classifyCustomers(accounts, health, { hasHealth: true, said });
    assert.equal(expansion.length, 1, `${stage} should not suppress a dated ask`);
    const top = expansion[0].expansionReasons[0];
    assert.equal(top.kind, 'they_asked');
    assert.match(top.conflict, new RegExp(stage), `the conflict with the CRM must be surfaced for ${stage}`);
  }
});

test('an ask for something they have since bought is not resurfaced', () => {
  const accounts = [acct('bought')];
  const health = h({ bought: { status: 'client', mrr: 500, products: ['Ledger', 'Lumen Value'] } });
  const said = saidMap({ bought: { asked: [{
    product: 'Lumen Value', text: 'Asked about Lumen Value', quote: 'happy to give it a trial run',
    at: iso(20), ageDays: 20,
  }] } });
  const { expansion } = classifyCustomers(accounts, health, { hasHealth: true, said });
  assert.deepEqual(expansion, []);
});

test('a problem they raised on a call becomes a risk reason with its quote', () => {
  const accounts = [acct('unhappy')];
  const health = h({ unhappy: { status: 'client', mrr: 700, active_users_30d: 4 } });
  const said = saidMap({ unhappy: { risks: [{
    product: null, text: 'Reported the nightly export has failed since the upgrade',
    quote: 'the export has been empty every morning since you upgraded us', at: iso(6), via: 'call_received', ageDays: 6,
  }] } });
  // One mined risk is one tier-2 signal, so it does not carry the account onto the list alone --
  // but it must reach the row, with its quote. Pair it with a second tier-2 and it counts.
  const { active } = classifyCustomers(accounts, health, { hasHealth: true, said });
  const r = active[0].riskReasons.find(x => x.kind === 'they_said');
  assert.ok(r, 'a mined risk must reach the row');
  assert.match(r.quote, /export has been empty/);
  assert.equal(r.evidence, 'said');

  const paired = h({ unhappy: { status: 'client', mrr: 700, active_users_30d: 4, units_90d: 5, units_prev_90d: 90 } });
  const { atRisk } = classifyCustomers(accounts, paired, { hasHealth: true, said });
  assert.equal(atRisk.length, 1, 'a mined risk plus a usage collapse is a pattern');
});

test('with nothing mined the page behaves exactly as it did before', () => {
  const accounts = [acct('plain')];
  const health = h({ plain: { status: 'client', mrr: 300, upgrade_stage: 'Never Raised', upgrade_value: 150 } });
  const withOut = classifyCustomers(accounts, health, { hasHealth: true });
  const withEmpty = classifyCustomers(accounts, health, { hasHealth: true, said: saidMap({ plain: {} }) });
  assert.deepEqual(withOut.expansion.map(r => r.companyId), withEmpty.expansion.map(r => r.companyId));
  assert.deepEqual(
    withOut.active[0].expansionReasons.map(r => r.kind),
    withEmpty.active[0].expansionReasons.map(r => r.kind),
  );
});

// The reader's own guard, tested through the shape it actually receives. `classifyCustomers` takes
// the bucketed result, so these assert the contract between the two: what the miner is allowed to
// hand over, and what the page refuses to render as a pitch.
test('an ask with no product is not a lead and does not reach the page', () => {
  const accounts = [acct('vague')];
  const health = h({ vague: { status: 'client', mrr: 300 } });
  // The kind of output this guards against: "They asked to reschedule a meeting", tagged
  // expansion, no product. It must not become a row telling a rep to go and sell something.
  const said = saidMap({ vague: { asked: [{
    product: null, text: 'Asked to reschedule the meeting',
    quote: 'Busy week here, could we move Thursday to next week?', at: iso(5), ageDays: 5,
  }] } });
  const { expansion } = classifyCustomers(accounts, health, { hasHealth: true, said });
  assert.deepEqual(expansion, [], 'a product-less ask must not create an expansion row');
});

test('an ask goes stale; a decline does not', () => {
  const accounts = [acct('old'), acct('refused')];
  const health = h({
    old: { status: 'client', mrr: 200 },
    refused: { status: 'client', mrr: 200, upgrade_products: ['Lumen Value'] },
  });
  const said = saidMap({
    // 200 days: past the 90-day expansion window. An opening from two quarters ago is not an
    // opening, and showing it as one is how the list fills with things nobody can act on.
    old: { asked: [{ product: 'Lumen Value', text: 'Asked about Lumen Value', quote: 'could we add lumen value', at: iso(200), ageDays: 200 }] },
    // 200 days: still inside the 365-day decline window. A "no" outlives a "yes".
    refused: { declined: [{ product: 'Lumen Value', text: 'Said no to Lumen Value', quote: 'not for us', at: iso(200), ageDays: 200 }] },
  });
  const { expansion } = classifyCustomers(accounts, health, { hasHealth: true, said });
  const byId = new Map(expansion.map(r => [r.companyId, r]));
  assert.ok(!byId.has('old'), 'a 200-day-old ask should have decayed out');
  const stillRefused = byId.get('refused');
  const text = (stillRefused?.expansionReasons ?? []).map(x => x.text).join(' ');
  assert.ok(!/Lumen Value/.test(text), `a 200-day-old decline must still suppress Lumen Value: ${text}`);
});

test('a lost deal is never a risk reason', () => {
  // A closed sales event, not a threat to the relationship. They are still a customer and still
  // paying; what was lost was an attempt to sell them more. Churn is account_status and a
  // cancellation date. Carrying it here kept accounts red over something nobody can recover.
  const accounts = [acct('lost', { lostLast12m: true, wonDeals: 3 })];
  const health = h({ lost: { status: 'client', mrr: 600, active_users_30d: 5 } });
  const { active, atRisk } = classifyCustomers(accounts, health, { hasHealth: true });
  assert.equal(active.length, 1, 'still a customer');
  assert.deepEqual(atRisk, [], 'a lost deal must not put an account at risk');
  assert.deepEqual(active[0].riskReasons, [], 'and must not appear as a reason at all');
});

// ── GET-402: what they said is read by category, and ranked by how grave it is ──────────────

test('a stated cancellation is a tier-1 reason, beside a cancellation date; an invoice complaint is tier 3', () => {
  const accounts = [
    { companyId: 'leaving', name: 'Wexcombe', products: [], reasons: [] },
    { companyId: 'grumbling', name: 'Ombrière', products: [], reasons: [] },
  ];
  const health = new Map([['leaving', { status: 'client', mrr: 900 }], ['grumbling', { status: 'client', mrr: 900 }]]);
  const said = new Map([
    ['leaving', { asked: [], declined: [], risks: [{ text: 'Moving to another vendor at renewal', quote: "We're moving to another vendor at renewal", at: new Date().toISOString(), severity: 'stated_churn', ageDays: 2 }] }],
    ['grumbling', { asked: [], declined: [], risks: [{ text: 'Missing invoice', quote: "We never got last month's invoice", at: new Date().toISOString(), severity: 'friction', ageDays: 2 }] }],
  ]);
  const { atRisk } = classifyCustomers(accounts, health, { hasHealth: true, said });
  const leaving = atRisk.find(r => r.companyId === 'leaving');
  const grumbling = atRisk.find(r => r.companyId === 'grumbling');
  assert.ok(leaving, 'a stated cancellation puts the account on the list');
  assert.equal(leaving.riskReasons[0].tier, 1);
  assert.equal(leaving.riskReasons[0].kind, 'they_said_leaving');
  // Friction alone does not make the list: under the bar ("one tier-1, or two independent
  // tier-2"), tier 3 is context on a row and never the reason for it. It shows on the account's
  // row as a reason, ranked last, and the account stays on the active list.
  assert.equal(grumbling, undefined, 'an invoice complaint on its own is not a worklist row');
  const active = classifyCustomers(accounts, health, { hasHealth: true, said }).active.find(r => r.companyId === 'grumbling');
  assert.ok(active, 'still an active customer');
  assert.equal(active.riskReasons[0].tier, 3);
  assert.equal(active.riskReasons[0].kind, 'they_said');
});

// ── 2026-10-01: what is NOT evidence ────────────────────────────────────────────────────────

test('a to-do we owe them is never a risk reason, however many there are', () => {
  // "Turn on the valuation feed", "install the quote widget": an engaged customer, not a leaving one.
  // Two of these used to meet the two-reason bar and put dozens of accounts on the list on to-dos alone.
  const accounts = [acct('busy', { reasons: [
    { tier: 1, kind: 'owed', text: 'Turn on the valuation feed' },
    { tier: 1, kind: 'owed', text: 'Install the quote widget' },
    { tier: 1, kind: 'owed', text: 'Send the credentialing steps' },
  ] })];
  const health = h({ busy: { status: 'client', mrr: 400, active_users_30d: 3 } });
  const { atRisk, active } = classifyCustomers(accounts, health, { hasHealth: true });
  assert.deepEqual(atRisk, []);
  assert.ok(!active[0].riskReasons.some(r => r.kind === 'owed'), 'owed must not appear as a risk reason');
});

test('the CRM upgrade price alone is not an expansion opportunity, and $0 is not even context', () => {
  const accounts = [acct('priced'), acct('zero')];
  const health = h({
    priced: { status: 'client', mrr: 70, upgrade_stage: 'Never Raised', upgrade_value: 900, upgrade_products: ['Lumen Value'] },
    zero: { status: 'client', mrr: 1250, upgrade_stage: 'Never Raised', upgrade_value: 0, upgrade_products: ['Lumen Locate'] },
  });
  const { expansion, active } = classifyCustomers(accounts, health, { hasHealth: true });
  assert.deepEqual(expansion, []);
  const priced = active.find(r => r.companyId === 'priced');
  assert.equal(priced.expansionReasons[0].kind, 'upgrade_untouched');
  assert.equal(priced.expansionReasons[0].tier, 3, 'the price travels on the row as context');
  const zero = active.find(r => r.companyId === 'zero');
  assert.ok(!zero.expansionReasons.some(r => r.kind === 'upgrade_untouched'));
});

test('expansion has the same bar as risk: one tier-1, or two independent tier-2', () => {
  const accounts = [acct('motion'), acct('motion-and-heavy')];
  const health = h({
    motion: { status: 'client', mrr: 300, upgrade_stage: 'Quote Out', upgrade_value: 200 },
    'motion-and-heavy': { status: 'client', mrr: 150, usage_30d: 400, upgrade_stage: 'Quote Out', upgrade_value: 200 },
  });
  const { expansion } = classifyCustomers(accounts, health, { hasHealth: true });
  assert.deepEqual(expansion.map(r => r.companyId), ['motion-and-heavy']);
});

test('two risks read out of the same conversation are one piece of evidence, not two', () => {
  const accounts = [acct('one-call'), acct('two-calls')];
  const health = h({ 'one-call': { status: 'client', mrr: 400 }, 'two-calls': { status: 'client', mrr: 400 } });
  const risk = (ref, text) => ({ text, quote: text, at: iso(5), ageDays: 5, severity: 'at_risk', ref });
  const said = saidMap({
    'one-call': { risks: [risk('obs-1', 'Champion has left'), risk('obs-1', 'Reviewing other vendors')] },
    'two-calls': { risks: [risk('obs-2', 'Champion has left'), risk('obs-3', 'Reviewing other vendors')] },
  });
  const { atRisk } = classifyCustomers(accounts, health, { hasHealth: true, said });
  assert.deepEqual(atRisk.map(r => r.companyId), ['two-calls']);
});
