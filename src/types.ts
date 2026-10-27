import type { TFile } from "obsidian";

export type ProgressStyle = "bar" | "text" | "circle";
export type SyncMode = "manual" | "scheduled";

export interface PluginSettings {
  oauthToken: string;
  remoteRoot: string;
  syncMode: SyncMode;
  syncIntervalMinutes: number;
  concurrency: number;
  showProgressNotice: boolean;
  progressStyle: ProgressStyle;
  excludePrefixes: string[];
}

export interface FileState {
  baseHash: string;
  localHash?: string;
  localMtime?: number;
  localSize?: number;
  remoteModified?: string;
  remoteSize?: number;
}

export interface PluginState {
  version: 2;
  deviceId: string;
  files: Record<string, FileState>;
  lastSyncAt?: number;
  remoteRoot?: string;
}

export interface LocalEntry {
  file: TFile;
  mtime: number;
  size: number;
  hash?: string;
}

export interface RemoteEntry {
  relativePath: string;
  remotePath: string;
  sha256?: string;
  size: number;
  modified?: string;
}

export interface SyncStats {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: number;
  unchanged: number;
  failed: number;
}

export type SyncPhase = "local-scan" | "remote-scan" | "sync" | "done";

export interface SyncProgress {
  phase: SyncPhase;
  completed: number;
  total: number;
  currentPath?: string;
  stats: SyncStats;
}

export type ProgressCallback = (progress: SyncProgress) => void;

export interface LockHandle {
  owner: string;
  stopHeartbeat: () => void;
}
