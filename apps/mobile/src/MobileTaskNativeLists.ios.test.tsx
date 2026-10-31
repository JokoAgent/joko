// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { TaskTagColor } from "@joko/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { MobileTaskOptionsSheet } from "./MobileTaskOptionsSheet.ios";
import { MobileTaskTagsNative } from "./MobileTaskTagsNative.ios";
import type { MobileTaskTagsNativeProps } from "./MobileTaskTagsNative";

const native = vi.hoisted(() => ({ state: "active", sheet: undefined as undefined | { onDismiss?: () => void; onIsPresentedChange: (value: boolean) => void },
  buttons: new Map<string, () => void>(), announce: vi.fn(), listeners: new Set<(state: string) => void>(),
  move: undefined as undefined | ((sources: number[], destination: number) => void), editMode: "" }));
vi.mock("react-native", () => ({ AppState: { get currentState() { return native.state; }, addEventListener: (_kind: string, listener: (state: string) => void) => {
  native.listeners.add(listener); return { remove: () => native.listeners.delete(listener) }; } }, AccessibilityInfo: { announceForAccessibility: native.announce } }));
vi.mock("@expo/ui", async () => { const React = await import("react"); return { Host: ({ children }: { children: ReactNode }) => React.createElement("div", {}, children) }; });
vi.mock("@expo/ui/swift-ui/modifiers", () => Object.fromEntries(["accessibilityLabel", "accessibilityAddTraits", "buttonStyle", "deleteDisabled", "disabled", "environment", "foregroundStyle", "frame", "interactiveDismissDisabled", "moveDisabled", "pickerStyle", "presentationDragIndicator", "strokeBorder", "tag"].map(key => [key, (value: unknown, detail?: unknown) => ({ key, value, detail })])));
vi.mock("@expo/ui/swift-ui", async () => {
  const React = await import("react"); const container = ({ children }: { children: ReactNode }) => React.createElement("div", {}, children);
  return { Group: container, HStack: container, VStack: container, ZStack: container, Form: ({ children, modifiers = [] }: { children: ReactNode; modifiers?: Array<{ key: string; value: unknown; detail: unknown }> }) => {
    const environment = modifiers.find(value => value.key === "environment"); if (environment) native.editMode = String(environment.detail);
    return React.createElement("div", {}, children);
  }, Section: container, Text: container, RNHostView: container, Circle: () => null, ProgressView: () => null,
    List: { ForEach: ({ children, onMove }: { children: ReactNode; onMove?: (sources: number[], destination: number) => void }) => { native.move = onMove; return React.createElement("div", {}, children); } },
    BottomSheet: ({ isPresented, children, ...callbacks }: { isPresented: boolean; children: ReactNode; onDismiss?: () => void; onIsPresentedChange: (value: boolean) => void }) => {
      native.sheet = callbacks; return isPresented ? React.createElement("div", { "data-native-sheet": true }, children) : null;
    },
    Button: ({ label, onPress, modifiers = [] }: { label: string; onPress: () => void; modifiers?: Array<{ key: string; value: unknown }> }) => {
      native.buttons.set(label, onPress); return React.createElement("button", { onClick: onPress, disabled: modifiers.some(value => value.key === "disabled" && value.value === true) }, label);
    },
    Picker: ({ children }: { children: ReactNode }) => React.createElement("div", {}, children),
    TextField: ({ text, onTextChange, modifiers = [] }: { text: { get: () => string }; onTextChange: (value: string) => void; modifiers?: Array<{ key: string; value: unknown }> }) => React.createElement("input", {
      value: text.get(), disabled: modifiers.some(value => value.key === "disabled" && value.value === true), onChange: () => undefined,
      onInput: (event: React.ChangeEvent<HTMLInputElement>) => onTextChange(event.target.value)
    }),
    useNativeState: (initial: string) => { const value = React.useRef(initial); return React.useMemo(() => ({ get: () => value.current, set: (next: string) => { value.current = next; } }), []); }
  };
});
afterEach(() => { native.state = "active"; native.sheet = undefined; native.buttons.clear(); native.listeners.clear(); native.announce.mockReset(); });

