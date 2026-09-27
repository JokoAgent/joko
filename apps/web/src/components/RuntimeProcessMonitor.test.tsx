// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import { emptySnapshot, type AppSnapshot, type RuntimeProcessUsageView } from "../model.js";
import { terminateRuntimeProcessWithCurrentFence, type RuntimeProcessDiagnosticsSnapshot } from "../runtime-process-diagnostics.js";
import {
  formatRuntimeProcessCpu,
  formatRuntimeProcessMemory,
  mergeRuntimeProcessDiagnosticsDisplay,
  nextRuntimeProcessSort,
  RuntimeProcessMonitor,
  RuntimeProcessMonitorSurface,
  sortRuntimeProcesses,
  staleRuntimeProcessDiagnosticsDisplay,
  type RuntimeProcessDiagnosticsDisplay
} from "./RuntimeProcessMonitor.js";

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

describe("RuntimeProcessMonitor", () => {
  it("uses the compact process table's formatting and sort defaults", () => {
    expect(formatRuntimeProcessCpu(2.25)).toBe("2.3%");
    expect(formatRuntimeProcessCpu(12.6)).toBe("13%");
    expect(formatRuntimeProcessMemory(1536)).toBe("2 MB");
    expect(formatRuntimeProcessMemory(1572864)).toBe("1.5 GB");
    expect(nextRuntimeProcessSort({ key: "cpu", direction: "desc" }, "cpu")).toEqual({ key: "cpu", direction: "asc" });
    expect(nextRuntimeProcessSort({ key: "cpu", direction: "desc" }, "name")).toEqual({ key: "name", direction: "asc" });
    expect(sortRuntimeProcesses([process("beta", 10, 3), process("alpha", 11, 20)], { key: "cpu", direction: "desc" }, (item) => item.sessionId)
      .map((item) => item.sessionId)).toEqual(["alpha", "beta"]);
  });

  it("loads only capability-advertised roots and submits the complete selected spawn fence", async () => {
    let terminated = false;
    const rows = [process("beta", 10, 3), process("alpha", 11, 20)];
    const listRuntimeProcesses = vi.fn(async () => ({
      capturedAt: Date.now(),
      processes: terminated ? [] : rows
    }));
    const terminateRuntimeProcess = vi.fn(async (target: RuntimeProcessUsageView) => {
      expect(target).toBe(rows[1]);
      terminated = true;
    });
    const controller = { listRuntimeProcesses, terminateRuntimeProcess } as unknown as AppController;
    const container = await render(controller, snapshot(true));

    await vi.waitFor(() => expect(container.querySelectorAll('[role="row"][tabindex="0"]')).toHaveLength(2));
    expect(listRuntimeProcesses).toHaveBeenCalledWith("backend-local", expect.any(AbortSignal));
    expect([...container.querySelectorAll(".runtime-process-details > span:first-child")].map((item) => item.textContent)).toEqual([
      "Alpha task · 3 processes",
      "Beta task · 3 processes"
    ]);
    expect(container.querySelector('[aria-sort="descending"]')?.textContent).toContain("CPU");

    const alpha = [...container.querySelectorAll<HTMLElement>('[role="row"][tabindex="0"]')]
      .find((item) => item.textContent?.includes("Alpha task"));
    await act(async () => alpha?.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })));
    const terminate = container.querySelector<HTMLButtonElement>(".runtime-process-footer .button")!;
    expect(terminate.disabled).toBe(false);
    await act(async () => terminate.click());

    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain("Terminate Local runtime Alpha task?");
    await act(async () => dialog.parentElement?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(document.body.querySelector('[role="alertdialog"]')).toBe(dialog);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Back");

    await act(async () => dialog.querySelector<HTMLButtonElement>(".button--danger")?.click());
    await vi.waitFor(() => expect(terminateRuntimeProcess).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(container.querySelectorAll('[role="row"][tabindex="0"]')).toHaveLength(0));
    expect(container.textContent).toContain("No local runtime processes are running.");
  });

  it("does not make process RPCs when the Backend omits the inspection capability", async () => {
    const listRuntimeProcesses = vi.fn(async () => ({ capturedAt: Date.now(), processes: [] }));
    const container = await render({ listRuntimeProcesses } as unknown as AppController, snapshot(false));
    expect(container.textContent).toContain("This Backend cannot inspect service-node runtime processes.");
    expect(listRuntimeProcesses).not.toHaveBeenCalled();
  });

  it("opens the capability-advertised standalone Desktop monitor from the empty state", async () => {
    const open = vi.fn(async () => ({ version: 1 as const, focusedExisting: false }));
    Object.defineProperty(window, "jokoDesktop", {
      configurable: true,
      value: {
        capabilities: ["runtime.processMonitorWindow"],
        runtimeProcessMonitor: { open }
      } as unknown as JokoDesktopApi
    });
    const container = await render({
      listRuntimeProcesses: vi.fn(async () => ({ capturedAt: Date.now(), processes: [] }))
    } as unknown as AppController, snapshot(false));

    const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.textContent === "Open monitor window");
    expect(button).toBeDefined();
    await act(async () => button?.click());
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    expect(open).toHaveBeenCalledWith(owner());
  });

  it("retains only same-owner Backend data when a later sample partially fails", () => {
    const previous = display("owner-one", "ready", [process("alpha", 11, 20)], 100);
    const partial: RuntimeProcessDiagnosticsSnapshot = {
      locale: "en",
      backends: [{
        backendId: "backend-local",
        backendGeneration: "1",
        backendName: "Local runtime",
        usageSupported: true,
        terminateSupported: true,
        state: "error",
        error: "sample failed",
        processes: []
      }],
      sessions: previous.sessions
    };

    const stale = mergeRuntimeProcessDiagnosticsDisplay(previous, "owner-one", partial);
    expect(stale.backends[0]).toMatchObject({ state: "stale", capturedAt: 100, error: "sample failed" });
    expect(stale.backends[0]?.processes).toHaveLength(1);

    const differentOwner = mergeRuntimeProcessDiagnosticsDisplay(previous, "owner-two", partial);
    expect(differentOwner.backends[0]).toMatchObject({ state: "error", error: "sample failed" });
    expect(differentOwner.backends[0]?.processes).toHaveLength(0);

    const replacementBackend = mergeRuntimeProcessDiagnosticsDisplay(previous, "owner-one", {
      ...partial,
      backends: [{ ...partial.backends[0]!, backendGeneration: "2" }]
    });
    expect(replacementBackend.backends[0]).toMatchObject({ state: "error", backendGeneration: "2" });
    expect(replacementBackend.backends[0]?.processes).toHaveLength(0);

    const loadingFailure = staleRuntimeProcessDiagnosticsDisplay({
      ...previous,
      loaded: false,
      backends: [{ ...previous.backends[0]!, state: "loading", capturedAt: undefined, processes: [] }]
    }, "owner-one", "invalid Backend occurrence");
    expect(loadingFailure).toMatchObject({ loaded: true });
    expect(loadingFailure.backends[0]).toMatchObject({
      state: "error",
      error: "invalid Backend occurrence",
      processes: []
    });
  });

  it("clears selection and confirmation state when the Backend occurrence changes", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const renderSurface = async (value: RuntimeProcessDiagnosticsDisplay): Promise<void> => {
      await act(async () => root.render(<RuntimeProcessMonitorSurface
        display={value}
        runAction={(_key, work) => { void work(); }}
        t={(key, values) => translate("en", key, values)}
        onRefresh={async () => undefined}
        onTerminate={async () => undefined}
      />));
    };
    await renderSurface(display("owner-one", "ready", [process("alpha", 11, 20)], 100));
    await act(async () => container.querySelector<HTMLElement>('[role="row"][tabindex="0"]')?.click());
    await act(async () => container.querySelector<HTMLButtonElement>(".runtime-process-footer .button")?.click());
    expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull();

    await renderSurface(display("owner-one", "ready", [process("beta", 10, 3)], 200, "2"));
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    expect(container.querySelector('[aria-selected="true"]')).toBeNull();
  });

  it("re-reads the exact process instance fence before dispatching termination", async () => {
    const original = process("alpha", 11, 20);
    const replacement = { ...original, processInstanceId: "20000000-0000-4000-8000-000000000011" };
    const terminateRuntimeProcess = vi.fn(async () => undefined);
    await expect(terminateRuntimeProcessWithCurrentFence(
      {
        listRuntimeProcesses: vi.fn(async () => ({ capturedAt: 200, processes: [replacement] })),
        terminateRuntimeProcess
      },
      snapshot(true),
      original,
      "1"
    )).rejects.toThrow("no longer current");
    expect(terminateRuntimeProcess).not.toHaveBeenCalled();
  });
});

