// @vitest-environment jsdom

import { act, type JSX } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  currentDesktopUpdateBannerDismiss,
  desktopUpdateApi,
  deferDesktopUpdateBannerBecauseBusy,
  dismissDesktopUpdateBanner,
  isNewDesktopUpdateAfterDismiss,
  markDesktopUpdateBannerAutoShown,
  resetDesktopUpdateStateForTests,
  restoreDesktopUpdateBanner,
  useDesktopUpdateStatus
} from "./desktop-update.js";

const roots: Root[] = [];

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  resetDesktopUpdateStateForTests();
  document.body.replaceChildren();
  Reflect.deleteProperty(window, "jokoDesktop");
});

describe("Desktop update renderer bridge", () => {
  it("subscribes before hydration and does not let a stale snapshot overwrite a push", async () => {
    let resolveHydration!: (status: JokoDesktopUpdateStatus) => void;
    const hydration = new Promise<JokoDesktopUpdateStatus>((resolve) => { resolveHydration = resolve; });
    let listener: ((status: JokoDesktopUpdateStatus) => void) | undefined;
    const unsubscribe = vi.fn();
    installDesktop({
      getStatus: vi.fn(() => hydration),
      onStatus: vi.fn((next) => {
        listener = next;
        return unsubscribe;
      })
    });
    const { container, root } = await renderStatus();

    await act(async () => listener?.({ status: "ready", version: "3.0.0" }));
    expect(container.textContent).toBe("ready:3.0.0");
    await act(async () => resolveHydration({ status: "idle", availability: "available" }));
    expect(container.textContent).toBe("ready:3.0.0");

    await act(async () => root.unmount());
    roots.splice(roots.indexOf(root), 1);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("keys dismissal to the exact installable update and restores on a newer one", () => {
    const ready = { status: "ready", version: "2.0.0" } as const;
    dismissDesktopUpdateBanner(ready);
    expect(isNewDesktopUpdateAfterDismiss(ready)).toBe(false);
    expect(isNewDesktopUpdateAfterDismiss({ status: "ready", version: "2.0.1" })).toBe(true);
    expect(isNewDesktopUpdateAfterDismiss({
      status: "superseding",
      version: "2.0.0",
      nextVersion: "2.1.0",
      progress: 0,
      transferred: 0,
      total: 0,
      bytesPerSecond: 0
    })).toBe(true);
  });

  it("keeps automatic busy deferral distinct from an explicit user dismissal", () => {
    const ready = { status: "ready", version: "2.0.0" } as const;
    expect(deferDesktopUpdateBannerBecauseBusy(ready)).toBe(true);
    expect(currentDesktopUpdateBannerDismiss()).toEqual({
      dismissed: true,
      reason: "busy",
      updateKey: "ready\0" + ready.version,
      decisionKey: "ready\0" + ready.version
    });

    dismissDesktopUpdateBanner(ready);
    const userDismiss = currentDesktopUpdateBannerDismiss();
    expect(userDismiss.reason).toBe("user");
    expect(deferDesktopUpdateBannerBecauseBusy(ready)).toBe(false);
    expect(markDesktopUpdateBannerAutoShown(ready)).toBe(false);
    expect(currentDesktopUpdateBannerDismiss()).toBe(userDismiss);
  });

  it("preserves the automatic decision when the user explicitly restores a busy banner", () => {
    const ready = { status: "ready", version: "2.0.0" } as const;
    deferDesktopUpdateBannerBecauseBusy(ready);
    restoreDesktopUpdateBanner();
    expect(currentDesktopUpdateBannerDismiss()).toEqual({
      dismissed: false,
      decisionKey: "ready\0" + ready.version
    });
  });

  it("requires the explicit app.update capability", () => {
    Object.defineProperty(window, "jokoDesktop", {
      configurable: true,
      value: { capabilities: [], updates: validUpdates() } as unknown as JokoDesktopApi
    });
    expect(desktopUpdateApi()).toBeUndefined();
  });
});

function StatusText(): JSX.Element {
  const status = useDesktopUpdateStatus();
  return <span>{status === undefined ? "none" : `${status.status}:${status.status === "ready" ? status.version : ""}`}</span>;
}

async function renderStatus(): Promise<{ readonly container: HTMLDivElement; readonly root: Root }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<StatusText />);
    await Promise.resolve();
  });
  return { container, root };
}

function installDesktop(overrides: Partial<JokoDesktopApi["updates"]>): void {
  Object.defineProperty(window, "jokoDesktop", {
    configurable: true,
    value: {
      capabilities: ["app.update"],
      updates: { ...validUpdates(), ...overrides }
    } as unknown as JokoDesktopApi
  });
}

function validUpdates(): JokoDesktopApi["updates"] {
  return {
    getStatus: vi.fn(async () => ({ status: "idle", availability: "available" } as const)),
    check: vi.fn(async () => ({ status: "up-to-date" as const })),
    relaunch: vi.fn(async () => ({ accepted: true as const })),
    relaunchStartup: vi.fn(async () => ({ accepted: true as const })),
    retryStartup: vi.fn(async () => ({ status: "up-to-date" as const })),
    onStatus: vi.fn(() => vi.fn()),
    getAutoRelaunchSettings: vi.fn(async () => ({
      autoRelaunchOnIdle: false,
      isCustomized: false,
      defaultAutoRelaunchOnIdle: false
    })),
    setAutoRelaunchOnIdle: vi.fn(async (enabled) => ({
      autoRelaunchOnIdle: enabled,
      isCustomized: true,
      defaultAutoRelaunchOnIdle: false
    })),
    resetAutoRelaunchSettings: vi.fn(async () => ({
      autoRelaunchOnIdle: false,
      isCustomized: false,
      defaultAutoRelaunchOnIdle: false
    })),
    getChannelSettings: vi.fn(async () => ({
      enableBeta: false,
      isCustomized: false,
      defaultEnableBeta: false
    })),
    setBetaChannelEnabled: vi.fn(async (enabled) => ({
      enableBeta: enabled,
      isCustomized: true,
      defaultEnableBeta: false
    })),
    resetChannelSettings: vi.fn(async () => ({
      enableBeta: false,
      isCustomized: false,
      defaultEnableBeta: false
    })),
    probeBetaChannel: vi.fn(async () => ({ available: true })),
    relaunchForChannelChange: vi.fn(async () => ({ accepted: true as const })),
    onChannelSettings: vi.fn(() => vi.fn())
  };
}
