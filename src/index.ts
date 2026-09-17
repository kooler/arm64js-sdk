import { createArm64JS, type Arm64JSApi } from './api.js';

export type { Arm64JSApi } from './api.js';
export type { HostMode } from './hosts.js';
export type { MountSource } from './mount.js';
export { VERSION as version } from './version.js';
export { Vm, type FileData, type Mount } from './vm.js';
export type {
  Arm64JSErrorCode,
  BootOptions,
  BootProgress,
  ExecOptions,
  ExecResult,
  OutputInfo,
  ReadFileOptions,
  SnapshotInfo,
  SnapshotOptions,
  StorageStatus,
  VmExit,
  WriteFileOptions,
} from '@arm64js/protocol';
export { Arm64JSError } from '@arm64js/protocol';

export const Arm64JS: Arm64JSApi = createArm64JS();
export default Arm64JS;
