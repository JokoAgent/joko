import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { describe, expect, it, vi } from "vitest";

interface VoiceOverlayApi {
  getStatus(): Promise<Readonly<Record<string, unknown>>>;
  onStatus(listener: (status: unknown) => void): () => void;
  getLocale(): Promise<unknown>;
  onLocale(listener: (locale: unknown) => void): () => void;
  cancel(): Promise<void>;
  retry(): Promise<void>;
}

const IDLE_STATUS = Object.freeze({ state: "idle", generation: "0" });

function loadPreload(): {
  readonly api: VoiceOverlayApi;
  readonly invoke: ReturnType<typeof vi.fn>;
  readonly listeners: Map<string, (...parameters: unknown[]) => void>;
  readonly removeListener: ReturnType<typeof vi.fn>;
  readonly exposedNames: readonly string[];
  setLocaleResult(value: unknown): void;
} {
  const source = readFileSync(new URL("../src/voice-overlay-preload.cts", import.meta.url), "utf8");
  const output = transpileModule(source, {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
  }).outputText;
  const listeners = new Map<string, (...parameters: unknown[]) => void>();
  let localeResult: unknown = "zh-CN";
  const invoke = vi.fn(async (channel: string): Promise<unknown> => {
    if (channel === "joko:global-voice:status:get") return IDLE_STATUS;
    if (channel === "joko:global-voice:overlay-locale:get") return localeResult;
    return undefined;
  });
  const removeListener = vi.fn((channel: string, listener: (...parameters: unknown[]) => void): void => {
    if (listeners.get(channel) === listener) listeners.delete(channel);
  });
  const exposures = new Map<string, unknown>();
  const electron = {
    contextBridge: {
      exposeInMainWorld: (name: string, value: unknown): void => { exposures.set(name, value); }
    },
    ipcRenderer: {
      invoke,
      on: (channel: string, listener: (...parameters: unknown[]) => void): void => { listeners.set(channel, listener); },
      removeListener
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
    console,
    Object,
    Promise,
    BigInt,
    Number,
    String,
    TypeError,
    RegExp,
    Array
  });
  return {
    api: exposures.get("jokoVoiceOverlay") as VoiceOverlayApi,
    invoke,
    listeners,
    removeListener,
    exposedNames: [...exposures.keys()],
    setLocaleResult: (value: unknown): void => { localeResult = value; }
  };
}

describe("global voice overlay dedicated preload", () => {
  it("adds a read-only locale projection without changing the status shape", async () => {
    const loaded = loadPreload();

    expect(loaded.exposedNames).toEqual(["jokoVoiceOverlay"]);
    expect(Object.keys(loaded.api).sort()).toEqual([
      "cancel", "getLocale", "getStatus", "onLocale", "onStatus", "retry"
    ]);
    await expect(loaded.api.getLocale()).resolves.toBe("zh-CN");
    await expect(loaded.api.getStatus()).resolves.toEqual(IDLE_STATUS);
    expect(loaded.invoke).toHaveBeenCalledWith("joko:global-voice:overlay-locale:get");
    expect(Object.keys(await loaded.api.getStatus())).toEqual(["state", "generation"]);
  });

  it("rejects every non-concrete locale returned by Main", async () => {
    const loaded = loadPreload();
    for (const invalid of ["system", "ja", "ko", { locale: "en" }, null, undefined]) {
      loaded.setLocaleResult(invalid);
      await expect(loaded.api.getLocale()).rejects.toThrow(/locale/u);
    }
    for (const locale of ["en", "zh-CN", "en-XA"]) {
      loaded.setLocaleResult(locale);
      await expect(loaded.api.getLocale()).resolves.toBe(locale);
    }
  });

  it("delivers only concrete locale changes and cleans up its exact listener once", () => {
    const loaded = loadPreload();
    const listener = vi.fn();
    const unsubscribe = loaded.api.onLocale(listener);
    const publish = loaded.listeners.get("joko:global-voice:overlay-locale:changed");

    publish?.({}, "en");
    publish?.({}, "zh-CN");
    publish?.({}, "en-XA");
    expect(listener.mock.calls.map(([locale]) => locale)).toEqual(["en", "zh-CN", "en-XA"]);

    for (const invalid of ["system", "ja", { locale: "en" }, null]) publish?.({}, invalid);
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
    unsubscribe();
    expect(loaded.removeListener).toHaveBeenCalledTimes(1);
    expect(loaded.removeListener).toHaveBeenCalledWith(
      "joko:global-voice:overlay-locale:changed",
      publish
    );
    expect(loaded.listeners.has("joko:global-voice:overlay-locale:changed")).toBe(false);
  });

  it("rejects a non-function locale observer before registering IPC", () => {
    const loaded = loadPreload();
    const subscribe = loaded.api.onLocale as unknown as (listener: unknown) => () => void;

    expect(() => subscribe(null)).toThrow(/listener must be a function/u);
    expect(loaded.listeners.has("joko:global-voice:overlay-locale:changed")).toBe(false);
  });
});
