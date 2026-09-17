// arm64js — a Linux VM inside your web page.
//
//   import { Arm64JS } from 'arm64js';
//   const vm = await Arm64JS.boot('alpine');
//   const { output, exitCode } = await vm.exec('apk add --no-cache curl && curl --version');
//   await vm.writeFile('/root/data.csv', file);            // a Blob or File
//   const out = await vm.readFile('/root/result.txt');     // a Blob
//   await vm.mount({ 'big.bin': file }, '/data');          // read in place
//   const snap = await vm.snapshot({ name: 'with curl' });
//   await vm.dispose();
//   // later, after a reload:
//   const again = await Arm64JS.boot(snap.id);
//
// A small loader. The engine and its browser runtime come from the arm64js
// CDN, pinned to the version this package was released with; a snapshot saved
// on another engine boots on that one when it has to. The VM runs in this page
// when the page is cross-origin isolated, otherwise in a hidden frame from the
// CDN that isolates itself. Same API either way.

import {
  Arm64JSError,
  PROTOCOL_VERSION,
  type Arm64JSErrorCode,
  type BootOptions,
  type ExecOptions,
  type ExecResult,
  type Host,
  type OutputInfo,
  type ReadFileOptions,
  type RuntimeModule,
  type SnapshotInfo,
  type SnapshotOptions,
  type StorageStatus,
  type VmExit,
  type WriteFileOptions,
} from '@arm64js/protocol';
import { mountFrameHost, type FrameDeps } from './frame-host.js';
import { engineParts, frameUrl, isNewerEngine, packageEngine, runtimeModuleUrl } from './loader.js';
import { VERSION } from './version.js';

export { Arm64JSError, VERSION as version };

/// Re-raise a host failure as this package's `Arm64JSError`.
///
/// Inline, the rejection carries the CDN runtime's own copy of the class, so an
/// `instanceof` against the copy this package exports would be false — while in
/// frame mode, where `RpcClient` rebuilds it locally, it would be true. Every
/// host call a page can reach goes through here so there is one class.
function rethrow(e: unknown): never {
  const code = (e as { code?: Arm64JSErrorCode })?.code;
  if (e instanceof Arm64JSError) throw e;
  if (code) throw new Arm64JSError(code, (e as Error).message, (e as { data?: unknown }).data);
  throw new Arm64JSError('boot-failed', String((e as Error)?.message ?? e));
}

function noConsoleInput(): Arm64JSError {
  return new Arm64JSError('invalid-input', 'this engine has no console input; it needs engine 0.3 or newer');
}

function noFileSharing(): Arm64JSError {
  return new Arm64JSError('share-unavailable', 'this engine cannot share files; it needs engine 0.4 or newer');
}

/// What `mount` takes: a record of file name → Blob, or a list of Files (an
/// `<input type=file>`'s `files`, a drop's).
export type MountSource = Record<string, Blob> | Iterable<File> | ArrayLike<File>;

/// What `writeFile` takes.
export type FileData = Blob | BufferSource | string;

/// A live `mount`.
export interface Mount {
  /** Where the files are in the guest. */
  readonly path: string;
  /** Remove the mount. Idempotent. */
  unmount(): Promise<void>;
}

/// `path` with repeated and trailing slashes dropped, so one folder has one key.
/// The runtime checks the rest.
function guestPath(path: string): string {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new Arm64JSError('invalid-input', `the path must be an absolute guest path, not ${JSON.stringify(path)}`);
  }
  return `/${path
    .split('/')
    .filter((p) => p !== '' && p !== '.')
    .join('/')}`;
}

/// The record of Blobs the runtime takes.
function mountFiles(source: MountSource): Record<string, Blob> {
  const files = recordOf(source);
  if (Object.keys(files).length === 0) throw new Arm64JSError('invalid-input', 'mount: no files to share');
  return files;
}

