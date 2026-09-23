// The optional terminal: output reaches xterm, typing and size reach the VM,
// and dispose detaches everything. xterm is replaced by a recording double.
// Also pins that nothing but this entry point names xterm.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const made: FakeTerminal[] = [];

class Emitter<T> {
  private readonly cbs = new Set<(v: T) => void>();
  on = (cb: (v: T) => void) => {
    this.cbs.add(cb);
    return { dispose: () => this.cbs.delete(cb) };
  };
  fire(v: T) {
    for (const cb of this.cbs) {
      cb(v);
    }
  }
  get size() {
    return this.cbs.size;
  }
}

class FakeTerminal {
  cols = 80;
  rows = 24;
  written: Array<string | Uint8Array> = [];
  options: Record<string, unknown>;
  opened: unknown = null;
  disposed = false;
  data = new Emitter<string>();
  resized = new Emitter<{ cols: number; rows: number }>();
  onData = this.data.on;
  onResize = this.resized.on;
  constructor(opts: Record<string, unknown>) {
    this.options = { ...opts };
    made.push(this);
  }
  loadAddon(addon: { activate(t: FakeTerminal): void }) {
    addon.activate(this);
  }
  open(el: unknown) {
    this.opened = el;
  }
  write(d: string | Uint8Array) {
    this.written.push(d);
  }
  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.resized.fire({ cols, rows });
  }
  dispose() {
    this.disposed = true;
  }
}

vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerminal }));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    term: FakeTerminal | null = null;
    activate(t: FakeTerminal) {
      this.term = t;
    }
    fit() {
      this.term?.resize(120, 40);
    }
  },
}));

const { attachTerminal } = await import('../src/terminal.ts');

function fakeVm() {
  const output = new Set<(b: Uint8Array, info: { exec?: boolean }) => void>();
  const exit = new Set<(e: { reason: string }) => void>();
  const writes: string[] = [];
  const sizes: Array<[number, number]> = [];
  const vm = {
    onOutput: (cb: (b: Uint8Array, info: { exec?: boolean }) => void) => (output.add(cb), () => output.delete(cb)),
    onExit: (cb: (e: { reason: string }) => void) => (exit.add(cb), () => exit.delete(cb)),
    write: async (d: string) => void writes.push(d),
    resize: async (c: number, r: number) => void sizes.push([c, r]),
  };
  return {
    vm: vm as never,
    writes,
    sizes,
    print: (s: string, exec = false) => output.forEach((cb) => cb(new TextEncoder().encode(s), exec ? { exec } : {})),
    stop: (reason: string) => exit.forEach((cb) => cb({ reason })),
    listeners: () => output.size + exit.size,
  };
}

beforeEach(() => {
  made.length = 0;
  vi.useFakeTimers();
});

describe('attachTerminal', () => {
  it('fits, reports the size, and asks for a fresh prompt', () => {
    const f = fakeVm();
    const el = {};
    const t = attachTerminal(f.vm, el as HTMLElement);
    expect(made[0].opened).toBe(el);
    expect(f.sizes).toEqual([[120, 40]]);
    expect(f.writes).toEqual(['\r']);
    expect(t.xterm).toBe(made[0]);
  });

  it('shows output, sends typing, and pushes a settled resize once', () => {
    const f = fakeVm();
    attachTerminal(f.vm, {} as HTMLElement);
    const term = made[0];
    f.print('hello');
    f.print('stty -echo', true);
    expect(term.written.map((w) => new TextDecoder().decode(w as Uint8Array))).toEqual(['hello']);
    term.data.fire('ls\r');
    expect(f.writes.at(-1)).toBe('ls\r');
    term.resize(100, 30);
    term.resize(101, 30);
    expect(f.sizes).toEqual([[120, 40]]);
    vi.advanceTimersByTime(150);
    expect(f.sizes).toEqual([
      [120, 40],
      [101, 30],
    ]);
  });

  it('stops input when the VM stops, and dispose detaches everything', () => {
    const f = fakeVm();
    const t = attachTerminal(f.vm, {} as HTMLElement, { fit: false, xterm: { fontSize: 12 } });
    const term = made[0];
    expect(term.options.fontSize).toBe(12);
    expect(f.sizes).toEqual([[80, 24]]);
    f.stop('halted');
    expect(term.options.disableStdin).toBe(true);
    expect(String(term.written.at(-1))).toContain('halted');
    t.dispose();
    t.dispose();
    expect(term.disposed).toBe(true);
    expect(f.listeners()).toBe(0);
    expect(term.data.size + term.resized.size).toBe(0);
  });
});

describe('packaging', () => {
  it('names xterm only in the terminal entry point', () => {
    const dir = fileURLToPath(new URL('../src/', import.meta.url));
    const naming = readdirSync(dir).filter((f) => readFileSync(dir + f, 'utf8').includes('@xterm/'));
    expect(naming).toEqual(['terminal.ts']);
  });

  it('exports the terminal as its own entry, with xterm as an optional peer', () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
      exports: Record<string, { default: string }>;
      dependencies?: Record<string, string>;
      peerDependenciesMeta: Record<string, { optional: boolean }>;
    };
    expect(pkg.exports['./terminal'].default).toBe('./dist/terminal.js');
    expect(pkg.dependencies ?? {}).not.toHaveProperty('@xterm/xterm');
    expect(pkg.peerDependenciesMeta['@xterm/xterm'].optional).toBe(true);
    expect(pkg.peerDependenciesMeta['@xterm/addon-fit'].optional).toBe(true);
  });
});
