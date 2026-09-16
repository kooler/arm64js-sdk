# arm64js SDK

arm64js is a WebAssembly based arm64 emulator running in web browser allowing to boot and control a real Linux (Alpine).

This SDK provides a way to create a VM, set it up and interact with it. The SDK is distributed as npm package and integrated with arm64js CDN.

## VM lifecycle

1. _Boot a base image._ Similarly to Docker you need to select one of the available base images to boot your VM. Only base images provided by arm64js can be used at the moment as they require some customization to work "quick" when being emulated in web browser. For now only 'alpine' is provided. Booting the image creates VM instance:

```js
import { Arm64JS } from 'arm64js';
const vm = await Arm64JS.boot('alpine');
```

2. _Setup the VM._ You would likely want to install some extra packages or copy files into your VM so that it can do something useful. To manage packages use `apk` as you would in the native Alpine. To execute a command (any command pretty much) the `vm.exec` method is used:

```js
const { output, exitCode } = await vm.exec('apk add --no-cache curl');
```

it returns raw `output` and `exitCode` so that you can verify if it worked.

The VM doesn't have access to the internet except the apk registry, so if you'd like it to work with some custom data you need to copy that data into the VM.

```js
import { Arm64JS } from 'arm64js';

const vm = await Arm64JS.boot('alpine');
const { output, exitCode } = await vm.exec('apk add --no-cache curl && curl --version');
const snap = await vm.snapshot({ name: 'with curl' });
await vm.dispose();

// later, even after a reload:
const again = await Arm64JS.boot(snap.id);
```

