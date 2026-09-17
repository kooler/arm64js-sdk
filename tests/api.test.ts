// The public API over a fake host: inline vs frame selection, the protocol
// check, VM handles, the snapshot and storage calls, and booting a snapshot on
// the engine it was saved on.

import { describe, expect, it, vi } from 'vitest';
import { Arm64JSError, PROTOCOL_VERSION, type Host, type SnapshotInfo } from '@arm64js/protocol';
import { createArm64JS } from '../src/index.ts';
import { packageEngine } from '../src/loader.ts';

function fakeHost(): Host & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    async boot(target, opts) {
      calls.push(['boot', target, opts]);
      return { vmId: 'vm1' };
    },
    async exec(vmId, script) {
      calls.push(['exec', vmId, script]);
      return { output: 'ok', exitCode: 0, truncated: false };
    },
    onOutput: () => () => {},
    onExit: () => () => {},
    async dispose(vmId) {
      calls.push(['dispose', vmId]);
    },
    async snapshot(vmId, opts) {
      calls.push(['snapshot', vmId, opts]);
      return {
        id: 'a'.repeat(64),
        name: opts?.name ?? null,
        created: 1,
        base: 'alpine',
        engine: '0.11',
        vcpus: 1,
        sizeBytes: 1,
        meta: null,
      };
    },
    async listSnapshots() {
      return [];
    },
    async getSnapshot() {
      return null;
    },
    async removeSnapshot(id, opts) {
      calls.push(['removeSnapshot', id, opts]);
    },
    async storageStatus() {
      return { available: true, snapshots: 0, poolBytes: 0 };
    },
  };
}

function savedOn(id: string, engine: string): SnapshotInfo {
  return { id, name: null, created: 1, base: 'alpine', engine, vcpus: 1, sizeBytes: 1, meta: null };
}

const engineOf = (url: string) => /sdk-v([\d.]+)\//.exec(url)![1];

