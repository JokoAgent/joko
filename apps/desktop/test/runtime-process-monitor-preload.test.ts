import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { describe, expect, it, vi } from "vitest";

const OWNER = Object.freeze({
  version: 1,
  profileId: "profile-1",
  serverId: "server-1",
  connectionGeneration: "2",
  snapshotGeneration: "4"
});
const REQUEST = Object.freeze({
  version: 1,
  requestId: "00000000-0000-4000-8000-000000000001",
  owner: OWNER,
  action: Object.freeze({ kind: "refresh" })
});
const RESPONSE = Object.freeze({
  version: 1,
  requestId: REQUEST.requestId,
  owner: OWNER,
  result: Object.freeze({
    kind: "snapshot",
    locale: "en",
    backends: Object.freeze([Object.freeze({
      backendId: "backend-1",
      backendGeneration: "8",
      backendName: "Local runtime",
      usageSupported: true,
      terminateSupported: false,
      state: "ready",
      capturedAt: 100,
      processes: Object.freeze([Object.freeze({
        backendId: "backend-1",
        role: "task-host",
        sessionId: "session-1",
        generation: 5,
        pid: 123,
        cpuPercent: 0.5,
        memoryKb: 4_096,
        processCount: 1,
        terminable: false
      })])
    })]),
    sessions: Object.freeze([Object.freeze({
      sessionId: "session-1",
      backendId: "backend-1",
      sessionName: "Task one",
      generation: "5"
    })])
  })
});
const DESKTOP_SAMPLE = Object.freeze({
  version: 1,
  capturedAt: 200,
  processes: Object.freeze([Object.freeze({
    role: "renderer",
    pid: 222,
    label: "Task one",
    cpuPercent: 1.25,
    memoryKb: 8_192,
    processCount: 1
  })])
});

interface DiagnosticsApi {
  readonly version: number;
  readonly platform: string;
  readonly window: {
    minimize(): Promise<void>;
    toggleMaximize(): Promise<boolean>;
    setZoomFactor(value: number): Promise<void>;
    close(): Promise<void>;
  };
  getOwner(): Promise<unknown>;
  sampleDesktop(): Promise<unknown>;
  request(request: unknown): Promise<void>;
  onResponse(listener: (response: unknown) => void): () => void;
  onRetired(listener: () => void): () => void;
}

function loadPreload(): {
  readonly api: DiagnosticsApi;
  readonly invoke: ReturnType<typeof vi.fn>;
  readonly listeners: Map<string, (...parameters: unknown[]) => void>;
  readonly removeListener: ReturnType<typeof vi.fn>;
  readonly exposedNames: readonly string[];
} {
  const source = readFileSync(new URL("../src/runtime-process-monitor-preload.cts", import.meta.url), "utf8");
  const output = transpileModule(source, {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
  }).outputText;
  const listeners = new Map<string, (...parameters: unknown[]) => void>();
  const invoke = vi.fn(async (channel: string): Promise<unknown> => {
    if (channel === "joko:runtime-process-diagnostics:owner:get") return OWNER;
    if (channel === "joko:runtime-process-monitor:sample-desktop") return DESKTOP_SAMPLE;
    if (channel === "joko:window:toggle-maximize") return true;
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
    process: { platform: "linux" },
    console,
    Object,
    Promise,
    Set,
    Map,
    BigInt,
    Number,
    String,
    TypeError,
    RegExp
  });
  return {
    api: exposures.get("jokoRuntimeProcessDiagnostics") as DiagnosticsApi,
    invoke,
    listeners,
    removeListener,
    exposedNames: [...exposures.keys()]
  };
}

describe("runtime process monitor dedicated preload", () => {
  it("exposes one minimal world with only window controls and versioned diagnostics", async () => {
    const loaded = loadPreload();
    expect(loaded.exposedNames).toEqual(["jokoRuntimeProcessDiagnostics"]);
    expect(Object.keys(loaded.api).sort()).toEqual([
      "getOwner", "onResponse", "onRetired", "platform", "request", "sampleDesktop", "version", "window"
    ]);
    expect(Object.keys(loaded.api.window).sort()).toEqual([
      "close", "minimize", "setZoomFactor", "toggleMaximize"
    ]);
    expect(loaded.api).toMatchObject({ version: 1, platform: "linux" });
    await expect(loaded.api.getOwner()).resolves.toEqual(OWNER);
    await expect(loaded.api.sampleDesktop()).resolves.toEqual(DESKTOP_SAMPLE);
    await expect(loaded.api.window.toggleMaximize()).resolves.toBe(true);
    await expect(loaded.api.window.close()).resolves.toBeUndefined();
    expect(loaded.invoke).toHaveBeenCalledWith("joko:window:close");
    await expect(loaded.api.window.setZoomFactor(4)).rejects.toThrow(/zoom/u);
    expect(loaded.invoke).not.toHaveBeenCalledWith("joko:window:set-zoom-factor", 4);
  });

  it("strictly parses requests and projections and removes exact listeners", async () => {
    const loaded = loadPreload();
    await expect(loaded.api.request(REQUEST)).resolves.toBeUndefined();
    expect(loaded.invoke).toHaveBeenCalledWith("joko:runtime-process-diagnostics:request", REQUEST);
    expect(() => loaded.api.request({ ...REQUEST, bearer: "secret" })).toThrow(/request/u);
    loaded.invoke.mockImplementationOnce(async () => ({
      ...DESKTOP_SAMPLE,
      processes: [{ ...DESKTOP_SAMPLE.processes[0], terminable: true }]
    }));
    await expect(loaded.api.sampleDesktop()).rejects.toThrow(/metric/u);

    const onResponse = vi.fn();
    const releaseResponse = loaded.api.onResponse(onResponse);
    loaded.listeners.get("joko:runtime-process-diagnostics:response")?.({}, RESPONSE);
    expect(onResponse).toHaveBeenCalledWith(RESPONSE);
    loaded.listeners.get("joko:runtime-process-diagnostics:response")?.({}, {
      ...RESPONSE,
      result: { ...RESPONSE.result, backends: [{ ...RESPONSE.result.backends[0], backendGeneration: "08" }] }
    });
    expect(onResponse).toHaveBeenCalledTimes(1);
    releaseResponse();
    expect(loaded.removeListener).toHaveBeenCalledWith(
      "joko:runtime-process-diagnostics:response",
      expect.any(Function)
    );

    const onRetired = vi.fn();
    const releaseRetired = loaded.api.onRetired(onRetired);
    loaded.listeners.get("joko:runtime-process-diagnostics:retired")?.({});
    expect(onRetired).toHaveBeenCalledTimes(1);
    releaseRetired();
  });
});
