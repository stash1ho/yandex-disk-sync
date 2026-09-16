import { Notice, Plugin, normalizePath } from "obsidian";
import { YandexDiskSyncSettingTab } from "./settings-tab";
import { SyncEngine } from "./sync-engine";
import type {
  PluginSettings,
  PluginState,
  SyncProgress,
  SyncStats
} from "./types";
import { makeDeviceId } from "./utils";

type SyncTrigger = "manual" | "startup" | "debounce" | "periodic" | "resume";

interface StoredData {
  settings?: Partial<PluginSettings>;
  state?: Partial<PluginState> & {
    version?: number;
    files?: Record<string, { baseHash: string }>;
  };
}

const DEFAULT_SETTINGS: PluginSettings = {
  oauthToken: "",
  remoteRoot: "app:/vault",
  debounceSeconds: 10,
  syncOnStartup: true,
  syncIntervalMinutes: 5,
  concurrency: 4,
  showProgressNotice: true,
  excludePrefixes: [".obsidian", ".trash"]
};

export default class YandexDiskSyncPlugin extends Plugin {
  settings: PluginSettings = { ...DEFAULT_SETTINGS };
  state: PluginState = this.newState();

  private debounceTimer: number | null = null;
  private periodicTimer: number | null = null;
  private suppressEventDepth = 0;
  private syncing = false;
  private syncRequestedWhileBusy = false;
  private statusEl: HTMLElement | null = null;
  private progressNotice: Notice | null = null;
  private lastProgressPaint = 0;

