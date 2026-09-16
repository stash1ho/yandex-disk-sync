import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from "obsidian";
import type { LockHandle, RemoteEntry } from "./types";
import { delay, joinRemotePath, mapLimit, sha256, validateRemotePath } from "./utils";

const API_ROOT = "https://cloud-api.yandex.net/v1/disk";
const LOCK_FOLDER = ".sync-lock";
const LOCK_OWNER_FILE = "owner.json";
const LOCK_TTL_MS = 5 * 60 * 1000;
const LOCK_HEARTBEAT_MS = 30 * 1000;
const MAX_RETRIES = 4;

interface YandexResource {
  name: string;
  type: "file" | "dir";
  sha256?: string;
  size?: number;
  modified?: string;
  created?: string;
  _embedded?: {
    items: YandexResource[];
    total: number;
  };
}

interface LockDocument {
  owner: string;
  updatedAt: number;
}

interface FolderListing {
  files: RemoteEntry[];
  folders: Array<{ remotePath: string; relativePath: string }>;
}

export class YandexDiskClient {
  private readonly knownFolders = new Set<string>();
  private readonly pendingFolders = new Map<string, Promise<void>>();

  constructor(private readonly token: string) {}

  private headers(): Record<string, string> {
    return { Authorization: `OAuth ${this.token}` };
  }

  private resourceUrl(path: string, extra: Record<string, string> = {}): string {
    const params = new URLSearchParams({ path, ...extra });
    return `${API_ROOT}/resources?${params.toString()}`;
  }

