// Personal vs company sources (GET-232): which tools are whose, and who may see or change
// a connection.
//
// Run: node --test apps/api/tests/sourceScope.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceScope, canSeeConnection, canManageConnection } from '../src/providers/sourceScope.mjs';

test('mailbox, calendar, LinkedIn, booking pages and note-takers are personal', () => {
  for (const [name, cat] of [
    ['gmail_oauth', 'communication'], ['google_calendar', 'communication'], ['smtp', 'communication'],
    ['linkedin', null], ['calendly', 'meetings'], ['cal_com', 'meetings'],
    ['fireflies', 'meetings'], ['fathom', 'meetings'], ['granola', 'meetings'],
  ]) assert.equal(sourceScope(name, cat), 'personal', name);
});

test('Fellow is a company source even though it is a note-taker', () => {
  // A Super Admin key reads the whole Fellow workspace, so one connection covers the team.
  assert.equal(sourceScope('fellow', 'meetings'), 'company');
});

test('RingCentral is a company source: one service-user JWT reads the whole company call log', () => {
  assert.equal(sourceScope('ringcentral', 'meetings'), 'company');
});

test('the catalogue and the source rule agree on every provider', async () => {
  // Two places derive "whose tool is this": the catalogue (onboarding lists, the DB column)
  // and sourceScope (the Sources pages, permissions). They must never disagree.
  const { CATALOGUE, scopeOf } = await import('../src/providers/catalogue.mjs');
  for (const [name, p] of Object.entries(CATALOGUE)) {
    const fromCatalogue = scopeOf(name) === 'workspace' ? 'company' : 'personal';
    const fromRule = sourceScope(name, p.category);
    if (p.hidden) continue;
    assert.equal(fromRule, fromCatalogue, `${name}: sourceScope says ${fromRule}, catalogue says ${fromCatalogue}`);
  }
});

test('CRMs, outbound tools, Slack and billing are company sources', () => {
  for (const [name, cat] of [
    ['hubspot', 'crm'], ['attio', 'crm'], ['salesforce', 'crm'], ['instantly', 'outbound'],
    ['heyreach', 'outbound'], ['slack', 'communication'], ['stripe', null], ['apollo', 'enrichment'],
  ]) assert.equal(sourceScope(name, cat), 'company', name);
});

const THEO = 'u-theo', AVERY = 'u-avery';

test("a teammate's personal source is invisible, even to an admin", () => {
  const conn = { scope: 'personal', ownerUserId: AVERY };
  assert.equal(canSeeConnection({ ...conn, viewerUserId: AVERY, viewerIsAdmin: false }), true);
  assert.equal(canSeeConnection({ ...conn, viewerUserId: THEO, viewerIsAdmin: true }), false);
  assert.equal(canManageConnection({ ...conn, viewerUserId: THEO, viewerIsAdmin: true }), false);
  assert.equal(canManageConnection({ ...conn, viewerUserId: AVERY, viewerIsAdmin: false }), true);
});

test('everyone sees a company source; only admins change it', () => {
  const conn = { scope: 'company', ownerUserId: AVERY };
  assert.equal(canSeeConnection({ ...conn, viewerUserId: THEO, viewerIsAdmin: false }), true);
  assert.equal(canManageConnection({ ...conn, viewerUserId: THEO, viewerIsAdmin: false }), false);
  assert.equal(canManageConnection({ ...conn, viewerUserId: AVERY, viewerIsAdmin: false }), false);
  assert.equal(canManageConnection({ ...conn, viewerUserId: THEO, viewerIsAdmin: true }), true);
});

test('a personal source with no recorded owner is left to admins to clean up', () => {
  const conn = { scope: 'personal', ownerUserId: null };
  assert.equal(canSeeConnection({ ...conn, viewerUserId: THEO, viewerIsAdmin: false }), false);
  assert.equal(canSeeConnection({ ...conn, viewerUserId: THEO, viewerIsAdmin: true }), true);
});
