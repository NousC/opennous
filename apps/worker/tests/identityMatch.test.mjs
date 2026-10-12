import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  domainRoot, emailDomain, normalizeCompanyToken, corroboratesIdentity, FREE_EMAIL_DOMAINS,
} from '../src/utils/identityMatch.mjs';

test('domainRoot extracts the second-level label', () => {
  assert.equal(domainRoot('northwind.example'), 'northwind');
  assert.equal(domainRoot('www.Northwind.EXAMPLE'), 'northwind');
  // co.uk is kept on purpose: the case is a two-label public suffix, which .example cannot show.
  assert.equal(domainRoot('mail.acme.co.uk'), 'acme');
  assert.equal(domainRoot('acme.example'), 'acme');
  assert.equal(domainRoot(''), null);
  assert.equal(domainRoot(null), null);
});

test('emailDomain pulls the lowercased domain', () => {
  assert.equal(emailDomain('Jordan.Reed@Northwind.EXAMPLE'), 'northwind.example');
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
  assert.equal(corroboratesIdentity(a, 'northwind.example'), true);
});

test('different company: northwind.example does NOT corroborate against Globex Future Labs', () => {
  const b = { domain: null, company: 'Globex Future Labs 🌐', emailDomains: [] };
  assert.equal(corroboratesIdentity(b, 'northwind.example'), false);
});

test('free/personal email domains never corroborate', () => {
  const c = { domain: 'northwind.example', company: 'NORTHWIND', emailDomains: ['northwind.example'] };
  for (const d of ['gmail.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'gmx.de']) {
    assert.equal(corroboratesIdentity(c, d), false, `${d} should not corroborate`);
  }
  assert.ok(FREE_EMAIL_DOMAINS.has('gmail.com'));
});

test('stored company domain corroborates', () => {
  const c = { domain: 'acme.example', company: null, emailDomains: [] };
  assert.equal(corroboratesIdentity(c, 'acme.example'), true);
  assert.equal(corroboratesIdentity(c, 'other.example'), false);
});

test('another known email at the same domain corroborates', () => {
  const c = { domain: null, company: null, emailDomains: ['jane@nope'.split('@')[1], 'acme.example'] };
  assert.equal(corroboratesIdentity(c, 'acme.example'), true);
});

test('short company tokens do not over-match via prefix', () => {
  // company "Co" → token "" after suffix strip → no corroboration on a random domain
  const c = { domain: null, company: 'Co', emailDomains: [] };
  assert.equal(corroboratesIdentity(c, 'northwind.example'), false);
});

test('missing incoming domain is safe', () => {
  assert.equal(corroboratesIdentity({ company: 'NORTHWIND' }, null), false);
  assert.equal(corroboratesIdentity({ company: 'NORTHWIND' }, ''), false);
});

import { companyDomainFromEmail, isFreeEmailDomain } from '@nous/core';

test('companyDomainFromEmail suppresses free/personal mailboxes', () => {
  assert.equal(companyDomainFromEmail('test.user.0004@gmail.com'), null);
  assert.equal(companyDomainFromEmail('jordan@web.de'), null);
  assert.equal(companyDomainFromEmail('a@outlook.com'), null);
});

test('companyDomainFromEmail keeps real company domains', () => {
  assert.equal(companyDomainFromEmail('jane@acme.example'), 'acme.example');
  assert.equal(companyDomainFromEmail('Jane@ACME.EXAMPLE'), 'acme.example');
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
  assert.equal(isFreeEmailDomain('acme.example'), false);
});