const colors = { background: "#fff", surface: "#fff", ink: "#111", muted: "#777", accent: "#f90", border: "#ddd", negative: "#b00", brandBackground: "#ffe" };
it("runs a native task option only after its actual dismissal and rejects a previous presentation's dismissal", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); const host = document.body.appendChild(document.createElement("div")), root = createRoot(host);
  const close = vi.fn(), action = vi.fn();
  const show = (visible: boolean) => act(() => root.render(createElement(MobileTaskOptionsSheet<string>, { visible,
    items: [{ id: "archive", label: "Archive", destructive: true }, { id: "disabled", label: "Disabled", disabled: true }], colors, locale: "en", onClose: close, onAction: action })));
  try {
    await show(true); const oldDismiss = native.sheet!.onDismiss!;
    await act(() => (Array.from(host.querySelectorAll("button")).find(button => button.textContent === "Archive")!).click());
    expect(action).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce(); await show(false);
    await act(() => native.sheet!.onDismiss?.()); expect(action).toHaveBeenCalledExactlyOnceWith("archive");
    await show(true); await act(() => native.buttons.get("Archive")!()); await show(false);
    await act(() => oldDismiss()); expect(action).toHaveBeenCalledOnce();
    await act(() => native.sheet!.onDismiss?.()); expect(action).toHaveBeenCalledTimes(2);
  } finally { await act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});

it("maps native tag rows and fields to the original controller, blocks busy back, and rejects callbacks from an old rendered owner", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); const host = document.body.appendChild(document.createElement("div")), root = createRoot(host);
  const toggle = vi.fn(), change = vi.fn(), save = vi.fn(), close = vi.fn(), back = vi.fn();
  const props: MobileTaskTagsNativeProps = { visible: true, busy: false, error: "", colors, locale: "en", subtitle: "Original task",
    adding: false, revision: 1n, onAdd: vi.fn(), onMove: vi.fn(),
    items: [{ id: "tag", name: "Work", color: "#777", attached: false, onToggle: toggle, onEdit: vi.fn() }],
    palette: [{ value: TaskTagColor.BLUE, name: "Blue", hex: "#00f" }], create: { name: "", color: TaskTagColor.BLUE, canSave: true, onName: change, onColor: vi.fn(), onSave: save },
    onDelete: vi.fn(), onBack: back, onClose: close };
  try {
    await act(() => root.render(createElement(MobileTaskTagsNative, props)));
    const oldToggle = native.buttons.get("Work")!; await act(() => oldToggle()); expect(toggle).toHaveBeenCalledOnce();
    expect(host.querySelector("input")).toBeNull();
    await act(() => native.buttons.get("Create tag")!()); expect(props.onAdd).toHaveBeenCalledOnce();
    await act(() => root.render(createElement(MobileTaskTagsNative, { ...props, adding: true })));
    const input = host.querySelector("input")!;
    await act(() => { input.value = "New tag"; input.dispatchEvent(new Event("input", { bubbles: true })); }); expect(change).toHaveBeenCalledWith("New tag");
    await act(() => native.buttons.get("Save")?.()); expect(save).toHaveBeenCalledOnce();
    await act(() => root.render(createElement(MobileTaskTagsNative, { ...props, busy: true })));
    await act(() => native.sheet!.onIsPresentedChange(false)); expect(close).not.toHaveBeenCalled();
    expect(Array.from(host.querySelectorAll("button")).filter(button => button.textContent === "Cancel").every(button => button.disabled)).toBe(true);
    await act(() => oldToggle()); expect(toggle).toHaveBeenCalledOnce();
    await act(() => root.render(createElement(MobileTaskTagsNative, { ...props, error: "Check original operation" })));
    expect(native.announce).toHaveBeenCalledWith("Check original operation");
  } finally { await act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});

it("uses native move destinations and blocks tag edits while sorting or after the catalog changes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); const host = document.body.appendChild(document.createElement("div")), root = createRoot(host);
  const toggle = vi.fn(), edit = vi.fn(), move = vi.fn();
  const props: MobileTaskTagsNativeProps = { visible: true, busy: false, error: "", colors, locale: "en", adding: false, revision: 1n,
    items: ["One", "Two"].map(id => ({ id, name: id, color: "#777", attached: false, onToggle: toggle, onEdit: edit })),
    palette: [], create: { name: "", color: TaskTagColor.BLUE, canSave: false, onName: vi.fn(), onColor: vi.fn(), onSave: vi.fn() },
    onAdd: vi.fn(), onMove: move, onDelete: vi.fn(), onBack: vi.fn(), onClose: vi.fn() };
  try {
    await act(() => root.render(createElement(MobileTaskTagsNative, props)));
    await act(() => native.buttons.get("Reorder tags")!()); expect(native.editMode).toBe("active");
    await act(() => native.buttons.get("One")!()); expect(toggle).not.toHaveBeenCalled();
    const oldMove = native.move!; await act(() => oldMove([0], 2)); expect(move).toHaveBeenCalledExactlyOnceWith(0, 1);
    await act(() => root.render(createElement(MobileTaskTagsNative, { ...props, revision: 2n })));
    expect(native.editMode).toBe("inactive");
    await act(() => oldMove([0], 2)); expect(move).toHaveBeenCalledOnce();
  } finally { await act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
