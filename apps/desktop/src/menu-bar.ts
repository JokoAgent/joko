import { atomicWritePrivateFile, readPrivateFile } from "@joko/device-peer/private-files";
import { DEFAULT_MENUBAR_SETTINGS, MENU_BAR_MESSAGES, buildMenubarView,
  type DesktopMenubarAction, type DesktopMenubarSnapshot, type MenubarSettings, type MenubarState,
  type MenubarHelperMessage, type MenubarView } from "@joko/contracts";
import { parseMenubarSettings, parseMenubarSettingsPatch, parseMenubarSnapshot } from "./native-task-status-contract.js";
import { MenuBarNativeHost, type MenuBarNativeHostOptions } from "./menu-bar-native-host.js";
import type { IpcMainInvokeEvent } from "electron";
import { DESKTOP_CHANNELS } from "./channels.js";

export interface MenuBarSettingsStore {
  initialize(): Promise<MenubarSettings>;
  get(): MenubarSettings;
  patch(patch: unknown): Promise<MenubarSettings>;
}

export function createMenuBarSettingsStore(path: string): MenuBarSettingsStore {
  let settings = structuredClone(DEFAULT_MENUBAR_SETTINGS);
  let initialization: Promise<MenubarSettings> | undefined;
  let tail = Promise.resolve();
  const initialize = (): Promise<MenubarSettings> => initialization ??= readPrivateFile(path).then(bytes => {
    if (!bytes) return structuredClone(settings);
    try { settings = parseMenubarSettings(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); }
    catch { /* A corrupt device preference returns to the explicit defaults. */ }
    finally { bytes.fill(0); }
    return structuredClone(settings);
  }).catch(() => structuredClone(settings));
  return {
    initialize,
    get: () => structuredClone(settings),
    patch: patch => {
      const parsed = parseMenubarSettingsPatch(patch);
      const operation = tail.then(async () => {
        await initialize();
        const next = parseMenubarSettings({ ...settings, ...parsed });
        const bytes = Buffer.from(JSON.stringify(next) + "\n", "utf8");
        try { await atomicWritePrivateFile(path, bytes); } finally { bytes.fill(0); }
        settings = next;
        return structuredClone(settings);
      });
      tail = operation.then(() => undefined, () => undefined);
      return operation;
    }
  };
}

export function registerMenuBarIpc(options: {
  readonly ipc: { handle(channel: string, handler: (event: IpcMainInvokeEvent, ...parameters: unknown[]) => unknown): void };
  readonly menuBar: DesktopMenuBar;
  readonly assertSource: (event: IpcMainInvokeEvent) => void;
  readonly assertDocument: (event: IpcMainInvokeEvent, occurrence: unknown) => void;
}): void {
  options.ipc.handle(DESKTOP_CHANNELS.menuBarGet, (event, ...parameters) => {
    options.assertSource(event);
    if (parameters.length !== 0) throw new TypeError("Invalid menu bar state request.");
    return options.menuBar.state();
  });
  options.ipc.handle(DESKTOP_CHANNELS.menuBarSetEnabled, (event, ...parameters) => {
    options.assertSource(event);
    if (parameters.length !== 1 || typeof parameters[0] !== "boolean") throw new TypeError("Invalid menu bar toggle.");
    return options.menuBar.setEnabled(parameters[0]);
  });
  options.ipc.handle(DESKTOP_CHANNELS.menuBarPublish, (event, ...parameters) => {
    options.assertDocument(event, parameters[0]);
    if (parameters.length !== 2) throw new TypeError("Menu bar publication requires the current document and presentation.");
    options.menuBar.publish(parameters[1]);
  });
}

interface DesktopMenuBarOptions {
    available: boolean;
    store: MenuBarSettingsStore;
    onSettings: (settings: MenubarSettings) => void;
    onAction: (action: DesktopMenubarAction) => void;
    onOpenApp: () => void;
    onError: (error: unknown) => void;
}

/** Device-local settings and a replaceable, authenticated presentation owner. */
export class DesktopMenuBar {
  readonly #options: DesktopMenuBarOptions;
  readonly #host: MenuBarNativeHost;
  #snapshot: DesktopMenubarSnapshot | undefined;
  #low: boolean | undefined;
  #disposed = false;
  readonly #suspensions = new Set<string>();
  #locale = "en";
  #failedSettingsPatch: unknown;
  #helperFailed = false;

  constructor(options: DesktopMenuBarOptions & Omit<MenuBarNativeHostOptions, "onStarted" | "onRestarting" | "onFailure" | "onMessage">) {
    this.#options = options;
    this.#host = new MenuBarNativeHost({
      resolveHelper: options.resolveHelper,
      ...(options.spawnProcess ? { spawnProcess: options.spawnProcess } : {}),
      onStarted: () => { this.#helperFailed = false; options.onSettings(options.store.get()); },
      onRestarting: () => undefined,
      onFailure: message => { this.#helperFailed = true; options.onError(new Error(message)); options.onSettings(options.store.get()); },
      onMessage: message => this.#message(message)
    });
  }