describe('Arm64JS', () => {
  it('runs inline on an isolated page, importing the pinned runtime from the CDN', async () => {
    const host = fakeHost();
    const urls: string[] = [];
    const sdk = createArm64JS({
      isolated: true,
      engine: '0.11',
      importRuntime: async (url) => (
        urls.push(url),
        { protocol: PROTOCOL_VERSION, engine: '0.11', createHost: () => host }
      ),
    });
    const vm = await sdk.boot('alpine', { vcpus: 1 });
    expect(urls).toEqual(['https://cdn.arm64js.com/sdk-v0.11/arm64js-sdk-lib.js']);
    expect(await sdk.mode()).toBe('inline');
    expect(await sdk.engine()).toBe('0.11');
    expect(vm.id).toBe('vm1');
    expect(vm.engine).toBe('0.11');
    expect(await vm.exec('true')).toEqual({ output: 'ok', exitCode: 0, truncated: false });
    const snap = await vm.snapshot({ name: 's' });
    expect(snap.name).toBe('s');
    await vm.dispose();
    await vm.dispose();
    expect(() => vm.exec('true')).toThrow(/disposed/);
    expect(host.calls.filter((c) => c[0] === 'dispose')).toHaveLength(1);
    await sdk.boot(snap.id);
    expect(host.calls.at(-1)).toEqual(['boot', snap.id, undefined]);
    // Only an id, not the snapshot's info.
    await expect(sdk.boot(snap as never)).rejects.toMatchObject({ code: 'invalid-input' });
  });

  it('passes console input and size through, and says so on an engine without them', async () => {
    const host = fakeHost();
    const inputs: unknown[][] = [];
    const withInput = {
      ...host,
      write: async (vmId: string, data: string) => void inputs.push(['write', vmId, data]),
      resize: async (vmId: string, cols: number, rows: number) => void inputs.push(['resize', vmId, cols, rows]),
    };
    const sdk = createArm64JS({
      isolated: true,
      importRuntime: async () => ({ protocol: PROTOCOL_VERSION, engine: '0.11', createHost: () => withInput }),
    });
    const vm = await sdk.boot('alpine');
    await vm.write('ls\r');
    await vm.resize(100, 30);
    expect(inputs).toEqual([
      ['write', 'vm1', 'ls\r'],
      ['resize', 'vm1', 100, 30],
    ]);

    const older = createArm64JS({
      isolated: true,
      importRuntime: async () => ({ protocol: PROTOCOL_VERSION, engine: '0.2', createHost: () => fakeHost() }),
    });
    const vm2 = await older.boot('alpine');
    await expect(vm2.write('x')).rejects.toMatchObject({ code: 'invalid-input', message: /0\.3/ });
    await expect(vm2.resize(80, 24)).rejects.toMatchObject({ code: 'invalid-input' });
  });

  it('refuses a runtime speaking another protocol', async () => {
    const sdk = createArm64JS({
      isolated: true,
      importRuntime: async () => ({ protocol: PROTOCOL_VERSION + 1, engine: '0.11', createHost: fakeHost }),
    });
    await expect(sdk.boot('alpine')).rejects.toMatchObject({ code: 'protocol-mismatch' });
  });

  it('mounts the frame on a page that is not isolated, and forgets it when lost', async () => {
    const host = fakeHost();
    let lost: (() => void) | null = null;
    const dispose = vi.fn();
    const mounts: string[] = [];
    const sdk = createArm64JS({
      isolated: false,
      engine: '0.11',
      mountFrame: async (url) => (mounts.push(url), { host, onLost: (cb) => ((lost = cb), () => {}), dispose }),
    });
    await sdk.boot('alpine');
    expect(mounts).toEqual(['https://cdn.arm64js.com/sdk-v0.11/frame.html']);
    expect(await sdk.mode()).toBe('frame');
    // A lost frame is torn down, not just forgotten: its workers keep running
    // when only the frame's main thread stopped answering.
    lost!();
    expect(dispose).toHaveBeenCalledTimes(1);
    await sdk.boot('alpine');
    expect(mounts).toHaveLength(2);
    await sdk.shutdown();
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it('exposes snapshots and storage', async () => {
    const host = fakeHost();
    const sdk = createArm64JS({
      isolated: true,
      importRuntime: async () => ({ protocol: PROTOCOL_VERSION, engine: '0.11', createHost: () => host }),
    });
    expect(await sdk.snapshots.list()).toEqual([]);
    expect(await sdk.snapshots.get('x')).toBeNull();
    await sdk.snapshots.remove('a'.repeat(64), { force: true });
    expect(host.calls.at(-1)).toEqual(['removeSnapshot', 'a'.repeat(64), { force: true }]);
    expect((await sdk.storage.status()).available).toBe(true);
  });

  it("boots a snapshot on the engine it was saved on when this page's cannot", async () => {
    const id = (c: string) => c.repeat(64);
    const saved: Record<string, string> = { [id('a')]: '0.4', [id('b')]: '0.4', [id('c')]: '0.6', [id('d')]: 'dev' };
    // What this page's engine refuses: a changed snapshot format.
    const refused = new Set([id('a'), id('d')]);
    const hosts = new Map<string, ReturnType<typeof fakeHost>>();
    const urls: string[] = [];
    const sdk = createArm64JS({
      isolated: true,
      engine: '0.5',
      importRuntime: async (url) => {
        urls.push(url);
        const engine = engineOf(url);
        const host = fakeHost();
        const boot = host.boot;
        host.boot = async (target, opts) => {
          if (engine === '0.5' && refused.has(target)) throw new Arm64JSError('engine-mismatch', 'another format');
          await boot(target, opts);
          return { vmId: `${engine}:${target[0]}` };
        };
        host.getSnapshot = async (sid) => (saved[sid] ? savedOn(sid, saved[sid]) : null);
        hosts.set(engine, host);
        return { protocol: PROTOCOL_VERSION, engine, createHost: () => host };
      },
    });
    const booted = (engine: string, target: string) =>
      hosts.get(engine)!.calls.some((c) => c[0] === 'boot' && c[1] === target);

    // The same format stays on this page's engine.
    expect((await sdk.boot(id('b'))).engine).toBe('0.5');
    // Another format goes to the engine it was saved on.
    const a = await sdk.boot(id('a'));
    expect([a.engine, a.id]).toEqual(['0.4', '0.4:a']);
    // A newer engine's snapshot goes straight to it.
    expect((await sdk.boot(id('c'))).engine).toBe('0.6');
    expect(booted('0.5', id('c'))).toBe(false);
    // With no engine to go to, the refusal stands.
    await expect(sdk.boot(id('d'))).rejects.toMatchObject({ code: 'engine-mismatch' });
    // A snapshot this page does not know is left to its own engine to report.
    await sdk.boot(id('e'));
    expect(booted('0.5', id('e'))).toBe(true);
    // Each engine loads once, and this page's stays the one reported.
    await sdk.boot(id('a'));
    expect(urls.map(engineOf)).toEqual(['0.5', '0.4', '0.6']);
    expect(await sdk.engine()).toBe('0.5');

    // A VM's calls go to its own engine; snapshot calls to this page's.
    await a.exec('true');
    expect(hosts.get('0.4')!.calls.at(-1)).toEqual(['exec', '0.4:a', 'true']);
    await sdk.snapshots.remove(id('a'));
    expect(hosts.get('0.5')!.calls.at(-1)).toEqual(['removeSnapshot', id('a'), undefined]);

    await sdk.shutdown();
    const disposed = (engine: string) => hosts.get(engine)!.calls.filter((c) => c[0] === 'dispose').length;
    expect([disposed('0.4'), disposed('0.5'), disposed('0.6')]).toEqual([2, 2, 1]);
  });

  it('refuses an engine for a snapshot that speaks another protocol', async () => {
    const id = 'a'.repeat(64);
    const sdk = createArm64JS({
      isolated: true,
      engine: '0.5',
      importRuntime: async (url) => {
        const host = fakeHost();
        host.getSnapshot = async () => savedOn(id, '0.9');
        const protocol = engineOf(url) === '0.9' ? PROTOCOL_VERSION + 1 : PROTOCOL_VERSION;
        return { protocol, engine: engineOf(url), createHost: () => host };
      },
    });
    await expect(sdk.boot(id)).rejects.toMatchObject({ code: 'protocol-mismatch', message: /engine 0\.9/ });
    // This page's engine is still up.
    expect((await sdk.boot('alpine')).engine).toBe('0.5');
  });

  it("keeps each engine's frame apart", async () => {
    const id = 'a'.repeat(64);
    const frames = new Map<string, { lost: () => void; dispose: ReturnType<typeof vi.fn> }>();
    const mounts: string[] = [];
    const sdk = createArm64JS({
      isolated: false,
      engine: '0.5',
      mountFrame: async (url) => {
        mounts.push(url);
        const engine = engineOf(url);
        const host = fakeHost();
        host.getSnapshot = async () => savedOn(id, '0.4');
        if (engine === '0.5') {
          host.boot = async () => {
            throw new Arm64JSError('engine-mismatch', 'another format');
          };
        }
        const frame = { lost: () => {}, dispose: vi.fn() };
        frames.set(engine, frame);
        return { host, onLost: (cb) => ((frame.lost = cb), () => {}), dispose: frame.dispose };
      },
    });
    expect((await sdk.boot(id)).engine).toBe('0.4');
    const first = frames.get('0.4')!;
    first.lost();
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(frames.get('0.5')!.dispose).not.toHaveBeenCalled();
    // The next boot builds that engine's frame again, and only that one.
    await sdk.boot(id);
    expect(mounts.map(engineOf)).toEqual(['0.5', '0.4', '0.4']);
    await sdk.shutdown();
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(frames.get('0.4')!.dispose).toHaveBeenCalledTimes(1);
    expect(frames.get('0.5')!.dispose).toHaveBeenCalledTimes(1);
  });

  it("runs this package's own engine by default", async () => {
    const urls: string[] = [];
    const sdk = createArm64JS({
      isolated: true,
      importRuntime: async (url) => (
        urls.push(url),
        { protocol: PROTOCOL_VERSION, engine: engineOf(url), createHost: fakeHost }
      ),
    });
    expect(await sdk.engine()).toBe(packageEngine());
    expect(urls).toEqual([`https://cdn.arm64js.com/sdk-v${packageEngine()}/arm64js-sdk-lib.js`]);
  });

  it('shares files: Files by name, Blob records as they are, and writes as Blobs', async () => {
    const host = fakeHost();
    const calls: unknown[][] = [];
    let refuse = false;
    const sharing = {
      ...host,
      mount: async (vmId: string, files: unknown, path: string) => {
        calls.push(['mount', vmId, files, path]);
        if (refuse) throw Object.assign(new Error('something is already mounted'), { code: 'invalid-input' });
      },
      unmount: async (vmId: string, path: string) => void calls.push(['unmount', vmId, path]),
      writeFile: async (vmId: string, path: string, data: Blob, opts?: unknown) =>
        void calls.push(['writeFile', vmId, path, await data.text(), opts]),
      readFile: async (vmId: string, path: string, opts?: unknown) => (
        calls.push(['readFile', vmId, path, opts]),
        new Blob([`read ${path}`])
      ),
    };
    const sdk = createArm64JS({
      isolated: true,
      importRuntime: async () => ({ protocol: PROTOCOL_VERSION, engine: '0.4', createHost: () => sharing }),
    });
    const vm = await sdk.boot('alpine');

    const note = { 'note.txt': new Blob(['n']) };
    const m = await vm.mount(note, '/work/');
    expect(m.path).toBe('/work');
    expect(calls.at(-1)).toEqual(['mount', 'vm1', note, '/work']);
    const folder = { kind: 'directory', getFileHandle() {} };
    await expect(vm.mount(folder as never, '/dir')).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(vm.mount(new Map() as never, '/map')).rejects.toMatchObject({ code: 'invalid-input' });

    const a = new File(['a'], 'a.txt');
    const b = new File(['b'], 'b.txt');
    await vm.mount([a, b], '/in');
    const record = calls.at(-1)![2] as Record<string, Blob>;
    expect(Object.keys(record)).toEqual(['a.txt', 'b.txt']);
    expect(record['a.txt']).toBe(a);
    await expect(vm.mount([a, new File(['x'], 'a.txt')], '/dup')).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(vm.mount(new Blob(['x']) as never, '/blob')).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(vm.mount({ 'x.bin': new Blob(['x']) }, 'relative')).rejects.toMatchObject({ code: 'invalid-input' });
    const blobs = { 'x.bin': new Blob(['x']) };
    await vm.mount(blobs, '/x');
    expect(calls.at(-1)![2]).toBe(blobs);

    await m.unmount();
    await m.unmount();
    expect(calls.filter((c) => c[0] === 'unmount')).toEqual([['unmount', 'vm1', '/work']]);
    // An old handle does not undo a newer mount at the same path.
    const first = await vm.mount(blobs, '/again');
    await vm.unmount('/again');
    await vm.mount(blobs, '/again');
    await first.unmount();
    expect(calls.filter((c) => c[0] === 'unmount' && c[2] === '/again')).toHaveLength(1);
    await expect(vm.mount(null as never, '/n')).rejects.toMatchObject({ code: 'invalid-input' });

    // Nor while the newer mount is still under way.
    const old = await vm.mount(blobs, '/race');
    const undoing = vm.unmount('/race');
    const redoing = vm.mount(blobs, '/race');
    await old.unmount();
    await undoing;
    const fresh = await redoing;
    expect(calls.filter((c) => c[0] === 'unmount' && c[2] === '/race')).toHaveLength(1);
    await fresh.unmount();
    expect(calls.filter((c) => c[0] === 'unmount' && c[2] === '/race')).toHaveLength(2);

    // A refused mount leaves the earlier handle in charge.
    const live = await vm.mount(blobs, '/busy');
    refuse = true;
    await expect(vm.mount(blobs, '/busy')).rejects.toMatchObject({ code: 'invalid-input' });
    refuse = false;
    await live.unmount();
    expect(calls.at(-1)).toEqual(['unmount', 'vm1', '/busy']);

    await vm.writeFile('/etc/motd', 'hello', { mode: 0o644 });
    await vm.writeFile('/a.bin', new TextEncoder().encode('bytes'));
    await vm.writeFile('/b.bin', new Blob(['blob']));
    expect(calls.filter((c) => c[0] === 'writeFile').map((c) => [c[2], c[3]])).toEqual([
      ['/etc/motd', 'hello'],
      ['/a.bin', 'bytes'],
      ['/b.bin', 'blob'],
    ]);
    await expect(vm.writeFile('/c', 42 as never)).rejects.toMatchObject({ code: 'invalid-input' });
    const read = await vm.readFile('/etc/hostname', { timeoutMs: 1000 });
    expect(await read.text()).toBe('read /etc/hostname');
    expect(calls.at(-1)).toEqual(['readFile', 'vm1', '/etc/hostname', { timeoutMs: 1000 }]);

    // A disposed VM throws at once, like the other calls.
    await vm.dispose();
    expect(() => vm.mount(blobs, '/x')).toThrow(/disposed/);
    expect(() => vm.unmount('/x')).toThrow(/disposed/);

    // An engine before file sharing says which one is needed.
    const older = createArm64JS({
      isolated: true,
      importRuntime: async () => ({ protocol: PROTOCOL_VERSION, engine: '0.3', createHost: () => fakeHost() }),
    });
    const vm2 = await older.boot('alpine');
    await expect(vm2.writeFile('/x', 'x')).rejects.toMatchObject({ code: 'share-unavailable', message: /0\.4/ });
    await expect(vm2.readFile('/x')).rejects.toMatchObject({ code: 'share-unavailable' });
    await expect(vm2.mount(blobs, '/x')).rejects.toMatchObject({ code: 'share-unavailable' });
    await expect(vm2.unmount('/x')).rejects.toMatchObject({ code: 'share-unavailable' });
  });
});
