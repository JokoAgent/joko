// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileOfflineNotice } from "./MobileOfflineNotice";

vi.mock("react-native", async () => {
  const React = await import("react");
  return {
    StyleSheet: { create: <T,>(value: T) => value },
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) => React.createElement("span", props, props.children),
    View: ({ accessibilityRole, accessibilityLiveRegion, ...props }: Record<string, unknown> & {
      children?: React.ReactNode;
      accessibilityRole?: string;
      accessibilityLiveRegion?: string;
    }) => React.createElement("div", {
      ...props,
      ...(accessibilityRole ? { role: accessibilityRole } : {}),
      ...(accessibilityLiveRegion ? { "aria-live": accessibilityLiveRegion } : {})
    }, props.children)
  };
});

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
});

describe("MobileOfflineNotice", () => {
  it("announces the saved age and read-only recovery state", () => {
    const container = document.createElement("div");
    root = createRoot(container);
    act(() => root!.render(createElement(MobileOfflineNotice, {
      cachedAt: 10_000,
      now: 130_000,
      locale: "en",
      colors: { surface: "#fff", border: "#ddd", muted: "#555", negative: "#a00" }
    })));

    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();
    expect(container.textContent).toContain("Saved offline 2 min ago");
    expect(container.textContent).toContain("read-only until Joko reconnects");
  });
});
