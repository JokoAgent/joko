import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { describe, expect, it, vi } from "vitest";
import { DESKTOP_CHANNELS } from "../src/channels.js";

interface DeepLinkApi {
  takePending(): Promise<unknown>;
  acknowledge(value: unknown): Promise<boolean>;
  onNavigate(listener: (delivery: unknown) => void): () => void;
}

interface KeepAwakeApi {
  onKeepAwakeChanged(listener: (settings: { readonly enabled: boolean }) => void): () => void;
}

interface NativeGamepadApi {
  getSnapshot(): Promise<unknown>;
  setClientState(value: unknown): Promise<unknown>;
  probe(): Promise<unknown>;
}

interface OpenWithApi {
  listOpenWithApps(request: { readonly listOccurrence: string; readonly name: string }): Promise<unknown>;
  retireOpenWithApps(listOccurrence: string): Promise<void>;
  openFileWithApp(request: {
    readonly requestId: string;
    readonly listOccurrence: string;
    readonly appId: string;
    readonly file: { readonly name: string; readonly mediaType: string; readonly bytes: Uint8Array };
  }): Promise<unknown>;
  cancelFileOpen(requestId: string): Promise<void>;
}

const MAIN_DOCUMENT_CLAIM = "00000000-0000-4000-8000-000000000001";

function delivery(documentOccurrence: string, deliveryOccurrence = 1): unknown {
  return Object.freeze({
    documentOccurrence,
    deliveryOccurrence,
    navigation: Object.freeze({ kind: "settings", section: "providers" })
  });
}

function loadPreload(
  documentOccurrence: string,
  crypto: {
    readonly randomUUID?: () => string;
    readonly getRandomValues?: (bytes: Uint8Array) => Uint8Array;
  } = { randomUUID: () => MAIN_DOCUMENT_CLAIM },
  preferredSystemLocale: unknown = "zh-CN",
  platform: NodeJS.Platform = "win32",
  nativeGamepadOccurrence: unknown = "native-gamepad-document",
  openWithOccurrence: unknown = "00000000-0000-4000-8000-000000000010"
): {
  readonly exposed: Readonly<Record<string, unknown>>;
  readonly deepLinks: DeepLinkApi;
  readonly power: KeepAwakeApi;
  readonly nativeGamepad: NativeGamepadApi;
  readonly openWith: OpenWithApi;
  readonly invoke: ReturnType<typeof vi.fn>;
  readonly synchronousChannels: readonly string[];
  readonly listeners: Map<string, (...parameters: unknown[]) => void>;
  setPending(value: unknown): void;
} {
  const source = readFileSync(new URL("../src/preload.cts", import.meta.url), "utf8");
  const output = transpileModule(source, {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
  }).outputText;
  const listeners = new Map<string, (...parameters: unknown[]) => void>();
  let pending: unknown;
  const invoke = vi.fn(async (channel: string, ..._parameters: unknown[]): Promise<unknown> => {
    if (channel === "joko:deep-link:take-pending") return pending;
    if (channel === "joko:deep-link:acknowledge") return true;
    if (channel.startsWith("joko:native-gamepad:")) {
      return { version: 1, revision: 0, status: "idle", devices: [] };
    }
    if (channel === DESKTOP_CHANNELS.listOpenWithApps) {
      return { status: "listed", listOccurrence: "00000000-0000-4000-8000-000000000011", apps: [] };
    }
    if (channel === DESKTOP_CHANNELS.openFileWithApp) return { status: "opened" };
    return undefined;
  });
  let exposed: unknown;
  const synchronousChannels: string[] = [];
  const electron = {
    contextBridge: {
      exposeInMainWorld: (_name: string, value: unknown): void => { exposed = value; }
    },
    ipcRenderer: {
      sendSync: (channel: string, ...parameters: unknown[]): unknown => {
        synchronousChannels.push(channel);
        if (channel === "joko:main-document:occurrence:get") {
          expect(parameters).toEqual([MAIN_DOCUMENT_CLAIM]);
        }
        if (channel === "joko:main-document:occurrence:get") return documentOccurrence;
        if (channel === "joko:native-gamepad:document:capture") {
          expect(parameters).toEqual([MAIN_DOCUMENT_CLAIM]);
          return nativeGamepadOccurrence;
        }
        if (channel === DESKTOP_CHANNELS.openWithCaptureDocument) {
          expect(parameters).toEqual([MAIN_DOCUMENT_CLAIM]);
          return openWithOccurrence;
        }
        if (channel === "joko:locale:preferred-system:get") return preferredSystemLocale;
        return false;
      },
      invoke,
      send: vi.fn(),
      on: (channel: string, listener: (...parameters: unknown[]) => void): void => { listeners.set(channel, listener); },
      removeListener: (channel: string, listener: (...parameters: unknown[]) => void): void => {
        if (listeners.get(channel) === listener) listeners.delete(channel);
      }
    }
  };
  const commonJsModule = { exports: {} };
  runInNewContext(output, {
    module: commonJsModule,
    exports: commonJsModule.exports,
    require: (specifier: string): unknown => {
      if (specifier !== "electron") throw new Error(`Unexpected preload dependency: ${specifier}`);
      return electron;
    },
    process: { platform },
    crypto,
    console,
    Object,
    Promise,
    Set,
    Map,
    WeakMap,
    BigInt,
    Number,
    String,
    Boolean,
    TypeError,
    RangeError,
    RegExp,
    URL,
    URLSearchParams,
    TextEncoder,
    Uint8Array,
    ArrayBuffer,
    structuredClone
  });
  const desktop = exposed as Readonly<Record<string, unknown>> & {
    readonly deepLinks: DeepLinkApi;
    readonly power: KeepAwakeApi;
    readonly nativeGamepad: NativeGamepadApi;
  } & OpenWithApi;
  return {
    exposed: desktop,
    deepLinks: desktop.deepLinks,
    power: desktop.power,
    nativeGamepad: desktop.nativeGamepad,
    openWith: desktop,
    invoke,
    synchronousChannels,
    listeners,
    setPending: (value: unknown): void => { pending = value; }
  };
}

