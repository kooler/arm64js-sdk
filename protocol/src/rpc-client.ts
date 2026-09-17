// The page's half of the frame RPC: a `Host` whose every call crosses a
// `MessagePort` to the engine's `RpcServer` in the frame. It imports nothing
// but the protocol and names no runtime internals.
//
// Callbacks cannot cross the port, so the `Host`'s three are events:
// `onProgress` correlated by call id, `onOutput` switched on with
// `subscribeOutput`, `onExit` posted for every VM the server booted.

import {
  Arm64JSError,
  RPC_KIND,
  RPC_PING_MISSES,
  RPC_PING_MS,
  type BootOptions,
  type ExecOptions,
  type ExecResult,
  type Host,
  type MountFiles,
  type OutputInfo,
  type ReadFileOptions,
  type RpcCall,
  type RpcEvent,
  type RpcMessage,
  type SnapshotOptions,
  type VmExit,
  type WriteFileOptions,
} from './protocol.js';

/// The port shape both ends use (a `MessagePort`, or a double in tests).
export interface PortLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', cb: (ev: { data: unknown }) => void): void;
  removeEventListener(type: 'message', cb: (ev: { data: unknown }) => void): void;
  start?(): void;
  close?(): void;
}

export function isRpc(data: unknown): data is RpcMessage {
  return (
    !!data &&
    typeof data === 'object' &&
    (data as { kind?: unknown }).kind === RPC_KIND &&
    (data as { v?: unknown }).v === 1
  );
}

/// Timer seams, so the heartbeat is testable with fake time.
export interface ClientTimers {
  setInterval(cb: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/// Reports an engine without the file-sharing ops as `share-unavailable`. Its
/// server refuses them with the message `unknown op: <op>`, and that is all
/// there is to match on.
function fileOp<T>(p: Promise<T>): Promise<T> {
  return p.catch((e: unknown) => {
    const err = e as { code?: string; message?: string };
    if (err?.code === 'invalid-input' && /^unknown op: /.test(err.message ?? '')) {
      throw new Arm64JSError('share-unavailable', 'this engine cannot share files; it needs engine 0.4 or newer');
    }
    throw e;
  });
}

/// A `Host` over a port to an `RpcServer`. `lost` fires once when the other end
/// stops answering; every pending and later call then rejects with `vm-lost`.
export class RpcClient implements Host {
  private seq = 0;
  private readonly pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private readonly progress = new Map<number, (p: unknown) => void>();
  private readonly outputs = new Map<string, Set<(bytes: Uint8Array, info: OutputInfo) => void>>();
  private readonly exits = new Map<string, Set<(exit: VmExit) => void>>();
  private readonly lostListeners = new Set<() => void>();
  private lost = false;
  private missed = 0;
  private heartbeat: unknown = null;
  private readonly onMessage = (ev: { data: unknown }) => this.handle(ev.data);

  constructor(
    private readonly port: PortLike,
    private readonly timers: ClientTimers = globalThis,
    pingMs = RPC_PING_MS,
  ) {
    port.addEventListener('message', this.onMessage);
    port.start?.();
    this.heartbeat = timers.setInterval(() => this.tick(), pingMs);
  }

  onLost(cb: () => void): () => void {
    this.lostListeners.add(cb);
    return () => this.lostListeners.delete(cb);
  }

  close(): void {
    if (this.heartbeat !== null) this.timers.clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.port.removeEventListener('message', this.onMessage);
    this.port.close?.();
  }

  private tick(): void {
    if (this.lost) return;
    if (this.missed >= RPC_PING_MISSES) {
      this.markLost();
      return;
    }
    this.missed += 1;
    this.port.postMessage({ kind: RPC_KIND, v: 1, ping: Date.now() });
  }

  private markLost(): void {
    if (this.lost) return;
    this.lost = true;
    if (this.heartbeat !== null) this.timers.clearInterval(this.heartbeat);
    this.heartbeat = null;
    const err = new Arm64JSError('vm-lost', 'the VM frame stopped answering');
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    for (const cb of this.lostListeners) cb();
  }

  private handle(data: unknown): void {
    if (!isRpc(data)) return;
    if ('pong' in data) {
      this.missed = 0;
      return;
    }
    if ('ping' in data) return;
    if ('event' in data) {
      this.onEvent(data);
      return;
    }
    if ('re' in data) {
      const p = this.pending.get(data.re);
      if (!p) return;
      this.pending.delete(data.re);
      this.progress.delete(data.re);
      if (data.ok) p.resolve(data.value);
      else p.reject(new Arm64JSError(data.error.code, data.error.message));
    }
  }

  private onEvent(ev: RpcEvent): void {
    if (ev.event === 'progress' && ev.re !== undefined) {
      this.progress.get(ev.re)?.(ev.data);
    } else if (ev.event === 'output' && ev.vmId) {
      const bytes = ev.data instanceof Uint8Array ? ev.data : new Uint8Array(ev.data as ArrayLike<number>);
      const info: OutputInfo = ev.exec ? { exec: true } : {};
      for (const cb of this.outputs.get(ev.vmId) ?? []) cb(bytes, info);
    } else if (ev.event === 'exit' && ev.vmId) {
      for (const cb of this.exits.get(ev.vmId) ?? []) cb(ev.data as VmExit);
    }
  }

  private call<T>(op: string, args: unknown[], onProgress?: (p: unknown) => void): Promise<T> {
    if (this.lost) return Promise.reject(new Arm64JSError('vm-lost', 'the VM frame stopped answering'));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (onProgress) this.progress.set(id, onProgress);
      try {
        this.port.postMessage({ kind: RPC_KIND, v: 1, id, op, args } satisfies RpcCall);
      } catch (e) {
        // An argument that cannot be cloned.
        this.pending.delete(id);
        this.progress.delete(id);
        reject(new Arm64JSError('invalid-input', `${op}: ${String((e as Error)?.message ?? e)}`));
      }
    });
  }

