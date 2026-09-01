// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import type { AutomaticConnectionTarget } from "../local-state.js";
import type { ConnectionProfile } from "../model.js";
import type { Translator } from "./types.js";
import { ConnectionScreen } from "./ConnectionScreen.js";

const managedConnection: JokoDesktopManagedOrchestratorConnection = {
  profileId: "managed-local-profile",
  deviceId: "managed-local-device",
  serverId: "managed-local-server",
  name: "Local Joko",
  origin: "http://127.0.0.1:4318"
};

const localProfile: ConnectionProfile = {
  id: managedConnection.profileId,
  deviceId: managedConnection.deviceId,
  serverId: managedConnection.serverId,
  name: managedConnection.name,
  origin: managedConnection.origin,
  managedLocal: true
};

const remoteProfile: ConnectionProfile = {
  id: "remote-profile",
  deviceId: "remote-device",
  serverId: "remote-server",
  name: "Remote Joko",
  origin: "https://orchestrator.example.test"
};

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      media: "",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true)
    })
  });
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.deleteProperty(window, "matchMedia");
  Reflect.deleteProperty(window, "isSecureContext");
});

describe("ConnectionScreen connection choice", () => {
  it("switches both the illustration group and Light/Dark theme from the title icon", async () => {
    const setTheme = vi.fn(async () => undefined);
    const controller = controllerFixture({ setTheme });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<ConnectionScreen controller={controller} t={translator} />));

    const artwork = container.querySelector<HTMLButtonElement>(".connection-hero__artwork");
    const firstArtwork = artwork?.dataset.artwork;
    const titleIcon = container.querySelector<HTMLButtonElement>(".connection-title-icon");
    await act(async () => titleIcon?.click());

    expect(setTheme).toHaveBeenCalledWith("dark");
    expect(artwork?.dataset.artwork).not.toBe(firstArtwork);

    await act(async () => root.unmount());
    container.remove();
  });

  it("shows bundled local and remote choices together and defaults automatic entry on", async () => {
    const connect = vi.fn(async () => undefined);
    const controller = controllerFixture({
      connect,
      managedOrchestratorStatus: { state: "ready", connection: managedConnection }
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<ConnectionScreen controller={controller} t={translator} />));

    const localButton = container.querySelector<HTMLButtonElement>("button[data-managed-local-connect]");
    const automatic = container.querySelector<HTMLInputElement>(".connection-auto-choice input");
    const tabs = [...container.querySelectorAll<HTMLButtonElement>(".connection-tabs button")];
    expect(localButton).not.toBeNull();
    expect(automatic?.checked).toBe(true);
    expect(tabs).toHaveLength(3);
    expect(tabs.every((tab) => !tab.disabled)).toBe(true);

    await act(async () => localButton?.click());
    expect(connect).toHaveBeenLastCalledWith(localProfile, { automatic: true });

    await act(async () => automatic?.click());
    await act(async () => localButton?.click());
    expect(connect).toHaveBeenLastCalledWith(localProfile, { automatic: false });

    await act(async () => root.unmount());
    container.remove();
  });

  it("keeps all remote methods available while the bundled service is still starting", async () => {
    const controller = controllerFixture({ managedOrchestratorStatus: { state: "starting" } });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<ConnectionScreen controller={controller} t={translator} />));

    expect(container.querySelector(".local-connection-card[data-state='starting']")).not.toBeNull();
    const tabs = [...container.querySelectorAll<HTMLButtonElement>(".connection-tabs button")];
    expect(tabs).toHaveLength(3);
    expect(tabs.every((tab) => !tab.disabled)).toBe(true);

    await act(async () => root.unmount());
    container.remove();
  });

  it("applies the bundled Desktop default to saved and newly paired remote connections", async () => {
    const connect = vi.fn(async () => undefined);
    const pair = vi.fn(async () => undefined);
    const controller = controllerFixture({
      connect,
      pair,
      managedOrchestratorStatus: { state: "ready", connection: managedConnection }
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<ConnectionScreen controller={controller} t={translator} />));

    const remoteButton = container.querySelector<HTMLButtonElement>(".profile-list .button");
    const automatic = container.querySelector<HTMLInputElement>(".connection-auto-choice input");
    await act(async () => remoteButton?.click());
    expect(connect).toHaveBeenLastCalledWith(remoteProfile, { automatic: true });

    await act(async () => automatic?.click());
    const pairTab = [...container.querySelectorAll<HTMLButtonElement>(".connection-tabs button")][2];
    await act(async () => pairTab?.click());
    const codeInput = container.querySelector<HTMLInputElement>('input[autocomplete="one-time-code"]');
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      valueSetter?.call(codeInput, "PAIR-CODE");
      codeInput?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLFormElement>(".pair-form")?.requestSubmit());
    expect(pair).toHaveBeenLastCalledWith(
      "http://127.0.0.1:4318",
      "PAIR-CODE",
      expect.any(String),
      { automatic: false }
    );

    await act(async () => root.unmount());
    container.remove();
  });

  it("freezes the automatic-entry choice while a connection selection is in flight", async () => {
    let finishPair: (() => void) | undefined;
    const pair = vi.fn(() => new Promise<void>((resolve) => { finishPair = resolve; }));
    const controller = controllerFixture({
      pair,
      managedOrchestratorStatus: { state: "ready", connection: managedConnection }
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<ConnectionScreen controller={controller} t={translator} />));
    const pairTab = [...container.querySelectorAll<HTMLButtonElement>(".connection-tabs button")][2];
    await act(async () => pairTab?.click());
    const codeInput = container.querySelector<HTMLInputElement>('input[autocomplete="one-time-code"]');
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      valueSetter?.call(codeInput, "PAIR-CODE");
      codeInput?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLFormElement>(".pair-form")?.requestSubmit());

    const automatic = container.querySelector<HTMLInputElement>(".connection-auto-choice input");
    expect(pair).toHaveBeenCalledOnce();
    expect(automatic?.checked).toBe(true);
    expect(automatic?.disabled).toBe(true);

    await act(async () => finishPair?.());
    await act(async () => root.unmount());
    container.remove();
  });

  it("keeps automatic entry off by default when no bundled Desktop service exists", async () => {
    const connect = vi.fn(async () => undefined);
    const controller = controllerFixture({ connect });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<ConnectionScreen controller={controller} t={translator} />));

    const automatic = container.querySelector<HTMLInputElement>(".connection-auto-choice input");
    expect(automatic?.checked).toBe(false);
    const remoteButton = container.querySelector<HTMLButtonElement>(".profile-list .button");
    await act(async () => remoteButton?.click());
    expect(connect).toHaveBeenLastCalledWith(remoteProfile, { automatic: false });

    await act(async () => root.unmount());
    container.remove();
  });

  it("lets the user explicitly turn off a remembered automatic target", async () => {
    const setAutomaticConnectionEnabled = vi.fn(async () => undefined);
    const controller = controllerFixture({
      managedOrchestratorStatus: { state: "ready", connection: managedConnection },
      automaticConnectionTarget: { kind: "profile", profileId: remoteProfile.id },
      setAutomaticConnectionEnabled
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<ConnectionScreen controller={controller} t={translator} />));

    const automatic = container.querySelector<HTMLInputElement>(".connection-auto-choice input");
    expect(automatic?.checked).toBe(true);
    await act(async () => automatic?.click());
    expect(setAutomaticConnectionEnabled).toHaveBeenCalledWith(false);
    expect(automatic?.checked).toBe(false);

    await act(async () => root.unmount());
    container.remove();
  });

  it("disables automatic entry when the browser cannot persist encrypted credentials", async () => {
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
    const controller = controllerFixture({ managedOrchestratorStatus: { state: "starting" }, automaticConnectionAvailable: false });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => root.render(<ConnectionScreen controller={controller} t={translator} />));

      const automatic = container.querySelector<HTMLInputElement>(".connection-auto-choice input");
      expect(automatic?.disabled).toBe(true);
      expect(automatic?.checked).toBe(false);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    }
  });

  it("still lets the user turn off an existing target while protected storage is unavailable", async () => {
    const setAutomaticConnectionEnabled = vi.fn(async () => undefined);
    const controller = controllerFixture({
      managedOrchestratorStatus: { state: "starting" },
      automaticConnectionAvailable: false,
      automaticConnectionTarget: { kind: "profile", profileId: remoteProfile.id },
      setAutomaticConnectionEnabled
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<ConnectionScreen controller={controller} t={translator} />));

    const automatic = container.querySelector<HTMLInputElement>(".connection-auto-choice input");
    expect(automatic?.checked).toBe(true);
    expect(automatic?.disabled).toBe(false);
    await act(async () => automatic?.click());
    expect(setAutomaticConnectionEnabled).toHaveBeenCalledWith(false);

    await act(async () => root.unmount());
    container.remove();
  });

  it("prefills the persisted managed origin when recovery uses a fallback port", async () => {
    const fallbackManagedProfile = { ...localProfile, origin: "http://127.0.0.1:49152" };
    const controller = controllerFixture({
      managedOrchestratorStatus: { state: "recoveryRequired", reason: "credentialRejected" },
      managedProfile: fallbackManagedProfile
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<ConnectionScreen controller={controller} t={translator} />));

    const recoveryButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("managedOrchestrator.recoverAccess"));
    await act(async () => recoveryButton?.click());

    expect(container.querySelector<HTMLInputElement>('input[type="url"]')?.value).toBe(fallbackManagedProfile.origin);
    expect(container.textContent).toContain("managedOrchestrator.credentialRejected");
    expect(container.textContent).not.toContain("connection.localReady");

    await act(async () => root.unmount());
    container.remove();
  });

  it("keeps the internal architecture name out of connection errors", async () => {
    const controller = controllerFixture({
      error: "Desktop-managed Orchestrator runtime state is unavailable.",
      discoveryError: "Orchestrator discovery failed."
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<ConnectionScreen controller={controller} t={translator} />));

    expect(container.textContent).toContain("Desktop-managed Joko node runtime state is unavailable.");
    const nearbyTab = [...container.querySelectorAll<HTMLButtonElement>(".connection-tabs button")][0];
    await act(async () => nearbyTab?.click());
    expect(container.textContent).toContain("Joko node discovery failed.");
    expect(container.textContent).not.toContain("Orchestrator");

    await act(async () => root.unmount());
    container.remove();
  });
});

