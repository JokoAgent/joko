// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RuntimeCommandSource } from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileRuntimeCommandPalette } from "./MobileRuntimeCommandPalette";

vi.mock("react-native", async () => {
  const { createElement: element, forwardRef } = await import("react");
  const primitive = (tag: "div" | "span") => ({
    accessibilityLabel,
    accessibilityRole,
    accessibilityLiveRegion,
    children
  }: {
    readonly accessibilityLabel?: string;
    readonly accessibilityRole?: string;
    readonly accessibilityLiveRegion?: string;
    readonly children?: ReactNode;
  }) => element(tag, {
    ...(accessibilityLabel === undefined ? {} : { "aria-label": accessibilityLabel }),
    ...(accessibilityRole === undefined ? {} : { role: accessibilityRole }),
    ...(accessibilityLiveRegion === undefined ? {} : { "aria-live": accessibilityLiveRegion })
  }, children);
  return {
    Pressable: ({
      accessibilityLabel,
      accessibilityHint,
      accessibilityState,
      disabled,
      onPress,
      children
    }: {
      readonly accessibilityLabel?: string;
      readonly accessibilityHint?: string;
      readonly accessibilityState?: { readonly selected?: boolean; readonly disabled?: boolean };
      readonly disabled?: boolean;
      readonly onPress?: () => void;
      readonly children?: ReactNode;
    }) => element("button", {
      "aria-label": accessibilityLabel,
      "aria-description": accessibilityHint,
      "aria-selected": accessibilityState?.selected,
      disabled: disabled || accessibilityState?.disabled,
      onClick: onPress
    }, children),
    ScrollView: forwardRef<HTMLDivElement, {
      readonly children?: ReactNode;
      readonly keyboardShouldPersistTaps?: string;
    }>(({
      children,
      keyboardShouldPersistTaps
    }, ref) => element("div", { ref, "data-keyboard-taps": keyboardShouldPersistTaps }, children)),
    StyleSheet: { create: (styles: unknown) => styles },
    Text: primitive("span"),
    View: primitive("div")
  };
});

const colors = {
  background: "#fff",
  surface: "#fafafa",
  ink: "#111",
  muted: "#666",
  border: "#ccc",
  accent: "#7655cc",
  negative: "#b00",
  brandBackground: "#f2efff"
};

const items = [
  {
    commandId: "release",
    name: "release",
    description: "Prepare release notes",
    source: RuntimeCommandSource.PROMPT
  },
  {
    commandId: "review",
    name: "review",
    description: "",
    source: RuntimeCommandSource.SKILL,
    resourceId: "review-skill"
  }
];

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container = undefined;
});

function render(overrides: Partial<Parameters<typeof MobileRuntimeCommandPalette>[0]> = {}) {
  const onClose = vi.fn();
  const onRefresh = vi.fn();
  const onRetry = vi.fn();
  const onSelect = vi.fn();
  container = document.createElement("div");
  root = createRoot(container);
  act(() => root!.render(createElement(MobileRuntimeCommandPalette, {
    visible: true,
    query: "re",
    items,
    selectedIndex: 1,
    status: "ready",
    disabled: false,
    checkingDraft: false,
    colors,
    onClose,
    onRefresh,
    onRetry,
    onSelect,
    ...overrides
  })));
  return { container, onClose, onRefresh, onRetry, onSelect };
}

describe("MobileRuntimeCommandPalette", () => {
  it("renders a native accessible selected list without taking the editor's semantic role", () => {
    const mounted = render();
    expect(mounted.container.querySelector('[role="list"]')?.getAttribute("aria-label")).toBe("Runtime commands");
    const review = mounted.container.querySelector('button[aria-label="Insert runtime command /review"]');
    expect(review?.getAttribute("aria-selected")).toBe("true");
    expect(review?.getAttribute("aria-description")).toBe("Skill command");
    expect(mounted.container.querySelector('[data-keyboard-taps="always"]')).not.toBeNull();
    expect(mounted.container.textContent).toContain("Selected /review");
    expect(mounted.container.textContent).toContain("Prepare release notes");
    act(() => review?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(mounted.onSelect).toHaveBeenCalledWith(items[1]);
  });

  it("announces no-match and draft-fence states while keeping insertion disabled", () => {
    const noMatch = render({ items: [], query: "missing" });
    expect(noMatch.container.textContent).toContain("Enter and Tab will keep this text unsent");
    act(() => root?.unmount());
    root = undefined;

    const checking = render({ checkingDraft: true });
    expect(checking.container.textContent).toContain("Checking draft…");
    expect(checking.container.querySelector('button[aria-label="Insert runtime command /review"]')?.hasAttribute("disabled"))
      .toBe(true);
  });

  it("exposes retry, refresh, and close as separate accessible actions", () => {
    const mounted = render({ status: "error", error: "Catalog retired" });
    expect(mounted.container.querySelector('[role="alert"]')?.textContent).toContain("Catalog retired");
    const retry = mounted.container.querySelector('button[aria-label="Retry runtime commands"]');
    const refresh = mounted.container.querySelector('button[aria-label="Refresh runtime commands"]');
    const close = mounted.container.querySelector('button[aria-label="Close runtime commands"]');
    act(() => retry?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    act(() => refresh?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    act(() => close?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(mounted.onRetry).toHaveBeenCalledTimes(1);
    expect(mounted.onRefresh).toHaveBeenCalledTimes(1);
    expect(mounted.onClose).toHaveBeenCalledTimes(1);
  });
});
