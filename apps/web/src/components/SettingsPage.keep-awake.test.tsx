// @vitest-environment jsdom

import { act } from "react";
import type { JSX } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import { emptySnapshot } from "../model.js";
import { GeneralSettings } from "./SettingsPage.js";

interface KeepAwakeSettings {
  readonly enabled: boolean;
}

type KeepAwakeListener = (settings: KeepAwakeSettings) => void;

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  Reflect.deleteProperty(window, "jokoDesktop");
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

it("subscribes before the initial read and fences newer hints, replacement, and unmount", async () => {
  const initial = deferred<KeepAwakeSettings>();
  const first = keepAwakePower({ initial: () => initial.promise });
  installDesktop(first.power);
  const mounted = await mount(general());
  const toggle = keepAwakeToggle(mounted.container);

  expect(first.order.slice(0, 2)).toEqual(["subscribe", "get"]);
  expect(toggle.disabled).toBe(true);

  await act(async () => first.emit(true));
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(toggle.disabled).toBe(false);

  await act(async () => initial.resolve({ enabled: false }));
  expect(toggle.getAttribute("aria-checked")).toBe("true");

  const second = keepAwakePower({ initial: async () => ({ enabled: false }) });
  installDesktop(second.power);
  await act(async () => mounted.root.render(general()));
  await vi.waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
  expect(first.unsubscribe).toHaveBeenCalledOnce();
  expect(second.order.slice(0, 2)).toEqual(["subscribe", "get"]);

  await act(async () => first.invokeRetired(true));
  expect(toggle.getAttribute("aria-checked")).toBe("false");

  await act(async () => mounted.root.render(<></>));
  expect(second.unsubscribe).toHaveBeenCalledOnce();
  await act(async () => second.invokeRetired(true));
  expect(toggle.getAttribute("aria-checked")).toBe("false");
});

it("orders pending confirmations and recovers failed writes from Main authority", async () => {
  const firstSet = deferred<KeepAwakeSettings>();
  const failedSet = deferred<KeepAwakeSettings>();
  const unknownSet = deferred<KeepAwakeSettings>();
  const recovery = deferred<KeepAwakeSettings>();
  const unavailableRecovery = deferred<KeepAwakeSettings>();
  const power = keepAwakePower({
    initial: vi.fn()
      .mockResolvedValueOnce({ enabled: false })
      .mockImplementationOnce(() => recovery.promise)
      .mockImplementationOnce(() => unavailableRecovery.promise),
    set: vi.fn()
      .mockImplementationOnce(() => firstSet.promise)
      .mockImplementationOnce(() => failedSet.promise)
      .mockImplementationOnce(() => unknownSet.promise)
  });
  installDesktop(power.power);
  const mounted = await mount(general());
  const toggle = keepAwakeToggle(mounted.container);
  await vi.waitFor(() => expect(toggle.disabled).toBe(false));
  expect(toggle.getAttribute("aria-checked")).toBe("false");

  await act(async () => {
    toggle.click();
    toggle.click();
    await Promise.resolve();
  });
  expect(power.setKeepAwake).toHaveBeenCalledOnce();
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(toggle.disabled).toBe(true);
  expect(toggle.getAttribute("aria-busy")).toBe("true");
  expect(mounted.container.querySelector('[role="status"]')?.textContent).toBe("Working");

  await act(async () => power.emit(false));
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(toggle.disabled).toBe(true);
  await act(async () => firstSet.resolve({ enabled: true }));
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(toggle.disabled).toBe(false);

  await act(async () => power.emit(true));
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  await act(async () => toggle.click());
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  await act(async () => failedSet.reject(new Error("write failed")));
  await vi.waitFor(() => expect(power.getKeepAwake).toHaveBeenCalledTimes(2));
  expect(toggle.disabled).toBe(true);
  await act(async () => recovery.resolve({ enabled: false }));
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(toggle.disabled).toBe(false);
  expect(mounted.container.querySelector('[role="alert"]')?.textContent)
    .toContain("Could not save the keep-awake setting.");

  await act(async () => power.emit(true));
  await act(async () => toggle.click());
  await act(async () => unknownSet.reject(new Error("write failed again")));
  await vi.waitFor(() => expect(power.getKeepAwake).toHaveBeenCalledTimes(3));
  await act(async () => unavailableRecovery.reject(new Error("read unavailable")));
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(toggle.disabled).toBe(true);
});

