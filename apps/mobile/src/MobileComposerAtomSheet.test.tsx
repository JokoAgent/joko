// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileComposerAtomSheet } from "./MobileComposerAtomSheet";

vi.mock("react-native", async () => {
  const { createElement: element } = await import("react");
  const primitive = (tag: "div" | "span") => ({ accessibilityLabel, children }: {
    readonly accessibilityLabel?: string;
    readonly children?: ReactNode;
  }) => element(tag, accessibilityLabel === undefined ? {} : { "aria-label": accessibilityLabel }, children);
  return {
    Modal: ({ visible, children }: { readonly visible: boolean; readonly children?: ReactNode }) =>
      visible ? element("div", { "data-modal": "true" }, children) : null,
    Pressable: ({ accessibilityLabel, onPress, children }: {
      readonly accessibilityLabel?: string;
      readonly onPress?: () => void;
      readonly children?: ReactNode;
    }) => element("button", { "aria-label": accessibilityLabel, onClick: onPress }, children),
    ScrollView: primitive("div"),
    StyleSheet: { absoluteFill: {}, hairlineWidth: 1, create: (styles: unknown) => styles },
    Text: primitive("span"),
    TextInput: ({ accessibilityLabel, value }: { readonly accessibilityLabel?: string; readonly value?: string }) =>
      element("textarea", { "aria-label": accessibilityLabel, value, readOnly: true }),
    View: primitive("div")
  };
});

vi.mock("react-native-safe-area-context", async () => {
  const { createElement: element } = await import("react");
  return {
    SafeAreaView: ({ accessibilityViewIsModal, children }: {
      readonly accessibilityViewIsModal?: boolean;
      readonly children?: ReactNode;
    }) => element("div", { "aria-modal": accessibilityViewIsModal }, children)
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

describe("MobileComposerAtomSheet", () => {
  it("presents a task/message link as read-only accessible details with whole-atom removal", () => {
    const onRemove = vi.fn();
    container = document.createElement("div");
    root = createRoot(container);
    act(() => root!.render(createElement(MobileComposerAtomSheet, {
      atom: {
        kind: "route-reference",
        routeKind: "session",
        atomId: "route-one",
        href: "#/tasks/session?message=message",
        serialized: "#/tasks/session?message=message",
        sessionId: "session",
        messageId: "message",
        displayText: "Resolved message",
        start: 0,
        end: 32
      },
      colors,
      busy: false,
      onClose: vi.fn(),
      onSavePaste: vi.fn(),
      onRemove
    })));

    expect(container.querySelector('[aria-label="Task link details"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Task link label"]')?.textContent).toBe("Resolved message");
    expect(container.querySelector('[aria-label="Task link address"]')?.textContent)
      .toBe("#/tasks/session?message=message");
    expect(container.querySelector('[aria-label="Pasted text"]')).toBeNull();
    expect(container.querySelector('[aria-label="Save pasted text changes"]')).toBeNull();

    act(() => container!.querySelector('button[aria-label="Remove Resolved message"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onRemove).toHaveBeenCalledWith("route-one");
  });

  it("labels a project link independently from task authority", () => {
    container = document.createElement("div");
    root = createRoot(container);
    act(() => root!.render(createElement(MobileComposerAtomSheet, {
      atom: {
        kind: "route-reference",
        routeKind: "project",
        atomId: "project-one",
        href: "#/projects/project-one",
        serialized: "[Mobile](#/projects/project-one)",
        projectId: "project-one",
        displayText: "Mobile",
        start: 0,
        end: 39
      },
      colors,
      busy: false,
      onClose: vi.fn(),
      onSavePaste: vi.fn(),
      onRemove: vi.fn()
    })));

    expect(container.querySelector('[aria-label="Project link details"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Project link label"]')?.textContent).toBe("Mobile");
    expect(container.querySelector('[aria-label="Project link address"]')?.textContent)
      .toBe("#/projects/project-one");
    expect(container.textContent).toContain("Project link · project project-one");
  });
});
