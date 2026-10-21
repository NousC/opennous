// The chip on a claim is built by code where the category says what it is (GET-959).
//
// The extractor's free-text label mixed the thing with an opinion about it ("Bots vs Our Data",
// "Quillbox experimental chaos", "Pays to Fix CRM"), and a claim with no label showed a scrap of its
// sentence ("still work out"). Run: node --test packages/core/test/claimLabel.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimLabel } from '../dist/index.js';

const L = (category, content, extra = {}) => claimLabel({ category, content, ...extra });

test('a competitor chip is the competitor, in its one spelling', () => {
  assert.equal(L('competitor', 'Hollis Vane wants to compare the agents with us.', { label: 'Bots vs Our Data', metadata: { entity: 'Grok' } }), 'GrokBot');
  assert.equal(L('competitor', 'They looked at Pearl Lantern.', { label: 'Lantern trial', metadata: { entity: 'Pearl Lantern' } }), 'Pearl Lantern');
  // No name stored: the model's label stands.
  assert.equal(L('competitor', 'They are looking at another vendor.', { label: 'Another vendor', metadata: { entity: null } }), 'Another vendor');
});

test('a tech stack chip is the tool, not an opinion of it', () => {
  assert.equal(L('tech_stack', 'The bots are chaos.', { label: 'GrokBot experimental chaos', metadata: { tool: 'Grokbots' } }), 'GrokBot');
  assert.equal(L('tech_stack', 'Fellow beats the dialer at transcripts.', { label: 'Fellow Over JustCall', metadata: { tool: 'Fellow' } }), 'Fellow');
  assert.equal(L('tech_stack', 'Call intelligence was poor.', { label: 'Bad Call Intelligence', metadata: { tool: 'ring central' } }), 'RingCentral');
});

test('a budget chip is the amount, or says there is none yet', () => {
  assert.equal(L('budget', 'Budget is about $40k for this.', { label: 'Budget' }), '$40k');
  assert.equal(L('budget', 'They set aside money.', { label: 'Set aside', metadata: { quote: 'we have roughly €12,000 a year for it' } }), '€12,000 a year');
  assert.equal(L('budget', 'Hollis Vane says they will pay significant money to fix their CRM.', { label: 'Pays to Fix CRM' }), 'No number yet');
});

test('a stakeholder chip is the role, and says when the person is not named', () => {
  assert.equal(L('authority', "The company's CEO (name not yet known) drives the bot initiative.", { metadata: { role: 'decision_maker' } }), 'CEO · not named yet');
  assert.equal(L('authority', 'Hollis Vane signs off on tooling.', { metadata: { role: 'decision_maker' } }), 'Hollis Vane · Decision maker');
  assert.equal(L('authority', 'The CRO will review the results.', { metadata: { role: 'economic_buyer' } }), 'CRO · Budget holder');
  assert.equal(L('authority', 'Someone senior decides.', { metadata: { role: null } }), 'Someone senior decides.');
});

test('any other category keeps the model label', () => {
  assert.equal(L('pain', 'Reps type the upgrade fields by hand.', { label: 'Unreliable upgrade fields' }), 'Unreliable upgrade fields');
});

test('no label: a readable start of the fact, never a scrap', () => {
  assert.equal(L('blocker', 'Hollis Vane still has to work out how the product fits their plan before presenting it.'),
    'Has to work out how the product…');
  assert.equal(L('blocker', 'Hollis Vane does not yet know who to onboard onto the product.'),
    'Does not yet know who to onboard…');
  assert.equal(L('buying_signal', 'Hollis raised a managed service arrangement as a possibility.', { metadata: { speaker: 'Hollis Vane' } }),
    'Raised a managed service arrangement…');
  assert.equal(L('pain', "Hollis Vane's company Quillmere's upgrade fields are not reliable."),
    'Upgrade fields are not reliable.');
  assert.equal(L('goal', ''), 'Goal');
});

// From review: what the code-built chip must not do.
test('a stakeholder without a title or name keeps who it is', () => {
  assert.equal(L('authority', 'Sam is the champion.', { label: 'Sam champions', metadata: { role: 'champion' } }), 'Sam champions');
  assert.equal(L('authority', 'Maya Lin reports to the CEO and will champion the deal.', { label: 'Maya champions', metadata: { role: 'champion' } }), 'Maya champions');
  assert.equal(L('authority', 'Hollis is the product owner and decides.', { label: 'Hollis decides', metadata: { role: 'decision_maker' } }), 'Hollis decides');
  assert.equal(L('authority', 'Account Executive Sam pushes it internally.', { label: 'Sam pushes internally', metadata: { role: 'champion' } }), 'Sam pushes internally');
});

test('a budget with no number but a state keeps its label', () => {
  assert.equal(L('budget', 'Budget is frozen until Q3.', { label: 'Budget frozen until Q3' }), 'Budget frozen until Q3');
  assert.equal(L('budget', 'Budget approved for next year.', { label: 'Budget approved' }), 'Budget approved');
});

test('two capitalised words are a name only before something a person does', () => {
  assert.equal(L('pain', 'Google Sheets breaks every week for the ops team.'), 'Google Sheets breaks every week…');
  assert.equal(L('pain', 'New York office cannot see the pipeline.'), 'New York office cannot see the pipeline.');
});

test('markdown is stripped and a chip is never long', () => {
  assert.equal(L('pain', '**Key pain:**\n- reps re-type data into the CRM every day'), 'Key pain: reps re-type data into…');
  assert.ok(L('pain', 'x'.repeat(500)).length <= 61);
});

test('a stakeholder chip never names the person who only opened the sentence', () => {
  assert.equal(L('authority', 'Hollis Vane cannot switch off the bots because the CEO runs them.', { label: 'CEO drives the bots', metadata: { role: 'champion' } }), 'CEO drives the bots');
});

test('a Title Case label reads in sentence case, names kept', () => {
  assert.equal(L('goal', 'Wants to re-engage churned customers.', { label: 'Re-engage Churned Customers' }), 'Re-engage churned customers');
  assert.equal(L('goal', 'Wants a handoff to Kelsey when a demo closes.', { label: 'Kelsey Handoff Workflow' }), 'Kelsey handoff workflow');
  assert.equal(L('pain', 'HubSpot upgrade fields are typed by reps and unreliable.', { label: 'Unreliable HubSpot Fields' }), 'Unreliable HubSpot fields');
  assert.equal(L('status_quo', 'CS works in motions.', { label: 'CS Motions List' }), 'CS motions list');
  // A word the sentence never writes in lowercase keeps its capital: it may be a name.
  assert.equal(L('goal', 'Wants a weekly view.', { label: 'Weekly Rev Ops Triage' }), 'Weekly Rev Ops triage');
});

test('small words go lowercase, and a capital at the start of a sentence is not a name', () => {
  assert.equal(L('objection', 'Hollis Vane is not expecting a silver bullet.', { label: 'Not A Silver Bullet' }), 'Not a silver bullet');
  assert.equal(L('pain', 'Lead generation is not very strong.', { label: 'Weak Lead Generation' }), 'Weak lead generation');
  assert.equal(L('status_quo', 'All product metrics are pushed into the CRM.', { label: 'Product Metrics In CRM' }), 'Product metrics in CRM');
});
