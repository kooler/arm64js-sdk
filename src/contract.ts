// The contract between the arm64js SDK (npm `arm64js`, repo kooler/arm64js-sdk)
// and this runtime, which the SDK loads from the CDN as `sdk-v<X.Y>/`.
//
// This file and `rpc-client.ts` are the only text the two repositories share:
// the SDK vendors both verbatim, and the release workflow publishes them beside
// the runtime so the SDK's CI can diff its copies against the version it pins.
// So this one imports nothing and names no runtime internals — every type must
// cross a `postMessage` boundary, and every value is a literal or the one error
// class both sides construct.
//
// Bump `CONTRACT_VERSION` on any change a released SDK could not survive
// (a removed op, a renamed field, a changed meaning). Adding an optional field
// or a new op is not a bump: an older SDK simply never uses it.

/// The contract this runtime speaks. The frame handshake and the runtime module
/// both report it; the SDK refuses a mismatch with `contract-mismatch`.
export const CONTRACT_VERSION = 1;

/// Where the SDK, the runtime and the images live. Fixed: a configurable base
/// would only let a page point the runtime at chunks built for another engine.
export const CDN_BASE = 'https://cdn.arm64js.com';

/// The frame handshake and the one message the page sends back. Spellings are
/// pinned by tests on both sides of the origin boundary.
export const FRAME_MESSAGE_KIND = 'arm64js-frame';
export const FRAME_OP_CONNECT = 'connect';
/// The RPC envelope kind on the connected port.
export const RPC_KIND = 'arm64js';

/// Every way an SDK call can fail. The RPC layer carries these by `code` and
/// the SDK rethrows them, so a page sees one vocabulary in both modes.
export type Arm64JSErrorCode =
  | 'unsupported-browser'
  | 'contract-mismatch'
  | 'engine-mismatch'
  | 'image-not-found'
  | 'boot-failed'
  | 'exec-timeout'
  | 'exec-failed'
  | 'vm-exited'
  | 'vm-lost'
  | 'storage-unavailable'
  | 'quota'
  | 'snapshot-failed'
  | 'snapshot-not-found'
  | 'snapshot-in-use'
  | 'snapshot-corrupt'
  | 'invalid-input';

/// The error every SDK-facing failure is reported as.
export class Arm64JSError extends Error {
  readonly code: Arm64JSErrorCode;
  readonly data?: unknown;
  constructor(code: Arm64JSErrorCode, message: string, data?: unknown) {
    super(message);
    this.name = 'Arm64JSError';
    this.code = code;
    this.data = data;
  }
}

/// One published build of an image. A snapshot resumes only on an engine whose
/// `format` and `layout` match, so a record carries one build per epoch.
export interface ImageBuild {
  /** The deploy that baked it (informational; not what compatibility keys on). */
  engine_release: string;
  /** Snapshot format version (`MANIFEST_VERSION` in the runtime). */
  format: number;
  /** Shared-memory layout version (`LAYOUT_VERSION` in the runtime). */
  layout: number;
  /** The snapshot manifest hash: `<CDN_BASE>/manifest/<hash>`. */
  manifest: string;
  size_bytes: number;
  vcpus: number;
  /** Whether the guest was baked with a network card (the SDK boots only these). */
  net: boolean;
  /** ISO timestamp of the bake. */
  built: string;
}

/// `images/<name>/<version>.json` and `images/<name>/latest.json` on the CDN.
export interface ImageRecord {
  name: string;
  version: number;
  builds: ImageBuild[];
}

/// A boot's progress, as the SDK's `onProgress` sees it. `memory` repeats with
/// chunk counts while the working set streams in.
export interface BootProgress {
  stage: 'resolve' | 'manifest' | 'start' | 'memory' | 'run' | 'done';
  done?: number;
  total?: number;
}

export interface BootOptions {
  /** Guest CPUs the image build must have (default: any; the newest compatible build wins). */
  vcpus?: number;
  onProgress?: (p: BootProgress) => void;
}

export interface ExecOptions {
  /**
   * Give up after this long (default 120 000 ms) with `exec-timeout`. The VM
   * keeps running, and the runtime interrupts whatever held the terminal so the
   * next `exec` is not typed into it — which works for anything that answers
   * Ctrl-C.
   */
  timeoutMs?: number;
}

export interface ExecResult {
  /**
   * What the script printed: stdout and stderr merged (one serial console),
   * escapes stripped, the command's own echo removed. Bounded; see `truncated`.
   */
  output: string;
  /** The script's exit status, from the guest's own report. */
  exitCode: number;
  /** Whether `output` is only the tail of what the script printed (it is capped
   *  at 1 MiB, and the head is what goes). */
  truncated: boolean;
}

/// What `onOutput` says about a chunk. Absent before engine 0.3.
export interface OutputInfo {
  exec?: boolean;
}

/// How a VM's run ended.
export interface VmExit {
  reason: string;
}

export interface SnapshotOptions {
  name?: string;
  /** Anything JSON, up to 16 KiB, stored with the record and returned by `list`. */
  meta?: unknown;
  onProgress?: (done: number, total: number) => void;
}

/// A snapshot kept in this origin's browser storage. `boot(info.id)` resumes it.
export interface SnapshotInfo {
  id: string;
  name: string | null;
  /** Save time, ms since the epoch. */
  created: number;
  /** The CDN image the chain started from (`'alpine'`, `'alpine:2'`, …). */
  base: string;
  /** The engine tag it was saved on. One engine runs per page (the SDK's pin),
   *  so this is what a `boot` of it needs. An engine whose snapshot format
   *  differs refuses it with `engine-mismatch`; most releases do not change
   *  that format. */
  engine: string;
  vcpus: number;
  /** Bytes this save wrote, not the whole chain. */
  sizeBytes: number;
  meta: unknown;
}

