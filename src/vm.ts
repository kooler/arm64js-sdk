import {
  Arm64JSError,
  type ExecOptions,
  type ExecResult,
  type Host,
  type HostListenerMessage,
  type OutputInfo,
  type ReadFileOptions,
  type SnapshotInfo,
  type SnapshotOptions,
  type VmExit,
  type WriteFileOptions,
} from '@arm64js/protocol';
import { Connection } from './connection.js';
import { withSdkErrors } from './errors.js';
import { serveConnection, type HttpHandler } from './http.js';
import { guestPath, mountFiles, type MountSource } from './mount.js';

/** The `onExit` a VM gets when its frame stops answering. */
const LOST_EXIT: VmExit = { reason: 'lost' };

/** What `writeFile` takes. */
export type FileData = Blob | BufferSource | string;

/** A live `mount`. */
export interface Mount {
  /** Where the files are in the guest. */
  readonly path: string;
  /** Remove the mount. Idempotent. */
  unmount(): Promise<void>;
}

/** How long `Listener.close` waits for the engine to confirm. */
const UNLISTEN_WAIT_MS = 5000;

/** `serveHttp`'s default request body limit. */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024;

export interface ServeHttpOptions {
  /** Larger request bodies are refused with 413 (default 64 MiB). */
  maxBodyBytes?: number;
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A live `listen`. */
export interface Listener {
  /** The port the guest dials on `host.internal`. */
  readonly port: number;
  /** Take no new connections. Open ones keep going. Idempotent. */
  close(): Promise<void>;
}

/** A running VM. */
export class Vm {
  private disposed = false;
  private frameLost = false;
  private readonly exitListeners = new Set<(exit: VmExit) => void>();
  /** The latest `mount` at each path, so an old handle cannot undo a newer one. */
  private readonly mounts = new Map<string, object>();
  /** Listener ports by guest port. */
  private readonly listeners = new Map<number, MessagePort>();
  /** Open guest connections, ended when the VM goes away. */
  private readonly connections = new Set<Connection>();
  private exitWatched = false;
  private exited = false;

  /** @internal */
  constructor(
    readonly id: string,
    private readonly host: Host,
    /** The engine this VM runs on (`'0.11'`). */
    readonly engine: string,
    private readonly onDisposed: (vm: Vm) => void,
  ) {}

  /** Run a shell command (one or more lines) in the guest and get its output and
   *  exit code. One at a time per VM. */
  async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    this.check();
    return withSdkErrors(this.host.exec(this.id, command, opts));
  }

  /** The raw bytes the guest prints on its console. While an `exec` runs, only
   *  what its command prints comes through, marked `info.exec`. Returns the
   *  unsubscribe. */
  onOutput(cb: (bytes: Uint8Array, info: OutputInfo) => void): () => void {
    this.check();
    return this.host.onOutput(this.id, cb);
  }

  /** Type into the guest's console, as a person at a terminal would. Input
   *  sent while an `exec` or `snapshot` runs is held and delivered after it. */
  async write(data: string): Promise<void> {
    this.check();
    return withSdkErrors(this.host.write(this.id, data));
  }

  /** Set the guest's terminal size, so full-screen programs lay out for it. */
  async resize(cols: number, rows: number): Promise<void> {
    this.check();
    return withSdkErrors(this.host.resize(this.id, cols, rows));
  }

  /** The guest's run ending (a halt, a fault). Returns the unsubscribe. */
  onExit(cb: (exit: VmExit) => void): () => void {
    this.check();
    if (this.frameLost) {
      queueMicrotask(() => cb(LOST_EXIT));
      return () => {};
    }
    const unsubscribe = this.host.onExit(this.id, cb);
    this.exitListeners.add(cb);
    return () => {
      unsubscribe();
      this.exitListeners.delete(cb);
    };
  }

