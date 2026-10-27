import { Notice, Plugin } from "obsidian";
import { YandexDiskSyncSettingTab } from "./settings-tab";
import { SyncEngine } from "./sync-engine";
import { createProgressView, normalizeProgressStyle, progressSummary } from "./progress-view";
import { normalizeSyncInterval, normalizeSyncMode } from "./sync-settings";
import type {
  PluginSettings,
  PluginState,
  ProgressStyle,
  SyncMode,
  SyncProgress,
  SyncStats
} from "./types";
import { makeDeviceId } from "./utils";

type SyncTrigger = "manual" | "periodic";

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
  syncMode: "manual",
  syncIntervalMinutes: 5,
  concurrency: 4,
  showProgressNotice: true,
  progressStyle: "bar",
  excludePrefixes: [".obsidian", ".trash"]
};

export default class YandexDiskSyncPlugin extends Plugin {
  settings: PluginSettings = { ...DEFAULT_SETTINGS };
  state: PluginState = this.newState();

  private periodicTimer: number | null = null;
  private nextSyncAt: number | null = null;
  private unloaded = false;
  private layoutReady = false;
  private syncing = false;
  private statusEl: HTMLElement | null = null;
  private progressNotice: Notice | null = null;
  private lastProgressPaint = 0;
  private lastProgress: SyncProgress | null = null;

  async onload(): Promise<void> {
    await this.loadPluginData();
    if (this.unloaded) return;
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
    this.setIdleStatus();

    this.app.workspace.onLayoutReady(() => {
      if (this.unloaded) return;
      this.layoutReady = true;
      this.registerDomEvent(document, "visibilitychange", () => {
        if (document.visibilityState === "visible") this.syncAfterResume();
      });
      this.registerDomEvent(window, "focus", () => this.syncAfterResume());
      this.configurePeriodicSync();
    });
  }

  onunload(): void {
    this.unloaded = true;
    this.clearSyncTimer();
    this.progressNotice?.hide();
  }

  configurePeriodicSync(): void {
    this.clearSyncTimer();
    if (this.unloaded || !this.layoutReady || this.settings.syncMode !== "scheduled") return;
    const minutes = this.settings.syncIntervalMinutes;
    if (!this.settings.oauthToken || this.syncing) return;
    this.nextSyncAt = Date.now() + minutes * 60 * 1000;
    this.periodicTimer = window.setTimeout(
      () => void this.syncNow("periodic"),
      minutes * 60 * 1000
    );
  }

  async setSyncMode(mode: SyncMode): Promise<void> {
    this.settings.syncMode = mode;
    this.configurePeriodicSync();
    if (!this.syncing) this.setIdleStatus();
    await this.savePluginData();
  }

  private clearSyncTimer(): void {
    if (this.periodicTimer !== null) window.clearTimeout(this.periodicTimer);
    this.periodicTimer = null;
    this.nextSyncAt = null;
  }

  async savePluginData(): Promise<void> {
    await this.saveData({ settings: this.settings, state: this.state });
  }

  async setProgressStyle(style: ProgressStyle): Promise<void> {
    this.settings.progressStyle = style;
    if (this.progressNotice && this.lastProgress) {
      this.updateProgress(this.lastProgress, true);
    }
    await this.savePluginData();
  }

  private async loadPluginData(): Promise<void> {
    const stored = (await this.loadData()) as StoredData | null;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(stored?.settings ?? {}),
      concurrency: this.clamp(stored?.settings?.concurrency ?? 4, 1, 8),
      progressStyle: normalizeProgressStyle(stored?.settings?.progressStyle),
      syncMode: stored?.settings
        ? normalizeSyncMode(stored.settings.syncMode, stored.settings.syncIntervalMinutes ?? 5)
        : DEFAULT_SETTINGS.syncMode,
      syncIntervalMinutes: normalizeSyncInterval(stored?.settings?.syncIntervalMinutes),
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

  private syncAfterResume(): void {
    if (this.settings.syncMode !== "scheduled" || this.nextSyncAt === null) return;
    if (Date.now() >= this.nextSyncAt) void this.syncNow("periodic");
  }

  private async syncNow(trigger: SyncTrigger): Promise<void> {
    if (this.unloaded || (trigger !== "manual" && this.settings.syncMode !== "scheduled")) return;
    if (!this.settings.oauthToken) {
      if (trigger === "manual") {
        new Notice("Укажи OAuth-токен Яндекс.Диска в настройках плагина.");
      }
      return;
    }
    if (this.syncing) {
      if (trigger === "manual") new Notice("Синхронизация уже выполняется.");
      return;
    }

    this.clearSyncTimer();
    this.syncing = true;
    try {
      if (this.state.remoteRoot !== this.settings.remoteRoot) {
        this.state.files = Object.create(null) as PluginState["files"];
        this.state.remoteRoot = this.settings.remoteRoot;
        await this.savePluginData();
      }
      this.lastProgressPaint = 0;
      this.lastProgress = null;
      if (this.settings.showProgressNotice || trigger === "manual") {
        this.progressNotice = new Notice("Yandex Sync: подготовка…", 0);
      }
      const stats = await new SyncEngine(
        this.app,
        this.settings,
        this.state,
        () => undefined,
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
    } finally {
      this.syncing = false;
      this.configurePeriodicSync();
    }
  }

  private updateProgress(progress: SyncProgress, force = false): void {
    this.lastProgress = progress;
    const { phase, percent } = progressSummary(progress);
    const counter = percent === undefined ? "..." : `${percent}%`;
    this.setStatus(`Yandex Sync: ${phase} ${counter}`);

    const now = Date.now();
    if (this.progressNotice && (force || now - this.lastProgressPaint > 120 || progress.phase === "done")) {
      this.progressNotice.setMessage(
        createProgressView(progress, this.settings.progressStyle)
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

  private setIdleStatus(): void {
    this.setStatus(this.settings.syncMode === "manual"
      ? "Yandex Sync: вручную"
      : `Yandex Sync: каждые ${this.settings.syncIntervalMinutes} мин`);
  }

  private setStatus(text: string): void {
    this.statusEl?.setText(text);
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
