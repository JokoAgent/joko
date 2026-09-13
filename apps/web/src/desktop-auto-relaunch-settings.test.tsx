// @vitest-environment jsdom

import { act, type JSX } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  desktopAutoRelaunchApi,
  useDesktopAutoRelaunchSettings
} from "./desktop-auto-relaunch-settings.js";
import { translate } from "./i18n.js";
import { DesktopAutoRelaunchSetting } from "./components/DesktopAutoRelaunchSetting.js";

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

describe("Desktop idle update settings", () => {
  it("stays hidden outside Desktop and when any settings method or capability is absent", async () => {
    let view = await renderSetting();
    expect(view.container.textContent).toBe("");
    await unmount(view.root);

    installDesktop(validUpdates(), []);
    expect(desktopAutoRelaunchApi()).toBeUndefined();
    view = await renderSetting();
    expect(view.container.textContent).toBe("");
    await unmount(view.root);

    const incomplete = validUpdates() as unknown as Record<string, unknown>;
    Reflect.deleteProperty(incomplete, "resetAutoRelaunchSettings");
    installDesktop(incomplete as unknown as JokoDesktopApi["updates"]);
    expect(desktopAutoRelaunchApi()).toBeUndefined();
    view = await renderSetting();
    expect(view.container.textContent).toBe("");
  });

  it("renders the label and description with a disabled false default until hydration", async () => {
    const hydration = deferred<JokoDesktopAutoRelaunchSettings>();
    installDesktop({ ...validUpdates(), getAutoRelaunchSettings: vi.fn(() => hydration.promise) });
    const { container } = await renderSetting();

    expect(container.textContent).toContain("Install updates while idle");
    expect(container.textContent).toContain("idle for 10 minutes and no tasks are running");
    const toggle = checkbox(container);
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(true);

    await act(async () => hydration.resolve(settings(false, false)));
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(false);
  });

  it("persists toggles, exposes customization, and restores the bridge default", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const updates = validUpdates();
    updates.setAutoRelaunchOnIdle = vi.fn(async (enabled) => settings(enabled, true));
    updates.resetAutoRelaunchSettings = vi.fn(async () => settings(false, false));
    installDesktop(updates);
    const { container } = await renderSetting();
    const toggle = checkbox(container);

    await act(async () => { toggle.click(); });
    expect(updates.setAutoRelaunchOnIdle).toHaveBeenCalledWith(true);
    expect(toggle.checked).toBe(true);
    expect(container.textContent).toContain("Customized");

    const reset = container.querySelector<HTMLButtonElement>('button[aria-label="Restore default"]');
    expect(reset).not.toBeNull();
    reset?.focus();
    await act(async () => { reset?.click(); });
    expect(updates.resetAutoRelaunchSettings).toHaveBeenCalledOnce();
    expect(toggle.checked).toBe(false);
    expect(container.textContent).not.toContain("Customized");
    expect(container.querySelector('button[aria-label="Restore default"]')).toBeNull();
    expect(document.activeElement).toBe(switchControl(container));
  });

  it("keeps localized load and mutation failures visible without leaking bridge errors", async () => {
    const updates = validUpdates();
    updates.getAutoRelaunchSettings = vi.fn()
      .mockRejectedValueOnce(new Error("private IPC detail"))
      .mockResolvedValueOnce(settings(false, false));
    updates.setAutoRelaunchOnIdle = vi.fn(async () => { throw new Error("secret path"); });
    installDesktop(updates);
    const { container } = await renderSetting();

    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Idle update settings could not be loaded.");
    expect(container.textContent).not.toContain("private IPC detail");
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "Retry");
    await act(async () => { retry?.click(); });
    expect(updates.getAutoRelaunchSettings).toHaveBeenCalledTimes(2);

    await act(async () => { checkbox(container).click(); });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Idle update settings could not be saved. Try again.");
    expect(container.textContent).not.toContain("secret path");
    expect(checkbox(container).checked).toBe(false);
    expect(checkbox(container).disabled).toBe(false);
  });

  it("lets the newest mutation or reset win and ignores every superseded response", async () => {
    const firstSet = deferred<JokoDesktopAutoRelaunchSettings>();
    const secondSet = deferred<JokoDesktopAutoRelaunchSettings>();
    const reset = deferred<JokoDesktopAutoRelaunchSettings>();
    const updates = validUpdates();
    updates.setAutoRelaunchOnIdle = vi.fn()
      .mockImplementationOnce(() => firstSet.promise)
      .mockImplementationOnce(() => secondSet.promise);
    updates.resetAutoRelaunchSettings = vi.fn(() => reset.promise);
    installDesktop(updates);
    const harness = await renderHarness();

    await act(async () => {
      void harness.actions().setAutoRelaunchOnIdle(true);
      void harness.actions().setAutoRelaunchOnIdle(false);
    });
    await act(async () => secondSet.resolve(settings(false, true)));
    expect(harness.state().autoRelaunchOnIdle).toBe(false);
    await act(async () => firstSet.resolve(settings(true, true)));
    expect(harness.state().autoRelaunchOnIdle).toBe(false);

    const lateSet = deferred<JokoDesktopAutoRelaunchSettings>();
    updates.setAutoRelaunchOnIdle = vi.fn(() => lateSet.promise);
    await act(async () => {
      void harness.actions().setAutoRelaunchOnIdle(true);
      void harness.actions().reset();
    });
    await act(async () => reset.resolve(settings(false, false)));
    await act(async () => lateSet.resolve(settings(true, true)));
    expect(harness.state()).toMatchObject({
      autoRelaunchOnIdle: false,
      isCustomized: false,
      saving: false
    });
    expect(harness.state().error).toBeUndefined();
  });

  it("drops hydration and mutation completions after unmount", async () => {
    const hydration = deferred<JokoDesktopAutoRelaunchSettings>();
    const updates = validUpdates();
    updates.getAutoRelaunchSettings = vi.fn(() => hydration.promise);
    installDesktop(updates);
    const harness = await renderHarness();
    await unmount(harness.root);
    await act(async () => hydration.resolve(settings(true, true)));
    expect(harness.renderCount()).toBe(1);
  });
});

