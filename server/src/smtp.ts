import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { randomUUID } from 'node:crypto';

/**
 * A minimal SMTP client, written by hand.
 *
 * The alternative is a production dependency for what is a line-oriented
 * protocol over a socket, and the same reasoning as the PDF and xlsx writers
 * beside it applies. This one speaks only what a mill needs: implicit TLS,
 * AUTH LOGIN or PLAIN, one message, one attachment.
 *
 * It refuses to do anything without credentials. There is no default host, no
 * fallback relay and no "pretend it worked" branch: an unconfigured mill has
 * an outbox that fills up and says so, which is the truth, rather than a queue
 * that drains into nowhere.
 */

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  fromName: string;
  /** Off only for a local test server that speaks TLS with a self-signed cert. */
  rejectUnauthorized: boolean;
}

export class SmtpNotConfigured extends Error {
  constructor(missing: string[]) {
    super(
      `email is not configured: set ${missing.join(', ')}. ` +
      'Nothing has been sent and the message is still queued.'
    );
    this.name = 'SmtpNotConfigured';
  }
}

/** Reads the environment once per call, so a restart is all a change needs. */
export function smtpConfig(): SmtpConfig | { missing: string[] } {
  const need = { host: 'SMTP_HOST', user: 'SMTP_USER', pass: 'SMTP_PASS', from: 'SMTP_FROM' };
  const missing = Object.entries(need)
    .filter(([, key]) => !process.env[key]?.trim())
    .map(([, key]) => key);
  if (missing.length > 0) return { missing };

  return {
    host: process.env.SMTP_HOST!.trim(),
    port: Number(process.env.SMTP_PORT ?? 465),
    user: process.env.SMTP_USER!.trim(),
    pass: process.env.SMTP_PASS!,
    from: process.env.SMTP_FROM!.trim(),
    fromName: (process.env.SMTP_FROM_NAME ?? '').trim(),
    // Only a deliberate opt-out, and never the default.
    rejectUnauthorized: process.env.SMTP_INSECURE !== 'true'
  };
}

export const isConfigured = () => !('missing' in smtpConfig());

// ------------------------------------------------------------------- MIME --

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

/** RFC 2047, so a party's name in Gujarati survives a Subject line. */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${b64(value)}?=`;
}

const address = (email: string, name: string) =>
  name ? `${encodeHeader(name)} <${email}>` : email;

export interface Message {
  to: string;
  toName: string;
  cc?: string | null;
  subject: string;
  body: string;
  attachment?: { filename: string; content: Buffer; mime: string };
}

export function buildMime(config: SmtpConfig, message: Message): string {
  const boundary = `----linkerp-${randomUUID()}`;
  const headers = [
    `From: ${address(config.from, config.fromName)}`,
    `To: ${address(message.to, message.toName)}`,
    ...(message.cc ? [`Cc: ${message.cc}`] : []),
    `Subject: ${encodeHeader(message.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomUUID()}@link-erp>`,
    'MIME-Version: 1.0'
  ];

  if (!message.attachment) {
    return [
      ...headers,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      b64(message.body).replace(/(.{76})/g, '$1\r\n')
    ].join('\r\n');
  }

  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(message.body).replace(/(.{76})/g, '$1\r\n'),
    '',
    `--${boundary}`,
    `Content-Type: ${message.attachment.mime}; name="${message.attachment.filename}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${message.attachment.filename}"`,
    '',
    message.attachment.content.toString('base64').replace(/(.{76})/g, '$1\r\n'),
    '',
    `--${boundary}--`,
    ''
  ].join('\r\n');
}

// ----------------------------------------------------------------- the wire --

/** A dot at the start of a line ends DATA; the protocol says double it. */
const dotStuff = (mime: string) => mime.replace(/\r\n\./g, '\r\n..');

class Conversation {
  private buffer = '';
  private waiting: { codes: number[]; resolve: (line: string) => void;
                     reject: (e: Error) => void } | null = null;
  private socket: TLSSocket;

  constructor(socket: TLSSocket) {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', chunk => this.take(String(chunk)));
    socket.on('error', e => this.fail(e as Error));
  }

  private take(chunk: string) {
    this.buffer += chunk;
    // A reply ends on a line whose fourth character is a space, not a hyphen.
    const match = /^(\d{3}) [^\n]*\r?\n/m.exec(this.buffer);
    if (!match || !this.waiting) return;
    const reply = this.buffer;
    this.buffer = '';
    const pending = this.waiting;
    this.waiting = null;
    const code = Number(match[1]);
    if (pending.codes.includes(code)) pending.resolve(reply);
    else pending.reject(new Error(`the mail server said: ${reply.trim()}`));
  }

  private fail(error: Error) {
    const pending = this.waiting;
    this.waiting = null;
    pending?.reject(error);
  }

  expect(...codes: number[]): Promise<string> {
    return new Promise((resolve, reject) => {
      this.waiting = { codes, resolve, reject };
      this.take('');
    });
  }

  async say(line: string, ...codes: number[]): Promise<string> {
    const reply = this.expect(...codes);
    this.socket.write(`${line}\r\n`);
    return reply;
  }
}

/**
 * Sends one message and closes. No pooling: a mill sends a handful of
 * documents a day, and a pooled connection is a thing that goes stale in the
 * night and fails the first send of the morning.
 */
export async function sendMail(message: Message, timeoutMs = 20_000): Promise<void> {
  const config = smtpConfig();
  if ('missing' in config) throw new SmtpNotConfigured(config.missing);

  const socket = tlsConnect({
    host: config.host, port: config.port,
    rejectUnauthorized: config.rejectUnauthorized,
    servername: config.host
  });
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error('the mail server stopped answering')));

  const talk = new Conversation(socket);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('secureConnect', () => resolve());
      socket.once('error', reject);
    });

    await talk.expect(220);
    const greeting = await talk.say('EHLO link-erp', 250);

    if (/AUTH[ =][^\n]*PLAIN/i.test(greeting)) {
      await talk.say(
        `AUTH PLAIN ${Buffer.from(`\0${config.user}\0${config.pass}`).toString('base64')}`, 235);
    } else {
      await talk.say('AUTH LOGIN', 334);
      await talk.say(Buffer.from(config.user).toString('base64'), 334);
      await talk.say(Buffer.from(config.pass).toString('base64'), 235);
    }

    await talk.say(`MAIL FROM:<${config.from}>`, 250);
    await talk.say(`RCPT TO:<${message.to}>`, 250, 251);
    if (message.cc) await talk.say(`RCPT TO:<${message.cc}>`, 250, 251);
    await talk.say('DATA', 354);
    await talk.say(`${dotStuff(buildMime(config, message))}\r\n.`, 250);
    await talk.say('QUIT', 221).catch(() => undefined);
  } finally {
    socket.destroy();
  }
}
