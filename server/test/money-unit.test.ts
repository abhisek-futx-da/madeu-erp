/**
 * Rupee arithmetic, in isolation. The audit's evidence was a test failure
 * printing 555407.2000000001 — money was being added as binary doubles across
 * five copy-pasted `round2` definitions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { paise, rupees, round2, sumMoney, sumBy, sameMoney, exceeds, amountInWords }
  from '../src/money.ts';

test('the half-paise case rounds up, not down', () => {
  // 1.005 * 100 is 100.49999999999999 in binary; a naive Math.round gives 1.00.
  assert.equal(round2(1.005), 1.01);
  assert.equal(round2(2.675), 2.68);
  assert.equal(round2(8.615), 8.62);
});

test('paise and rupees round-trip', () => {
  for (const n of [0, 0.01, 1, 99.99, 12345.67, 1_00_00_000.5]) {
    assert.equal(rupees(paise(n)), round2(n));
  }
});

test('a long column of money adds exactly', () => {
  const hundred = Array.from({ length: 100 }, () => 0.1);
  assert.equal(sumMoney(hundred), 10);
  // The same sum with doubles drifts.
  assert.notEqual(hundred.reduce((a, b) => a + b, 0), 10);
});

test('the invoice column that produced the bug now sums exactly', () => {
  const invoices = [15200, 24213.6, 16142.4, 16142.4, 6000, 15200, 9500, 5700, 6650, 4750];
  assert.equal(sumMoney(invoices), 119498.4);
  assert.equal(sumBy(invoices.map(v => ({ v })), r => r.v), 119498.4);
});

test('sumBy over an empty set is zero, not NaN', () => {
  assert.equal(sumBy([], (r: { v: number }) => r.v), 0);
});

test('comparison is by the paise, not by a hand-picked tolerance', () => {
  assert.ok(sameMoney(0.1 + 0.2, 0.3));
  assert.ok(!sameMoney(10, 10.01));
  assert.ok(exceeds(10.01, 10));
  assert.ok(!exceeds(10, 10));
  assert.ok(!exceeds(10.004, 10));
});

test('a non-finite value is refused rather than silently becoming zero', () => {
  assert.throws(() => paise(NaN));
  assert.throws(() => paise(Infinity));
});

test('amount in words uses the Indian scale', () => {
  assert.equal(amountInWords(0), 'Rupees Zero Only');
  assert.equal(amountInWords(1), 'Rupees One Only');
  assert.equal(amountInWords(15), 'Rupees Fifteen Only');
  assert.equal(amountInWords(100), 'Rupees One Hundred Only');
  assert.equal(amountInWords(1234), 'Rupees One Thousand Two Hundred Thirty Four Only');
  assert.equal(amountInWords(123456), 'Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six Only');
  assert.equal(
    amountInWords(12345678),
    'Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight Only'
  );
});

test('amount in words carries the paise', () => {
  assert.equal(amountInWords(15960.5), 'Rupees Fifteen Thousand Nine Hundred Sixty and Fifty Paise Only');
  assert.equal(amountInWords(0.05), 'Rupees Zero and Five Paise Only');
});

test('a credit note in words reads as a negative', () => {
  assert.match(amountInWords(-500), /^Minus Rupees Five Hundred/);
});
