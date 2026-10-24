import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runInNewContext } from "node:vm";
import type { IpcMainInvokeEvent } from "electron";
import { afterEach, expect, it, vi } from "vitest";
import { buildMenubarView, DEFAULT_MENUBAR_SETTINGS, isMenubarSupportedPlatform,
  type MenubarSettings, type MenubarView, type DesktopMenubarAction } from "@joko/contracts";
import { DesktopMenuBar, createMenuBarSettingsStore, registerMenuBarIpc } from "../src/menu-bar.js";
import { MenuBarNativeHost } from "../src/menu-bar-native-host.js";
import { parseMenubarHelperMessage, parseMenubarSettings, parseMenubarSnapshot } from "../src/native-task-status-contract.js";
import { DESKTOP_CHANNELS } from "../src/channels.js";
import { compiledPreloadSource } from "./support/preload-source.js";

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function view(settings = structuredClone(DEFAULT_MENUBAR_SETTINGS), usedPercent = 10): MenubarView {
  return buildMenubarView({ nowMs: 1_000, locale: "en", moneySymbol: "$", settings, updatedAtMs: 1_000,
    sources: [{ kind: "subscription", id: "source-one", providerId: "provider-one", family: "generic", logoSvg: "joko:mark",
      brand: "Subscription", account: null, plan: "Plan", credits: null, creditsUnlimited: false, prepaidUsd: null,
      updatedAtMs: 1_000, windows: [{ kind: "session", usedPercent, windowMinutes: 300, resetsAtMs: 20_000 }] }],
    tasks: [{ sessionId: "bound-task-one", title: "Task", harness: "first", model: "Model", tokensToday: 10, valueToday: 0.1,
      contextPercent: null, running: true, startedAtMs: 500, lastActiveAtMs: 1_000 }],
    usage: { days: [], scopes: { local: { daily: [], models: { "7": [], "30": [], "90": [] }, devices: [] },
      all: { daily: [], models: { "7": [], "30": [], "90": [] }, devices: [] } } },
    harnessLogos: { first: "joko:mark", second: "joko:mark", other: "joko:mark" }, uiStrings: {}, t: key => key });
}

class Helper extends EventEmitter {
  readonly stdin = new PassThrough(); readonly stdout = new PassThrough(); readonly stderr = new PassThrough();
  readonly process = this as unknown as ChildProcessWithoutNullStreams;
  readonly updates: { type: string; view?: MenubarView }[] = [];
  exited = false;
  kill = vi.fn(() => { this.exit(); return true; });
  constructor() {
    super();
    this.stdin.on("data", (bytes: Buffer) => {
      for (const line of bytes.toString().trim().split("\n")) {
        const command = JSON.parse(line) as { type: string; view?: MenubarView };
        this.updates.push(command);
        if (command.type === "shutdown") this.exit();
      }
    });
  }
  output(message: unknown): void { this.stdout.write(JSON.stringify(message) + "\n"); }
  exit(): void { if (!this.exited) { this.exited = true; this.emit("exit", 0, null); this.emit("close", 0, null); } }
}

function fixture(available = true) {
  let settings = structuredClone(DEFAULT_MENUBAR_SETTINGS);
  const helpers: Helper[] = [], actions: DesktopMenubarAction[] = [];
  const options = { available, resolveHelper: () => "/verified/menu-bar", onOpenApp: vi.fn(), onSettings: vi.fn(), onError: vi.fn(),
    onAction: (action: DesktopMenubarAction) => { actions.push(action); },
    spawnProcess: vi.fn(() => { const child = new Helper(); helpers.push(child); return child.process; }),
    store: { initialize: async () => settings, get: () => structuredClone(settings), patch: async (patch: unknown) => {
      settings = parseMenubarSettings({ ...settings, ...(patch as object) }); return settings;
    } } };
  const service = new DesktopMenuBar(options);
  const publish = (revision: number, used = 10, ownerId = "document-one") => service.publish({ ownerId, revision: String(revision), view: view(settings, used) });
  return { service, helpers, actions, options, publish };
}

