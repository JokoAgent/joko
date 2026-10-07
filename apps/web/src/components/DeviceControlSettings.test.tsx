// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import { emptySnapshot, type AppSnapshot, type DeviceView } from "../model.js";
import {
  DeviceControlSettings,
  deviceControlRelation,
  sortControllableDevices
} from "./DeviceControlSettings.js";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("DeviceControlSettings", () => {
  it("uses an explicit permissive preference but an ineffective route when no relation was persisted", () => {
    expect(deviceControlRelation([], "controller", "target")).toEqual({
      id: "controller:target",
      controllerDeviceId: "controller",
      targetDeviceId: "target",
      outboundEnabled: true,
      inboundAllowed: true,
      effective: false,
      revision: 0n
    });
  });

  it("sorts online devices first and uses a deterministic name and id tie-break", () => {
    const devices = [
      device("offline-alpha", "Alpha", "offline"),
      device("online-zulu", "Zulu", "online"),
      device("online-alpha-b", "alpha", "online"),
      device("online-alpha-a", "Alpha", "online")
    ];

    expect(sortControllableDevices(devices).map((entry) => entry.id)).toEqual([
      "online-alpha-a",
      "online-alpha-b",
      "online-zulu",
      "offline-alpha"
    ]);
    expect(devices.map((entry) => entry.id)).toEqual([
      "offline-alpha",
      "online-zulu",
      "online-alpha-b",
      "online-alpha-a"
    ]);
  });

  it("renames the current device and changes its global receive opt-in", async () => {
    const renameDevice = vi.fn(async () => device("self", "Main desk", "online", { manualDisplayName: "Main desk", revision: 2n }));
    const setDeviceRemoteControlEnabled = vi.fn(async () => undefined);
    const rendered = await renderSettings(
      snapshot([device("self", "Desk", "online", { kind: "desktop" })]),
      { renameDevice, setDeviceRemoteControlEnabled }
    );

    const name = rendered.container.querySelector<HTMLInputElement>(".device-control-name-row input");
    if (name === null) throw new Error("Device name input was not rendered");
    await setInputValue(name, "  Main desk  ");
    await clickButton(rendered.container, "Save");
    await clickControl(rendered.container, 'button[aria-label="Allow remote control of this device"]');
    await rendered.flush();

    expect(renameDevice).toHaveBeenCalledWith("self", "Main desk", 1n);
    expect(setDeviceRemoteControlEnabled).toHaveBeenCalledWith(true);
    expect(rendered.actionKeys).toEqual(["device-remote-control"]);
  });

  it("keeps outbound intent and inbound permission as separate, peer-directed actions", async () => {
    const setDeviceControlTargetEnabled = vi.fn(async () => undefined);
    const setDeviceControllerAllowed = vi.fn(async () => undefined);
    const configured = snapshot(
      [
        device("self", "Desk", "online", { kind: "desktop", remoteControlEnabled: true }),
        device("peer", "Build node", "online", { kind: "service", remoteControlEnabled: true })
      ],
      [
        {
          id: "self:peer",
          controllerDeviceId: "self",
          targetDeviceId: "peer",
          outboundEnabled: false,
          inboundAllowed: true,
          effective: false,
          revision: 3n
        },
        {
          id: "peer:self",
          controllerDeviceId: "peer",
          targetDeviceId: "self",
          outboundEnabled: true,
          inboundAllowed: false,
          effective: false,
          revision: 4n
        }
      ]
    );
    const rendered = await renderSettings(configured, {
      setDeviceControlTargetEnabled,
      setDeviceControllerAllowed
    });

    const outbound = rendered.container.querySelector<HTMLButtonElement>('button[aria-label="Allow controlling Build node"]');
    const inbound = rendered.container.querySelector<HTMLButtonElement>('button[aria-label="Allow Build node to control this device"]');
    expect(outbound?.getAttribute("aria-checked")).toBe("false");
    expect(inbound?.getAttribute("aria-checked")).toBe("false");
    if (outbound === null || inbound === null) throw new Error("Two-sided controls were not rendered");
    await act(async () => outbound.click());
    await act(async () => inbound.click());
    await rendered.flush();

    expect(setDeviceControlTargetEnabled).toHaveBeenCalledWith("peer", true);
    expect(setDeviceControllerAllowed).toHaveBeenCalledWith("peer", true);
    expect(rendered.actionKeys).toEqual([
      "device-control-target:peer",
      "device-controller-allowed:peer"
    ]);
  });

  it.each(["self", "peer"])("lets %s explicitly save the effective name as a manual override and reset to the returned default", async (targetId) => {
    const renameDevice = vi.fn(async (id: string, name: string) => device(id, name, "online", {
      defaultDisplayName: "System name", manualDisplayName: name, revision: 2n
    }));
    const resetDeviceName = vi.fn(async (id: string) => device(id, "Updated system name", "online", {
      defaultDisplayName: "Updated system name", revision: 4n
    }));
    const initial = snapshot([
      device("self", "System name", "online"),
      device("peer", "System name", "offline")
    ]);
    const rendered = await renderSettings(initial, { renameDevice, resetDeviceName });
    const row = rendered.container.querySelector<HTMLElement>(targetId === "self" ? ".device-control-self" : ".device-control-peer");
    if (row === null) throw new Error("Device row missing");
    await clickButton(row, "Save");
    await rendered.flush();
    expect(renameDevice).toHaveBeenCalledWith(targetId, "System name", 1n);
    expect(row.textContent).toContain("Custom name · Default: System name");
    expect([...row.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save")?.disabled).toBe(true);

    await clickButton(row, "Restore default name");
    await rendered.flush();
    expect(resetDeviceName).toHaveBeenCalledWith(targetId, 2n);
    expect(row.querySelector<HTMLInputElement>("input")?.value).toBe("Updated system name");
    expect(row.textContent).toContain("Default name: Updated system name");
    await rendered.rerender(initial);
    expect(row.querySelector<HTMLInputElement>("input")?.value).toBe("Updated system name");
  });

  it("keeps a dirty name and its exact Device revision across live updates and failed CAS", async () => {
    const renameDevice = vi.fn().mockRejectedValueOnce(new Error("Device changed")).mockResolvedValueOnce(
      device("self", "Reviewed name", "online", { defaultDisplayName: "OS renamed", manualDisplayName: "Reviewed name", revision: 3n })
    );
    const rendered = await renderSettings(snapshot([device("self", "Desk", "online", { manualDisplayName: "Desk" })]), { renameDevice });
    const input = rendered.container.querySelector<HTMLInputElement>(".device-control-self input");
    if (input === null) throw new Error("Name input missing");
    await setInputValue(input, "My draft");
    await rendered.rerender(snapshot([device("self", "Desk", "online", {
      defaultDisplayName: "OS renamed", manualDisplayName: "Desk", revision: 2n
    })]));
    expect(input.value).toBe("My draft");
    await clickButton(rendered.container, "Save");
    await rendered.flush();
    expect(renameDevice).toHaveBeenCalledExactlyOnceWith("self", "My draft", 1n);
    expect(input.value).toBe("My draft");
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain("draft has been kept");
    await clickButton(rendered.container, "Cancel");
    expect(input.value).toBe("Desk");
    await setInputValue(input, "Reviewed name");
    await clickButton(rendered.container, "Save");
    await rendered.flush();
    expect(renameDevice).toHaveBeenLastCalledWith("self", "Reviewed name", 2n);
  });

  it("gates a name attempt synchronously and checks an unknown receipt without a second mutation", async () => {
    const nameAttempt = deferred<DeviceView>();
    const receiptCheck = deferred<DeviceView>();
    const renameDevice = vi.fn(() => nameAttempt.promise);
    const resetDeviceName = vi.fn();
    const checkDeviceNameUpdate = vi.fn(() => receiptCheck.promise);
    const rendered = await renderSettings(snapshot([device("self", "Desk", "online", { manualDisplayName: "Desk" })]), {
      renameDevice, resetDeviceName, checkDeviceNameUpdate
    });
    const input = rendered.container.querySelector<HTMLInputElement>(".device-control-self input");
    if (input === null) throw new Error("Name input missing");
    await setInputValue(input, "My draft");
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true })));
    expect(renameDevice).not.toHaveBeenCalled();
    const save = [...rendered.container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save");
    if (save === undefined) throw new Error("Save missing");
    await act(async () => { save.click(); save.click(); });
    expect(renameDevice).toHaveBeenCalledExactlyOnceWith("self", "My draft", 1n);
    expect(input.disabled).toBe(true);
    await act(async () => nameAttempt.reject(Object.assign(new Error("Response unknown"), { code: "DEVICE_NAME_UNCONFIRMED" })));
    expect(input.value).toBe("My draft");
    expect(save.disabled).toBe(true);
    const check = [...rendered.container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Check status");
    if (check === undefined) throw new Error("Receipt check missing");
    await act(async () => { check.click(); check.click(); });
    expect(checkDeviceNameUpdate).toHaveBeenCalledExactlyOnceWith("self");
    await act(async () => receiptCheck.resolve(device("self", "My draft", "online", {
      defaultDisplayName: "Actual OS name", manualDisplayName: "My draft", revision: 2n
    })));
    expect(rendered.container.textContent).toContain("Device name saved.");
    expect(renameDevice).toHaveBeenCalledOnce();
    expect(resetDeviceName).not.toHaveBeenCalled();
  });

  it("retires old owner continuations while retaining that owner's dirty draft", async () => {
    const attempt = deferred<DeviceView>();
    const renameDevice = vi.fn(() => attempt.promise);
    const oldSnapshot = snapshot([device("self", "Desk", "online", { manualDisplayName: "Desk" })]);
    const rendered = await renderSettings(oldSnapshot, { renameDevice });
    const oldInput = rendered.container.querySelector<HTMLInputElement>(".device-control-self input");
    if (oldInput === null) throw new Error("Name input missing");
    await setInputValue(oldInput, "Old owner draft");
    await clickButton(rendered.container, "Save");
    await rendered.rerender(snapshot([device("self", "Other node", "online")]), {
      activeProfile: { id: "other", deviceId: "self", serverId: "other-server", name: "Other", origin: "https://other.example" },
      connectionGeneration: 2
    });
    await act(async () => attempt.resolve(device("self", "Old owner draft", "online", { manualDisplayName: "Old owner draft", revision: 2n })));
    expect(rendered.container.querySelector<HTMLInputElement>(".device-control-self input")?.value).toBe("Other node");
    expect(rendered.container.textContent).not.toContain("Device name saved.");
    await rendered.rerender(oldSnapshot);
    expect(rendered.container.querySelector<HTMLInputElement>(".device-control-self input")?.value).toBe("Old owner draft");
  });

  it("fails closed for controller-only clients and controller-only targets", async () => {
    const setDeviceRemoteControlEnabled = vi.fn(async () => undefined);
    const setDeviceControllerAllowed = vi.fn(async () => undefined);
    const setDeviceControlTargetEnabled = vi.fn(async () => undefined);
    const rendered = await renderSettings(
      snapshot([
        device("self", "Browser", "online", { kind: "web", remoteControlEnabled: true }),
        device("peer-service", "Service node", "online", { kind: "service", remoteControlEnabled: true }),
        device("peer-web", "Browser peer", "online", { kind: "web", remoteControlEnabled: true })
      ]),
      { setDeviceRemoteControlEnabled, setDeviceControllerAllowed, setDeviceControlTargetEnabled }
    );

    const global = rendered.container.querySelector<HTMLButtonElement>('button[aria-label="Allow remote control of this device"]');
    const inbound = rendered.container.querySelector<HTMLButtonElement>('button[aria-label="Allow Service node to control this device"]');
    const webTarget = rendered.container.querySelector<HTMLButtonElement>('button[aria-label="Allow controlling Browser peer"]');
    expect(global?.getAttribute("aria-checked")).toBe("false");
    expect(global?.disabled).toBe(true);
    expect(inbound?.disabled).toBe(true);
    expect(webTarget?.disabled).toBe(true);
    await act(async () => {
      global?.click();
      inbound?.click();
      webTarget?.click();
    });
    await rendered.flush();

    expect(setDeviceRemoteControlEnabled).not.toHaveBeenCalled();
    expect(setDeviceControllerAllowed).not.toHaveBeenCalled();
    expect(setDeviceControlTargetEnabled).not.toHaveBeenCalled();
    expect(rendered.container.textContent).toContain("This client can control other devices");
  });
});