  private async requestWithRetry(
    request: RequestUrlParam,
    operation: string
  ): Promise<RequestUrlResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await requestUrl({ ...request, throw: false });
        if (response.status !== 429 && response.status < 500) return response;
        lastError = new Error(`${operation}: HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
      }

      if (attempt < MAX_RETRIES) {
        const backoff = Math.min(30_000, 1_000 * 2 ** attempt) + Math.random() * 500;
        await delay(backoff);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`${operation}: ошибка сети`);
  }

  async testConnection(root: string): Promise<boolean> {
    const safeRoot = validateRemotePath(root);
    await this.ensureFolder(safeRoot);
    const resource = await this.getResource(safeRoot);
    return resource?.type === "dir";
  }

  async ensureFolder(path: string): Promise<void> {
    if (this.knownFolders.has(path)) return;
    const pending = this.pendingFolders.get(path);
    if (pending) return pending;
    const operation = this.ensureFolderUncached(path);
    this.pendingFolders.set(path, operation);
    try {
      await operation;
      this.knownFolders.add(path);
    } finally {
      this.pendingFolders.delete(path);
    }
  }

  private async ensureFolderUncached(path: string): Promise<void> {
    const response = await this.requestWithRetry(
      {
        url: this.resourceUrl(path),
        method: "PUT",
        headers: this.headers()
      },
      `Создание папки ${path}`
    );
    if (response.status !== 201 && response.status !== 409) {
      throw new Error(`Не удалось создать папку ${path} (HTTP ${response.status})`);
    }
    if (response.status === 409) {
      const existing = await this.getResource(path);
      if (existing && existing.type !== "dir") {
        throw new Error(`${path} существует, но не является папкой`);
      }
    }
  }

  async getResource(path: string): Promise<YandexResource | null> {
    const response = await this.requestWithRetry(
      { url: this.resourceUrl(path), headers: this.headers() },
      `Получение метаданных ${path}`
    );
    if (response.status === 404) return null;
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Не удалось получить метаданные ${path} (HTTP ${response.status})`);
    }
    return response.json as YandexResource;
  }

  async listFiles(root: string, concurrency: number): Promise<Map<string, RemoteEntry>> {
    const safeRoot = validateRemotePath(root);
    await this.ensureFolder(safeRoot);
    const result = new Map<string, RemoteEntry>();
    let frontier = [{ remotePath: safeRoot, relativePath: "" }];

    while (frontier.length > 0) {
      const listings = await mapLimit(frontier, concurrency, (folder) =>
        this.listFolder(folder.remotePath, folder.relativePath)
      );
      const nextFrontier: typeof frontier = [];
      for (const listing of listings) {
        for (const file of listing.files) result.set(file.relativePath, file);
        nextFrontier.push(...listing.folders);
      }
      frontier = nextFrontier;
    }
    return result;
  }

  private async listFolder(remotePath: string, relativePath: string): Promise<FolderListing> {
    const files: RemoteEntry[] = [];
    const folders: FolderListing["folders"] = [];
    const limit = 1000;
    let offset = 0;

    while (true) {
      const response = await this.requestWithRetry(
        {
          url: this.resourceUrl(remotePath, {
            limit: String(limit),
            offset: String(offset)
          }),
          headers: this.headers()
        },
        `Чтение папки ${remotePath}`
      );
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Не удалось прочитать ${remotePath} (HTTP ${response.status})`);
      }

      const embedded = (response.json as YandexResource)._embedded;
      if (!embedded) break;
      for (const item of embedded.items) {
        if (item.name === LOCK_FOLDER) continue;
        const childRelative = relativePath
          ? `${relativePath}/${item.name}`
          : item.name;
        const childRemote = joinRemotePath(remotePath, item.name);
        if (item.type === "dir") {
          folders.push({ remotePath: childRemote, relativePath: childRelative });
        } else {
          files.push({
            relativePath: childRelative,
            remotePath: childRemote,
            sha256: item.sha256,
            size: item.size ?? 0,
            modified: item.modified
          });
        }
      }

      offset += embedded.items.length;
      if (offset >= embedded.total || embedded.items.length === 0) break;
    }
    return { files, folders };
  }

  async getRemoteHash(entry: RemoteEntry): Promise<string> {
    if (entry.sha256) return entry.sha256.toLowerCase();
    return sha256(await this.download(entry.remotePath));
  }

  async download(path: string): Promise<ArrayBuffer> {
    const linkResponse = await this.requestWithRetry(
      {
        url: `${API_ROOT}/resources/download?${new URLSearchParams({ path }).toString()}`,
        headers: this.headers()
      },
      `Получение ссылки на скачивание ${path}`
    );
    if (linkResponse.status < 200 || linkResponse.status >= 300) {
      throw new Error(`Не удалось получить ссылку на ${path} (HTTP ${linkResponse.status})`);
    }
    const href = (linkResponse.json as { href: string }).href;
    const response = await this.requestWithRetry(
      { url: href },
      `Скачивание ${path}`
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Не удалось скачать ${path} (HTTP ${response.status})`);
    }
    return response.arrayBuffer;
  }

  async upload(path: string, data: ArrayBuffer, overwrite = true): Promise<boolean> {
    await this.ensureParentFolders(path);
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const linkResponse = await this.requestWithRetry(
        {
          url: `${API_ROOT}/resources/upload?${new URLSearchParams({
            path,
            overwrite: String(overwrite)
          }).toString()}`,
          headers: this.headers()
        },
        `Получение ссылки на загрузку ${path}`
      );
      if (linkResponse.status === 409 && !overwrite) return false;
      if (linkResponse.status < 200 || linkResponse.status >= 300) {
        throw new Error(`Не удалось получить ссылку загрузки ${path} (HTTP ${linkResponse.status})`);
      }

      try {
        const href = (linkResponse.json as { href: string }).href;
        const response = await requestUrl({
          url: href,
          method: "PUT",
          body: data,
          throw: false
        });
        if (response.status === 409 && !overwrite) return false;
        if (response.status >= 200 && response.status < 300) return true;
        if (response.status !== 429 && response.status < 500) {
          throw new Error(`Не удалось загрузить ${path} (HTTP ${response.status})`);
        }
      } catch (error) {
        if (attempt === MAX_RETRIES) throw error;
      }

      if (attempt < MAX_RETRIES) await delay(Math.min(30_000, 1_000 * 2 ** attempt));
    }
    throw new Error(`Не удалось загрузить ${path}`);
  }

  async delete(path: string, permanently = false): Promise<void> {
    const response = await this.requestWithRetry(
      {
        url: this.resourceUrl(path, { permanently: String(permanently) }),
        method: "DELETE",
        headers: this.headers()
      },
      `Удаление ${path}`
    );
    if (response.status !== 404 && (response.status < 200 || response.status >= 300)) {
      throw new Error(`Не удалось удалить ${path} (HTTP ${response.status})`);
    }
  }

  async acquireLock(root: string, owner: string): Promise<LockHandle> {
    const safeRoot = validateRemotePath(root);
    await this.ensureFolder(safeRoot);
    const lockPath = joinRemotePath(safeRoot, LOCK_FOLDER);

    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await this.requestWithRetry(
        {
          url: this.resourceUrl(lockPath),
          method: "PUT",
          headers: this.headers()
        },
        "Создание блокировки"
      );

      if (response.status === 201) {
        this.knownFolders.add(lockPath);
        await this.writeLockOwner(lockPath, owner);
        const heartbeat = window.setInterval(() => {
          void this.writeLockOwner(lockPath, owner).catch(() => undefined);
        }, LOCK_HEARTBEAT_MS);
        return {
          owner,
          stopHeartbeat: () => window.clearInterval(heartbeat)
        };
      }
      if (response.status !== 409) {
        throw new Error(`Не удалось создать блокировку (HTTP ${response.status})`);
      }

      const document = await this.readLockOwner(lockPath);
      const fallback = await this.getResource(lockPath);
      const timestamp = document?.updatedAt ?? this.resourceTimestamp(fallback);
      if (timestamp && Date.now() - timestamp <= LOCK_TTL_MS) {
        throw new Error("Другой клиент уже выполняет синхронизацию.");
      }

      await this.delete(lockPath, true);
      await delay(800);
    }
    throw new Error("Не удалось получить блокировку синхронизации.");
  }

  async releaseLock(root: string, handle: LockHandle): Promise<void> {
    handle.stopHeartbeat();
    const lockPath = joinRemotePath(validateRemotePath(root), LOCK_FOLDER);
    try {
      const current = await this.readLockOwner(lockPath);
      if (current?.owner === handle.owner) await this.delete(lockPath, true);
    } catch {
      // An expired lock is safe: only its owner is allowed to remove it.
    }
  }

  private async writeLockOwner(lockPath: string, owner: string): Promise<void> {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ owner, updatedAt: Date.now() } satisfies LockDocument)
    );
    await this.upload(
      joinRemotePath(lockPath, LOCK_OWNER_FILE),
      bytes.buffer as ArrayBuffer,
      true
    );
  }

  private async readLockOwner(lockPath: string): Promise<LockDocument | null> {
    try {
      const data = await this.download(joinRemotePath(lockPath, LOCK_OWNER_FILE));
      const parsed = JSON.parse(new TextDecoder().decode(data)) as Partial<LockDocument>;
      return typeof parsed.owner === "string" && typeof parsed.updatedAt === "number"
        ? { owner: parsed.owner, updatedAt: parsed.updatedAt }
        : null;
    } catch {
      return null;
    }
  }

  private resourceTimestamp(resource: YandexResource | null): number | undefined {
    const value = resource?.modified ?? resource?.created;
    if (!value) return undefined;
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : undefined;
  }

  private async ensureParentFolders(path: string): Promise<void> {
    const safePath = validateRemotePath(path);
    const match = safePath.match(/^([a-zA-Z]+):\/(.*)$/);
    if (!match) return;
    const segments = match[2].split("/").filter(Boolean);
    if (segments.length <= 1) return;
    let current = `${match[1]}:/`;
    for (const segment of segments.slice(0, -1)) {
      current = joinRemotePath(current, segment);
      await this.ensureFolder(current);
    }
  }
}
