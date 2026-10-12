// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MobileConversationSearchSheet } from "./MobileConversationSearchSheet";
import type { TimelineRow } from "./timeline";

const native = vi.hoisted(() => ({ listeners: new Set<(state: string) => void>() }));
vi.mock("react-native", async () => {
  const React = await import("react");
  const element = (tag: string) => ({ children, accessibilityLabel, accessibilityRole, disabled, onPress }: {
    children?: ReactNode; accessibilityLabel?: string; accessibilityRole?: string; disabled?: boolean; onPress?: () => void;
  }) => React.createElement(tag, { "aria-label": accessibilityLabel, role: accessibilityRole, disabled, onClick: onPress }, children);
  return { Platform: { OS: "android" }, AppState: { addEventListener: (_event: string, listener: (state: string) => void) => { native.listeners.add(listener); return { remove: () => native.listeners.delete(listener) }; } },
    Modal: ({ visible, children }: { visible: boolean; children: ReactNode }) => visible ? children : null,
    ActivityIndicator: () => null, Pressable: element("button"), View: element("div"), Text: element("span"), StyleSheet: { create: <T,>(value: T) => value, hairlineWidth: 1 },
    TextInput: ({ value, accessibilityLabel, onChangeText }: { value: string; accessibilityLabel: string; onChangeText: (value: string) => void }) => React.createElement("input", {
      value, "aria-label": accessibilityLabel, onChange: () => undefined, onInput: (event: React.ChangeEvent<HTMLInputElement>) => onChangeText(event.target.value)
    }) };
});
vi.mock("react-native-safe-area-context", async () => {
  const React = await import("react");
  return { SafeAreaView: ({ children }: { children: ReactNode }) => React.createElement("div", {}, children), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});
vi.mock("./MobileKeyboardAvoidingView", async () => {
  const React = await import("react"); return { MobileKeyboardAvoidingView: ({ children }: { children: ReactNode }) => React.createElement("div", {}, children), useMobileKeyboardState: () => ({ height: 0, visible: false }) };
});
let root: Root, host: HTMLDivElement;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.body.appendChild(document.createElement("div")); root = createRoot(host); });
afterEach(async () => { await act(() => root.unmount()); host.remove(); native.listeners.clear(); vi.unstubAllGlobals(); });
const colors = { surface: "#fff", ink: "#111", muted: "#666", border: "#ddd", negative: "#b00" };
const rows: TimelineRow[] = ["First", "Second"].map((text, index) => ({ id: `${index}`, eventId: `${index}`, sequence: BigInt(index), label: "Reply", kind: "assistant", text: `${text} match`, completed: true }));
async function input(text: string) { const field = host.querySelector("input")!; await act(() => { field.value = text; field.dispatchEvent(new Event("input", { bubbles: true })); }); }
async function press(label: string) { await act(() => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click()); }

it("focuses the existing hit, cycles matches, clears the query and never loads history automatically", async () => {
  const focus = vi.fn(), earlier = vi.fn(async () => undefined);
  await act(() => root.render(createElement(MobileConversationSearchSheet, { visible: true, rows, colors, locale: "en", hasEarlier: true, loadingEarlier: false,
    canLoadEarlier: true, onClose: vi.fn(), onFocus: focus, onLoadEarlier: earlier })));
  await input("MATCH"); expect(host.textContent).toContain("1 / 2"); expect(focus).toHaveBeenLastCalledWith({ itemKey: "0", sourceKey: "0" }); expect(earlier).not.toHaveBeenCalled();
  await press("Next match"); expect(host.textContent).toContain("2 / 2"); expect(focus).toHaveBeenLastCalledWith({ itemKey: "1", sourceKey: "1" });
  await press("Next match"); expect(host.textContent).toContain("1 / 2");
  await press("Previous match"); expect(host.textContent).toContain("2 / 2");
  await press("Search earlier messages"); expect(earlier).toHaveBeenCalledOnce();
  await press("Clear search"); expect(host.textContent).toContain("Enter a keyword");
});

it("retires a failed older read on close and closes when the app leaves the foreground", async () => {
  let reject!: (reason: Error) => void; const pending = new Promise<void>((_resolve, fail) => { reject = fail; });
  const close = vi.fn(); const render = async (visible: boolean) => { await act(() => root.render(createElement(MobileConversationSearchSheet, {
    visible, rows, colors, locale: "en", hasEarlier: true, loadingEarlier: false, canLoadEarlier: true, onClose: close, onFocus: vi.fn(), onLoadEarlier: () => pending
  }))); };
  await render(true); await input("no hit"); expect(host.textContent).toContain("0 / 0");
  await press("Search earlier messages"); await act(() => { for (const listener of native.listeners) listener("background"); }); expect(close).toHaveBeenCalledOnce();
  await render(false); await act(async () => { reject(new Error("Read failed")); await Promise.resolve(); });
  await render(true); expect(host.querySelector('[role="alert"]')).toBeNull();
});
