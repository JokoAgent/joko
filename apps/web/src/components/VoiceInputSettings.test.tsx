// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import { emptySnapshot, type VoiceInputCapabilityView } from "../model.js";
import { readVoiceInputPreferences, writeVoiceInputPreferences } from "../voice-input-preferences.js";
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
  it("keeps same-named refinement models on different runtimes independently selectable", async () => {
    const base = emptySnapshot();
    const update = vi.fn(async () => undefined);
    const snapshot = { ...base, backends: ["text-one", "text-two"].map((id) => ({ id, name: id, version: "1", health: "healthy" as const, capabilities: new Map() })),
      settings: { ...base.settings, voiceInput: { ...base.settings.voiceInput, refinementEnabled: true }, providers: [{
        id: "same-provider", name: "Text provider", kind: "customEndpoint" as const, enabled: true, revision: 1n,
        runtimes: ["text-one", "text-two"].map((backendId) => ({ backendId, compatibility: "openaiResponses" as const, endpoint: "https://text.example/v1", credentialId: "", credentialOrigin: "",
          environmentName: "", keyless: true, authHeader: false, headers: [], models: [{ modelId: "same-model", name: "Text model", reasoning: false, inputModalities: ["text" as const],
            contextWindowTokens: 128_000, maximumOutputTokens: 4096, inputCostMicrosPerMillion: 0, outputCostMicrosPerMillion: 0, cacheReadCostMicrosPerMillion: 0,
            cacheWriteCostMicrosPerMillion: 0, thinkingLevels: [], supportsFastMode: false }] }))
      }] } };
    const controller = { state: { snapshot, preferences: { appShortcutOverrides: {} } }, getVoiceInputCapabilities: vi.fn(async () => capability), updateVoiceInputServiceSettings: update } as unknown as AppController;
    const container = document.createElement("div"); document.body.append(container); const root = createRoot(container); roots.push(root);
    await act(async () => root.render(<VoiceInputSettings controller={controller} t={(key, values) => translate("en", key, values)} />));
    await chooseSelect(container.querySelector<HTMLButtonElement>('[aria-label="Refinement model"]')!, "Text provider · Text model · text-one");
    await chooseSelect(container.querySelector<HTMLButtonElement>('[aria-label="Backup refinement model"]')!, "Text provider · Text model · text-two");
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save transcription service")!.click());
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ refinerModel: { backendId: "text-one", providerId: "same-provider", modelId: "same-model" },
      refinerFallbackModel: { backendId: "text-two", providerId: "same-provider", modelId: "same-model" } }));
  });

  it("configures independent SAUC resources and credentials for both routes", async () => {
    writeVoiceInputPreferences({ locale: "en" });
    const update = vi.fn(async () => undefined);
    const controller = {
      state: { snapshot: emptySnapshot(), preferences: { appShortcutOverrides: {} } },
      getVoiceInputCapabilities: vi.fn(async () => ({ ...capability, supportsLocale: false })),
      updateVoiceInputServiceSettings: update
    } as unknown as AppController;
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container); roots.push(root);
    await act(async () => root.render(<VoiceInputSettings controller={controller} t={(key, values) => translate("en", key, values)} />));
    await chooseSelect(container.querySelector<HTMLButtonElement>('[aria-label="Transcription protocol"]')!, "Volcengine SAUC");
    expect(container.querySelector('[aria-label="Transcription model"]')).toBeNull();
    expect(container.querySelector('[aria-label="No API key required"]')).toBeNull();
    expect(container.querySelector<HTMLInputElement>('[aria-label="Transcription endpoint"]')?.value).toBe("wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async");
    expect(container.querySelector('[aria-label="Transcription resource ID"]')?.textContent).toContain("volc.seedasr.sauc.duration");
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Spoken language"]')?.disabled).toBe(true);
    expect(container.querySelector('[aria-label="Spoken language"]')?.textContent).toBe("Automatic");
    expect(readVoiceInputPreferences().locale).toBe("en");
    expect(container.textContent).toContain("detects the spoken language automatically");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Backup transcription route"]')!.click());
    await chooseSelect(container.querySelector<HTMLButtonElement>('[aria-label="Backup protocol"]')!, "Volcengine SAUC");
    await chooseSelect(container.querySelector<HTMLButtonElement>('[aria-label="Backup resource ID"]')!, "volc.bigasr.sauc.concurrent");
    await act(async () => {
      setInput(container.querySelector<HTMLInputElement>('[aria-label="API key"]')!, "primary-sauc-key");
      setInput(container.querySelector<HTMLInputElement>('[aria-label="Backup API key"]')!, "backup-sauc-key");
    });
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save transcription service")!.click());
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      protocol: "volcengineSauc", model: "", resourceId: "volc.seedasr.sauc.duration", keyless: false, secret: "primary-sauc-key",
      fallbackEnabled: true, fallbackProtocol: "volcengineSauc", fallbackModel: "", fallbackResourceId: "volc.bigasr.sauc.concurrent", fallbackKeyless: false, fallbackSecret: "backup-sauc-key"
    }));
    expect([...container.querySelectorAll<HTMLInputElement>('input[type="password"]')].every((input) => input.value === "")).toBe(true);
    await chooseSelect(container.querySelector<HTMLButtonElement>('[aria-label="Transcription protocol"]')!, "ElevenLabs Scribe realtime");
    expect(container.querySelector('[aria-label="Transcription resource ID"]')).toBeNull();
    expect(container.querySelector<HTMLInputElement>('[aria-label="Transcription model"]')?.value).toBe("scribe_v2_realtime");
    expect(JSON.stringify(localStorage)).not.toContain("sauc-key");
  });

  it("selects Scribe defaults and requires a new key when changing the saved protocol", async () => {
    const snapshot = emptySnapshot();
    const configured = {
      ...snapshot,
      settings: { ...snapshot.settings, voiceInput: { ...snapshot.settings.voiceInput, credentialConfigured: true } }
    };
    const update = vi.fn(async () => undefined);
    const controller = {
      state: { snapshot: configured, preferences: { appShortcutOverrides: {} } },
      getVoiceInputCapabilities: vi.fn(async () => capability),
      updateVoiceInputServiceSettings: update
    } as unknown as AppController;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container); roots.push(root);
    await act(async () => root.render(<VoiceInputSettings controller={controller} t={(key, values) => translate("en", key, values)} />));
    await chooseSelect(container.querySelector<HTMLButtonElement>('button[role="combobox"][aria-label="Transcription protocol"]')!, "ElevenLabs Scribe realtime");
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Transcription endpoint"]')?.value).toBe("wss://api.elevenlabs.io/v1/speech-to-text/realtime");
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Transcription model"]')?.value).toBe("scribe_v2_realtime");
    const save = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save transcription service")!;
    await act(async () => save.click());
    expect(update).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Replace or clear the saved key");
    await act(async () => setInput(container.querySelector<HTMLInputElement>('input[type="password"]')!, "new-scribe-key"));
    await act(async () => save.click());
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ protocol: "elevenLabsScribeRealtime", model: "scribe_v2_realtime", secret: "new-scribe-key" }));
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe("");
    expect(JSON.stringify(localStorage)).not.toContain("new-scribe-key");
  });

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
    await chooseSelect(locale, translate("en", "language.zh-TW"));
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

  it.each(["protocol edit", "fallback edit", "service revision", "save"] as const)("discards an old connection probe after %s", async (change) => {
    const state = { snapshot: emptySnapshot(), preferences: { appShortcutOverrides: {} } };
    type ProbeResult = Awaited<ReturnType<AppController["testVoiceInputConnection"]>>;
    let resolveProbe!: (result: ProbeResult) => void;
    let rejectProbe!: (error: Error) => void;
    const test = vi.fn(() => new Promise<ProbeResult>((resolve, reject) => { resolveProbe = resolve; rejectProbe = reject; }));
    const update = vi.fn(async () => undefined);
    const controller = {
      state,
      getVoiceInputCapabilities: vi.fn(async () => capability),
      testVoiceInputConnection: test,
      updateVoiceInputServiceSettings: update
    } as unknown as AppController;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container); roots.push(root);
    const render = (): void => root.render(<VoiceInputSettings controller={controller} t={(key, values) => translate("en", key, values)} />);
    await act(async () => render());
    const button = (label: string): HTMLButtonElement => [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label)!;
    await act(async () => button("Test connection").click());
    expect(test).toHaveBeenCalledWith();
    if (change === "protocol edit") {
      await chooseSelect(container.querySelector<HTMLButtonElement>('button[role="combobox"][aria-label="Transcription protocol"]')!, "ElevenLabs Scribe realtime");
    } else if (change === "fallback edit") {
      await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Backup transcription route"]')!.click());
    } else if (change === "service revision") {
      state.snapshot = { ...state.snapshot, settings: { ...state.snapshot.settings,
        voiceInput: { ...state.snapshot.settings.voiceInput, revision: state.snapshot.settings.voiceInput.revision + 1n } } };
      await act(async () => render());
    } else {
      await act(async () => button("Save transcription service").click());
      expect(update).toHaveBeenCalledOnce();
    }
    await act(async () => {
      if (change === "service revision") rejectProbe(new Error("old probe failed"));
      else resolveProbe(change === "fallback edit" ? { ok: false, reason: "authenticationFailed" } : { ok: true });
    });
    const probeStatus = container.querySelector(".voice-input-service-actions [role]")?.textContent;
    expect(container.textContent).not.toContain("Transcription connection succeeded.");
    expect(probeStatus).toBe(translate("en", change === "save" ? "settings.voiceInputServiceSaved" : "settings.voiceInputServiceSecureHint"));
    expect(button("Test connection").disabled).toBe(change === "protocol edit" || change === "fallback edit");
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

    let entry = container.querySelector<HTMLElement>(".voice-input-dictionary-list article")!;
    const edit = [...entry.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Edit")!;
    await act(async () => edit.click());
    const aliases = container.querySelector<HTMLTextAreaElement>('[aria-label="Edit recognition aliases"]')!;
    await act(async () => setInput(aliases, "voice kit\nVoiceKit\nvoice kit\nnew variant"));
    const save = [...entry.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save")!;
    await act(async () => save.click());
    expect(readVoiceInputPreferences().dictionary.entries[0]?.aliases.map((alias) => alias.text)).toEqual(["voice kit", "new variant"]);
    expect(entry.textContent).toContain("Recognized from: voice kit, new variant");
    await act(async () => setInput(newTerm, "Canonical"));
    await act(async () => add.click());
    const destinationId = readVoiceInputPreferences().dictionary.entries.find((value) => value.text === "Canonical")!.id;
    await act(async () => [...entry.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Edit")!.click());
    await act(async () => setInput(container.querySelector<HTMLInputElement>('[aria-label="Edit dictionary term"]')!, "Canonical"));
    expect(entry.textContent).toContain("Saving will merge with the existing term");
    await act(async () => {
      const merge = [...entry.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save")!;
      merge.focus(); merge.click();
    });
    expect(readVoiceInputPreferences().dictionary.entries).toMatchObject([{ id: destinationId, text: "Canonical", frequency: 2 }]);
    expect(container.querySelectorAll(".voice-input-dictionary-list article")).toHaveLength(1);
    expect(container.textContent).toContain("Dictionary entries merged.");
    entry = container.querySelector<HTMLElement>(".voice-input-dictionary-list article")!;
    expect(document.activeElement).toBe(entry.querySelector("[data-dictionary-edit]"));
    await act(async () => [...entry.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Edit")!.click());
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Edit recognition aliases"]')?.value).toBe("voice kit\nnew variant");
    await act(async () => setInput(container.querySelector<HTMLInputElement>('[aria-label="Edit dictionary term"]')!, ""));
    await act(async () => [...entry.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save")!.click());
    expect(readVoiceInputPreferences().dictionary.entries).toEqual([]);

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

function setInput(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")?.set;
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
