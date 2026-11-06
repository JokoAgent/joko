// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { Alert } from "react-native";

import { create } from "@bufbuild/protobuf";
import { RevisionSchema, SessionSchema, TaskTagCatalogSchema, TaskTagColor, TaskTagDeletePreviewSchema, TaskTagSchema, type TaskTag } from "@joko/contracts";
import { MobileTaskTagDots, MobileTaskTagsSheet, mobileTaskTagName } from "./MobileTaskTags";
import type { MobileTaskTagsNativeProps } from "./MobileTaskTagsNative";
import type { MobileClient } from "./mobile-client";
import { mobileMessage } from "./mobile-messages";

vi.mock("react-native", async () => {
  const { createElement: element } = await import("react");
  const primitive = (tag: "div" | "span") => ({ children, accessibilityLabel }: {
    readonly children?: ReactNode;
    readonly accessibilityLabel?: string;
  }) => element(tag, { "aria-label": accessibilityLabel }, children);
  return {
    ActivityIndicator: primitive("span"),
    Alert: { alert: vi.fn() },
    AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
    Modal: ({ visible, children }: { readonly visible: boolean; readonly children?: ReactNode }) => visible ? element("div", {}, children) : null,
    Pressable: primitive("div"),
    ScrollView: primitive("div"),
    Text: primitive("span"),
    TextInput: primitive("span"),
    View: primitive("div"),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
  };
});
vi.mock("./MobileTaskTagsNative", async () => {
  const { createElement: element } = await import("react");
  return { mobileTaskTagsNativeAvailable: true, MobileTaskTagsNative: ({ visible, items, edit, onDelete, error }: MobileTaskTagsNativeProps) =>
    visible ? element("div", {}, edit ? element("div", {},
      element("button", { onClick: onDelete }, "Delete tag"),
      element("input", { value: edit.name, "aria-label": "Tag name", onInput: (event: { currentTarget: HTMLInputElement }) => edit.onName(event.currentTarget.value) }),
      element("button", { onClick: () => edit.onColor(TaskTagColor.ORANGE), "aria-label": "Choose orange" }, "Choose orange"),
      element("button", { disabled: !edit.canSave, onClick: edit.onSave, "aria-label": "Save tag" }, "Save tag"),
      error && element("span", { role: "alert" }, error))
      : items.map(item => element("button", { key: item.id, onClick: item.onEdit }, item.name))) : null };
});
vi.mock("react-native-safe-area-context", async () => {
  const { createElement: element } = await import("react");
  return { SafeAreaView: ({ children }: { readonly children?: ReactNode }) => element("div", {}, children) };
});

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
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

it.each([
  { fromHome: true, retired: false, elapsed: 0 },
  { fromHome: true, retired: true, elapsed: 0 },
  { fromHome: false, retired: false, elapsed: 61_000 }
])("uses the original tag deletion source fromHome=$fromHome, retired=$retired, elapsed=$elapsed ms", async ({ fromHome, retired, elapsed }) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let owner = "task-owner";
  const preview = create(TaskTagDeletePreviewSchema, { taskTagId: "release", affectedSessionCount: 2n,
    tagRevision: { value: 4n }, associationRevision: { value: 2n } });
  const previewTaskTagDeletion = vi.fn(async () => preview), deleteTaskTag = vi.fn(async () => true);
  const client = { state: { status: "connected", selectedId: fromHome ? undefined : "task" }, homeTaskTagSourceKey: () => owner,
    taskHeaderSourceKey: () => owner, previewTaskTagDeletion, deleteTaskTag } as unknown as MobileClient;
  const session = create(SessionSchema, { sessionId: "task", displayName: "Task" });
  const catalog = create(TaskTagCatalogSchema, { taskTags: [tag("release", "Release", TaskTagColor.TEAL)] });
  const colors = { background: "white", surface: "white", ink: "black", muted: "gray", border: "gray", accent: "blue", brandBackground: "white", negative: "red" };
  const host = document.body.appendChild(document.createElement("div")), root = createRoot(host);
  try {
    await act(async () => root.render(createElement(MobileTaskTagsSheet, { visible: true, fromHome, session, catalog, client, colors, locale: "en", onClose() {} })));
    await act(async () => host.querySelector("button")!.click());
    await act(async () => host.querySelector("button")!.click());
    expect(previewTaskTagDeletion).toHaveBeenCalledExactlyOnceWith("release");
    const confirm = vi.mocked(Alert.alert).mock.calls[0]?.[2]?.find(button => button.style === "destructive")?.onPress;
    expect(confirm).toBeDefined();
    if (retired) owner = "replacement-task-owner";
    const time = vi.spyOn(Date, "now").mockReturnValue(Date.now() + elapsed);
    try { await act(async () => confirm!()); }
    finally { time.mockRestore(); }
    if (retired) expect(deleteTaskTag).not.toHaveBeenCalled();
    else expect(deleteTaskTag).toHaveBeenCalledExactlyOnceWith("task", preview);
  } finally { await act(async () => root.unmount()); }
});

