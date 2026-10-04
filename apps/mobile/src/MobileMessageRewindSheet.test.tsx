// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { FileChangeKind, RewindSafety, WorkspaceRewindPreviewSchema } from "@joko/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { plainTextMobileComposerDraft } from "./mobile-composer-document";
import { mobileMessage } from "./mobile-messages";
import type { MobileMessageRewindControls, MobileMessageRewindPreview, MobileMessageRewindResult } from "./mobile-message-rewind";

const native = vi.hoisted(() => ({ state: "active", listeners: new Set<(state: string) => void>() }));
vi.mock("react-native", () => {
  const box = ({ children }: { children?: ReactNode }) => createElement("div", {}, children);
  return { View: box, ScrollView: box, Text: ({ children }: { children?: ReactNode }) => createElement("span", {}, children),
    Modal: ({ children, visible }: { children?: ReactNode; visible: boolean }) => visible ? createElement("div", { role: "dialog" }, children) : null,
    Pressable: ({ children, onPress, accessibilityLabel, disabled }: {
      children?: ReactNode; onPress?: () => void; accessibilityLabel?: string; disabled?: boolean
    }) => createElement("button", { onClick: onPress, "aria-label": accessibilityLabel, disabled }, children),
    StyleSheet: { create: (value: unknown) => value },
    AppState: { get currentState() { return native.state; }, addEventListener: (_event: string, listener: (state: string) => void) => {
      native.listeners.add(listener); return { remove: () => native.listeners.delete(listener) };
    } }
  };
});
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: ({ children }: { children?: ReactNode }) => createElement("div", {}, children) }));
import { MobileMessageRewindSheet } from "./MobileMessageRewindSheet";

const controls: MobileMessageRewindControls = { authorityKey: "revision", surfaceOwnerKey: "task-one", sessionId: "task",
  source: { eventId: "event", messageId: "message", sourceKey: "source", draft: plainTextMobileComposerDraft("Original input") },
  canDialogue: true, canFiles: true, canRewind: true };
const files = () => create(WorkspaceRewindPreviewSchema, { previewId: "preview", workspaceId: "workspace", changeSetId: "checkpoint",
  safety: RewindSafety.REQUIRES_CONFIRMATION, expiresAt: { seconds: BigInt(Math.floor(Date.now() / 1000) + 600) },
  inverseChanges: [{ relativePath: "src/file.ts", kind: FileChangeKind.UPDATED }], gaps: [{ relativePath: "image.png", explanation: "Missing baseline" }] });
const colors = { background: "#fff", surface: "#fafafa", ink: "#111", muted: "#666", border: "#ccc", accent: "#ff9800", negative: "#b00", brandBackground: "#fff4df" };
let host: HTMLDivElement; let root: Root;
const close = vi.fn(); const error = vi.fn(); const check = vi.fn<() => Promise<boolean>>();
const load = vi.fn<(key: string, eventId: string, signal: AbortSignal) => Promise<MobileMessageRewindPreview | undefined>>();
const commit = vi.fn<(preview: MobileMessageRewindPreview, mode: "dialogue" | "files", signal: AbortSignal) => Promise<MobileMessageRewindResult>>();
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); native.state = "active";
  close.mockReset(); error.mockReset(); check.mockReset(); load.mockReset(); commit.mockReset();
  load.mockResolvedValue({ controls, files: files() });
  host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); native.listeners.clear();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});
async function render(value = controls, visible = true, busy = false, locale: "en" | "zh-CN" = "en") {
  await act(async () => root.render(createElement(MobileMessageRewindSheet, { visible, controls: value, busy, colors, locale,
    onClose: close, onError: error, onLoad: load, onCommit: commit, onCheckOperation: check })));
}
function button(label: string) {
  const node = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((value) => value.getAttribute("aria-label") === label);
  expect(node, label).toBeDefined(); return node!;
}
async function click(label: string) { await act(async () => button(label).click()); }

describe("native message rewind preview and confirmation", () => {
  it("shows exact changes and gaps, dispatches the selected mode once, and keeps unknown results read-only until operation reconciliation", async () => {
    let finish!: (result: MobileMessageRewindResult) => void;
    commit.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await render(); expect(load).toHaveBeenCalledExactlyOnceWith("revision", "event", expect.any(AbortSignal));
    expect(host.textContent).toContain("src/file.ts"); expect(host.textContent).toContain("Missing baseline");
    await click("Restore files only"); await click("Restore files only");
    expect(commit).toHaveBeenCalledOnce(); expect(commit.mock.calls[0]![1]).toBe("files");
    await render({ ...controls, canDialogue: false, canFiles: false, canRewind: false }, true, true);
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => finish({ kind: "unknown" }));
    await render({ ...controls, canRewind: false });
    expect(host.textContent).toContain("The result is not confirmed."); expect(button("Rewind dialogue only").disabled).toBe(true);
    check.mockResolvedValueOnce(true); await click(mobileMessage("en", "receipt.check"));
    expect(check).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce(); expect(error).not.toHaveBeenCalled();
  });

  it("keeps dialogue-only confirmation available when files are blocked or absent and explains failed preview recovery", async () => {
    const blocked = files(); blocked.safety = RewindSafety.BLOCKED; blocked.conflicts = [{ $typeName: "joko.v1.WorkspaceConflict", relativePath: "src/file.ts", explanation: "External edit" }];
    load.mockResolvedValueOnce({ controls, files: blocked }); commit.mockResolvedValueOnce({ kind: "rewound", mode: "dialogue" });
    await render(); expect(host.textContent).toContain("External edit"); expect(button("Restore files only").disabled).toBe(true);
    await click("Rewind dialogue only"); expect(commit.mock.calls[0]![1]).toBe("dialogue"); expect(close).toHaveBeenCalledOnce();
    await render(controls, false); load.mockResolvedValueOnce({ controls, fileError: true }); await render(controls, true, false, "zh-CN");
    expect(host.textContent).toContain("无法读取文件预览"); expect(button("仅恢复文件").disabled).toBe(true);
    expect(button("仅回退对话").disabled).toBe(false); expect(button("刷新")).toBeDefined();
  });

  it("aborts previews on owner retirement and background, discarding old completions after a new sheet opens", async () => {
    let finish!: (result: MobileMessageRewindPreview) => void;
    load.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await render(); const signal = load.mock.calls[0]![2];
    await render({ ...controls, surfaceOwnerKey: "task-two" }); expect(signal.aborted).toBe(true);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    await render(controls, false); await render();
    await act(async () => finish({ controls, fileError: true }));
    expect(host.textContent).not.toContain("The file preview could not be loaded.");
    await act(async () => { native.state = "background"; native.listeners.forEach((listener) => listener("background")); });
    expect(host.querySelector('[role="dialog"]')).toBeNull(); expect(commit).not.toHaveBeenCalled();
  });
});