async function render(controller: AppController, value: AppSnapshot): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const connectedController = {
    ...controller,
    state: {
      ready: true,
      connectionState: "connected",
      connectionGeneration: 1,
      activeProfile: { id: "profile-local", deviceId: "device-local", serverId: "server-local", name: "Local", origin: "http://127.0.0.1" },
      preferences: { locale: "en" },
      snapshot: value
    }
  } as unknown as AppController;
  await act(async () => root.render(<RuntimeProcessMonitor
    controller={connectedController}
    snapshot={value}
    runAction={(_key, work) => { void work(); }}
    t={(key, values) => translate("en", key, values)}
  />));
  return container;
}

function snapshot(capable: boolean): AppSnapshot {
  const base = emptySnapshot();
  const capabilities = new Map([
    ["runtime.process_usage", { name: "runtime.process_usage", supported: capable, options: [] }],
    ["runtime.process_terminate", { name: "runtime.process_terminate", supported: capable, options: [] }]
  ]);
  return {
    ...base,
    revision: 1n,
    generation: 1n,
    backends: [{ id: "backend-local", name: "Local runtime", version: "1", health: "healthy", instanceGeneration: 1, capabilities }],
    sessions: [
      { id: "alpha", backendId: "backend-local", targetId: "target", name: "Alpha task", state: "idle", pinned: false, archived: false, generation: 4n, fastMode: false, permissionMode: "ask", planMode: false, updatedAt: 1 },
      { id: "beta", backendId: "backend-local", targetId: "target", name: "Beta task", state: "idle", pinned: false, archived: false, generation: 4n, fastMode: false, permissionMode: "ask", planMode: false, updatedAt: 1 }
    ]
  };
}

