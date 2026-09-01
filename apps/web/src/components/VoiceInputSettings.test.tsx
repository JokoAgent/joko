// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import { emptySnapshot, type VoiceInputCapabilityView } from "../model.js";
import { readVoiceInputPreferences } from "../voice-input-preferences.js";
import { VoiceInputSettings } from "./VoiceInputSettings.js";

const roots: Root[] = [];
const addDeviceListener = vi.fn();
const removeDeviceListener = vi.fn();

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  vi.stubGlobal("MediaRecorder", class {
    static isTypeSupported(value: string): boolean { return value === "audio/webm"; }
  });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn(),
      enumerateDevices: vi.fn(async () => [{ kind: "audioinput", deviceId: "mic-one", groupId: "group", label: "Desk microphone", toJSON: () => ({}) }]),
      addEventListener: addDeviceListener,
      removeEventListener: removeDeviceListener
    }
  });
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  Reflect.deleteProperty(window, "jokoDesktop");
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("VoiceInputSettings", () => {
  it("shows negotiated service/device state and persists only client-safe choices", async () => {
    const snapshot = emptySnapshot();
    const controller = {
      state: { snapshot, preferences: { appShortcutOverrides: {} } },
      getVoiceInputCapabilities: vi.fn(async () => capability),
      testVoiceInputConnection: vi.fn(async () => ({ ok: true } as const))
    } as unknown as AppController;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<VoiceInputSettings controller={controller} t={(key, values) => translate("en", key, values)} />));

    expect(container.textContent).toContain("Voice input");
    expect(container.textContent).toContain("Ready");
    expect(container.textContent).toContain("Desk microphone");
    const testConnection = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Test connection")!;
    await act(async () => testConnection.click());
    expect(container.textContent).toContain("Transcription connection succeeded.");
    const locale = container.querySelector<HTMLButtonElement>('button[role="combobox"][aria-label="Spoken language"]')!;
    const device = container.querySelector<HTMLButtonElement>('button[role="combobox"][aria-label="Microphone"]')!;
    const shortcut = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Change")!;
    await chooseSelect(locale, "繁體中文");
    await chooseSelect(device, "Desk microphone");
    await act(async () => shortcut.click());
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        code: "KeyM",
        key: "m",
        altKey: true,
        shiftKey: true
      }));
    });
    expect(readVoiceInputPreferences()).toEqual({
      locale: "zh-TW",
      deviceId: "mic-one",
      shortcut: { code: "KeyM", key: "m", meta: false, ctrl: false, alt: true, shift: true, fn: false },
      refinementInstructions: "",
      dictionary: { entries: [], candidates: [], suppressedAutomaticTexts: [] },
      dictionaryTerms: [],
      autoDictionaryEnabled: true,
      playInteractionSound: true,
      fastActivationEnabled: false,
      muteOtherSounds: true
    });
    expect(addDeviceListener).toHaveBeenCalledWith("devicechange", expect.any(Function));
  });

  it("manages rich local dictionary entries and the automatic-learning preference", async () => {
    const base = emptySnapshot();
    const snapshot = {
      ...base,
      settings: {
        ...base.settings,
        voiceInput: { ...base.settings.voiceInput, refinementEnabled: true }
      }
    };
    const controller = {
      state: { snapshot, preferences: { appShortcutOverrides: {} } },
      getVoiceInputCapabilities: vi.fn(async () => capability),
      testVoiceInputConnection: vi.fn(async () => ({ ok: true } as const))
    } as unknown as AppController;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<VoiceInputSettings controller={controller} t={(key, values) => translate("en", key, values)} />));

    const newTerm = container.querySelector<HTMLInputElement>('input[aria-label="New dictionary term"]')!;
    const add = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Add term")!;
    await act(async () => {
      setInput(newTerm, "VoiceKit");
      add.click();
    });
    expect(readVoiceInputPreferences().dictionary.entries).toMatchObject([{ text: "VoiceKit", source: "manual" }]);
    expect(container.textContent).toContain("VoiceKit");

    const automatic = container.querySelector<HTMLButtonElement>('button[aria-label="Learn vocabulary from corrections"]')!;
    await act(async () => automatic.click());
    expect(readVoiceInputPreferences().autoDictionaryEnabled).toBe(false);
  });

  it("does not accept recording keys until Desktop has suspended the active global binding", async () => {
    let releaseSuspension: (() => void) | undefined;
    const configure = vi.fn((patch: { readonly shortcutRecording?: boolean }) => (
      patch.shortcutRecording === true
        ? new Promise<void>((resolve) => { releaseSuspension = resolve; })
        : Promise.resolve()
    ));
    const setShortcut = vi.fn(async () => ({ accepted: true as const, activation: "toggle" as const }));
    installDesktopVoice(setShortcut, configure);
    const controller = {
      state: { snapshot: emptySnapshot(), preferences: { appShortcutOverrides: {} } },
      getVoiceInputCapabilities: vi.fn(async () => capability),
      testVoiceInputConnection: vi.fn(async () => ({ ok: true } as const))
    } as unknown as AppController;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<VoiceInputSettings controller={controller} t={(key, values) => translate("en", key, values)} />));
    const original = readVoiceInputPreferences().shortcut;
    const change = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Change")!;

    await act(async () => change.click());
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      code: "KeyM",
      key: "m",
      altKey: true,
      shiftKey: true
    })));
    expect(setShortcut).not.toHaveBeenCalled();
    expect(readVoiceInputPreferences().shortcut).toEqual(original);

    await act(async () => releaseSuspension?.());
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      code: "KeyN",
      key: "n",
      altKey: true,
      shiftKey: true
    })));
    await vi.waitFor(() => expect(setShortcut).toHaveBeenCalledWith(expect.objectContaining({ code: "KeyN" })));
  });

  it("rejects a Voice Input shortcut already owned by Composer without changing the binding", async () => {
    const setShortcut = vi.fn(async () => ({ accepted: true as const, activation: "toggle" as const }));
    installDesktopVoice(setShortcut);
    const controller = {
      state: {
        snapshot: emptySnapshot(),
        preferences: { appShortcutOverrides: {}, composerSendShortcut: "modifier-enter" }
      },
      getVoiceInputCapabilities: vi.fn(async () => capability),
      testVoiceInputConnection: vi.fn(async () => ({ ok: true } as const))
    } as unknown as AppController;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<VoiceInputSettings controller={controller} t={(key, values) => translate("en", key, values)} />));
    const original = readVoiceInputPreferences().shortcut;
    const change = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Change")!;

    await act(async () => change.click());
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        code: "Enter",
        key: "Enter",
        ctrlKey: true
      }));
    });

    expect(setShortcut).not.toHaveBeenCalled();
    expect(readVoiceInputPreferences().shortcut).toEqual(original);
    expect(container.textContent).toContain(
      "Conflicts with the Voice Input shortcut. Change either the Composer send shortcut or the Voice Input shortcut."
    );
  });

  it("serializes desktop shortcut intents and persists every committable result in binding order", async () => {
    type RegistrationResult = Awaited<ReturnType<JokoDesktopApi["globalVoice"]["setShortcut"]>>;
    const pending: Array<(result: RegistrationResult) => void> = [];
    const setShortcut = vi.fn((_preference: JokoDesktopGlobalVoiceShortcut | "disabled") => new Promise<RegistrationResult>((resolve) => {
      pending.push(resolve);
    }));
    installDesktopVoice(setShortcut);
    const controller = {
      state: { snapshot: emptySnapshot(), preferences: { appShortcutOverrides: {} } },
      getVoiceInputCapabilities: vi.fn(async () => capability),
      testVoiceInputConnection: vi.fn(async () => ({ ok: true } as const))
    } as unknown as AppController;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<VoiceInputSettings controller={controller} t={(key, values) => translate("en", key, values)} />));
    const original = readVoiceInputPreferences().shortcut;

    await recordShortcut(container, "KeyM", "m");
    await recordShortcut(container, "KeyN", "n");
    expect(readVoiceInputPreferences().shortcut).toEqual(original);
    expect(setShortcut).toHaveBeenCalledTimes(1);
    await act(async () => pending.shift()?.({ accepted: true, activation: "toggle" }));
    expect(readVoiceInputPreferences().shortcut).toMatchObject({ code: "KeyM", key: "m" });
    await vi.waitFor(() => expect(setShortcut).toHaveBeenCalledTimes(2));
    await act(async () => pending.shift()?.({ accepted: false, reason: "in-use" }));
    expect(readVoiceInputPreferences().shortcut).toMatchObject({ code: "KeyM", key: "m" });
    expect(container.textContent).toContain("already in use");

    await recordShortcut(container, "KeyP", "p");
    await recordShortcut(container, "KeyQ", "q");
    expect(setShortcut).toHaveBeenCalledTimes(3);
    await act(async () => pending.shift()?.({ accepted: false, reason: "permission" }));
    expect(readVoiceInputPreferences().shortcut).toMatchObject({ code: "KeyP", key: "p" });
    expect(container.textContent).toContain("Allow Input Monitoring");
    await vi.waitFor(() => expect(setShortcut).toHaveBeenCalledTimes(4));
    await act(async () => pending.shift()?.({ accepted: false, reason: "unsupported" }));
    expect(readVoiceInputPreferences().shortcut).toMatchObject({ code: "KeyP", key: "p" });

    const disable = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Disable")!;
    await act(async () => disable.click());
    expect(readVoiceInputPreferences().shortcut).toMatchObject({ code: "KeyP" });
    await act(async () => pending.shift()?.({ accepted: false, reason: "unsupported" }));
    expect(readVoiceInputPreferences().shortcut).toMatchObject({ code: "KeyP" });

    await recordShortcut(container, "KeyR", "r");
    await recordShortcut(container, "KeyS", "s");
    await act(async () => pending.shift()?.({ accepted: true, activation: "toggle" }));
    expect(readVoiceInputPreferences().shortcut).toMatchObject({ code: "KeyR", key: "r" });
    await vi.waitFor(() => expect(setShortcut).toHaveBeenCalledTimes(7));
    await act(async () => pending.shift()?.({ accepted: true, activation: "hold" }));
    expect(readVoiceInputPreferences().shortcut).toMatchObject({ code: "KeyS", key: "s" });
  });

  it("commits an accepted desktop binding even after the Settings surface unmounts", async () => {
    type RegistrationResult = Awaited<ReturnType<JokoDesktopApi["globalVoice"]["setShortcut"]>>;
    const pending: Array<(result: RegistrationResult) => void> = [];
    const setShortcut = vi.fn((_preference: JokoDesktopGlobalVoiceShortcut | "disabled") => new Promise<RegistrationResult>((resolve) => {
      pending.push(resolve);
    }));
    installDesktopVoice(setShortcut);
    const controller = {
      state: { snapshot: emptySnapshot(), preferences: { appShortcutOverrides: {} } },
      getVoiceInputCapabilities: vi.fn(async () => capability),
      testVoiceInputConnection: vi.fn(async () => ({ ok: true } as const))
    } as unknown as AppController;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<VoiceInputSettings controller={controller} t={(key, values) => translate("en", key, values)} />));

    await recordShortcut(container, "KeyM", "m");
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => root.unmount());
    roots.splice(roots.indexOf(root), 1);
    await act(async () => pending.shift()?.({ accepted: true, activation: "toggle" }));
    expect(readVoiceInputPreferences().shortcut).toMatchObject({ code: "KeyM", key: "m" });
  });
});

