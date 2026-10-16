// HTTP/1.1 for `vm.serveHttp`: one request per connection, streamed responses.
// Bodies without `Content-Length` go chunked, so a cut-off body is detectable.

import { HOST_INTERNAL_NAME } from '@arm64js/protocol';
import type { Connection } from './connection.js';

/** Answers one guest request. */
export type HttpHandler = (request: Request) => Promise<Response> | Response;

const HEAD_MAX = 64 * 1024;
const CRLF = new Uint8Array([13, 10]);
const HEAD_END = new Uint8Array([13, 10, 13, 10]);

/** Headers about the connection itself, which this server sets. */
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection']);

const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  206: 'Partial Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  413: 'Content Too Large',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Serve one request on `conn`, then close it. */
export async function serveConnection(
  conn: Connection,
  handler: HttpHandler,
  opts: { maxBodyBytes: number },
): Promise<void> {
  const reader = new ByteReader(conn.readable.getReader());
  let response: Response;
  let method = 'GET';
  let http10 = false;
  try {
    const head = await reader.readUntil(HEAD_END, HEAD_MAX);
    if (head === null) {
      conn.close();
      return;
    }
    const req = parseHead(head);
    method = req.method;
    http10 = req.version === 'HTTP/1.0';
    const body = await readBody(reader, req.headers, opts.maxBodyBytes, async () => {
      if (req.headers.get('expect')?.toLowerCase() === '100-continue') {
        await conn.write('HTTP/1.1 100 Continue\r\n\r\n');
      }
    });
    // The guest must not choose the URL's origin (`Host`, absolute-form target).
    const request = new Request(`http://${HOST_INTERNAL_NAME}:${conn.localPort}${pathOf(req.target)}`, {
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
      headers: req.headers,
      method,
    });
    try {
      response = await handler(request);
      if (!(response instanceof Response)) {
        throw new Error('the handler must return a Response');
      }
    } catch (e) {
      console.error('[arm64js] serveHttp handler failed', e);
      response = new Response(`handler failed: ${String((e as Error)?.message ?? e)}\n`, { status: 500 });
    }
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 400;
    response = new Response(`${String((e as Error)?.message ?? e)}\n`, { status });
  }
  // Drop unread guest bytes, or they fill the window and block the guest.
  await reader.cancel();
  try {
    await writeResponse(conn, response, method === 'HEAD', http10);
    await conn.end();
  } catch {
    conn.close();
    // The guest is gone: stop the body's producer.
    await response.body?.cancel().catch(() => {});
  }
}

/** The path and query of a request target, whatever its form. */
function pathOf(target: string): string {
  if (target.startsWith('/')) {
    return target;
  }
  try {
    const u = new URL(target);
    return `${u.pathname}${u.search}`;
  } catch {
    throw new HttpError(400, 'bad request target');
  }
}

interface RequestHead {
  method: string;
  target: string;
  version: string;
  headers: Headers;
}

function parseHead(bytes: Uint8Array): RequestHead {
  const text = new TextDecoder('latin1').decode(bytes);
  const lines = text.split('\r\n');
  const [method, target, version] = (lines.shift() ?? '').split(' ');
  if (!method || !target || !version?.startsWith('HTTP/1.')) {
    throw new HttpError(400, 'bad request line');
  }
  const headers = new Headers();
  for (const line of lines) {
    if (line === '') {
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) {
      throw new HttpError(400, 'bad header line');
    }
    try {
      headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    } catch {
      throw new HttpError(400, 'bad header line');
    }
  }
  return { headers, method: method.toUpperCase(), target, version };
}