function recordOf(source: MountSource): Record<string, Blob> {
  if (!source || typeof source !== 'object') {
    throw new Arm64JSError('invalid-input', 'mount takes a record of Blobs or a list of Files');
  }
  if (source instanceof Blob)
    throw new Arm64JSError('invalid-input', 'mount: name the Blob, e.g. { "data.bin": blob }');
  const list = source as Partial<Iterable<File>> & Partial<ArrayLike<File>>;
  if (typeof list[Symbol.iterator] === 'function' || typeof list.length === 'number') {
    return filesRecord(source as Iterable<File>);
  }
  // Checked here: something else (a folder handle) may not even reach the VM's
  // frame, and then no answer would ever come back.
  const proto = Object.getPrototypeOf(source);
  if (proto !== Object.prototype && proto !== null) {
    throw new Arm64JSError('invalid-input', 'mount takes a record of Blobs or a list of Files');
  }
  for (const [name, blob] of Object.entries(source)) {
    if (!(blob instanceof Blob)) throw new Arm64JSError('invalid-input', `mount: ${name} is not a Blob`);
  }
  return source as Record<string, Blob>;
}

/// A list of Files as the record the runtime takes, named by `File.name`.
function filesRecord(source: Iterable<File> | ArrayLike<File>): Record<string, Blob> {
  const record: Record<string, Blob> = Object.create(null);
  for (const file of Array.from(source as ArrayLike<File>)) {
    if (!(file instanceof Blob) || typeof (file as { name?: unknown }).name !== 'string') {
      throw new Arm64JSError('invalid-input', 'mount: every item in a list must be a File');
    }
    if (file.name in record) throw new Arm64JSError('invalid-input', `mount: two files are named ${file.name}`);
    record[file.name] = file;
  }
  return record;
}

/// Await a host call, re-raising its failure as this package's error class.
function owned<T>(p: Promise<T>): Promise<T> {
  return p.catch(rethrow);
}
export type {
  Arm64JSErrorCode,
  BootOptions,
  BootProgress,
  ExecOptions,
  ExecResult,
  OutputInfo,
  ReadFileOptions,
  SnapshotInfo,
  SnapshotOptions,
  StorageStatus,
  VmExit,
  WriteFileOptions,
} from '@arm64js/protocol';
export type HostMode = 'inline' | 'frame';

/// Seams for tests; a page never passes these.
export interface Arm64JSDeps {
  isolated?: boolean;
  /** The page's own engine (default: this package's). */
  engine?: string;
  importRuntime?: (url: string) => Promise<RuntimeModule>;
  mountFrame?: (url: string) => Promise<{ host: Host; onLost(cb: () => void): () => void; dispose(): void }>;
  frameDeps?: FrameDeps;
}

/// A local snapshot id, as the runtime spells it.
function isSnapshotId(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
}

