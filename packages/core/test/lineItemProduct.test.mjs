// A line item's PRODUCT is its provider id, never the name a rep typed.
//
// Measured on a live portal: dozens of real products filed under many more names, a large share split
// ("QuickLane" / "Lumen Tag 2.0 Check" / "Lumen QuickLane (West)" are one product). Grouping on
// the name turns one product with four buyers into three products with one buyer each, which
// clears no peer threshold — so the cross-sell finding is never made, and the empty result
// reads as "no opportunity here" rather than as a miscount. That is the failure these guard.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/lineItemProduct.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineItemProduct, commerceRecordToValue } from '../dist/integrations/crm/index.js';

test('one product id is one product, whatever it was named', () => {
  const a = lineItemProduct({ name: 'QuickLane', hs_product_id: 31000000017 });        // numeric on the way in
  const b = lineItemProduct({ name: 'Lumen QuickLane (West)', hs_product_id: '31000000017' });
  const c = lineItemProduct({ name: 'Lumen Tag 2.0 Check', product_key: '31000000017' });
  assert.equal(a.key, b.key);
  assert.equal(b.key, c.key);
  // The key groups; the label is what a human reads. Both names survive for the caller to pick.
  assert.equal(a.label, 'QuickLane');
  assert.equal(b.label, 'Lumen QuickLane (West)');
});

test('no product id: each item keeps its own identity, never a shared bucket', () => {
  // Invented ad-hoc rows of the kind reps type. Absent an id, we have no grounds to call any two
  // the same product — merging them would invent a peer group that does not exist.
  const rows = ['Spring discount', 'Onboarding package - $500', 'Lumen Sync', 'Extra seat (annual)'];
  const keys = new Set(rows.map(name => lineItemProduct({ name }).key));
  assert.equal(keys.size, rows.length);
});

test('a name that looks like an id does not merge with that id', () => {
  assert.notEqual(
    lineItemProduct({ name: '31000000029' }).key,
    lineItemProduct({ name: 'Lumen Finance', hs_product_id: '31000000029' }).key,
  );
});

test('name folding is whitespace only — it never edits the name itself', () => {
  assert.equal(lineItemProduct({ name: '  Lumen   Pro  ' }).key, 'name:lumen pro');
  // Guards a regex slip that ate every "s": "Lumen Pro seat" must not fold to "lumen pro eat".
  assert.equal(lineItemProduct({ name: 'Lumen Pro seat' }).key, 'name:lumen pro seat');
  // A region suffix is NOT stripped. Without an id from the CRM, "(West)" might be a real
  // separate SKU, and deciding otherwise would be Nous asserting a fact the CRM never gave us.
  assert.notEqual(
    lineItemProduct({ name: 'Lumen Complete' }).key,
    lineItemProduct({ name: 'Lumen Complete (West)' }).key,
  );
});

test('never returns a blank label, and never invents a product', () => {
  assert.equal(lineItemProduct({ hs_sku: 'PRO' }).label, 'PRO');
  assert.equal(lineItemProduct({ hs_product_id: '7' }).label, '7');   // last resort, but readable
  assert.equal(lineItemProduct(null), null);
  assert.equal(lineItemProduct({}), null);
});

test('the sync records product_key, so a reader never needs a provider field name', () => {
  const li = commerceRecordToValue('line_items', {
    id: '9', properties: { name: 'Lumen Pro', hs_product_id: '31000000031', quantity: '2', price: '250' },
  });
  assert.equal(li.product_key, '31000000031');
  assert.equal(lineItemProduct(li).key, 'id:31000000031');

  // Looked and found nothing is recorded as null — distinct from an older row that predates
  // the field, which has no product_key at all and falls back to hs_product_id.
  const adhoc = commerceRecordToValue('line_items', { id: '10', properties: { name: '25%' } });
  assert.equal(adhoc.product_key, null);
  assert.equal(lineItemProduct(adhoc).key, 'name:25%');

  // Only line items carry it: an invoice has no product.
  const inv = commerceRecordToValue('invoices', { id: '1', properties: { hs_invoice_number: 'INV-7' } });
  assert.equal('product_key' in inv, false);
});

test('the catalog names the product; a typed name is only the fallback', () => {
  const catalog = new Map([['31000000017', 'Lumen QuickLane (West)']]);
  const li = commerceRecordToValue('line_items', {
    id: '9', properties: { name: 'QuickLane', hs_product_id: '31000000017' },   // what a rep typed
  }, catalog);
  assert.equal(li.product_name, 'Lumen QuickLane (West)');

  const p = lineItemProduct(li);
  assert.equal(p.label, 'Lumen QuickLane (West)');
  assert.equal(p.canonical, true);        // the caller can tell a real name from a popular typo
  assert.equal(p.key, 'id:31000000017');  // naming never changes the grouping
});

test('a product the catalog does not have falls back, and says so', () => {
  // Confirmed live: one of the product ids selling on the measured portal was hard-deleted,
  // so the catalog cannot name it. The line item still has to be readable.
  const li = commerceRecordToValue('line_items', {
    id: '9', properties: { name: 'Lumen Legacy', hs_product_id: '31000000043' },
  }, new Map());
  assert.equal(li.product_name, null);
  const p = lineItemProduct(li);
  assert.equal(p.label, 'Lumen Legacy');
  assert.equal(p.canonical, false);
});

test('rows synced before the catalog existed still work', () => {
  // No product_name key at all — the shape written by earlier syncs. It must still group by id.
  const old = { name: 'Pairwise', hs_product_id: 31000000055, quantity: 1 };
  const p = lineItemProduct(old);
  assert.equal(p.key, 'id:31000000055');
  assert.equal(p.label, 'Pairwise');
  assert.equal(p.canonical, false);
});

test('no catalog passed at all: the sync still records line items', () => {
  const li = commerceRecordToValue('line_items', { id: '9', properties: { name: 'Lumen Pro', hs_product_id: '7' } });
  assert.equal(li.product_key, '7');
  assert.equal(li.product_name, null);
  assert.equal(lineItemProduct(li).label, 'Lumen Pro');
});