async function readBody(
  reader: ByteReader,
  headers: Headers,
  max: number,
  beforeBody: () => Promise<void>,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const tooLarge = () => new HttpError(413, `the request body is over ${max} bytes`);
  if (headers.get('transfer-encoding')?.toLowerCase().includes('chunked')) {
    await beforeBody();
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const line = await reader.readUntil(CRLF, 1024);
      if (line === null) {
        throw new HttpError(400, 'the request body ended early');
      }
      const size = parseInt(new TextDecoder().decode(line).split(';')[0].trim(), 16);
      if (!Number.isFinite(size) || size < 0) {
        throw new HttpError(400, 'bad chunk size');
      }
      if (size === 0) {
        // Trailers, up to the empty line.
        while ((await reader.readUntil(CRLF, HEAD_MAX))?.length) {
          // skip
        }
        return concat(parts);
      }
      total += size;
      if (total > max) {
        throw tooLarge();
      }
      parts.push(await reader.readExact(size));
      await reader.readExact(2);
    }
  }
  const length = headers.get('content-length');
  if (length === null) {
    return null;
  }
  if (!/^\d+$/.test(length.trim())) {
    throw new HttpError(400, 'bad Content-Length');
  }
  const n = Number(length.trim());
  // Refuse before `100 Continue` invites the body.
  if (!Number.isSafeInteger(n) || n > max) {
    throw tooLarge();
  }
  await beforeBody();
  return reader.readExact(n);
}

async function writeResponse(conn: Connection, response: Response, head: boolean, http10: boolean): Promise<void> {
  const status = response.status;
  const lines = [`HTTP/1.1 ${status} ${response.statusText || REASONS[status] || ''}`];
  response.headers.forEach((value, name) => {
    if (!HOP_HEADERS.has(name) && name !== 'set-cookie') {
      lines.push(`${name}: ${value}`);
    }
  });
  for (const cookie of response.headers.getSetCookie?.() ?? []) {
    lines.push(`set-cookie: ${cookie}`);
  }
  const noBody = head || status === 204 || status === 304 || (status >= 100 && status < 200);
  const sized = response.headers.has('content-length');
  // HTTP/1.0 has no chunked encoding: the connection's end marks the body's.
  const chunked = !noBody && !!response.body && !sized && !http10;
  if (!response.body && !noBody && !sized) {
    lines.push('content-length: 0');
  }
  if (chunked) {
    lines.push('transfer-encoding: chunked');
  }
  lines.push('connection: close', '', '');
  await conn.write(lines.join('\r\n'));
  if (noBody || !response.body) {
    await response.body?.cancel();
    return;
  }
  for await (const chunk of iterate(response.body)) {
    if (chunk.length === 0) {
      continue;
    }
    await conn.write(chunked ? concat([ascii(`${chunk.length.toString(16)}\r\n`), chunk, CRLF]) : chunk);
  }
  if (chunked) {
    await conn.write('0\r\n\r\n');
  }
}

function ascii(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function* iterate(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Buffered reads over a byte stream. */
class ByteReader {
  private buf: Uint8Array = new Uint8Array(0);
  private done = false;

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  /** Bytes up to `delim` (dropped), or `null` at end of stream before any byte. */
  async readUntil(delim: Uint8Array, max: number): Promise<Uint8Array | null> {
    let from = 0;
    for (;;) {
      const at = indexOf(this.buf, delim, from);
      if (at >= 0) {
        const out = this.buf.slice(0, at);
        this.buf = this.buf.subarray(at + delim.length);
        return out;
      }
      if (this.buf.length > max) {
        throw new HttpError(431, 'the request head is too large');
      }
      from = Math.max(0, this.buf.length - delim.length + 1);
      const next = await this.next();
      if (!next) {
        if (this.buf.length === 0) {
          return null;
        }
        throw new HttpError(400, 'the request ended early');
      }
      this.buf = this.buf.length === 0 ? next : concat([this.buf, next]);
    }
  }

  /** Exactly `n` bytes, copied once. */
  async readExact(n: number): Promise<Uint8Array<ArrayBuffer>> {
    const parts: Uint8Array[] = [];
    let have = 0;
    while (have < n) {
      if (this.buf.length === 0) {
        const next = await this.next();
        if (!next) {
          throw new HttpError(400, 'the request body ended early');
        }
        this.buf = next;
      }
      const take = Math.min(n - have, this.buf.length);
      parts.push(this.buf.subarray(0, take));
      this.buf = this.buf.subarray(take);
      have += take;
    }
    return concat(parts);
  }

  /** Stop reading: the rest of the stream is dropped. */
  async cancel(): Promise<void> {
    await this.reader.cancel().catch(() => {});
  }

  private async next(): Promise<Uint8Array | null> {
    if (this.done) {
      return null;
    }
    const { done, value } = await this.reader.read();
    if (done) {
      this.done = true;
      return null;
    }
    return value;
  }
}

function indexOf(hay: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) {
        continue outer;
      }
    }
    return i;
  }
  return -1;
}
