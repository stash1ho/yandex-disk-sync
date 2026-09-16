import { App, normalizePath, TFile } from "obsidian";
import type {
  FileState,
  LocalEntry,
  PluginSettings,
  PluginState,
  ProgressCallback,
  RemoteEntry,
  SyncProgress,
  SyncStats
} from "./types";
import { joinRemotePath, mapLimit, sha256 } from "./utils";
import { YandexDiskClient } from "./yandex-client";

const CHECKPOINT_MULTIPLIER = 5;

class LocalFileChangedError extends Error {
  constructor(path: string) {
    super(`Файл изменился во время синхронизации: ${path}. Он будет обработан повторно.`);
  }
}

export class SyncEngine {
  private readonly client: YandexDiskClient;
  private readonly remoteHashCache = new Map<string, Promise<string>>();
  private progress: SyncProgress;

  constructor(
    private readonly app: App,
    private readonly settings: PluginSettings,
    private readonly state: PluginState,
    private readonly setSuppressEvents: (value: boolean) => void,
    private readonly onProgress: ProgressCallback,
    private readonly checkpoint: () => Promise<void>
  ) {
    this.client = new YandexDiskClient(settings.oauthToken);
    this.progress = {
      phase: "local-scan",
      completed: 0,
      total: 0,
      stats: this.emptyStats()
    };
  }

  async sync(): Promise<SyncStats> {
    const lockOwner = `${this.state.deviceId}:${Date.now().toString(36)}`;
    const lock = await this.client.acquireLock(this.settings.remoteRoot, lockOwner);
    try {
      this.emitProgress("local-scan", 0, 0);
      const localFiles = this.buildLocalIndex();

      this.emitProgress("remote-scan", 0, 0);
      const remoteFiles = await this.client.listFiles(
        this.settings.remoteRoot,
        this.settings.concurrency
      );

      const paths = [...new Set([
        ...localFiles.keys(),
        ...remoteFiles.keys(),
        ...Object.keys(this.state.files)
      ])].sort();

      const stats = this.emptyStats();
      this.progress.stats = stats;
      this.emitProgress("sync", 0, paths.length);

      const checkpointSize = Math.max(
        this.settings.concurrency,
        this.settings.concurrency * CHECKPOINT_MULTIPLIER
      );
      let completed = 0;
      for (let offset = 0; offset < paths.length; offset += checkpointSize) {
        const chunk = paths.slice(offset, offset + checkpointSize);
        await mapLimit(chunk, this.settings.concurrency, async (path) => {
          try {
            await this.reconcilePath(path, localFiles, remoteFiles, stats);
          } catch (error) {
            stats.failed++;
            console.error(`[Yandex Disk Sync] ${path}`, error);
          } finally {
            completed++;
            this.emitProgress("sync", completed, paths.length, path);
          }
        });
        await this.checkpoint();
      }

      this.state.lastSyncAt = Date.now();
      await this.checkpoint();
      this.emitProgress("done", paths.length, paths.length);
      return stats;
    } finally {
      await this.client.releaseLock(this.settings.remoteRoot, lock);
    }
  }

  private buildLocalIndex(): Map<string, LocalEntry> {
    const result = new Map<string, LocalEntry>();
    const files = this.app.vault.getFiles().filter((file) => this.shouldSync(file.path));
    for (const file of files) {
      result.set(file.path, {
        file,
        mtime: file.stat.mtime,
        size: file.stat.size
      });
    }
    return result;
  }

  private shouldSync(path: string): boolean {
    const normalized = normalizePath(path);
    return !this.settings.excludePrefixes.some((prefix) => {
      const excluded = normalizePath(prefix).replace(/\/$/, "");
      return normalized === excluded || normalized.startsWith(`${excluded}/`);
    });
  }