const translator: Translator = (key) => key;

function controllerFixture(overrides: {
  readonly setTheme?: AppController["setTheme"];
  readonly connect?: AppController["connect"];
  readonly pair?: AppController["pair"];
  readonly managedOrchestratorStatus?: JokoDesktopManagedOrchestratorStatus;
  readonly managedProfile?: ConnectionProfile;
  readonly automaticConnectionAvailable?: boolean;
  readonly automaticConnectionTarget?: AutomaticConnectionTarget;
  readonly setAutomaticConnectionEnabled?: AppController["setAutomaticConnectionEnabled"];
  readonly error?: string;
  readonly discoveryError?: string;
}): AppController {
  return {
    state: {
      ready: true,
      connectionState: "disconnected",
      profiles: [overrides.managedProfile ?? localProfile, remoteProfile],
      activeProfile: undefined,
      managedOrchestratorStatus: overrides.managedOrchestratorStatus,
      automaticConnectionAvailable: overrides.automaticConnectionAvailable ?? true,
      preferences: {
        theme: "light",
        locale: "en",
        ...(overrides.automaticConnectionTarget === undefined ? {} : { automaticConnectionTarget: overrides.automaticConnectionTarget })
      },
      error: overrides.error,
      discoveryState: "idle",
      discoveryError: overrides.discoveryError,
      discoveredNodes: []
    },
    setTheme: overrides.setTheme ?? vi.fn(async () => undefined),
    connect: overrides.connect ?? vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    pair: overrides.pair ?? vi.fn(async () => undefined),
    forgetProfile: vi.fn(async () => undefined),
    refreshDiscoveredNodes: vi.fn(async () => undefined),
    retryManagedOrchestrator: vi.fn(async () => undefined),
    cancelAutomaticConnectionAttempt: vi.fn(),
    setAutomaticConnectionEnabled: overrides.setAutomaticConnectionEnabled ?? vi.fn(async () => undefined)
  } as unknown as AppController;
}
