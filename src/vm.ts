// A running VM, as a page holds it.

import {
  Arm64JSError,
  type ExecOptions,
  type ExecResult,
  type Host,
  type OutputInfo,
  type ReadFileOptions,
  type SnapshotInfo,
  type SnapshotOptions,
  type VmExit,
  type WriteFileOptions,
} from '@arm64js/protocol';
import { noConsoleInput, noFileSharing, owned } from './errors.js';
import { guestPath, mountFiles, type MountSource } from './mount.js';

/** What `writeFile` takes. */
export type FileData = Blob | BufferSource | string;

/** A live `mount`. */
export interface Mount {
  /** Where the files are in the guest. */
  readonly path: string;
  /** Remove the mount. Idempotent. */
  unmount(): Promise<void>;
}

/** A running VM. */
export class Vm {
  private disposed = false;
  /** The latest `mount` at each path, so an old handle cannot undo a newer one. */
  private readonly mounts = new Map<string, object>();

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
  exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    this.check();
    return owned(this.host.exec(this.id, command, opts));
  }

  /** The raw bytes the guest prints on its console. `info.exec` marks what an
   *  `exec` printed (its command, output and prompts). Returns the unsubscribe. */
  onOutput(cb: (bytes: Uint8Array, info: OutputInfo) => void): () => void {
    this.check();
    return this.host.onOutput(this.id, cb);
  }

  /** Type into the guest's console, as a person at a terminal would. Input
   *  sent while an `exec` or `snapshot` runs is held and delivered after it. */
  write(data: string): Promise<void> {
    this.check();
    if (!this.host.write) return Promise.reject(noConsoleInput());
    return owned(this.host.write(this.id, data));
  }

  /** Set the guest's terminal size, so full-screen programs lay out for it. */
  resize(cols: number, rows: number): Promise<void> {
    this.check();
    if (!this.host.resize) return Promise.reject(noConsoleInput());
    return owned(this.host.resize(this.id, cols, rows));
  }

  /** The guest's run ending (a halt, a fault). Returns the unsubscribe. */
  onExit(cb: (exit: VmExit) => void): () => void {
    this.check();
    return this.host.onExit(this.id, cb);
  }

  /** Show files to the guest, read-only, in the folder `path` (an absolute
   *  guest path, created if missing). A file is read only as the guest asks, so
   *  its size does not matter. Mounts are not kept in snapshots: mount again
   *  after booting one. */
  mount(source: MountSource, path: string): Promise<Mount> {
    this.check();
    if (!this.host.mount) return Promise.reject(noFileSharing());
    let at: string;
    let files: Record<string, Blob>;
    try {
      at = guestPath(path);
      files = mountFiles(source);
    } catch (e) {
      return Promise.reject(e);
    }
    // Taken before the call, so a handle for an earlier mount here sees it is stale.
    const token = {};
    const before = this.mounts.get(at);
    this.mounts.set(at, token);
    const handle: Mount = {
      path: at,
      unmount: async () => {
        if (this.mounts.get(at) === token) await this.unmount(at);
      },
    };
    return owned(this.host.mount(this.id, files, at)).then(
      () => handle,
      (e) => {
        if (this.mounts.get(at) === token) {
          if (before) this.mounts.set(at, before);
          else this.mounts.delete(at);
        }
        throw e;
      },
    );
  }

  /** Undo the `mount` at `path`. Idempotent. */
  unmount(path: string): Promise<void> {
    this.check();
    if (!this.host.unmount) return Promise.reject(noFileSharing());
    let at: string;
    try {
      at = guestPath(path);
    } catch (e) {
      return Promise.reject(e);
    }
    const token = this.mounts.get(at);
    return owned(this.host.unmount(this.id, at)).then(() => {
      // A mount started meanwhile keeps its token.
      if (this.mounts.get(at) === token) this.mounts.delete(at);
    });
  }

  /** Copy `data` into the guest as the file `path`, replacing it if it exists and
   *  creating its folder if missing. The file lives in guest memory: for a large
   *  one, `mount` it instead. */
  writeFile(path: string, data: FileData, opts?: WriteFileOptions): Promise<void> {
    this.check();
    if (!this.host.writeFile) return Promise.reject(noFileSharing());
    let blob: Blob;
    if (data instanceof Blob) blob = data;
    else if (typeof data === 'string' || data instanceof ArrayBuffer || ArrayBuffer.isView(data))
      blob = new Blob([data]);
    else return Promise.reject(new Arm64JSError('invalid-input', 'writeFile takes a Blob, bytes or a string'));
    return owned(this.host.writeFile(this.id, path, blob, opts));
  }

  /** Copy the guest's file `path` out, as a `Blob`. The copy is held in page
   *  memory. */
  readFile(path: string, opts?: ReadFileOptions): Promise<Blob> {
    this.check();
    if (!this.host.readFile) return Promise.reject(noFileSharing());
    return owned(this.host.readFile(this.id, path, opts));
  }

  /** Save the VM to this browser's storage. The VM keeps running. */
  snapshot(opts?: SnapshotOptions): Promise<SnapshotInfo> {
    this.check();
    return owned(this.host.snapshot(this.id, opts));
  }

  /** Stop the VM and free its workers. Idempotent. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.onDisposed(this);
    await owned(this.host.dispose(this.id));
  }

  private check(): void {
    if (this.disposed) throw new Arm64JSError('vm-lost', 'this VM was disposed');
  }
}
