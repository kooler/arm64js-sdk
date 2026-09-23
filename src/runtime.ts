import { Arm64JSError, type BootOptions, type SnapshotInfo, type StorageStatus } from '@arm64js/protocol';
import { withSdkErrors } from './errors.js';
import { loadHost, type HostDeps, type HostMode, type LoadedHost } from './hosts.js';
import { engineParts, isNewerEngine, packageEngine } from './loader.js';
import { Vm } from './vm.js';

/** Seams for tests; a page never passes these. */
export interface Arm64JSDeps extends HostDeps {
  /** The page's own engine (default: this package's). */
  engine?: string;
}

/**
 * The runtimes for this page: its own engine, loaded on the first call, and
 * any other a snapshot needs.
 */
export class Runtime {
  private readonly defaultEngine: string;
  private readonly engines = new Map<string, Promise<LoadedHost>>();
  private readonly vms = new Set<Vm>();

  constructor(private readonly deps: Arm64JSDeps = {}) {
    this.defaultEngine = deps.engine ?? packageEngine();
  }

  async load(engine = this.defaultEngine): Promise<LoadedHost> {
    const loading = this.engines.get(engine);
    if (loading) {
      return loading;
    }
    const next: Promise<LoadedHost> = loadHost(engine, this.deps, () => this.lost(engine, next)).catch((e) => {
      if (this.engines.get(engine) === next) {
        this.engines.delete(engine);
      }
      throw e;
    });
    this.engines.set(engine, next);
    return next;
  }

  /** Forget a frame that stopped answering, and end the VMs that ran in it. */
  private lost(engine: string, loading: Promise<LoadedHost>): void {
    if (this.engines.get(engine) !== loading) {
      return;
    }
    this.engines.delete(engine);
    for (const vm of this.vms) {
      if (vm.engine === engine) {
        this.vms.delete(vm);
        vm.lost();
      }
    }
  }

  async boot(id: string, opts?: BootOptions): Promise<Vm> {
    if (typeof id !== 'string') {
      throw new Arm64JSError('invalid-input', 'boot takes an image name or a snapshot id');
    }
    const defaultHost = await this.load();
    if (!isSnapshotId(id)) {
      return this.bootOn(defaultHost, id, opts);
    }
    // The engine the snapshot was saved on. An unreadable record is left to the
    // boot below to report.
    const saved = (await defaultHost.host.getSnapshot(id).catch(() => null))?.engine;
    const other = saved && saved !== defaultHost.engine && engineParts(saved) ? saved : null;
    // Saved on a newer engine: use it. Saved on an older one: try ours first.
    if (other && isNewerEngine(other, defaultHost.engine)) {
      return this.bootOn(await this.load(other), id, opts);
    }
    try {
      return await this.bootOn(defaultHost, id, opts);
    } catch (e) {
      // A changed snapshot format: only the engine it was saved on can resume it.
      if (!other || (e as Arm64JSError).code !== 'engine-mismatch') {
        throw e;
      }
      return this.bootOn(await this.load(other), id, opts);
    }
  }

  private async bootOn(loaded: LoadedHost, id: string, opts?: BootOptions): Promise<Vm> {
    const { vmId } = await withSdkErrors(loaded.host.boot(id, opts));
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
    return withSdkErrors((await this.load()).host.listSnapshots());
  }

  async getSnapshot(id: string): Promise<SnapshotInfo | null> {
    return withSdkErrors((await this.load()).host.getSnapshot(id));
  }

  async removeSnapshot(id: string, opts?: { force?: boolean }): Promise<void> {
    return withSdkErrors((await this.load()).host.removeSnapshot(id, opts));
  }

  async storageStatus(): Promise<StorageStatus> {
    return withSdkErrors((await this.load()).host.storageStatus());
  }

  async shutdown(): Promise<void> {
    const loads = [...this.engines];
    if (loads.length === 0) {
      return;
    }
    // Wait for loads in flight, so no frame appears after shutdown.
    const loaded = await Promise.all(loads.map(async ([, p]) => p.catch(() => null)));
    for (const vm of [...this.vms]) {
      await vm.dispose().catch(() => {});
    }
    this.vms.clear();
    for (const l of loaded) {
      l?.dispose();
    }
    for (const [engine, p] of loads) {
      if (this.engines.get(engine) === p) {
        this.engines.delete(engine);
      }
    }
  }
}

/** A local snapshot id, as the runtime spells it. */
function isSnapshotId(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
}
