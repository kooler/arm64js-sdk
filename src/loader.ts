// Which runtime to load, and from where. `sdk-v<X.Y>/` on the CDN holds an
// exact, never-rewritten runtime; `versions.json` says which `X.Y` is newest
// overall and per major.
//
// The default pin is this package's own `X.Y`, the runtime it was released
// with. `'v0'` follows the newest 0.x and `'latest'` the newest of all, both
// resolved through `versions.json` at load time.

import { Arm64JSError, CDN_BASE } from './contract.js';
import { VERSION } from './version.js';

/// `'latest'`, `'v<major>'`, or `'v<major>.<minor>'` (exact).
export type EngineSpec = string;

/// The engine this package pins by default: its own major.minor.
export function defaultEngine(): string {
  const [major, minor] = VERSION.split('.');
  return `v${major}.${minor}`;
}

export interface VersionsIndex {
  latest: string;
  majors: Record<string, string>;
}

/// Turn a spec into an exact `X.Y`, asking the CDN only for the moving ones.
export async function resolveEngine(
  spec: EngineSpec,
  fetchFn: (url: string) => Promise<Response> = (u) => globalThis.fetch(u, { cache: 'no-cache' }),
): Promise<string> {
  const exact = /^v(\d+)\.(\d+)$/.exec(spec);
  if (exact) return `${exact[1]}.${exact[2]}`;
  const major = /^v(\d+)$/.exec(spec);
  if (spec !== 'latest' && !major) {
    throw new Arm64JSError(
      'invalid-input',
      `engine must be 'latest', 'v<major>' or 'v<major>.<minor>', not ${JSON.stringify(spec)}`,
    );
  }
  let index: VersionsIndex;
  try {
    const res = await fetchFn(`${CDN_BASE}/versions.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    index = (await res.json()) as VersionsIndex;
  } catch (e) {
    throw new Arm64JSError('boot-failed', `could not read the engine index from the CDN: ${String(e)}`);
  }
  const picked = major ? index.majors?.[major[1]] : index.latest;
  if (!picked || !/^\d+\.\d+$/.test(picked)) {
    throw new Arm64JSError('boot-failed', `no engine on the CDN matches ${spec}`);
  }
  return picked;
}

/// The immutable runtime directory for an exact `X.Y`, with its trailing slash.
export function runtimeDir(version: string): string {
  return `${CDN_BASE}/sdk-v${version}/`;
}

export function runtimeModuleUrl(version: string): string {
  return `${runtimeDir(version)}arm64js-sdk-lib.js`;
}

export function frameUrl(version: string): string {
  return `${runtimeDir(version)}frame.html`;
}