it.each([true, false])("keeps the name draft through a same-owner catalog update with a color change=%s", async colorChanged => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const original = tag("release", "Release", TaskTagColor.TEAL);
  const updateTaskTag = vi.fn(async () => !colorChanged);
  const client = { state: { status: "connected", selectedId: "session" }, taskHeaderSourceKey: () => "task-owner",
    updateTaskTag } as unknown as MobileClient;
  const session = create(SessionSchema, { sessionId: "session", displayName: "Task" });
  const colors = { background: "white", surface: "white", ink: "black", muted: "gray", border: "gray", accent: "blue", brandBackground: "white", negative: "red" };
  const host = document.body.appendChild(document.createElement("div")), root = createRoot(host);
  const render = (taskTag: TaskTag) => root.render(createElement(MobileTaskTagsSheet, { visible: true, session,
    catalog: create(TaskTagCatalogSchema, { taskTags: [taskTag] }), client, colors, locale: "en", onClose() {} }));
  try {
    await act(async () => render(original));
    await act(async () => host.querySelector("button")!.click());
    const input = host.querySelector("input")!;
    await act(async () => {
      input.value = "Launch";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => render(create(TaskTagSchema, { ...original, revision: create(RevisionSchema, { value: 2n }), sortOrder: 1,
      color: colorChanged ? TaskTagColor.ORANGE : original.color })));
    expect(host.querySelector("input")?.value).toBe("Launch");
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Save tag"]')!.click());
    expect(updateTaskTag).toHaveBeenCalledExactlyOnceWith("session", "release", colorChanged ? 1n : 2n, { name: "Launch" });
    if (colorChanged) {
      expect(host.querySelector("input")?.value).toBe("Launch");
      expect(host.querySelector('[role="alert"]')?.textContent).toBe(mobileMessage("en", "taskTags.changeFailed"));
    } else {
      expect(host.querySelector("input")).toBeNull();
    }
  } finally { await act(async () => root.unmount()); }
});

it("edits a preset using its displayed name and sends only the changed color", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const updateTaskTag = vi.fn(async () => true);
  const client = { state: { status: "connected", selectedId: "session" }, taskHeaderSourceKey: () => "task-owner",
    updateTaskTag } as unknown as MobileClient;
  const session = create(SessionSchema, { sessionId: "session", displayName: "Task" });
  const catalog = create(TaskTagCatalogSchema, { taskTags: [tag("preset:work", "Work", TaskTagColor.INDIGO, "work", false)] });
  const colors = { background: "white", surface: "white", ink: "black", muted: "gray", border: "gray", accent: "blue", brandBackground: "white", negative: "red" };
  const host = document.body.appendChild(document.createElement("div")), root = createRoot(host);
  try {
    await act(async () => root.render(createElement(MobileTaskTagsSheet, { visible: true, session, catalog, client, colors, locale: "zh-CN", onClose() {} })));
    await act(async () => host.querySelector("button")!.click());
    expect(host.querySelector("input")?.value).toBe("工作");
    const save = host.querySelector<HTMLButtonElement>('[aria-label="Save tag"]')!;
    expect(save.disabled).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Choose orange"]')!.click());
    await act(async () => save.click());
    expect(updateTaskTag).toHaveBeenCalledExactlyOnceWith("session", "preset:work", 1n, { color: TaskTagColor.ORANGE });
  } finally { await act(async () => root.unmount()); }
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