describe("main application preload deep-link occurrence fence", () => {
  it("captures the host-owned occurrence once before any other bridge query without exposing capture", () => {
    const loaded = loadPreload("document-current");

    expect(loaded.synchronousChannels).toEqual([
      "joko:main-document:occurrence:get",
      "joko:files:open-with:document:capture",
      "joko:native-task-status:availability:get",
      "joko:locale:preferred-system:get"
    ]);
    expect(Reflect.has(loaded.exposed, "mainDocumentOccurrence")).toBe(false);
    expect(Reflect.has(loaded.exposed, "mainDocumentOccurrenceGet")).toBe(false);
  });

  it("creates the private v4 claim with random bytes when randomUUID is unavailable", () => {
    const loaded = loadPreload("document-current", {
      getRandomValues: (bytes) => {
        bytes.fill(0);
        bytes[15] = 1;
        return bytes;
      }
    });
    expect(loaded.synchronousChannels[0]).toBe("joko:main-document:occurrence:get");
  });

  it("drops a live delivery from a retired Document before renderer side effects", () => {
    const loaded = loadPreload("document-current");
    const listener = vi.fn();
    loaded.deepLinks.onNavigate(listener);

    loaded.listeners.get("joko:deep-link:navigate")?.({}, delivery("document-retired"));
    expect(listener).not.toHaveBeenCalled();

    const current = delivery("document-current", 2);
    loaded.listeners.get("joko:deep-link:navigate")?.({}, current);
    expect(listener).toHaveBeenCalledExactlyOnceWith(current);
  });

  it("rejects stale pulls and acknowledgements while accepting the captured occurrence", async () => {
    const loaded = loadPreload("document-current");
    loaded.setPending(delivery("document-retired"));
    await expect(loaded.deepLinks.takePending()).rejects.toThrow(/Document occurrence/u);

    const current = delivery("document-current", 2);
    loaded.setPending(current);
    await expect(loaded.deepLinks.takePending()).resolves.toEqual(current);
    await expect(loaded.deepLinks.acknowledge({
      documentOccurrence: "document-retired",
      deliveryOccurrence: 2
    })).rejects.toThrow(/Document occurrence/u);
    expect(loaded.invoke).not.toHaveBeenCalledWith("joko:deep-link:acknowledge", expect.anything());
    await expect(loaded.deepLinks.acknowledge({
      documentOccurrence: "document-current",
      deliveryOccurrence: 2
    })).resolves.toBe(true);
  });
});

