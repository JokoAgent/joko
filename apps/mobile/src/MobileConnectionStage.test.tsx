// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileConnectionStage } from "./MobileConnectionStage";

vi.mock("react-native", async () => {
  const React = await import("react");
  const element = (tag: string) => ({ accessibilityLabel, accessibilityHint, onPress,
    contentContainerStyle: _contentContainerStyle, keyboardDismissMode: _keyboardDismissMode,
    keyboardShouldPersistTaps: _keyboardShouldPersistTaps, ...props }: Record<string, unknown> & {
      children?: React.ReactNode;
      accessibilityLabel?: string;
      accessibilityHint?: string;
      onPress?: () => void;
      contentContainerStyle?: unknown;
      keyboardDismissMode?: unknown;
      keyboardShouldPersistTaps?: unknown;
    }) => React.createElement(tag, {
      ...props,
      ...(accessibilityLabel ? { "aria-label": accessibilityLabel } : {}),
      ...(accessibilityHint ? { title: accessibilityHint } : {}),
      ...(onPress ? { onClick: onPress } : {}),
      style: undefined
    }, props.children);
  return {
    KeyboardAvoidingView: element("div"),
    Platform: { OS: "ios" },
    Pressable: element("button"),
    ScrollView: element("div"),
    StyleSheet: { create: <T,>(value: T) => value },
    Text: element("span"),
    View: element("div"),
    useWindowDimensions: () => ({ width: 390, height: 844 })
  };
});

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, right: 0, bottom: 34, left: 0 })
}));

vi.mock("react-native-svg", async () => {
  const React = await import("react");
  return { SvgXml: () => React.createElement("span", { "data-testid": "svg" }) };
});

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
});

describe("MobileConnectionStage", () => {
  it("mounts localized stage copy and accessibility actions", () => {
    const onArtworkPress = vi.fn();
    const onIconPress = vi.fn();
    const container = document.createElement("div");
    root = createRoot(container);
    act(() => root!.render(createElement(MobileConnectionStage, {
      artworkId: "group-one/base",
      artworkSource: "<svg />",
      iconSource: "<svg />",
      locale: "ja",
      colors: { brandBackground: "#fff", ink: "#111", muted: "#666" },
      onArtworkPress,
      onIconPress,
      children: createElement("span", null, "form")
    })));

    const artwork = container.querySelector('button[aria-label="Joko のイラストを変更：group-one/base"]');
    const icon = container.querySelector('button[aria-label="次の Joko イラストを表示"]');
    expect(artwork?.getAttribute("title")).toContain("2 つのポーズ");
    expect(icon?.getAttribute("title")).toContain("最初のポーズ");
    expect(container.textContent).toContain("どこにいても、仕事をあなたのそばに。");

    act(() => (artwork as HTMLButtonElement).click());
    act(() => (icon as HTMLButtonElement).click());
    expect(onArtworkPress).toHaveBeenCalledOnce();
    expect(onIconPress).toHaveBeenCalledOnce();
  });
});