  private async reconcilePath(
    path: string,
    localFiles: Map<string, LocalEntry>,
    remoteFiles: Map<string, RemoteEntry>,
    stats: SyncStats
  ): Promise<void> {
    const local = localFiles.get(path);
    const remote = remoteFiles.get(path);
    const localHash = local ? await this.getLocalHash(path, local) : undefined;
    const remoteHash = remote ? await this.getRemoteHash(remote) : undefined;
    const baseHash = this.state.files[path]?.baseHash;

    if (local && remote && localHash && remoteHash && localHash === remoteHash) {
      this.remember(path, localHash, local, remote);
      stats.unchanged++;
      return;
    }

    if (!baseHash) {
      if (local && !remote) {
        const uploaded = await this.uploadCurrentLocal(path);
        if (uploaded) {
          this.state.files[path] = uploaded;
          stats.uploaded++;
        }
        return;
      }
      if (!local && remote) {
        const downloaded = await this.downloadWithoutOverwrite(path, remote);
        this.state.files[path] = downloaded;
        stats.downloaded++;
        return;
      }
      if (local && remote) {
        this.state.files[path] = await this.resolveConflict(path, remote, stats);
      }
      return;
    }

    const localChanged = localHash !== baseHash;
    const remoteChanged = remoteHash !== baseHash;

    if (!localChanged && !remoteChanged) {
      stats.unchanged++;
      return;
    }

    if (localChanged && !remoteChanged) {
      if (local) {
        if (remote && !(await this.remoteStillMatches(remote, remoteHash))) {
          const currentRemote = await this.currentRemoteEntry(path);
          if (currentRemote) {
            this.state.files[path] = await this.resolveConflict(path, currentRemote, stats);
            return;
          }
        }
        const uploaded = await this.uploadCurrentLocal(path);
        if (uploaded) {
          this.state.files[path] = uploaded;
          stats.uploaded++;
        }
      } else if (remote) {
        if (await this.remoteStillMatches(remote, remoteHash)) {
          await this.client.delete(remote.remotePath, false);
          delete this.state.files[path];
          stats.deletedRemote++;
        } else {
          const currentRemote = await this.currentRemoteEntry(path);
          if (currentRemote) {
            this.state.files[path] = await this.downloadWithoutOverwrite(path, currentRemote);
            stats.downloaded++;
          }
        }
      }
      return;
    }

    if (!localChanged && remoteChanged) {
      if (remote) {
        if (local && !(await this.localStillMatches(path, localHash))) {
          this.state.files[path] = await this.resolveConflict(path, remote, stats);
          return;
        }
        this.state.files[path] = await this.downloadReplacingSnapshot(
          path,
          remote,
          localHash
        );
        stats.downloaded++;
      } else if (local) {
        if (await this.localStillMatches(path, localHash)) {
          await this.deleteLocal(path);
          delete this.state.files[path];
          stats.deletedLocal++;
        } else {
          const uploaded = await this.uploadCurrentLocal(path);
          if (uploaded) {
            this.state.files[path] = uploaded;
            stats.uploaded++;
            stats.conflicts++;
          }
        }
      }
      return;
    }

    if (!local && !remote) {
      delete this.state.files[path];
      return;
    }
    if (local && !remote) {
      const uploaded = await this.uploadCurrentLocal(path);
      if (uploaded) {
        this.state.files[path] = uploaded;
        stats.uploaded++;
        stats.conflicts++;
      }
      return;
    }
    if (!local && remote) {
      this.state.files[path] = await this.downloadWithoutOverwrite(path, remote);
      stats.downloaded++;
      stats.conflicts++;
      return;
    }
    if (remote) this.state.files[path] = await this.resolveConflict(path, remote, stats);
  }

  private async getLocalHash(path: string, entry: LocalEntry): Promise<string> {
    if (entry.hash) return entry.hash;
    const cached = this.state.files[path];
    if (
      cached?.localHash &&
      cached.localMtime === entry.mtime &&
      cached.localSize === entry.size
    ) {
      entry.hash = cached.localHash;
      return entry.hash;
    }
    const data = await this.app.vault.readBinary(entry.file);
    entry.hash = await sha256(data);
    return entry.hash;
  }