it("persists only acknowledged settings and recovers from corruption or a failed save", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-menu-settings-")); directories.push(root);
  const path = join(root, "settings.json"); await writeFile(path, "invalid JSON");
  const store = createMenuBarSettingsStore(path);
  expect(await store.initialize()).toEqual(DEFAULT_MENUBAR_SETTINGS);
  await store.patch({ privacy: true, order: ["source-one"] });
  expect(await createMenuBarSettingsStore(path).initialize()).toMatchObject({ privacy: true, order: ["source-one"] });
  const a = store.patch({ scope: "local" }), b = store.patch({ statusText: "task" }); await Promise.all([a, b]);
  expect(store.get()).toMatchObject({ scope: "local", statusText: "task", privacy: true });
  await rm(path); await mkdir(path);
  await expect(store.patch({ enabled: false })).rejects.toThrow();
  expect(store.get().enabled).toBe(true);
  expect(() => store.patch({ scope: "unrecognized" })).toThrow();
});

it("binds task intents to the latest presentation, ignores old revisions and alerts only on a healthy-to-low transition", async () => {
  const f = fixture(); await f.service.initialize(); const helper = f.helpers[0]!;
  expect(helper.updates).toEqual([]); helper.output({ type: "ready" });
  expect(helper.updates.at(-1)?.view?.gate).toBe("connection");
  f.publish(1, 95); expect(f.actions).toEqual([]);
  f.publish(2, 10); f.publish(3, 95); f.publish(2, 10);
  expect(f.actions).toEqual([{ type: "low-alert" }]);
  helper.output({ type: "open-session", sessionId: "not-published" }); expect(f.options.onOpenApp).not.toHaveBeenCalled();
  helper.output({ type: "open-session", sessionId: "bound-task-one" });
  expect(f.actions.at(-1)).toEqual({ type: "open-session", id: "bound-task-one" });
  f.service.clear(); helper.output({ type: "open-session", sessionId: "bound-task-one" });
  expect(f.options.onOpenApp).toHaveBeenCalledOnce();
  expect(helper.updates.at(-1)?.view).toMatchObject({ gate: "connection", tasks: [], sources: [] });
  await f.service.dispose();
});

it("stops across independent sleep/lock fences and resumes with a fresh connection gate", async () => {
  const f = fixture(); await f.service.initialize(); f.helpers[0]!.output({ type: "ready" }); f.publish(1);
  await f.service.suspend("system"); await f.service.suspend("lock"); f.publish(2);
  f.service.resume("system"); expect(f.helpers).toHaveLength(1);
  f.service.resume("lock"); expect(f.helpers).toHaveLength(2);
  f.helpers[1]!.output({ type: "ready" }); expect(f.helpers[1]!.updates.at(-1)?.view?.gate).toBe("connection");
  await f.service.setEnabled(false); f.publish(3); expect(f.helpers[1]!.exited).toBe(true);
  await f.service.dispose();
  const unsupported = fixture(false); await unsupported.service.initialize();
  expect(unsupported.helpers).toHaveLength(0); await expect(unsupported.service.setEnabled(true)).rejects.toThrow("macOS 14");
  expect(isMenubarSupportedPlatform("darwin", "23.0.0")).toBe(true);
  expect(isMenubarSupportedPlatform("darwin", "22.9.0")).toBe(false);
  expect(isMenubarSupportedPlatform("win32", "99")).toBe(false);
});

it("does not turn a stale Provider detail click into the replacement connection's new-task intent", async () => {
  const f = fixture(); await f.service.initialize(); const helper = f.helpers[0]!; helper.output({ type: "ready" }); f.publish(1);
  helper.output({ type: "detail-action", sourceId: "source-one", actionId: "old-provider-action" });
  helper.output({ type: "detail-action", sourceId: "source-one" });
  expect(f.actions).toEqual([]);
  helper.output({ type: "detail-action", sourceId: "source-one", actionId: "provider-one" });
  expect(f.actions).toEqual([{ type: "new-task", id: "provider-one" }]);
  const next = view(); next.details["source-one"]!.action = { kind: "new-task", providerId: "replacement-provider-action" };
  f.service.publish({ ownerId: "document-one", revision: "2", view: next });
  helper.output({ type: "detail-action", sourceId: "source-one", actionId: "provider-one" });
  expect(f.actions).toHaveLength(1);
  await f.service.dispose();
});

