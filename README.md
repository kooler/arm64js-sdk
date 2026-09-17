# ARM64JS SDK

arm64js is a WebAssembly based arm64 emulator running in web browser and allowing to boot and control a real Linux (Alpine).

This SDK helps to: create a VM, set it up and interact with it. The SDK is distributed as npm package and integrated with arm64js CDN.

## VM creation lifecycle

1. _Boot a base image._ Similarly to Docker you need to select a base images to boot the initial state of your VM. At the moment only base images provided by arm64js can be used as they require some customization to work "quicker" when emulated in web browser. For now only 'alpine' is provided. Booting the image creates a VM instance:

```js
import { Arm64JS } from 'arm64js';
const vm = await Arm64JS.boot('alpine');
```

2. _Setup the VM._ You would likely want to install some extra packages or copy files into your VM so that it can do something useful. For managing packages use `apk` as you would in the native Alpine. To execute a command (any command pretty much) the `vm.exec` method is used:

```js
const { output, exitCode } = await vm.exec('apk add --no-cache curl');
```

it returns raw `output` and `exitCode` so that you can verify the result.

The VM _does not_ have access to the Internet except the apk registry. To give it your own data, you can use on of the two options:

- `vm.writeFile`: copies specified file into the VM. Changing or deleting the file happens only inside the VM. File is saved and loaded with the snapshot. Uses VM memory to copy the file, thus is indended mainly for smaller (up to 100Mb) files.
- `vm.mount`: read-only, direct mount of the data blob. Doesn't use any VM memory. Not stored in the snapshot. To unmount use `vm.unmount()`.

See example below:

```js
await vm.writeFile('/root/data.csv', file); // creates a physical file a the VM
await vm.mount({ 'model.bin': bigFile }, '/data'); // read-only, directly mounted blob, does not copy anything into the VM so can be large file
```

To read any file from the VM use `readFile`:

```js
const result = await vm.readFile('/root/result.txt'); // a copy out, as a Blob
```

3. _Make a snapshot and save it locally_. Once you are done with VM setup you would likely want to save it so that you don't need to do the same setup again. For that make a snapshot of the VM. Snapshots are stored in the [OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system).

```js
const snap = await vm.snapshot({ name: 'alpine with curl' });
console.log(snap.id); // this is the id we'd need to store to load the snapshot later
```

To load from the snapshot specify it's ID when creating the VM:

```js
const again = await Arm64JS.boot(snap.id);
```

## Where the VM runs

The VM needs `SharedArrayBuffer` which browsers only give to cross-origin-isolated pages. If `Cross-Origin-Opener-Policy` (COOP) header is not specified or not sufficient, the SDK will load VM inside the iframe on cdn.arm64js.com domain.

The following decision process is being used:

| Your page                                                                                        | What happens                                                                                   |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| sends `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` | the VM runs **inline**, in your page's own workers. Works in all modern browsers.              |
| sends no COOP headers (likely)                                                                   | the VM runs in a hidden **frame** served from the arm64js. Works only in Chrome and Edge 137+. |
| no COOP header and browser that doesn't support iframe fallback (Firefox, Safari)                | `boot()` rejects with `unsupported-browser`.                                                   |

Call `Arm64JS.mode()` to see which mode is being used. The API is the same in both.

### Setting the headers

To run the VM inline, send these two headers with the HTML of the page that runs the VM:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

We recommend setting them only on the pages that run the VM, not on the whole site, because they change how the browser treats a page:

- files from other domains (scripts, images, fonts, iframes) load only if their server allows it with a `Cross-Origin-Resource-Policy` or CORS header. The arm64js CDN already does.
- popups the page opens lose their link to it, which can break sign-in or payment popups.

Here's an example how to send them with nginx:

```nginx
location = /playground.html {
    add_header Cross-Origin-Opener-Policy same-origin;
    add_header Cross-Origin-Embedder-Policy require-corp;
}
```

To check the setup run `await Arm64JS.mode()`, it should return `'inline'`.

