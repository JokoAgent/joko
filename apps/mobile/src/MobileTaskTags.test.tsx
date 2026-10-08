// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import { create } from "@bufbuild/protobuf";
import { TaskTagColor, TaskTagSchema, type TaskTag } from "@joko/contracts";
import { MobileTaskTagDots, mobileTaskTagName } from "./MobileTaskTags";

vi.mock("react-native", async () => {
  const { createElement: element } = await import("react");
  const primitive = (tag: "div" | "span") => ({ children, accessibilityLabel }: {
    readonly children?: ReactNode;
    readonly accessibilityLabel?: string;
  }) => element(tag, { "aria-label": accessibilityLabel }, children);
  return {
    ActivityIndicator: primitive("span"),
    Alert: { alert: vi.fn() },
    Modal: ({ visible, children }: { readonly visible: boolean; readonly children?: ReactNode }) => visible ? element("div", {}, children) : null,
    Pressable: primitive("div"),
    ScrollView: primitive("div"),
    Text: primitive("span"),
    TextInput: primitive("span"),
    View: primitive("div"),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
  };
});
vi.mock("react-native-safe-area-context", async () => {
  const { createElement: element } = await import("react");
  return { SafeAreaView: ({ children }: { readonly children?: ReactNode }) => element("div", {}, children) };
});

afterEach(() => {
  document.body.replaceChildren();
});

it("localizes untouched presets and keeps all mobile task dots visible", () => {
  const work = tag("preset:work", "Work", TaskTagColor.INDIGO, "work", false);
  expect(mobileTaskTagName(work, "zh-CN")).toBe("工作");
  expect(mobileTaskTagName({ ...work, name: "Focus", nameCustomized: true }, "zh-CN")).toBe("Focus");

  const tags = Array.from({ length: 8 }, (_, index) => tag(`tag-${index}`, `Tag ${index}`, TaskTagColor.BLUE));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(createElement(MobileTaskTagDots, { tags, locale: "en" })));
  try {
    const group = host.querySelector<HTMLElement>('[aria-label="Tag 0, Tag 1, Tag 2, Tag 3, Tag 4, Tag 5, Tag 6, Tag 7"]');
    expect(group).not.toBeNull();
    expect(group?.children).toHaveLength(8);
    expect(group?.textContent).toBe("");
  } finally {
    act(() => root.unmount());
  }
});

function tag(
  taskTagId: string,
  name: string,
  color: TaskTagColor,
  presetKey?: string,
  nameCustomized = true
): TaskTag {
  return create(TaskTagSchema, {
    taskTagId,
    name,
    color,
    ...(presetKey === undefined ? {} : { presetKey }),
    nameCustomized,
    sortOrder: 0,
    revision: { value: 1n },
    associationRevision: { value: 0n },
    createdAt: { seconds: 0n },
    updatedAt: { seconds: 0n }
  });
}