  private getRemoteHash(entry: RemoteEntry): Promise<string> {
    const cacheKey = [
      entry.remotePath,
      entry.sha256 ?? "",
      entry.modified ?? "",
      String(entry.size)
    ].join("|");
    const existing = this.remoteHashCache.get(cacheKey);
    if (existing) return existing;
    const pending = this.client.getRemoteHash(entry);
    this.remoteHashCache.set(cacheKey, pending);
    return pending;
  }

  private async readStableLocal(path: string): Promise<{
    file: TFile;
    data: ArrayBuffer;
    hash: string;
    mtime: number;
    size: number;
  } | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const file = this.app.vault.getFileByPath(path);
      if (!file) return null;
      const before = { mtime: file.stat.mtime, size: file.stat.size };
      const data = await this.app.vault.readBinary(file);
      const current = this.app.vault.getFileByPath(path);
      if (
        current &&
        current.stat.mtime === before.mtime &&
        current.stat.size === before.size
      ) {
        return {
          file: current,
          data,
          hash: await sha256(data),
          mtime: before.mtime,
          size: before.size
        };
      }
    }
    throw new LocalFileChangedError(path);
  }

  private async uploadCurrentLocal(path: string): Promise<FileState | null> {
    const snapshot = await this.readStableLocal(path);
    if (!snapshot) return null;
    await this.client.upload(this.remotePath(path), snapshot.data, true);
    return {
      baseHash: snapshot.hash,
      localHash: snapshot.hash,
      localMtime: snapshot.mtime,
      localSize: snapshot.size,
      remoteSize: snapshot.size
    };
  }

  private async downloadWithoutOverwrite(
    path: string,
    remote: RemoteEntry
  ): Promise<FileState> {
    if (this.app.vault.getFileByPath(path)) {
      return this.resolveConflict(path, remote, this.progress.stats);
    }
    const data = await this.client.download(remote.remotePath);
    const hash = await sha256(data);
    await this.writeLocal(path, data);
    return this.localStateAfterWrite(path, hash, remote);
  }

  private async downloadReplacingSnapshot(
    path: string,
    remote: RemoteEntry,
    expectedLocalHash: string | undefined
  ): Promise<FileState> {
    if (!(await this.localStillMatches(path, expectedLocalHash))) {
      return this.resolveConflict(path, remote, this.progress.stats);
    }
    const data = await this.client.download(remote.remotePath);
    if (!(await this.localStillMatches(path, expectedLocalHash))) {
      return this.resolveConflict(path, remote, this.progress.stats, data);
    }
    const hash = await sha256(data);
    await this.writeLocal(path, data);
    return this.localStateAfterWrite(path, hash, remote);
  }

  private async resolveConflict(
    path: string,
    remote: RemoteEntry,
    stats: SyncStats,
    downloadedRemote?: ArrayBuffer
  ): Promise<FileState> {
    const local = await this.readStableLocal(path);
    if (!local) {
      const data = downloadedRemote ?? (await this.client.download(remote.remotePath));
      const hash = await sha256(data);
      await this.writeLocal(path, data);
      stats.downloaded++;
      return this.localStateAfterWrite(path, hash, remote);
    }

    const remoteData = downloadedRemote ?? (await this.client.download(remote.remotePath));
    const conflictPath = this.makeConflictPath(path);
    await this.writeLocal(conflictPath, remoteData);
    await this.client.upload(this.remotePath(conflictPath), remoteData, true);
    await this.client.upload(this.remotePath(path), local.data, true);
    stats.conflicts++;
    stats.uploaded++;
    return {
      baseHash: local.hash,
      localHash: local.hash,
      localMtime: local.mtime,
      localSize: local.size,
      remoteSize: local.size
    };
  }

  private async localStillMatches(path: string, expectedHash?: string): Promise<boolean> {
    if (!expectedHash) return this.app.vault.getFileByPath(path) === null;
    const snapshot = await this.readStableLocal(path);
    return snapshot?.hash === expectedHash;
  }

  private async remoteStillMatches(
    snapshot: RemoteEntry,
    expectedHash?: string
  ): Promise<boolean> {
    if (!expectedHash) return false;
    const current = await this.currentRemoteEntry(snapshot.relativePath);
    return current ? (await this.getRemoteHash(current)) === expectedHash : false;
  }

  private async currentRemoteEntry(path: string): Promise<RemoteEntry | null> {
    const remotePath = this.remotePath(path);
    const resource = await this.client.getResource(remotePath);
    if (!resource || resource.type !== "file") return null;
    return {
      relativePath: path,
      remotePath,
      sha256: resource.sha256,
      size: resource.size ?? 0,
      modified: resource.modified
    };
  }

  private async writeLocal(path: string, data: ArrayBuffer): Promise<void> {
    this.setSuppressEvents(true);
    try {
      await this.ensureLocalParent(path);
      const existing = this.app.vault.getFileByPath(path);
      if (existing) await this.app.vault.modifyBinary(existing, data);
      else await this.app.vault.createBinary(path, data);
    } finally {
      this.setSuppressEvents(false);
    }
  }

  private async deleteLocal(path: string): Promise<void> {
    const file = this.app.vault.getFileByPath(path);
    if (!file) return;
    this.setSuppressEvents(true);
    try {
      await this.app.fileManager.trashFile(file);
    } finally {
      this.setSuppressEvents(false);
    }
  }

  private async ensureLocalParent(path: string): Promise<void> {
    const segments = normalizePath(path).split("/");
    if (segments.length <= 1) return;
    let current = "";
    for (const segment of segments.slice(0, -1)) {
      current = current ? `${current}/${segment}` : segment;
      if (!this.app.vault.getFolderByPath(current)) {
        try {
          await this.app.vault.createFolder(current);
        } catch (error) {
          if (!this.app.vault.getFolderByPath(current)) throw error;
        }
      }
    }
  }

  private localStateAfterWrite(
    path: string,
    hash: string,
    remote: RemoteEntry
  ): FileState {
    const file = this.app.vault.getFileByPath(path);
    return {
      baseHash: hash,
      localHash: hash,
      localMtime: file?.stat.mtime,
      localSize: file?.stat.size,
      remoteModified: remote.modified,
      remoteSize: remote.size
    };
  }

  private remember(
    path: string,
    hash: string,
    local: LocalEntry,
    remote: RemoteEntry
  ): void {
    this.state.files[path] = {
      baseHash: hash,
      localHash: hash,
      localMtime: local.mtime,
      localSize: local.size,
      remoteModified: remote.modified,
      remoteSize: remote.size
    };
  }

  private remotePath(path: string): string {
    return joinRemotePath(this.settings.remoteRoot, path);
  }

  private makeConflictPath(path: string): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const device = this.state.deviceId.slice(0, 8);
    const separator = path.lastIndexOf("/");
    const directory = separator >= 0 ? path.slice(0, separator + 1) : "";
    const filename = separator >= 0 ? path.slice(separator + 1) : path;
    const extension = filename.lastIndexOf(".");
    return extension <= 0
      ? `${directory}${filename}.remote-conflict-${device}-${timestamp}`
      : `${directory}${filename.slice(0, extension)}.remote-conflict-${device}-${timestamp}${filename.slice(extension)}`;
  }

  private emitProgress(
    phase: SyncProgress["phase"],
    completed: number,
    total: number,
    currentPath?: string
  ): void {
    this.progress = {
      phase,
      completed,
      total,
      currentPath,
      stats: this.progress.stats
    };
    this.onProgress(this.progress);
  }

  private emptyStats(): SyncStats {
    return {
      uploaded: 0,
      downloaded: 0,
      deletedLocal: 0,
      deletedRemote: 0,
      conflicts: 0,
      unchanged: 0,
      failed: 0
    };
  }
}