export interface StorageStatus {
  /** Whether snapshots can be kept at all here. */
  available: boolean;
  /** Why not, when `available` is false. */
  reason?: 'no-opfs' | 'blocked' | 'insecure-context';
  /** Whether the browser has granted this origin persistent storage. */
  persistent?: boolean;
  quota?: number;
  usage?: number;
  /** Snapshots kept here. */
  snapshots: number;
  /** Bytes in the chunk pool (snapshots and cached image chunks together). */
  poolBytes: number;
}

/// What the runtime offers the SDK: called directly inline, and through the
/// frame's RPC server otherwise. Every method is async and every argument and
/// result structured-cloneable, except the callbacks, which become events.
export interface Host {
  /** Boot a CDN image (`'alpine'`, `'alpine:2'`, `'alpine@sha256:<hex>'`) or a
   *  local snapshot by id (64 hex characters). Resolves once the guest is stepping. */
  boot(target: string, opts?: BootOptions): Promise<{ vmId: string }>;
  /** Run a shell script in the guest and report its exit status. One at a time per VM. */
  exec(vmId: string, script: string, opts?: ExecOptions): Promise<ExecResult>;
  /** Observe the raw console bytes the guest prints. `info.exec` marks bytes
   *  printed by an `exec` (its script, its output, the prompts around it), which
   *  a terminal hides. Returns the unsubscribe. */
  onOutput(vmId: string, cb: (bytes: Uint8Array, info: OutputInfo) => void): () => void;
  /** Type into the guest's console, as a person at a terminal would. Held
   *  while an `exec` or a `snapshot` runs, and sent after it. Absent before
   *  engine 0.3. */
  write?(vmId: string, data: string): Promise<void>;
  /** Set the guest's terminal size. Absent before engine 0.3. */
  resize?(vmId: string, cols: number, rows: number): Promise<void>;
  /** Observe the guest's run ending (a halt, a fault). Returns the unsubscribe. */
  onExit(vmId: string, cb: (exit: VmExit) => void): () => void;
  /** Stop the VM and free its workers. Idempotent. */
  dispose(vmId: string): Promise<void>;
  /** Save the VM to browser storage. The VM keeps running. */
  snapshot(vmId: string, opts?: SnapshotOptions): Promise<SnapshotInfo>;
  listSnapshots(): Promise<SnapshotInfo[]>;
  getSnapshot(id: string): Promise<SnapshotInfo | null>;
  /** Delete a snapshot; refused while a VM runs from it unless `force`. */
  removeSnapshot(id: string, opts?: { force?: boolean }): Promise<void>;
  storageStatus(): Promise<StorageStatus>;
}

/// The shape of the runtime module (`sdk-v<X.Y>/arm64js-sdk-lib.js`) the SDK
/// imports. `engine` is the CDN version tag (`'0.11'`), `contract` is
/// `CONTRACT_VERSION` as built.
export interface RuntimeModule {
  contract: number;
  engine: string;
  createHost(): Host;
}

/// The frame's first message to the page that framed it, posted on load.
export interface FrameHandshake {
  kind: typeof FRAME_MESSAGE_KIND;
  v: 1;
  /** Whether the frame document is cross-origin isolated (the runtime can run). */
  isolated: boolean;
  contract: number;
  engine: string;
}

/// The page's one message back: the port the RPC then runs on (transferred).
export interface FrameConnect {
  kind: typeof FRAME_MESSAGE_KIND;
  v: 1;
  op: typeof FRAME_OP_CONNECT;
}

/// The RPC over the connected port: a `Call` names a `Host` op and gets one
/// `Reply`; `Event`s are unsolicited (output, exit, boot progress); `Ping`/
/// `Pong` keep both ends sure the other is alive.
export type RpcCall = { kind: typeof RPC_KIND; v: 1; id: number; op: string; args: unknown[] };
export type RpcReply =
  | { kind: typeof RPC_KIND; v: 1; re: number; ok: true; value: unknown }
  | { kind: typeof RPC_KIND; v: 1; re: number; ok: false; error: { code: Arm64JSErrorCode; message: string } };
export type RpcEvent = {
  kind: typeof RPC_KIND;
  v: 1;
  event: string;
  vmId?: string;
  re?: number;
  data: unknown;
  /** On `output`: the chunk came from an `exec`. */
  exec?: boolean;
};
export type RpcPing = { kind: typeof RPC_KIND; v: 1; ping: number } | { kind: typeof RPC_KIND; v: 1; pong: number };
export type RpcMessage = RpcCall | RpcReply | RpcEvent | RpcPing;

/// Bounds on `write` and `resize`.
export const WRITE_MAX_CHARS = 64 * 1024;
export const TERM_MAX_COLS = 1000;
export const TERM_MAX_ROWS = 500;

/// How often the client pings, and how many unanswered pings mean the frame is gone.
export const RPC_PING_MS = 10_000;
export const RPC_PING_MISSES = 2;

/// The RPC op names, one per `Host` method, plus the two subscriptions carried
/// as events. Spelled out so both sides pin the same list.
export const RPC_OPS = [
  'boot',
  'exec',
  'dispose',
  'snapshot',
  'listSnapshots',
  'getSnapshot',
  'removeSnapshot',
  'storageStatus',
  'subscribeOutput',
  'unsubscribeOutput',
  'write',
  'resize',
] as const;
export const RPC_EVENTS = ['progress', 'output', 'exit', 'lost'] as const;
