import { timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

const reply = (res, status, body) => {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': typeof body === 'string'
    ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store' });
  res.end(text);
};

export function parseWeight(text) {
  const match = /(-?\d+(?:\.\d+)?)/.exec(String(text));
  if (!match) throw new Error('scale returned no numeric weight');
  const kilograms = Number(match[1]);
  if (!Number.isFinite(kilograms) || kilograms < 0 || kilograms > 5000) {
    throw new Error('scale returned an invalid weight');
  }
  return Math.round(kilograms * 1000) / 1000;
}

export function validatePrintJob(language, bytes) {
  if (!['zpl', 'tspl'].includes(language)) throw new Error('printer language must be zpl or tspl');
  if (bytes.length === 0 || bytes.length > 1_000_000) throw new Error('print job size is invalid');
  const text = bytes.toString('utf8');
  if (language === 'zpl' && (!text.includes('^XA') || !text.includes('^XZ'))) {
    throw new Error('incomplete ZPL job');
  }
  if (language === 'tspl' && !/(^|\n)PRINT\s+\d+\s*,\s*\d+/i.test(text)) {
    throw new Error('incomplete TSPL job');
  }
}

const sendTcp = (host, port, bytes, timeoutMs = 5000) => new Promise((resolve, reject) => {
  const socket = net.createConnection({ host, port });
  socket.setTimeout(timeoutMs);
  socket.once('connect', () => socket.end(bytes));
  socket.once('close', hadError => hadError || resolve());
  socket.once('timeout', () => socket.destroy(new Error('hardware connection timed out')));
  socket.once('error', reject);
});

const sendCups = (queue, bytes) => new Promise((resolve, reject) => {
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(queue)) return reject(new Error('invalid CUPS queue'));
  const child = spawn('lp', ['-d', queue, '-o', 'raw'], { stdio: ['pipe', 'ignore', 'pipe'] });
  let error = '';
  child.stderr.on('data', chunk => { error += chunk.toString(); });
  child.once('error', reject);
  child.once('close', code => code === 0 ? resolve() : reject(new Error(error.trim() || `lp exited ${code}`)));
  child.stdin.end(bytes);
});

const readTcpScale = (host, port, timeoutMs) => new Promise((resolve, reject) => {
  const socket = net.createConnection({ host, port });
  let text = '';
  socket.setTimeout(timeoutMs);
  socket.on('data', chunk => {
    text += chunk.toString();
    if (/\r|\n|kg/i.test(text) && /\d/.test(text)) socket.end();
  });
  socket.once('close', () => {
    try { resolve(parseWeight(text)); } catch (error) { reject(error); }
  });
  socket.once('timeout', () => socket.destroy(new Error('scale timed out')));
  socket.once('error', reject);
});

const tokenMatches = (provided, expected) => {
  const left = Buffer.from(String(provided ?? ''));
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
};

export function createBridge(config) {
  if (!/^https?:\/\/[^/]+$/.test(config.allowedOrigin)) throw new Error('ALLOWED_ORIGIN must be one exact origin');
  if (config.token.length < 24) throw new Error('BRIDGE_TOKEN must contain at least 24 characters');

  return http.createServer((req, res) => {
    const origin = req.headers.origin;
    if (origin === config.allowedOrigin) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
      res.setHeader('access-control-allow-private-network', 'true');
      res.setHeader('access-control-allow-headers', 'content-type,x-printer-language,x-bridge-token');
      res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      if (origin !== config.allowedOrigin) return reply(res, 403, 'origin refused');
      res.writeHead(204); res.end(); return;
    }
    if (req.url === '/health' && req.method === 'GET') return reply(res, 200, { ok: true });
    if (origin !== config.allowedOrigin || !tokenMatches(req.headers['x-bridge-token'], config.token)) {
      return reply(res, 403, 'origin or pairing token refused');
    }

    if (req.url === '/print' && req.method === 'POST') {
      const chunks = []; let size = 0;
      req.on('data', chunk => {
        size += chunk.length;
        if (size > 1_000_000) req.destroy(new Error('print job too large'));
        else chunks.push(chunk);
      });
      req.on('error', error => !res.headersSent && reply(res, 400, error.message));
      req.on('end', async () => {
        try {
          const bytes = Buffer.concat(chunks);
          validatePrintJob(String(req.headers['x-printer-language'] ?? ''), bytes);
          if (config.printerMode === 'tcp') await sendTcp(config.printerHost, config.printerPort, bytes);
          else if (config.printerMode === 'cups') await sendCups(config.printerQueue, bytes);
          else throw new Error('PRINTER_MODE must be tcp or cups');
          reply(res, 200, { printed: true, bytes: bytes.length });
        } catch (error) { reply(res, 502, error instanceof Error ? error.message : String(error)); }
      });
      return;
    }

    if (req.url === '/scale' && req.method === 'GET') {
      if (!config.scaleHost) return reply(res, 503, 'TCP scale is not configured; use direct Web Serial');
      readTcpScale(config.scaleHost, config.scalePort, config.scaleTimeoutMs)
        .then(kilograms => reply(res, 200, { kilograms }))
        .catch(error => reply(res, 502, error instanceof Error ? error.message : String(error)));
      return;
    }
    reply(res, 404, 'not found');
  });
}

export function configFromEnv(env = process.env) {
  return {
    token: env.BRIDGE_TOKEN ?? '', allowedOrigin: env.ALLOWED_ORIGIN ?? '',
    printerMode: env.PRINTER_MODE ?? 'tcp', printerHost: env.PRINTER_HOST ?? '',
    printerPort: Number(env.PRINTER_PORT ?? 9100), printerQueue: env.PRINTER_QUEUE ?? '',
    scaleHost: env.SCALE_TCP_HOST ?? '', scalePort: Number(env.SCALE_TCP_PORT ?? 4001),
    scaleTimeoutMs: Number(env.SCALE_TIMEOUT_MS ?? 5000)
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.BRIDGE_PORT ?? 17420);
  const bridge = createBridge(configFromEnv());
  bridge.listen(port, '127.0.0.1', () => {
    process.stdout.write(`Link ERP hardware bridge listening on http://127.0.0.1:${port}\n`);
  });
}
