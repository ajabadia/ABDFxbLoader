export interface FileSnapshotEntry {
  path: string;
  size: number;
  mtimeMs: number;
  isDir: boolean;
  hash?: string;
}

export interface RegistrySnapshotEntry {
  key: string;
  valueName: string;
  valueType: string;
  valueData: string;
}

export interface CaptureSnapshot {
  id: string;
  createdAt: string;
  platform: string;
  files: FileSnapshotEntry[];
  registry: RegistrySnapshotEntry[];
  scanRoots: string[];
  registryRoots: string[];
}

export interface CaptureDiff {
  snapshotIdBefore: string;
  snapshotIdAfter: string;
  createdAt: string;
  addedFiles: FileSnapshotEntry[];
  modifiedFiles: Array<{ before: FileSnapshotEntry; after: FileSnapshotEntry }>;
  removedFiles: FileSnapshotEntry[];
  addedRegistry: RegistrySnapshotEntry[];
  modifiedRegistry: Array<{ before: RegistrySnapshotEntry; after: RegistrySnapshotEntry }>;
  removedRegistry: RegistrySnapshotEntry[];
  filteredOut: number;
}

export interface CaptureConfig {
  excludePatterns: string[];
  scanRoots: string[];
  registryRoots: string[];
  computeHashes: boolean;
}

export type CaptureTaskStatus = 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed';
export type CaptureTaskKind = 'start' | 'finish';

/** Estado ligero consultable mientras una captura recorre archivos y registro. */
export interface CaptureTask {
  taskId: string;
  kind: CaptureTaskKind;
  status: CaptureTaskStatus;
  phase: string;
  message: string;
  rootsTotal: number;
  rootsCompleted: number;
  currentRoot: string | null;
  currentPath: string | null;
  entriesVisited: number;
  filesFound: number;
  registryRootsTotal: number;
  registryRootsCompleted: number;
  currentRegistryRoot: string | null;
  startedAt: string;
  updatedAt: string;
  error?: string;
  result?: {
    snapshotId?: string;
    diffId?: string;
    filesAdded?: number;
    filesModified?: number;
    filesRemoved?: number;
    registryAdded?: number;
    registryModified?: number;
    registryRemoved?: number;
  };
}