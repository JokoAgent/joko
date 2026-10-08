// @vitest-environment jsdom
import { act, type JSX } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  desktopRemoteDesktopApi,
  useDesktopRemoteDesktop,
  type DesktopRemoteDesktopState
} from "./desktop-remote-desktop.js";

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

describe("desktop Remote Desktop state", () => {
  it("requires the capability and complete bridge surface", async () => {
    const fixture = createRemoteDesktop();
    installDesktop(fixture.api, []);
    expect(desktopRemoteDesktopApi()).toBeUndefined();
    expect((await renderHarness()).state().available).toBe(false);

    const incomplete = { ...fixture.api } as unknown as Record<string, unknown>;
    Reflect.deleteProperty(incomplete, "disconnect");
    installDesktop(incomplete as unknown as JokoDesktopApi["remoteDesktop"]);
    expect(desktopRemoteDesktopApi()).toBeUndefined();
  });

  it("lets a synchronous authoritative push win over a late initial read", async () => {
    const hydration = deferred<JokoDesktopRemoteDesktopSnapshot>();
    const pushed = snapshot({
      enabled: true,
      active: true,
      controlling: true,
      controllerDeviceId: "phone-1",
      displayId: "display-2",
      permissions: { screenRecording: "granted", accessibility: "granted" }
    });
    const fixture = createRemoteDesktop(snapshot(), pushed);
    fixture.api.getState = vi.fn(() => hydration.promise);
    installDesktop(fixture.api);
    const harness = await renderHarness();

    expect(harness.state()).toMatchObject({
      active: true,
      controlling: true,
      controllerDeviceId: "phone-1",
      loading: false
    });
    await act(async () => hydration.resolve(snapshot()));
    expect(harness.state()).toMatchObject({ active: true, controlling: true, controllerDeviceId: "phone-1" });
  });

  it("admits one mutation, preserves an authoritative push, and fences its late transport failure", async () => {
    const mutation = deferred<JokoDesktopRemoteDesktopSnapshot>();
    const fixture = createRemoteDesktop(snapshot({ enabled: false }));
    fixture.api.setEnabled = vi.fn(() => mutation.promise);
    installDesktop(fixture.api);
    const harness = await renderHarness();

    await act(async () => {
      void harness.actions().setEnabled(true);
      void harness.actions().setEnabled(false);
      void harness.actions().disconnect();
    });
    expect(fixture.api.setEnabled).toHaveBeenCalledExactlyOnceWith(true);
    expect(fixture.api.disconnect).not.toHaveBeenCalled();
    expect(harness.state().saving).toBe(true);

    await act(async () => fixture.publish(snapshot({ enabled: true })));
    expect(harness.state()).toMatchObject({ enabled: true, saving: true });
    await act(async () => mutation.reject(new Error("late private IPC failure")));
    expect(harness.state()).toMatchObject({ enabled: true, saving: false });
    expect(harness.state().error).toBeUndefined();
  });

  it("recovers authoritative state after a failed action and drops completions after API replacement", async () => {
    const first = createRemoteDesktop(snapshot({ enabled: false }));
    first.api.setEnabled = vi.fn(async () => { throw new Error("private failure"); });
    first.api.getState = vi.fn()
      .mockResolvedValueOnce(snapshot({ enabled: false }))
      .mockResolvedValueOnce(snapshot({ enabled: true }));
    installDesktop(first.api);
    const harness = await renderHarness();

    await act(async () => harness.actions().setEnabled(true));
    expect(harness.state()).toMatchObject({ enabled: true, saving: false, error: "save" });

    const oldRead = deferred<JokoDesktopRemoteDesktopSnapshot>();
    first.api.getState = vi.fn(() => oldRead.promise);
    await act(async () => { void harness.actions().reload(); });
    const second = createRemoteDesktop(snapshot({ enabled: false }));
    installDesktop(second.api);
    await harness.rerender();
    expect(first.unsubscribe).toHaveBeenCalledOnce();
    expect(harness.state()).toMatchObject({ enabled: false, loading: false });
    await act(async () => oldRead.resolve(snapshot({ enabled: true })));
    expect(harness.state().enabled).toBe(false);
  });
});

interface HarnessActions {
  readonly reload: () => Promise<void>;
  readonly setEnabled: (enabled: boolean) => Promise<void>;
  readonly disconnect: () => Promise<void>;
  readonly showPermissionGuide: () => Promise<void>;
}

async function renderHarness(): Promise<{
  readonly actions: () => HarnessActions;
  readonly state: () => DesktopRemoteDesktopState;
  readonly rerender: () => Promise<void>;
}> {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  roots.push(root);
  let actions: HarnessActions | undefined;
  let current: DesktopRemoteDesktopState | undefined;
  function Harness(): JSX.Element {
    const value = useDesktopRemoteDesktop();
    actions = value;
    current = value.state;
    return <output>{value.state.enabled ? "on" : "off"}</output>;
  }
  const rerender = async (): Promise<void> => {
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
      await Promise.resolve();
    });
  };
  await rerender();
  return {
    actions: () => actions as HarnessActions,
    state: () => current as DesktopRemoteDesktopState,
    rerender
  };
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

function createRemoteDesktop(
  initial = snapshot(),
  synchronous?: JokoDesktopRemoteDesktopSnapshot
): {
  readonly api: JokoDesktopApi["remoteDesktop"];
  readonly publish: (value: JokoDesktopRemoteDesktopSnapshot) => void;
  readonly unsubscribe: ReturnType<typeof vi.fn>;
} {
  const listeners = new Set<(value: JokoDesktopRemoteDesktopSnapshot) => void>();
  const unsubscribe = vi.fn();
  const api: JokoDesktopApi["remoteDesktop"] = {
    getState: vi.fn(async () => initial),
    setEnabled: vi.fn(async (enabled) => snapshot({ ...initial, enabled })),
    disconnect: vi.fn(async () => snapshot({ ...initial, active: false, controlling: false })),
    getPermissions: vi.fn(async () => initial.permissions),
    showPermissionGuide: vi.fn(async () => initial.permissions),
    onStateChanged: vi.fn((listener) => {
      listeners.add(listener);
      if (synchronous !== undefined) listener(synchronous);
      return () => {
        listeners.delete(listener);
        unsubscribe();
      };
    })
  };
  return {
    api,
    publish: (value) => { for (const listener of listeners) listener(value); },
    unsubscribe
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
