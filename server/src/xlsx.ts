import { deflateRawSync } from 'node:zlib';

/**
 * A real .xlsx, written by hand.
 *
 * CSV loses the thing a mill's accountant needs most: type. Excel reads a
 * date column its own way, turns long digit strings into scientific notation,
 * and will not sum a column it has decided is text. An accountant then
 * re-types figures, and a re-typed figure is a wrong figure.
 *
 * No dependency: an xlsx is a zip of XML, and both are in the standard
 * library. The same reasoning as the PDF writer beside this file.
 */

export type CellType = 'text' | 'number' | 'date';
export interface SheetColumn { key: string; label: string; type?: CellType }

/** Excel refuses to open a file carrying control characters at all. */
const printable = (text: string) => {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code > 0x1f || code === 0x09 || code === 0x0a || code === 0x0d) out += ch;
  }
  return out;
};

const xml = (value: unknown) => printable(String(value ?? ''))
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const COLUMN_NAMES: string[] = [];
function columnName(index: number): string {
  if (COLUMN_NAMES[index]) return COLUMN_NAMES[index]!;
  let n = index;
  let name = '';
  do {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  COLUMN_NAMES[index] = name;
  return name;
}

/** Excel counts days from 1900, with a deliberate bug: 1900 is a leap year. */
function excelSerial(iso: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return null;
  const days = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000;
  return days + 25569;
}

function cell(ref: string, value: unknown, type: CellType): string {
  if (value === null || value === undefined || value === '') return '';
  if (type === 'number') {
    const n = Number(value);
    if (Number.isFinite(n)) return `<c r="${ref}"><v>${n}</v></c>`;
  }
  if (type === 'date') {
    const serial = excelSerial(String(value));
    if (serial !== null) return `<c r="${ref}" s="2"><v>${serial}</v></c>`;
  }
  // Inline strings, so a GSTIN or an HSN code stays exactly as it was written
  // instead of becoming a number in scientific notation.
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
}

function sheetXml(columns: SheetColumn[], rows: Record<string, unknown>[]): string {
  const widths = columns.map((c, i) => {
    const longest = rows.reduce(
      (widest, r) => Math.max(widest, String(r[c.key] ?? '').length), c.label.length);
    return `<col min="${i + 1}" max="${i + 1}" width="${Math.min(Math.max(longest + 2, 8), 50)}" customWidth="1"/>`;
  }).join('');

  const header = columns
    .map((c, i) => `<c r="${columnName(i)}1" s="1" t="inlineStr"><is><t>${xml(c.label)}</t></is></c>`)
    .join('');

  const body = rows.map((row, r) => {
    const cells = columns
      .map((c, i) => cell(`${columnName(i)}${r + 2}`, row[c.key], c.type ?? 'text'))
      .join('');
    return `<row r="${r + 2}">${cells}</row>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetPr><outlinePr/></sheetPr>
<sheetViews><sheetView workbookViewId="0" tabSelected="1">
<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>
</sheetView></sheetViews>
<cols>${widths}</cols>
<sheetData><row r="1">${header}</row>${body}</sheetData>
<autoFilter ref="A1:${columnName(Math.max(columns.length - 1, 0))}${rows.length + 1}"/>
</worksheet>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

/** Style 1 is the bold header; style 2 is dd-mm-yyyy, as an Indian mill reads it. */
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="dd-mm-yyyy"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function workbookXml(sheetName: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${xml(sheetName)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
}

// ------------------------------------------------------------------- zip --

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = -1;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

interface Entry { name: string; body: Buffer; deflated: Buffer; crc: number; offset: number }

/** A minimal zip: deflate, local headers, central directory, end record. */
function zip(files: { name: string; content: string }[]): Buffer {
  const entries: Entry[] = [];
  const chunks: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const body = Buffer.from(file.content, 'utf8');
    const deflated = deflateRawSync(body);
    const crc = crc32(body);
    const name = Buffer.from(file.name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(8, 8);            // deflate
    local.writeUInt16LE(0, 10);           // time
    local.writeUInt16LE(0x21, 12);        // date: 1980-01-01, so files are reproducible
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, name, deflated);
    entries.push({ name: file.name, body, deflated, crc, offset });
    offset += local.length + name.length + deflated.length;
  }

  const centralStart = offset;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(entry.crc, 16);
    central.writeUInt32LE(entry.deflated.length, 20);
    central.writeUInt32LE(entry.body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.offset, 42);
    chunks.push(central, name);
    offset += central.length + name.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(offset - centralStart, 12);
  end.writeUInt32LE(centralStart, 16);
  chunks.push(end);

  return Buffer.concat(chunks);
}

/** Excel's own hard limit; a report past it is a database query, not a sheet. */
export const SHEET_ROW_LIMIT = 1_048_575;

export function renderXlsx(
  sheetName: string, columns: SheetColumn[], rows: Record<string, unknown>[]
): Buffer {
  const capped = rows.length > SHEET_ROW_LIMIT ? rows.slice(0, SHEET_ROW_LIMIT) : rows;
  // A sheet name may not carry these, and Excel refuses the whole file if it does.
  const safeName = (sheetName || 'Report').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31);
  return zip([
    { name: '[Content_Types].xml', content: CONTENT_TYPES },
    { name: '_rels/.rels', content: ROOT_RELS },
    { name: 'xl/workbook.xml', content: workbookXml(safeName) },
    { name: 'xl/_rels/workbook.xml.rels', content: WORKBOOK_RELS },
    { name: 'xl/styles.xml', content: STYLES },
    { name: 'xl/worksheets/sheet1.xml', content: sheetXml(columns, capped) }
  ]);
}
