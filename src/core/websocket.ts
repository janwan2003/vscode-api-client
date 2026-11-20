// WebSocket requests in the JetBrains HTTP Client format:
//
//   WEBSOCKET wss://example.com/socket
//   Authorization: Bearer {{token}}
//
//   {"type": "hello"}              ← sent as soon as the connection is open
//   ===                            ← message separator
//   {"type": "subscribe"}          ← sent right after the previous one
//   === wait-for-server            ← wait for one message from the server first
//   {"type": "ping"}
//   === wait-for-server            ← a script ending in waits: close once they are met
//
// A `ws://` / `wss://` URL with no method (or GET) is a WebSocket request too. The protocol is
// RFC 6455, written here on top of the socket node:http hands over after the `101` handshake, so
// TLS settings, proxies (CONNECT for wss), cookies and the User-Agent work as for HTTP requests.
// No extensions (no permessage-deflate) and no subprotocol unless a `Sec-WebSocket-Protocol`
// header asks for one.

import { createHash, randomBytes } from 'node:crypto';
import type { Socket } from 'node:net';
import type { HttpRequest, HttpResponse } from './model.ts';
import { mergeCookieHeader } from './cookies.ts';
import type { SseEvent } from './sse.ts';
import { describeNetworkError, exchange, type Hdr, type SendOptions, type Upgraded } from './send.ts';

/** One message of a WebSocket script and how many server messages to wait for before sending it. */
export interface WsStep {
  /** Server messages to receive (since the previous message was sent) before this one is sent. */
  wait: number;
  /** Text, or bytes from a `< ./file` message (sent as a binary frame). */
  message: string | Uint8Array;
}

export interface WsScript {
  steps: WsStep[];
  /** `=== wait-for-server` lines after the last message: wait for that many replies, then close. */
  trailingWaits: number;
}

const SEPARATOR = /^\s*===(?:\s+(wait-for-server))?\s*(?:\/\/.*)?$/;

/** `WEBSOCKET <url>` (JetBrains), `WS <url>` (httpYac), or a `ws://` / `wss://` URL with GET (the default method). */
export function isWebSocketRequest(req: Pick<HttpRequest, 'method' | 'url'>): boolean {
  const m = req.method.toUpperCase();
  return m === 'WEBSOCKET' || m === 'WS' || (m === 'GET' && /^\s*wss?:\/\//i.test(req.url));
}

/** Split a WebSocket request body into messages at `===` lines (see the file comment). */
export function parseWsScript(body: string | undefined): WsScript {
  const steps: WsStep[] = [];
  let wait = 0;
  let lines: string[] = [];
  const flush = () => {
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (lines.length) {
      steps.push({ wait, message: lines.join('\n') });
      wait = 0;
    }
    lines = [];
  };
  for (const line of (body ?? '').split(/\r?\n/)) {
    const m = SEPARATOR.exec(line);
    if (!m) {
      lines.push(line);
      continue;
    }
    flush();
    if (m[1]) wait++;
  }
  flush();
  return { steps, trailingWaits: wait };
}

// ---------------------------------------------------------------------------------------------
// Framing (RFC 6455 section 5)

export const OP = { continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 } as const;

export interface Frame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

/** Encode one frame. Clients must mask (`mask` true); servers must not. */
export function encodeFrame(opcode: number, payload: Uint8Array, mask = true, fin = true): Buffer {
  const len = payload.byteLength;
  const ext = len < 126 ? 0 : len < 65536 ? 2 : 8;
  const head = Buffer.alloc(2 + ext + (mask ? 4 : 0));
  head[0] = (fin ? 0x80 : 0) | opcode;
  head[1] = (mask ? 0x80 : 0) | (ext === 0 ? len : ext === 2 ? 126 : 127);
  if (ext === 2) head.writeUInt16BE(len, 2);
  else if (ext === 8) head.writeBigUInt64BE(BigInt(len), 2);
  const body = Buffer.from(payload);
  if (mask) {
    const key = randomBytes(4);
    key.copy(head, 2 + ext);
    for (let i = 0; i < body.length; i++) body[i] ^= key[i & 3];
  }
  return Buffer.concat([head, body]);
}

/** Incremental frame parser: feed socket bytes, get complete frames. Accepts masked frames too (for tests). */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0);
  constructor(private readonly maxPayload = 64 * 1024 * 1024) {}

  push(chunk: Buffer): Frame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: Frame[] = [];
    for (;;) {
      if (this.buf.length < 2) break;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      if (b0 & 0x70) throw new Error('WebSocket protocol error: reserved bits set (extensions are not supported)');
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) break;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) break;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(this.maxPayload)) throw new Error(`WebSocket message larger than ${this.maxPayload} bytes`);
        len = Number(big);
        off = 10;
      }
      if (len > this.maxPayload) throw new Error(`WebSocket message larger than ${this.maxPayload} bytes`);
      const masked = (b1 & 0x80) !== 0;
      const total = off + (masked ? 4 : 0) + len;
      if (this.buf.length < total) break;
      let payload = this.buf.subarray(off + (masked ? 4 : 0), total);
      if (masked) {
        const key = this.buf.subarray(off, off + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= key[i & 3];
      } else payload = Buffer.from(payload);
      out.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload });
      this.buf = this.buf.subarray(total);
    }
    return out;
  }
}

