// @vitest-environment jsdom

import { act } from "react";
import type { JSX } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import { emptySnapshot } from "../model.js";
import { readActivationClickPreference } from "../window-activation-click.js";
import { GeneralSettings } from "./SettingsPage.js";

interface WindowInteractionSettings {
  readonly swallowActivationClick: boolean;
}

type WindowInteractionListener = (settings: WindowInteractionSettings) => void;

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  window.localStorage.clear();
  Reflect.deleteProperty(window, "jokoDesktop");
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

it("subscribes before the initial read and fences newer hints, replacement, and unmount", async () => {
  const initial = deferred<WindowInteractionSettings>();
  const first = windowInteraction({ initial: () => initial.promise });
  installDesktop(first.interaction);
  const mounted = await mount(general());
  const toggle = activationClickToggle(mounted.container);

  expect(first.order.slice(0, 2)).toEqual(["subscribe", "get"]);
  expect(toggle.disabled).toBe(true);

  await act(async () => first.emit(true));
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(readActivationClickPreference()).toBe(true);

  await act(async () => initial.resolve({ swallowActivationClick: false }));
  expect(toggle.getAttribute("aria-checked")).toBe("true");

  const second = windowInteraction({ initial: async () => ({ swallowActivationClick: false }) });
  installDesktop(second.interaction);
  await act(async () => mounted.root.render(general()));
  await vi.waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
  expect(first.unsubscribe).toHaveBeenCalledOnce();
  expect(second.order.slice(0, 2)).toEqual(["subscribe", "get"]);

  await act(async () => first.invokeRetired(true));
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(readActivationClickPreference()).toBe(false);

  await act(async () => mounted.root.render(<></>));
  expect(second.unsubscribe).toHaveBeenCalledOnce();
  await act(async () => second.invokeRetired(true));
  expect(readActivationClickPreference()).toBe(false);
});

it("serializes same-batch changes and keeps newer Main hints over stale mutation results", async () => {
  const firstSet = deferred<WindowInteractionSettings>();
  const authoritativeSet = deferred<WindowInteractionSettings>();
  const authoritativeRecovery = deferred<WindowInteractionSettings>();
  const hintedSet = deferred<WindowInteractionSettings>();
  const hintedRecovery = deferred<WindowInteractionSettings>();
  const unknownSet = deferred<WindowInteractionSettings>();
  const unavailableRecovery = deferred<WindowInteractionSettings>();
  const interaction = windowInteraction({
    initial: vi.fn()
      .mockResolvedValueOnce({ swallowActivationClick: false })
      .mockImplementationOnce(() => authoritativeRecovery.promise)
      .mockImplementationOnce(() => hintedRecovery.promise)
      .mockImplementationOnce(() => unavailableRecovery.promise),
    set: vi.fn()
      .mockImplementationOnce(() => firstSet.promise)
      .mockImplementationOnce(() => authoritativeSet.promise)
      .mockImplementationOnce(() => hintedSet.promise)
      .mockImplementationOnce(() => unknownSet.promise)
  });
  installDesktop(interaction.interaction);
  const mounted = await mount(general());
  const toggle = activationClickToggle(mounted.container);
  await vi.waitFor(() => expect(toggle.disabled).toBe(false));

  act(() => {
    toggle.click();
    toggle.click();
  });
  expect(interaction.setSwallowActivationClick).toHaveBeenCalledOnce();
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(toggle.disabled).toBe(true);
  expect(toggle.getAttribute("aria-busy")).toBe("true");
  expect(readActivationClickPreference()).toBe(true);

  await act(async () => interaction.emit(false));
  await act(async () => firstSet.resolve({ swallowActivationClick: true }));
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(toggle.disabled).toBe(false);
  expect(readActivationClickPreference()).toBe(false);

  await act(async () => toggle.click());
  await act(async () => authoritativeSet.reject(new Error("write failed")));
  await vi.waitFor(() => expect(interaction.get).toHaveBeenCalledTimes(2));
  await act(async () => authoritativeRecovery.resolve({ swallowActivationClick: true }));
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(readActivationClickPreference()).toBe(true);
  expect(mounted.container.querySelector('[role="alert"]')?.textContent)
    .toContain("Could not save the background-window click setting.");

  await act(async () => toggle.click());
  await act(async () => interaction.emit(true));
  await act(async () => hintedSet.reject(new Error("write failed with newer hint")));
  await vi.waitFor(() => expect(interaction.get).toHaveBeenCalledTimes(3));
  await act(async () => hintedRecovery.resolve({ swallowActivationClick: false }));
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(readActivationClickPreference()).toBe(true);

  await act(async () => toggle.click());
  expect(readActivationClickPreference()).toBe(false);
  await act(async () => unknownSet.reject(new Error("write failed again")));
  await vi.waitFor(() => expect(interaction.get).toHaveBeenCalledTimes(4));
  await act(async () => unavailableRecovery.reject(new Error("read unavailable")));
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(toggle.disabled).toBe(false);
  expect(readActivationClickPreference()).toBe(true);
});