describe("application preload open-with Document occurrence fence", () => {
  const LIST = "00000000-0000-4000-8000-000000000011";
  const REQUEST = "00000000-0000-4000-8000-000000000012";
  const APP = "00000000-0000-4000-8000-000000000013";

  it("advertises only after Windows capture and privately binds list/open/retire/cancel", async () => {
    const loaded = loadPreload("document-current");
    expect(loaded.exposed["capabilities"]).toContain("files.openWith");
    expect(Reflect.has(loaded.exposed, "openWithDocumentOccurrence")).toBe(false);

    await loaded.openWith.listOpenWithApps({ listOccurrence: LIST, name: "report.txt" });
    await loaded.openWith.openFileWithApp({
      requestId: REQUEST,
      listOccurrence: LIST,
      appId: APP,
      file: { name: "report.txt", mediaType: "text/plain", bytes: new Uint8Array([1]) }
    });
    await loaded.openWith.retireOpenWithApps(LIST);
    await loaded.openWith.cancelFileOpen(REQUEST);

    expect(loaded.invoke).toHaveBeenCalledWith(DESKTOP_CHANNELS.listOpenWithApps, {
      documentOccurrence: "00000000-0000-4000-8000-000000000010",
      listOccurrence: LIST,
      name: "report.txt"
    });
    expect(loaded.invoke).toHaveBeenCalledWith(DESKTOP_CHANNELS.openFileWithApp, {
      appId: APP,
      documentOccurrence: "00000000-0000-4000-8000-000000000010",
      file: { name: "report.txt", mediaType: "text/plain", bytes: expect.any(Uint8Array) },
      listOccurrence: LIST,
      requestId: REQUEST
    });
    expect(loaded.invoke).toHaveBeenCalledWith(DESKTOP_CHANNELS.retireOpenWithApps, {
      documentOccurrence: "00000000-0000-4000-8000-000000000010",
      listOccurrence: LIST
    });
    expect(loaded.invoke).toHaveBeenCalledWith(
      DESKTOP_CHANNELS.cancelFileOpen,
      REQUEST,
      "00000000-0000-4000-8000-000000000010"
    );
  });

  it("fails closed off Windows or when the capture is rejected", async () => {
    const linux = loadPreload("document-current", { randomUUID: () => MAIN_DOCUMENT_CLAIM }, "en", "linux");
    expect(linux.exposed["capabilities"]).not.toContain("files.openWith");
    await expect(linux.openWith.listOpenWithApps({ listOccurrence: LIST, name: "report.txt" }))
      .rejects.toThrow(/unavailable/u);

    const rejected = loadPreload(
      "document-current",
      { randomUUID: () => MAIN_DOCUMENT_CLAIM },
      "en",
      "win32",
      undefined,
      null
    );
    expect(rejected.exposed["capabilities"]).not.toContain("files.openWith");
    await expect(rejected.openWith.openFileWithApp({
      requestId: REQUEST,
      listOccurrence: LIST,
      appId: APP,
      file: { name: "report.txt", mediaType: "text/plain", bytes: new Uint8Array([1]) }
    })).rejects.toThrow(/unavailable/u);
  });
});

describe("application preload native gamepad Document occurrence fence", () => {
  it("advertises the capability only after capture and privately binds every request", async () => {
    const loaded = loadPreload(
      "document-current",
      { randomUUID: () => MAIN_DOCUMENT_CLAIM },
      "en",
      "darwin",
      "native-gamepad-current"
    );

    expect(loaded.synchronousChannels).toEqual([
      "joko:main-document:occurrence:get",
      "joko:native-gamepad:document:capture",
      "joko:native-task-status:availability:get",
      "joko:locale:preferred-system:get"
    ]);
    expect(loaded.exposed["capabilities"]).toContain("hardware.nativeGamepad");
    expect(Reflect.has(loaded.exposed, "nativeGamepadDocumentOccurrence")).toBe(false);

    await expect(loaded.nativeGamepad.getSnapshot()).resolves.toEqual({
      version: 1, revision: 0, status: "idle", devices: []
    });
    await expect(loaded.nativeGamepad.setClientState({ version: 1, enabled: true, preview: false }))
      .resolves.toMatchObject({ status: "idle" });
    await expect(loaded.nativeGamepad.probe()).resolves.toMatchObject({ status: "idle" });
    expect(loaded.invoke).toHaveBeenCalledWith(
      DESKTOP_CHANNELS.nativeGamepadGetSnapshot,
      "native-gamepad-current"
    );
    expect(loaded.invoke).toHaveBeenCalledWith(
      DESKTOP_CHANNELS.nativeGamepadSetClientState,
      "native-gamepad-current",
      { version: 1, enabled: true, preview: false }
    );
    expect(loaded.invoke).toHaveBeenCalledWith(
      DESKTOP_CHANNELS.nativeGamepadProbe,
      "native-gamepad-current"
    );
  });

  it("fails closed without advertising or invoking when capture is rejected", async () => {
    const loaded = loadPreload(
      "document-current",
      { randomUUID: () => MAIN_DOCUMENT_CLAIM },
      "en",
      "darwin",
      null
    );

    expect(loaded.exposed["capabilities"]).not.toContain("hardware.nativeGamepad");
    await expect(loaded.nativeGamepad.getSnapshot()).rejects.toThrow(/unavailable/u);
    await expect(loaded.nativeGamepad.setClientState({ version: 1, enabled: true, preview: false }))
      .rejects.toThrow(/unavailable/u);
    await expect(loaded.nativeGamepad.probe()).rejects.toThrow(/unavailable/u);
    expect(loaded.invoke.mock.calls.some(([channel]) => String(channel).startsWith("joko:native-gamepad:")))
      .toBe(false);
  });
});

