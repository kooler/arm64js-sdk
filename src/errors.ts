// Errors raised by this package. Every host call a page can reach goes through
// `owned`, so a caller sees one `Arm64JSError` class whichever way the VM runs.

import { Arm64JSError, type Arm64JSErrorCode } from '@arm64js/protocol';

/** Await a host call, re-raising its failure as this package's error class. */
export function owned<T>(p: Promise<T>): Promise<T> {
  return p.catch(rethrow);
}

export function noConsoleInput(): Arm64JSError {
  return new Arm64JSError('invalid-input', 'this engine has no console input; it needs engine 0.3 or newer');
}

export function noFileSharing(): Arm64JSError {
  return new Arm64JSError('share-unavailable', 'this engine cannot share files; it needs engine 0.4 or newer');
}

/**
 * Re-raise a host failure as this package's `Arm64JSError`.
 *
 * Inline, the rejection carries the CDN runtime's own copy of the class, so an
 * `instanceof` against the copy this package exports would be false — while in
 * frame mode, where `RpcClient` rebuilds it locally, it would be true.
 */
function rethrow(e: unknown): never {
  const code = (e as { code?: Arm64JSErrorCode })?.code;
  if (e instanceof Arm64JSError) throw e;
  if (code) throw new Arm64JSError(code, (e as Error).message, (e as { data?: unknown }).data);
  throw new Arm64JSError('boot-failed', String((e as Error)?.message ?? e));
}
