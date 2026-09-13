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
    const renameDevice = vi.fn(async () => undefined);
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

    expect(renameDevice).toHaveBeenCalledWith("self", "Main desk");
    expect(setDeviceRemoteControlEnabled).toHaveBeenCalledWith(true);
    expect(rendered.actionKeys).toEqual(["rename-device:self", "device-remote-control"]);
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
}> {
  const work: Promise<void>[] = [];
  const actionKeys: string[] = [];
  const controller = {
    state: {
      activeProfile: {
        id: "profile",
        deviceId: "self",
        serverId: "server",
        name: "Local",
        origin: "https://orchestrator.example"
      }
    },
    refresh: vi.fn(async () => undefined),
    ...methods
  } as unknown as AppController;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<DeviceControlSettings
    controller={controller}
    snapshot={snapshotValue}
    locale="en"
    runAction={(key, action) => {
      actionKeys.push(key);
      work.push(action());
    }}
    t={(key, values) => translate("en", key, values)}
  />));
  return {
    container,
    actionKeys,
    flush: async () => {
      await act(async () => {
        await Promise.all(work.splice(0));
      });
    }
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
