/**
 * Rupee arithmetic. Money leaves Postgres as `numeric(14,2)` and arrives here
 * as a JS double, which cannot add exactly: summing a page of invoices used to
 * produce 555407.2000000001. Everything below works in integer paise and only
 * returns to rupees at the boundary.
 *
 * This file exists because `round2` had been copy-pasted into five modules.
 */

/**
 * Rupees to paise. `n * 100` alone is wrong for the classic half-paise case —
 * 1.005 * 100 is 100.49999999999999 in binary, so Math.round gives 100, not
 * 101. Trimming to 15 significant digits first removes the artifact without
 * touching any figure a mill could actually bill.
 */
export function paise(n: number): number {
  if (!Number.isFinite(n)) throw new Error(`not a money value: ${n}`);
  return Math.round(Number((n * 100).toPrecision(15)));
}

export const rupees = (p: number): number => p / 100;

/** Rounds to the paise a `numeric(14,2)` column can actually hold. */
export const round2 = (n: number): number => rupees(paise(n));

/** Adds money without accumulating binary error. */
export const sumMoney = (values: number[]): number =>
  rupees(values.reduce((total, n) => total + paise(n), 0));

/** Sums a projection of rows — the shape almost every caller actually wants. */
export const sumBy = <T>(rows: readonly T[], pick: (row: T) => number): number =>
  sumMoney(rows.map(pick));

/**
 * Two amounts are the same money if they agree to the paise. Comparing with a
 * hand-picked 0.005 tolerance in a dozen places is how rounding bugs hide.
 */
export const sameMoney = (a: number, b: number): boolean => paise(a) === paise(b);

/** True when `a` exceeds `b` by at least one paise. */
export const exceeds = (a: number, b: number): boolean => paise(a) > paise(b);

/**
 * Divides an amount across weights without losing or inventing a paise — or,
 * since a length is stored to two places too, a centimetre. Cutting a
 * ₹3,601.00 thaan into three equal rolls is ₹1,200.333… each; naive rounding
 * gives three times ₹1,200.33 and a paise vanishes from the balance sheet.
 * Largest remainder: floor every share, then hand the leftover to the shares
 * that were cut hardest.
 */
export function apportion(amount: number, weights: number[]): number[] {
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (!(total > 0)) throw new Error('cannot apportion across zero weight');

  const cents = paise(amount);
  const exact = weights.map(w => (cents * w) / total);
  const shares = exact.map(Math.floor);

  let spare = cents - shares.reduce((sum, n) => sum + n, 0);
  const neediest = exact
    .map((e, i) => ({ i, remainder: e - Math.floor(e) }))
    .sort((a, b) => b.remainder - a.remainder);
  for (const { i } of neediest) {
    if (spare === 0) break;
    shares[i]! += Math.sign(spare);
    spare -= Math.sign(spare);
  }
  return shares.map(rupees);
}

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen',
  'Eighteen', 'Nineteen'
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigits(n: number): string {
  if (n < 20) return ONES[n] ?? '';
  const tens = TENS[Math.floor(n / 10)] ?? '';
  const unit = ONES[n % 10] ?? '';
  return unit ? `${tens} ${unit}` : tens;
}

/**
 * Amount in words on the Indian scale — a tax invoice is not valid without it.
 * Lakh and crore, not million: "One Lakh Twenty Three Thousand".
 */
export function amountInWords(amount: number): string {
  const total = paise(Math.abs(amount));
  const whole = Math.floor(total / 100);
  const fraction = total % 100;

  const groups: [number, string][] = [
    [10_000_000, 'Crore'], [100_000, 'Lakh'], [1_000, 'Thousand'], [100, 'Hundred']
  ];

  let left = whole;
  const parts: string[] = [];
  for (const [size, label] of groups) {
    const count = Math.floor(left / size);
    if (count > 0) {
      parts.push(`${twoDigits(count)} ${label}`);
      left -= count * size;
    }
  }
  if (left > 0) parts.push(twoDigits(left));

  const rupeeWords = parts.length > 0 ? parts.join(' ') : 'Zero';
  const sign = amount < 0 ? 'Minus ' : '';
  const paiseWords = fraction > 0 ? ` and ${twoDigits(fraction)} Paise` : '';
  return `${sign}Rupees ${rupeeWords}${paiseWords} Only`;
}
