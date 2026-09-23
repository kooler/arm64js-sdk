// An optional terminal for a VM, on xterm.js:
//
//   import { attachTerminal } from 'arm64js/terminal';
//   import '@xterm/xterm/css/xterm.css';
//   const term = attachTerminal(vm, document.getElementById('term')!);
//
// A separate entry point, so a page that never imports it carries no xterm.
// `@xterm/xterm` and `@xterm/addon-fit` are optional peer dependencies.

import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type ITerminalOptions } from '@xterm/xterm';
import type { Vm } from './vm.js';

export interface TerminalOptions {
  /** Size the terminal to its element, now and whenever the element resizes
   *  (default true). Off, the terminal keeps `xterm.cols`/`xterm.rows`. */
  fit?: boolean;
  /** Passed to xterm's `Terminal`. */
  xterm?: ITerminalOptions;
}

export interface AttachedTerminal {
  /** The xterm instance, for themes, focus and addons. */
  readonly xterm: Terminal;
  /** Refit to the element now. */
  fit(): void;
  /** Detach from the VM and remove the terminal. The VM keeps running. */
  dispose(): void;
}

/**
 * How long the element must stay one size before the guest hears it, so a
 * drag repaints a full-screen program once rather than per frame.
 */
const RESIZE_SETTLE_MS = 100;

/** Show a VM's console in `element` and send what is typed there to the guest. */
export function attachTerminal(vm: Vm, element: HTMLElement, opts: TerminalOptions = {}): AttachedTerminal {
  const xterm = new Terminal({ convertEol: true, cursorBlink: true, ...opts.xterm });
  const fitAddon = new FitAddon();
  const fitting = opts.fit ?? true;
  if (fitting) {
    xterm.loadAddon(fitAddon);
  }
  xterm.open(element);

  const report = (e: unknown) => globalThis.console?.warn?.('[arm64js] terminal', e);
  // What an `exec` prints is its caller's, not the person's at the keyboard.
  const unsubscribeOutput = vm.onOutput((bytes, info) => {
    if (!info.exec) {
      xterm.write(bytes);
    }
  });
  const unsubscribeExit = vm.onExit(({ reason }) => {
    xterm.options.disableStdin = true;
    xterm.write(`\r\n[the VM stopped: ${reason}]\r\n`);
  });
  const inputSubscription = xterm.onData((data) => void vm.write(data).catch(report));

  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSentSize = '';
  const sendSizeToGuest = () => {
    const size = `${xterm.cols}x${xterm.rows}`;
    if (size === lastSentSize) {
      return;
    }
    lastSentSize = size;
    void vm.resize(xterm.cols, xterm.rows).catch(report);
  };
  const resizeSubscription = xterm.onResize(() => {
    if (resizeTimer !== null) {
      clearTimeout(resizeTimer);
    }
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      sendSizeToGuest();
    }, RESIZE_SETTLE_MS);
  });
  const fit = () => {
    if (fitting) {
      fitAddon.fit();
    }
  };
  const observer = fitting && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => fit()) : null;
  observer?.observe(element);
  fit();
  sendSizeToGuest();
  // The guest's prompt was printed before this terminal existed; an empty line
  // brings up a fresh one.
  void vm.write('\r').catch(report);

  let disposed = false;
  return {
    xterm,
    fit,
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      if (resizeTimer !== null) {
        clearTimeout(resizeTimer);
      }
      observer?.disconnect();
      unsubscribeOutput();
      unsubscribeExit();
      inputSubscription.dispose();
      resizeSubscription.dispose();
      xterm.dispose();
    },
  };
}
