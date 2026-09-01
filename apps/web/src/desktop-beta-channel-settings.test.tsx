// @vitest-environment jsdom

import { act, type JSX } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  desktopBetaChannelApi,
  useDesktopBetaChannelSettings
} from "./desktop-beta-channel-settings.js";
import { translate } from "./i18n.js";
import { DesktopBetaChannelSetting } from "./components/DesktopBetaChannelSetting.js";

const roots: Root[] = [];
beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "jokoDesktop");
});

describe("Desktop beta update channel", () => {
  it("hides the card unless the complete Desktop surface exists", async () => {
    let view = await renderSetting();
    expect(view.container.textContent).toBe("");
    await unmount(view.root);

    const fixture = createUpdates();
    installDesktop(fixture.updates, []);
    expect(desktopBetaChannelApi()).toBeUndefined();
    view = await renderSetting();
    expect(view.container.textContent).toBe("");
    await unmount(view.root);

    const incomplete = createUpdates().updates as unknown as Record<string, unknown>;
    Reflect.deleteProperty(incomplete, "probeBetaChannel");
    installDesktop(incomplete as unknown as JokoDesktopApi["updates"]);
    expect(desktopBetaChannelApi()).toBeUndefined();
    view = await renderSetting();
    expect(view.container.textContent).toBe("");
  });

  it("shows the beta-channel copy and keeps the default-off toggle disabled until hydration", async () => {
    const hydration = deferred<JokoDesktopUpdateChannelSettings>();
    const fixture = createUpdates();
    fixture.updates.getChannelSettings = vi.fn(() => hydration.promise);
    installDesktop(fixture.updates);
    const { container } = await renderSetting();

    expect(container.textContent).toContain("Experimental");
    expect(container.textContent).toContain("Beta channel");
    expect(container.textContent).toContain("Join the beta channel to receive upcoming client updates early. Takes effect after restart.");
    const toggle = checkbox(container);
    expect(controlChecked(toggle)).toBe(false);
    expect(toggle.disabled).toBe(true);

    await act(async () => hydration.resolve(channelSettings(false, false)));
    expect(controlChecked(toggle)).toBe(false);
    expect(toggle.disabled).toBe(false);
  });

  it("probes before enabling and never persists an unavailable or unreachable beta channel", async () => {
    const fixture = createUpdates();
    fixture.updates.probeBetaChannel = vi.fn(async () => ({ available: false }));
    installDesktop(fixture.updates);
    const { container } = await renderSetting();

    await act(async () => { checkbox(container).click(); });
    expect(fixture.updates.probeBetaChannel).toHaveBeenCalledOnce();
    expect(fixture.updates.setBetaChannelEnabled).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent)
      .toBe("The beta channel is unavailable — could not reach the beta update server.");
    expect(controlChecked(checkbox(container))).toBe(false);

    fixture.updates.probeBetaChannel = vi.fn(async () => { throw new Error("https://secret.invalid/token"); });
    await act(async () => { checkbox(container).click(); });
    expect(fixture.updates.setBetaChannelEnabled).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("secret.invalid");
    expect(container.querySelector('[role="alert"]')?.textContent)
      .toBe("The beta channel is unavailable — could not reach the beta update server.");
  });

  it("persists enablement, opens the Restart Joko modal, and restores focus when going back", async () => {
    const fixture = createUpdates();
    installDesktop(fixture.updates);
    const { container } = await renderSetting();
    const toggle = checkbox(container);

    await act(async () => { toggle.click(); });
    expect(fixture.updates.probeBetaChannel).toHaveBeenCalledOnce();
    expect(fixture.updates.setBetaChannelEnabled).toHaveBeenCalledWith(true);
    expect(controlChecked(toggle)).toBe(true);
    const dialog = requireElement<HTMLElement>(document, '[role="dialog"]');
    expect(dialog.textContent).toContain("Restart Joko");
    expect(dialog.textContent).toContain("The beta channel requires a restart to take effect. Restart now?");
    expect(buttonWithText(dialog, "Restart now")).toBe(document.activeElement);

    await act(async () => { backButton(dialog).click(); });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(toggle).toBe(document.activeElement);
    expect(fixture.updates.relaunchForChannelChange).not.toHaveBeenCalled();
  });

  it("uses allowBusy false first and exposes allowBusy true only after the exact busy confirmation", async () => {
    const fixture = createUpdates();
    fixture.updates.relaunchForChannelChange = vi.fn()
      .mockResolvedValueOnce({ accepted: false, reason: "busy" })
      .mockResolvedValueOnce({ accepted: true });
    installDesktop(fixture.updates);
    const { container } = await renderSetting();
    await act(async () => { checkbox(container).click(); });

    await act(async () => { buttonWithText(document, "Restart now").click(); });
    expect(fixture.updates.relaunchForChannelChange).toHaveBeenNthCalledWith(1, { allowBusy: false });
    const busyDialog = requireElement<HTMLElement>(document, '[role="dialog"]');
    expect(busyDialog.textContent)
      .toContain("Tasks are currently in progress and restarting will interrupt them. Restart now anyway?");
    expect(backButton(busyDialog)).toBe(document.activeElement);

    await act(async () => { buttonWithText(busyDialog, "Restart now").click(); });
    expect(fixture.updates.relaunchForChannelChange).toHaveBeenNthCalledWith(2, { allowBusy: true });
  });

  it("keeps an in-flight relaunch fenced when a matching settings push arrives", async () => {
    const relaunch = deferred<JokoDesktopUpdateRelaunchResult>();
    const fixture = createUpdates();
    fixture.updates.relaunchForChannelChange = vi.fn(() => relaunch.promise);
    installDesktop(fixture.updates);
    const { container } = await renderSetting();
    await act(async () => { checkbox(container).click(); });
    const restart = buttonWithText(document, "Restart now");

    await act(async () => { restart.click(); });
    expect(restart.disabled).toBe(true);
    await act(async () => fixture.publish(channelSettings(true, true)));
    expect(restart.disabled).toBe(true);
    await act(async () => { restart.click(); });
    expect(fixture.updates.relaunchForChannelChange).toHaveBeenCalledOnce();

    await act(async () => relaunch.resolve({ accepted: false, reason: "busy" }));
    expect(backButton(document).disabled).toBe(false);
  });

  it("disables without probing and shows the exact restart-later notice", async () => {
    const fixture = createUpdates(channelSettings(true, true));
    installDesktop(fixture.updates);
    const { container } = await renderSetting();

    expect(controlChecked(checkbox(container))).toBe(true);
    await act(async () => { checkbox(container).click(); });
    expect(fixture.updates.probeBetaChannel).not.toHaveBeenCalled();
    expect(fixture.updates.setBetaChannelEnabled).toHaveBeenCalledWith(false);
    expect(controlChecked(checkbox(container))).toBe(false);
    expect(container.querySelector('[role="status"]')?.textContent)
      .toBe("Beta channel disabled; takes effect after restart");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("shows customized state and returns focus to the toggle after restoring defaults", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const fixture = createUpdates(channelSettings(true, true));
    installDesktop(fixture.updates);
    const { container } = await renderSetting();
    const restore = requireElement<HTMLButtonElement>(container, '[aria-label="Restore default"]');

    expect(container.textContent).toContain("Customized");
    restore.focus();
    await act(async () => restore.click());

    expect(fixture.updates.resetChannelSettings).toHaveBeenCalledOnce();
    expect(controlChecked(checkbox(container))).toBe(false);
    expect(container.textContent).not.toContain("Customized");
    expect(container.querySelector('[aria-label="Restore default"]')).toBeNull();
    expect(document.activeElement).toBe(checkbox(container));
  });

  it("maps load, save, and relaunch failures to local enumerated copy without leaking IPC details", async () => {
    const fixture = createUpdates();
    fixture.updates.getChannelSettings = vi.fn()
      .mockRejectedValueOnce(new Error("C:\\private\\settings.json"))
      .mockResolvedValueOnce(channelSettings(false, false));
    fixture.updates.setBetaChannelEnabled = vi.fn(async () => { throw new Error("IPC_SECRET_SAVE"); });
    installDesktop(fixture.updates);
    const { container } = await renderSetting();

    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Beta channel settings could not be loaded.");
    expect(container.textContent).not.toContain("private");
    await act(async () => { buttonWithText(container, "Retry").click(); });
    await act(async () => { checkbox(container).click(); });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Failed to toggle beta channel");
    expect(container.textContent).not.toContain("IPC_SECRET_SAVE");

    fixture.updates.setBetaChannelEnabled = vi.fn(async () => channelSettings(true, true));
    fixture.updates.relaunchForChannelChange = vi.fn(async () => { throw new Error("SECRET_RESTART"); });
    await act(async () => { checkbox(container).click(); });
    await act(async () => { buttonWithText(document, "Restart now").click(); });
    expect(requireElement<HTMLElement>(document, '[role="dialog"] [role="alert"]').textContent)
      .toBe("Joko could not restart. Try again.");
    expect(document.body.textContent).not.toContain("SECRET_RESTART");
  });

  it("lets authoritative pushes supersede hydration and pending probes, then unsubscribes on unmount", async () => {
    const hydration = deferred<JokoDesktopUpdateChannelSettings>();
    const probe = deferred<{ readonly available: boolean }>();
    const fixture = createUpdates();
    fixture.updates.getChannelSettings = vi.fn(() => hydration.promise);
    fixture.updates.probeBetaChannel = vi.fn(() => probe.promise);
    installDesktop(fixture.updates);
    const harness = await renderHarness();

    await act(async () => fixture.publish(channelSettings(true, true)));
    await act(async () => hydration.resolve(channelSettings(false, false)));
    expect(harness.state().enableBeta).toBe(true);

    await act(async () => { void harness.actions().setEnableBeta(false); });
    await act(async () => fixture.publish(channelSettings(false, true)));
    expect(harness.state().enableBeta).toBe(false);

    await act(async () => { void harness.actions().setEnableBeta(true); });
    await act(async () => fixture.publish(channelSettings(false, true)));
    await act(async () => probe.resolve({ available: true }));
    expect(fixture.updates.setBetaChannelEnabled).toHaveBeenCalledTimes(1);

    await unmount(harness.root);
    expect(fixture.unsubscribe).toHaveBeenCalledOnce();
  });

  it("treats even a synchronous or persist-before-error channel push as the newest authority", async () => {
    const save = deferred<JokoDesktopUpdateChannelSettings>();
    const fixture = createUpdates();
    let channelListener: ((settings: JokoDesktopUpdateChannelSettings) => void) | undefined;
    fixture.updates.getChannelSettings = vi.fn(async () => channelSettings(false, false));
    fixture.updates.onChannelSettings = vi.fn((listener) => {
      channelListener = listener;
      listener(channelSettings(true, true));
      return () => { fixture.unsubscribe(); };
    });
    fixture.updates.setBetaChannelEnabled = vi.fn(() => save.promise);
    installDesktop(fixture.updates);
    const harness = await renderHarness();
    expect(harness.state().enableBeta).toBe(true);

    await act(async () => channelListener?.(channelSettings(false, true)));
    await act(async () => { void harness.actions().setEnableBeta(true); });
    await act(async () => channelListener?.(channelSettings(true, true)));
    await act(async () => save.reject(new Error("late transport failure")));
    expect(harness.state()).toMatchObject({
      enableBeta: true,
      restartPrompt: "restart"
    });
    expect(harness.state().error).toBeUndefined();
  });

  it("drops async completions after unmount and exposes reset semantics through the hook", async () => {
    const reset = deferred<JokoDesktopUpdateChannelSettings>();
    const fixture = createUpdates(channelSettings(true, true));
    fixture.updates.resetChannelSettings = vi.fn(() => reset.promise);
    installDesktop(fixture.updates);
    const harness = await renderHarness();

    await act(async () => { void harness.actions().reset(); });
    await act(async () => reset.resolve(channelSettings(false, false)));
    expect(harness.state()).toMatchObject({
      enableBeta: false,
      isCustomized: false,
      notice: "disabled"
    });

    const lateReset = deferred<JokoDesktopUpdateChannelSettings>();
    fixture.updates.resetChannelSettings = vi.fn(() => lateReset.promise);
    await act(async () => { void harness.actions().reset(); });
    const renders = harness.renderCount();
    await unmount(harness.root);
    await act(async () => lateReset.resolve(channelSettings(false, false)));
    expect(harness.renderCount()).toBe(renders);
  });
});

