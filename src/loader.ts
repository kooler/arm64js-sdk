// Which runtime to load, and from where. `sdk-v<X.Y>/` on the CDN holds an
// exact, never-rewritten runtime.
//
// A page runs the runtime this package was released with, its own `X.Y`. A
// snapshot saved on another engine can bring that engine's runtime in too.

import { CDN_BASE } from '@arm64js/protocol';
import { VERSION } from './version.js';

/** The engine this package runs: its own major.minor. */
export function packageEngine(): string {
  const [major, minor] = VERSION.split('.');
  return `${major}.${minor}`;
}

/** `'0.11'` as `[0, 11]`, or `null` for anything that is not an exact engine tag. */
export function engineParts(tag: string): [number, number] | null {
  const m = /^(\d+)\.(\d+)$/.exec(tag);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Whether engine `a` is newer than engine `b`. False unless both are exact tags. */
export function isNewerEngine(a: string, b: string): boolean {
  const x = engineParts(a);
  const y = engineParts(b);
  if (!x || !y) return false;
  return x[0] !== y[0] ? x[0] > y[0] : x[1] > y[1];
}

/** The immutable runtime directory for an exact `X.Y`, with its trailing slash. */
export function runtimeDir(version: string): string {
  return `${CDN_BASE}/sdk-v${version}/`;
}

export function runtimeModuleUrl(version: string): string {
  return `${runtimeDir(version)}arm64js-sdk-lib.js`;
}

export function frameUrl(version: string): string {
  return `${runtimeDir(version)}frame.html`;
}
