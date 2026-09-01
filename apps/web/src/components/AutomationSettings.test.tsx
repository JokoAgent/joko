// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import { emptySnapshot, type AppSnapshot } from "../model.js";
import { AutomationSettings, validateBrowserServiceSettings } from "./AutomationSettings.js";
import { SettingsPage } from "./SettingsPage.js";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("AutomationSettings", () => {
  it("mounts Browser, Computer, and Android in order and keeps persisted Computer opt-in checked while runtime is unready", async () => {
    const controller = controllerFixture();
    const container = await render(controller, snapshot());

    expect([...container.querySelectorAll<HTMLElement>("[data-automation-card]")]
      .map((card) => card.dataset.automationCard)).toEqual(["browser", "computer", "android"]);
    expect(container.textContent).toContain("Android automation");

    const computerToggle = required(container.querySelector<HTMLButtonElement>('[data-automation-toggle="computer"]'));
    expect(computerToggle.getAttribute("aria-checked")).toBe("true");
    expect(computerToggle.disabled).toBe(false);
    expect(container.querySelectorAll(".automation-permission")).toHaveLength(2);

    await act(async () => computerToggle.click());
    expect(controller.updateComputerAutomationSettings).toHaveBeenCalledWith(false);
  });

  it("switches the browser automation target through the typed settings mutation", async () => {
    const controller = controllerFixture();
    const container = await render(controller, snapshot());

    const sidebar = required(container.querySelector<HTMLButtonElement>('[data-automation-target="sidebar"]'));
    const external = required(container.querySelector<HTMLButtonElement>('[data-automation-target="external"]'));
    expect(external.getAttribute("aria-selected")).toBe("true");
    expect(sidebar.getAttribute("aria-selected")).toBe("false");

    await act(async () => sidebar.click());
    expect(controller.updateBrowserSettings).toHaveBeenCalledWith("browser-local", { automationTarget: "sidebar" });
  });

  it("opens a detected external browser and uses a forced external Chrome download when missing", async () => {
    const controller = controllerFixture();
    const detected = await render(controller, snapshot());

    await act(async () => required(detected.querySelector<HTMLButtonElement>(".automation-browser__external-action")).click());
    expect(controller.showBrowserAutomation).toHaveBeenCalledWith("browser-local", "target-local");

    const missing = await render(controller, snapshot({ detectedBrowser: "" }));
    await act(async () => required(missing.querySelector<HTMLButtonElement>(".automation-browser__download")).click());
    expect(controller.openHttpLink).toHaveBeenCalledWith("https://www.google.com/chrome/", { forceExternal: true });
  });

  it("recovers an unhealthy sidebar and routes each macOS permission action independently", async () => {
    const controller = controllerFixture();
    const container = await render(controller, snapshot({ target: "sidebar", browserState: "error" }));

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("The browser could not start");
    await act(async () => required(container.querySelector<HTMLButtonElement>(".automation-browser__recover")).click());
    expect(controller.restartBrowser).toHaveBeenCalledWith("browser-local");

    await act(async () => required(container.querySelector<HTMLButtonElement>('[data-automation-permission="accessibility"]')).click());
    await act(async () => required(container.querySelector<HTMLButtonElement>('[data-automation-permission="screenRecording"]')).click());
    expect(controller.openComputerAutomationPermissionSettings).toHaveBeenNthCalledWith(1, "accessibility");
    expect(controller.openComputerAutomationPermissionSettings).toHaveBeenNthCalledWith(2, "screenRecording");
    expect(controller.requestComputerAutomationPermission).toHaveBeenNthCalledWith(1, "accessibility");
    expect(controller.requestComputerAutomationPermission).toHaveBeenNthCalledWith(2, "screenRecording");

    await act(async () => required(container.querySelector<HTMLButtonElement>(".automation-computer__recheck")).click());
    expect(controller.probeComputerAutomation).toHaveBeenCalledWith(true);
  });

  it("binds Browser implicitly to the current project and disables the switch without one", async () => {
    const controller = controllerFixture();
    const withoutProject = await render(controller, snapshot({ projectAvailable: false }));

    expect(withoutProject.querySelector(".automation-browser-workspace")).toBeNull();
    expect(required(withoutProject.querySelector<HTMLButtonElement>('[data-automation-toggle="browser"]')).disabled).toBe(true);
    expect(withoutProject.textContent).toContain("Open a project before changing browser access");

    const withProject = await render(controller, snapshot());
    const toggle = required(withProject.querySelector<HTMLButtonElement>('[data-automation-toggle="browser"]'));
    await act(async () => toggle.click());
    expect(controller.updateBrowserSettings).toHaveBeenCalledWith("browser-local", { targetId: "target-local", enabled: false });
  });

  it("mounts service-scoped Browser settings even when no target is active", async () => {
    const controller = controllerFixture();
    const container = await render(controller, snapshot({ projectAvailable: false }));

    expect(required(container.querySelector<HTMLButtonElement>('[data-automation-toggle="browser"]')).disabled).toBe(true);
    const profile = required(container.querySelector<HTMLInputElement>('[data-automation-browser-service="profile"]'));
    const timeout = required(container.querySelector<HTMLInputElement>('[data-automation-browser-service="timeout"]'));
    const uploads = required(container.querySelector<HTMLInputElement>('[data-automation-browser-service="uploads"]'));
    const downloads = required(container.querySelector<HTMLInputElement>('[data-automation-browser-service="downloads"]'));
    expect(profile.value).toBe("Agent browser");
    expect(timeout.value).toBe("300");
    expect(profile.disabled).toBe(false);
    expect(timeout.disabled).toBe(false);
    expect(uploads.disabled).toBe(false);
    expect(downloads.disabled).toBe(false);
  });

  it("mounts Browser service settings through the Automation settings route", async () => {
    window.history.replaceState(null, "", "/#/settings/automation");
    const controller = controllerFixture();
    const value = snapshot({ projectAvailable: false });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(
      <SettingsPage
        controller={controller}
        snapshot={value}
        locale="en"
        t={(key, values) => translate("en", key, values)}
        runAction={(_key, action) => { void action(); }}
      />
    ));

    expect(container.querySelector('[data-automation-card="browser"]')).not.toBeNull();
    expect(container.querySelector('[data-automation-browser-service="profile"]')).not.toBeNull();
    expect(container.querySelector('[data-automation-browser-service="timeout"]')).not.toBeNull();
    expect(container.querySelector('[data-automation-browser-service="uploads"]')).not.toBeNull();
    expect(container.querySelector('[data-automation-browser-service="downloads"]')).not.toBeNull();
  });

  it("patches Browser service settings without a target identity and keeps transfer policies independent", async () => {
    const controller = controllerFixture();
    const container = await render(controller, snapshot({ projectAvailable: false }));
    const profile = required(container.querySelector<HTMLInputElement>('[data-automation-browser-service="profile"]'));
    const timeout = required(container.querySelector<HTMLInputElement>('[data-automation-browser-service="timeout"]'));

    await act(async () => {
      changeInput(profile, "Research browser");
      changeInput(timeout, "900");
    });
    await act(async () => buttonWithText(container, "Save browser settings").click());
    expect(controller.updateBrowserSettings).toHaveBeenNthCalledWith(1, "browser-local", {
      profileDisplayName: "Research browser",
      takeoverTimeoutSeconds: 900
    });

    await act(async () => required(container.querySelector<HTMLButtonElement>('[data-automation-browser-service="uploads"]')).click());
    await act(async () => required(container.querySelector<HTMLButtonElement>('[data-automation-browser-service="downloads"]')).click());
    expect(controller.updateBrowserSettings).toHaveBeenNthCalledWith(2, "browser-local", { allowUploads: false });
    expect(controller.updateBrowserSettings).toHaveBeenNthCalledWith(3, "browser-local", { allowDownloads: false });
  });

  it("rejects Browser profile and takeover drafts outside the service validation boundary", async () => {
    expect(validateBrowserServiceSettings(" Browser", "300").profileValid).toBe(false);
    expect(validateBrowserServiceSettings("B".repeat(129), "300").profileValid).toBe(false);
    expect(validateBrowserServiceSettings("Browser", "0").timeoutValid).toBe(false);
    expect(validateBrowserServiceSettings("Browser", "1.5").timeoutValid).toBe(false);
    expect(validateBrowserServiceSettings("Browser", "86401").timeoutValid).toBe(false);
    expect(validateBrowserServiceSettings("Browser", "86400")).toEqual({
      profileValid: true,
      timeoutValid: true,
      timeoutSeconds: 86_400
    });

    const controller = controllerFixture();
    const container = await render(controller, snapshot());
    const profile = required(container.querySelector<HTMLInputElement>('[data-automation-browser-service="profile"]'));
    const timeout = required(container.querySelector<HTMLInputElement>('[data-automation-browser-service="timeout"]'));
    await act(async () => {
      changeInput(profile, " ");
      changeInput(timeout, "0");
    });
    expect(profile.getAttribute("aria-invalid")).toBe("true");
    expect(timeout.getAttribute("aria-invalid")).toBe("true");
    const save = buttonWithText(container, "Save browser settings");
    expect(save.disabled).toBe(true);
    await act(async () => save.click());
    expect(controller.updateBrowserSettings).not.toHaveBeenCalled();
  });

  it("shows structured embedded health only for the sidebar and keeps reconnect available in ready state", async () => {
    const controller = controllerFixture();
    const sidebar = await render(controller, snapshot({ target: "sidebar" }));
    const reconnect = required(sidebar.querySelector<HTMLButtonElement>(".automation-browser__recover"));
    expect(reconnect.textContent).toContain("Reconnect");
    expect(reconnect.disabled).toBe(false);

    const external = await render(controller, snapshot({ target: "external" }));
    expect(external.querySelector(".automation-browser__recover")).toBeNull();
    expect(external.textContent).toContain("Detected Google Chrome");
  });

  it("opens a granted macOS permission pane without starting grant and cancels an active grant on unmount", async () => {
    const grantedController = controllerFixture();
    const granted = await render(grantedController, snapshot({ accessibilityPermission: "granted" }));
    await act(async () => required(granted.querySelector<HTMLButtonElement>('[data-automation-permission="accessibility"]')).click());
    expect(grantedController.openComputerAutomationPermissionSettings).toHaveBeenCalledWith("accessibility");
    expect(grantedController.requestComputerAutomationPermission).not.toHaveBeenCalled();

    const missingController = controllerFixture();
    const missing = await render(missingController, snapshot());
    await act(async () => required(missing.querySelector<HTMLButtonElement>('[data-automation-permission="accessibility"]')).click());
    const root = required(roots.pop());
    await act(async () => root.unmount());
    expect(missingController.cancelComputerAutomationPermission).toHaveBeenCalledOnce();
  });

  it("does not start a native permission grant after leaving while its settings pane is opening", async () => {
    let finishOpening!: () => void;
    const controller = controllerFixture();
    controller.openComputerAutomationPermissionSettings = vi.fn(() => new Promise<void>((resolve) => {
      finishOpening = resolve;
    }));
    const container = await render(controller, snapshot());

    await act(async () => {
      required(container.querySelector<HTMLButtonElement>('[data-automation-permission="accessibility"]')).click();
    });
    const root = required(roots.pop());
    await act(async () => root.unmount());
    await act(async () => finishOpening());

    expect(controller.requestComputerAutomationPermission).not.toHaveBeenCalled();
  });

  it("routes first enable through the mutation that installs a missing computer driver", async () => {
    const controller = controllerFixture();
    const container = await render(controller, snapshot({ installed: false, computerEnabled: false }));

    const toggle = required(container.querySelector<HTMLButtonElement>('[data-automation-toggle="computer"]'));
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await act(async () => toggle.click());
    expect(controller.updateComputerAutomationSettings).toHaveBeenCalledWith(true);
    expect(controller.installComputerAutomation).not.toHaveBeenCalled();
  });

  it("shows the compact Windows install activity with a spinner while first enable is in flight", async () => {
    let finish!: () => void;
    const controller = controllerFixture();
    controller.updateComputerAutomationSettings = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const container = await render(controller, snapshot({
      installed: false,
      computerEnabled: false,
      computerPlatform: "win32"
    }));

    await act(async () => required(container.querySelector<HTMLButtonElement>('[data-automation-toggle="computer"]')).click());
    expect(container.querySelector(".automation-computer__installing")?.textContent).toContain("Installing cua-driver…");

    await act(async () => finish());
  });

  it("checks installed driver updates once per mount and routes the compact update footer", async () => {
    const controller = controllerFixture();
    const container = await render(controller, snapshot({
      updateAvailable: true,
      updateLatestVersion: "0.8.0"
    }));

    expect(controller.checkComputerAutomationUpdate).toHaveBeenCalledOnce();
    expect(controller.checkComputerAutomationUpdate).toHaveBeenCalledWith(false);
    expect(container.textContent).toContain("New version v0.8.0 available");
    await act(async () => buttonWithText(container, "Update").click());
    expect(controller.updateComputerAutomationDriver).toHaveBeenCalledWith(false);
  });

  it("joins an update already running and renders bounded download progress", async () => {
    const controller = controllerFixture();
    const container = await render(controller, snapshot({
      updateAvailable: true,
      updateLatestVersion: "0.8.0",
      updateInProgress: true,
      updatePhase: "downloading",
      updateDownloadedBytes: 25,
      updateTotalBytes: 100
    }));

    expect(controller.updateComputerAutomationDriver).toHaveBeenCalledWith(true);
    expect(container.textContent).toContain("Updating…");
    expect(buttonWithText(container, "Updating…").disabled).toBe(true);
  });

  it("does not touch ADB while disabled and enables Android through the machine-wide mutation", async () => {
    const controller = controllerFixture();
    const container = await render(controller, snapshot());
    expect(controller.prepareAndroidAdb).not.toHaveBeenCalled();
    expect(controller.probeAndroidAutomation).not.toHaveBeenCalled();

    const refresh = required(container.querySelector<HTMLButtonElement>(".automation-android__refresh"));
    expect(refresh.disabled).toBe(false);
    await act(async () => refresh.click());
    expect(controller.probeAndroidAutomation).toHaveBeenCalledWith(true);

    const toggle = required(container.querySelector<HTMLButtonElement>('[data-automation-toggle="android"]'));
    await act(async () => toggle.click());
    expect(controller.updateAndroidAutomationSettings).toHaveBeenCalledWith(true);
  });

  it("prepares enabled Android automation and routes device, refresh, and ADB path reset actions", async () => {
    const controller = controllerFixture();
    const container = await render(controller, snapshot({ androidEnabled: true }));
    expect(controller.prepareAndroidAdb).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("1 ready device connected");

    await act(async () => required(container.querySelector<HTMLButtonElement>(".automation-android__device-trigger")).click());
    const device = [...container.querySelectorAll<HTMLButtonElement>(".automation-android__device-option")]
      .find((option) => option.textContent?.includes("Pixel 9"));
    await act(async () => required(device).click());
    expect(controller.selectAndroidAutomationDevice).toHaveBeenCalledWith("device-1");

    await act(async () => required(container.querySelector<HTMLButtonElement>(".automation-android__refresh")).click());
    expect(controller.probeAndroidAutomation).toHaveBeenCalledWith(true);

    const actions = [...container.querySelectorAll<HTMLButtonElement>(".automation-android__path-actions .button")];
    await act(async () => required(actions.at(-1)).click());
    expect(controller.setAndroidAdbPath).toHaveBeenCalledWith();
  });

  it("keeps a manually observed disabled device picker usable", async () => {
    const controller = controllerFixture();
    const container = await render(controller, snapshot({ androidObserved: true }));

    expect(container.textContent).toContain("1 ready device connected");
    const picker = required(container.querySelector<HTMLButtonElement>(".automation-android__device-trigger"));
    expect(picker.disabled).toBe(false);
    await act(async () => picker.click());
    const device = [...container.querySelectorAll<HTMLButtonElement>(".automation-android__device-option")]
      .find((option) => option.textContent?.includes("Pixel 9"));
    await act(async () => required(device).click());
    expect(controller.selectAndroidAutomationDevice).toHaveBeenCalledWith("device-1");
  });

  it("gives the Android device listbox complete keyboard and dismissal semantics", async () => {
    const controller = controllerFixture();
    const base = snapshot({ androidEnabled: true });
    const value: AppSnapshot = {
      ...base,
      settings: {
        ...base.settings,
        androidAutomation: {
          ...base.settings.androidAutomation,
          configuredDefaultDeviceSerial: "device-1",
          devices: [
            {
              deviceSerial: "offline-device",
              state: "offline",
              product: "offline",
              model: "Unavailable phone",
              device: "offline",
              transportId: "2",
              usb: "1-2"
            },
            ...base.settings.androidAutomation.devices,
            {
              deviceSerial: "device-2",
              state: "device",
              product: "felix",
              model: "Pixel Fold",
              device: "felix",
              transportId: "3",
              usb: "1-3"
            }
          ]
        }
      }
    };
    const container = await render(controller, value);
    const trigger = required(container.querySelector<HTMLButtonElement>(".automation-android__device-trigger"));

    await act(async () => trigger.click());
    let menu = required(container.querySelector<HTMLDivElement>('[role="listbox"]'));
    let enabled = [...menu.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)')];
    expect(document.activeElement?.textContent).toContain("Pixel 9");
    expect(menu.querySelector<HTMLButtonElement>("button:disabled")?.textContent).toContain("Unavailable phone");

    await act(async () => fireKey(document.activeElement as HTMLElement, "ArrowDown"));
    expect(document.activeElement?.textContent).toContain("Pixel Fold");
    await act(async () => fireKey(document.activeElement as HTMLElement, "ArrowDown"));
    expect(document.activeElement).toBe(enabled[0]);
    await act(async () => fireKey(document.activeElement as HTMLElement, "End"));
    expect(document.activeElement).toBe(enabled.at(-1));
    await act(async () => fireKey(document.activeElement as HTMLElement, "Home"));
    expect(document.activeElement).toBe(enabled[0]);
    await act(async () => fireKey(document.activeElement as HTMLElement, "p"));
    expect(document.activeElement?.textContent).toContain("Pixel 9");
    await act(async () => fireKey(document.activeElement as HTMLElement, "p"));
    expect(document.activeElement?.textContent).toContain("Pixel Fold");

    await act(async () => fireKey(document.activeElement as HTMLElement, "Escape"));
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await act(async () => fireKey(trigger, "ArrowUp"));
    menu = required(container.querySelector<HTMLDivElement>('[role="listbox"]'));
    enabled = [...menu.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)')];
    expect(document.activeElement).toBe(enabled.at(-1));
    await act(async () => fireKey(document.activeElement as HTMLElement, " "));
    expect(controller.selectAndroidAutomationDevice).toHaveBeenCalledWith("device-2");
    expect(document.activeElement).toBe(trigger);

    await act(async () => trigger.click());
    const tabEvent = fireKey(document.activeElement as HTMLElement, "Tab");
    expect(tabEvent.defaultPrevented).toBe(false);
    const nextControl = required(container.querySelector<HTMLInputElement>(
      '.automation-android__path-actions input'
    ));
    await act(async () => nextControl.focus());
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(nextControl);

    await act(async () => trigger.click());
    await act(async () => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });
});

