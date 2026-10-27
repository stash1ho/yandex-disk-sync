const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const path = require("node:path");
const { webcrypto } = require("node:crypto");
const { build } = require("esbuild");

// Exercise the real plugin lifecycle and scheduling with a fake clock.
// Only the sync engine is replaced: these checks never access a real vault or cloud.
const compiled = build({
  absWorkingDir: path.join(__dirname, ".."),
  entryPoints: ["src/main.ts"],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  external: ["obsidian"],
  plugins: [{
    name: "isolated-sync-engine",
    setup(builder) {
      builder.onResolve({ filter: /^\.\/sync-engine$/ }, () => ({ path: "engine", namespace: "test" }));
      builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({
        contents: "export class SyncEngine { sync() { return globalThis.__syncHook(); } }"
      }));
    }
  }]
}).then((result) => result.outputFiles[0].text);

const emptyStats = () => ({ uploaded: 0, downloaded: 0, deletedLocal: 0, deletedRemote: 0, conflicts: 0, unchanged: 0, failed: 0 });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

async function createHarness(settings, { deferLayout = false } = {}) {
  let now = 1_000_000;
  let nextId = 0;
  let stored = settings === undefined ? null : { settings: { oauthToken: "fake-token", ...settings } };
  let calls = 0;
  let sync = async () => emptyStats();
  let ready;
  const timers = new Map();
  const listeners = new Map();
  const commands = [];
  const notices = [];
  const app = {
    workspace: {
      onLayoutReady(callback) { if (deferLayout) ready = callback; else callback(); },
      on() { throw new Error("Editor changes must not start synchronization"); }
    },
    vault: { on() { throw new Error("Vault changes must not start synchronization"); } }
  };
  class Plugin {
    constructor() { this.app = app; }
    async loadData() { return structuredClone(stored); }
    async saveData(value) { stored = structuredClone(value); }
    addSettingTab() {}
    addRibbonIcon(icon, label, callback) { this.ribbon = callback; }
    addCommand(command) { commands.push(command); }
    addStatusBarItem() { return { setText() {} }; }
    registerDomEvent(target, event, callback) { listeners.set(event, callback); }
  }
  class Notice {
    constructor(message) { notices.push(message); }
    hide() {}
    setMessage() {}
  }
  const context = {
    module: { exports: {} },
    require(name) {
      assert.equal(name, "obsidian");
      return { Plugin, Notice, PluginSettingTab: class {}, requestUrl() { throw new Error("Unexpected network access"); } };
    },
    console,
    crypto: webcrypto,
    Date: class extends Date { static now() { return now; } },
    window: {
      setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { callback, at: now + delay }); return id; },
      clearTimeout(id) { timers.delete(id); }
    },
    document: { visibilityState: "visible" },
    __syncHook() { calls++; return sync(); }
  };
  vm.runInNewContext(await compiled, context);
  const plugin = new context.module.exports.default();
  await plugin.onload();
  return {
    plugin, timers, listeners, commands, notices,
    get calls() { return calls; },
    get stored() { return stored; },
    setSync(fn) { sync = fn; },
    runLayout() { ready(); },
    elapseWithoutTimers(ms) { now += ms; },
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        const entry = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry || entry[1].at > until) break;
        now = entry[1].at;
        timers.delete(entry[0]);
        entry[1].callback();
        await flush();
      }
      now = until;
      await flush();
    }
  };
}

test("manual mode ignores startup, focus, visibility and stale automatic callbacks", async () => {
  const h = await createHarness({ syncMode: "manual", syncOnStartup: true, debounceSeconds: 2 });
  await h.advance(10 * 60_000);
  h.listeners.get("focus")();
  h.listeners.get("visibilitychange")();
  await h.plugin.syncNow("periodic");
  assert.equal(h.calls, 0);
  assert.equal(h.timers.size, 0);
  h.plugin.ribbon();
  await flush();
  h.commands[0].callback();
  await flush();
  assert.equal(h.calls, 2);
  assert.equal(h.timers.size, 0);
});

test("scheduled mode waits the interval, supports manual sync and resumes only when overdue", async () => {
  const h = await createHarness({ syncMode: "scheduled", syncIntervalMinutes: 2 });
  await h.advance(119_999);
  assert.equal(h.calls, 0);
  await h.advance(1);
  assert.equal(h.calls, 1);
  assert.equal(h.timers.size, 1);
  await h.advance(60_000);
  await h.plugin.syncNow("manual");
  assert.equal(h.calls, 2);
  await h.advance(60_000);
  h.listeners.get("focus")();
  await flush();
  assert.equal(h.calls, 2);
  h.elapseWithoutTimers(60_000);
  h.listeners.get("focus")();
  h.listeners.get("visibilitychange")();
  await flush();
  assert.equal(h.calls, 3);
  assert.equal(h.timers.size, 1);
});

