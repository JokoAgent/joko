// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import type { SimulatorViewerInstanceView, SimulatorViewerStateView } from "../model.js";
import { SimulatorViewerPanel } from "./SimulatorViewerPanel.js";

const roots: Root[] = [];
const route = { instanceId: "instance-one", generation: 2n, leaseId: "lease-one" } as const;
const created: SimulatorViewerInstanceView = {
  route, simulatorUdid: "A0123456-1234-1234-1234-123456789ABC", simulatorName: "Joko iPhone",
  runtimeIdentifier: "iOS-19", deviceTypeIdentifier: "iPhone-17", creationProvenance: "joko",
  lifecycleState: "ready", viewerState: "attached", healthState: "healthy"
};
const external: SimulatorViewerInstanceView = {
  ...created, route: { instanceId: "external-one", generation: 1n, leaseId: "lease-two" },
  simulatorUdid: "B0123456-1234-1234-1234-123456789ABC", simulatorName: "Shared iPhone",
  creationProvenance: "external"
};
const state: SimulatorViewerStateView = {
  support: "supported", devices: [{ udid: created.simulatorUdid, name: "Template iPhone",
    state: "Shutdown", runtimeIdentifier: "iOS-19", runtimeName: "iOS 19",
    deviceTypeIdentifier: "iPhone-17", available: true }], instances: [created, external]
};

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
});

it("mounts the task grid and confirms deletion only for an exact Joko-created instance", async () => {
  let current = state;
  const read = vi.fn(async () => current);
  const control = vi.fn(async (_sessionId: string, _requestId: string,
    input: Parameters<AppController["controlSimulatorInstance"]>[2]) => {
    expect(input).toEqual({ action: "delete", route });
    current = { ...current, instances: [external] };
    return { instance: created, deleted: true, replayed: false };
  });
  const container = await mount(read, control);
  expect(container.querySelectorAll(".simulator-viewer__card")).toHaveLength(2);
  expect(container.textContent).toContain("Live screen is not available yet");
  expect(container.textContent).toContain("Detach the current instance before adding another");
  expect(button(container, "Attach").disabled).toBe(true);
  expect([...container.querySelectorAll(".simulator-viewer__card")][1]?.textContent).not.toContain("Delete");
  await act(async () => button(container, "Delete").click());
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("Joko iPhone");
  expect(control).not.toHaveBeenCalled();
  await act(async () => button(document, "Cancel").click());
  expect(control).not.toHaveBeenCalled();
  await act(async () => button(container, "Delete").click());
  await act(async () => button(document, "Delete device").click());
  expect(control).toHaveBeenCalledOnce();
  expect(control.mock.calls[0]?.[0]).toBe("task-one");
  expect(control.mock.calls[0]?.[1]).toMatch(/^[0-9a-f-]{36}$/u);
  expect(read).toHaveBeenCalledTimes(2);
  expect(container.querySelectorAll(".simulator-viewer__card")).toHaveLength(1);
  expect(document.activeElement?.textContent).toContain("Refresh");
});

it("reobserves an uncertain action without redispatch and disables controls while disconnected", async () => {
  const read = vi.fn(async () => state);
  const control = vi.fn(async () => { throw new Error("transport interrupted"); });
  const container = await mount(read, control);
  await act(async () => button(container, "Stop").click());
  expect(control).toHaveBeenCalledOnce();
  expect(read).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("not confirmed");
  expect(control).toHaveBeenCalledTimes(1);
  expect(button(container, "Stop").disabled).toBe(true);
  const disconnected = await mount(read, control, false);
  expect(disconnected.textContent).toContain("Connection lost");
  expect([...disconnected.querySelectorAll<HTMLButtonElement>("button")].every(item => item.disabled)).toBe(true);
});

it("keeps the same task observation across unrelated controller snapshots", async () => {
  const read = vi.fn(async () => state);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const render = async (revision: number) => act(async () => root.render(<SimulatorViewerPanel
    controller={{ state: { connectionState: "connected", activeProfile: { id: "local" }, revision },
      getSimulatorViewerState: read } as unknown as AppController}
    sessionId="task-one" active t={(key, values) => translate("en", key, values)} />));
  await render(1);
  await render(2);
  expect(read).toHaveBeenCalledOnce();
  expect(container.querySelectorAll(".simulator-viewer__card")).toHaveLength(2);
});

async function mount(read: AppController["getSimulatorViewerState"],
  control: AppController["controlSimulatorInstance"], connected = true): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const controller = { state: { connectionState: connected ? "connected" : "offline" },
    getSimulatorViewerState: read, controlSimulatorInstance: control } as unknown as AppController;
  await act(async () => root.render(<SimulatorViewerPanel controller={controller} sessionId="task-one" active t={(key, values) => translate("en", key, values)} />));
  return container;
}

function button(root: ParentNode, name: string): HTMLButtonElement {
  const value = [...root.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === name);
  if (!value) throw new Error(`Missing ${name} button`);
  return value;
}
