// @vitest-environment jsdom
import { act, createElement, forwardRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileVoiceDictionaryScreen, type MobileVoiceDictionaryScreenProps } from "./MobileVoiceDictionaryScreen";
import { mobileMessage } from "./mobile-messages";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import type { MobileVoicePreferencesStoreState } from "./mobile-voice-preferences-store";
import { create } from "@bufbuild/protobuf";
import { VoiceInputServiceSettingsSchema, VoiceInputTranscriptionProtocol, VoiceInputSaucMode, VoiceInputSaucAuthentication, TestVoiceInputConnectionResponseSchema } from "@joko/contracts";
import type { MobileVoiceSettingsTransport } from "./mobile-voice-service-settings";

const native = vi.hoisted(() => ({ alert: vi.fn() }));

vi.mock("react-native", async () => {
  const React = await import("react");
  const element = (tag: string) => ({ accessibilityLabel, accessibilityRole, accessibilityLiveRegion: _live,
    accessibilityState: _state, selectable: _selectable,
    onPress, disabled, contentContainerStyle: _content, keyboardShouldPersistTaps: _taps, ...props }: Record<string, unknown> & {
      children?: React.ReactNode; accessibilityLabel?: string; accessibilityRole?: string;
      accessibilityLiveRegion?: string; onPress?: () => void; disabled?: boolean;
      contentContainerStyle?: unknown; keyboardShouldPersistTaps?: unknown;
    }) => React.createElement(tag, {
      ...props,
      ...(accessibilityLabel ? { "aria-label": accessibilityLabel } : {}),
      ...(accessibilityRole ? { role: accessibilityRole } : {}),
      ...(onPress ? { onClick: onPress } : {}),
      disabled,
      style: undefined
    }, props.children);
  const TextInput = forwardRef<HTMLInputElement | HTMLTextAreaElement, {
    accessibilityLabel?: string; value?: string; editable?: boolean; multiline?: boolean;
    onChangeText?: (value: string) => void; onSubmitEditing?: () => void;
  } & Record<string, unknown>>((rawProps, ref) => {
    const { accessibilityLabel, value, editable = true, multiline, secureTextEntry, autoCorrect: _autoCorrect,
      placeholderTextColor: _placeholderTextColor,
      onChangeText: rawChangeText, onSubmitEditing: rawSubmitEditing, ...props } = rawProps;
    const onChangeText = rawChangeText as ((value: string) => void) | undefined;
    const onSubmitEditing = rawSubmitEditing as (() => void) | undefined;
    return React.createElement(multiline ? "textarea" : "input", {
        ...props,
        ref,
        "aria-label": accessibilityLabel,
        value,
        ...(!multiline && secureTextEntry ? { type: "password" } : {}),
        disabled: !editable,
        onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChangeText?.(event.target.value),
        onKeyDown: (event: React.KeyboardEvent) => { if (event.key === "Enter") onSubmitEditing?.(); },
        style: undefined
      });
  });
  return {
    Alert: { alert: native.alert },
    AppState: { addEventListener: () => ({ remove: () => undefined }) },
    BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
    Pressable: element("button"),
    ScrollView: element("div"),
    StyleSheet: { create: <T,>(value: T) => value },
    Switch: ({ accessibilityLabel, value, onValueChange, disabled }: {
      accessibilityLabel?: string; value?: boolean; onValueChange?: (value: boolean) => void; disabled?: boolean;
    }) => React.createElement("input", { type: "checkbox", "aria-label": accessibilityLabel, checked: value,
      disabled, onChange: (event: React.ChangeEvent<HTMLInputElement>) => onValueChange?.(event.target.checked) }),
    Text: element("span"),
    TextInput,
    View: element("div")
  };
});

const colors = {
  background: "#fafafa", surface: "#fff", ink: "#111", muted: "#666", border: "#ddd",
  accent: "#f90", negative: "#b00", brandBackground: "#fff0d0"
};

function voiceState(status: MobileVoicePreferencesStoreState["status"] = "ready"): MobileVoicePreferencesStoreState {
  return {
    status,
    saving: false,
    ...(status === "error" ? { error: "damaged" } : {}),
    document: {
      version: 1,
      revision: 3,
      preferencesRevision: 3,
      refinementInstructions: "Keep commands verbatim.",
      autoLearningEnabled: true,
      recognitionContextEnabled: false, recognitionContextData: [],
      usage: { voiceStarts: 4, correctionObservations: 2, lastVoiceStartedAt: 30, lastCorrectionAt: 25 },
      history: []
    }
  };
}

let root: Root | undefined;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container.remove();
  native.alert.mockReset();
  vi.unstubAllGlobals();
});

