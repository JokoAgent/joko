// @vitest-environment jsdom

import { act, useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import { emptySnapshot, type Locale, type Theme } from "../model.js";
import { writeVoiceInputPreferences } from "../voice-input-preferences.js";
import { createUnavailableDedicatedHardwareSnapshot, type DedicatedHardwareBridge } from "../dedicated-hardware.js";
import {
  AppearanceSettings,
  GeneralSettings,
  SettingsPage
} from "./SettingsPage.js";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  Object.defineProperty(window, "jokoDesktop", {
    configurable: true,
    value: { capabilities: ["notifications.session"], platform: "win32" }
  });
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
  Reflect.deleteProperty(window, "jokoDesktop");
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("shared settings interactions", () => {
  it("gives the theme radiogroup one tab stop and activates Arrow/Home/End destinations", async () => {
    const controller = controllerFixture();
    const container = await renderAppearance(controller);
    const group = required(container.querySelector<HTMLDivElement>('[role="radiogroup"][aria-label="Theme"]'));
    const radios = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')];

    expect(radios.map((radio) => radio.tabIndex)).toEqual([0, -1, -1]);
    radios[0]!.focus();
    await act(async () => fireKey(radios[0]!, "ArrowRight"));
    expect(document.activeElement).toBe(radios[1]);
    expect(controller.setTheme).toHaveBeenLastCalledWith("light");
    expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, 0, -1]);

    await act(async () => fireKey(radios[1]!, "End"));
    expect(document.activeElement).toBe(radios[2]);
    expect(controller.setTheme).toHaveBeenLastCalledWith("dark");
    await act(async () => fireKey(radios[2]!, "Home"));
    expect(document.activeElement).toBe(radios[0]);
    expect(controller.setTheme).toHaveBeenLastCalledWith("system");
    await act(async () => fireKey(radios[0]!, "ArrowLeft"));
    expect(document.activeElement).toBe(radios[2]);
    expect(controller.setTheme).toHaveBeenLastCalledWith("dark");
  });

  it("keeps theme persistence visibly pending, then reports success or the latest failure", async () => {
    const saved = deferred<void>();
    const failed = deferred<void>();
    const controller = controllerFixture();
    controller.setTheme = vi.fn()
      .mockImplementationOnce(() => saved.promise)
      .mockImplementationOnce(() => failed.promise);
    const onSuccess = vi.fn();
    const container = await renderAppearance(controller, onSuccess);
    const group = required(container.querySelector<HTMLDivElement>('[role="radiogroup"][aria-label="Theme"]'));
    const radios = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')];

    await act(async () => radios[1]!.click());
    expect(group.getAttribute("aria-busy")).toBe("true");
    expect(radios.every((radio) => radio.disabled)).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Working");

    await act(async () => saved.resolve());
    expect(group.getAttribute("aria-busy")).toBe("false");
    expect(onSuccess).toHaveBeenCalledWith("Theme saved.");

    await act(async () => radios[2]!.click());
    await act(async () => failed.reject(new Error("disk unavailable")));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not save the theme setting.");
  });

  it("restores keyboard focus after the pending theme control is re-enabled", async () => {
    const saved = deferred<void>();
    const controller = controllerFixture();
    controller.setTheme = vi.fn(() => saved.promise);
    const container = await renderAppearance(controller);
    const radios = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')];

    radios[0]!.focus();
    await act(async () => fireKey(radios[0]!, "ArrowRight"));
    expect(radios.every((radio) => radio.disabled)).toBe(true);
    await act(async () => saved.resolve());

    expect(document.activeElement).toBe(radios[1]);
    expect(radios[1]!.tabIndex).toBe(0);
  });

  it("fences language persistence and exposes pending, failure, and success", async () => {
    const failed = deferred<void>();
    const controller = controllerFixture();
    controller.setLocale = vi.fn()
      .mockImplementationOnce(() => failed.promise)
      .mockResolvedValueOnce(undefined);
    const onSuccess = vi.fn();
    const container = await renderAppearance(controller, onSuccess);
    const language = required(container.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Language"]'));

    await chooseOption(language, translate("en", "language.zh-CN"));
    expect(language.disabled).toBe(true);
    expect(language.getAttribute("aria-busy")).toBe("true");
    await act(async () => failed.reject(new Error("disk unavailable")));
    expect(language.disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not save the language setting.");

    await chooseOption(language, translate("en", "language.zh-CN"));
    expect(onSuccess).toHaveBeenCalledWith("Language saved.");
    expect(controller.setLocale).toHaveBeenNthCalledWith(2, "zh-CN");
  });

  it("disables notification changes while pending and lets only the latest request publish feedback", async () => {
    const stale = deferred<void>();
    const latest = deferred<void>();
    const latestFailure = deferred<void>();
    const controller = controllerFixture();
    controller.setSessionNotificationsEnabled = vi.fn()
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => latest.promise)
      .mockImplementationOnce(() => latestFailure.promise);
    const onSuccess = vi.fn();
    const container = await renderGeneral(controller, onSuccess);
    const toggle = required(container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Desktop notifications"]'));

    // Two native events can be queued before the pending render disables the control.
    await act(async () => {
      toggle.click();
      toggle.click();
    });
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute("aria-busy")).toBe("true");
    expect(controller.setSessionNotificationsEnabled).toHaveBeenCalledTimes(2);
    await act(async () => stale.reject(new Error("stale failure")));
    expect(toggle.disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')).toBeNull();

    await act(async () => latest.resolve());
    expect(toggle.disabled).toBe(false);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(controller.setSessionNotificationsEnabled).toHaveBeenNthCalledWith(2, false);
    expect(onSuccess).toHaveBeenCalledWith("Desktop notifications disabled.");

    await act(async () => toggle.click());
    await act(async () => latestFailure.reject(new Error("latest failure")));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not save the desktop notification setting.");
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("rejects a Composer send shortcut already owned by Voice Input without mutating preferences", async () => {
    writeVoiceInputPreferences({
      shortcut: {
        code: "Enter",
        key: "Enter",
        meta: false,
        ctrl: true,
        alt: false,
        shift: false,
        fn: false
      }
    });
    const controller = controllerFixture();
    const container = await renderGeneral(controller, () => undefined);
    const shortcut = required(container.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Send shortcut"]'));

    await chooseOption(shortcut, "Ctrl/Command+Enter sends");

    expect(controller.setComposerSendShortcut).not.toHaveBeenCalled();
    expect(controller.state.preferences.composerSendShortcut).toBe("enter");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Conflicts with the Voice Input shortcut. Change either the Composer send shortcut or the Voice Input shortcut."
    );
  });

  it("single-flights Composer shortcut selection and reset with pending accessibility and one success each", async () => {
    const selection = deferred<void>();
    const reset = deferred<void>();
    const controller = controllerFixture();
    controller.setComposerSendShortcut = vi.fn()
      .mockImplementationOnce(() => selection.promise)
      .mockImplementationOnce(() => reset.promise);
    const onSuccess = vi.fn();
    const container = await renderStatefulGeneral(controller, onSuccess);
    const shortcut = required(container.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Send shortcut"]'));

    await chooseOptionTwice(shortcut, "Ctrl/Command+Enter sends");

    expect(controller.setComposerSendShortcut).toHaveBeenCalledTimes(1);
    expect(controller.setComposerSendShortcut).toHaveBeenLastCalledWith("modifier-enter");
    expect(shortcut.disabled).toBe(true);
    expect(shortcut.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Working");
    expect(container.textContent).toContain("Customized");
    const pendingReset = required(container.querySelector<HTMLButtonElement>('button[aria-label="Restore default"]'));
    expect(pendingReset.disabled).toBe(true);
    expect(pendingReset.getAttribute("aria-busy")).toBe("true");

    await act(async () => selection.resolve());

    expect(shortcut.disabled).toBe(false);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenLastCalledWith("Saved");
    const restore = required(container.querySelector<HTMLButtonElement>('button[aria-label="Restore default"]'));
    await act(async () => {
      restore.click();
      restore.click();
    });

    expect(controller.setComposerSendShortcut).toHaveBeenCalledTimes(2);
    expect(controller.setComposerSendShortcut).toHaveBeenLastCalledWith(DEFAULT_UI_PREFERENCES.composerSendShortcut);
    expect(shortcut.disabled).toBe(true);
    expect(restore.disabled).toBe(true);
    expect(restore.getAttribute("aria-busy")).toBe("true");
    expect(container.textContent).toContain("Customized");

    await act(async () => reset.resolve());

    expect(onSuccess).toHaveBeenCalledTimes(2);
    expect(onSuccess).toHaveBeenLastCalledWith("Restored default settings");
    expect(container.textContent).not.toContain("Customized");
    expect(container.querySelector('button[aria-label="Restore default"]')).toBeNull();
  });

  it("shows a localized Composer shortcut failure after the Controller rolls back its authoritative value", async () => {
    const failed = deferred<void>();
    const controller = controllerFixture();
    controller.setComposerSendShortcut = vi.fn(() => failed.promise);
    const onSuccess = vi.fn();
    const container = await renderStatefulGeneral(controller, onSuccess);
    const shortcut = required(container.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Send shortcut"]'));

    await chooseOption(shortcut, "Ctrl/Command+Enter sends");
    expect(shortcut.textContent).toContain("Ctrl/Command+Enter sends");
    await act(async () => failed.reject(new Error("storage failed")));

    expect(shortcut.disabled).toBe(false);
    expect(shortcut.textContent).toContain("Enter sends");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("The shortcut could not be saved.");
    expect(container.textContent).not.toContain("Customized");
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("validates Restore default against Voice Input before clearing a customized Composer shortcut", async () => {
    writeVoiceInputPreferences({
      shortcut: {
        code: "Enter",
        key: "Enter",
        meta: true,
        ctrl: false,
        alt: false,
        shift: false,
        fn: false
      }
    });
    const controller = controllerFixture("modifier-enter");
    const container = await renderGeneral(controller, () => undefined);
    const restore = required(container.querySelector<HTMLButtonElement>('button[aria-label="Restore default"]'));

    await act(async () => restore.click());

    expect(controller.setComposerSendShortcut).not.toHaveBeenCalled();
    expect(controller.state.preferences.composerSendShortcut).toBe("modifier-enter");
    expect(container.textContent).toContain("Customized");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Conflicts with the Voice Input shortcut. Change either the Composer send shortcut or the Voice Input shortcut."
    );
  });

  it("retires late Composer shortcut feedback when the Controller owner changes or the page unmounts", async () => {
    const stale = deferred<void>();
    const afterUnmount = deferred<void>();
    const first = controllerFixture();
    first.setComposerSendShortcut = vi.fn(() => stale.promise);
    const second = controllerFixture();
    second.setComposerSendShortcut = vi.fn(() => afterUnmount.promise);
    const onSuccess = vi.fn();
    const mounted = await mount(<GeneralHarness controller={first} onSuccess={onSuccess} />);
    let shortcut = required(mounted.container.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Send shortcut"]'));

    await chooseOption(shortcut, "Ctrl/Command+Enter sends");
    await act(async () => mounted.root.render(<GeneralHarness controller={second} onSuccess={onSuccess} />));
    shortcut = required(mounted.container.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Send shortcut"]'));
    expect(shortcut.disabled).toBe(false);
    await chooseOption(shortcut, "Ctrl/Command+Enter sends");
    expect(shortcut.disabled).toBe(true);
    await act(async () => stale.reject(new Error("late old owner failure")));
    expect(shortcut.disabled).toBe(true);
    expect(mounted.container.querySelector('[role="alert"]')).toBeNull();
    expect(onSuccess).not.toHaveBeenCalled();

    await act(async () => mounted.root.render(<></>));
    await act(async () => afterUnmount.resolve());
    expect(onSuccess).not.toHaveBeenCalled();
    expect(mounted.container.querySelector('[role="status"]')).toBeNull();
  });

  it("replaces first-level settings locations instead of adding browser history entries", async () => {
    window.history.replaceState({ marker: "settings" }, "", "/#/settings");
    const before = window.history.length;
    const container = await renderSettingsPage(controllerFixture());
    const general = required(container.querySelector<HTMLButtonElement>('#settings-tab-general'));

    await act(async () => general.click());

    expect(window.location.hash).toBe("#/settings/general");
    expect(window.history.length).toBe(before);
    expect(window.history.state).toEqual({ marker: "settings" });
  });

  it("places dedicated hardware before gamepad and explicitly marks it unavailable without the Desktop capability", async () => {
    window.history.replaceState(null, "", "/#/settings/shortcuts");
    const container = await renderSettingsPage(controllerFixture());
    const hardware = required(container.querySelector<HTMLElement>(".dedicated-hardware-settings"));
    const gamepad = required(container.querySelector<HTMLElement>(".gamepad-settings"));

    expect(hardware.textContent).toContain("Dedicated hardware is available in Joko Desktop.");
    expect(hardware.compareDocumentPosition(gamepad) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it("uses the dedicated hardware bridge only when its Desktop capability is advertised", async () => {
    const snapshot = createUnavailableDedicatedHardwareSnapshot();
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
    Object.defineProperty(window, "jokoDesktop", {
      configurable: true,
      value: { capabilities: ["hardware.dedicatedInput"], platform: "win32", dedicatedHardware: bridge }
    });
    window.history.replaceState(null, "", "/#/settings/shortcuts");
    const container = await renderSettingsPage(controllerFixture());

    await vi.waitFor(() => expect(bridge.getDedicatedHardwareState).toHaveBeenCalled());
    expect(container.textContent).not.toContain("Dedicated hardware is available in Joko Desktop.");
    expect(container.textContent).toContain("The skill catalog is not available in this settings view.");
  });
});

function AppearanceHarness({ controller, onSuccess }: {
  readonly controller: AppController;
  readonly onSuccess: (message: string) => void;
}): JSX.Element {
  const [theme, setTheme] = useState<Theme>("system");
  const [locale, setLocale] = useState<Locale>("en");
  const wrapped = {
    ...controller,
    state: {
      ...controller.state,
      preferences: { ...controller.state.preferences, theme, locale }
    },
    setTheme: async (next: Theme) => {
      const previous = theme;
      setTheme(next);
      try {
        await controller.setTheme(next);
      } catch (error) {
        setTheme(previous);
        throw error;
      }
    },
    setLocale: async (next: Locale) => {
      const previous = locale;
      setLocale(next);
      try {
        await controller.setLocale(next);
      } catch (error) {
        setLocale(previous);
        throw error;
      }
    }
  } as AppController;
  return <AppearanceSettings
    controller={wrapped}
    locale={locale}
    theme={theme}
    onSuccess={onSuccess}
    onOpenPi={() => undefined}
    t={(key, values) => translate("en", key, values)}
  />;
}

function GeneralHarness({ controller, onSuccess }: {
  readonly controller: AppController;
  readonly onSuccess: (message: string) => void;
}): JSX.Element {
  const [shortcut, setShortcut] = useState(controller.state.preferences.composerSendShortcut);
  const shortcutRef = useRef(shortcut);
  const sourceRef = useRef(controller);
  sourceRef.current = controller;
  shortcutRef.current = shortcut;
  useEffect(() => {
    shortcutRef.current = controller.state.preferences.composerSendShortcut;
    setShortcut(controller.state.preferences.composerSendShortcut);
  }, [controller]);
  const setComposerSendShortcut = useCallback(async (next: "enter" | "modifier-enter"): Promise<void> => {
    const previous = shortcutRef.current;
    shortcutRef.current = next;
    setShortcut(next);
    try {
      await controller.setComposerSendShortcut(next);
    } catch (error) {
      if (sourceRef.current === controller) {
        shortcutRef.current = previous;
        setShortcut(previous);
      }
      throw error;
    }
  }, [controller]);
  const wrapped = {
    ...controller,
    state: {
      ...controller.state,
      preferences: { ...controller.state.preferences, composerSendShortcut: shortcut }
    },
    setComposerSendShortcut
  } as AppController;
  return <GeneralSettings
    controller={wrapped}
    snapshot={emptySnapshot()}
    runAction={(_key, action) => { void action(); }}
    onSuccess={onSuccess}
    t={(key, values) => translate("en", key, values)}
  />;
}

function controllerFixture(
  composerSendShortcut: "enter" | "modifier-enter" = DEFAULT_UI_PREFERENCES.composerSendShortcut
): AppController {
  return {
    state: {
      preferences: { ...DEFAULT_UI_PREFERENCES, composerSendShortcut },
      profiles: [],
      automaticConnectionAvailable: false
    },
    setTheme: vi.fn(async () => undefined),
    setLocale: vi.fn(async () => undefined),
    setSessionNotificationsEnabled: vi.fn(async () => undefined),
    setComposerSendShortcut: vi.fn(async () => undefined),
    resetLayoutPreferences: vi.fn(async () => undefined),
    navigate: vi.fn()
  } as unknown as AppController;
}

async function renderAppearance(
  controller: AppController,
  onSuccess: (message: string) => void = () => undefined
): Promise<HTMLDivElement> {
  return render(<AppearanceHarness controller={controller} onSuccess={onSuccess} />);
}

async function renderGeneral(
  controller: AppController,
  onSuccess: (message: string) => void
): Promise<HTMLDivElement> {
  return render(<GeneralSettings
    controller={controller}
    snapshot={emptySnapshot()}
    runAction={(_key, action) => { void action(); }}
    onSuccess={onSuccess}
    t={(key, values) => translate("en", key, values)}
  />);
}

async function renderStatefulGeneral(
  controller: AppController,
  onSuccess: (message: string) => void
): Promise<HTMLDivElement> {
  return render(<GeneralHarness controller={controller} onSuccess={onSuccess} />);
}

async function renderSettingsPage(controller: AppController): Promise<HTMLDivElement> {
  return render(<SettingsPage
    controller={controller}
    snapshot={emptySnapshot()}
    locale="en"
    runAction={(_key, action) => { void action(); }}
    t={(key, values) => translate("en", key, values)}
  />);
}

async function render(element: JSX.Element): Promise<HTMLDivElement> {
  return (await mount(element)).container;
}

async function mount(element: JSX.Element): Promise<{ readonly container: HTMLDivElement; readonly root: Root }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return { container, root };
}

async function chooseOption(trigger: HTMLButtonElement, label: string): Promise<void> {
  await act(async () => trigger.click());
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
    .find((candidate) => candidate.textContent?.trim() === label);
  await act(async () => required(option).click());
}

async function chooseOptionTwice(trigger: HTMLButtonElement, label: string): Promise<void> {
  await act(async () => trigger.click());
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
    .find((candidate) => candidate.textContent?.trim() === label);
  await act(async () => {
    required(option).click();
    required(option).click();
  });
}

function fireKey(target: HTMLElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value?: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve: (value?: T) => resolve(value as T), reject };
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected rendered element");
  return value;
}