  boot(target: string, opts: BootOptions = {}): Promise<{ vmId: string }> {
    const { onProgress, ...rest } = opts;
    return this.call('boot', [target, rest], onProgress as ((p: unknown) => void) | undefined);
  }

  exec(vmId: string, command: string, opts: ExecOptions = {}) {
    return this.call<ExecResult>('exec', [vmId, command, opts]);
  }

  onOutput(vmId: string, cb: (bytes: Uint8Array, info: OutputInfo) => void): () => void {
    let set = this.outputs.get(vmId);
    if (!set) {
      set = new Set();
      this.outputs.set(vmId, set);
      void this.call('subscribeOutput', [vmId]).catch(() => {});
    }
    set.add(cb);
    return () => {
      const s = this.outputs.get(vmId);
      if (!s) return;
      s.delete(cb);
      if (s.size === 0) {
        this.outputs.delete(vmId);
        void this.call('unsubscribeOutput', [vmId]).catch(() => {});
      }
    };
  }

  write(vmId: string, data: string): Promise<void> {
    return this.call<void>('write', [vmId, data]);
  }

  resize(vmId: string, cols: number, rows: number): Promise<void> {
    return this.call<void>('resize', [vmId, cols, rows]);
  }

  mount(vmId: string, files: MountFiles, path: string): Promise<void> {
    return fileOp(this.call<void>('mount', [vmId, files, path]));
  }

  unmount(vmId: string, path: string): Promise<void> {
    return fileOp(this.call<void>('unmount', [vmId, path]));
  }

  writeFile(vmId: string, path: string, data: Blob, opts: WriteFileOptions = {}): Promise<void> {
    return fileOp(this.call<void>('writeFile', [vmId, path, data, opts]));
  }

  readFile(vmId: string, path: string, opts: ReadFileOptions = {}): Promise<Blob> {
    return fileOp(this.call<Blob>('readFile', [vmId, path, opts]));
  }

  onExit(vmId: string, cb: (exit: VmExit) => void): () => void {
    let set = this.exits.get(vmId);
    if (!set) {
      set = new Set();
      this.exits.set(vmId, set);
    }
    set.add(cb);
    return () => {
      this.exits.get(vmId)?.delete(cb);
    };
  }

  async dispose(vmId: string): Promise<void> {
    this.outputs.delete(vmId);
    this.exits.delete(vmId);
    await this.call('dispose', [vmId]);
  }

  snapshot(vmId: string, opts: SnapshotOptions = {}) {
    const { onProgress, ...rest } = opts;
    return this.call<Awaited<ReturnType<Host['snapshot']>>>(
      'snapshot',
      [vmId, rest],
      onProgress ? (p) => onProgress((p as { done: number }).done, (p as { total: number }).total) : undefined,
    );
  }

  listSnapshots() {
    return this.call<Awaited<ReturnType<Host['listSnapshots']>>>('listSnapshots', []);
  }

  getSnapshot(id: string) {
    return this.call<Awaited<ReturnType<Host['getSnapshot']>>>('getSnapshot', [id]);
  }

  removeSnapshot(id: string, opts = {}) {
    return this.call<void>('removeSnapshot', [id, opts]);
  }

  storageStatus() {
    return this.call<Awaited<ReturnType<Host['storageStatus']>>>('storageStatus', []);
  }
}
