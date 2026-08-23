import { describe, expect, it } from 'vitest';
import { parseStatementCsv } from './BankReconciliationView';

describe('bank statement CSV import', () => {
  it('normalises Indian dates and debit/credit into signed amounts', () => {
    const rows = parseStatementCsv(
      'date,reference,description,debit,credit\n05/10/2026,OUT-1,Supplier,"1,000.00",\n2026-10-06,IN-1,Customer,,2500.00'
    );
    expect(rows).toEqual([
      { txnDate: '2026-10-05', valueDate: null, reference: 'OUT-1', description: 'Supplier', amount: -1000 },
      { txnDate: '2026-10-06', valueDate: null, reference: 'IN-1', description: 'Customer', amount: 2500 }
    ]);
  });

  it('refuses ambiguous or zero-value rows', () => {
    expect(() => parseStatementCsv('reference,amount\nx,10')).toThrow(/header needs date/i);
    expect(() => parseStatementCsv('date,amount\n2026-10-05,0')).toThrow(/cannot be zero/i);
  });
});