function controllerFixture(): AppController {
  return {
    updateBrowserSettings: vi.fn(async () => undefined),
    showBrowserAutomation: vi.fn(async () => undefined),
    restartBrowser: vi.fn(async () => undefined),
    updateComputerAutomationSettings: vi.fn(async () => undefined),
    installComputerAutomation: vi.fn(async () => undefined),
    probeComputerAutomation: vi.fn(async () => undefined),
    requestComputerAutomationPermission: vi.fn(async () => undefined),
    cancelComputerAutomationPermission: vi.fn(async () => undefined),
    openComputerAutomationPermissionSettings: vi.fn(async () => undefined),
    checkComputerAutomationUpdate: vi.fn(async () => undefined),
    updateComputerAutomationDriver: vi.fn(async () => undefined),
    updateAndroidAutomationSettings: vi.fn(async () => undefined),
    prepareAndroidAdb: vi.fn(async () => undefined),
    probeAndroidAutomation: vi.fn(async () => undefined),
    selectAndroidAutomationDevice: vi.fn(async () => undefined),
    setAndroidAdbPath: vi.fn(async () => undefined),
    openHttpLink: vi.fn(async () => undefined)
  } as unknown as AppController;
}

async function render(controller: AppController, value: AppSnapshot): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(
    <AutomationSettings
      controller={controller}
      snapshot={value}
      activeTargetId={value.targets.some((target) => target.id === "target-local") ? "target-local" : undefined}
      runAction={(_key, action) => { void action(); }}
      t={(key, values) => translate("en", key, values)}
    />
  ));
  return container;
}

