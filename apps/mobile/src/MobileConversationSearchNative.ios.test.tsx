// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MobileConversationSearchNative } from "./MobileConversationSearchNative.ios";

vi.mock("@expo/ui", async () => { const React = await import("react"); return { Host: ({ children }: { children: ReactNode }) => React.createElement("div", {}, children) }; });
vi.mock("expo-glass-effect", () => ({ isLiquidGlassAvailable: () => true }));
vi.mock("@expo/ui/swift-ui/modifiers", () => Object.fromEntries([
  "accessibilityLabel", "autocorrectionDisabled", "background", "buttonStyle", "contentShape", "disabled", "font", "foregroundStyle",
  "frame", "glassEffect", "labelStyle", "padding", "presentationDragIndicator", "submitLabel", "textInputAutocapitalization"
].map((key) => [key, (value: unknown) => ({ key, value })]).concat([["shapes", { circle: () => ({}), capsule: () => ({}) }] as any])));
vi.mock("@expo/ui/swift-ui", async () => {
  const React = await import("react"); const container = ({ children }: { children: ReactNode }) => React.createElement("div", {}, children);
  return { Group: container, HStack: container, VStack: container, Text: container, Spacer: () => null,
    BottomSheet: ({ isPresented, onIsPresentedChange, children }: { isPresented: boolean; onIsPresentedChange: (value: boolean) => void; children: ReactNode }) => isPresented
      ? React.createElement("div", {}, children, React.createElement("button", { onClick: () => onIsPresentedChange(false) }, "Dismiss native search")) : null,
    Button: ({ label, onPress, modifiers }: { label: string; onPress: () => void; modifiers: Array<{ key: string; value: unknown }> }) => React.createElement("button", {
      disabled: modifiers.some((value) => value.key === "disabled" && value.value === true), onClick: onPress
    }, label),
    TextField: ({ text, onTextChange, placeholder }: { text: { get: () => string }; onTextChange: (value: string) => void; placeholder: string }) => React.createElement("input", {
      "aria-label": placeholder, value: text.get(), onChange: () => undefined, onInput: (event: React.ChangeEvent<HTMLInputElement>) => onTextChange(event.target.value)
    }),
    useNativeState: (initial: string) => { const value = React.useRef(initial); const [, refresh] = React.useState(0);
      return React.useMemo(() => ({ get: () => value.current, set: (next: string) => { value.current = next; refresh((current) => current + 1); } }), []); }
  };
});

it("maps the SwiftUI sheet, text and action events to the same search owner", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.body.appendChild(document.createElement("div")), root = createRoot(host);
  const change = vi.fn(), move = vi.fn(), earlier = vi.fn(), close = vi.fn();
  try {
    await act(() => root.render(createElement(MobileConversationSearchNative, { visible: true, query: "term", counter: "1 / 2", hasHits: true,
      title: "Search conversation", placeholder: "Search this conversation", clearLabel: "Clear search", previousLabel: "Previous match", nextLabel: "Next match",
      earlier: { visible: true, disabled: false, label: "Search earlier messages" }, colors: { surface: "#fff", ink: "#111", muted: "#666", negative: "#b00", dark: false },
      onChangeQuery: change, onMove: move, onLoadEarlier: earlier, onClose: close })));
    const press = async (label: string) => { const button = Array.from(host.querySelectorAll("button")).find((item) => item.textContent === label)!; await act(() => button.click()); };
    expect(host.textContent).toContain("1 / 2");
    const input = host.querySelector("input")!; await act(() => { input.value = "next"; input.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(change).toHaveBeenLastCalledWith("next"); await press("Clear search"); expect(change).toHaveBeenLastCalledWith("");
    await press("Previous match"); await press("Next match"); expect(move.mock.calls).toEqual([["previous"], ["next"]]);
    await press("Search earlier messages"); expect(earlier).toHaveBeenCalledOnce();
    await press("Dismiss native search"); expect(close).toHaveBeenCalledOnce();
  } finally { await act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
