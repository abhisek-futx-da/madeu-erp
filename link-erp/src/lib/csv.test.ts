import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv';

describe('parseCsv', () => {
  it('reads Excel CSV quoting, commas, newlines and a UTF-8 BOM', () => {
    const parsed = parseCsv('\uFEFFcode,name,notes\r\nA,"Alpha, Mills","line 1\nline 2"\r\n');
    expect(parsed.headers).toEqual(['code', 'name', 'notes']);
    expect(parsed.rows).toEqual([{ code: 'A', name: 'Alpha, Mills', notes: 'line 1\nline 2' }]);
  });

  it('refuses duplicate headers and malformed row widths', () => {
    expect(() => parseCsv('code,code\nA,B')).toThrow(/duplicate header/);
    expect(() => parseCsv('code,name\nA')).toThrow(/expected 2/);
  });

  it('refuses an unfinished quoted cell', () => {
    expect(() => parseCsv('code,name\nA,"broken')).toThrow(/quoted cell/);
  });
});
