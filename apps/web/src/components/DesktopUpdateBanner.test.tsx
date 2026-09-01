// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { resetDesktopUpdateStateForTests } from "../desktop-update.js";
import { DESKTOP_UPDATE_BUSY_POLL_MS } from "../desktop-update-busy-deferral.js";
import { translate } from "../i18n.js";
import { DesktopUpdateBanner, DesktopUpdateRestoreButton } from "./DesktopUpdateBanner.js";
import { TOOLTIP_DELAY_MS } from "./ui.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
}

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
  document.body.replaceChildren();
  Reflect.deleteProperty(window, "jokoDesktop");
  vi.useRealTimers();
});

describe("DesktopUpdateBanner relaunch fence", () => {
  it("samples activity once at click time and relaunches directly only when safe", async () => {
    const probe = deferred<boolean>();
    const desktop = installDesktopUpdate({ status: "ready", version: "2.0.0" });
    const probeRuntimeActivity = vi.fn()
      .mockResolvedValueOnce(false)
      .mockImplementation(() => probe.promise);
    const { container } = await renderBanner(false, probeRuntimeActivity);
    const trigger = requireElement<HTMLButtonElement>(container, ".desktop-update-banner__pill");

    await act(async () => {
      trigger.click();
      trigger.click();
    });
    expect(probeRuntimeActivity).toHaveBeenCalledTimes(2);
    expect(desktop.relaunch).not.toHaveBeenCalled();
    expect(container.querySelector('[data-status="ready"] .is-spinning')).toBeNull();

    await act(async () => probe.resolve(false));
    expect(desktop.relaunch).toHaveBeenCalledOnce();
    expect(desktop.relaunch).toHaveBeenCalledWith({ allowBusy: false });
    expect(container.textContent).not.toContain("A task is still running");
  });

  it.each(["busy", "probe-error"] as const)("fails closed into confirmation for %s and restores trigger focus on cancel", async (outcome) => {
    const desktop = installDesktopUpdate({ status: "ready", version: "2.0.0" });
    const probeRuntimeActivity = vi.fn()
      .mockResolvedValueOnce(false)
      .mockImplementation(outcome === "busy"
        ? async () => true
        : async () => Promise.reject(new Error("Orchestrator unavailable")));
    const { container } = await renderBanner(false, probeRuntimeActivity);

    await act(async () => requireElement<HTMLButtonElement>(container, ".desktop-update-banner__pill").click());
    expect(desktop.relaunch).not.toHaveBeenCalled();
    expect(container.textContent).toContain("A task is still running");
    const cancel = requireElement<HTMLButtonElement>(container, ".desktop-update-banner__cancel");
    expect(document.activeElement).toBe(cancel);

    await act(async () => cancel.click());
    const restoredTrigger = requireElement<HTMLButtonElement>(container, ".desktop-update-banner__pill");
    expect(document.activeElement).toBe(restoredTrigger);
  });

  it("invalidates an outstanding safe result when the update becomes superseded", async () => {
    const probe = deferred<boolean>();
    const desktop = installDesktopUpdate({ status: "ready", version: "2.0.0" });
    const probeRuntimeActivity = vi.fn()
      .mockResolvedValueOnce(false)
      .mockImplementation(() => probe.promise);
    const { container } = await renderBanner(false, probeRuntimeActivity);

    await act(async () => requireElement<HTMLButtonElement>(container, ".desktop-update-banner__pill").click());
    await act(async () => desktop.publish({
      status: "superseding",
      version: "2.0.0",
      nextVersion: "2.1.0",
      progress: 15,
      transferred: 1_572_864,
      total: 10_485_760,
      bytesPerSecond: 524_288
    }));
    await act(async () => probe.resolve(false));

    expect(desktop.relaunch).not.toHaveBeenCalled();
    expect(container.querySelector('[data-status="superseding"]')).not.toBeNull();
  });

  it("passes the busy override only after the warning is visible", async () => {
    const desktop = installDesktopUpdate({ status: "ready", version: "2.0.0" });
    const probeRuntimeActivity = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const { container } = await renderBanner(false, probeRuntimeActivity);

    await act(async () => requireElement<HTMLButtonElement>(container, ".desktop-update-banner__pill").click());
    expect(desktop.relaunch).not.toHaveBeenCalled();
    expect(container.textContent).toContain("A task is still running");
    await act(async () => requireElement<HTMLButtonElement>(container, ".desktop-update-banner__pill").click());
    expect(desktop.relaunch).toHaveBeenCalledWith({ allowBusy: true });
  });

  it("returns to the busy warning when main closes the safe-probe race", async () => {
    const desktop = installDesktopUpdate({ status: "ready", version: "2.0.0" });
    desktop.relaunch.mockResolvedValueOnce({ accepted: false, reason: "busy" });
    const { container } = await renderBanner(false, async () => false);

    await act(async () => requireElement<HTMLButtonElement>(container, ".desktop-update-banner__pill").click());
    expect(desktop.relaunch).toHaveBeenCalledWith({ allowBusy: false });
    expect(container.textContent).toContain("A task is still running");
    expect(container.textContent).not.toContain("could not relaunch");
  });

  it("preserves an apply failure across an equivalent ready refresh and permits retry", async () => {
    const firstRelaunch = deferred<JokoDesktopUpdateRelaunchResult>();
    const desktop = installDesktopUpdate({ status: "ready", version: "2.0.0" });
    desktop.relaunch
      .mockImplementationOnce(() => firstRelaunch.promise)
      .mockResolvedValueOnce({ accepted: true });
    const probeRuntimeActivity = vi.fn(async () => false);
    const { container } = await renderBanner(false, probeRuntimeActivity);

    await act(async () => requireElement<HTMLButtonElement>(container, ".desktop-update-banner__pill").click());
    await act(async () => desktop.publish({ status: "ready", version: "2.0.0" }));
    await act(async () => firstRelaunch.resolve({ accepted: false, reason: "apply-failed" }));
    expect(container.textContent).toContain("installer could not start");

    await act(async () => requireElement<HTMLButtonElement>(container, ".desktop-update-banner__pill").click());
    expect(probeRuntimeActivity).toHaveBeenCalledTimes(3);
    expect(desktop.relaunch).toHaveBeenNthCalledWith(2, { allowBusy: false });
  });

  it("exposes a collapsed apply failure without changing the single-button rail and permits retry", async () => {
    vi.useFakeTimers();
    const desktop = installDesktopUpdate({ status: "ready", version: "2.0.0" });
    desktop.relaunch
      .mockResolvedValueOnce({ accepted: false, reason: "apply-failed" })
      .mockResolvedValueOnce({ accepted: true });
    const probeRuntimeActivity = vi.fn(async () => false);
    const { container } = await renderBanner(true, probeRuntimeActivity);

    await act(async () => requireElement<HTMLButtonElement>(container, ".desktop-update-banner--rail > button").click());
    const errorRail = requireElement<HTMLElement>(container, ".desktop-update-banner--rail.is-error");
    expect(errorRail.getAttribute("role")).toBe("alert");
    expect(errorRail.getAttribute("aria-live")).toBe("assertive");
    expect(errorRail.querySelectorAll(":scope > button")).toHaveLength(1);
    const retry = requireElement<HTMLButtonElement>(errorRail, ":scope > button");
    expect(retry.hasAttribute("title")).toBe(false);
    expect(retry.getAttribute("aria-label")).toContain("installer could not start");
    await act(async () => { retry.focus(); vi.advanceTimersByTime(TOOLTIP_DELAY_MS); });
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toContain("installer could not start");

    await act(async () => retry.click());
    expect(probeRuntimeActivity).toHaveBeenCalledTimes(3);
    expect(desktop.relaunch).toHaveBeenCalledTimes(2);
    expect(desktop.relaunch).toHaveBeenNthCalledWith(2, { allowBusy: false });
    expect(container.querySelector(".desktop-update-banner--rail.is-error")).toBeNull();
  });

  it("invalidates a probe when dismissed, exposes restore, and never relaunches after unmount", async () => {
    const probe = deferred<boolean>();
    const desktop = installDesktopUpdate({ status: "ready", version: "2.0.0" });
    const probeRuntimeActivity = vi.fn()
      .mockResolvedValueOnce(false)
      .mockImplementation(() => probe.promise);
    const rendered = await renderBanner(false, probeRuntimeActivity);

    await act(async () => requireElement<HTMLButtonElement>(rendered.container, ".desktop-update-banner__pill").click());
    await act(async () => requireElement<HTMLButtonElement>(rendered.container, ".desktop-update-banner__dismiss").click());
    expect(rendered.container.querySelector(".desktop-update-banner")).toBeNull();
    const restore = requireElement<HTMLButtonElement>(rendered.container, ".desktop-update-restore");
    await act(async () => restore.click());
    expect(rendered.container.querySelector(".desktop-update-banner")).not.toBeNull();

    await act(async () => rendered.root.unmount());
    roots.splice(roots.indexOf(rendered.root), 1);
    await act(async () => probe.resolve(false));
    expect(desktop.relaunch).not.toHaveBeenCalled();
  });

  it("keeps a single Flame rail and restores an expanded dismissal from the rail footer", async () => {
    installDesktopUpdate({ status: "ready", version: "2.0.0" });
    const { container, root } = await renderBanner(false, async () => false);
    await act(async () => requireElement<HTMLButtonElement>(container, ".desktop-update-banner__dismiss").click());
    await act(async () => root.render(<>
      <DesktopUpdateBanner collapsed probeRuntimeActivity={async () => false} t={t} />
      <DesktopUpdateRestoreButton t={t} />
    </>));

    expect(container.querySelector(".desktop-update-banner")).toBeNull();
    await act(async () => requireElement<HTMLButtonElement>(container, ".desktop-update-restore").click());
    expect(container.querySelector(".desktop-update-banner--rail")).not.toBeNull();
    expect(container.querySelectorAll(".desktop-update-banner--rail > button")).toHaveLength(1);
    expect(container.querySelector(".desktop-update-banner__rail-dismiss")).toBeNull();
  });

  it("shows only ready and superseding in the Sidebar and keeps superseding progress text-free", async () => {
    const desktop = installDesktopUpdate({
      status: "downloading",
      version: "2.0.0",
      progress: 42,
      transferred: 4_194_304,
      total: 10_485_760,
      bytesPerSecond: 524_288
    });
    const { container } = await renderBanner(false, async () => false);
    expect(container.querySelector(".desktop-update-banner")).toBeNull();
    await act(async () => desktop.publish({ status: "error", errorKind: "download", version: "2.0.0" }));
    expect(container.querySelector(".desktop-update-banner")).toBeNull();
    await act(async () => desktop.publish({ status: "manual-download", reason: "unsupported-platform" }));
    expect(container.querySelector(".desktop-update-banner")).toBeNull();

    await act(async () => desktop.publish({
      status: "superseding",
      version: "2.0.0",
      nextVersion: "2.1.0",
      progress: 67,
      transferred: 7_025_459,
      total: 10_485_760,
      bytesPerSecond: 524_288
    }));
    expect(container.textContent).toContain("Newer version found");
    expect(container.textContent).toContain("Updating…");
    expect(container.textContent).not.toContain("67%");
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
  });
});