it("converges two mounted renderers on confirmed Main broadcasts", async () => {
  const pendingSet = deferred<KeepAwakeSettings>();
  const power = keepAwakePower({
    initial: async () => ({ enabled: false }),
    set: () => pendingSet.promise
  });
  installDesktop(power.power);
  const first = await mount(general());
  const second = await mount(general());
  const firstToggle = keepAwakeToggle(first.container);
  const secondToggle = keepAwakeToggle(second.container);
  await vi.waitFor(() => {
    expect(firstToggle.disabled).toBe(false);
    expect(secondToggle.disabled).toBe(false);
  });
  expect(power.listeners.size).toBe(2);

  await act(async () => firstToggle.click());
  expect(firstToggle.getAttribute("aria-checked")).toBe("true");
  expect(secondToggle.getAttribute("aria-checked")).toBe("false");
  await act(async () => power.emit(true));
  expect(firstToggle.getAttribute("aria-checked")).toBe("true");
  expect(secondToggle.getAttribute("aria-checked")).toBe("true");
  await act(async () => pendingSet.resolve({ enabled: true }));
  expect(firstToggle.disabled).toBe(false);

  await act(async () => first.root.render(<></>));
  expect(power.listeners.size).toBe(1);
  await act(async () => power.emit(false));
  expect(firstToggle.getAttribute("aria-checked")).toBe("true");
  expect(secondToggle.getAttribute("aria-checked")).toBe("false");
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

function keepAwakePower(options: {
  readonly initial: () => Promise<KeepAwakeSettings>;
  readonly set?: (enabled: boolean) => Promise<KeepAwakeSettings>;
}): {
  readonly power: JokoDesktopApi["power"];
  readonly order: string[];
  readonly listeners: Set<KeepAwakeListener>;
  readonly getKeepAwake: ReturnType<typeof vi.fn>;
  readonly setKeepAwake: ReturnType<typeof vi.fn>;
  readonly unsubscribe: ReturnType<typeof vi.fn>;
  readonly emit: (enabled: boolean) => void;
  readonly invokeRetired: (enabled: boolean) => void;
} {
  const order: string[] = [];
  const listeners = new Set<KeepAwakeListener>();
  let lastListener: KeepAwakeListener | undefined;
  const unsubscribe = vi.fn();
  const getKeepAwake = vi.fn(() => {
    order.push("get");
    return options.initial();
  });
  const setKeepAwake = vi.fn((enabled: boolean) => options.set?.(enabled) ?? Promise.resolve({ enabled }));
  const power = {
    getKeepAwake,
    setKeepAwake,
    onKeepAwakeChanged: vi.fn((listener: KeepAwakeListener) => {
      order.push("subscribe");
      lastListener = listener;
      listeners.add(listener);
      return () => {
        unsubscribe();
        listeners.delete(listener);
      };
    })
  } as unknown as JokoDesktopApi["power"];
  return {
    power,
    order,
    listeners,
    getKeepAwake,
    setKeepAwake,
    unsubscribe,
    emit: (enabled) => { for (const listener of listeners) listener({ enabled }); },
    invokeRetired: (enabled) => { lastListener?.({ enabled }); }
  };
}

function installDesktop(power: JokoDesktopApi["power"]): void {
  Object.defineProperty(window, "jokoDesktop", {
    configurable: true,
    value: {
      capabilities: ["power.keepAwake"],
      platform: "win32",
      power
    } as unknown as JokoDesktopApi
  });
}

function keepAwakeToggle(container: ParentNode): HTMLButtonElement {
  const toggle = container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Keep computer awake"]');
  if (toggle === null) throw new Error("Expected keep-awake toggle.");
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
