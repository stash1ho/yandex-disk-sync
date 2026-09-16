import { Notice, PluginSettingTab, Setting } from "obsidian";
import type YandexDiskSyncPlugin from "./main";
import { validateRemotePath } from "./utils";
import { YandexDiskClient } from "./yandex-client";

export class YandexDiskSyncSettingTab extends PluginSettingTab {
  constructor(private readonly plugin: YandexDiskSyncPlugin) {
    super(plugin.app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("OAuth-токен")
      .setDesc(
        "Токен хранится локально в data.json плагина. Папка .obsidian по умолчанию не синхронизируется."
      )
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("y0_...")
          .setValue(this.plugin.settings.oauthToken)
          .onChange(async (value) => {
            this.plugin.settings.oauthToken = value.trim();
            this.plugin.configurePeriodicSync();
            await this.plugin.savePluginData();
          });
      });

    new Setting(containerEl)
      .setName("Удалённая папка")
      .setDesc("Для приложения с доступом только к своей папке используй app:/vault.")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.remoteRoot)
          .onChange(async (value) => {
            try {
              this.plugin.settings.remoteRoot = validateRemotePath(value || "app:/vault");
              await this.plugin.savePluginData();
            } catch {
              // Keep the last valid path while the user is still typing.
            }
          })
      );

    new Setting(containerEl)
      .setName("Параллельные операции")
      .setDesc(
        "Сколько файлов обрабатывать одновременно. 4 — безопасный баланс для iPhone и компьютера."
      )
      .addSlider((slider) =>
        slider
          .setLimits(1, 8, 1)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.concurrency)
          .onChange(async (value) => {
            this.plugin.settings.concurrency = value;
            await this.plugin.savePluginData();
          })
      );

    new Setting(containerEl)
      .setName("Автосинхронизация после паузы")
      .setDesc("Задержка после последнего локального изменения, от 2 до 300 секунд.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.debounceSeconds))
          .onChange(async (value) => {
            const seconds = Number(value);
            if (Number.isFinite(seconds) && seconds >= 2 && seconds <= 300) {
              this.plugin.settings.debounceSeconds = seconds;
              await this.plugin.savePluginData();
            }
          })
      );

    new Setting(containerEl)
      .setName("Проверять облако каждые N минут")
      .setDesc("0 отключает периодическую проверку. Рекомендуемое значение — 5 минут.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.syncIntervalMinutes))
          .onChange(async (value) => {
            const minutes = Number(value);
            if (Number.isFinite(minutes) && minutes >= 0 && minutes <= 1440) {
              this.plugin.settings.syncIntervalMinutes = minutes;
              this.plugin.configurePeriodicSync();
              await this.plugin.savePluginData();
            }
          })
      );

    new Setting(containerEl)
      .setName("Синхронизация при открытии")
      .setDesc("Получать изменения из облака сразу после запуска Obsidian.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncOnStartup)
          .onChange(async (value) => {
            this.plugin.settings.syncOnStartup = value;
            await this.plugin.savePluginData();
          })
      );

    new Setting(containerEl)
      .setName("Показывать прогресс")
      .setDesc("Показывать обновляемое уведомление с процентом и текущим файлом.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showProgressNotice)
          .onChange(async (value) => {
            this.plugin.settings.showProgressNotice = value;
            await this.plugin.savePluginData();
          })
      );

    new Setting(containerEl)
      .setName("Исключённые папки")
      .setDesc("Один путь на строку. Папка .obsidian должна оставаться исключённой.")
      .addTextArea((area) => {
        area.inputEl.addClass("yandex-sync-setting-textarea");
        area
          .setValue(this.plugin.settings.excludePrefixes.join("\n"))
          .onChange(async (value) => {
            const paths = value
              .split("\n")
              .map((path) => path.trim())
              .filter(Boolean);
            this.plugin.settings.excludePrefixes = [...new Set([".obsidian", ...paths])];
            await this.plugin.savePluginData();
          });
      });

    new Setting(containerEl)
      .setName("Проверить подключение")
      .setDesc("Проверяет токен и доступ к выбранной папке.")
      .addButton((button) =>
        button.setButtonText("Проверить").onClick(async () => {
          if (!this.plugin.settings.oauthToken) {
            new Notice("Сначала укажи OAuth-токен.");
            return;
          }
          button.setDisabled(true);
          try {
            const connected = await new YandexDiskClient(
              this.plugin.settings.oauthToken
            ).testConnection(this.plugin.settings.remoteRoot);
            new Notice(
              connected
                ? "Яндекс.Диск подключён."
                : "Не удалось подключиться к Яндекс.Диску."
            );
          } catch (error) {
            new Notice(`Ошибка: ${error instanceof Error ? error.message : String(error)}`);
          } finally {
            button.setDisabled(false);
          }
        })
      );
  }
}