/// A running VM.
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
    const { write } = this.host;
    if (!write) return Promise.reject(noConsoleInput());
    return owned(write.call(this.host, this.id, data));
  }

  /** Set the guest's terminal size, so full-screen programs lay out for it. */
  resize(cols: number, rows: number): Promise<void> {
    this.check();
    const { resize } = this.host;
    if (!resize) return Promise.reject(noConsoleInput());
    return owned(resize.call(this.host, this.id, cols, rows));
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
    const { mount } = this.host;
    if (!mount) return Promise.reject(noFileSharing());
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
    return owned(mount.call(this.host, this.id, files, at)).then(
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
    const { unmount } = this.host;
    if (!unmount) return Promise.reject(noFileSharing());
    let at: string;
    try {
      at = guestPath(path);
    } catch (e) {
      return Promise.reject(e);
    }
    const token = this.mounts.get(at);
    return owned(unmount.call(this.host, this.id, at)).then(() => {
      // A mount started meanwhile keeps its token.
      if (this.mounts.get(at) === token) this.mounts.delete(at);
    });
  }

  /** Copy `data` into the guest as the file `path`, replacing it if it exists and
   *  creating its folder if missing. The file lives in guest memory: for a large
   *  one, `mount` it instead. */
  writeFile(path: string, data: FileData, opts?: WriteFileOptions): Promise<void> {
    this.check();
    const { writeFile } = this.host;
    if (!writeFile) return Promise.reject(noFileSharing());
    let blob: Blob;
    if (data instanceof Blob) blob = data;
    else if (typeof data === 'string' || data instanceof ArrayBuffer || ArrayBuffer.isView(data))
      blob = new Blob([data]);
    else return Promise.reject(new Arm64JSError('invalid-input', 'writeFile takes a Blob, bytes or a string'));
    return owned(writeFile.call(this.host, this.id, path, blob, opts));
  }

  /** Copy the guest's file `path` out, as a `Blob`. The copy is held in page
   *  memory. */
  readFile(path: string, opts?: ReadFileOptions): Promise<Blob> {
    this.check();
    const { readFile } = this.host;
    if (!readFile) return Promise.reject(noFileSharing());
    return owned(readFile.call(this.host, this.id, path, opts));
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

interface Loaded {
  host: Host;
  mode: HostMode;
  engine: string;
  dispose(): void;
}

/// The runtimes for this page: its own engine, loaded on the first call, and
/// any other a snapshot needs.
class Runtime {
  private readonly own: string;
  private readonly engines = new Map<string, Promise<Loaded>>();
  private readonly vms = new Set<Vm>();

  constructor(private readonly deps: Arm64JSDeps = {}) {
    this.own = deps.engine ?? packageEngine();
  }

  load(engine = this.own): Promise<Loaded> {
    const loading = this.engines.get(engine);
    if (loading) return loading;
    const next: Promise<Loaded> = this.doLoad(engine, () => this.lost(engine, next)).catch((e) => {
      if (this.engines.get(engine) === next) this.engines.delete(engine);
      throw e;
    });
    this.engines.set(engine, next);
    return next;
  }

  private async doLoad(engine: string, onLost: () => void): Promise<Loaded> {
    const isolated = this.deps.isolated ?? Boolean(globalThis.crossOriginIsolated);
    if (isolated) {
      const importer =
        this.deps.importRuntime ?? ((url: string) => import(/* @vite-ignore */ /* webpackIgnore: true */ url));
      let mod: RuntimeModule;
      try {
        mod = await importer(runtimeModuleUrl(engine));
      } catch (e) {
        throw new Arm64JSError('boot-failed', `could not load engine ${engine} from the CDN: ${String(e)}`);
      }
      if (mod.protocol !== PROTOCOL_VERSION) {
        throw new Arm64JSError(
          'protocol-mismatch',
          `this SDK speaks protocol ${PROTOCOL_VERSION} but engine ${engine} speaks ${String(mod.protocol)}; update the arm64js package`,
        );
      }
      return { host: mod.createHost(), mode: 'inline', engine, dispose() {} };
    }
    const mounter = this.deps.mountFrame ?? ((url: string) => mountFrameHost(url, this.deps.frameDeps));
    const frame = await mounter(frameUrl(engine));
    frame.onLost(() => {
      // The next call builds a new frame. Tear this one down first: only its
      // main thread stopped answering, and the workers behind it keep stepping
      // a guest with no handle left.
      onLost();
      try {
        frame.dispose();
      } catch {
        // A frame already gone from the document has nothing to remove.
      }
    });
    return { host: frame.host, mode: 'frame', engine, dispose: () => frame.dispose() };
  }

  /// Forget a frame that stopped answering, and the VMs that ran in it.
  private lost(engine: string, loading: Promise<Loaded>): void {
    if (this.engines.get(engine) !== loading) return;
    this.engines.delete(engine);
    for (const vm of this.vms) if (vm.engine === engine) this.vms.delete(vm);
  }

  async boot(id: string, opts?: BootOptions): Promise<Vm> {
    if (typeof id !== 'string') {
      throw new Arm64JSError('invalid-input', 'boot takes an image name or a snapshot id');
    }
    const own = await this.load();
    if (!isSnapshotId(id)) return this.bootOn(own, id, opts);
    // The engine the snapshot was saved on. An unreadable record is left to the
    // boot below to report.
    const saved = (await own.host.getSnapshot(id).catch(() => null))?.engine;
    const other = saved && saved !== own.engine && engineParts(saved) ? saved : null;
    // An older engine may not know what a newer one saved, even in the same format.
    if (other && isNewerEngine(other, own.engine)) return this.bootOn(await this.load(other), id, opts);
    try {
      return await this.bootOn(own, id, opts);
    } catch (e) {
      // A changed snapshot format: only the engine it was saved on can resume it.
      if (!other || (e as Arm64JSError).code !== 'engine-mismatch') throw e;
      return this.bootOn(await this.load(other), id, opts);
    }
  }

  private async bootOn(loaded: Loaded, id: string, opts?: BootOptions): Promise<Vm> {
    const { vmId } = await owned(loaded.host.boot(id, opts));
    const vm = new Vm(vmId, loaded.host, loaded.engine, (v) => this.vms.delete(v));
    this.vms.add(vm);
    return vm;
  }

  async mode(): Promise<HostMode> {
    return (await this.load()).mode;
  }

  async engine(): Promise<string> {
    return (await this.load()).engine;
  }

  async listSnapshots(): Promise<SnapshotInfo[]> {
    return owned((await this.load()).host.listSnapshots());
  }

  async getSnapshot(id: string): Promise<SnapshotInfo | null> {
    return owned((await this.load()).host.getSnapshot(id));
  }

  async removeSnapshot(id: string, opts?: { force?: boolean }): Promise<void> {
    return owned((await this.load()).host.removeSnapshot(id, opts));
  }

  async storageStatus(): Promise<StorageStatus> {
    return owned((await this.load()).host.storageStatus());
  }

  async shutdown(): Promise<void> {
    const loads = [...this.engines];
    if (loads.length === 0) return;
    const loaded = await Promise.all(loads.map(([, p]) => p.catch(() => null)));
    for (const vm of [...this.vms]) await vm.dispose().catch(() => {});
    this.vms.clear();
    for (const l of loaded) l?.dispose();
    for (const [engine, p] of loads) if (this.engines.get(engine) === p) this.engines.delete(engine);
  }
}

/// Build the API over a runtime. Exported for tests; the package's own
/// `Arm64JS` is one of these over the real page.
export function createArm64JS(deps: Arm64JSDeps = {}) {
  const rt = new Runtime(deps);
  return {
    /** Boot a CDN image (`'alpine'`, `'alpine:2'`) or one of this browser's snapshots by id.
     *  A snapshot boots on the engine it was saved on when this page's own cannot resume it. */
    boot: (target: string, opts?: BootOptions) => rt.boot(target, opts),
    /** `'inline'` when the VM runs in this page, `'frame'` when in the CDN's frame. */
    mode: () => rt.mode(),
    /** This page's engine, e.g. `'0.11'`. A VM booted from a snapshot may run on
     *  another: see `vm.engine`. */
    engine: () => rt.engine(),
    snapshots: {
      list: () => rt.listSnapshots(),
      get: (id: string) => rt.getSnapshot(id),
      /** Delete a snapshot. Refused while a VM runs from it, unless `force`. */
      remove: (id: string, opts?: { force?: boolean }) => rt.removeSnapshot(id, opts),
    },
    storage: {
      status: () => rt.storageStatus(),
    },
    /** Dispose every VM and, in frame mode, the frame. */
    shutdown: () => rt.shutdown(),
    version: VERSION,
  };
}

export type Arm64JSApi = ReturnType<typeof createArm64JS>;

export const Arm64JS: Arm64JSApi = createArm64JS();
export default Arm64JS;
