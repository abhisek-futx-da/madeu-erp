/**
 * IRP client behaviour, driven through a fake transport. No credentials and no
 * network: what is under test is our retry, error classification and parsing,
 * not the government's uptime.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { IrpClient, interpret, type IrpTransport } from '../src/irp.ts';

const creds = {
  baseUrl: 'https://irp.test', clientId: 'c', clientSecret: 's',
  username: 'u', password: 'p', gstin: '27ANBPC3604Q1Z0'
};

class Fake implements IrpTransport {
  calls: { path: string; body: unknown; headers: Record<string, string> }[] = [];
  #responses: (({ status: number; body: any }) | Error)[];

  constructor(responses: (({ status: number; body: any }) | Error)[]) {
    this.#responses = responses;
  }

  async post(path: string, body: unknown, headers: Record<string, string>) {
    this.calls.push({ path, body, headers });
    const next = this.#responses.shift() ?? { status: 500, body: null };
    if (next instanceof Error) throw next;
    return next;
  }
}

const accepted = {
  status: 200,
  body: {
    Status: 1,
    Data: {
      Irn: 'a'.repeat(64), AckNo: '112010000123', AckDt: '2026-09-10 14:22:00',
      SignedQRCode: 'eyJhbGciOi...', EwbNo: 351000123456, EwbValidTill: '2026-09-13 23:59:00'
    }
  }
};

test('a successful registration is parsed into an IRN', async () => {
  const t = new Fake([accepted]);
  const r = await new IrpClient(creds, t).generateIrn({ Version: '1.1' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.irn.length, 64);
  assert.equal(r.ackNo, '112010000123');
  assert.equal(r.ewayBillNo, '351000123456');
  assert.equal(t.calls.length, 1);
});

test('credentials travel as headers, never in the payload', async () => {
  const t = new Fake([accepted]);
  await new IrpClient(creds, t).generateIrn({ Version: '1.1' });
  const call = t.calls[0]!;
  assert.equal(call.headers.client_id, 'c');
  assert.equal(call.headers.gstin, '27ANBPC3604Q1Z0');
  assert.equal(JSON.stringify(call.body).includes('client_secret'), false);
});

test('Data arriving as a JSON string is still parsed', () => {
  const r = interpret({ status: 200, body: { Status: '1', Data: JSON.stringify(accepted.body.Data) } });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.ackNo, '112010000123');
});

test('a duplicate IRN is a permanent answer, not a retry', async () => {
  const dup = {
    status: 400,
    body: { Status: 0, ErrorDetails: [{ ErrorCode: '2150', ErrorMessage: 'Duplicate IRN' }] }
  };
  const t = new Fake([dup, dup, dup]);
  const r = await new IrpClient(creds, t).generateIrn({});
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, '2150');
  assert.equal(r.retryable, false);
  assert.equal(t.calls.length, 1, 'must not hammer the IRP over a duplicate');
});

test('a validation rejection is reported with every field the IRP named', async () => {
  const t = new Fake([{
    status: 400,
    body: {
      Status: 0,
      ErrorDetails: [
        { ErrorCode: '2212', ErrorMessage: 'Invalid buyer pincode' },
        { ErrorCode: '2240', ErrorMessage: 'Invalid HSN code' }
      ]
    }
  }]);
  const r = await new IrpClient(creds, t).generateIrn({});
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.message, /Invalid buyer pincode/);
  assert.match(r.message, /Invalid HSN code/);
  assert.equal(t.calls.length, 1);
});

test('a 5xx is retried and can still succeed', async () => {
  const t = new Fake([{ status: 503, body: { message: 'gateway down' } }, accepted]);
  const r = await new IrpClient(creds, t).generateIrn({});
  assert.equal(r.ok, true);
  assert.equal(t.calls.length, 2);
});

test('retries are bounded', async () => {
  const t = new Fake([
    { status: 503, body: null }, { status: 503, body: null },
    { status: 503, body: null }, accepted
  ]);
  const r = await new IrpClient(creds, t, 3).generateIrn({});
  assert.equal(r.ok, false);
  assert.equal(t.calls.length, 3, 'three attempts, then give up');
});

test('a transport failure is retryable and surfaced, not swallowed', async () => {
  const t = new Fake([new Error('socket hang up'), accepted]);
  const r = await new IrpClient(creds, t).generateIrn({});
  assert.equal(r.ok, true);
  assert.equal(t.calls.length, 2);
});

test('every transport attempt failing yields the last error', async () => {
  const t = new Fake([new Error('timeout'), new Error('timeout'), new Error('timeout')]);
  const r = await new IrpClient(creds, t, 3).generateIrn({});
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'TRANSPORT');
  assert.match(r.message, /timeout/);
});

test('a 200 with no IRN is treated as a failure', () => {
  const r = interpret({ status: 200, body: { Status: 1, Data: {} } });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'NO_IRN');
});

test('cancellation posts the reason to the cancel endpoint', async () => {
  const t = new Fake([{ status: 200, body: { Status: 1, Data: { Irn: 'b'.repeat(64) } } }]);
  await new IrpClient(creds, t).cancelIrn('b'.repeat(64), '1', 'wrong entry');
  const call = t.calls[0]!;
  assert.match(call.path, /Cancel$/);
  assert.deepEqual(call.body, { Irn: 'b'.repeat(64), CnlRsn: '1', CnlRem: 'wrong entry' });
});
