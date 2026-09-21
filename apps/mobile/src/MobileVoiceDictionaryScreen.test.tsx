// @vitest-environment jsdom
import { act, createElement, forwardRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileVoiceDictionaryScreen, type MobileVoiceDictionaryScreenProps } from "./MobileVoiceDictionaryScreen";
import { mobileMessage } from "./mobile-messages";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import type { MobileVoiceDictionaryStoreState } from "./mobile-voice-dictionary-store";

const native = vi.hoisted(() => ({ alert: vi.fn() }));

vi.mock("react-native", async () => {
  const React = await import("react");
  const element = (tag: string) => ({ accessibilityLabel, accessibilityRole, accessibilityLiveRegion: _live,
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
    const { accessibilityLabel, value, editable = true, multiline,
      onChangeText: rawChangeText, onSubmitEditing: rawSubmitEditing, ...props } = rawProps;
    const onChangeText = rawChangeText as ((value: string) => void) | undefined;
    const onSubmitEditing = rawSubmitEditing as (() => void) | undefined;
    return React.createElement(multiline ? "textarea" : "input", {
        ...props,
        ref,
        "aria-label": accessibilityLabel,
        value,
        disabled: !editable,
        onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChangeText?.(event.target.value),
        onKeyDown: (event: React.KeyboardEvent) => { if (event.key === "Enter") onSubmitEditing?.(); },
        style: undefined
      });
  });
  return {
    Alert: { alert: native.alert },
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

function voiceState(status: MobileVoiceDictionaryStoreState["status"] = "ready"): MobileVoiceDictionaryStoreState {
  return {
    status,
    saving: false,
    ...(status === "error" ? { error: "damaged" } : {}),
    document: {
      version: 1,
      revision: 3,
      dictionaryRevision: 3,
      refinementInstructions: "Keep commands verbatim.",
      autoLearningEnabled: true,
      dictionary: {
        entries: [
          { id: "source", text: "Variant", source: "automatic", frequency: 3,
            aliases: [{ text: "variant old", count: 2, lastSeenAt: 20 }], createdAt: 10, updatedAt: 20 },
          { id: "target", text: "Canonical", source: "manual", frequency: 4,
            aliases: [], createdAt: 5, updatedAt: 25 }
        ],
        candidates: [{ text: "VoiceKit", evidenceCount: 2,
          aliases: [{ text: "voice kit", count: 2, lastSeenAt: 22 }], createdAt: 8, updatedAt: 22 }],
        suppressedAutomaticTexts: []
      },
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
    onAddTerm: vi.fn(async () => undefined),
    onEditEntry: vi.fn(async () => "updated" as const),
    onDeleteEntry: vi.fn(async () => undefined),
    ...overrides
  };
  act(() => root!.render(createElement(MobileVoiceDictionaryScreen, props)));
  return props;
}

function button(label: string): HTMLButtonElement {
  const value = container.querySelector(`button[aria-label="${label}"]`);
  if (!(value instanceof HTMLButtonElement)) throw new Error(`Missing button: ${label}`);
  return value;
}

function change(label: string, value: string): void {
  const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`);
  if (!input) throw new Error(`Missing input: ${label}`);
  act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("MobileVoiceDictionaryScreen", () => {
  it.each(["en", "zh-CN", "zh-TW", "ja", "ko"] as const)("renders the complete local surface in %s", (locale) => {
    render(locale);
    expect(container.textContent).toContain(mobileMessage(locale, "settings.voice.title"));
    expect(container.textContent).toContain(mobileMessage(locale, "settings.voice.privacy"));
    expect(container.textContent).toContain(mobileMessage(locale, "settings.voice.entries"));
    expect(container.textContent).toContain(mobileMessage(locale, "settings.voice.candidates"));
    expect(container.textContent).toContain(mobileMessage(locale, "settings.voice.localActivity"));
    expect(button(mobileMessage(locale, "settings.voice.confirmCandidate", { term: "VoiceKit" }))).toBeTruthy();
  });

  it("keeps an edit draft across locale changes, previews a merge, reports the result, and restores input focus", async () => {
    const onEditEntry = vi.fn(async () => "mergedEntry" as const);
    render("en", { onEditEntry });
    act(() => button(mobileMessage("en", "settings.voice.edit", { term: "Variant" })).click());
    change(mobileMessage("en", "settings.voice.term"), "Canonical");
    expect(container.textContent).toContain(mobileMessage("en", "settings.voice.mergeEntry", { term: "Canonical" }));
    render("ja", { onEditEntry });
    expect((container.querySelector(`[aria-label="${mobileMessage("ja", "settings.voice.term")}"]`) as HTMLInputElement).value)
      .toBe("Canonical");
    await act(async () => button(mobileMessage("ja", "settings.voice.saveEntry")).click());
    expect(onEditEntry).toHaveBeenCalledWith("source", "Canonical", "variant old");
    expect(container.textContent).toContain(mobileMessage("ja", "settings.voice.merged"));
    expect(document.activeElement?.getAttribute("aria-label")).toBe(mobileMessage("ja", "settings.voice.term"));
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
