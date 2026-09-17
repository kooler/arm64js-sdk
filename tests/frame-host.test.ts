// The frame mount over fakes: the handshake is accepted only from the frame's
// own window and origin, an unisolated frame is reported as unsupported, a
// protocol mismatch by name, silence by the timeout, and a good handshake ends
// with one connect message carrying a port.

import { MessageChannel } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { FRAME_MESSAGE_KIND, PROTOCOL_VERSION } from '@arm64js/protocol';
import { mountFrameHost, type FrameDeps } from '../src/frame-host.ts';

function fakePage() {
  const listeners = new Set<(e: unknown) => void>();
  const posted: Array<{ msg: unknown; origin: string; transfer?: unknown[] }> = [];
  const contentWindow = {
    postMessage: (msg: unknown, origin: string, transfer?: unknown[]) => posted.push({ msg, origin, transfer }),
  };
  let appended: unknown = null;
  let removed = false;
  const iframe = {
    style: {} as { cssText?: string },
    attrs: {} as Record<string, string>,
    src: '',
    contentWindow,
    setAttribute(k: string, v: string) {
      this.attrs[k] = v;
    },
    remove() {
      removed = true;
    },
  };
  let timeoutCb: (() => void) | null = null;
  const deps: FrameDeps = {
    document: {
      createElement: () => iframe as unknown as HTMLElement,
      body: { appendChild: (el: unknown) => (appended = el) },
    } as never,
    view: {
      addEventListener: (_t: string, cb: (e: unknown) => void) => listeners.add(cb),
      removeEventListener: (_t: string, cb: (e: unknown) => void) => listeners.delete(cb),
    } as never,
    setTimeout: (cb) => ((timeoutCb = cb), 1),
    clearTimeout: () => {},
    makeChannel: () => new MessageChannel() as never,
  };
  const emit = (data: unknown, over: { source?: unknown; origin?: string } = {}) => {
    for (const cb of [...listeners])
      cb({ source: over.source ?? contentWindow, origin: over.origin ?? 'https://cdn.arm64js.com', data });
  };
  return {
    deps,
    emit,
    posted,
    iframe,
    isAppended: () => appended === iframe,
    isRemoved: () => removed,
    fireTimeout: () => timeoutCb?.(),
  };
}

const URL_ = 'https://cdn.arm64js.com/sdk-v0.11/frame.html';
const hello = (over: Record<string, unknown> = {}) => ({
  kind: FRAME_MESSAGE_KIND,
  v: 1,
  isolated: true,
  protocol: PROTOCOL_VERSION,
  engine: '0.11',
  ...over,
});

describe('mountFrameHost', () => {
  it('appends a 1x1 frame, accepts the handshake, and connects with a port', async () => {
    const page = fakePage();
    const pending = mountFrameHost(URL_, page.deps);
    expect(page.isAppended()).toBe(true);
    expect(page.iframe.src).toBe(URL_);
    expect(page.iframe.style.cssText).toMatch(/width:1px;height:1px/);
    expect(page.iframe.style.cssText).not.toMatch(/display:none/);
    // Wrong window, wrong origin, wrong shape: all ignored.
    page.emit(hello(), { source: {} });
    page.emit(hello(), { origin: 'https://evil.example' });
    page.emit({ kind: 'other' });
    page.emit(hello());
    const mounted = await pending;
    expect(page.posted).toHaveLength(1);
    expect(page.posted[0].msg).toEqual({ kind: FRAME_MESSAGE_KIND, v: 1, op: 'connect' });
    expect(page.posted[0].origin).toBe('https://cdn.arm64js.com');
    expect(page.posted[0].transfer).toHaveLength(1);
    mounted.dispose();
    expect(page.isRemoved()).toBe(true);
  });

  it('reports an unisolated frame as unsupported and removes it', async () => {
    const page = fakePage();
    const pending = mountFrameHost(URL_, page.deps);
    page.emit(hello({ isolated: false }));
    await expect(pending).rejects.toMatchObject({ code: 'unsupported-browser' });
    expect(page.isRemoved()).toBe(true);
  });

  it('reports a protocol mismatch by name', async () => {
    const page = fakePage();
    const pending = mountFrameHost(URL_, page.deps);
    page.emit(hello({ protocol: PROTOCOL_VERSION + 5 }));
    await expect(pending).rejects.toMatchObject({ code: 'protocol-mismatch' });
  });

  it('gives up on a silent frame', async () => {
    const page = fakePage();
    const pending = mountFrameHost(URL_, page.deps);
    page.fireTimeout();
    await expect(pending).rejects.toMatchObject({ code: 'unsupported-browser' });
    expect(page.isRemoved()).toBe(true);
  });
});