/** `Sec-WebSocket-Accept` for a `Sec-WebSocket-Key`. */
export function acceptKey(key: string): string {
  return createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}

const CLOSE_NAMES: Record<number, string> = {
  1000: 'normal closure', 1001: 'going away', 1002: 'protocol error', 1003: 'unsupported data', 1005: 'no status',
  1006: 'abnormal closure', 1007: 'invalid payload', 1008: 'policy violation', 1009: 'message too big',
  1010: 'missing extension', 1011: 'internal error', 1012: 'service restart', 1013: 'try again later',
};

function describeClose(payload: Buffer): string {
  if (payload.length < 2) return '1005 (no status)';
  const code = payload.readUInt16BE(0);
  const reason = payload.subarray(2).toString('utf8');
  return `${code} ${reason || `(${CLOSE_NAMES[code] ?? 'closed'})`}`;
}

// ---------------------------------------------------------------------------------------------
// Sending

/**
 * Open a WebSocket, run the script and collect every message. Resolves with a response whose
 * `events` are the messages in order (`sent` / `message` / `binary`) and whose `body` is a readable
 * transcript (`>` sent, `<` received). Ends when the server closes, a script that ends in
 * `=== wait-for-server` has its replies (`done`), `# @max-events` received messages arrived, or on
 * Stop / timeout, which keep what arrived. A handshake that is not answered with 101 resolves as a
 * normal response (e.g. 401 with its body), so it can be read and checked.
 */
