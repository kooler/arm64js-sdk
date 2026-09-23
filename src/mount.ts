// Checks and normalizes what a page passes to `vm.mount`, before anything is
// sent to the runtime.

import { Arm64JSError } from '@arm64js/protocol';

/**
 * What `mount` takes: a record of file name → Blob, or a list of Files (an
 * `<input type=file>`'s `files`, a drop's).
 */
export type MountSource = Record<string, Blob> | Iterable<File> | ArrayLike<File>;

/**
 * `path` with repeated and trailing slashes dropped, so one folder has one key.
 * The runtime checks the rest.
 */
export function guestPath(path: string): string {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new Arm64JSError('invalid-input', `the path must be an absolute guest path, not ${JSON.stringify(path)}`);
  }
  return `/${path
    .split('/')
    .filter((p) => p !== '' && p !== '.')
    .join('/')}`;
}

/** The record of Blobs the runtime takes. */
export function mountFiles(source: MountSource): Record<string, Blob> {
  const files = recordOf(source);
  if (Object.keys(files).length === 0) {
    throw new Arm64JSError('invalid-input', 'mount: no files to share');
  }
  return files;
}

function recordOf(source: MountSource): Record<string, Blob> {
  if (!source || typeof source !== 'object') {
    throw new Arm64JSError('invalid-input', 'mount takes a record of Blobs or a list of Files');
  }
  if (source instanceof Blob) {
    throw new Arm64JSError('invalid-input', 'mount: name the Blob, e.g. { "data.bin": blob }');
  }
  const list = source as Partial<Iterable<File>> & Partial<ArrayLike<File>>;
  if (typeof list[Symbol.iterator] === 'function' || typeof list.length === 'number') {
    return filesRecord(source as Iterable<File>);
  }
  // Checked here: something else (a folder handle) may not even reach the VM's
  // frame, and then no answer would ever come back.
  const proto: unknown = Object.getPrototypeOf(source);
  if (proto !== Object.prototype && proto !== null) {
    throw new Arm64JSError('invalid-input', 'mount takes a record of Blobs or a list of Files');
  }
  for (const [name, blob] of Object.entries(source as Record<string, unknown>)) {
    if (!(blob instanceof Blob)) {
      throw new Arm64JSError('invalid-input', `mount: ${name} is not a Blob`);
    }
  }
  return source as Record<string, Blob>;
}

/** A list of Files as the record the runtime takes, named by `File.name`. */
function filesRecord(source: Iterable<File> | ArrayLike<File>): Record<string, Blob> {
  const record = Object.create(null) as Record<string, Blob>;
  for (const file of Array.from(source as ArrayLike<File>)) {
    if (!(file instanceof Blob) || typeof (file as { name?: unknown }).name !== 'string') {
      throw new Arm64JSError('invalid-input', 'mount: every item in a list must be a File');
    }
    if (file.name in record) {
      throw new Arm64JSError('invalid-input', `mount: two files are named ${file.name}`);
    }
    record[file.name] = file;
  }
  return record;
}