function snapshot(overrides: {
  readonly target?: "sidebar" | "external";
  readonly detectedBrowser?: string;
  readonly browserState?: AppSnapshot["browsers"][number]["state"];
  readonly projectAvailable?: boolean;
  readonly installed?: boolean;
  readonly computerEnabled?: boolean;
  readonly computerPlatform?: "darwin" | "win32";
  readonly androidEnabled?: boolean;
  readonly androidObserved?: boolean;
  readonly updateAvailable?: boolean;
  readonly updateLatestVersion?: string;
  readonly updateInProgress?: boolean;
  readonly updatePhase?: AppSnapshot["settings"]["computerAutomation"]["updatePhase"];
  readonly updateDownloadedBytes?: number;
  readonly updateTotalBytes?: number;
  readonly accessibilityPermission?: AppSnapshot["settings"]["computerAutomation"]["accessibilityPermission"];
  readonly screenRecordingPermission?: AppSnapshot["settings"]["computerAutomation"]["screenRecordingPermission"];
} = {}): AppSnapshot {
  const base = emptySnapshot();
  const androidReady = overrides.androidEnabled === true || overrides.androidObserved === true;
  const projectAvailable = overrides.projectAvailable !== false;
  return {
    ...base,
    targets: projectAvailable ? [{
      id: "target-local",
      backendId: "backend-local",
      name: "Project",
      workspaceId: "workspace-local",
      workspaceName: "Project",
      trusted: true,
      pinned: false,
      archived: false
    }] : [],
    browsers: [{
      id: "browser-local",
      name: "Agent browser",
      state: overrides.browserState ?? "ready",
      generation: 1n,
      pages: []
    }],
    settings: {
      ...base.settings,
      browsers: [{
        browserProviderId: "browser-local",
        profileDisplayName: "Agent browser",
        takeoverTimeoutSeconds: 300,
        allowUploads: true,
        allowDownloads: true,
        automationTarget: overrides.target ?? "external",
        support: "supported",
        supportReason: "",
        detectedBrowser: overrides.detectedBrowser ?? "Google Chrome",
        targetSettings: projectAvailable ? [{ targetId: "target-local", enabled: true }] : [],
        backendHealth: {
          active: overrides.browserState !== "error",
          status: overrides.browserState === "error" ? "error" : "ready",
          canRecover: true,
          ...(overrides.browserState === "error" ? { reason: "startFailed" as const } : {})
        }
      }],
      computerAutomation: {
        enabled: overrides.computerEnabled ?? true,
        support: "supported",
        supportReason: "",
        installed: overrides.installed ?? true,
        driverVersion: overrides.installed === false ? "" : "0.7.0",
        daemonRunning: false,
        accessibilityPermission: overrides.accessibilityPermission ?? "missing",
        screenRecordingPermission: overrides.screenRecordingPermission ?? "missing",
        screenRecordingCapturable: false,
        ready: false,
        runtimeState: "unavailable",
        failureReason: "",
        platform: overrides.computerPlatform ?? "darwin",
        updateCurrentVersion: overrides.installed === false ? "" : "0.7.0",
        updateLatestVersion: overrides.updateLatestVersion ?? "",
        updateAvailable: overrides.updateAvailable ?? false,
        updateInProgress: overrides.updateInProgress ?? false,
        updatePhase: overrides.updatePhase ?? "idle",
        ...(overrides.updateDownloadedBytes === undefined ? {} : { updateDownloadedBytes: overrides.updateDownloadedBytes }),
        ...(overrides.updateTotalBytes === undefined ? {} : { updateTotalBytes: overrides.updateTotalBytes })
      },
      androidAutomation: {
        enabled: overrides.androidEnabled ?? false,
        support: "supported",
        supportReason: "",
        adbAvailable: androidReady,
        adbPath: androidReady ? "C:\\Android\\platform-tools\\adb.exe" : "",
        adbPathSource: androidReady ? "prepared" : "unspecified",
        preparationSupported: true,
        preparationReady: androidReady,
        preparationError: "",
        adbVersion: androidReady ? "1.0.41" : "",
        devices: androidReady ? [{
          deviceSerial: "device-1",
          state: "device",
          product: "komodo",
          model: "Pixel 9",
          device: "komodo",
          transportId: "1",
          usb: "1-1"
        }] : [],
        defaultDeviceSerial: androidReady ? "device-1" : "",
        configuredDefaultDeviceSerial: "",
        adbPathOverride: "",
        issue: androidReady ? "unspecified" : "adbNotFound",
        failureReason: "",
        platform: "win32",
        runtimeState: overrides.androidEnabled ? "ready" : "disabled",
        statusObserved: androidReady
      }
    }
  };
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected rendered element");
  return value;
}

function buttonWithText(container: ParentNode, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === text);
  if (button === undefined) throw new Error(`Expected a button labelled ${text}.`);
  return button;
}

function fireKey(target: HTMLElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

function changeInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter === undefined) throw new Error("Expected the native input value setter");
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}