  /** Show files to the guest, read-only, in the folder `path` (an absolute
   *  guest path, created if missing). A file is read only as the guest asks, so
   *  its size does not matter. Mounts are not kept in snapshots: mount again
   *  after booting one. */
  async mount(source: MountSource, path: string): Promise<Mount> {
    this.check();
    const guestDir = guestPath(path);
    const files = mountFiles(source);
    if (this.mounts.has(guestDir)) {
      throw new Arm64JSError('invalid-input', `mount: ${guestDir} is already mounted, unmount it first`);
    }
    // Taken before the call, so a second mount here is refused while this one runs.
    const token = {};
    this.mounts.set(guestDir, token);
    const handle: Mount = {
      path: guestDir,
      unmount: async () => {
        if (this.mounts.get(guestDir) === token) {
          await this.unmount(guestDir);
        }
      },
    };
    try {
      await withSdkErrors(this.host.mount(this.id, files, guestDir));
    } catch (e) {
      // An unmount meanwhile may have let a newer mount take the path.
      if (this.mounts.get(guestDir) === token) {
        this.mounts.delete(guestDir);
      }
      throw e;
    }
    return handle;
  }

  /** Undo the `mount` at `path`. Idempotent. */
  async unmount(path: string): Promise<void> {
    this.check();
    const guestDir = guestPath(path);
    const token = this.mounts.get(guestDir);
    await withSdkErrors(this.host.unmount(this.id, guestDir));
    // A mount started meanwhile keeps its token.
    if (this.mounts.get(guestDir) === token) {
      this.mounts.delete(guestDir);
    }
  }

  /** Copy `data` into the guest as the file `path`, replacing it if it exists and
   *  creating its folder if missing. The file lives in guest memory: for a large
   *  one, `mount` it instead. */
  async writeFile(path: string, data: FileData, opts?: WriteFileOptions): Promise<void> {
    this.check();
    let blob: Blob;
    if (data instanceof Blob) {
      blob = data;
    } else if (typeof data === 'string' || data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      blob = new Blob([data]);
    } else {
      throw new Arm64JSError('invalid-input', 'writeFile takes a Blob, bytes or a string');
    }
    return withSdkErrors(this.host.writeFile(this.id, path, blob, opts));
  }

  /** Copy the guest's file `path` out, as a `Blob`. The copy is held in page
   *  memory. */
  async readFile(path: string, opts?: ReadFileOptions): Promise<Blob> {
    this.check();
    return withSdkErrors(this.host.readFile(this.id, path, opts));
  }

