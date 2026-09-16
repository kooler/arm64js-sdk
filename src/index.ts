// arm64js — a Linux VM inside your web page.
//
//   import { Arm64JS } from 'arm64js';
//   const vm = await Arm64JS.boot('alpine');
//   const { output, exitCode } = await vm.exec('apk add --no-cache curl && curl --version');
//   const snap = await vm.snapshot({ name: 'with curl' });
//   await vm.dispose();
//   // later, after a reload:
//   const again = await Arm64JS.boot(snap.id);
//
// A small loader. The engine and its browser runtime come from the arm64js
// CDN, pinned to the version this package was released with. The VM runs in
// this page when the page is cross-origin isolated, otherwise in a hidden frame
// from the CDN that isolates itself. Same API either way.

import {
  Arm64JSError,
  CONTRACT_VERSION,
  type Arm64JSErrorCode,
  type BootOptions,
  type ExecOptions,
  type ExecResult,
  type Host,
  type OutputInfo,
  type RuntimeModule,
  type SnapshotInfo,
  type SnapshotOptions,
  type StorageStatus,
  type VmExit,
} from './contract.js';
import { mountFrameHost, type FrameDeps } from './frame-host.js';
import { defaultEngine, frameUrl, resolveEngine, runtimeModuleUrl, type EngineSpec } from './loader.js';
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
  SnapshotInfo,
  SnapshotOptions,
  StorageStatus,
  VmExit,
} from './contract.js';
export type { EngineSpec } from './loader.js';

export interface Arm64JSConfig {
  /** Which engine to load from the CDN: `'latest'`, `'v0'`, or an exact `'v0.11'`.
   *  Default: the version this package was released with. */
  engine?: EngineSpec;
}

export type HostMode = 'inline' | 'frame';

/// Seams for tests; a page never passes these.
export interface Arm64JSDeps {
  isolated?: boolean;
  importRuntime?: (url: string) => Promise<RuntimeModule>;
  mountFrame?: (url: string) => Promise<{ host: Host; onLost(cb: () => void): () => void; dispose(): void }>;
  fetchFn?: (url: string) => Promise<Response>;
  frameDeps?: FrameDeps;
}

/// A running VM.
export class Vm {
  private disposed = false;

  /** @internal */
  constructor(
    readonly id: string,
    private readonly host: Host,
    private readonly onDisposed: (vm: Vm) => void,
  ) {}

  /** Run a shell script in the guest and get its output and exit code. One at a time per VM. */
  exec(script: string, opts?: ExecOptions): Promise<ExecResult> {
    this.check();
    return owned(this.host.exec(this.id, script, opts));
  }

  /** The raw bytes the guest prints on its console. `info.exec` marks what an
   *  `exec` printed (its script, output and prompts). Returns the unsubscribe. */
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

/// The runtime for this page: one, loaded on the first `boot`.
class Runtime {
  private config: Arm64JSConfig = {};
  private loading: Promise<Loaded> | null = null;
  private readonly vms = new Set<Vm>();

  constructor(private readonly deps: Arm64JSDeps = {}) {}

  configure(config: Arm64JSConfig): void {
    if (this.loading) {
      throw new Arm64JSError(
        'invalid-input',
        'configure() must run before the first boot(); the engine is already loaded',
      );
    }
    this.config = { ...this.config, ...config };
  }

  load(): Promise<Loaded> {
    return (this.loading ??= this.doLoad().catch((e) => {
      this.loading = null;
      throw e;
    }));
  }

  private async doLoad(): Promise<Loaded> {
    const engine = await resolveEngine(this.config.engine ?? defaultEngine(), this.deps.fetchFn);
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
      if (mod.contract !== CONTRACT_VERSION) {
        throw new Arm64JSError(
          'contract-mismatch',
          `this SDK speaks contract ${CONTRACT_VERSION} but engine ${engine} speaks ${String(mod.contract)}; update the arm64js package or pin an engine it matches`,
        );
      }
      return { host: mod.createHost(), mode: 'inline', engine, dispose() {} };
    }
    const mounter = this.deps.mountFrame ?? ((url: string) => mountFrameHost(url, this.deps.frameDeps));
    const frame = await mounter(frameUrl(engine));
    frame.onLost(() => {
      // The next boot builds a new frame. Tear this one down first: only its
      // main thread stopped answering, and the workers behind it keep stepping
      // a guest with no handle left once `loading` is cleared.
      this.loading = null;
      this.vms.clear();
      try {
        frame.dispose();
      } catch {
        // A frame already gone from the document has nothing to remove.
      }
    });
    return { host: frame.host, mode: 'frame', engine, dispose: () => frame.dispose() };
  }

  async boot(target: string | SnapshotInfo, opts?: BootOptions): Promise<Vm> {
    const id = typeof target === 'string' ? target : target.id;
    const { host } = await this.load();
    const { vmId } = await owned(host.boot(id, opts));
    const vm = new Vm(vmId, host, (v) => this.vms.delete(v));
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
    if (!this.loading) return;
    const loaded = await this.loading.catch(() => null);
    for (const vm of [...this.vms]) await vm.dispose().catch(() => {});
    this.vms.clear();
    loaded?.dispose();
    this.loading = null;
  }
}

/// Build the API over a runtime. Exported for tests; the package's own
/// `Arm64JS` is one of these over the real page.
export function createArm64JS(deps: Arm64JSDeps = {}) {
  const rt = new Runtime(deps);
  return {
    /** Choose the engine. Must run before the first `boot`. */
    configure: (config: Arm64JSConfig) => rt.configure(config),
    /** Boot a CDN image (`'alpine'`, `'alpine:2'`) or one of this browser's snapshots (its id or info). */
    boot: (target: string | SnapshotInfo, opts?: BootOptions) => rt.boot(target, opts),
    /** `'inline'` when the VM runs in this page, `'frame'` when in the CDN's frame. */
    mode: () => rt.mode(),
    /** The exact engine version in use, e.g. `'0.11'`. */
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
