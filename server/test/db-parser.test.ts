import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePgInt8, parsePgNumeric } from '../src/db.ts';

test('database decimals cross the API boundary only while their scaled value is exact', () => {
  assert.equal(parsePgNumeric('999999999999.99'), 999999999999.99);
  assert.equal(parsePgNumeric('-12.3456'), -12.3456);
  assert.throws(() => parsePgNumeric('9999999999999999.99'), /exact API boundary/);
  assert.throws(() => parsePgNumeric('NaN'), /invalid PostgreSQL numeric/);
});

test('int8 values cannot silently lose identity precision', () => {
  assert.equal(parsePgInt8('9007199254740991'), Number.MAX_SAFE_INTEGER);
  assert.throws(() => parsePgInt8('9007199254740992'), /exact API boundary/);
});
