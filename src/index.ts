import { createArm64JS, type Arm64JSApi } from './api.js';

export type { Arm64JSApi } from './api.js';
export type { HostMode } from './hosts.js';
export type { MountSource } from './mount.js';
export { VERSION as version } from './version.js';
export { Connection, type ConnectionData } from './connection.js';
export type { HttpHandler } from './http.js';
export { DEFAULT_MAX_BODY_BYTES, Vm, type FileData, type Listener, type Mount, type ServeHttpOptions } from './vm.js';
export type {
  Arm64JSErrorCode,
  BootOptions,
  BootProgress,
  ExecOptions,
  ExecResult,
  GatewayOptions,
  OutputInfo,
  ReadFileOptions,
  SnapshotInfo,
  SnapshotOptions,
  StorageStatus,
  VmExit,
  WriteFileOptions,
} from '@arm64js/protocol';
export { Arm64JSError, HOST_INTERNAL_NAME } from '@arm64js/protocol';

export const Arm64JS: Arm64JSApi = createArm64JS();
export default Arm64JS;
