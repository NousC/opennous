// Scorecard rule matching — the layer that decides whether a signal fires at all.
//
// The bug this pins down: rules are authored lowercase ('head of sales') and enrichment
// stores titles as written ('Head of Sales'), so an exact match meant the role rules never
// fired and the lead fell to the 50 baseline with "no signals matched this profile".
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/scorecardMatch.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreLead } from '../dist/icp/scorecard.js';

const signal = (key, rule, weight = 8) => ({
  id: key, workspace_id: 'w', key, label: key, weight, rule,
  coverage: 0, added_in: null, active: true, layer: 'fit', manual: false,
  created_at: null, updated_at: null,
});

const GTM_LEADER = signal('gtm_leader', {
  feature: 'job_title', op: 'in',
  value: ['head of gtm', 'head of sales', 'vp sales', 'chief revenue officer'],
});

test('a title stored as written fires a rule authored in lowercase', () => {
  const { fired } = scoreLead({ job_title: 'Head of Sales' }, [GTM_LEADER]);
  assert.deepEqual(fired.map(f => f.key), ['gtm_leader']);
});

test('surrounding whitespace is not signal either', () => {
  assert.equal(scoreLead({ job_title: '  VP Sales ' }, [GTM_LEADER]).fired.length, 1);
});

test('a title that genuinely does not match still does not fire', () => {
  assert.equal(scoreLead({ job_title: 'Head of Engineering' }, [GTM_LEADER]).fired.length, 0);
  assert.equal(scoreLead({}, [GTM_LEADER]).fired.length, 0);
});

test('== and != compare case-insensitively for strings', () => {
  const isAgency = signal('agency', { feature: 'industry', op: '==', value: 'agency' });
  const notAgency = signal('not_agency', { feature: 'industry', op: '!=', value: 'agency' }, 3);
  assert.equal(scoreLead({ industry: 'Agency' }, [isAgency]).fired.length, 1);
  assert.equal(scoreLead({ industry: 'Agency' }, [notAgency]).fired.length, 0);
  assert.equal(scoreLead({ industry: 'SaaS' }, [notAgency]).fired.length, 1);
});

test('numbers and booleans keep exact comparison', () => {
  const small = signal('small', { feature: 'employee_count', op: '<=', value: 50 }, 4);
  assert.equal(scoreLead({ employee_count: 20 }, [small]).fired.length, 1);
  assert.equal(scoreLead({ employee_count: 500 }, [small]).fired.length, 0);
  const inbound = signal('inbound', { feature: 'pipe.inbound', op: '==', value: true }, 2);
  assert.equal(scoreLead({ 'pipe.inbound': true }, [inbound]).fired.length, 1);
  assert.equal(scoreLead({ 'pipe.inbound': false }, [inbound]).fired.length, 0);
});
