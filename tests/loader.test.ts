import { describe, expect, it } from 'vitest';
import { defaultEngine, frameUrl, resolveEngine, runtimeModuleUrl } from '../src/loader.ts';
import { VERSION } from '../src/version.ts';

const index = { latest: '0.12', majors: { '0': '0.12', '1': '1.3' }, versions: ['0.11', '0.12', '1.3'] };
const fetchIndex = async () => new Response(JSON.stringify(index));

describe('engine resolution', () => {
  it("defaults to this package's own major.minor", () => {
    const [major, minor] = VERSION.split('.');
    expect(defaultEngine()).toBe(`v${major}.${minor}`);
  });
  it('resolves an exact pin without the network', async () => {
    let fetched = false;
    expect(await resolveEngine('v0.11', async () => ((fetched = true), new Response('')))).toBe('0.11');
    expect(fetched).toBe(false);
  });
  it('resolves a major and latest through versions.json', async () => {
    expect(await resolveEngine('v0', fetchIndex)).toBe('0.12');
    expect(await resolveEngine('v1', fetchIndex)).toBe('1.3');
    expect(await resolveEngine('latest', fetchIndex)).toBe('0.12');
  });
  it('refuses a malformed spec and a missing major', async () => {
    await expect(resolveEngine('0.11')).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(resolveEngine('v9', fetchIndex)).rejects.toMatchObject({ code: 'boot-failed' });
    await expect(resolveEngine('latest', async () => new Response('', { status: 500 }))).rejects.toMatchObject({
      code: 'boot-failed',
    });
  });
  it('names the immutable runtime directory on the fixed CDN', () => {
    expect(runtimeModuleUrl('0.11')).toBe('https://cdn.arm64js.com/sdk-v0.11/arm64js-sdk-lib.js');
    expect(frameUrl('0.11')).toBe('https://cdn.arm64js.com/sdk-v0.11/frame.html');
  });
});