function owner(): DesktopRuntimeProcessMonitorOwner {
  return {
    version: 1,
    profileId: "profile-local",
    serverId: "server-local",
    connectionGeneration: "1",
    snapshotGeneration: "1"
  };
}

function display(
  ownerKey: string,
  state: "ready" | "stale",
  processes: readonly RuntimeProcessUsageView[],
  capturedAt: number,
  backendGeneration = "1"
): RuntimeProcessDiagnosticsDisplay {
  return {
    ownerKey,
    loaded: true,
    backends: [{
      backendId: "backend-local",
      backendGeneration,
      backendName: "Local runtime",
      usageSupported: true,
      terminateSupported: true,
      state,
      capturedAt,
      processes
    }],
    sessions: [
      { sessionId: "alpha", backendId: "backend-local", sessionName: "Alpha task", generation: "4" },
      { sessionId: "beta", backendId: "backend-local", sessionName: "Beta task", generation: "4" }
    ]
  };
}

function process(sessionId: string, pid: number, cpuPercent: number): RuntimeProcessUsageView {
  return {
    backendId: "backend-local",
    sessionId,
    generation: 4,
    pid,
    cpuPercent,
    memoryKb: pid * 1024,
    processCount: 3,
    terminable: true,
    processInstanceId: pid === 10
      ? "10000000-0000-4000-8000-000000000010"
      : "10000000-0000-4000-8000-000000000011"
  };
}