export async function sendWebSocket(req: HttpRequest, script: WsScript, opts: SendOptions = {}): Promise<HttpResponse> {
  const controller = new AbortController();
  const timeout = opts.timeoutMs && opts.timeoutMs > 0 ? setTimeout(() => controller.abort(new Error(`Timed out after ${opts.timeoutMs} ms`)), opts.timeoutMs) : undefined;
  const onAbort = () => controller.abort(opts.signal!.reason instanceof Error ? opts.signal!.reason : new Error('Cancelled'));
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener('abort', onAbort, { once: true });
  const signal = controller.signal;
  const started = performance.now();

  try {
    const url = new URL(req.url.trim().replace(/^ws(s?):\/\//i, 'http$1://').replace(/^(?![a-z][a-z0-9+.-]*:\/\/)/i, 'http://'));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Unsupported WebSocket URL ${req.url}`);
    const key = randomBytes(16).toString('base64');
    const headers: Hdr[] = [];
    let ownCookie: string | undefined;
    for (const h of req.headers) {
      if (h.disabled || !h.name) continue;
      // Content-Type only says how to highlight the messages (as in JetBrains); the handshake headers are ours.
      if (/^(content-type|content-length|connection|upgrade|sec-websocket-key|sec-websocket-version|sec-websocket-extensions|transfer-encoding)$/i.test(h.name)) continue;
      if (opts.cookieJar && /^cookie$/i.test(h.name)) {
        ownCookie = ownCookie ? `${ownCookie}; ${h.value}` : h.value;
        continue;
      }
      headers.push({ name: h.name, value: h.value });
    }
    if (url.username || url.password) {
      if (!headers.some((h) => /^authorization$/i.test(h.name))) {
        headers.push({ name: 'Authorization', value: `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}` });
      }
      url.username = '';
      url.password = '';
    }
    if (!headers.some((h) => /^user-agent$/i.test(h.name))) headers.push({ name: 'User-Agent', value: opts.userAgent ?? 'plainwire' });
    headers.push({ name: 'Connection', value: 'Upgrade' }, { name: 'Upgrade', value: 'websocket' }, { name: 'Sec-WebSocket-Version', value: '13' }, { name: 'Sec-WebSocket-Key', value: key });
    let sentCookie: string | undefined;
    if (opts.cookieJar) {
      sentCookie = mergeCookieHeader(ownCookie, opts.cookieJar.cookieHeader(url));
      if (sentCookie) headers.push({ name: 'Cookie', value: sentCookie });
    } else if (ownCookie) headers.push({ name: 'Cookie', value: ownCookie });

    let up: Upgraded | undefined;
    const res = await exchange(url, 'GET', headers, undefined, opts, signal, (u) => (up = u));
    const status = res.statusCode ?? 0;
    const hdrs: [string, string][] = [];
    for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) hdrs.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);
    const setCookie = res.headers['set-cookie'];
    if (opts.cookieJar && setCookie?.length) opts.cookieJar.setFromResponse(url, setCookie);
    const wsUrl = url.href.replace(/^http/, 'ws');
    const extra = sentCookie ? { sentCookie } : {};

    if (!up) {
      // Refused: read the body like any response (servers explain 400/401/403 there).
      const body = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
      return { status, statusText: res.statusMessage ?? '', headers: hdrs, body: body.toString('utf8'), bodyEncoding: 'utf8', size: body.byteLength, timeMs: Math.round(performance.now() - started), url: wsUrl, ...extra };
    }
    const accept = res.headers['sec-websocket-accept'];
    if (accept !== acceptKey(key)) {
      up.socket.destroy();
      throw new Error(`the server answered 101 but with a wrong Sec-WebSocket-Accept (${accept ?? 'none'})`);
    }
    const s = await converse(up.socket, up.head, script, signal, started, opts);
    return {
      status,
      statusText: res.statusMessage ?? 'Switching Protocols',
      headers: hdrs,
      body: s.transcript,
      bodyEncoding: 'utf8',
      size: s.size,
      timeMs: Math.round(performance.now() - started),
      url: wsUrl,
      events: s.events,
      streamEnd: s.end,
      ...(s.closeReason ? { closeReason: s.closeReason } : {}),
      ...extra,
    };
  } catch (err) {
    const reason = signal.aborted && signal.reason instanceof Error ? signal.reason.message : undefined;
    throw new Error(`WebSocket failed: ${reason ?? describeNetworkError(err)}`);
  } finally {
    if (timeout) clearTimeout(timeout);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

interface Conversation {
  events: SseEvent[];
  transcript: string;
  size: number;
  end: NonNullable<HttpResponse['streamEnd']>;
  closeReason?: string;
}

/** Run the script over an open socket. Stop and timeout end it normally (what arrived is kept). */
function converse(socket: Socket, head: Buffer, script: WsScript, signal: AbortSignal, started: number, opts: SendOptions): Promise<Conversation> {
  return new Promise((resolve, reject) => {
    socket.setNoDelay(true);
    const reader = new FrameReader();
    const events: SseEvent[] = [];
    const lines: string[] = [];
    let size = 0;
    let received = 0;
    let receivedSinceSend = 0;
    let step = 0;
    let fragments: Buffer[] = [];
    let fragOp = 0;
    let finished = false;
    let closing = false;
    let closeReason: string | undefined;
    const ms = () => Math.round(performance.now() - started);
    const record = (e: SseEvent, line: string) => {
      events.push(e);
      lines.push(line);
      opts.onEvent?.(e);
    };

    const finish = (end: Conversation['end'], err?: Error) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', onAbort);
      clearTimeout(closeTimer);
      if (err) {
        socket.destroy();
        return reject(err);
      }
      if (closeReason) lines.push(`-- closed: ${closeReason}`);
      resolve({ events, transcript: lines.join('\n'), size, end, closeReason });
    };
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    /** Start the closing handshake; the socket is destroyed after the server's close or 1 s. */
    const close = (end: Conversation['end'], code = 1000) => {
      if (closing || finished) return finish(end);
      closing = true;
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(code);
      try {
        socket.write(encodeFrame(OP.close, payload));
      } catch {
        /* already gone */
      }
      closeTimer = setTimeout(() => socket.destroy(), 1000);
      socket.once('close', () => clearTimeout(closeTimer));
      finish(end);
      socket.end();
    };
    const onAbort = () => close(signal.reason instanceof Error && signal.reason.message.startsWith('Timed out') ? 'timeout' : 'stopped', 1001);

    /** Send every message whose waits are met; close when a script ending in waits is complete. */
    const advance = () => {
      while (!finished && !closing && step < script.steps.length && receivedSinceSend >= script.steps[step].wait) {
        const { message } = script.steps[step++];
        const bin = typeof message !== 'string';
        const bytes = bin ? message : Buffer.from(message, 'utf8');
        socket.write(encodeFrame(bin ? OP.binary : OP.text, bytes));
        receivedSinceSend = 0;
        const data = bin ? Buffer.from(bytes).toString('base64') : message;
        record({ event: 'sent', data, timeMs: ms() }, `> ${bin ? `(${bytes.byteLength} bytes, binary)` : message}`);
      }
      if (step >= script.steps.length && script.trailingWaits > 0 && receivedSinceSend >= script.trailingWaits) close('done');
    };

    const onMessage = (opcode: number, payload: Buffer) => {
      received++;
      receivedSinceSend++;
      if (opcode === OP.text) {
        let text: string;
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
        } catch {
          return close('closed', 1007);
        }
        record({ event: 'message', data: text, timeMs: ms() }, `< ${text}`);
      } else record({ event: 'binary', data: payload.toString('base64'), timeMs: ms() }, `< (${payload.byteLength} bytes, binary)`);
      if (opts.maxEvents && received >= opts.maxEvents) return close('max-events');
      advance();
    };

    socket.on('data', (chunk: Buffer) => {
      if (finished) return;
      size += chunk.byteLength;
      let frames: Frame[];
      try {
        frames = reader.push(chunk);
      } catch (e) {
        return finish('closed', e as Error);
      }
      for (const f of frames) {
        if (finished) return;
        if (f.opcode === OP.ping) socket.write(encodeFrame(OP.pong, f.payload));
        else if (f.opcode === OP.pong) continue;
        else if (f.opcode === OP.close) {
          closeReason = describeClose(f.payload);
          if (!closing) {
            closing = true;
            try {
              socket.write(encodeFrame(OP.close, f.payload.subarray(0, 2)));
            } catch {
              /* ignore */
            }
          }
          socket.end();
          return finish('closed');
        } else if (f.opcode === OP.continuation) {
          fragments.push(f.payload);
          if (f.fin) {
            const all = Buffer.concat(fragments);
            fragments = [];
            onMessage(fragOp, all);
          }
        } else if (f.opcode === OP.text || f.opcode === OP.binary) {
          if (f.fin) onMessage(f.opcode, f.payload);
          else {
            fragOp = f.opcode;
            fragments = [f.payload];
          }
        } else return finish('closed', new Error(`WebSocket protocol error: unknown opcode ${f.opcode}`));
      }
    });
    socket.on('error', (e) => finish('closed', e));
    socket.on('close', () => {
      if (!closeReason && !closing) closeReason = '1006 (connection lost without a close frame)';
      finish('closed');
    });
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    // Messages before the first `=== wait-for-server` go out on open, before anything already received is read.
    advance();
    if (head.length) socket.emit('data', head);
  });
}