test("changing mode cancels scheduled work and persists across reload", async () => {
  const h = await createHarness({ syncMode: "scheduled", syncIntervalMinutes: 1 });
  await h.plugin.setSyncMode("manual");
  await h.advance(300_000);
  assert.equal(h.calls, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.stored.settings.syncMode, "manual");
  const reloaded = await createHarness(h.stored.settings);
  assert.equal(reloaded.plugin.settings.syncMode, "manual");
  assert.equal(reloaded.timers.size, 0);
  await h.plugin.setSyncMode("scheduled");
  await h.advance(60_000);
  assert.equal(h.calls, 1);
});

test("busy sync does not queue repeated clicks or restart after switching to manual", async () => {
  const h = await createHarness({ syncMode: "scheduled", syncIntervalMinutes: 1 });
  let finish;
  h.setSync(() => new Promise((resolve) => { finish = resolve; }));
  const running = h.plugin.syncNow("manual");
  await flush();
  await h.plugin.syncNow("manual");
  await h.advance(300_000);
  await h.plugin.setSyncMode("manual");
  assert.equal(h.calls, 1);
  finish(emptyStats());
  await running;
  await h.advance(300_000);
  assert.equal(h.calls, 1);
  assert.equal(h.timers.size, 0);
});

test("manual lock failure has no automatic retry; scheduled failure waits a full interval", async () => {
  for (const mode of ["manual", "scheduled"]) {
    const h = await createHarness({ syncMode: mode, syncIntervalMinutes: 1 });
    h.setSync(async () => { throw new Error("Другой клиент уже выполняет синхронизацию."); });
    await h.plugin.syncNow("manual");
    await h.advance(59_999);
    assert.equal(h.calls, 1);
    await h.advance(1);
    assert.equal(h.calls, mode === "scheduled" ? 2 : 1);
  }
});

test("unload cancels timers and finishing in-flight work cannot rearm them", async () => {
  const h = await createHarness({ syncMode: "scheduled", syncIntervalMinutes: 1 });
  let finish;
  h.setSync(() => new Promise((resolve) => { finish = resolve; }));
  const running = h.plugin.syncNow("manual");
  await flush();
  h.plugin.onunload();
  finish(emptyStats());
  await running;
  await h.advance(120_000);
  assert.equal(h.calls, 1);
  assert.equal(h.timers.size, 0);
  const delayed = await createHarness({ syncMode: "scheduled" }, { deferLayout: true });
  delayed.plugin.onunload();
  delayed.runLayout();
  assert.equal(delayed.timers.size, 0);
});

test("new installs default to manual; legacy interval 0 stays manual and positive interval migrates", async () => {
  for (const [settings, mode, interval] of [
    [undefined, "manual", 5],
    [{ syncIntervalMinutes: 0 }, "manual", 5],
    [{ syncIntervalMinutes: 10 }, "scheduled", 10],
    [{ syncMode: "invalid", syncIntervalMinutes: -1 }, "manual", 5],
    [{ syncMode: "scheduled", syncIntervalMinutes: NaN }, "scheduled", 5]
  ]) {
    const h = await createHarness(settings);
    assert.equal(h.plugin.settings.syncMode, mode);
    assert.equal(h.plugin.settings.syncIntervalMinutes, interval);
  }
});

test("interval changes replace the old deadline", async () => {
  const h = await createHarness({ syncMode: "scheduled", syncIntervalMinutes: 1 });
  await h.advance(30_000);
  h.plugin.settings.syncIntervalMinutes = 2;
  h.plugin.configurePeriodicSync();
  await h.advance(119_999);
  assert.equal(h.calls, 0);
  await h.advance(1);
  assert.equal(h.calls, 1);
  assert.equal(h.timers.size, 1);
});

test("without a token neither mode schedules or accesses the engine", async () => {
  for (const syncMode of ["manual", "scheduled"]) {
    const h = await createHarness({ syncMode, oauthToken: "" });
    await h.advance(600_000);
    await h.plugin.syncNow("manual");
    assert.equal(h.calls, 0);
    assert.equal(h.timers.size, 0);
  }
});
