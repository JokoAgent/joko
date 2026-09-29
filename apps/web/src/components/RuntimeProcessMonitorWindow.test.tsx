// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeProcessMonitorWindow } from "./RuntimeProcessMonitorWindow.js";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  Reflect.deleteProperty(document, "visibilityState");
  Reflect.deleteProperty(window, "jokoRuntimeProcessDiagnostics");
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("RuntimeProcessMonitorWindow", () => {
  it("subscribes before resolving its exact owner and uses only the dedicated diagnostics bridge", async () => {
    const sequence: string[] = [];
    let responseListener: ((response: DesktopRuntimeProcessMonitorResponse) => void) | undefined;
    let retiredListener: (() => void) | undefined;
    const request = vi.fn(async (message: DesktopRuntimeProcessMonitorRequest) => {
      if (message.action.kind === "terminate") {
        queueMicrotask(() => responseListener?.({
          version: 1,
          requestId: message.requestId,
          owner: message.owner,
          result: { kind: "terminated" }
        }));
        return;
      }
      queueMicrotask(() => responseListener?.({
        version: 1,
        requestId: message.requestId,
        owner: message.owner,
        result: {
          kind: "snapshot",
          locale: "en",
          backends: [{
            backendId: "backend-local",
            backendGeneration: "1",
            backendName: "Local runtime",
            usageSupported: true,
            terminateSupported: true,
            state: "ready",
            capturedAt: 1_700_000_000_000,
            processes: [runtimeProcess()]
          }],
          sessions: [{ sessionId: "session-local", backendId: "backend-local", sessionName: "Local task", generation: "4" }]
        }
      }));
    });
    Object.defineProperty(window, "jokoRuntimeProcessDiagnostics", {
      configurable: true,
      value: {
        version: 1,
        platform: "darwin",
        window: windowControls(),
        onResponse(listener: (response: DesktopRuntimeProcessMonitorResponse) => void) {
          sequence.push("response");
          responseListener = listener;
          return () => { responseListener = undefined; };
        },
        onRetired(listener: () => void) {
          sequence.push("retired");
          retiredListener = listener;
          return () => { retiredListener = undefined; };
        },
        async getOwner() {
          sequence.push("owner");
          return owner;
        },
        sampleDesktop: vi.fn(async () => desktopSample()),
        request
      } satisfies JokoRuntimeProcessDiagnosticsApi
    });

    const container = await render();
    await vi.waitFor(() => expect(container.querySelectorAll('[role="row"][tabindex="0"]')).toHaveLength(2));
    expect(sequence.slice(0, 3)).toEqual(["response", "retired", "owner"]);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ owner, action: { kind: "refresh" } }));
    expect(container.textContent).toContain("Local task");
    expect(container.textContent).toContain("Updated");

    await act(async () => container.querySelector<HTMLElement>('[role="row"][tabindex="0"]')?.click());
    await act(async () => container.querySelector<HTMLButtonElement>(".runtime-process-footer .button")?.click());
    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]');
    await act(async () => dialog?.querySelector<HTMLButtonElement>(".button--danger")?.click());
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(expect.objectContaining({
      owner,
      action: expect.objectContaining({ kind: "terminate", backendGeneration: "1", process: runtimeProcess() })
    })));

    await act(async () => retiredListener?.());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Connect a Joko node in the main window");
  });

  it("renders a bounded unavailable state when the dedicated bridge is absent", async () => {
    const container = await render();
    expect(container.querySelector("h1")?.textContent).toBe("Runtime resource usage");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Connect a Joko node in the main window");
  });

  it("does not sample while its native window is hidden and refreshes when shown", async () => {
    let visibility: DocumentVisibilityState = "hidden";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility
    });
    const request = vi.fn(async () => undefined);
    const sampleDesktop = vi.fn(async () => desktopSample());
    Object.defineProperty(window, "jokoRuntimeProcessDiagnostics", {
      configurable: true,
      value: {
        version: 1,
        platform: "win32",
        window: windowControls(),
        getOwner: vi.fn(async () => owner),
        sampleDesktop,
        request,
        onResponse: vi.fn(() => () => undefined),
        onRetired: vi.fn(() => () => undefined)
      } satisfies JokoRuntimeProcessDiagnosticsApi
    });

    await render();
    await act(async () => Promise.resolve());
    expect(request).not.toHaveBeenCalled();
    expect(sampleDesktop).not.toHaveBeenCalled();

    visibility = "visible";
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(expect.objectContaining({
      owner,
      action: { kind: "refresh" }
    })));
    expect(sampleDesktop).toHaveBeenCalledOnce();
  });
});

const owner: DesktopRuntimeProcessMonitorOwner = {
  version: 1,
  profileId: "profile-local",
  serverId: "server-local",
  connectionGeneration: "1",
  snapshotGeneration: "1"
};

async function render(): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<RuntimeProcessMonitorWindow />));
  return container;
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

function desktopSample(): DesktopRuntimeProcessSample {
  return {
    version: 1,
    capturedAt: 1_700_000_000_000,
    processes: [{ role: "main", pid: 41, label: null, cpuPercent: 1, memoryKb: 2_048, processCount: 1 }]
  };
}

function windowControls(): JokoRuntimeProcessDiagnosticsApi["window"] {
  return {
    minimize: vi.fn(async () => undefined),
    toggleMaximize: vi.fn(async () => false),
    setZoomFactor: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined)
  };
}