  async initialize(): Promise<void> { await this.#options.store.initialize(); this.#renderGate(); }
  state(): MenubarState {
    const settings = this.#options.store.get();
    return { available: this.#options.available, enabled: settings.enabled, settings, ...(this.#helperFailed ? { error: "helper" as const } : {}) };
  }
  async setEnabled(enabled: boolean): Promise<MenubarState> {
    if (!this.#options.available || this.#disposed) throw new Error("The menu bar requires macOS 14 or later and its installed helper.");
    if (enabled && this.#helperFailed) await this.#host.stop();
    await this.#commit({ enabled });
    return this.state();
  }
  publish(input: unknown): void {
    if (this.#disposed || this.#suspensions.size > 0 || !this.#options.available) return;
    const snapshot = parseMenubarSnapshot(input);
    if (!this.state().enabled) return;
    if (JSON.stringify(snapshot.view.settings) !== JSON.stringify(this.#options.store.get())) {
      this.#options.onSettings(this.#options.store.get());
      return;
    }
    if (this.#snapshot?.ownerId === snapshot.ownerId && BigInt(snapshot.revision) <= BigInt(this.#snapshot.revision)) return;
    if (this.#snapshot?.ownerId !== snapshot.ownerId) this.#low = undefined;
    this.#snapshot = snapshot;
    this.#locale = snapshot.view.locale;
    const metered = snapshot.view.sources.filter(source => source.kind !== "payg" && source.fill !== null);
    const low = snapshot.view.gate === undefined ? metered.length > 0 && metered.every(source => !source.reserve && source.fill! <= 0.15) : undefined;
    if (low === true && this.#low === false && snapshot.view.settings.lowAlert) this.#options.onAction({ type: "low-alert" });
    this.#low = low;
    this.#host.publish(this.#withSettingsError(snapshot.view));
  }
  clear(): void {
    this.#snapshot = undefined;
    this.#low = undefined;
    this.#renderGate();
  }
  async suspend(reason = "system"): Promise<void> { this.#suspensions.add(reason); this.#snapshot = undefined; this.#low = undefined; await this.#host.stop(); }
  resume(reason = "system"): void {
    if (this.#disposed) return;
    this.#suspensions.delete(reason);
    if (this.#suspensions.size > 0) return;
    this.#renderGate(); this.#options.onAction({ type: "refresh" });
  }
  async dispose(): Promise<void> { this.#disposed = true; this.#snapshot = undefined; await this.#host.stop(); }

  async #commit(patch: unknown): Promise<void> {
    const settings = await this.#options.store.patch(patch);
    if (this.#disposed) return;
    this.#failedSettingsPatch = undefined;
    this.clear();
    this.#options.onSettings(settings);
    if (!settings.enabled) await this.#host.stop();
  }
  #renderGate(): void {
    if (this.#disposed || this.#suspensions.size > 0 || !this.#options.available || !this.state().enabled) return;
    const strings = MENU_BAR_MESSAGES[this.#locale.startsWith("zh") ? "zh-CN" : "en"];
    const view: MenubarView = buildMenubarView({
      nowMs: Date.now(), locale: this.#locale, moneySymbol: "", settings: this.#options.store.get(),
      sources: [], tasks: [], updatedAtMs: null, gate: "connection",
      usage: { days: [], scopes: { local: { daily: [], models: { "7": [], "30": [], "90": [] }, devices: [] },
        all: { daily: [], models: { "7": [], "30": [], "90": [] }, devices: [] } } },
      harnessLogos: { first: "joko:mark", second: "joko:mark", other: "joko:mark" },
      uiStrings: Object.fromEntries(Object.entries(strings).filter(([key]) => key.startsWith("ui.")).map(([key, value]) => [key.slice(3), value])),
      t: (key, values) => (strings[key] ?? key).replace(/\{\{(\w+)\}\}/gu, (_, key: string) => String(values?.[key] ?? ""))
    });
    this.#host.publish(this.#withSettingsError(view));
  }
  #withSettingsError(view: MenubarView): MenubarView {
    if (this.#failedSettingsPatch === undefined) return view;
    return { ...view, strings: { ...view.strings, settingsError: this.#locale.startsWith("zh")
      ? "无法保存设置。已保留原设置，请重试。" : "Could not save settings. Your previous settings are retained. Retry to apply this change.",
      retrySettings: this.#locale.startsWith("zh") ? "重试" : "Retry" } };
  }
  #saveFromHelper(patch: unknown): void {
    void this.#commit(patch).catch(error => {
      if (this.#disposed) return;
      this.#failedSettingsPatch = patch;
      this.#options.onError(error);
      if (this.#snapshot) this.#host.publish(this.#withSettingsError(this.#snapshot.view));
      else this.#renderGate();
    });
  }
  #message(message: MenubarHelperMessage): void {
    if (this.#disposed || this.#suspensions.size > 0 || !this.state().enabled) return;
    if (message.type === "settings") { this.#saveFromHelper(message.patch); return; }
    if (message.type === "retry-settings") { if (this.#failedSettingsPatch !== undefined) this.#saveFromHelper(this.#failedSettingsPatch); return; }
    if (message.type === "open-app") { this.#options.onOpenApp(); return; }
    if (message.type === "refresh" || message.type === "panel" && message.open) { this.#options.onAction({ type: "refresh" }); return; }
    const snapshot = this.#snapshot;
    if (!snapshot || snapshot.view.gate) return;
    if (message.type === "open-session" && snapshot.view.tasks.some(task => task.sessionId === message.sessionId)) {
      this.#options.onOpenApp(); this.#options.onAction({ type: "open-session", id: message.sessionId });
    } else if (message.type === "open-provider-settings") {
      this.#options.onOpenApp(); this.#options.onAction({ type: "open-provider-settings" });
    } else if (message.type === "detail-action") {
      const action = snapshot.view.details[message.sourceId]?.action;
      if (action?.kind === "new-task" && message.actionId === action.providerId) { this.#options.onOpenApp(); this.#options.onAction({ type: "new-task", id: action.providerId }); }
      else if (action?.kind === "open-settings") { this.#options.onOpenApp(); this.#options.onAction({ type: "open-provider-settings" }); }
      else if (action?.kind === "open-app") this.#options.onOpenApp();
    }
  }
}