function device(
  id: string,
  name: string,
  presence: DeviceView["presence"],
  patch: Partial<DeviceView> = {}
): DeviceView {
  return {
    id,
    name,
    defaultDisplayName: name,
    revision: 1n,
    kind: "desktop",
    platform: "test",
    appVersion: "1.0.0",
    revoked: false,
    remoteControlEnabled: false,
    presence,
    ...patch
  };
}

function snapshot(
  devices: readonly DeviceView[],
  deviceControlRelations: AppSnapshot["deviceControlRelations"] = []
): AppSnapshot {
  return { ...emptySnapshot(), devices, deviceControlRelations };
}

async function renderSettings(snapshotValue: AppSnapshot, methods: Record<string, unknown>): Promise<{
  readonly container: HTMLDivElement;
  readonly actionKeys: string[];
  readonly flush: () => Promise<void>;
  readonly rerender: (snapshot: AppSnapshot, state?: Partial<AppController["state"]>) => Promise<void>;
}> {
  const work: Promise<void>[] = [];
  const actionKeys: string[] = [];
  const controller = {
    state: {
      connectionGeneration: 1,
      connectionState: "connected",
      activeProfile: {
        id: "profile",
        deviceId: "self",
        serverId: "server",
        name: "Local",
        origin: "https://orchestrator.example"
      }
    },
    refresh: vi.fn(async () => undefined),
    hasPendingDeviceNameUpdate: () => false,
    ...methods
  } as unknown as AppController;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const render = (snapshot: AppSnapshot, state: Partial<AppController["state"]> = {}): Promise<void> => act(async () => root.render(<DeviceControlSettings
    controller={{ ...controller, state: { ...controller.state, ...state } }}
    snapshot={snapshot}
    locale="en"
    runAction={(key, action) => {
      actionKeys.push(key);
      work.push(action());
    }}
    t={(key, values) => translate("en", key, values)}
  />));
  await render(snapshotValue);
  return {
    container,
    actionKeys,
    flush: async () => {
      await act(async () => {
        await Promise.all(work.splice(0));
        await Promise.resolve();
      });
    },
    rerender: render
  };
}

async function setInputValue(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function clickButton(container: HTMLElement, label: string): Promise<void> {
  const button = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
  if (button === undefined) throw new Error(`Button not found: ${label}`);
  await act(async () => button.click());
}

async function clickControl(container: HTMLElement, selector: string): Promise<void> {
  const control = container.querySelector<HTMLButtonElement>(selector);
  if (control === null) throw new Error(`Control not found: ${selector}`);
  await act(async () => control.click());
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void; readonly reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}