  /** Take guest connections to `host.internal:<port>`; `onConnection` gets each as
   *  a byte stream. Ports nobody listens on refuse connections. Not kept in
   *  snapshots. */
  async listen(port: number, onConnection: (conn: Connection) => unknown): Promise<Listener> {
    this.check();
    if (typeof onConnection !== 'function') {
      throw new Arm64JSError('invalid-input', 'listen needs a function to call for each connection');
    }
    const host = this.host;
    if (!host.listen || !host.unlisten) {
      throw new Arm64JSError(
        'listen-failed',
        `engine ${this.engine} cannot take connections from the guest; update the arm64js package`,
      );
    }
    const unlisten = host.unlisten.bind(host);
    let listener: MessagePort;
    try {
      listener = await withSdkErrors(host.listen(this.id, port));
    } catch (e) {
      // An engine from before protocol 1.2 does not know the op.
      if ((e as Arm64JSError).code === 'invalid-input' && /unknown op/.test(String((e as Error).message))) {
        throw new Arm64JSError(
          'listen-failed',
          `engine ${this.engine} cannot take connections from the guest; update the arm64js package`,
        );
      }
      throw e;
    }
    if (this.gone()) {
      listener.close();
      throw new Arm64JSError('vm-lost', 'the VM went away while listen ran');
    }
    this.watchExit();
    let closing = false;
    let engineDone: (() => void) | null = null;
    this.listeners.set(port, listener);
    listener.onmessage = (ev: MessageEvent<HostListenerMessage>) => {
      if (ev.data?.type === 'closed') {
        engineDone?.();
        return;
      }
      if (ev.data?.type !== 'connect' || !(ev.data.conn instanceof MessagePort)) {
        return;
      }
      const conn = new Connection(ev.data.conn, ev.data.port);
      // Refuse rather than leave it hanging.
      if (closing || this.gone()) {
        conn.close();
        return;
      }
      this.connections.add(conn);
      void conn.closed.then(() => this.connections.delete(conn));
      const fail = (e: unknown) => {
        console.error('[arm64js] listen callback failed', e);
        conn.close();
      };
      try {
        const r = onConnection(conn);
        if (r && typeof (r as Promise<unknown>).then === 'function') {
          (r as Promise<unknown>).then(undefined, fail);
        }
      } catch (e) {
        fail(e);
      }
    };
    return {
      close: async () => {
        if (closing || this.listeners.get(port) !== listener) {
          return;
        }
        closing = true;
        try {
          if (!this.gone()) {
            // Wait for `closed` so no connection in flight is lost.
            const done = new Promise<void>((resolve) => {
              engineDone = resolve;
            });
            await withSdkErrors(unlisten(this.id, port));
            await Promise.race([done, delay(UNLISTEN_WAIT_MS)]);
          }
        } catch (e) {
          // The VM stopped: nothing is listening anyway.
          const code = (e as Arm64JSError).code;
          if (code !== 'vm-exited' && code !== 'vm-lost') {
            throw e;
          }
        } finally {
          if (this.listeners.get(port) === listener) {
            this.listeners.delete(port);
          }
          listener.close();
        }
      },
      port,
    };
  }

  /** Serve HTTP on `host.internal:<port>`: each guest request becomes a `Request`;
   *  the handler's `Response` streams back. */
  async serveHttp(port: number, handler: HttpHandler, opts: ServeHttpOptions = {}): Promise<Listener> {
    if (typeof handler !== 'function') {
      throw new Arm64JSError('invalid-input', 'serveHttp needs a function that answers a Request');
    }
    const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 0) {
      throw new Arm64JSError('invalid-input', 'maxBodyBytes must be a whole number of bytes');
    }
    return this.listen(port, (conn) => {
      void serveConnection(conn, handler, { maxBodyBytes });
    });
  }

  /** Save the VM to this browser's storage. The VM keeps running. */
  async snapshot(opts?: SnapshotOptions): Promise<SnapshotInfo> {
    this.check();
    return withSdkErrors(this.host.snapshot(this.id, opts));
  }

  /** Stop the VM and free its workers. Idempotent. */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.closeListeners();
    this.onDisposed(this);
    await withSdkErrors(this.host.dispose(this.id));
  }

  /** @internal The frame this VM ran in stopped answering. */
  lost(): void {
    if (this.frameLost) {
      return;
    }
    this.frameLost = true;
    this.closeListeners();
    for (const cb of [...this.exitListeners]) {
      cb(LOST_EXIT);
    }
    this.exitListeners.clear();
  }

  /** The VM is gone and its workers cannot say so: end everything here. */
  private closeListeners(): void {
    for (const listener of this.listeners.values()) {
      listener.close();
    }
    this.listeners.clear();
    for (const conn of this.connections) {
      conn.lost();
    }
    this.connections.clear();
  }

  /** The guest's workers stop without notice, so end everything on exit. */
  private watchExit(): void {
    if (this.exitWatched) {
      return;
    }
    this.exitWatched = true;
    try {
      this.host.onExit(this.id, () => {
        this.exited = true;
        this.closeListeners();
      });
    } catch {
      // Unknown VM: dispose cleans up.
    }
  }

  private gone(): boolean {
    return this.disposed || this.frameLost || this.exited;
  }

  private check(): void {
    if (this.disposed) {
      throw new Arm64JSError('vm-lost', 'this VM was disposed');
    }
  }
}
