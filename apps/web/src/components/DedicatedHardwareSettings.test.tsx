// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createUnavailableDedicatedHardwareSnapshot,
  setDedicatedHardwareModelState,
  type DedicatedHardwareBridge,
  type DedicatedHardwarePreviewInput,
  type DedicatedHardwareSnapshot
} from "../dedicated-hardware.js";
import type { Translator } from "./types.js";
import { DedicatedHardwareSettings } from "./DedicatedHardwareSettings.js";
import type { AppController } from "../controller.js";

const roots: Root[] = [];
const t = ((key: string) => key) as Translator;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setVisibility("visible");
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("DedicatedHardwareSettings", () => {
  it("shows both supported models and a fail-closed Desktop-only state on the web", async () => {
    const rendered = await renderSettings();

    expect(rendered.container.textContent).toContain("Dedicated hardware is available in Joko Desktop.");
    expect(rendered.container.textContent).toContain("Codex Micro");
    expect(rendered.container.textContent).toContain("Creator Micro 2");
    expect(rendered.container.querySelector('[data-web-unavailable="true"]')).not.toBeNull();
    expect(control<HTMLInputElement>(rendered.container, "Enable Codex Micro").disabled).toBe(true);
    expect(control<HTMLInputElement>(rendered.container, "Brightness").matches(":disabled")).toBe(true);
  });

  it("lets the latest overlapping save own the UI and ignores an older completion", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const bridge = createBridge(connectedSnapshot(), {
      setDedicatedHardwareSettings: vi.fn()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise)
    });
    const rendered = await renderSettings(bridge);
    await loaded(rendered.container);
    const enable = control<HTMLInputElement>(rendered.container, "Enable Codex Micro");

    await act(async () => enable.click());
    expect(enable.checked).toBe(true);
    await act(async () => enable.click());
    expect(enable.checked).toBe(false);
    expect(bridge.setDedicatedHardwareSettings).toHaveBeenCalledTimes(2);

    await act(async () => second.resolve(undefined));
    expect(enable.checked).toBe(false);
    expect(rendered.container.textContent).toContain("Hardware settings saved.");
    await act(async () => first.resolve(undefined));
    expect(enable.checked).toBe(false);
  });

  it("rolls a failed latest mutation back to the last confirmed settings", async () => {
    const failure = deferred<unknown>();
    const bridge = createBridge(connectedSnapshot(), { setDedicatedHardwareSettings: vi.fn(() => failure.promise) });
    const rendered = await renderSettings(bridge);
    await loaded(rendered.container);
    const source = control<HTMLSelectElement>(rendered.container, "Task key source");
    expect(source.value).toBe("last-sent");

    await changeSelect(source, "priority");
    expect(source.value).toBe("priority");
    await act(async () => failure.reject(new Error("disk full")));

    expect(source.value).toBe("last-sent");
    expect(rendered.container.textContent).toContain("The change was not saved. Confirmed settings were restored.");
  });

  it("resets layout and all settings while retaining enablement", async () => {
    let snapshot = connectedSnapshot();
    const model = snapshot.models["codex-micro"];
    snapshot = setDedicatedHardwareModelState(snapshot, {
      ...model,
      settings: {
        ...model.settings,
        enabled: true,
        lighting: { brightnessPercent: 35, autoDim: "off" },
        layout: { ...model.settings.layout, encoderMode: "custom" }
      }
    });
    const bridge = createBridge(snapshot);
    const rendered = await renderSettings(bridge);
    await loaded(rendered.container);
    await vi.waitFor(() => expect(bridge.setDedicatedHardwarePreview).toHaveBeenCalledWith("codex-micro", true));
    vi.mocked(bridge.setDedicatedHardwarePreview).mockClear();

    await clickButton(rendered.container, "Restore layout");
    await flush();
    expect(bridge.resetDedicatedHardwareSettings).toHaveBeenLastCalledWith("codex-micro", "layout");
    expect(control<HTMLInputElement>(rendered.container, "Enable Codex Micro").checked).toBe(true);
    expect(control<HTMLInputElement>(rendered.container, "Brightness").value).toBe("35");
    await vi.waitFor(() => expect(bridge.setDedicatedHardwarePreview).toHaveBeenCalledWith("codex-micro", false));
    await vi.waitFor(() => expect(bridge.setDedicatedHardwarePreview).toHaveBeenCalledWith("codex-micro", true));
    vi.mocked(bridge.setDedicatedHardwarePreview).mockClear();

    await clickButton(rendered.container, "Restore all hardware settings");
    await flush();
    expect(bridge.resetDedicatedHardwareSettings).toHaveBeenLastCalledWith("codex-micro", "all");
    expect(control<HTMLInputElement>(rendered.container, "Enable Codex Micro").checked).toBe(true);
    expect(control<HTMLInputElement>(rendered.container, "Brightness").value).toBe("100");
    await vi.waitFor(() => expect(bridge.setDedicatedHardwarePreview).toHaveBeenCalledWith("codex-micro", false));
    await vi.waitFor(() => expect(bridge.setDedicatedHardwarePreview).toHaveBeenCalledWith("codex-micro", true));
  });

  it("reacquires preview after a settings mutation settles and the service has revoked the old lease", async () => {
    const saved = deferred<unknown>();
    const bridge = createBridge(enabledConnectedSnapshot(), {
      setDedicatedHardwareSettings: vi.fn(() => saved.promise)
    });
    const rendered = await renderSettings(bridge);
    await loaded(rendered.container);
    await vi.waitFor(() => expect(bridge.setDedicatedHardwarePreview).toHaveBeenCalledWith("codex-micro", true));
    vi.mocked(bridge.setDedicatedHardwarePreview).mockClear();

    await changeSelect(control<HTMLSelectElement>(rendered.container, "Task key source"), "priority");
    await vi.waitFor(() => expect(bridge.setDedicatedHardwarePreview).toHaveBeenCalledWith("codex-micro", true));
    const callsBeforeSettlement = vi.mocked(bridge.setDedicatedHardwarePreview).mock.calls.length;
    await act(async () => saved.resolve(undefined));

    await vi.waitFor(() => expect(vi.mocked(bridge.setDedicatedHardwarePreview).mock.calls.length).toBeGreaterThan(callsBeforeSettlement + 1));
    expect(vi.mocked(bridge.setDedicatedHardwarePreview).mock.calls.slice(callsBeforeSettlement)).toEqual([
      ["codex-micro", false],
      ["codex-micro", true]
    ]);
    expect(rendered.container.querySelector('[data-dedicated-hardware-preview="true"]')).not.toBeNull();
  });

  it("surfaces a settings-store failure, disables edits, and leaves recovery reset available", async () => {
    let snapshot = connectedSnapshot();
    snapshot = setDedicatedHardwareModelState(snapshot, { ...snapshot.models["codex-micro"], settingsError: "invalid" });
    const bridge = createBridge(snapshot);
    const rendered = await renderSettings(bridge);
    await vi.waitFor(() => expect(rendered.container.textContent).toContain("Saved hardware settings are invalid."));

    expect(control<HTMLInputElement>(rendered.container, "Enable Codex Micro").disabled).toBe(true);
    const reset = [...rendered.container.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.textContent === "Restore all hardware settings");
    expect(reset?.disabled).toBe(false);
    await act(async () => reset?.click());
    await flush();
    expect(bridge.resetDedicatedHardwareSettings).toHaveBeenCalledWith("codex-micro", "all");
  });

  it("shows recovery-required only for Creator and invokes the explicit recover bridge", async () => {
    let required = connectedSnapshot();
    required = setDedicatedHardwareModelState(required, {
      ...required.models["creator-micro-2"],
      keymap: { phase: "error", backupAvailable: true, failure: "recovery-required" }
    });
    const recovered = setDedicatedHardwareModelState(required, {
      ...required.models["creator-micro-2"],
      keymap: { phase: "idle", backupAvailable: false, failure: null }
    });
    const bridge = createBridge(required, {
      recoverDedicatedHardwareKeymap: vi.fn(async () => recovered)
    });
    const rendered = await renderSettings(bridge);
    await loaded(rendered.container);
    expect(rendered.container.textContent).not.toContain("Device keymap recovery required");

    await clickButton(rendered.container, "Creator Micro 2");
    await vi.waitFor(() => expect(rendered.container.textContent).toContain("Device keymap recovery required"));
    await clickButton(rendered.container, "Recover original keymap");

    expect(bridge.recoverDedicatedHardwareKeymap).toHaveBeenCalledExactlyOnceWith("creator-micro-2");
    await vi.waitFor(() => expect(rendered.container.textContent).not.toContain("Device keymap recovery required"));
    expect(rendered.container.textContent).toContain("Keymap recovery completed.");
  });

  it("leases preview per selected model and renders input without subscribing to action dispatch", async () => {
    let previewListener: ((input: unknown) => void) | undefined;
    const actionSubscription = vi.fn(() => () => undefined);
    const bridge = createBridge(enabledConnectedSnapshot(), {
      onDedicatedHardwarePreviewInput: vi.fn((listener: (input: unknown) => void) => { previewListener = listener; return () => { previewListener = undefined; }; }),
      onDedicatedHardwareAction: actionSubscription
    });
    const rendered = await renderSettings(bridge);
    await loaded(rendered.container);
    expect(bridge.setDedicatedHardwarePreview).toHaveBeenCalledWith("codex-micro", true);

    await act(async () => previewListener?.({ version: 1, model: "codex-micro", kind: "key", key: "ACT12", pressed: true } satisfies DedicatedHardwarePreviewInput));
    expect(rendered.container.querySelector('[data-key="ACT12"]')?.classList.contains("is-pressed")).toBe(true);
    await act(async () => previewListener?.({ version: 1, model: "codex-micro", kind: "stick", x: .5, y: -.25, pressed: true } satisfies DedicatedHardwarePreviewInput));
    expect(rendered.container.querySelector<HTMLElement>(".dedicated-hardware-stick > span")?.style.transform).toBe("translate(11px, -5.5px)");
    await act(async () => previewListener?.({ version: 1, model: "codex-micro", kind: "encoder", delta: 1, pressed: false } satisfies DedicatedHardwarePreviewInput));
    expect(rendered.container.querySelector<HTMLElement>(".dedicated-hardware-encoder > span")?.style.transform).toBe("rotate(18deg)");
    expect(actionSubscription).not.toHaveBeenCalled();

    await clickButton(rendered.container, "Creator Micro 2");
    await flush();
    expect(bridge.setDedicatedHardwarePreview).toHaveBeenCalledWith("codex-micro", false);
    expect(bridge.setDedicatedHardwarePreview).toHaveBeenCalledWith("creator-micro-2", true);

    await act(async () => rendered.root.unmount());
    roots.splice(roots.indexOf(rendered.root), 1);
    expect(bridge.setDedicatedHardwarePreview).toHaveBeenCalledWith("creator-micro-2", false);
  });

  it("polls every two seconds only while the document is visible", async () => {
    vi.useFakeTimers();
    const bridge = createBridge(enabledConnectedSnapshot());
    await renderSettings(bridge, 2_000);
    await act(async () => Promise.resolve());
    expect(bridge.getDedicatedHardwareState).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(4_000));
    expect(bridge.getDedicatedHardwareState).toHaveBeenCalledTimes(3);
    setVisibility("hidden");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => vi.advanceTimersByTimeAsync(6_000));
    expect(bridge.getDedicatedHardwareState).toHaveBeenCalledTimes(3);
    expect(bridge.setDedicatedHardwarePreview).toHaveBeenCalledWith("codex-micro", false);

    setVisibility("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => Promise.resolve());
    expect(bridge.getDedicatedHardwareState).toHaveBeenCalledTimes(4);
    expect(bridge.setDedicatedHardwarePreview).toHaveBeenCalledWith("codex-micro", true);
  });

  it("never acquires preview while disabled or disconnected and does not expose a failed lease", async () => {
    const disabled = createBridge(connectedSnapshot());
    const disabledView = await renderSettings(disabled);
    await loaded(disabledView.container);
    expect(disabled.setDedicatedHardwarePreview).not.toHaveBeenCalled();
    expect(disabledView.container.querySelector("[data-dedicated-hardware-preview]")).toBeNull();

    const failed = createBridge(enabledConnectedSnapshot(), {
      setDedicatedHardwarePreview: vi.fn(async (_model, enabled) => {
        if (enabled) throw new Error("lease denied");
      })
    });
    const failedView = await renderSettings(failed);
    await loaded(failedView.container);
    await vi.waitFor(() => expect(failedView.container.textContent).toContain("Live input preview is unavailable."));
    expect(failedView.container.querySelector("[data-dedicated-hardware-preview]")).toBeNull();
  });

  it("loads enabled skills from the current server catalog for new bindings", async () => {
    const listSkills = vi.fn(async () => ({
      revision: 1n,
      skills: [{
        id: "review-skill",
        backendId: "backend",
        scope: "global" as const,
        name: "Review changes",
        sourceLabel: "review-skill",
        state: "loaded" as const,
        enabled: true,
        canToggle: true,
        contentAvailable: true,
        canEdit: true,
        canDelete: true,
        revision: 1n,
        approvedRevision: "revision",
        updatedAt: 1
      }]
    })) as unknown as AppController["listSkills"];
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container); roots.push(root);
    await act(async () => root.render(<DedicatedHardwareSettings
      t={t}
      bridge={createBridge(connectedSnapshot())}
      listSkills={listSkills}
      serverId="server"
      connected
    />));
    await vi.waitFor(() => expect(listSkills).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect([...container.querySelectorAll("option")].some((option) => option.textContent?.includes("Review changes") === true)).toBe(true));
    expect(container.textContent).not.toContain("The skill catalog is not available in this settings view.");
  });
});

