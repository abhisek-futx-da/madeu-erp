import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createBridge, parseWeight, validatePrintJob } from '../index.mjs';

test('scale text is bounded and rounded to grams', () => {
  assert.equal(parseWeight('ST,+0014.225 kg\r\n'), 14.225);
  assert.throws(() => parseWeight('-1 kg'), /invalid/);
  assert.throws(() => parseWeight('overload'), /no numeric/);
});

test('only complete supported raw print jobs pass', () => {
  validatePrintJob('zpl', Buffer.from('^XA^FDTEST^FS^XZ'));
  validatePrintJob('tspl', Buffer.from('SIZE 10 mm,10 mm\nPRINT 1,1'));
  assert.throws(() => validatePrintJob('zpl', Buffer.from('^XA')), /incomplete/);
});

test('loopback bridge authenticates and forwards the exact raw bytes to a network printer', async t => {
  let received = Buffer.alloc(0);
  const printer = net.createServer(socket => socket.on('data', chunk => { received = Buffer.concat([received, chunk]); }));
  await new Promise(resolve => printer.listen(0, '127.0.0.1', resolve));
  t.after(() => printer.close());
  const address = printer.address();
  assert.equal(typeof address, 'object');

  const token = 'test-pairing-token-at-least-24';
  const origin = 'https://erp.mill.test';
  const bridge = createBridge({ token, allowedOrigin: origin, printerMode: 'tcp',
    printerHost: '127.0.0.1', printerPort: address.port, printerQueue: '',
    scaleHost: '', scalePort: 4001, scaleTimeoutMs: 1000 });
  await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve));
  t.after(() => bridge.close());
  const bridgeAddress = bridge.address();
  assert.equal(typeof bridgeAddress, 'object');

  const raw = '^XA^FDTHAAN-1^FS^XZ';
  const response = await fetch(`http://127.0.0.1:${bridgeAddress.port}/print`, {
    method: 'POST', headers: { origin, 'x-bridge-token': token,
      'x-printer-language': 'zpl', 'content-type': 'text/plain' }, body: raw
  });
  assert.equal(response.status, 200, await response.text());
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(received.toString(), raw);

  const refused = await fetch(`http://127.0.0.1:${bridgeAddress.port}/print`, {
    method: 'POST', headers: { origin, 'x-bridge-token': 'wrong',
      'x-printer-language': 'zpl' }, body: raw
  });
  assert.equal(refused.status, 403);
});
