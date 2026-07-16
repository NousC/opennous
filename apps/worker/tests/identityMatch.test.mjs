import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  domainRoot, emailDomain, normalizeCompanyToken, corroboratesIdentity, FREE_EMAIL_DOMAINS,
} from '../src/utils/identityMatch.mjs';

test('domainRoot extracts the second-level label', () => {
  assert.equal(domainRoot('northwind.io'), 'northwind');
  assert.equal(domainRoot('www.Northwind.IO'), 'northwind');
  assert.equal(domainRoot('mail.acme.co.uk'), 'acme');
  assert.equal(domainRoot('acme.com'), 'acme');
  assert.equal(domainRoot(''), null);
  assert.equal(domainRoot(null), null);
});

test('emailDomain pulls the lowercased domain', () => {
  assert.equal(emailDomain('Jordan.Reed@Northwind.IO'), 'northwind.io');
  assert.equal(emailDomain('no-at-sign'), null);
});

test('normalizeCompanyToken collapses to a comparable token', () => {
  assert.equal(normalizeCompanyToken('NORTHWIND'), 'northwind');
  assert.equal(normalizeCompanyToken('Globex Future Labs 🌐'), 'globexfuture');
  assert.equal(normalizeCompanyToken('Acme, Inc.'), 'acme');
  assert.equal(normalizeCompanyToken('Foo Technologies'), 'foo');
});

test('same-name, matching company-domain corroborates against company NORTHWIND', () => {
  const a = { domain: null, company: 'NORTHWIND', emailDomains: ['outlook.com'] };
  assert.equal(corroboratesIdentity(a, 'northwind.io'), true);
});

test('different company: northwind.io does NOT corroborate against Globex Future Labs', () => {
  const b = { domain: null, company: 'Globex Future Labs 🌐', emailDomains: [] };
  assert.equal(corroboratesIdentity(b, 'northwind.io'), false);
});

test('free/personal email domains never corroborate', () => {
  const c = { domain: 'northwind.io', company: 'NORTHWIND', emailDomains: ['northwind.io'] };
  for (const d of ['gmail.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'gmx.de']) {
    assert.equal(corroboratesIdentity(c, d), false, `${d} should not corroborate`);
  }
  assert.ok(FREE_EMAIL_DOMAINS.has('gmail.com'));
});

test('stored company domain corroborates', () => {
  const c = { domain: 'acme.com', company: null, emailDomains: [] };
  assert.equal(corroboratesIdentity(c, 'acme.com'), true);
  assert.equal(corroboratesIdentity(c, 'other.com'), false);
});

test('another known email at the same domain corroborates', () => {
  const c = { domain: null, company: null, emailDomains: ['jane@nope'.split('@')[1], 'acme.com'] };
  assert.equal(corroboratesIdentity(c, 'acme.com'), true);
});

test('short company tokens do not over-match via prefix', () => {
  // company "Co" → token "" after suffix strip → no corroboration on a random domain
  const c = { domain: null, company: 'Co', emailDomains: [] };
  assert.equal(corroboratesIdentity(c, 'northwind.io'), false);
});

test('missing incoming domain is safe', () => {
  assert.equal(corroboratesIdentity({ company: 'NORTHWIND' }, null), false);
  assert.equal(corroboratesIdentity({ company: 'NORTHWIND' }, ''), false);
});

import { companyDomainFromEmail, isFreeEmailDomain } from '@nous/core';

test('companyDomainFromEmail suppresses free/personal mailboxes', () => {
  assert.equal(companyDomainFromEmail('alexrivera@gmail.com'), null);
  assert.equal(companyDomainFromEmail('jordan@gmx.de'), null);
  assert.equal(companyDomainFromEmail('a@outlook.com'), null);
});

test('companyDomainFromEmail keeps real company domains', () => {
  assert.equal(companyDomainFromEmail('jane@acme.io'), 'acme.io');
  assert.equal(companyDomainFromEmail('Jane@ACME.IO'), 'acme.io');
  assert.equal(companyDomainFromEmail('x@mail.acme.co.uk'), 'mail.acme.co.uk');
});

test('companyDomainFromEmail handles malformed input', () => {
  assert.equal(companyDomainFromEmail(null), null);
  assert.equal(companyDomainFromEmail('garbage'), null);
  assert.equal(companyDomainFromEmail(''), null);
});

test('isFreeEmailDomain', () => {
  assert.equal(isFreeEmailDomain('gmail.com'), true);
  assert.equal(isFreeEmailDomain('WWW.Gmail.com'), true);
  assert.equal(isFreeEmailDomain('acme.io'), false);
});