it("keeps native settings failures visible, restores acknowledged preferences and retries only explicitly", async () => {
  const f = fixture(); await f.service.initialize(); const helper = f.helpers[0]!; helper.output({ type: "ready" }); f.publish(1);
  const original = f.options.store.patch;
  f.options.store.patch = vi.fn().mockRejectedValue(new Error("private write failed"));
  helper.output({ type: "settings", patch: { privacy: true } });
  await vi.waitFor(() => expect(helper.updates.at(-1)?.view?.strings["settingsError"]).toContain("Could not save"));
  expect(helper.updates.at(-1)?.view?.settings.privacy).toBe(false); expect(f.service.state().settings.privacy).toBe(false);
  f.options.store.patch = original;
  helper.output({ type: "retry-settings" });
  await vi.waitFor(() => expect(f.service.state().settings.privacy).toBe(true));
  expect(helper.updates.at(-1)?.view?.strings["settingsError"]).toBeUndefined();
  await f.service.dispose();
});

it("bounds helper readiness and retries, and suppresses a retired helper's late events", async () => {
  vi.useFakeTimers(); const helpers: Helper[] = [], message = vi.fn(), failure = vi.fn();
  const host = new MenuBarNativeHost({ resolveHelper: () => "/verified/helper", onStarted: vi.fn(), onRestarting: vi.fn(), onFailure: failure,
    onMessage: message, spawnProcess: () => { const child = new Helper(); helpers.push(child); return child.process; } });
  host.publish(view()); await vi.advanceTimersByTimeAsync(2_500);
  expect(failure).toHaveBeenCalledWith(expect.stringContaining("ready")); expect(helpers[0]!.kill).toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1_000); expect(helpers).toHaveLength(2);
  helpers[0]!.output({ type: "open-app" }); expect(message).not.toHaveBeenCalled();
  helpers[1]!.output({ type: "ready" }); helpers[1]!.output({ type: "panel", open: true });
  expect(message).toHaveBeenCalledWith({ type: "panel", open: true });
  await host.stop(); await vi.advanceTimersByTimeAsync(60_000); expect(helpers).toHaveLength(2);
});

it("exposes a native start failure and admits an explicit retry without overlapping helpers", async () => {
  vi.useFakeTimers(); const f = fixture();
  f.options.spawnProcess.mockImplementationOnce(() => { throw new Error("spawn unavailable"); });
  await f.service.initialize(); expect(f.service.state().error).toBe("helper");
  expect(f.options.onError).toHaveBeenCalledOnce();
  await f.service.setEnabled(true); expect(f.helpers).toHaveLength(1);
  f.helpers[0]!.output({ type: "ready" }); expect(f.service.state().error).toBeUndefined();
  await vi.advanceTimersByTimeAsync(5_000); expect(f.helpers).toHaveLength(1);
  await f.service.dispose();
});

