export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
}

/** RFC-4180 CSV reader for files saved by Excel/LibreOffice. */
export function parseCsv(input: string): ParsedCsv {
  const text = input.replace(/^\uFEFF/, '');
  const matrix: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      if (cell.length > 0) throw new Error('a quoted cell must start with a quote');
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      matrix.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (quoted) throw new Error('the file ends inside a quoted cell');
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    matrix.push(row);
  }

  const nonBlank = matrix.filter(columns => columns.some(value => value.trim() !== ''));
  if (nonBlank.length < 2) throw new Error('include a header row and at least one data row');
  const headers = nonBlank[0]!.map(value => value.trim().replace(/^\uFEFF/, ''));
  if (headers.some(value => !value)) throw new Error('every column must have a header');
  const duplicates = headers.filter((value, index) => headers.indexOf(value) !== index);
  if (duplicates.length > 0) throw new Error(`duplicate header: ${duplicates[0]}`);

  const rows = nonBlank.slice(1).map((columns, index) => {
    if (columns.length !== headers.length) {
      throw new Error(`row ${index + 2} has ${columns.length} cells; expected ${headers.length}`);
    }
    return Object.fromEntries(headers.map((header, column) => [header, columns[column] ?? '']));
  });
  return { headers, rows };
}