it("retires pending writes when the Desktop owner is replaced or unmounted", async () => {
  const oldSet = deferred<WindowInteractionSettings>();
  const first = windowInteraction({
    initial: async () => ({ swallowActivationClick: false }),
    set: () => oldSet.promise
  });
  installDesktop(first.interaction);
  const mounted = await mount(general());
  const toggle = activationClickToggle(mounted.container);
  await vi.waitFor(() => expect(toggle.disabled).toBe(false));
  await act(async () => toggle.click());

  const newSet = deferred<WindowInteractionSettings>();
  const second = windowInteraction({
    initial: async () => ({ swallowActivationClick: true }),
    set: () => newSet.promise
  });
  installDesktop(second.interaction);
  await act(async () => mounted.root.render(general()));
  await vi.waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  await act(async () => oldSet.resolve({ swallowActivationClick: false }));
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(readActivationClickPreference()).toBe(true);

  await act(async () => toggle.click());
  await act(async () => mounted.root.render(<></>));
  await act(async () => newSet.resolve({ swallowActivationClick: true }));
  expect(readActivationClickPreference()).toBe(false);
  expect(second.unsubscribe).toHaveBeenCalledOnce();
});

it("keeps the capability/platform gate and the macOS restart explanation", async () => {
  const interaction = windowInteraction({ initial: async () => ({ swallowActivationClick: false }) });
  installDesktop(interaction.interaction, "linux");
  const mounted = await mount(general());
  expect(mounted.container.querySelector('[role="switch"][aria-label="Activate background windows without forwarding the first left click"]'))
    .toBeNull();

  installDesktop(interaction.interaction, "darwin");
  await act(async () => mounted.root.render(general()));
  await vi.waitFor(() => expect(activationClickToggle(mounted.container).disabled).toBe(false));
  expect(mounted.container.textContent).toContain("On macOS, this change applies after Joko restarts.");

  installDesktop(interaction.interaction, "win32", []);
  await act(async () => mounted.root.render(general()));
  expect(mounted.container.querySelector('[role="switch"][aria-label="Activate background windows without forwarding the first left click"]'))
    .toBeNull();
});

function general(): JSX.Element {
  return <GeneralSettings
    controller={controllerFixture()}
    snapshot={emptySnapshot()}
    runAction={(_key, action) => { void action(); }}
    onSuccess={() => undefined}
    t={(key, values) => translate("en", key, values)}
  />;
}

function controllerFixture(): AppController {
  return {
    state: {
      preferences: DEFAULT_UI_PREFERENCES,
      profiles: [],
      automaticConnectionAvailable: false
    },
    setSessionNotificationsEnabled: vi.fn(async () => undefined),
    setComposerSendShortcut: vi.fn(async () => undefined),
    resetLayoutPreferences: vi.fn(async () => undefined),
    navigate: vi.fn()
  } as unknown as AppController;
}

function windowInteraction(options: {
  readonly initial: () => Promise<WindowInteractionSettings>;
  readonly set?: (enabled: boolean) => Promise<WindowInteractionSettings>;
}): {
  readonly interaction: JokoDesktopApi["windowInteraction"];
  readonly order: string[];
  readonly get: ReturnType<typeof vi.fn>;
  readonly setSwallowActivationClick: ReturnType<typeof vi.fn>;
  readonly unsubscribe: ReturnType<typeof vi.fn>;
  readonly emit: (enabled: boolean) => void;
  readonly invokeRetired: (enabled: boolean) => void;
} {
  const order: string[] = [];
  const listeners = new Set<WindowInteractionListener>();
  let lastListener: WindowInteractionListener | undefined;
  const unsubscribe = vi.fn();
  const get = vi.fn(() => {
    order.push("get");
    return options.initial();
  });
  const setSwallowActivationClick = vi.fn((enabled: boolean) => options.set?.(enabled)
    ?? Promise.resolve({ swallowActivationClick: enabled }));
  const interaction = {
    get,
    setSwallowActivationClick,
    onChanged: vi.fn((listener: WindowInteractionListener) => {
      order.push("subscribe");
      lastListener = listener;
      listeners.add(listener);
      return () => {
        unsubscribe();
        listeners.delete(listener);
      };
    })
  } as JokoDesktopApi["windowInteraction"];
  return {
    interaction,
    order,
    get,
    setSwallowActivationClick,
    unsubscribe,
    emit: (enabled) => { for (const listener of listeners) listener({ swallowActivationClick: enabled }); },
    invokeRetired: (enabled) => { lastListener?.({ swallowActivationClick: enabled }); }
  };
}

function installDesktop(
  windowInteractionApi: JokoDesktopApi["windowInteraction"],
  platform = "win32",
  capabilities: readonly JokoDesktopCapability[] = ["window.activationClick"]
): void {
  Object.defineProperty(window, "jokoDesktop", {
    configurable: true,
    value: {
      capabilities,
      platform,
      windowInteraction: windowInteractionApi
    } as unknown as JokoDesktopApi
  });
}

function activationClickToggle(container: ParentNode): HTMLButtonElement {
  const toggle = container.querySelector<HTMLButtonElement>(
    '[role="switch"][aria-label="Activate background windows without forwarding the first left click"]'
  );
  if (toggle === null) throw new Error("Expected activation-click toggle.");
  return toggle;
}

async function mount(element: JSX.Element): Promise<{ readonly container: HTMLDivElement; readonly root: Root }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return { container, root };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}