function render(locale: MobileSupportedLocale, overrides: Partial<MobileVoiceDictionaryScreenProps> = {}) {
  const props: MobileVoiceDictionaryScreenProps = {
    colors,
    locale,
    state: voiceState(),
    onBack: vi.fn(),
    onRetry: vi.fn(async () => undefined),
    onReset: vi.fn(async () => undefined),
    onSetInstructions: vi.fn(async () => undefined),
    onSetAutoLearning: vi.fn(async () => undefined),
    ...overrides
  };
  act(() => root!.render(createElement(MobileVoiceDictionaryScreen, props)));
  return props;
}

function button(label: string): HTMLButtonElement {
  const value = Array.from(container.querySelectorAll("button")).find((entry) => entry.getAttribute("aria-label") === label);
  if (!(value instanceof HTMLButtonElement)) throw new Error(`Missing button: ${label}`);
  return value;
}

function change(label: string, value: string): void {
  const input = Array.from(container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea"))
    .find((entry) => entry.getAttribute("aria-label") === label);
  if (!input) throw new Error(`Missing input: ${label}`);
  act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("MobileVoiceDictionaryScreen", () => {
  it("connects the voice service settings section to full primary and fallback configuration and private context authorization", async () => {
    const settings = create(VoiceInputServiceSettingsSchema, { enabled: true, protocol: VoiceInputTranscriptionProtocol.VOLCENGINE_SAUC,
      fallbackProtocol: VoiceInputTranscriptionProtocol.VOLCENGINE_SAUC, fallbackEnabled: true,
      endpoint: "wss://speech.example/api/v3/sauc/bigmodel_async", fallbackEndpoint: "wss://fallback.example/api/v3/sauc/bigmodel_async",
      resourceId: "primary-resource", fallbackResourceId: "fallback-resource", version: { revision: { value: 4n } },
      sauc: { mode: VoiceInputSaucMode.ASYNC_TWO_PASS, authentication: VoiceInputSaucAuthentication.API_KEY },
      fallbackSauc: { mode: VoiceInputSaucMode.ASYNC_TWO_PASS, authentication: VoiceInputSaucAuthentication.API_KEY } });
    const api: MobileVoiceSettingsTransport = { ownerKey: "voice-node-a", isCurrent: () => true,
      get: vi.fn(async () => settings), getCapabilities: vi.fn(async () => ({ support: "supported" as const, supportsLocale: true,
        supportsLiveDrafts: true, supportsRefinement: true, supportsRecognitionContext: true,
        recognitionContextMaximumItems: 20, recognitionContextMaximumItemBytes: 2_048, recognitionContextMaximumBytes: 8_192, supportedLocales: [],
        limits: { supportedMimeTypes: ["audio/pcm"], maximumAudioChunkBytes: 1024, maximumAudioBytes: 4096,
          maximumAudioChunkDurationMs: 1000, maximumAudioDurationMs: 10_000, maximumLocaleCharacters: 35, stableWaitMs: 500, maximumConcurrentSessions: 1 } })),
      save: vi.fn(async () => settings), test: vi.fn(async () => create(TestVoiceInputConnectionResponseSchema, { ok: true })),
      reconcile: vi.fn(async () => undefined), hasPending: () => false };
    const setContext = vi.fn(async () => undefined);
    await act(async () => { render("en", { serviceTransport: api, onSetRecognitionContext: setContext }); });
    act(() => { button("Primary · Streaming input").click(); button("Fallback · Bidirectional streaming").click(); });
    expect(Array.from(container.querySelectorAll("button")).map((entry) => entry.getAttribute("aria-label")).filter((label) => label?.startsWith("Primary")))
      .toContain("Primary · APP ID + Access Token");
    act(() => button("Primary · APP ID + Access Token").click());
    change("Primary · APP ID", "public-app"); change("Primary · Hotword table name", "word-table");
    change("Primary · Hotword table ID", "word-id"); change("Fallback · Replacement table ID", "replacement-id");
    change("Primary · APP ID + Access Token", "private-primary"); change("Fallback · API Key", "private-fallback");
    act(() => (container.querySelector('[aria-label="Primary · Send dictionary main terms as hotwords"]') as HTMLInputElement).click());
    await act(async () => button("Save configuration").click());
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: expect.objectContaining({ value: 4n }),
      endpoint: "wss://speech.example/api/v3/sauc/bigmodel_nostream", fallbackEndpoint: "wss://fallback.example/api/v3/sauc/bigmodel",
      sauc: expect.objectContaining({ mode: VoiceInputSaucMode.STREAM_INPUT, authentication: VoiceInputSaucAuthentication.ACCESS_TOKEN,
        appId: "public-app", useDictionaryHotwords: true, boostingTableName: "word-table", boostingTableId: "word-id" }),
      fallbackSauc: expect.objectContaining({ mode: VoiceInputSaucMode.BIDIRECTIONAL, correctTableId: "replacement-id" })
    }), { primary: "private-primary", fallback: "private-fallback" }, expect.any(AbortSignal));
    expect((container.querySelector('[aria-label="Primary · API Key"]') as HTMLInputElement).value).toBe("");
    await act(async () => button("Test saved connection").click()); expect(api.test).toHaveBeenCalledOnce();
    act(() => { (container.querySelector('[aria-label="Authorize sending these texts to the recognition service"]') as HTMLInputElement).click(); button("Add text").click(); });
    change("Recognition context 1", "private context\nsecond paragraph");
    await act(async () => button("Save private context").click());
    expect(setContext).toHaveBeenCalledWith(true, [{ text: "private context\nsecond paragraph" }]);
    expect(api.save).toHaveBeenCalledOnce();
    change("Primary · Endpoint", "wss://retained.example/api/v3/sauc/bigmodel_async");
    await act(async () => { render("en", { serviceTransport: undefined, onSetRecognitionContext: setContext }); });
    expect((container.querySelector('[aria-label="Primary · Endpoint"]') as HTMLInputElement).value).toBe("wss://retained.example/api/v3/sauc/bigmodel_async");
    expect((container.querySelector('[aria-label="Primary · Endpoint"]') as HTMLInputElement).disabled).toBe(true);
    await act(async () => { render("en", { serviceTransport: { ...api, ownerKey: "voice-node-b" }, onSetRecognitionContext: setContext }); });
    expect(button("Save configuration").disabled).toBe(true);
    expect(container.textContent).toContain("Review current revision");
    act(() => button("Review current revision").click());
    expect(button("Save configuration").disabled).toBe(false);
    vi.mocked(api.get).mockResolvedValue({ ...settings,
      version: { ...settings.version!, revision: { ...settings.version!.revision!, value: 5n } } });
    await act(async () => button("Refresh configuration").click());
    expect(button("Save configuration").disabled).toBe(true);
    expect((container.querySelector('[aria-label="Primary · Endpoint"]') as HTMLInputElement).value).toBe("wss://retained.example/api/v3/sauc/bigmodel_async");
    act(() => button("Review current revision").click());
    expect(button("Save configuration").disabled).toBe(false);
  });
  it.each(["en", "zh-CN"] as const)("opens the read-only node dictionary from voice settings in %s", locale => {
    const open = vi.fn();
    render(locale, { onReadOnlyDictionary: open });
    act(() => button(mobileMessage(locale, "settings.voiceReadonly.title")).click());
    expect(open).toHaveBeenCalledOnce();
    for (const key of ["settings.voice.addTerm", "settings.voice.saveEntry", "settings.voice.deleteEntry", "settings.voice.sync"] as const) {
      expect(Array.from(container.querySelectorAll("[aria-label]")).some(entry => entry.getAttribute("aria-label") === mobileMessage(locale, key))).toBe(false);
    }
    expect(container.textContent).toContain(mobileMessage(locale, "settings.voice.localActivity"));
  });

  it("distinguishes failed private history from the node dictionary result", () => {
    render("en", { state: { ...voiceState(), error: "local disk unavailable" } });
    expect(container.textContent).toContain(mobileMessage("en", "settings.voice.localSaveError"));
    expect(container.textContent).not.toContain(mobileMessage("en", "settings.voice.saveError"));
  });

  it("offers retry and explicit reset recovery for a damaged strict-v1 record", async () => {
    const onRetry = vi.fn(async () => undefined);
    const onReset = vi.fn(async () => undefined);
    render("en", { state: voiceState("error"), onRetry, onReset });
    await act(async () => button(mobileMessage("en", "common.retry")).click());
    expect(onRetry).toHaveBeenCalledOnce();
    act(() => button(mobileMessage("en", "settings.voice.reset")).click());
    expect(native.alert).toHaveBeenCalledWith(
      mobileMessage("en", "settings.voice.resetTitle"),
      mobileMessage("en", "settings.voice.resetBody"),
      expect.any(Array)
    );
    const actions = native.alert.mock.calls[0]?.[2] as Array<{ text: string; onPress?: () => void }>;
    act(() => actions.find((action) => action.text === mobileMessage("en", "settings.voice.reset"))?.onPress?.());
    expect(onReset).toHaveBeenCalledOnce();
  });

});
