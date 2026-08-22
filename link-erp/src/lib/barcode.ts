/**
 * Code 128 (subset B/C) rendered as inline SVG. No external library, because a
 * label must print from a locked-down browser with no CDN reachable — and a
 * barcode system that cannot print its own barcodes is not a barcode system.
 *
 * Encoding follows the Code 128 specification: start character, data, a
 * modulo-103 weighted checksum, then stop.
 */

// Bar/space widths for values 0-106, as published in the Code 128 tables.
const PATTERNS = [
  '11011001100','11001101100','11001100110','10010011000','10010001100','10001001100',
  '10011001000','10011000100','10001100100','11001001000','11001000100','11000100100',
  '10110011100','10011011100','10011001110','10111001100','10011101100','10011100110',
  '11001110010','11001011100','11001001110','11011100100','11001110100','11101101110',
  '11101001100','11100101100','11100100110','11101100100','11100110100','11100110010',
  '11011011000','11011000110','11000110110','10100011000','10001011000','10001000110',
  '10110001000','10001101000','10001100010','11010001000','11000101000','11000100010',
  '10110111000','10110001110','10001101110','10111011000','10111000110','10001110110',
  '11101110110','11010001110','11000101110','11011101000','11011100010','11011101110',
  '11101011000','11101000110','11100010110','11101101000','11101100010','11100011010',
  '11101111010','11001000010','11110001010','10100110000','10100001100','10010110000',
  '10010000110','10000101100','10000100110','10110010000','10110000100','10011010000',
  '10011000010','10000110100','10000110010','11000010010','11001010000','11110111010',
  '11000010100','10001111010','10100111100','10010111100','10010011110','10111100100',
  '10011110100','10011110010','11110100100','11110010100','11110010010','11011011110',
  '11011110110','11110110110','10101111000','10100011110','10001011110','10111101000',
  '10111100010','11110101000','11110100010','10111011110','10111101110','11101011110',
  '11110101110','11110101111','11110101111','11110101111'
];

const STOP = '1100011101011';
const START_B = 104;

export interface BarcodeSvg {
  svg: string;
  width: number;
  height: number;
}

/** Encodes `value` as Code 128B and returns a self-contained SVG string. */
export function code128(value: string, opts: { height?: number; module?: number } = {}): BarcodeSvg {
  const height = opts.height ?? 48;
  const module = opts.module ?? 2;

  if (value.length === 0) throw new Error('nothing to encode');

  /**
   * Silently dropping what subset B cannot carry would print a label whose
   * barcode scans as a different piece than the one it is stuck to. Refuse
   * instead: a missing label is a visible problem, a wrong one is not.
   */
  const unencodable = [...value].filter(c => {
    const code = c.charCodeAt(0);
    return code < 32 || code > 126;
  });
  if (unencodable.length > 0) {
    throw new Error(
      `Code 128 subset B cannot encode ${unencodable.map(c => JSON.stringify(c)).join(', ')} ` +
      `in "${value}"`
    );
  }

  const codes: number[] = [START_B];
  for (const ch of value) codes.push(ch.charCodeAt(0) - 32);

  // Modulo-103 checksum, weighted by position.
  let checksum = START_B;
  for (let i = 1; i < codes.length; i++) checksum += codes[i]! * i;
  codes.push(checksum % 103);

  const bits = codes.map(c => PATTERNS[c] ?? PATTERNS[0]!).join('') + STOP;

  let x = 0;
  const rects: string[] = [];
  let run = 0;
  for (let i = 0; i < bits.length; i++) {
    const bit = bits[i];
    const next = bits[i + 1];
    run += 1;
    if (bit !== next) {
      if (bit === '1') {
        rects.push(`<rect x="${x}" y="0" width="${run * module}" height="${height}"/>`);
      }
      x += run * module;
      run = 0;
    }
  }

  const width = x;
  return {
    width,
    height,
    svg:
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
      `viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges">` +
      `<rect width="${width}" height="${height}" fill="#fff"/>` +
      `<g fill="#000">${rects.join('')}</g></svg>`
  };
}

/** A data URI, so the SVG can go straight into an `img` on a label sheet. */
export const code128DataUri = (value: string, opts?: { height?: number; module?: number }) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(code128(value, opts).svg)}`;
