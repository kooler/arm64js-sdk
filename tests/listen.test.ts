// `vm.listen` and `vm.serveHttp` over real `MessageChannel`s, with a fake engine
// that speaks `HostConnMessage` like `web/src/net/host-ports.ts`.

import {
  Arm64JSError,
  HOST_CONN_WINDOW,
  type Host,
  type HostConnect,
  type HostConnMessage,
  type HostListenerMessage,
} from '@arm64js/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { Connection } from '../src/connection.ts';
import { Vm } from '../src/vm.ts';

/** A host whose `listen` hands back one end of a channel and keeps the other. */
function fakeHost(withListen = true) {
  const engineEnds = new Map<number, MessagePort>();
  const exits: Array<(e: { reason: string }) => void> = [];
  // Like the engine: `closed` once it stops.
  const unlisten = vi.fn(async (_vmId: string, port: number): Promise<void> => {
    engineEnds.get(port)?.postMessage({ type: 'closed' } satisfies HostListenerMessage);
  });
  const host = {
    onExit: (_vmId: string, cb: (e: { reason: string }) => void) => {
      exits.push(cb);
      return () => {};
    },
    listen: withListen
      ? async (_vmId: string, port: number) => {
          const ch = new MessageChannel();
          engineEnds.set(port, ch.port2);
          return ch.port1;
        }
      : undefined,
    unlisten: withListen ? unlisten : undefined,
    dispose: async () => {},
  } as unknown as Host;
  const exit = () => {
    for (const cb of exits) {
      cb({ reason: 'halted' });
    }
  };
  return { engineEnds, exit, host, unlisten };
}

/** The guest's end of one connection, as the net worker would drive it. */
class Guest {
  readonly received: Uint8Array[] = [];
  ended = false;
  closed = false;
  private waiters: Array<() => void> = [];

  constructor(
    readonly port: MessagePort,
    /** Acknowledge page bytes as they arrive. */
    private autoAck = true,
  ) {
    port.onmessage = (ev: MessageEvent<HostConnMessage>) => {
      const m = ev.data;
      if (m.type === 'data') {
        this.received.push(m.data);
        if (this.autoAck) {
          this.ack(m.data.length);
        }
      } else if (m.type === 'end') {
        this.ended = true;
      } else if (m.type === 'close') {
        this.closed = true;
      }
      for (const w of this.waiters.splice(0)) {
        w();
      }
    };
  }

  ack(bytes: number): void {
    this.port.postMessage({ type: 'ack', bytes } satisfies HostConnMessage);
  }