async function renderSettings(bridge?: DedicatedHardwareBridge, pollIntervalMs = 60_000): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container); roots.push(root);
  await act(async () => root.render(<DedicatedHardwareSettings t={t} bridge={bridge} pollIntervalMs={pollIntervalMs}
    skills={[{ serverId: "server", resourceId: "review", name: "Review changes" }]} />));
  return { container, root };
}

function connectedSnapshot(): DedicatedHardwareSnapshot {
  let snapshot = createUnavailableDedicatedHardwareSnapshot();
  for (const model of ["codex-micro", "creator-micro-2"] as const) snapshot = setDedicatedHardwareModelState(snapshot, {
    ...snapshot.models[model],
    status: "connected",
    reason: null,
    devicePresent: true,
    transport: "usb",
    firmwareVersion: "1.2.3",
    batteryPercent: 72,
    charging: false,
    inputPermission: "granted"
  });
  return snapshot;
}

function enabledConnectedSnapshot(): DedicatedHardwareSnapshot {
  let snapshot = connectedSnapshot();
  for (const model of ["codex-micro", "creator-micro-2"] as const) snapshot = setDedicatedHardwareModelState(snapshot, {
    ...snapshot.models[model],
    settings: { ...snapshot.models[model].settings, enabled: true }
  });
  return snapshot;
}

