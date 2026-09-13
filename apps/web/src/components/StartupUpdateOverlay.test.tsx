// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { resetDesktopUpdateStateForTests } from "../desktop-update.js";
import { translate } from "../i18n.js";
import {
  isStartupUpdateInteractionBlocked,
  resetStartupUpdateInteractionBarrierForTests
} from "../startup-update-interaction.js";
import {
  STARTUP_UPDATE_MIN_VISIBLE_MS,
  STARTUP_UPDATE_READY_VISIBLE_MS,
  StartupUpdateOverlay
} from "./StartupUpdateOverlay.js";

const roots: Root[] = [];
const t = (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]): string => translate("en", key, values);

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  resetDesktopUpdateStateForTests();
  resetStartupUpdateInteractionBarrierForTests();
  document.body.replaceChildren();
  Reflect.deleteProperty(window, "jokoDesktop");
  vi.useRealTimers();
});

describe("Startup update overlay", () => {
  it("ignores every ordinary background update status", async () => {
    const desktop = installDesktopUpdate({ status: "checking" });
    const { container } = await renderOverlay();
    expect(container.querySelector(".startup-update-overlay")).toBeNull();

    await act(async () => desktop.publish({
      status: "downloading",
      version: "2.0.0",
      progress: 40,
      transferred: 4_194_304,
      total: 10_485_760,
      bytesPerSecond: 524_288
    }));
    expect(container.querySelector(".startup-update-overlay")).toBeNull();
    await act(async () => desktop.publish({
      status: "superseding",
      version: "2.0.0",
      nextVersion: "3.0.0",
      progress: 40,
      transferred: 4_194_304,
      total: 10_485_760,
      bytesPerSecond: 524_288
    }));
    expect(container.querySelector(".startup-update-overlay")).toBeNull();
    await act(async () => desktop.publish({ status: "ready", version: "3.0.0" }));
    expect(container.querySelector(".startup-update-overlay")).toBeNull();
    await act(async () => desktop.publish({ status: "error", errorKind: "download" }));
    expect(container.querySelector(".startup-update-overlay")).toBeNull();
    expect(desktop.relaunchStartup).not.toHaveBeenCalled();
  });

  it("keeps the startup overlay continuous while a ready artifact is superseded", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const desktop = installDesktopUpdate({ status: "checking", startup: true });
    const { container } = await renderOverlay();

    await act(async () => desktop.publish({
      status: "superseding",
      version: "2.0.0",
      nextVersion: "3.0.0",
      progress: 41,
      transferred: 1_048_576,
      total: 4_194_304,
      bytesPerSecond: 524_288,
      startup: true
    }));
    expect(container.querySelector('.startup-update-overlay[data-phase="downloading"]')).not.toBeNull();
    expect(container.textContent).toContain("Updating Joko…");
    expect(progressbar(container).getAttribute("aria-valuenow")).toBe("41");
    expect(container.textContent).toContain("512.0 KB/s");
    expect(container.textContent).toContain("1.0 MB / 4.0 MB");

    await act(async () => desktop.publish({
      status: "superseding",
      version: "2.0.0",
      nextVersion: "3.0.0",
      progress: 19,
      transferred: 2_097_152,
      total: 4_194_304,
      bytesPerSecond: 262_144,
      startup: true
    }));
    expect(progressbar(container).getAttribute("aria-valuenow")).toBe("41");
    expect(container.textContent).toContain("256.0 KB/s");
    expect(container.textContent).toContain("2.0 MB / 4.0 MB");
    expect(container.textContent).not.toContain("512.0 KB/s");
    await act(async () => desktop.publish({ status: "ready", version: "3.0.0", startup: true }));
    expect(container.textContent).toContain("Update complete, restarting shortly…");
    expect(container.querySelector(".startup-update-overlay")).not.toBeNull();
  });

  it("maps checking and downloading states and never moves progress backward", async () => {
    const desktop = installDesktopUpdate({ status: "checking", startup: true });
    const { container } = await renderOverlay();
    expect(container.textContent).toContain("Checking for updates…");
    expect(container.querySelector(".startup-update-overlay__panel")).not.toBeNull();
    expect(container.querySelector(".startup-update-overlay__spinner")).not.toBeNull();
    expect(container.querySelector('[role="progressbar"]')).toBeNull();

    await act(async () => desktop.publish({
      status: "downloading",
      version: "2.0.0",
      progress: 38,
      transferred: 3_145_728,
      total: 8_388_608,
      bytesPerSecond: 1_572_864,
      startup: true
    }));
    expect(container.textContent).toContain("Updating Joko…");
    expect(progressbar(container).getAttribute("aria-valuenow")).toBe("38");
    expect(container.textContent).toContain("1.5 MB/s");
    expect(container.textContent).toContain("3.0 MB / 8.0 MB");
    await act(async () => desktop.publish({
      status: "downloading",
      version: "2.0.0",
      progress: 12,
      transferred: 4_194_304,
      total: 8_388_608,
      bytesPerSecond: 524_288,
      startup: true
    }));
    expect(progressbar(container).getAttribute("aria-valuenow")).toBe("38");
    expect(container.textContent).toContain("512.0 KB/s");
    expect(container.textContent).toContain("4.0 MB / 8.0 MB");
    await act(async () => desktop.publish({
      status: "downloading",
      version: "2.0.0",
      progress: 72.6,
      transferred: 6_291_456,
      total: 8_388_608,
      bytesPerSecond: 1_048_576,
      startup: true
    }));
    expect(progressbar(container).getAttribute("aria-valuenow")).toBe("73");
  });

  it("holds the panel for three seconds and the ready copy for 1.5 seconds before one startup relaunch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const desktop = installDesktopUpdate({ status: "checking", startup: true });
    const { container } = await renderOverlay();

    await advance(2_000);
    await act(async () => desktop.publish({ status: "ready", version: "2.0.0", startup: true }));
    expect(container.textContent).toContain("Update complete, restarting shortly…");
    await advance(STARTUP_UPDATE_READY_VISIBLE_MS - 1);
    expect(desktop.relaunchStartup).not.toHaveBeenCalled();
    await advance(1);
    expect(desktop.relaunchStartup).toHaveBeenCalledOnce();
    expect(Date.now()).toBe(3_500);

    await act(async () => desktop.publish({ status: "ready", version: "2.0.0", startup: true }));
    await advance(10_000);
    expect(desktop.relaunchStartup).toHaveBeenCalledOnce();

    await act(async () => desktop.publish({ status: "idle", availability: "available" }));
    await advance(0);
    expect(container.querySelector(".startup-update-overlay")).toBeNull();
  });

  it("keeps a fast released gate covered until the total display floor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const desktop = installDesktopUpdate({ status: "checking", startup: true });
    const { container } = await renderOverlay();

    await advance(100);
    await act(async () => desktop.publish({ status: "idle", availability: "available" }));
    await advance(STARTUP_UPDATE_MIN_VISIBLE_MS - 101);
    expect(container.textContent).toContain("Checking for updates…");
    await advance(1);
    expect(container.querySelector(".startup-update-overlay")).toBeNull();
  });

  it("keeps the held overlay modal while preserving window chrome and restores exact background state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const backgroundAction = vi.fn();
    const backgroundApp = document.createElement("main");
    backgroundApp.className = "app";
    backgroundApp.setAttribute("aria-hidden", "false");
    const backgroundButton = document.createElement("button");
    backgroundButton.addEventListener("click", backgroundAction);
    backgroundApp.append(backgroundButton);
    const windowControls = document.createElement("div");
    windowControls.className = "desktop-window-controls";
    const windowControlAction = vi.fn();
    const windowControl = document.createElement("button");
    windowControl.addEventListener("click", windowControlAction);
    windowControls.append(windowControl);
    document.body.append(backgroundApp, windowControls);
    backgroundButton.focus();

    const desktop = installDesktopUpdate({ status: "checking", startup: true });
    const { container } = await renderOverlay();
    const overlay = requireElement<HTMLElement>(container, ".startup-update-overlay");
    expect(isStartupUpdateInteractionBlocked()).toBe(true);
    expect(backgroundApp.inert).toBe(true);
    expect(backgroundApp.getAttribute("inert")).toBe("");
    expect(backgroundApp.getAttribute("aria-hidden")).toBe("true");
    expect(document.activeElement).toBe(overlay);

    backgroundButton.click();
    expect(backgroundAction).not.toHaveBeenCalled();
    const rendererShortcut = vi.fn();
    window.addEventListener("keydown", rendererShortcut, true);
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
      const event = new KeyboardEvent("keydown", {
        key: "n",
        code: "KeyN",
        bubbles: true,
        cancelable: true,
        ...modifier
      });
      backgroundButton.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(rendererShortcut).not.toHaveBeenCalled();
    window.removeEventListener("keydown", rendererShortcut, true);

    windowControl.click();
    windowControl.focus();
    expect(windowControlAction).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(windowControl);
    backgroundButton.focus();
    expect(document.activeElement).not.toBe(backgroundButton);
    overlay.focus();

    await act(async () => desktop.publish({ status: "idle", availability: "available" }));
    const lateApp = document.createElement("section");
    lateApp.className = "app";
    lateApp.inert = true;
    lateApp.setAttribute("inert", "preserve");
    await act(async () => {
      document.body.append(lateApp);
      await Promise.resolve();
    });
    expect(container.querySelector(".startup-update-overlay")).not.toBeNull();
    expect(isStartupUpdateInteractionBlocked()).toBe(true);
    expect(lateApp.inert).toBe(true);
    expect(lateApp.getAttribute("inert")).toBe("");
    expect(lateApp.getAttribute("aria-hidden")).toBe("true");
    backgroundButton.click();
    expect(backgroundAction).not.toHaveBeenCalled();

    await advance(STARTUP_UPDATE_MIN_VISIBLE_MS - 1);
    expect(isStartupUpdateInteractionBlocked()).toBe(true);
    await advance(1);
    expect(container.querySelector(".startup-update-overlay")).toBeNull();
    expect(isStartupUpdateInteractionBlocked()).toBe(false);
    expect(backgroundApp.inert).toBe(false);
    expect(backgroundApp.hasAttribute("inert")).toBe(false);
    expect(backgroundApp.getAttribute("aria-hidden")).toBe("false");
    expect(lateApp.inert).toBe(true);
    expect(lateApp.getAttribute("inert")).toBe("preserve");
    expect(lateApp.hasAttribute("aria-hidden")).toBe(false);
    expect(document.activeElement).toBe(backgroundButton);
  });

  it("turns an automatic relaunch rejection into a focused manual retry without looping", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const desktop = installDesktopUpdate({ status: "ready", version: "2.0.0", startup: true });
    desktop.relaunchStartup
      .mockRejectedValueOnce(new Error("private IPC failure"))
      .mockResolvedValueOnce({ accepted: true });
    const { container } = await renderOverlay();

    await advance(STARTUP_UPDATE_MIN_VISIBLE_MS);
    expect(desktop.relaunchStartup).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("couldn't restart to finish installing");
    expect(container.textContent).not.toContain("private IPC failure");
    const retry = requireElement<HTMLButtonElement>(container, ".startup-update-overlay__panel > .button");
    expect(document.activeElement).toBe(retry);
    await advance(10_000);
    expect(desktop.relaunchStartup).toHaveBeenCalledOnce();

    await act(async () => {
      retry.click();
      retry.click();
    });
    expect(desktop.relaunchStartup).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".startup-update-overlay")).not.toBeNull();

    await act(async () => desktop.publish({ status: "idle", availability: "available" }));
    await advance(0);
    expect(container.querySelector(".startup-update-overlay")).toBeNull();
  });

  it("drops a stale automatic relaunch rejection after main releases the startup gate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const relaunch = deferred<JokoDesktopUpdateRelaunchResult>();
    const desktop = installDesktopUpdate({ status: "ready", version: "2.0.0", startup: true });
    desktop.relaunchStartup.mockImplementationOnce(() => relaunch.promise);
    const { container } = await renderOverlay();

    await advance(STARTUP_UPDATE_MIN_VISIBLE_MS);
    expect(desktop.relaunchStartup).toHaveBeenCalledOnce();
    await act(async () => desktop.publish({ status: "idle", availability: "available" }));
    await advance(0);
    expect(container.querySelector(".startup-update-overlay")).toBeNull();

    await act(async () => relaunch.reject(new Error("late IPC failure")));
    expect(container.querySelector(".startup-update-overlay")).toBeNull();
    expect(desktop.relaunchStartup).toHaveBeenCalledOnce();
  });

  it("focuses startup download errors, fences retry reentry, and ignores a stale rejection", async () => {
    const startupRetry = deferred<JokoDesktopUpdateCheckResult>();
    const desktop = installDesktopUpdate({ status: "error", errorKind: "download", version: "2.0.0", startup: true });
    desktop.retryStartup.mockImplementationOnce(() => startupRetry.promise);
    const { container } = await renderOverlay();
    const retry = requireElement<HTMLButtonElement>(container, ".startup-update-overlay__panel > .button");
    expect(document.activeElement).toBe(retry);

    await act(async () => {
      retry.click();
      retry.click();
    });
    expect(desktop.retryStartup).toHaveBeenCalledOnce();
    expect(desktop.check).not.toHaveBeenCalled();
    await act(async () => desktop.publish({ status: "checking", startup: true }));
    await act(async () => startupRetry.reject(new Error("late network failure")));
    expect(container.textContent).toContain("Checking for updates…");
    expect(container.textContent).not.toContain("still couldn't download");
  });

  it("shows a localized retry error and leaves the failure retryable", async () => {
    const desktop = installDesktopUpdate({ status: "error", errorKind: "download", startup: true });
    desktop.retryStartup
      .mockRejectedValueOnce(new Error("private IPC path"))
      .mockResolvedValueOnce({ status: "failed", errorKind: "download" });
    const { container } = await renderOverlay();

    await act(async () => requireElement<HTMLButtonElement>(container, ".startup-update-overlay__panel > .button").click());
    expect(container.textContent).toContain("still couldn't download the update");
    expect(container.textContent).not.toContain("private IPC path");
    expect(requireElement<HTMLButtonElement>(container, ".startup-update-overlay__panel > .button").disabled).toBe(false);
    await act(async () => requireElement<HTMLButtonElement>(container, ".startup-update-overlay__panel > .button").click());
    expect(desktop.retryStartup).toHaveBeenCalledTimes(2);
    expect(requireElement<HTMLButtonElement>(container, ".startup-update-overlay__panel > .button").disabled).toBe(false);
  });

  it("treats retry responses as advisory and exits only on main's non-startup release", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const desktop = installDesktopUpdate({ status: "error", errorKind: "download", startup: true });
    desktop.retryStartup.mockResolvedValueOnce({ status: "up-to-date" });
    const { container } = await renderOverlay();

    await act(async () => requireElement<HTMLButtonElement>(container, ".startup-update-overlay__panel > .button").click());
    expect(desktop.retryStartup).toHaveBeenCalledOnce();
    expect(desktop.check).not.toHaveBeenCalled();
    expect(container.querySelector(".startup-update-overlay")).not.toBeNull();

    await act(async () => desktop.publish({ status: "idle", availability: "available" }));
    await advance(STARTUP_UPDATE_MIN_VISIBLE_MS - 1);
    expect(container.querySelector(".startup-update-overlay")).not.toBeNull();
    await advance(1);
    expect(container.querySelector(".startup-update-overlay")).toBeNull();
  });
});