describe("main application preload preferred system locale", () => {
  it("exposes only the strict effective locale from the synchronous host projection", () => {
    const loaded = loadPreload("document-current");

    expect(DESKTOP_CHANNELS.preferredSystemLocaleGet).toBe("joko:locale:preferred-system:get");
    expect(loaded.exposed["preferredSystemLocale"]).toBe("zh-CN");
    expect(Object.isFrozen(loaded.exposed)).toBe(true);
    expect(Reflect.has(loaded.exposed, "setPreferredSystemLocale")).toBe(false);
  });

  it.each(["system", "en-XA", "ja", ["zh-CN"], null])(
    "fails closed instead of exposing malformed host locale %j",
    (locale) => {
      const loaded = loadPreload("document-current", { randomUUID: () => MAIN_DOCUMENT_CLAIM }, locale);
      expect(loaded.exposed["preferredSystemLocale"]).toBe("en");
    }
  );
});

describe("main application preload update settings observers", () => {
  it.each([
    ["onAutoRelaunchSettings", DESKTOP_CHANNELS.updateAutoRelaunchSettingsChanged, { autoRelaunchOnIdle: true, isCustomized: true, defaultAutoRelaunchOnIdle: false }],
    ["onChannelSettings", DESKTOP_CHANNELS.updateChannelSettingsChanged, { enableBeta: true, isCustomized: true, defaultEnableBeta: false }]
  ] as const)("validates and retires %s messages", (method, channel, settings) => {
    const loaded = loadPreload("document-current");
    const updates = loaded.exposed["updates"] as Record<typeof method, (listener: (value: unknown) => void) => () => void>;
    const listener = vi.fn();
    const unsubscribe = updates[method](listener);
    const wrapped = loaded.listeners.get(channel);
    expect(wrapped).toBeTypeOf("function");
    wrapped?.({}, settings);
    expect(listener).toHaveBeenCalledExactlyOnceWith(settings);
    wrapped?.({}, { ...settings, isCustomized: "true" });
    wrapped?.({}, { ...settings, extra: true });
    wrapped?.({}, null);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(loaded.listeners.has(channel)).toBe(false);
  });
});

describe("main application preload keep-awake observer", () => {
  it("delivers only exact keep-awake settings and removes the wrapped listener", () => {
    const loaded = loadPreload("document-current");
    const listener = vi.fn();
    const unsubscribe = loaded.power.onKeepAwakeChanged(listener);

    expect(DESKTOP_CHANNELS.keepAwakeChanged).toBe("joko:power:keep-awake:changed");
    const wrapped = loaded.listeners.get(DESKTOP_CHANNELS.keepAwakeChanged);
    expect(wrapped).toBeTypeOf("function");

    wrapped?.({}, { enabled: true });
    expect(listener).toHaveBeenCalledExactlyOnceWith({ enabled: true });

    wrapped?.({}, { enabled: "true" });
    wrapped?.({}, { enabled: false, unexpected: true });
    wrapped?.({}, null);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(loaded.listeners.has(DESKTOP_CHANNELS.keepAwakeChanged)).toBe(false);
    loaded.listeners.get(DESKTOP_CHANNELS.keepAwakeChanged)?.({}, { enabled: false });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-function keep-awake listener before registering IPC", () => {
    const loaded = loadPreload("document-current");
    const subscribe = loaded.power.onKeepAwakeChanged as unknown as (listener: unknown) => () => void;

    expect(() => subscribe(null)).toThrow(/listener must be a function/u);
    expect(loaded.listeners.has(DESKTOP_CHANNELS.keepAwakeChanged)).toBe(false);
  });
});