### Content-Security-Policy

If your page sends a Content-Security-Policy and you would like to use iframe based solution, you need to allow arm64js CDN as origin: `script-src https://cdn.arm64js.com`, `connect-src https://cdn.arm64js.com`, `worker-src blob:` (the VM's workers are started through a blob), and `frame-src https://cdn.arm64js.com` for the iframe itself.

## Install

```sh
npm install arm64js
```

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

### `vm.writeFile(path, data, { mode?, timeoutMs? })`

Copies `data` (a `Blob` or `File`, bytes, or a string) into the guest as the file `path`, an absolute guest path. An existing file is replaced, and a missing folder is created. `mode` sets the permission bits, e.g. `0o755` for a script.

The copy is kept in guest memory, like everything the guest writes, so it has to fit there (`alpine` has 1 GiB). Mount a large file instead. The default timeout is two minutes plus one second per MiB.

### `vm.readFile(path, { maxBytes?, timeoutMs? })` → `Blob`

Copies the guest's file `path` out. The copy is kept in page memory. A file larger than `maxBytes` (default 1 GiB, the guest's memory) is refused with `read-failed`, so a program in the guest can't fill your page's memory. The default timeout is ten minutes. To let the visitor save the file:

```js
const blob = await vm.readFile('/root/report.pdf');
const a = document.createElement('a');
a.href = URL.createObjectURL(blob);
a.download = 'report.pdf';
a.click();
```

### `vm.mount(files, path)` → `{ path, unmount() }`

Makes files from your page visible in the guest, read-only, in the folder `path`, which is created if missing. `files` is a record of names to Blobs (`{ 'data.bin': blob }`), or a list of Files (`input.files`, a drop's `dataTransfer.files`).

Nothing is copied up front: the guest reads each file as it needs it. So file size does not matter, and a file larger than the guest's memory works too. To change a file, copy it first (`cp /data/data.bin /root/`). A path that is already mounted is refused with `invalid-input`; `unmount` it first.

Keep in mind:

- **Mounts are not saved in snapshots.** After you boot a snapshot, mount again. Mounts left over in the snapshot are removed first.
- **Some paths can't be mounted over.** A path that would cover `/`, `/bin`, `/dev`, `/etc`, `/lib`, `/proc`, `/run`, `/sbin`, `/sys`, `/tmp` or `/usr` is refused with `invalid-input`, because the VM could then no longer run commands. So is anything under `/run/arm64js/share`, where the SDK keeps its own files. A folder inside the others, like `/usr/local/data` or `/tmp/in`, is fine.
- **If file sharing stops, its mounts are gone.** Calls that were waiting reject (`mount-failed`, `write-failed` or `read-failed`), the next `mount`, `writeFile` or `readFile` starts sharing again, and you need to mount again.
- **The VM waits on file operations.** While the guest waits for a file operation, the whole VM waits too.
- **Requirements.** `mount`, `writeFile` and `readFile` need engine 0.4 or newer and a VM from an image built with file sharing (images on the CDN include it from engine 0.4 on). Otherwise they reject with `share-unavailable`.

### `vm.unmount(path)`

Undoes a `mount`. If nothing is mounted at `path` (including when a program in the guest already unmounted it), it does nothing. While a program in the guest still uses the files, it rejects with `mount-failed`.

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

Everything rejects with an `Arm64JSError` carrying a `code`: `unsupported-browser`, `contract-mismatch`, `engine-mismatch`, `image-not-found`, `boot-failed`, `exec-timeout`, `exec-failed`, `vm-exited`, `vm-lost`, `storage-unavailable`, `quota`, `snapshot-failed`, `snapshot-not-found`, `snapshot-in-use`, `snapshot-corrupt`, `invalid-input`, `share-unavailable`, `mount-failed`, `write-failed`, `read-failed`.

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

One exception: a snapshot saved on engine 0.4 or newer from an image with file sharing does not boot on engine 0.3. It fails with `boot-failed`.

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