function createBridge(snapshot: DedicatedHardwareSnapshot, patch: Partial<DedicatedHardwareBridge> = {}): DedicatedHardwareBridge {
  const bridge: DedicatedHardwareBridge = {
    getDedicatedHardwareState: vi.fn(async () => snapshot),
    setDedicatedHardwareSettings: vi.fn(async () => undefined),
    resetDedicatedHardwareSettings: vi.fn(async () => undefined),
    probeDedicatedHardware: vi.fn(async () => snapshot),
    recoverDedicatedHardwareKeymap: vi.fn(async () => snapshot),
    setDedicatedHardwarePreview: vi.fn(async () => undefined),
    publishDedicatedHardwareTasks: vi.fn(async () => undefined),
    acknowledgeDedicatedHardwareTaskFocus: vi.fn(async () => false),
    openDedicatedHardwareInputSettings: vi.fn(async () => true)
  };
  return { ...bridge, ...patch, recoverDedicatedHardwareKeymap:
    patch.recoverDedicatedHardwareKeymap ?? bridge.recoverDedicatedHardwareKeymap };
}

async function loaded(container: HTMLElement): Promise<void> {
  await vi.waitFor(() => expect(control<HTMLInputElement>(container, "Enable Codex Micro").disabled).toBe(false));
}

function control<T extends HTMLElement>(container: HTMLElement, label: string): T {
  const element = container.querySelector<T>(`[aria-label="${label}"]`);
  if (element === null) throw new Error(`Control not found: ${label}`);
  return element;
}

async function changeSelect(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    setter?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function clickButton(container: HTMLElement, text: string): Promise<void> {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.includes(text));
  if (button === undefined) throw new Error(`Button not found: ${text}`);
  await act(async () => button.click());
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function setVisibility(value: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
}
