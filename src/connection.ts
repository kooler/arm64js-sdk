// A guest connection to `host.internal` as a byte stream. Writes wait while
// `HOST_CONN_WINDOW` bytes are unacknowledged; guest bytes are acknowledged only
// when read, so a slow page slows the guest. The page's side ends by itself once
// the page has read to the guest's end, as a Node socket's does.

import { Arm64JSError, HOST_CONN_CHUNK, HOST_CONN_WINDOW, type HostConnMessage } from '@arm64js/protocol';

/** What `write` takes. Strings are sent as UTF-8. */
export type ConnectionData = ArrayBuffer | ArrayBufferView | string;

/** One TCP connection the guest opened to `host.internal:<port>`. */
export class Connection implements AsyncIterable<Uint8Array> {
  /** The guest's bytes, in order. Ends when the guest closes its side. */
  readonly readable: ReadableStream<Uint8Array>;
  /** Writes go to the guest. Closing it is `end()`, aborting it is `close()`. */
  readonly writable: WritableStream<Uint8Array>;
  /** Resolves when the connection has ended both ways. */
  readonly closed: Promise<void>;

  private readonly inbox: Uint8Array[] = [];
  private remoteEnded = false;
  private isClosed = false;
  private localEnded = false;
  private readCancelled = false;
  private unacked = 0;
  private wake: (() => void) | null = null;
  private resolveClosed!: () => void;
  /** Writes in call order. */
  private writes: Promise<void> = Promise.resolve();

  /** @internal */
  constructor(
    private readonly port: MessagePort,
    /** The port the guest dialed. */
    readonly localPort: number,
  ) {
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    port.onmessage = (ev: MessageEvent<HostConnMessage>) => {
      this.onMessage(ev.data);
    };
    this.readable = new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          for (;;) {
            const chunk = this.inbox.shift();
            if (chunk) {
              this.post({ type: 'ack', bytes: chunk.length });
              controller.enqueue(chunk);
              return;
            }
            if (this.remoteEnded || this.isClosed) {
              controller.close();
              // The guest has ended and the page has seen it: end the page's side
              // too, after the writes already made. A page that forgot `end()`
              // would otherwise keep the connection, and its buffers in the VM.
              void this.end();
              return;
            }
            await this.waitForChange();
          }
        },
        // Writing goes on; guest bytes are dropped.
        cancel: () => {
          this.readCancelled = true;
          this.ackAll();
        },
      },
      { highWaterMark: 0 },
    );
    this.writable = new WritableStream<Uint8Array>({
      abort: () => {
        this.close();
      },
      close: async () => this.end(),
      write: async (chunk) => this.write(chunk),
    });
  }

  /** Send `data` to the guest. Resolves once it fits the window. */
  async write(data: ConnectionData): Promise<void> {
    const bytes = toBytes(data);
    const run = async (): Promise<void> => {
      for (let at = 0; at < bytes.length; at += HOST_CONN_CHUNK) {
        const piece = bytes.slice(at, at + HOST_CONN_CHUNK);
        while (!this.isClosed && this.unacked > 0 && this.unacked + piece.length > HOST_CONN_WINDOW) {
          await this.waitForChange();
        }
        if (this.isClosed) {
          throw new Arm64JSError('invalid-input', 'the connection is closed');
        }
        if (this.localEnded) {
          throw new Arm64JSError('invalid-input', 'write after end()');
        }
        this.unacked += piece.length;
        this.post({ type: 'data', data: piece }, [piece.buffer]);
      }
    };
    const next = this.writes.then(run);
    this.writes = next.catch(() => {});
    return next;
  }

  /** Half close after pending writes: the guest reads end-of-file but can still send. */
  async end(): Promise<void> {
    const run = (): void => {
      if (this.localEnded || this.isClosed) {
        return;
      }
      this.localEnded = true;
      this.post({ type: 'end' });
    };
    const next = this.writes.then(run);
    this.writes = next.catch(() => {});
    return next;
  }

  /** End both ways now. Bytes already sent still reach the guest; writes waiting
   *  for the window and later guest bytes are dropped. Idempotent. */
  close(): void {
    if (this.isClosed) {
      return;
    }
    this.post({ type: 'close' });
    this.finish();
  }

  /** @internal The VM went away; nothing more will arrive or leave. */
  lost(): void {
    if (!this.isClosed) {
      this.finish();
    }
  }

  /** Leaving a `for await` loop early keeps the connection open. */
  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array, void, undefined> {
    const reader = this.readable.getReader();
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) {
          return;
        }
        yield r.value;
      }
    } finally {
      reader.releaseLock();
    }
  }

  private onMessage(msg: HostConnMessage): void {
    if (this.isClosed) {
      return;
    }
    switch (msg?.type) {
      case 'data':
        if (msg.data instanceof Uint8Array && msg.data.length > 0 && !this.remoteEnded) {
          this.inbox.push(msg.data);
          if (this.readCancelled) {
            this.ackAll();
          }
        }
        break;
      case 'ack':
        this.unacked = Math.max(0, this.unacked - (Number(msg.bytes) || 0));
        break;
      case 'end':
        this.remoteEnded = true;
        break;
      case 'close':
        this.finish();
        return;
      default:
        return;
    }
    this.notify();
  }

  private ackAll(): void {
    const bytes = this.inbox.reduce((n, c) => n + c.length, 0);
    this.inbox.length = 0;
    if (bytes > 0) {
      this.post({ type: 'ack', bytes });
    }
  }

  private finish(): void {
    this.isClosed = true;
    this.port.onmessage = null;
    this.port.close();
    this.notify();
    this.resolveClosed();
  }

  private post(msg: HostConnMessage, transfer: Transferable[] = []): void {
    if (this.isClosed) {
      return;
    }
    try {
      this.port.postMessage(msg, transfer);
    } catch {
      this.finish();
    }
  }

  private async waitForChange(): Promise<void> {
    return new Promise((resolve) => {
      const prev = this.wake;
      this.wake = () => {
        prev?.();
        resolve();
      };
    });
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }
}

/** A copy of `data`; it is transferred away. */
function toBytes(data: ConnectionData): Uint8Array {
  if (typeof data === 'string') {
    return new TextEncoder().encode(data);
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data.slice(0));
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
  }
  throw new Arm64JSError('invalid-input', 'write takes bytes or a string');
}
