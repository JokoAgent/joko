// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RuntimeCommandSource } from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileCommandHelpSheet } from "./MobileCommandHelpSheet";

vi.mock("react-native", async () => {
  const { createElement: element } = await import("react");
  const primitive = (tag: "div" | "span") => ({
    accessibilityLabel,
    accessibilityRole,
    accessibilityViewIsModal,
    children
  }: {
    readonly accessibilityLabel?: string;
    readonly accessibilityRole?: string;
    readonly accessibilityViewIsModal?: boolean;
    readonly children?: ReactNode;
  }) => element(tag, {
    ...(accessibilityLabel === undefined ? {} : { "aria-label": accessibilityLabel }),
    ...(accessibilityRole === undefined ? {} : { role: accessibilityRole }),
    ...(accessibilityViewIsModal === undefined ? {} : { "aria-modal": accessibilityViewIsModal })
  }, children);
  return {
    Modal: ({ visible, onRequestClose, children }: {
      readonly visible: boolean;
      readonly onRequestClose: () => void;
      readonly children?: ReactNode;
    }) => visible ? element("div", { "data-modal": "true", onDoubleClick: onRequestClose }, children) : null,
    Pressable: ({ accessibilityLabel, onPress, children }: {
      readonly accessibilityLabel?: string;
      readonly onPress?: () => void;
      readonly children?: ReactNode;
    }) => element("button", { "aria-label": accessibilityLabel, onClick: onPress }, children),
    ScrollView: primitive("div"),
    StyleSheet: { create: (styles: unknown) => styles },
    Text: primitive("span"),
    View: primitive("div")
  };
});

vi.mock("react-native-safe-area-context", async () => {
  const { createElement: element } = await import("react");
  return {
    SafeAreaView: ({ accessibilityLabel, accessibilityViewIsModal, children }: {
      readonly accessibilityLabel?: string;
      readonly accessibilityViewIsModal?: boolean;
      readonly children?: ReactNode;
    }) => element("div", {
      "aria-label": accessibilityLabel,
      "aria-modal": accessibilityViewIsModal
    }, children)
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

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container = undefined;
});

describe("MobileCommandHelpSheet", () => {
  it("presents the frozen app and runtime command catalog with an accessible close path", () => {
    const onClose = vi.fn();
    container = document.createElement("div");
    root = createRoot(container);
    act(() => root!.render(createElement(MobileCommandHelpSheet, {
      locale: "en",
      visible: true,
      items: [
        {
          commandId: "builtin:help",
          name: "help",
          appCommand: "help",
          description: "Show every available command and skill"
        },
        {
          commandId: "skill-review",
          name: "skill:review",
          description: "",
          source: RuntimeCommandSource.SKILL,
          resourceId: "review-skill"
        }
      ],
      colors,
      onClose
    })));

    expect(container.querySelector('[aria-label="Available commands"]')?.getAttribute("aria-modal")).toBe("true");
    expect(container.querySelectorAll('[role="summary"]')).toHaveLength(2);
    expect(container.textContent).toContain("/help");
    expect(container.textContent).toContain("Joko");
    expect(container.textContent).toContain("/skill:review");
    expect(container.textContent).toContain("Skill");

    act(() => container!.querySelector('button[aria-label="Close command help"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    act(() => container!.querySelector('[data-modal="true"]')
      ?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("rerenders a mounted sheet in the newly selected locale without translating runtime data", () => {
    const onClose = vi.fn();
    const items = [{
      commandId: "skill-review",
      name: "skill:review",
      description: "Review the active change",
      source: RuntimeCommandSource.SKILL,
      resourceId: "review-skill"
    }];
    container = document.createElement("div");
    root = createRoot(container);
    act(() => root!.render(createElement(MobileCommandHelpSheet, {
      locale: "en", visible: true, items, colors, onClose
    })));
    expect(container.querySelector('[aria-label="Available commands"]')).not.toBeNull();

    act(() => root!.render(createElement(MobileCommandHelpSheet, {
      locale: "ja", visible: true, items, colors, onClose
    })));
    expect(container.querySelector('[aria-label="利用可能なコマンド"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="コマンドヘルプを閉じる"]')).not.toBeNull();
    expect(container.textContent).toContain("スキル");
    expect(container.textContent).toContain("Review the active change");
  });
});