  send(data: string | Uint8Array): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    this.port.postMessage({ type: 'data', data: bytes } satisfies HostConnMessage, [bytes.buffer]);
  }

  end(): void {
    this.port.postMessage({ type: 'end' } satisfies HostConnMessage);
  }

  bytes(): number {
    return this.received.reduce((n, b) => n + b.length, 0);
  }

  text(): string {
    return new TextDecoder().decode(concat(this.received));
  }

  async until(cond: () => boolean): Promise<void> {
    while (!cond()) {
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Open a guest connection to `port` through the listener the page registered. */
function dial(engineEnds: Map<number, MessagePort>, port: number, autoAck = true): Guest {
  const listener = engineEnds.get(port)!;
  const ch = new MessageChannel();
  listener.postMessage({ conn: ch.port2, port, type: 'connect' } satisfies HostConnect, [ch.port2]);
  return new Guest(ch.port1, autoAck);
}

const tick = async () => new Promise((r) => setTimeout(r, 5));

async function vmWithListener(port = 8080) {
  const fake = fakeHost();
  const vm = new Vm('vm1', fake.host, '0.6', () => {});
  const conns: Connection[] = [];
  const listener = await vm.listen(port, (c) => conns.push(c));
  return { ...fake, conns, listener, vm };
}

describe('vm.listen', () => {
  it('hands each guest connection to the callback, both directions working', async () => {
    const { conns, engineEnds } = await vmWithListener();
    const guest = dial(engineEnds, 8080);
    guest.send('ping');
    guest.end();
    await tick();
    expect(conns).toHaveLength(1);
    const conn = conns[0];
    expect(conn.localPort).toBe(8080);
    const got: string[] = [];
    for await (const chunk of conn) {
      got.push(new TextDecoder().decode(chunk));
    }
    expect(got.join('')).toBe('ping');
    await conn.write('pong');
    await conn.end();
    await guest.until(() => guest.ended);
    expect(guest.text()).toBe('pong');
  });

  it('keeps the connection open when a for-await loop is left early', async () => {
    const { conns, engineEnds } = await vmWithListener();
    const guest = dial(engineEnds, 8080);
    guest.send('line one\n');
    await tick();
    const conn = conns[0];
    for await (const chunk of conn) {
      expect(new TextDecoder().decode(chunk)).toBe('line one\n');
      break;
    }
    await conn.write('reply');
    await conn.end();
    await guest.until(() => guest.ended);
    expect(guest.text()).toBe('reply');
    expect(guest.closed).toBe(false);
  });

  it('drops and acknowledges guest bytes after the readable is cancelled, and still writes', async () => {
    const { conns, engineEnds } = await vmWithListener();
    const guest = dial(engineEnds, 8080);
    const acks: number[] = [];
    guest.port.addEventListener('message', (ev: MessageEvent<HostConnMessage>) => {
      if (ev.data.type === 'ack') {
        acks.push(ev.data.bytes);
      }
    });
    guest.send('abc');
    await tick();
    await conns[0].readable.cancel();
    guest.send('defg');
    await tick();
    expect(acks).toEqual([3, 4]);
    await conns[0].write('still');
    await guest.until(() => guest.text() === 'still');
  });

  it('acknowledges guest bytes only when they are read', async () => {
    const { conns, engineEnds } = await vmWithListener();
    const guest = dial(engineEnds, 8080);
    const acks: number[] = [];
    guest.port.addEventListener('message', (ev: MessageEvent<HostConnMessage>) => {
      if (ev.data.type === 'ack') {
        acks.push(ev.data.bytes);
      }
    });
    guest.send('abc');
    await tick();
    expect(acks).toEqual([]);
    const reader = conns[0].readable.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('abc');
    await tick();
    expect(acks).toEqual([3]);
  });

  it('holds writes past the window until the guest acknowledges', async () => {
    const { conns, engineEnds } = await vmWithListener();
    const guest = dial(engineEnds, 8080, false);
    await tick();
    const big = new Uint8Array(HOST_CONN_WINDOW * 3).fill(1);
    let done = false;
    const writing = conns[0].write(big).then(() => (done = true));
    await guest.until(() => guest.bytes() >= HOST_CONN_WINDOW);
    await tick();
    expect(guest.bytes()).toBe(HOST_CONN_WINDOW);
    expect(done).toBe(false);
    // Acknowledge until everything is through.
    while (guest.bytes() < big.length) {
      guest.ack(HOST_CONN_WINDOW);
      await guest.until(() => guest.bytes() % HOST_CONN_WINDOW === 0);
      await tick();
    }
    await writing;
    expect(done).toBe(true);
  });

  it('ends the connection both ways on close, and rejects later writes', async () => {
    const { conns, engineEnds } = await vmWithListener();
    const guest = dial(engineEnds, 8080);
    await tick();
    const conn = conns[0];
    conn.close();
    await conn.closed;
    await guest.until(() => guest.closed);
    await expect(conn.write('x')).rejects.toMatchObject({ code: 'invalid-input' });
  });

  it('sees the guest closing the connection', async () => {
    const { conns, engineEnds } = await vmWithListener();
    const guest = dial(engineEnds, 8080);
    await tick();
    guest.port.postMessage({ type: 'close' } satisfies HostConnMessage);
    await conns[0].closed;
    expect((await conns[0].readable.getReader().read()).done).toBe(true);
  });

  it('unlistens on close, and on dispose', async () => {
    const { listener, unlisten, vm } = await vmWithListener();
    await listener.close();
    expect(unlisten).toHaveBeenCalledWith('vm1', 8080);
    await listener.close();
    expect(unlisten).toHaveBeenCalledTimes(1);
    await vm.listen(9000, () => {});
    await vm.dispose();
    await expect(vm.listen(9001, () => {})).rejects.toMatchObject({ code: 'vm-lost' });
  });

  it('ends open connections when the VM is disposed', async () => {
    const { conns, engineEnds, vm } = await vmWithListener();
    dial(engineEnds, 8080);
    await tick();
    const reading = conns[0].readable.getReader().read();
    await vm.dispose();
    await conns[0].closed;
    expect((await reading).done).toBe(true);
  });

  it('closes the connection when an async callback rejects', async () => {
    const fake = fakeHost();
    const vm = new Vm('vm1', fake.host, '0.6', () => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await vm.listen(8080, async () => {
      await tick();
      throw new Error('handler bug');
    });
    const guest = dial(fake.engineEnds, 8080);
    await guest.until(() => guest.closed);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it('refuses a connection that arrives while the listener closes', async () => {
    const { conns, engineEnds, listener, unlisten } = await vmWithListener();
    let finish!: () => void;
    unlisten.mockImplementationOnce(async () => new Promise<void>((r) => (finish = r)));
    const closing = listener.close();
    const late = dial(engineEnds, 8080);
    await late.until(() => late.closed);
    expect(conns).toHaveLength(0);
    finish();
    engineEnds.get(8080)!.postMessage({ type: 'closed' } satisfies HostListenerMessage);
    await closing;
  });

  it('turns an older engine’s unknown op into listen-failed', async () => {
    const host = {
      listen: async () => {
        throw new Arm64JSError('invalid-input', 'unknown op: listen');
      },
      unlisten: async () => {},
    } as unknown as Host;
    const vm = new Vm('vm1', host, '0.5', () => {});
    await expect(vm.listen(80, () => {})).rejects.toMatchObject({ code: 'listen-failed' });
  });

  it('ends listeners and open connections when the guest exits, and close() stays quiet', async () => {
    const { conns, engineEnds, exit, listener, unlisten } = await vmWithListener();
    dial(engineEnds, 8080);
    await tick();
    const reading = conns[0].readable.getReader().read();
    exit();
    await conns[0].closed;
    expect((await reading).done).toBe(true);
    unlisten.mockRejectedValueOnce(new Arm64JSError('vm-exited', 'the VM has exited (halted)'));
    await expect(listener.close()).resolves.toBeUndefined();
  });

  it('waits for the engine to confirm, refusing connections sent before it did', async () => {
    const { conns, engineEnds, listener, unlisten } = await vmWithListener();
    let late: Guest | null = null;
    unlisten.mockImplementationOnce(async (_vmId: string, port: number) => {
      // A connection sent just before `closed`.
      late = dial(engineEnds, port);
      engineEnds.get(port)!.postMessage({ type: 'closed' } satisfies HostListenerMessage);
    });
    await listener.close();
    await late!.until(() => late!.closed);
    expect(conns).toHaveLength(0);
  });

  it('closes a listener that arrives after dispose', async () => {
    const fake = fakeHost();
    const vm = new Vm('vm1', fake.host, '0.6', () => {});
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const realListen = fake.host.listen!.bind(fake.host);
    fake.host.listen = async (vmId, port) => {
      await gate;
      return realListen(vmId, port);
    };
    const listening = vm.listen(8080, () => {});
    await vm.dispose();
    release();
    await expect(listening).rejects.toMatchObject({ code: 'vm-lost' });
  });

  it('says so on an engine without host ports', async () => {
    const vm = new Vm('vm1', fakeHost(false).host, '0.5', () => {});
    await expect(vm.listen(80, () => {})).rejects.toMatchObject({ code: 'listen-failed' });
  });
});

/** Send a raw HTTP request as the guest and read the whole response. */
async function request(engineEnds: Map<number, MessagePort>, raw: string | Uint8Array, port = 8080) {
  const guest = dial(engineEnds, port);
  guest.send(raw);
  await guest.until(() => guest.ended);
  return { guest, text: guest.text() };
}

/** The body of the last response in `text`, de-chunked when it was chunked;
 *  `null` when a chunked body never reached its last chunk. */
function bodyOf(text: string): string | null {
  const start = text.lastIndexOf('HTTP/1.1 ');
  const sep = text.indexOf('\r\n\r\n', start);
  const head = text.slice(start, sep).toLowerCase();
  let rest = text.slice(sep + 4);
  if (!head.includes('transfer-encoding: chunked')) {
    return rest;
  }
  let out = '';
  for (;;) {
    const nl = rest.indexOf('\r\n');
    if (nl < 0) {
      return null;
    }
    const n = parseInt(rest.slice(0, nl), 16);
    if (n === 0) {
      return out;
    }
    out += rest.slice(nl + 2, nl + 2 + n);
    rest = rest.slice(nl + 2 + n + 2);
  }
}

async function server(handler: (r: Request) => Promise<Response> | Response) {
  const fake = fakeHost();
  const vm = new Vm('vm1', fake.host, '0.6', () => {});
  await vm.serveHttp(8080, handler);
  return fake;
}

describe('vm.serveHttp', () => {
  it('answers a GET with the handler response', async () => {
    const seen: Request[] = [];
    const { engineEnds } = await server((req) => {
      seen.push(req);
      return new Response('hello', { headers: { 'x-test': '1' } });
    });
    const { text } = await request(engineEnds, 'GET /v1/models?x=1 HTTP/1.1\r\nHost: host.internal:8080\r\n\r\n');
    expect(seen[0].url).toBe('http://host.internal:8080/v1/models?x=1');
    expect(seen[0].method).toBe('GET');
    expect(text).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
    expect(text).toContain('x-test: 1\r\n');
    expect(text).toContain('connection: close\r\n');
    expect(text).toContain('transfer-encoding: chunked\r\n');
    expect(bodyOf(text)).toBe('hello');
  });

  it('passes a request body with Content-Length', async () => {
    const { engineEnds } = await server(async (req) => Response.json({ got: (await req.json()) as unknown }));
    const body = JSON.stringify({ model: 'm', stream: true });
    const { text } = await request(
      engineEnds,
      `POST /v1/chat/completions HTTP/1.1\r\nHost: h\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
    );
    expect(bodyOf(text)).toBe(JSON.stringify({ got: { model: 'm', stream: true } }));
  });

  it('decodes a chunked request body and answers Expect: 100-continue', async () => {
    const { engineEnds } = await server(async (req) => new Response(await req.text()));
    const { text } = await request(
      engineEnds,
      'POST / HTTP/1.1\r\nHost: h\r\nExpect: 100-continue\r\nTransfer-Encoding: chunked\r\n\r\n' +
        '5\r\nhello\r\n6;ext=1\r\n world\r\n0\r\n\r\n',
    );
    expect(text).toMatch(/^HTTP\/1\.1 100 Continue\r\n\r\nHTTP\/1\.1 200 OK\r\n/);
    expect(bodyOf(text)).toBe('hello world');
  });

  it('streams a response body as it is produced', async () => {
    let push!: (s: string) => void;
    let finish!: () => void;
    const { engineEnds } = await server(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              push = (s) => controller.enqueue(new TextEncoder().encode(s));
              finish = () => controller.close();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const guest = dial(engineEnds, 8080);
    guest.send('GET /events HTTP/1.1\r\nHost: h\r\n\r\n');
    await guest.until(() => guest.text().includes('\r\n\r\n'));
    push('data: 1\n\n');
    await guest.until(() => guest.text().includes('data: 1\n\n'));
    expect(guest.ended).toBe(false);
    push('data: 2\n\n');
    finish();
    await guest.until(() => guest.ended);
    expect(bodyOf(guest.text())).toBe('data: 1\n\ndata: 2\n\n');
  });

  it('answers 500 when the handler throws, and 400 for a bad request', async () => {
    const { engineEnds } = await server(() => {
      throw new Error('boom');
    });
    expect((await request(engineEnds, 'GET / HTTP/1.1\r\nHost: h\r\n\r\n')).text).toMatch(
      /^HTTP\/1\.1 500 Internal Server Error\r\n[\s\S]*boom/,
    );
    expect((await request(engineEnds, 'nonsense\r\n\r\n')).text).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/);
  });

  it('leaves a body that fails halfway without its last chunk', async () => {
    const { engineEnds } = await server(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('partial'));
            },
            pull(controller) {
              if (controller.desiredSize !== null && controller.desiredSize > 0) {
                controller.error(new Error('the model crashed'));
              }
            },
          }),
        ),
    );
    const guest = dial(engineEnds, 8080);
    guest.send('GET / HTTP/1.1\r\nHost: h\r\n\r\n');
    await guest.until(() => guest.closed);
    expect(guest.text()).toContain('partial');
    expect(bodyOf(guest.text())).toBeNull();
  });

  it('drops a request it answered early, so the guest is not blocked', async () => {
    const { engineEnds } = await server(() => new Response('unused'));
    const guest = dial(engineEnds, 8080);
    const acked: number[] = [];
    guest.port.addEventListener('message', (ev: MessageEvent<HostConnMessage>) => {
      if (ev.data.type === 'ack') {
        acked.push(ev.data.bytes);
      }
    });
    guest.send('POST / HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n');
    await guest.until(() => guest.ended);
    expect(guest.text()).toMatch(/^HTTP\/1\.1 400 /);
    guest.send(new Uint8Array(5000));
    await tick();
    expect(acked.at(-1)).toBe(5000);
  });

  it('refuses a body over maxBodyBytes with 413, before reading it', async () => {
    const fake = fakeHost();
    const vm = new Vm('vm1', fake.host, '0.6', () => {});
    const handler = vi.fn(() => new Response('unused'));
    await vm.serveHttp(8080, handler, { maxBodyBytes: 10 });
    const big = await request(
      fake.engineEnds,
      'POST / HTTP/1.1\r\nHost: h\r\nExpect: 100-continue\r\nContent-Length: 999999999999\r\n\r\n',
    );
    expect(big.text).toMatch(/^HTTP\/1\.1 413 /);
    expect(big.text).not.toContain('100 Continue');
    const chunked = await request(
      fake.engineEnds,
      'POST / HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: chunked\r\n\r\n8\r\n12345678\r\n8\r\n12345678\r\n0\r\n\r\n',
    );
    expect(chunked.text).toMatch(/^HTTP\/1\.1 413 /);
    expect(handler).not.toHaveBeenCalled();
  });

  it('keeps the request origin the page’s own, whatever the guest sends', async () => {
    const seen: string[] = [];
    const { engineEnds } = await server((req) => {
      seen.push(req.url);
      return new Response('ok');
    });
    await request(engineEnds, 'GET https://bank.example/admin?x=1 HTTP/1.1\r\nHost: bank.example\r\n\r\n');
    await request(engineEnds, 'GET /p HTTP/1.1\r\nHost: evil.example\r\n\r\n');
    expect(seen).toEqual(['http://host.internal:8080/admin?x=1', 'http://host.internal:8080/p']);
  });

  it('answers HTTP/1.0 without chunked encoding', async () => {
    const { engineEnds } = await server(() => new Response('plain body'));
    const { text } = await request(engineEnds, 'GET / HTTP/1.0\r\n\r\n');
    expect(text).not.toContain('transfer-encoding');
    expect(text.endsWith('\r\n\r\nplain body')).toBe(true);
  });

  it('cancels the response body when the guest goes away mid-stream', async () => {
    let cancelled = false;
    let push!: (s: string) => void;
    const { engineEnds } = await server(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
            start(controller) {
              push = (t) => controller.enqueue(new TextEncoder().encode(t));
            },
          }),
        ),
    );
    const guest = dial(engineEnds, 8080);
    guest.send('GET / HTTP/1.1\r\nHost: h\r\n\r\n');
    await guest.until(() => guest.text().includes('\r\n\r\n'));
    guest.port.postMessage({ type: 'close' } satisfies HostConnMessage);
    await tick();
    push('more');
    await tick();
    expect(cancelled).toBe(true);
  });

  it('sends no body for HEAD', async () => {
    const { engineEnds } = await server(() => new Response('body', { headers: { 'content-length': '4' } }));
    const { text } = await request(engineEnds, 'HEAD / HTTP/1.1\r\nHost: h\r\n\r\n');
    expect(text).toContain('content-length: 4\r\n');
    expect(text.endsWith('\r\n\r\n')).toBe(true);
  });
});
