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
import { withSdkErrors } from './errors.js';
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

/** A running VM. */
export class Vm {
  private disposed = false;
  private frameLost = false;
  private readonly exitListeners = new Set<(exit: VmExit) => void>();
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
  async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    this.check();
    return withSdkErrors(this.host.exec(this.id, command, opts));
  }

  /** The raw bytes the guest prints on its console. `info.exec` marks what an
   *  `exec` printed (its command, output and prompts). Returns the unsubscribe. */
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
    this.onDisposed(this);
    await withSdkErrors(this.host.dispose(this.id));
  }

  /** @internal The frame this VM ran in stopped answering. */
  lost(): void {
    if (this.frameLost) {
      return;
    }
    this.frameLost = true;
    for (const cb of [...this.exitListeners]) {
      cb(LOST_EXIT);
    }
    this.exitListeners.clear();
  }

  private check(): void {
    if (this.disposed) {
      throw new Arm64JSError('vm-lost', 'this VM was disposed');
    }
  }
}
