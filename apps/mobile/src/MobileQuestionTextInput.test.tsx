// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UseMobileVoiceInputOptions } from "./use-mobile-voice-input";
import { MobileQuestionTextInput } from "./MobileQuestionTextInput";

const voice = vi.hoisted(() => ({ options: undefined as UseMobileVoiceInputOptions | undefined, toggle: vi.fn(), cancel: vi.fn() }));
vi.mock("./use-mobile-voice-input", () => ({ useMobileVoiceInput: (options: UseMobileVoiceInputOptions) => {
  voice.options = options;
  return { available: true, checking: false, busy: false, state: "idle", toggle: voice.toggle, cancel: voice.cancel };
} }));
vi.mock("./use-mobile-voice-permission-settings", () => ({ useMobileVoicePermissionSettings: () => undefined }));
vi.mock("expo-crypto", () => ({ randomUUID: () => "voice-operation" }));
vi.mock("react-native", async () => {
  const React = await import("react");
  const container = ({ children }: { readonly children?: ReactNode }) => React.createElement("div", {}, children);
  return { View: container, Text: container,
    Pressable: ({ children, onPress, disabled }: { readonly children?: ReactNode; readonly onPress?: () => void; readonly disabled?: boolean }) => React.createElement("button", { onClick: onPress, disabled }, children),
    TextInput: React.forwardRef<HTMLInputElement, { readonly accessibilityLabel: string; readonly value: string; readonly editable: boolean; readonly onChangeText: (text: string) => void }>((props, ref) =>
      React.createElement("input", { ref, "aria-label": props.accessibilityLabel, value: props.value, disabled: !props.editable,
        onChange: (event: { readonly target: { readonly value: string } }) => props.onChangeText(event.target.value) })) };
});

let root: Root, host: HTMLDivElement;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.body.appendChild(document.createElement("div")); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("keeps provisional question speech out of the saved answer and adopts only its terminal text", async () => {
  const changed = vi.fn(); await render(changed);
  await act(async () => voice.options!.writeDraft({ text: "original preview", mentions: [], atoms: [], slashCommands: [], attachments: [] }, { start: 16, end: 16 }, false));
  expect(host.querySelector("input")!.value).toBe("original preview"); expect(changed).not.toHaveBeenCalled();
  expect(voice.options!.readDraft().text).toBe("original preview");
  await act(async () => voice.options!.writeDraft({ text: "original final", mentions: [], atoms: [], slashCommands: [], attachments: [] }, { start: 14, end: 14 }, true));
  expect(changed).toHaveBeenCalledExactlyOnceWith("original final");
});

it("hides provisional text and rejects terminal adoption when the question closes or settles", async () => {
  const changed = vi.fn(); await render(changed);
  await act(async () => voice.options!.writeDraft({ text: "preview", mentions: [], atoms: [], slashCommands: [], attachments: [] }, { start: 7, end: 7 }, false));
  const oldWrite = voice.options!.writeDraft;
  await render(changed, false);
  await act(async () => oldWrite({ text: "late", mentions: [], atoms: [], slashCommands: [], attachments: [] }, { start: 4, end: 4 }, true));
  expect(host.querySelector("input")!.value).toBe("original"); expect(changed).not.toHaveBeenCalled();
});

async function render(onChange: (value: string) => void, enabled = true) {
  await act(async () => root.render(<MobileQuestionTextInput ownerKey="request/field/other" enabled={enabled} value="original" label="Other"
    colors={{ background: "white", surface: "white", ink: "black", muted: "gray", border: "gray", accent: "orange", negative: "red", brandBackground: "white" }}
    locale="en" onChange={onChange} onError={() => undefined} />));
}
