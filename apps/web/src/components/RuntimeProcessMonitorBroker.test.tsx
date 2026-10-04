// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { emptySnapshot, type AppSnapshot } from "../model.js";
import { RuntimeProcessMonitorBroker } from "./RuntimeProcessMonitorBroker.js";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  Reflect.deleteProperty(window, "jokoDesktop");
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("RuntimeProcessMonitorBroker", () => {
  it("returns a direct, per-Backend snapshot and rejects a different owner occurrence", async () => {
    let listener: ((request: DesktopRuntimeProcessMonitorRequest) => void) | undefined;
    const respond = vi.fn(async (_response: DesktopRuntimeProcessMonitorResponse) => undefined);
    installDesktopBroker((next) => { listener = next; }, respond);
    const listRuntimeProcesses = vi.fn(async (backendId: string) => {
      if (backendId === "backend-broken") throw new Error("sampling unavailable");
      return { capturedAt: 123, processes: [runtimeProcess()] };
    });
    await render(controller(1, listRuntimeProcesses));

    listener?.(refreshRequest(owner("1"), "10000000-0000-4000-8000-000000000001"));
    await vi.waitFor(() => expect(respond).toHaveBeenCalledOnce());
    const response = respond.mock.calls[0]![0];
    expect(response.result.kind).toBe("snapshot");
    expect(response.result).not.toHaveProperty("snapshot");
    if (response.result.kind !== "snapshot") throw new Error("expected snapshot");
    expect(response.result.locale).toBe("zh-CN");
    expect(response.result.backends.find((backend) => backend.backendId === "backend-local"))
      .toMatchObject({ backendId: "backend-local", backendGeneration: "1", state: "ready", capturedAt: 123 });
    expect(response.result.backends.find((backend) => backend.backendId === "backend-broken")).toEqual({
      backendId: "backend-broken",
      backendGeneration: "1",
      backendName: "Broken runtime",
      usageSupported: true,
      terminateSupported: false,
      state: "error",
      error: "sampling unavailable"
    });

    listener?.(refreshRequest(owner("2"), "10000000-0000-4000-8000-000000000002"));
    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(2));
    expect(respond.mock.calls[1]![0].result).toMatchObject({ kind: "error", message: expect.stringContaining("no longer current") });
    expect(listRuntimeProcesses).toHaveBeenCalledTimes(2);
  });

  it("aborts an in-flight request when the renderer owner changes and emits no late response", async () => {
    let listener: ((request: DesktopRuntimeProcessMonitorRequest) => void) | undefined;
    const respond = vi.fn(async (_response: DesktopRuntimeProcessMonitorResponse) => undefined);
    const retire = installDesktopBroker((next) => { listener = next; }, respond);
    let resolveList: ((value: { capturedAt: number; processes: readonly DesktopRuntimeProcessMonitorProcess[] }) => void) | undefined;
    const listRuntimeProcesses = vi.fn(() => new Promise<{ capturedAt: number; processes: readonly DesktopRuntimeProcessMonitorProcess[] }>((resolve) => {
      resolveList = resolve;
    }));
    const { root } = await render(controller(1, listRuntimeProcesses, false));
    listener?.(refreshRequest(owner("1"), "10000000-0000-4000-8000-000000000003"));
    await vi.waitFor(() => expect(listRuntimeProcesses).toHaveBeenCalledOnce());

    await act(async () => root.render(<RuntimeProcessMonitorBroker controller={controller(2, listRuntimeProcesses, false)} />));
    expect(retire).toHaveBeenCalledWith(owner("1"));
    resolveList?.({ capturedAt: 456, processes: [] });
    await act(async () => Promise.resolve());
    expect(respond).not.toHaveBeenCalled();
  });
});

function installDesktopBroker(
  setListener: (listener: (request: DesktopRuntimeProcessMonitorRequest) => void) => void,
  respond: (response: DesktopRuntimeProcessMonitorResponse) => Promise<void>
): ReturnType<typeof vi.fn> {
  const retire = vi.fn(async () => undefined);
  Object.defineProperty(window, "jokoDesktop", {
    configurable: true,
    value: {
      runtimeProcessMonitor: {
        open: vi.fn(),
        retire,
        onRequest(listener: (request: DesktopRuntimeProcessMonitorRequest) => void) {
          setListener(listener);
          return () => undefined;
        },
        respond
      }
    } as unknown as JokoDesktopApi
  });
  return retire;
}

async function render(value: AppController): Promise<{ readonly root: Root; readonly container: HTMLDivElement }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<RuntimeProcessMonitorBroker controller={value} />));
  return { root, container };
}

function controller(
  connectionGeneration: number,
  listRuntimeProcesses: AppController["listRuntimeProcesses"],
  includeBroken = true
): AppController {
  const value = snapshot(includeBroken);
  return {
    state: {
      ready: true,
      connectionState: "connected",
      connectionGeneration,
      activeProfile: { id: "profile-local", deviceId: "device-local", serverId: "server-local", name: "Local", origin: "http://127.0.0.1" },
      preferences: { locale: "system" },
      systemLocale: "zh-CN",
      effectiveLocale: "zh-CN",
      snapshot: value
    },
    listRuntimeProcesses,
    terminateRuntimeProcess: vi.fn(async () => undefined)
  } as unknown as AppController;
}

function snapshot(includeBroken: boolean): AppSnapshot {
  const base = emptySnapshot();
  const usage = { name: "runtime.process_usage", supported: true, options: [] };
  const terminate = { name: "runtime.process_terminate", supported: true, options: [] };
  const readOnlyTerminate = { ...terminate, supported: false };
  return {
    ...base,
    revision: 1n,
    generation: 1n,
    backends: [
      { id: "backend-local", name: "Local runtime", version: "1", health: "healthy", instanceGeneration: 1, capabilities: new Map([[usage.name, usage], [terminate.name, terminate]]) },
      ...(includeBroken ? [{ id: "backend-broken", name: "Broken runtime", version: "1", health: "degraded" as const, instanceGeneration: 1, capabilities: new Map([[usage.name, usage], [terminate.name, readOnlyTerminate]]) }] : [])
    ],
    sessions: [{ id: "session-local", backendId: "backend-local", targetId: "target", name: "Local task", state: "idle", pinned: false, archived: false, generation: 4n, fastMode: false, permissionMode: "ask", planMode: false, updatedAt: 1 }]
  };
}

function owner(connectionGeneration: string): DesktopRuntimeProcessMonitorOwner {
  return {
    version: 1,
    profileId: "profile-local",
    serverId: "server-local",
    connectionGeneration,
    snapshotGeneration: "1"
  };
}

function refreshRequest(ownerValue: DesktopRuntimeProcessMonitorOwner, requestId: string): DesktopRuntimeProcessMonitorRequest {
  return { version: 1, requestId, owner: ownerValue, action: { kind: "refresh" } };
}

function runtimeProcess(): DesktopRuntimeProcessMonitorProcess {
  return {
    backendId: "backend-local",
    role: "task-host",
    sessionId: "session-local",
    generation: 4,
    pid: 42,
    cpuPercent: 2.5,
    memoryKb: 1024,
    processCount: 1,
    terminable: true,
    processInstanceId: "10000000-0000-4000-8000-000000000042"
  };
}
