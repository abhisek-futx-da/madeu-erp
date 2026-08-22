/**
 * TDS threshold arithmetic, pure and database-free. The two bases behave
 * differently and getting them the wrong way round under-deducts, which is the
 * mill's liability, not the supplier's.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDeduction, type Section } from '../src/tds.ts';

const s194c: Section = {
  code: '194C-OTH', kind: 'tds', rate: 2, rate_no_pan: 20,
  threshold: 100000, basis: 'full_once_crossed'
};

const s194q: Section = {
  code: '194Q', kind: 'tds', rate: 0.1, rate_no_pan: 5,
  threshold: 5000000, basis: 'excess_over_threshold'
};

test('194C deducts nothing until the annual threshold is crossed', () => {
  assert.equal(computeDeduction(s194c, 0, 40000, true), null);
  assert.equal(computeDeduction(s194c, 40000, 30000, true), null);
});

test('194C charges the whole cumulative amount on the document that crosses', () => {
  // 70,000 already paid, now 40,000 more: crossing 1,00,000 pulls in all 1,10,000.
  const d = computeDeduction(s194c, 70000, 40000, true);
  assert.ok(d);
  assert.equal(d.chargeable, 110000);
  assert.equal(d.amount, 2200);
});

test('194C charges only the new amount once already past the threshold', () => {
  const d = computeDeduction(s194c, 150000, 50000, true);
  assert.ok(d);
  assert.equal(d.chargeable, 50000);
  assert.equal(d.amount, 1000);
});

test('194Q charges only the slice above the threshold', () => {
  // 48 lakh already, now 5 lakh: only 3 lakh sits above 50 lakh.
  const d = computeDeduction(s194q, 4800000, 500000, true);
  assert.ok(d);
  assert.equal(d.chargeable, 300000);
  assert.equal(d.amount, 300);
});

test('194Q charges the full document once wholly above the threshold', () => {
  const d = computeDeduction(s194q, 6000000, 1000000, true);
  assert.ok(d);
  assert.equal(d.chargeable, 1000000);
  assert.equal(d.amount, 1000);
});

test('194Q deducts nothing below the threshold', () => {
  assert.equal(computeDeduction(s194q, 1000000, 2000000, true), null);
});

test('a missing PAN attracts the higher rate', () => {
  const withPan = computeDeduction(s194c, 200000, 50000, true);
  const without = computeDeduction(s194c, 200000, 50000, false);
  assert.ok(withPan && without);
  assert.equal(withPan.rate, 2);
  assert.equal(without.rate, 20);
  assert.equal(without.amount, 10000);
});

test('the two bases genuinely differ at the crossing document', () => {
  const crossing = 40000;
  const prior = 70000;
  const full = computeDeduction(s194c, prior, crossing, true);
  const excess = computeDeduction(
    { ...s194c, basis: 'excess_over_threshold' }, prior, crossing, true
  );
  assert.ok(full && excess);
  assert.equal(full.chargeable, 110000);
  assert.equal(excess.chargeable, 10000, 'excess basis charges only the part above');
  assert.notEqual(full.amount, excess.amount);
});

test('amounts are rounded to paise, never left to drift', () => {
  const d = computeDeduction({ ...s194q, threshold: 0 }, 0, 33333.33, true);
  assert.ok(d);
  assert.equal(d.amount, 33.33);
  assert.equal(Math.round(d.amount * 100) / 100, d.amount);
});

test('a zero-value document deducts nothing', () => {
  assert.equal(computeDeduction({ ...s194q, threshold: 0 }, 0, 0, true), null);
});