interface HarnessActions {
  readonly setEnableBeta: (enabled: boolean) => Promise<void>;
  readonly reset: () => Promise<void>;
}

async function renderHarness(): Promise<{
  readonly root: Root;
  readonly actions: () => HarnessActions;
  readonly state: () => ReturnType<typeof useDesktopBetaChannelSettings>["state"];
  readonly renderCount: () => number;
}> {
  let currentActions: HarnessActions | undefined;
  let currentState: ReturnType<typeof useDesktopBetaChannelSettings>["state"] | undefined;
  let renders = 0;
  function Harness(): JSX.Element {
    const value = useDesktopBetaChannelSettings();
    currentActions = value;
    currentState = value.state;
    renders += 1;
    return <output>{value.state.enableBeta ? "on" : "off"}</output>;
  }
  const { root } = await render(<Harness />);
  return {
    root,
    actions: () => currentActions as HarnessActions,
    state: () => currentState as ReturnType<typeof useDesktopBetaChannelSettings>["state"],
    renderCount: () => renders
  };
}

async function renderSetting(): Promise<{ readonly container: HTMLDivElement; readonly root: Root }> {
  return render(<DesktopBetaChannelSetting t={(key, values) => translate("en", key, values)} />);
}

async function render(element: JSX.Element): Promise<{ readonly container: HTMLDivElement; readonly root: Root }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(element);
    await Promise.resolve();
    await Promise.resolve();
  });
  return { container, root };
}