const capability: VoiceInputCapabilityView = {
  support: "supported",
  limits: {
    supportedMimeTypes: ["audio/webm"],
    maximumAudioChunkBytes: 8_192,
    maximumAudioBytes: 1_048_576,
    maximumAudioChunkDurationMs: 500,
    maximumAudioDurationMs: 60_000,
    maximumLocaleCharacters: 35,
    stableWaitMs: 500,
    maximumConcurrentSessions: 1
  },
  supportsLocale: true,
  supportsLiveDrafts: true,
  supportsRefinement: false
};

async function chooseSelect(select: HTMLButtonElement, label: string): Promise<void> {
  await act(async () => select.click());
  const option = [...document.body.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')]
    .find((candidate) => candidate.textContent === label);
  if (option === undefined) throw new Error(`Missing select option: ${label}`);
  await act(async () => option.click());
}

function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function recordShortcut(container: HTMLElement, code: string, key: string): Promise<void> {
  const change = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Change")!;
  await act(async () => change.click());
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      code,
      key,
      altKey: true,
      shiftKey: true
    }));
  });
}

function installDesktopVoice(
  setShortcut: JokoDesktopApi["globalVoice"]["setShortcut"],
  configure: JokoDesktopApi["applicationMenu"]["configure"] = vi.fn(async () => undefined)
): void {
  Object.defineProperty(window, "jokoDesktop", {
    configurable: true,
    value: {
      platform: "win32",
      capabilities: ["voice.globalDictation"],
      applicationMenu: { configure },
      globalVoice: {
        setShortcut,
        getAccessibility: vi.fn(async () => ({ status: "not-required" as const })),
        getInputMonitoring: vi.fn(async () => ({ status: "not-required" as const }))
      }
    } as unknown as JokoDesktopApi
  });
}
