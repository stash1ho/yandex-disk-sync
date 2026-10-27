import { Notice, PluginSettingTab, Setting } from "obsidian";
import type YandexDiskSyncPlugin from "./main";
import { validateRemotePath } from "./utils";
import { YandexDiskClient } from "./yandex-client";
import { createProgressView, normalizeProgressStyle } from "./progress-view";

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
      .setName("Режим синхронизации")
      .setDesc("Вручную — только по кнопке. По расписанию — через заданный интервал. Уже начатая синхронизация завершится при смене режима.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("manual", "Вручную")
          .addOption("scheduled", "По расписанию")
          .setValue(this.plugin.settings.syncMode)
          .onChange(async (value) => {
            await this.plugin.setSyncMode(value === "scheduled" ? "scheduled" : "manual");
            this.display();
          })
      );

    if (this.plugin.settings.syncMode === "scheduled") new Setting(containerEl)
      .setName("Интервал синхронизации, минут")
      .setDesc("От 1 до 1440 минут. Первый запуск — через этот интервал; следующие — после такой же паузы от завершения предыдущего. Кнопка доступна всегда.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.syncIntervalMinutes))
          .onChange(async (value) => {
            const minutes = Number(value);
            if (Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440) {
              this.plugin.settings.syncIntervalMinutes = minutes;
              this.plugin.configurePeriodicSync();
              await this.plugin.savePluginData();
            }
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

    const progressStyleSetting = new Setting(containerEl)
      .setName("Вид прогресса")
      .setDesc("Выбери оформление уведомления о синхронизации. Ниже показан пример.");
    const preview = document.createElement("div");
    preview.className = "yandex-sync-preview";
    const updatePreview = (): void => {
      preview.replaceChildren(createProgressView({
        phase: "sync",
        completed: 21,
        total: 50,
        currentPath: "Заметки/Пример.md",
        stats: { uploaded: 0, downloaded: 0, deletedLocal: 0, deletedRemote: 0, conflicts: 0, unchanged: 0, failed: 0 }
      }, this.plugin.settings.progressStyle));
    };
    progressStyleSetting.addDropdown((dropdown) => {
      dropdown
        .addOption("bar", "Полоска и проценты")
        .addOption("text", "Только текст")
        .addOption("circle", "Круговой индикатор")
        .setValue(this.plugin.settings.progressStyle)
        .onChange(async (value) => {
          const save = this.plugin.setProgressStyle(normalizeProgressStyle(value));
          updatePreview();
          await save;
        });
    });
    updatePreview();
    containerEl.append(preview);

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
