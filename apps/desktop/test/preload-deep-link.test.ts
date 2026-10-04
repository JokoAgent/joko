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
  } = { randomUUID: () => MAIN_DOCUMENT_CLAIM }
): {
  readonly exposed: Readonly<Record<string, unknown>>;
  readonly deepLinks: DeepLinkApi;
  readonly power: KeepAwakeApi;
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
  const invoke = vi.fn(async (channel: string): Promise<unknown> => {
    if (channel === "joko:deep-link:take-pending") return pending;
    if (channel === "joko:deep-link:acknowledge") return true;
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
        return channel === "joko:main-document:occurrence:get" ? documentOccurrence : false;
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
    process: { platform: "win32" },
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
    Uint8Array,
    ArrayBuffer,
    structuredClone
  });
  const desktop = exposed as Readonly<Record<string, unknown>> & {
    readonly deepLinks: DeepLinkApi;
    readonly power: KeepAwakeApi;
  };
  return {
    exposed: desktop,
    deepLinks: desktop.deepLinks,
    power: desktop.power,
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
      "joko:native-task-status:availability:get"
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
