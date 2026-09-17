import { describe, expect, it } from 'vitest';
import { engineParts, frameUrl, isNewerEngine, packageEngine, runtimeModuleUrl } from '../src/loader.ts';
import { VERSION } from '../src/version.ts';

describe('engines', () => {
  it("is this package's own major.minor", () => {
    const [major, minor] = VERSION.split('.');
    expect(packageEngine()).toBe(`${major}.${minor}`);
  });
  it('reads exact engine tags only', () => {
    expect(engineParts('0.11')).toEqual([0, 11]);
    expect(engineParts('12.0')).toEqual([12, 0]);
    for (const tag of ['dev', 'v0.11', '0', '0.11.1', '', '0.x']) expect(engineParts(tag)).toBeNull();
  });
  it('orders engines by number, not text', () => {
    expect(isNewerEngine('0.11', '0.9')).toBe(true);
    expect(isNewerEngine('1.0', '0.11')).toBe(true);
    expect(isNewerEngine('0.9', '0.11')).toBe(false);
    expect(isNewerEngine('0.4', '0.4')).toBe(false);
    expect(isNewerEngine('dev', '0.4')).toBe(false);
    expect(isNewerEngine('0.4', 'dev')).toBe(false);
  });
  it('names the immutable runtime directory on the fixed CDN', () => {
    expect(runtimeModuleUrl('0.11')).toBe('https://cdn.arm64js.com/sdk-v0.11/arm64js-sdk-lib.js');
    expect(frameUrl('0.11')).toBe('https://cdn.arm64js.com/sdk-v0.11/frame.html');
  });
});
