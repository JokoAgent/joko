// @vitest-environment jsdom
import { act, type JSX } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { translate } from "../i18n.js";
import { DesktopRemoteDesktopSettings } from "./DesktopRemoteDesktopSettings.js";
import { DesktopRemoteDesktopStatus } from "./DesktopRemoteDesktopStatus.js";

const t = (key: Parameters<typeof translate>[1], values?: Readonly<Record<string, string | number>>): string =>
  translate("en", key, values);
let previousDesktop: JokoDesktopApi | undefined;
const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  previousDesktop = window.jokoDesktop;
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  if (previousDesktop === undefined) Reflect.deleteProperty(window, "jokoDesktop");
  else Object.defineProperty(window, "jokoDesktop", { configurable: true, value: previousDesktop });
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("DesktopRemoteDesktopSettings", () => {
  it("stays absent without the host capability", async () => {
    const fixture = remoteDesktopFixture(snapshot());
    installDesktop(fixture.api, []);
    const view = await render(<DesktopRemoteDesktopSettings t={t} />);
    expect(view.host.textContent).toBe("");
    expect(fixture.api.getState).not.toHaveBeenCalled();
  });

  it("renders opt-in, permissions, active authority, and accessible host actions", async () => {
    const fixture = remoteDesktopFixture(snapshot({
      enabled: true,
      active: true,
      controlling: true,
      controllerDeviceId: "phone-1",
      displayId: "display-2",
      permissions: { screenRecording: "granted", accessibility: "missing" }
    }));
    fixture.api.showPermissionGuide = vi.fn(async () => ({
      screenRecording: "granted" as const,
      accessibility: "granted" as const
    }));
    installDesktop(fixture.api);
    const { host } = await render(<DesktopRemoteDesktopSettings t={t} />);

    expect(host.querySelector("section")?.getAttribute("aria-label")).toBe("Remote Desktop");
    expect(host.textContent).toContain("Off by default");
    expect(host.textContent).toContain("Screen Recording: Allowed");
    expect(host.textContent).toContain("Accessibility: Required");
    expect(host.textContent).toContain("Device phone-1 · Display display-2");
    expect(switchControl(host).getAttribute("aria-checked")).toBe("true");

    await act(async () => button(host, "Open permission guide").click());
    expect(fixture.api.showPermissionGuide).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("Accessibility: Allowed");
    const disconnect = requireElement<HTMLButtonElement>(host, 'button[aria-label="Disconnect Remote Desktop"]');
    await act(async () => disconnect.click());
    expect(fixture.api.disconnect).toHaveBeenCalledOnce();
  });

  it("disables actions during hydration, persists opt-in, and exposes local retry copy", async () => {
    const hydration = deferred<JokoDesktopRemoteDesktopSnapshot>();
    const fixture = remoteDesktopFixture(snapshot());
    fixture.api.getState = vi.fn()
      .mockImplementationOnce(() => hydration.promise)
      .mockResolvedValue(snapshot());
    installDesktop(fixture.api);
    const { host } = await render(<DesktopRemoteDesktopSettings t={t} />, false);

    expect(host.querySelector('[role="status"]')).not.toBeNull();
    expect(button(host, "Open permission guide").disabled).toBe(true);
    await act(async () => hydration.reject(new Error("private path")));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Remote Desktop status could not be loaded.");
    expect(host.textContent).not.toContain("private path");
    await act(async () => button(host, "Retry").click());
    await act(async () => switchControl(host).click());
    expect(fixture.api.setEnabled).toHaveBeenCalledExactlyOnceWith(true);
    expect(switchControl(host).getAttribute("aria-checked")).toBe("true");
  });
});

describe("DesktopRemoteDesktopStatus", () => {
  it("announces view/control state and keeps disconnect failures visible", async () => {
    const active = snapshot({
      enabled: true,
      active: true,
      controlling: false,
      controllerDeviceId: "tablet-7",
      displayId: "main",
      permissions: { screenRecording: "notRequired", accessibility: "notRequired" }
    });
    const fixture = remoteDesktopFixture(active);
    fixture.api.disconnect = vi.fn(async () => { throw new Error("private IPC detail"); });
    installDesktop(fixture.api);
    const { host } = await render(<DesktopRemoteDesktopStatus t={t} />);

    const surface = requireElement<HTMLElement>(host, 'aside[aria-label="Remote Desktop session"]');
    expect(surface.querySelector('[role="status"]')?.textContent).toContain("Desktop being viewed");
    expect(surface.textContent).toContain("Device tablet-7 · Display main");
    const disconnect = requireElement<HTMLButtonElement>(surface, 'button[aria-label="Disconnect Remote Desktop"]');
    await act(async () => disconnect.click());
    expect(fixture.api.disconnect).toHaveBeenCalledOnce();
    expect(surface.querySelector('[role="alert"]')?.textContent)
      .toBe("The Remote Desktop session could not be disconnected.");
    expect(surface.textContent).not.toContain("private IPC detail");
    expect(disconnect.disabled).toBe(false);
  });
});

async function render(element: JSX.Element, settle = true): Promise<{ readonly host: HTMLDivElement }> {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(element);
    if (settle) {
      await Promise.resolve();
      await Promise.resolve();
    }
  });
  return { host };
}

function installDesktop(
  remoteDesktop: JokoDesktopApi["remoteDesktop"],
  capabilities: readonly JokoDesktopCapability[] = ["remote.desktopHost"]
): void {
  Object.defineProperty(window, "jokoDesktop", {
    configurable: true,
    value: { capabilities, remoteDesktop } as unknown as JokoDesktopApi
  });
}

function remoteDesktopFixture(initial: JokoDesktopRemoteDesktopSnapshot): {
  readonly api: JokoDesktopApi["remoteDesktop"];
} {
  const listeners = new Set<(value: JokoDesktopRemoteDesktopSnapshot) => void>();
  let current = initial;
  const publish = (value: JokoDesktopRemoteDesktopSnapshot): JokoDesktopRemoteDesktopSnapshot => {
    current = value;
    for (const listener of listeners) listener(value);
    return value;
  };
  return {
    api: {
      getState: vi.fn(async () => current),
      setEnabled: vi.fn(async (enabled) => publish(snapshot({ ...current, enabled }))),
      disconnect: vi.fn(async () => publish(snapshot({
        ...current,
        active: false,
        controlling: false,
        controllerDeviceId: undefined,
        displayId: undefined
      }))),
      getPermissions: vi.fn(async () => current.permissions),
      showPermissionGuide: vi.fn(async () => current.permissions),
      onStateChanged: vi.fn((listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      })
    }
  };
}

function snapshot(
  overrides: Partial<JokoDesktopRemoteDesktopSnapshot> = {}
): JokoDesktopRemoteDesktopSnapshot {
  return {
    enabled: false,
    active: false,
    controlling: false,
    permissions: { screenRecording: "unknown", accessibility: "unknown" },
    ...overrides
  };
}

function switchControl(container: ParentNode): HTMLButtonElement {
  return requireElement<HTMLButtonElement>(container, 'button[role="switch"]');
}

function button(container: ParentNode, text: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent === text);
  if (match === undefined) throw new Error(`Missing button: ${text}`);
  return match;
}

function requireElement<T extends Element>(container: ParentNode, selector: string): T {
  const value = container.querySelector<T>(selector);
  if (value === null) throw new Error(`Missing element: ${selector}`);
  return value;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}
