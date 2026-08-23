import { describe, expect, it } from 'vitest';
import { thermalCommands } from './hardware';

const label = {
  barcode: 'THAAN-100/2', mill: 'Neelkamal Textiles', quality: 'Galaxy',
  grade: 'A', lot: 'L-22', metres: 97.5, kilograms: 14.225
};

describe('raw thermal label languages', () => {
  it('builds self-contained ZPL with Code 128 and both textile units', () => {
    const raw = thermalCommands('zpl', [label]);
    expect(raw).toContain('^XA');
    expect(raw).toContain('^BCN');
    expect(raw).toContain('^FDTHAAN-100/2^FS');
    expect(raw).toContain('97.50 MTR  14.225 KG');
    expect(raw).toContain('^XZ');
  });

  it('builds TSPL bytes with Code 128 and an explicit print command', () => {
    const raw = thermalCommands('tspl', [label]);
    expect(raw).toContain('SIZE 65 mm,35 mm');
    expect(raw).toContain('BARCODE 25,78,"128"');
    expect(raw).toContain('THAAN-100/2');
    expect(raw).toContain('PRINT 1,1');
  });

  it('removes control-language characters from user-supplied label text', () => {
    const raw = thermalCommands('zpl', [{ ...label, mill: 'Bad^FS\n^XA' }]);
    expect(raw).not.toContain('Bad^FS');
  });
});
