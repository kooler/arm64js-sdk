// Frame mode: the runtime in a hidden iframe on the CDN, over a MessagePort.
// The frame document carries Document-Isolation-Policy, so it is cross-origin
// isolated whatever this page's headers say — the only way a page that cannot
// set COOP/COEP gets a VM. Its handshake says whether that worked; a browser
// without the header comes up unisolated and this reports
// `unsupported-browser` rather than a VM that would never boot.

import {
  Arm64JSError,
  CONTRACT_VERSION,
  FRAME_MESSAGE_KIND,
  FRAME_OP_CONNECT,
  type FrameConnect,
  type FrameHandshake,
  type Host,
} from './contract.js';
import { RpcClient } from './rpc-client.js';

/// How long the frame gets to say hello before the page gives up on it: a frame
/// that never runs a script (blocked third-party frames, a network failure).
export const FRAME_HANDSHAKE_TIMEOUT_MS = 8_000;

/// The message the developer sees when the browser cannot isolate the frame.
export const UNSUPPORTED_MESSAGE =
  'arm64js needs SharedArrayBuffer, and this browser cannot isolate the VM frame on its own ' +
  '(Document-Isolation-Policy is Chrome/Edge 137+). To run here, serve your page with ' +
  'Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp ' +
  'so that crossOriginIsolated is true; the SDK then runs inline in every browser.';

/// Seams for tests: how the iframe is made and how messages arrive.
export interface FrameDeps {
  document?: Pick<Document, 'createElement' | 'body'>;
  view?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
  makeChannel?: () => { port1: MessagePort; port2: MessagePort };
}

export interface FrameHost {
  host: Host;
  client: RpcClient;
  iframe: HTMLIFrameElement;
  /** Fires once when the frame stops answering. */
  onLost(cb: () => void): () => void;
  dispose(): void;
}

/// Mount the frame for `frameUrl`, wait for its handshake, hand it a port.
export function mountFrameHost(url: string, deps: FrameDeps = {}): Promise<FrameHost> {
  const doc = deps.document ?? document;
  const view = deps.view ?? window;
  const later = deps.setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
  const cancel = deps.clearTimeout ?? ((h) => clearTimeout(h as number));
  const origin = new URL(url).origin;

  const iframe = doc.createElement('iframe');
  iframe.src = url;
  iframe.setAttribute('title', 'arm64js');
  iframe.setAttribute('aria-hidden', 'true');
  // In the layout and on screen, never display:none: a hidden frame's timers are
  // throttled by the browser. The VM steps in workers, but the frame's main
  // thread still relays.
  iframe.style.cssText = 'position:fixed;bottom:0;right:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none';

  return new Promise<FrameHost>((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | null, value?: FrameHost) => {
      if (settled) return;
      settled = true;
      cancel(timer);
      view.removeEventListener('message', onMessage as EventListener);
      if (err) {
        iframe.remove();
        reject(err);
      } else resolve(value!);
    };
    const timer = later(
      () =>
        finish(
          new Arm64JSError(
            'unsupported-browser',
            `the VM frame did not answer within ${FRAME_HANDSHAKE_TIMEOUT_MS / 1000}s. ${UNSUPPORTED_MESSAGE}`,
          ),
        ),
      FRAME_HANDSHAKE_TIMEOUT_MS,
    );
    const onMessage = (e: MessageEvent) => {
      // Only this frame, from the origin we loaded it from, saying the one thing
      // we expect. Anything else on the page can post to this window.
      if (e.source !== iframe.contentWindow) return;
      if (e.origin !== origin) return;
      const d = e.data as Partial<FrameHandshake> | null;
      if (!d || d.kind !== FRAME_MESSAGE_KIND || d.v !== 1 || typeof d.isolated !== 'boolean') return;
      if (!d.isolated) return finish(new Arm64JSError('unsupported-browser', UNSUPPORTED_MESSAGE));
      if (d.contract !== CONTRACT_VERSION) {
        return finish(
          new Arm64JSError(
            'contract-mismatch',
            `this SDK speaks contract ${CONTRACT_VERSION} but the engine runtime speaks ${String(d.contract)}; update the arm64js package or pin an engine it matches`,
          ),
        );
      }
      const { port1, port2 } = (deps.makeChannel ?? (() => new MessageChannel()))();
      const connect: FrameConnect = { kind: FRAME_MESSAGE_KIND, v: 1, op: FRAME_OP_CONNECT };
      iframe.contentWindow?.postMessage(connect, origin, [port2]);
      const client = new RpcClient(port1);
      finish(null, {
        host: client,
        client,
        iframe,
        onLost: (cb) => client.onLost(cb),
        dispose() {
          client.close();
          iframe.remove();
        },
      });
    };
    view.addEventListener('message', onMessage as EventListener);
    doc.body.appendChild(iframe);
  });
}