it("rejects malformed native payloads and enforces current-main-document publication before effects", async () => {
  const valid = { ownerId: "main", revision: "1", view: view() };
  expect(parseMenubarSnapshot(valid)).toEqual(valid);
  for (const invalid of [ { ...valid, view: { ...valid.view, sources: [{ ...valid.view.sources[0], logoSvg: "<svg/>" }] } },
    { ...valid, view: { ...valid.view, tasks: [valid.view.tasks[0], valid.view.tasks[0]] } },
    { ...valid, view: { ...valid.view, usage: { days: [], scopes: { all: { daily: [{ money: [], tokens: [], paid: 0 }], models: {}, note: "" } } } } },
    { ...valid, view: { ...valid.view, tasks: [{ ...valid.view.tasks[0], value: Number.NaN }] } } ]) {
    expect(() => parseMenubarSnapshot(invalid)).toThrow();
  }
  expect(() => parseMenubarHelperMessage({ type: "settings", patch: { order: ["x", "x"] } })).toThrow();
  expect(() => parseMenubarSettings({ ...DEFAULT_MENUBAR_SETTINGS, privacy: undefined })).toThrow();
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...parameters: unknown[]) => unknown>();
  const f = fixture(), trusted = {} as IpcMainInvokeEvent, other = {} as IpcMainInvokeEvent;
  registerMenuBarIpc({ ipc: { handle: (key, handler) => { handlers.set(key, handler); } }, menuBar: f.service,
    assertSource: event => { if (event !== trusted) throw new Error("untrusted"); },
    assertDocument: (event, occurrence) => { if (event !== trusted || occurrence !== "current") throw new Error("retired"); } });
  const publish = handlers.get(DESKTOP_CHANNELS.menuBarPublish)!, set = handlers.get(DESKTOP_CHANNELS.menuBarSetEnabled)!;
  expect(() => publish(trusted, "old", valid)).toThrow("retired");
  expect(() => publish(other, "current", valid)).toThrow("retired");
  expect(() => set(other, true)).toThrow("untrusted");
  expect(() => set(trusted, { enabled: true })).toThrow(); expect(f.helpers).toHaveLength(0);
  await f.service.initialize(); publish(trusted, "current", valid); expect(f.helpers).toHaveLength(1); await f.service.dispose();
});

it("assembles the real sandbox preload with typed menu settings, document-bound publication and removable listeners", async () => {
  const f = fixture(), listeners = new Map<string, (...args: unknown[]) => void>();
  let bridge!: NonNullable<JokoMenuBarPreload>;
  const invoke = vi.fn(async () => f.service.state());
  runInNewContext(compiledPreloadSource(), {
    module: { exports: {} }, exports: {}, require: () => ({
      contextBridge: { exposeInMainWorld: (_name: string, value: typeof bridge) => { bridge = value; } },
      ipcRenderer: { invoke, send: vi.fn(), sendSync: (channel: string) => channel === DESKTOP_CHANNELS.mainDocumentOccurrenceGet ? "document-occurrence"
        : channel === DESKTOP_CHANNELS.preferredSystemLocaleGet ? "en" : false,
        on: (channel: string, listener: (...args: unknown[]) => void) => { listeners.set(channel, listener); },
        removeListener: (channel: string) => { listeners.delete(channel); } }
    }), process: { platform: "darwin", arch: "arm64" }, crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000001" },
    console, Object, Promise, Set, Map, WeakMap, BigInt, Number, String, Boolean, TypeError, RangeError, RegExp, URL, URLSearchParams,
    TextEncoder, Uint8Array, ArrayBuffer, structuredClone
  });
  expect(bridge.capabilities).toContain("native.menuBar"); await bridge.menuBar.get();
  const snapshot = { ownerId: "main", revision: "1", view: view() }; await bridge.menuBar.publish(snapshot);
  expect(invoke).toHaveBeenLastCalledWith(DESKTOP_CHANNELS.menuBarPublish, "document-occurrence", snapshot);
  await expect(bridge.menuBar.setEnabled("yes" as unknown as boolean)).rejects.toThrow();
  const listener = vi.fn(), dispose = bridge.menuBar.onAction(listener);
  listeners.get(DESKTOP_CHANNELS.menuBarAction)!({}, { type: "open-session", id: "owned" });
  listeners.get(DESKTOP_CHANNELS.menuBarAction)!({}, { type: "open-session", id: "owned", path: "/secret" });
  expect(listener).toHaveBeenCalledExactlyOnceWith({ type: "open-session", id: "owned" }); dispose();
  expect(listeners.has(DESKTOP_CHANNELS.menuBarAction)).toBe(false);
});

interface JokoMenuBarPreload {
  capabilities: readonly string[];
  menuBar: {
    get(): Promise<unknown>; setEnabled(enabled: boolean): Promise<unknown>;
    publish(value: unknown): Promise<void>;
    onAction(listener: (action: unknown) => void): () => void;
  };
}