interface HarnessActions {
  readonly setAutoRelaunchOnIdle: (enabled: boolean) => Promise<void>;
  readonly reset: () => Promise<void>;
}

async function renderHarness(): Promise<{
  readonly root: Root;
  readonly actions: () => HarnessActions;
  readonly state: () => ReturnType<typeof useDesktopAutoRelaunchSettings>["state"];
  readonly renderCount: () => number;
}> {
  let currentActions: HarnessActions | undefined;
  let currentState: ReturnType<typeof useDesktopAutoRelaunchSettings>["state"] | undefined;
  let renders = 0;
  function Harness(): JSX.Element {
    const value = useDesktopAutoRelaunchSettings();
    currentActions = value;
    currentState = value.state;
    renders += 1;
    return <output>{value.state.autoRelaunchOnIdle ? "on" : "off"}</output>;
  }
  const { root } = await render(<Harness />);
  return {
    root,
    actions: () => currentActions as HarnessActions,
    state: () => currentState as ReturnType<typeof useDesktopAutoRelaunchSettings>["state"],
    renderCount: () => renders
  };
}

async function renderSetting(): Promise<{ readonly container: HTMLDivElement; readonly root: Root }> {
  return render(<DesktopAutoRelaunchSetting t={(key, values) => translate("en", key, values)} />);
}

async function render(element: JSX.Element): Promise<{ readonly container: HTMLDivElement; readonly root: Root }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(element);
    await Promise.resolve();
  });
  return { container, root };
}

async function unmount(root: Root): Promise<void> {
  await act(async () => root.unmount());
  const index = roots.indexOf(root);
  if (index >= 0) roots.splice(index, 1);
}

function checkbox(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (input === null) throw new Error("missing auto-relaunch toggle");
  return input;
}

function switchControl(container: HTMLElement): HTMLButtonElement {
  const control = container.querySelector<HTMLButtonElement>('button[role="switch"]');
  if (control === null) throw new Error("missing auto-relaunch switch");
  return control;
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

function validUpdates(): JokoDesktopApi["updates"] {
  return {
    getStatus: vi.fn(async () => ({ status: "idle", availability: "available" } as const)),
    check: vi.fn(async () => ({ status: "up-to-date" as const })),
    relaunch: vi.fn(async () => ({ accepted: true as const })),
    relaunchStartup: vi.fn(async () => ({ accepted: true as const })),
    retryStartup: vi.fn(async () => ({ status: "up-to-date" as const })),
    onStatus: vi.fn(() => vi.fn()),
    getAutoRelaunchSettings: vi.fn(async () => settings(false, false)),
    setAutoRelaunchOnIdle: vi.fn(async (enabled) => settings(enabled, true)),
    resetAutoRelaunchSettings: vi.fn(async () => settings(false, false)),
    getChannelSettings: vi.fn(async () => channelSettings(false, false)),
    setBetaChannelEnabled: vi.fn(async (enabled) => channelSettings(enabled, true)),
    resetChannelSettings: vi.fn(async () => channelSettings(false, false)),
    probeBetaChannel: vi.fn(async () => ({ available: true })),
    relaunchForChannelChange: vi.fn(async () => ({ accepted: true as const })),
    onChannelSettings: vi.fn(() => vi.fn())
  };
}

function settings(autoRelaunchOnIdle: boolean, isCustomized: boolean): JokoDesktopAutoRelaunchSettings {
  return { autoRelaunchOnIdle, isCustomized, defaultAutoRelaunchOnIdle: false };
}

function channelSettings(enableBeta: boolean, isCustomized: boolean): JokoDesktopUpdateChannelSettings {
  return { enableBeta, isCustomized, defaultEnableBeta: false };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}
