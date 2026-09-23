// The object a page calls: `Arm64JS.boot(...)`, `Arm64JS.snapshots.list()`.

import type { BootOptions } from '@arm64js/protocol';
import { Runtime, type Arm64JSDeps } from './runtime.js';
import { VERSION } from './version.js';

export type { Arm64JSDeps } from './runtime.js';

/**
 * Build the API over a runtime. Tests pass `deps`; the package's own
 * `Arm64JS` is one of these over the real page.
 */
export function createArm64JS(deps: Arm64JSDeps = {}) {
  const rt = new Runtime(deps);
  return {
    /** Boot a CDN image (`'alpine'`, `'alpine:2'`) or one of this browser's snapshots by id.
     *  A snapshot boots on the engine it was saved on when this page's own cannot resume it. */
    boot: async (target: string, opts?: BootOptions) => rt.boot(target, opts),
    /** `'inline'` when the VM runs in this page, `'frame'` when in the CDN's frame. */
    mode: async () => rt.mode(),
    /** This page's engine, e.g. `'0.11'`. A VM booted from a snapshot may run on
     *  another: see `vm.engine`. */
    engine: async () => rt.engine(),
    snapshots: {
      list: async () => rt.listSnapshots(),
      get: async (id: string) => rt.getSnapshot(id),
      /** Delete a snapshot. Refused while a VM runs from it, unless `force`. */
      remove: async (id: string, opts?: { force?: boolean }) => rt.removeSnapshot(id, opts),
    },
    storage: {
      status: async () => rt.storageStatus(),
    },
    /** Dispose every VM and, in frame mode, the frame. */
    shutdown: async () => rt.shutdown(),
    version: VERSION,
  };
}

export type Arm64JSApi = ReturnType<typeof createArm64JS>;
