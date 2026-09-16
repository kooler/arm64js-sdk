// The two files vendored from the main repo (kooler/arm64js, web/src/sdk-runtime/)
// must be byte-identical to the runtime this package pins. Locally, point
// ARM64JS_MAIN_REPO at a checkout; in CI the copies published beside the
// runtime on the CDN are fetched (skipped offline or before the first publish).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defaultEngine, resolveEngine, runtimeDir } from '../src/loader.ts';

const VENDORED = ['contract.ts', 'rpc-client.ts'];
const local = (f: string) => readFileSync(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), 'utf8');

describe('vendored files', () => {
  const main = process.env.ARM64JS_MAIN_REPO;
  it.skipIf(!main)('match the main repo checkout', () => {
    for (const f of VENDORED) {
      const path = `${main}/web/src/sdk-runtime/${f}`;
      expect(existsSync(path), path).toBe(true);
      expect(local(f)).toBe(readFileSync(path, 'utf8'));
    }
  });

  it.skipIf(!process.env.ARM64JS_SDK_ONLINE)(
    'match the copies published with the pinned engine',
    async (ctx: { skip(note?: string): void }) => {
      const engine = await resolveEngine(process.env.ARM64JS_ENGINE ?? defaultEngine());
      const published = await Promise.all(VENDORED.map((f) => fetch(`${runtimeDir(engine)}${f}`)));
      // Before the first publish of the engine this package pins there is nothing
      // to compare against, and a 404 is that state rather than a drift. Skip,
      // so the repo's CI is green from its first commit; once the engine is up,
      // any drift fails here before `npm publish`.
      if (published.every((res) => res.status === 404)) {
        ctx.skip();
        return;
      }
      for (let i = 0; i < VENDORED.length; i++) {
        const res = published[i];
        expect(res.ok, `${VENDORED[i]} for engine ${engine}`).toBe(true);
        expect(local(VENDORED[i])).toBe(await res.text());
      }
    },
  );
});