async function renderOverlay(): Promise<{ readonly container: HTMLDivElement; readonly root: Root }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<StartupUpdateOverlay t={t} />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return { container, root };
}

async function advance(milliseconds: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

function progressbar(container: ParentNode): HTMLElement {
  return requireElement(container, '[role="progressbar"]');
}

function requireElement<T extends Element>(container: ParentNode, selector: string): T {
  const value = container.querySelector<T>(selector);
  if (value === null) throw new Error(`Missing test element: ${selector}`);
  return value;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

function installDesktopUpdate(initialStatus: JokoDesktopUpdateStatus): {
  readonly check: ReturnType<typeof vi.fn>;
  readonly retryStartup: ReturnType<typeof vi.fn>;
  readonly relaunchStartup: ReturnType<typeof vi.fn>;
  readonly publish: (status: JokoDesktopUpdateStatus) => void;
} {
  const listeners = new Set<(status: JokoDesktopUpdateStatus) => void>();
  const check = vi.fn(async () => ({ status: "up-to-date" as const }));
  const retryStartup = vi.fn(async () => ({ status: "up-to-date" as const }));
  const relaunchStartup = vi.fn(async () => ({ accepted: true as const }));
  Object.defineProperty(window, "jokoDesktop", {
    configurable: true,
    value: {
      capabilities: ["app.update"],
      updates: {
        getStatus: vi.fn(async () => initialStatus),
        check,
        retryStartup,
        relaunch: vi.fn(async () => ({ accepted: true as const })),
        relaunchStartup,
        onStatus: vi.fn((listener: (status: JokoDesktopUpdateStatus) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        }),
        getAutoRelaunchSettings: vi.fn(async () => ({ autoRelaunchOnIdle: false, isCustomized: false, defaultAutoRelaunchOnIdle: false })),
        setAutoRelaunchOnIdle: vi.fn(async (enabled: boolean) => ({ autoRelaunchOnIdle: enabled, isCustomized: true, defaultAutoRelaunchOnIdle: false })),
        resetAutoRelaunchSettings: vi.fn(async () => ({ autoRelaunchOnIdle: false, isCustomized: false, defaultAutoRelaunchOnIdle: false }))
      }
    } as unknown as JokoDesktopApi
  });
  return {
    check,
    retryStartup,
    relaunchStartup,
    publish: (status) => {
      for (const listener of listeners) listener(status);
    }
  };
}