async function unmount(root: Root): Promise<void> {
  await act(async () => root.unmount());
  const index = roots.indexOf(root);
  if (index >= 0) roots.splice(index, 1);
}

function checkbox(container: ParentNode): HTMLButtonElement {
  return requireElement<HTMLButtonElement>(container, 'button[role="switch"]');
}

function controlChecked(control: HTMLElement): boolean {
  return control.getAttribute("aria-checked") === "true";
}

function backButton(container: ParentNode): HTMLButtonElement {
  return requireElement<HTMLButtonElement>(container, 'button[aria-label="Back"]');
}

function buttonWithText(container: ParentNode, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent === label);
  if (button === undefined) throw new Error(`Missing button: ${label}`);
  return button;
}

function requireElement<T extends Element>(container: ParentNode, selector: string): T {
  const value = container.querySelector<T>(selector);
  if (value === null) throw new Error(`Missing test element: ${selector}`);
  return value;
}

function installDesktop(
  updates: JokoDesktopApi["updates"],
  capabilities: readonly JokoDesktopCapability[] = ["app.update"]
): void {
  Object.defineProperty(window, "jokoDesktop", {
    configurable: true,
    value: { capabilities, updates } as unknown as JokoDesktopApi
  });
}

function createUpdates(initial = channelSettings(false, false)): {
  readonly updates: JokoDesktopApi["updates"];
  readonly publish: (settings: JokoDesktopUpdateChannelSettings) => void;
  readonly unsubscribe: () => void;
} {
  const listeners = new Set<(settings: JokoDesktopUpdateChannelSettings) => void>();
  const unsubscribe = vi.fn((): void => undefined);
  const updates: JokoDesktopApi["updates"] = {
    getStatus: vi.fn(async () => ({ status: "idle", availability: "available" } as const)),
    check: vi.fn(async () => ({ status: "up-to-date" as const })),
    relaunch: vi.fn(async () => ({ accepted: true as const })),
    relaunchStartup: vi.fn(async () => ({ accepted: true as const })),
    retryStartup: vi.fn(async () => ({ status: "up-to-date" as const })),
    onStatus: vi.fn(() => vi.fn()),
    getAutoRelaunchSettings: vi.fn(async () => ({ autoRelaunchOnIdle: false, isCustomized: false, defaultAutoRelaunchOnIdle: false })),
    setAutoRelaunchOnIdle: vi.fn(async (enabled) => ({ autoRelaunchOnIdle: enabled, isCustomized: true, defaultAutoRelaunchOnIdle: false })),
    resetAutoRelaunchSettings: vi.fn(async () => ({ autoRelaunchOnIdle: false, isCustomized: false, defaultAutoRelaunchOnIdle: false })),
    getChannelSettings: vi.fn(async () => initial),
    setBetaChannelEnabled: vi.fn(async (enabled) => channelSettings(enabled, true)),
    resetChannelSettings: vi.fn(async () => channelSettings(false, false)),
    probeBetaChannel: vi.fn(async () => ({ available: true })),
    relaunchForChannelChange: vi.fn(async () => ({ accepted: true as const })),
    onChannelSettings: vi.fn((listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        unsubscribe();
      };
    })
  };
  return {
    updates,
    publish: (settings) => {
      for (const listener of listeners) listener(settings);
    },
    unsubscribe
  };
}

function channelSettings(enableBeta: boolean, isCustomized: boolean): JokoDesktopUpdateChannelSettings {
  return { enableBeta, isCustomized, defaultEnableBeta: false };
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