  async onload(): Promise<void> {
    await this.loadPluginData();
    this.addSettingTab(new YandexDiskSyncSettingTab(this));
    this.addRibbonIcon(
      "refresh-cw",
      "Синхронизировать с Яндекс.Диском",
      () => void this.syncNow("manual")
    );
    this.addCommand({
      id: "sync-now",
      name: "Синхронизировать сейчас",
      callback: () => void this.syncNow("manual")
    });
    this.statusEl = this.addStatusBarItem();
    this.setStatus("Yandex Sync: готов");

    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(
        this.app.workspace.on("editor-change", () => {
          if (!this.eventsSuppressed()) this.scheduleDebouncedSync();
        })
      );
      this.registerEvent(
        this.app.vault.on("modify", (file) => this.onVaultChanged(file.path))
      );
      this.registerEvent(
        this.app.vault.on("create", (file) => this.onVaultChanged(file.path))
      );
      this.registerEvent(
        this.app.vault.on("delete", (file) => this.onVaultChanged(file.path))
      );
      this.registerEvent(
        this.app.vault.on("rename", (file) => this.onVaultChanged(file.path))
      );
      this.registerDomEvent(document, "visibilitychange", () => {
        if (document.visibilityState === "visible") this.syncAfterResume();
      });
      this.registerDomEvent(window, "focus", () => this.syncAfterResume());
      this.configurePeriodicSync();

      if (this.settings.syncOnStartup && this.settings.oauthToken) {
        window.setTimeout(() => void this.syncNow("startup"), 1200);
      }
    });
  }

  onunload(): void {
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    if (this.periodicTimer !== null) window.clearInterval(this.periodicTimer);
    this.progressNotice?.hide();
  }

  configurePeriodicSync(): void {
    if (this.periodicTimer !== null) {
      window.clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
    const minutes = this.settings.syncIntervalMinutes;
    if (!this.settings.oauthToken || minutes <= 0) return;
    this.periodicTimer = window.setInterval(
      () => void this.syncNow("periodic"),
      minutes * 60 * 1000
    );
    this.registerInterval(this.periodicTimer);
  }

  async savePluginData(): Promise<void> {
    await this.saveData({ settings: this.settings, state: this.state });
  }

  private async loadPluginData(): Promise<void> {
    const stored = (await this.loadData()) as StoredData | null;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(stored?.settings ?? {}),
      concurrency: this.clamp(stored?.settings?.concurrency ?? 4, 1, 8),
      excludePrefixes: [...new Set([
        ".obsidian",
        ...(stored?.settings?.excludePrefixes ?? DEFAULT_SETTINGS.excludePrefixes)
      ])]
    };

    const oldState = stored?.state;
    const files = Object.assign(Object.create(null) as PluginState["files"], oldState?.files ?? {});
    this.state = {
      version: 2,
      deviceId: oldState?.deviceId ?? makeDeviceId(),
      files,
      lastSyncAt: oldState?.lastSyncAt,
      remoteRoot: oldState?.remoteRoot ?? this.settings.remoteRoot
    };
  }

  private onVaultChanged(path: string): void {
    if (!this.eventsSuppressed() && !this.isExcluded(path)) {
      this.scheduleDebouncedSync();
    }
  }

  private scheduleDebouncedSync(): void {
    if (!this.settings.oauthToken) return;
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    const delay = this.settings.debounceSeconds * 1000;
    this.setStatus(`Yandex Sync: через ${this.settings.debounceSeconds} с`);
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      void this.syncNow("debounce");
    }, delay);
  }

  private syncAfterResume(): void {
    if (!this.settings.oauthToken || this.syncing) return;
    const lastSync = this.state.lastSyncAt ?? 0;
    if (Date.now() - lastSync > 30_000) void this.syncNow("resume");
  }

  private async syncNow(trigger: SyncTrigger): Promise<void> {
    if (!this.settings.oauthToken) {
      if (trigger === "manual") {
        new Notice("Укажи OAuth-токен Яндекс.Диска в настройках плагина.");
      }
      return;
    }
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.syncing) {
      this.syncRequestedWhileBusy = true;
      return;
    }

    this.syncing = true;
    if (this.state.remoteRoot !== this.settings.remoteRoot) {
      this.state.files = Object.create(null) as PluginState["files"];
      this.state.remoteRoot = this.settings.remoteRoot;
      await this.savePluginData();
    }
    this.lastProgressPaint = 0;
    if (this.settings.showProgressNotice || trigger === "manual") {
      this.progressNotice = new Notice("Yandex Sync: подготовка…", 0);
    }
    try {
      const stats = await new SyncEngine(
        this.app,
        this.settings,
        this.state,
        (value) => this.changeSuppressDepth(value),
        (progress) => this.updateProgress(progress),
        () => this.savePluginData()
      ).sync();
      await this.savePluginData();
      this.setStatus(stats.failed > 0 ? `Yandex Sync: ошибок ${stats.failed}` : "Yandex Sync: ✓");
      this.progressNotice?.hide();
      this.progressNotice = null;
      if (trigger === "manual" || stats.failed > 0) {
        new Notice(this.summaryText(stats), stats.failed > 0 ? 8000 : 5000);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus("Yandex Sync: ошибка");
      this.progressNotice?.hide();
      this.progressNotice = null;
      if (trigger === "manual" || !message.includes("Другой клиент")) {
        new Notice(`Yandex Sync: ${message}`, 8000);
      }
      if (message.includes("Другой клиент")) this.scheduleLockRetry();
    } finally {
      this.syncing = false;
      if (this.syncRequestedWhileBusy) {
        this.syncRequestedWhileBusy = false;
        window.setTimeout(() => void this.syncNow("debounce"), 500);
      }
    }
  }

  private updateProgress(progress: SyncProgress): void {
    const phase = {
      "local-scan": "локальные файлы",
      "remote-scan": "облако",
      sync: "синхронизация",
      done: "готово"
    }[progress.phase];
    const percent = progress.total > 0
      ? Math.round((progress.completed / progress.total) * 100)
      : 0;
    const counter = progress.total > 0
      ? `${progress.completed}/${progress.total} (${percent}%)`
      : "…";
    this.setStatus(`Yandex Sync: ${phase} ${counter}`);

    const now = Date.now();
    if (this.progressNotice && (now - this.lastProgressPaint > 120 || progress.phase === "done")) {
      const barLength = 12;
      const filled = progress.total > 0
        ? Math.round((progress.completed / progress.total) * barLength)
        : 0;
      const bar = `${"█".repeat(filled)}${"░".repeat(barLength - filled)}`;
      const path = progress.currentPath
        ? `\n${this.shortenPath(progress.currentPath)}`
        : "";
      this.progressNotice.setMessage(
        `Yandex Sync: ${phase}\n${bar} ${counter}${path}`
      );
      this.lastProgressPaint = now;
    }
  }

  private summaryText(stats: SyncStats): string {
    return [
      `↑ ${stats.uploaded}`,
      `↓ ${stats.downloaded}`,
      `конфликты ${stats.conflicts}`,
      `удалено локально ${stats.deletedLocal}`,
      `удалено в облаке ${stats.deletedRemote}`,
      `ошибки ${stats.failed}`
    ].join(" · ");
  }

  private changeSuppressDepth(suppress: boolean): void {
    this.suppressEventDepth = suppress
      ? this.suppressEventDepth + 1
      : Math.max(0, this.suppressEventDepth - 1);
  }

  private eventsSuppressed(): boolean {
    return this.suppressEventDepth > 0;
  }

  private isExcluded(path: string): boolean {
    const normalized = normalizePath(path);
    return this.settings.excludePrefixes.some((prefix) => {
      const excluded = normalizePath(prefix).replace(/\/$/, "");
      return normalized === excluded || normalized.startsWith(`${excluded}/`);
    });
  }

  private scheduleLockRetry(): void {
    window.setTimeout(() => {
      if (!this.syncing) void this.syncNow("debounce");
    }, 15_000);
  }

  private setStatus(text: string): void {
    this.statusEl?.setText(text);
  }

  private shortenPath(path: string): string {
    return path.length <= 70 ? path : `…${path.slice(-69)}`;
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, Math.floor(value)));
  }

  private newState(): PluginState {
    return {
      version: 2,
      deviceId: makeDeviceId(),
      files: Object.create(null) as PluginState["files"],
      remoteRoot: DEFAULT_SETTINGS.remoteRoot
    };
  }
}
