# ARM64JS SDK

arm64js is a WebAssembly based arm64 emulator running in web browser and allowing to boot and control a real Linux (Alpine).

This SDK helps to: create a VM, set it up and interact with it. The SDK is distributed as npm package and integrated with arm64js CDN.

## VM creation lifecycle

1. _Boot a base image._ Similarly to Docker you need to select a base images to boot the initial state of your VM. At the moment only base images provided by arm64js can be used as they require some customization to work "quicker" when emulated in web browser. The list of images and their versions is at [arm64js.com/images](https://arm64js.com/images/). Booting the image creates a VM instance:

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

### `Arm64JS.boot(image | snapshotId, { vcpus?, onProgress? })` → `Vm`

A VM can be created either from a based image or your own local snapshot.

- `image` name of an image on the CDN ([all images](https://arm64js.com/images/)): `'alpine'` is the newest version of it, `'alpine:2'` a fixed one, `'alpine@sha256:<hash>'` an exact snapshot.
- 'snapshotId': a snapshot id (`snap.id`, 64 hex characters) loads one of your own snapshots made previously.

Additionally you can specify `onProgress` callback to track VM loading phases (`resolve → manifest → start → memory (repeats, with counts) → run → done`) and number of virtuals CPUs the VM will have (more is not always better).

### Listener: `vm.onOutput(cb)` → unsubscribe

The raw bytes the guest prints on its console, including escape sequences.

```js
const decoder = new TextDecoder(); // The output comes as bytes (Uint8Array), TextDecoder turns them into text.
const stopOutput = vm.onOutput((bytes, info) => {
  if (info.exec) return; // skip commands that we call ourselfs
  console.log(decoder.decode(bytes, { stream: true }));
});

// to stop listening:
stopOutput();
```

### `vm.onExit(cb)` → unsubscribe

The VM stopped (halted or faulted). Every later call on the VM rejects with `vm-exited`.

If the VM has already stopped, callback is called right away. It is not called for `vm.dispose()`.

```js
const stopExit = vm.onExit(({ reason }) => console.log(`VM stopped: ${reason}`));

// later, to stop listening:
stopExit();
```

### `vm.exec(command, { timeoutMs? })` → `{ output, exitCode, truncated }`

Runs `command` in the guest's shell (`sh`), and returns what it printed and its exit status. `command` can be one command or several, one per line. The default timeout is two minutes.

It works by typing the command into the guest's serial console and reading the bytes back. There are few limits:

- stdout and stderr are merged into one stream.
- Each line of the command must be under 4000 bytes.
- **`output` is capped at 1 MiB**, and past that the head is dropped and `truncated` is `true`. Write to a file and read it back if you need more.
- A timeout does its best to terminate the command (sends Ctrl-C to the VM's console), but that does not guarantee that the command will stop -- a program that ignores Ctrl-C (like vim) will keep running.

Whatever the command does runs as **root** in the guest.

### `vm.write(data)`

Send data directly into VM console, lower level than `vm.exec`, allows sending any keyboard sequences including key presses like Ctrl-C ('\x03') or Enter ('\r').

### `vm.resize(cols, rows)`

Set terminal console size. Mainly useful if you are writing your own terminal implementation.

If you want to use a terminal with your VM it's easier to connect xterm (see "Terminal" section below).

### `vm.writeFile(path, data, { mode?, timeoutMs? })`

Copies `data` (a `Blob` or `File`, bytes, or a string) into the VM as the file `path` (an absolute path). An existing file is replaced, a missing folder is created.

- `mode` sets the permission bits, e.g. `0o755` for a script.
- `timeoutMs` will terminate operation if it doesn't complete within specified time (for example VM is very busy). Default is two minutes plus one second per MiB.

The copy is kept in VM memory, so it has to fit there (`alpine` for example has 1 GiB). If you need to use larger file, use `vm.mount` instead.

**Files become part of the VM, so when snapshot is taken those files will be present in the snapshot.**

### `vm.readFile(path, { maxBytes?, timeoutMs? })` → `Blob`

Copies a file out of VM. The copy is kept in VM memory, so the file should fit there (default 1 GiB). If it doesn't or path is not a file but directory or doesn't exist: the read is refused with `read-failed`.

Here's example of how file can be downloaded from the VM:

```js
const blob = await vm.readFile('/root/report.pdf');
const a = document.createElement('a');
a.href = URL.createObjectURL(blob);
a.download = 'report.pdf';
a.click();
```

### `vm.mount(files, path)` → `{ path, unmount() }`

Mounts files in read-only mode into the VM. Files are not copied so do not consume memory. `path` is created if missing. `files` is a record of names to Blobs (`{ 'data.bin': blob }`), or a list of Files (`input.files` or `dataTransfer.files`).

A path that is already mounted is refused with `invalid-input`, `unmount` it first.

**Mounts are not part of the VM and are not saved in snapshots.** After you boot a snapshot, mount again.

### `vm.unmount(path)`

Undoes a `mount`. If nothing is mounted at `path` it does nothing. While a program in the VM still uses the files, it rejects with `unmount-failed`.

### `vm.snapshot({ name?, meta? })` → `SnapshotInfo`

Saves the VM in browser storage (OPFS) and keeps it running. Use `meta` to store any extra info you'd like to add to the snapshot, any JSON up to 16 KiB, it is returned in `snapshots.list()`.

### `vm.dispose()`

Stops the VM and frees its workers.

### `Arm64JS.snapshots.list()` / `.get(id)` / `.remove(id, { force? })`

Lists stored snapshots, newest first: `{ id, name, created, base, engine, vcpus, sizeBytes, meta }`. `remove` is refused while a VM runs from that snapshot, unless `force` is specified.

### `Arm64JS.storage.status()`

Returns an object describing current storage situation: `{ available, reason?, persistent?, quota?, usage?, snapshots, poolBytes }`.

Storage can be unavailable when:

1. a page is not a secure context
2. a browser without OPFS
3. in **frame mode when the browser blocks third-party storage** (for example in private window).

When storage is not avaialble the `snapshot()` rejects with `storage-unavailable`.

### `Arm64JS.engine()` → `'0.4'`

The engine version SDK has been built with. A VM booted from a snapshot can run on another version (based on version that was running when snapshot has been made). Use `vm.engine` to check which.

### `Arm64JS.shutdown()`

Disposes every VM and, in frame mode, the frames.

### Errors

Everything rejects with an `Arm64JSError` carrying a `code`: `unsupported-browser`, `protocol-mismatch`, `engine-mismatch`, `image-not-found`, `boot-failed`, `exec-timeout`, `exec-failed`, `vm-exited`, `vm-lost`, `storage-unavailable`, `quota`, `snapshot-failed`, `snapshot-not-found`, `snapshot-in-use`, `snapshot-corrupt`, `invalid-input`, `share-unavailable`, `mount-failed`, `unmount-failed`, `write-failed`, `read-failed`.

## Terminal (optional)

A terminal is based on [xterm.js](https://xtermjs.org) and is not included by default, you need to install and wire it separately.

```sh
npm install @xterm/xterm @xterm/addon-fit
```

```js
import { attachTerminal } from 'arm64js/terminal';
import '@xterm/xterm/css/xterm.css';

const term = attachTerminal(vm, document.getElementById('term'));
// term.xterm is the xterm instance; term.dispose() removes it and leaves the VM running.
```

It shows the VM console, sends what is typed to the VM, and sizes itself to the element (pass `{ fit: false }` to keep a fixed size, and `{ xterm: { … } }` for xterm's own options). `vm.exec` runs on the same console but stays out of the terminal, keys pressed while `vm.exec` command is running are sent once it finishes.

## Networking

The VM has a emulated network card, DNS, and can install Alpine packages with `apk` through the CDN's package mirror. It has no general internet access.

## Development

```sh
npm install
npm test
npm run build
```

`protocol/` is the `@arm64js/protocol` package, which the engine uses too. To change it, bump its version and publish it (tag `protocol-v<version>`), update it in the engine and release the engine, then release this package.

## License

MIT
