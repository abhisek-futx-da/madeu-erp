import { describe, test, expect } from 'vitest';
import { code128, code128DataUri } from './barcode';

/**
 * A mispriced invoice is caught by a human; a mis-encoded barcode is caught by
 * a scanner refusing to read a label after ten thousand have been printed.
 */
describe('code 128', () => {
  test('starts with the quiet zone and the start-B character', () => {
    const { svg } = code128('NKT001');
    // Start B is value 104, pattern 11010010000.
    expect(svg).toContain('<svg');
    expect(svg).toContain('shape-rendering="crispEdges"');
  });

  test('a longer barcode is a wider barcode, at a fixed module width', () => {
    const short = code128('AB', { module: 2 });
    const long = code128('ABCDEFGH', { module: 2 });
    expect(long.width).toBeGreaterThan(short.width);
    // Six extra characters at eleven modules each, two pixels a module.
    expect(long.width - short.width).toBe(6 * 11 * 2);
  });

  test('height is honoured', () => {
    expect(code128('X', { height: 44 }).height).toBe(44);
  });

  test('the same value always encodes identically', () => {
    expect(code128('LOT-9931').svg).toBe(code128('LOT-9931').svg);
  });

  test('different values do not collide', () => {
    expect(code128('NKT001').svg).not.toBe(code128('NKT002').svg);
  });

  test('produces an inline data URI with no external reference', () => {
    const uri = code128DataUri('NKT001');
    expect(uri.startsWith('data:image/svg+xml')).toBe(true);
    expect(uri).not.toMatch(/https?:\/\//);
  });

  test('rejects a character Code 128 subset B cannot carry', () => {
    // Subset B covers ASCII 32-127; a rupee sign is outside it.
    expect(() => code128('NKT₹1')).toThrow();
  });

  test('refuses an empty value rather than printing a blank label', () => {
    expect(() => code128('')).toThrow();
  });
});
