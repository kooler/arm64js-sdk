// Loads the runtime for one engine, in one of two ways. A cross-origin isolated
// page imports it from the CDN and runs the VM itself. Any other page gets a
// hidden CDN frame that runs it.

import { Arm64JSError, PROTOCOL_VERSION, type Host, type RuntimeModule } from '@arm64js/protocol';
import { mountFrameHost, type FrameDeps } from './frame-host.js';
import { frameUrl, runtimeModuleUrl } from './loader.js';

/** `'inline'` when the VM runs in this page, `'frame'` when in the CDN's frame. */
export type HostMode = 'inline' | 'frame';

/** A runtime ready to boot VMs. */
export interface LoadedHost {
  host: Host;
  mode: HostMode;
  engine: string;
  dispose(): void;
}

/** Seams for tests; a page never passes these. */
export interface HostDeps {
  isolated?: boolean;
  importRuntime?: (url: string) => Promise<RuntimeModule>;
  mountFrame?: (url: string) => Promise<{ host: Host; onLost(cb: () => void): () => void; dispose(): void }>;
  frameDeps?: FrameDeps;
}

/**
 * Load `engine` inline when this page is cross-origin isolated, in a frame
 * otherwise. `onLost` fires if a frame stops answering.
 */
export async function loadHost(engine: string, deps: HostDeps, onLost: () => void): Promise<LoadedHost> {
  const isolated = deps.isolated ?? Boolean(globalThis.crossOriginIsolated);
  return isolated ? loadInlineHost(engine, deps) : loadFrameHost(engine, deps, onLost);
}

async function loadInlineHost(engine: string, deps: HostDeps): Promise<LoadedHost> {
  const importer =
    deps.importRuntime ??
    (async (url: string) => import(/* @vite-ignore */ /* webpackIgnore: true */ url) as Promise<RuntimeModule>);
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

async function loadFrameHost(engine: string, deps: HostDeps, onLost: () => void): Promise<LoadedHost> {
  const mounter = deps.mountFrame ?? (async (url: string) => mountFrameHost(url, deps.frameDeps));
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