describe("DesktopUpdateBanner automatic busy deferral", () => {
  it("does not flash the expanded banner while the first activity decision is pending", async () => {
    const probe = deferred<boolean>();
    const probeRuntimeActivity = vi.fn(() => probe.promise);
    installDesktopUpdate({ status: "ready", version: "2.0.0" });
    const { container } = await renderBanner(false, probeRuntimeActivity);

    expect(probeRuntimeActivity).toHaveBeenCalledOnce();
    expect(container.querySelector(".desktop-update-banner")).toBeNull();
    await act(async () => probe.resolve(false));
    expect(container.querySelector(".desktop-update-banner--expanded")).not.toBeNull();
  });

  it.each(["busy", "failure"] as const)("keeps only the expanded footer reminder after a %s decision", async (outcome) => {
    const probeRuntimeActivity = outcome === "busy"
      ? vi.fn(async () => true)
      : vi.fn(async () => Promise.reject(new Error("Activity owner unavailable")));
    installDesktopUpdate({ status: "ready", version: "2.0.0" });
    const { container } = await renderBanner(false, probeRuntimeActivity);

    expect(container.querySelector(".desktop-update-banner")).toBeNull();
    expect(container.querySelector(".desktop-update-restore")).not.toBeNull();
  });

  it("keeps exactly one collapsed flame while busy", async () => {
    installDesktopUpdate({ status: "ready", version: "2.0.0" });
    const { container } = await renderBanner(true, async () => true);

    expect(container.querySelector(".desktop-update-banner--rail")).not.toBeNull();
    expect(container.querySelectorAll(".desktop-update-banner--rail > button")).toHaveLength(1);
    expect(container.querySelector(".desktop-update-restore")).toBeNull();
  });

  it("polls at the bounded interval and reveals the expanded banner once activity is idle", async () => {
    vi.useFakeTimers();
    let busy = true;
    const probeRuntimeActivity = vi.fn(async () => busy);
    installDesktopUpdate({ status: "ready", version: "2.0.0" });
    const { container } = await renderBanner(false, probeRuntimeActivity);
    expect(container.querySelector(".desktop-update-banner")).toBeNull();
    expect(probeRuntimeActivity).toHaveBeenCalledOnce();

    busy = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(DESKTOP_UPDATE_BUSY_POLL_MS - 1); });
    expect(probeRuntimeActivity).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(probeRuntimeActivity).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".desktop-update-banner--expanded")).not.toBeNull();
  });

  it("does not hide the banner again after the user restores it while activity remains busy", async () => {
    vi.useFakeTimers();
    const probeRuntimeActivity = vi.fn(async () => true);
    installDesktopUpdate({ status: "ready", version: "2.0.0" });
    const { container } = await renderBanner(false, probeRuntimeActivity);
    expect(container.querySelector(".desktop-update-banner")).toBeNull();

    await act(async () => requireElement<HTMLButtonElement>(container, ".desktop-update-restore").click());
    expect(container.querySelector(".desktop-update-banner--expanded")).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(DESKTOP_UPDATE_BUSY_POLL_MS * 2); });
    expect(container.querySelector(".desktop-update-banner--expanded")).not.toBeNull();
    expect(probeRuntimeActivity).toHaveBeenCalledOnce();
  });

  it("re-probes a newer pending update and can reveal it after an older busy deferral", async () => {
    const probeRuntimeActivity = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const desktop = installDesktopUpdate({ status: "ready", version: "2.0.0" });
    const { container } = await renderBanner(false, probeRuntimeActivity);
    expect(container.querySelector(".desktop-update-banner")).toBeNull();

    await act(async () => desktop.publish({ status: "ready", version: "2.0.1" }));
    expect(probeRuntimeActivity).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("2.0.1");
  });

  it("never auto-restores a banner that the user dismissed", async () => {
    vi.useFakeTimers();
    const probeRuntimeActivity = vi.fn(async () => false);
    installDesktopUpdate({ status: "ready", version: "2.0.0" });
    const { container } = await renderBanner(false, probeRuntimeActivity);
    await act(async () => requireElement<HTMLButtonElement>(container, ".desktop-update-banner__dismiss").click());
    expect(container.querySelector(".desktop-update-banner")).toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(DESKTOP_UPDATE_BUSY_POLL_MS * 2); });
    expect(container.querySelector(".desktop-update-banner")).toBeNull();
    expect(probeRuntimeActivity).toHaveBeenCalledOnce();
  });
});

