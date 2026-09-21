// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobilePreviewControlBar, MobilePreviewControlButton } from "./MobilePreviewControls";

const observed = vi.hoisted(() => ({
  pressable: undefined as Record<string, unknown> | undefined,
  view: undefined as Record<string, unknown> | undefined
}));

vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  return {
    Pressable: (props: Record<string, unknown>) => {
      const resolveStyle = props["style"] as ((state: { pressed: boolean }) => unknown) | undefined;
      observed.pressable = { ...props, resolvedStyle: flattenStyle(resolveStyle?.({ pressed: false })) };
      return createElement("button", {
        disabled: props["disabled"] === true,
        onClick: props["onPress"] as (() => void) | undefined
      }, props["children"] as import("react").ReactNode);
    },
    StyleSheet: { create: (value: unknown) => value },
    Text: (props: Record<string, unknown>) => createElement("span", undefined,
      props["children"] as import("react").ReactNode),
    View: (props: Record<string, unknown>) => {
      observed.view = props;
      return createElement("div", undefined, props["children"] as import("react").ReactNode);
    }
  };
});

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  observed.pressable = undefined;
  observed.view = undefined;
});

describe("mobile preview native controls", () => {
  it("exposes a named toolbar and a named, stateful 44-point action", () => {
    const onPress = vi.fn();
    root = createRoot(document.createElement("div"));
    act(() => root!.render(createElement(MobilePreviewControlBar, {
      accessibilityLabel: "PDF controls",
      background: "#ffffff",
      border: "#cccccc",
      children: createElement(MobilePreviewControlButton, {
        accessibilityLabel: "Next PDF page",
        disabled: false,
        ink: "#111111",
        label: "Next",
        onPress,
        selected: true,
        surface: "#f5f5f5"
      })
    })));

    expect(observed.view).toMatchObject({
      accessibilityLabel: "PDF controls",
      accessibilityRole: "toolbar"
    });
    expect(observed.pressable).toMatchObject({
      accessibilityLabel: "Next PDF page",
      accessibilityRole: "button",
      accessibilityState: { disabled: false, selected: true },
      disabled: false,
      resolvedStyle: { minHeight: 44, minWidth: 44 }
    });
    act(() => (observed.pressable?.["onPress"] as (() => void) | undefined)?.());
    expect(onPress).toHaveBeenCalledOnce();
  });
});

function flattenStyle(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return value.reduce<Record<string, unknown>>((result, item) => ({
    ...result,
    ...flattenStyle(item)
  }), {});
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