If your page sends a Content-Security-Policy, it needs to allow that origin: `script-src https://cdn.arm64js.com`, `connect-src https://cdn.arm64js.com`, `worker-src blob:` (the VM's workers are started through a blob, which is what lets them load cross-origin), and `frame-src https://cdn.arm64js.com` for the frame path below.

## Install

```sh
npm install arm64js
```

## Where the VM runs

The VM needs `SharedArrayBuffer`, which browsers only give to cross-origin-isolated pages. You do not have to set anything up:

| Your page                                                                                        | What happens                                                                                                                    |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| sends `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` | the VM runs **inline**, in your page's own workers. Every browser.                                                              |
| sends no such headers (the usual case)                                                           | the VM runs in a hidden **frame** served from the CDN that isolates itself (`Document-Isolation-Policy`). Chrome and Edge 137+. |
| neither works (Firefox, Safari, without your headers)                                            | `boot()` rejects with `unsupported-browser`, and the message says which two headers make it run inline.                         |

`Arm64JS.mode()` tells you which one you got. The API is the same in both.

## API

### `Arm64JS.configure({ engine })`

Which engine to load. Default: the version this package was released with (`v<major>.<minor>` of the package version), exact and never rewritten. `'v0'` follows the newest 0.x on the CDN; `'latest'` the newest of all. Call it before the first `boot`.

One engine runs per page. A snapshot records the engine it was saved on and boots only on an engine that can resume it; see Versions below.

### `Arm64JS.boot(image | snapshotId | snapshot, { vcpus?, onProgress? })` → `Vm`

`image` names an image on the CDN: `'alpine'` is the newest version of it, `'alpine:2'` a fixed one, `'alpine@sha256:<hash>'` an exact snapshot. A 64-character hex string, or a `SnapshotInfo`, boots one of this browser's snapshots.

`onProgress` reports `resolve → manifest → start → memory (repeats, with counts) → run → done`.

### `vm.exec(script, { timeoutMs? })` → `{ output, exitCode, truncated }`

Runs `script` as a shell script in the guest (`sh`), one call at a time per VM, and returns what it printed and its exit status.

It works by typing the script into the guest's serial console and reading the bytes back, which sets four limits worth knowing:

- **stdout and stderr are one stream.** There is one console; redirect inside the script if you need them apart.
- **Each line of the script must be under 4000 bytes** (the guest terminal's own line buffer).
- **`output` is capped at 1 MiB**, and past that the head is dropped and `truncated` is `true`. Write to a file and read it back if you need more.
- **A timeout leaves the guest where it was.** The default is two minutes; on `exec-timeout` the SDK interrupts whatever held the terminal so the next `exec` is not typed into it, which works for anything that answers Ctrl-C and not for anything that does not. The VM keeps running either way.

Whatever the script does runs as **root** in the guest. That guest is a VM in the visitor's own browser with no path back to your servers, but it is a real root shell: treat the script the way you would treat any code you hand a machine.

### `vm.onOutput(cb)` → unsubscribe

The raw bytes the guest prints on its console, escape sequences included, and `info.exec`, which is true for what an `exec` printed (its script, its output and the prompts around it). A terminal of your own should skip those; the one below does.

### `vm.write(data)` / `vm.resize(cols, rows)`

Type into the guest's console and set its terminal size, for wiring up a terminal of your own. Input sent while an `exec` or `snapshot` runs is held and delivered after it, so it never lands inside a script. Needs engine 0.3 or newer.

### `vm.onExit(cb)` → unsubscribe

The guest's run ended (it halted, or faulted). Every later call on the VM rejects with `vm-exited`.

### `vm.snapshot({ name?, meta? })` → `SnapshotInfo`

Saves the VM into this origin's browser storage (OPFS) and keeps it running. `meta` is any JSON up to 16 KiB, returned as stored by `snapshots.list()`. Only what changed since the image is written; the image's own data stays on the CDN and is fetched again when needed.

### `vm.dispose()`

Stops the VM and frees its workers.

### `Arm64JS.snapshots.list()` / `.get(id)` / `.remove(id, { force? })`

Snapshots kept by this browser, newest first: `{ id, name, created, base, engine, vcpus, sizeBytes, meta }`. `remove` is refused while a VM runs from that snapshot, unless `force`.

### `Arm64JS.storage.status()`

`{ available, reason?, persistent?, quota?, usage?, snapshots, poolBytes }`. Storage is unavailable in a page that is not a secure context, in a browser without OPFS, and in **frame mode when the browser blocks third-party storage** (a setting, and private windows). Then `snapshot()` rejects with `storage-unavailable` and everything else still works.

Snapshots live where the VM runs: on your origin in inline mode, on the CDN's origin (partitioned to your site) in frame mode. They do not cross between the two. Safari clears script storage after seven days without a visit.

### `Arm64JS.shutdown()`

Disposes every VM and, in frame mode, the frame.

### Errors

Everything rejects with an `Arm64JSError` carrying a `code`: `unsupported-browser`, `contract-mismatch`, `engine-mismatch`, `image-not-found`, `boot-failed`, `exec-timeout`, `vm-exited`, `vm-lost`, `storage-unavailable`, `quota`, `snapshot-failed`, `snapshot-not-found`, `snapshot-in-use`, `snapshot-corrupt`, `invalid-input`.

## Terminal (optional)

A terminal on [xterm.js](https://xtermjs.org), in its own entry point, so a page that does not import it carries no xterm code:

```sh
npm install @xterm/xterm @xterm/addon-fit
```

```js
import { attachTerminal } from 'arm64js/terminal';
import '@xterm/xterm/css/xterm.css';

const term = attachTerminal(vm, document.getElementById('term'));
// term.xterm is the xterm instance; term.dispose() removes it and leaves the VM running.
```

It shows the guest's console, sends what is typed to the guest, and sizes itself to the element (pass `{ fit: false }` to keep a fixed size, and `{ xterm: { … } }` for xterm's own options). `exec` runs on the same console but stays out of the terminal: what it prints is marked (`info.exec` in `vm.onOutput`) and skipped, and keys pressed meanwhile are sent once it finishes.

## Networking

The guest has a network card, DNS, and can install Alpine packages with `apk` through the CDN's package mirror. It has no general internet access.

## Versions

Package `X.Y.Z` pins engine `X.Y` on the CDN, and that engine is what every `boot` on the page uses. A new engine is a new `X.Y` and a new package version; exact versions on the CDN are never rewritten.

Most engine releases change nothing about the snapshot format, and snapshots saved on an older one keep booting. When a release does change it, booting an older snapshot rejects with `engine-mismatch` — the snapshot is intact, but this engine cannot resume it. Two ways out:

- pin the package (and so the engine) the snapshots were made with, which keeps working because old engines stay on the CDN; or
- treat snapshots as a cache: catch `engine-mismatch`, `Arm64JS.snapshots.remove(id)`, and boot the image again.

`SnapshotInfo.engine` says which engine each one needs.

## Development

```sh
npm install
npm test                          # unit tests over fakes
ARM64JS_MAIN_REPO=../arm64js npm test   # also checks src/contract.ts and src/rpc-client.ts against the main repo
npm run build                     # dist/
```

`src/contract.ts` and `src/rpc-client.ts` are copied verbatim from `web/src/sdk-runtime/` in [kooler/arm64js](https://github.com/kooler/arm64js), which builds the engine, the runtime and the images. Do not edit them here.

## License

MIT