async function renderBanner(
  collapsed: boolean,
  probeRuntimeActivity: () => Promise<boolean>
): Promise<{ readonly container: HTMLDivElement; readonly root: Root }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<>
      <DesktopUpdateBanner collapsed={collapsed} probeRuntimeActivity={probeRuntimeActivity} t={t} />
      <DesktopUpdateRestoreButton suppressBusy={collapsed} t={t} />
    </>);
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
  return { container, root };
}

function installDesktopUpdate(initialStatus: JokoDesktopUpdateStatus): {
  readonly relaunch: ReturnType<typeof vi.fn>;
  readonly publish: (status: JokoDesktopUpdateStatus) => void;
} {
  const listeners = new Set<(status: JokoDesktopUpdateStatus) => void>();
  const relaunch = vi.fn(async () => ({ accepted: true as const }));
  Object.defineProperty(window, "jokoDesktop", {
    configurable: true,
    value: {
      capabilities: ["app.update"],
      updates: {
        getStatus: vi.fn(async () => initialStatus),
        check: vi.fn(async () => ({ status: "up-to-date" as const })),
        relaunch,
        relaunchStartup: vi.fn(async () => ({ accepted: true as const })),
        retryStartup: vi.fn(async () => ({ status: "up-to-date" as const })),
        onStatus: vi.fn((listener: (status: JokoDesktopUpdateStatus) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        })
      }
    } as unknown as JokoDesktopApi
  });
  return {
    relaunch,
    publish: (status) => {
      for (const listener of listeners) listener(status);
    }
  };
}

function requireElement<T extends Element>(container: ParentNode, selector: string): T {
  const value = container.querySelector<T>(selector);
  if (value === null) throw new Error(`Missing test element: ${selector}`);
  return value;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}
