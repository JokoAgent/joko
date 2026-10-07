// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileTaskCloneControls, MobileTaskCloneResult } from "./mobile-client";

const native = vi.hoisted(() => ({ state: "active", listeners: new Set<(state: string) => void>() }));
vi.mock("react-native", () => {
  const box = ({ children }: { children?: ReactNode }) => createElement("div", {}, children);
  return { View: box, ScrollView: box, Text: ({ children }: { children?: ReactNode }) => createElement("span", {}, children),
    TextInput: ({ value, onChangeText, accessibilityLabel, maxLength, editable }: {
      value: string; onChangeText: (value: string) => void; accessibilityLabel: string; maxLength: number; editable: boolean
    }) => createElement("input", { value, "aria-label": accessibilityLabel, maxLength, disabled: !editable,
      onInput: (event) => onChangeText(event.currentTarget.value), onChange: () => undefined }),
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
import { MobileTaskDerivationSheet } from "./MobileTaskDerivationSheet";

const controls: MobileTaskCloneControls = { authorityKey: "revision-one", surfaceOwnerKey: "task-one",
  sourceSessionId: "session-one", sourceName: "Plan", canClone: true };
const colors = { background: "#fff", surface: "#fafafa", ink: "#111", muted: "#666", border: "#ccc", accent: "#ff9800", negative: "#b00", brandBackground: "#fff4df" };
let host: HTMLDivElement;
let root: Root;
const close = vi.fn(); const open = vi.fn(); const error = vi.fn();
const clone = vi.fn<(authorityKey: string, name: string, signal: AbortSignal) => Promise<MobileTaskCloneResult>>();
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  native.state = "active"; close.mockReset(); open.mockReset(); error.mockReset(); clone.mockReset();
  host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); native.listeners.clear();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});
async function render(value = controls, visible = true, locale: "en" | "zh-CN" = "en") {
  await act(async () => root.render(createElement(MobileTaskDerivationSheet, { visible, kind: "clone",
    controls: { ...value, canDerive: value.canClone }, busy: false,
    colors, locale, onClose: close, onOpen: open, onError: error, onSubmit: clone })));
}
function button(label: string) {
  const found = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((node) => node.getAttribute("aria-label") === label);
  expect(found, label).toBeDefined(); return found!;
}
async function click(label: string) { await act(async () => button(label).click()); }

describe("native task derivation confirmation", () => {
  it("uses the current revision once, preserves confirmation during dispatch, and opens only the known new task", async () => {
    let finish!: (result: MobileTaskCloneResult) => void;
    clone.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await render();
    expect(host.querySelector<HTMLInputElement>("input")?.value).toBe("Plan (copy)");
    expect(host.textContent).toContain("Your current draft stays here.");
    await render({ ...controls, authorityKey: "revision-two" });
    await click("Create clone");
    expect(clone).toHaveBeenCalledOnce();
    expect(clone.mock.calls[0]?.slice(0, 2)).toEqual(["revision-two", "Plan (copy)"]);
    expect(button("Creating clone…").disabled).toBe(true);
    await render({ ...controls, authorityKey: "revision-two", canClone: false });
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => finish({ kind: "cloned", sessionId: "child-task" }));
    expect(open).not.toHaveBeenCalled();
    await click("Open cloned task");
    expect(open).toHaveBeenCalledExactlyOnceWith("child-task");
    expect(error).not.toHaveBeenCalled();
  });

  it("prevents retry of an unknown result and retires late feedback on owner and background changes", async () => {
    clone.mockResolvedValueOnce({ kind: "unknown" });
    await render(); await click("Create clone");
    expect(host.textContent).toContain("The result is not confirmed.");
    expect(button("Create clone").disabled).toBe(true);
    await click("Create clone"); expect(clone).toHaveBeenCalledOnce();
    await render(controls, false); await render(controls, true, "zh-CN");
    let finish!: (result: MobileTaskCloneResult) => void;
    clone.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await click("创建副本");
    const signal = clone.mock.calls[1]![2];
    await render({ ...controls, surfaceOwnerKey: "task-two" }, true, "zh-CN");
    expect(signal.aborted).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => finish({ kind: "cloned", sessionId: "late-task" }));
    expect(open).not.toHaveBeenCalled();
    await render(controls, false); await render(controls);
    clone.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await click("Create clone");
    const backgroundSignal = clone.mock.calls[2]![2];
    await act(async () => { native.state = "background"; native.listeners.forEach((listener) => listener("background")); });
    expect(backgroundSignal.aborted).toBe(true);
    await act(async () => finish({ kind: "cloned", sessionId: "background-task" }));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(open).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  });

  it("explains fork input recovery and preserves the created-task entry when draft restoration conflicts", async () => {
    const submit = vi.fn(async (): Promise<MobileTaskCloneResult | import("./mobile-client").MobileMessageForkResult> =>
      ({ kind: "forked", sessionId: "forked-task", draftRestored: false }));
    await act(async () => root.render(createElement(MobileTaskDerivationSheet, { visible: true, kind: "fork",
      controls: { ...controls, canDerive: true, restoreInput: true }, busy: false, colors, locale: "en",
      onClose: close, onOpen: open, onError: error, onSubmit: submit })));
    expect(host.textContent).toContain("Select any historical attachments again");
    expect(host.querySelector<HTMLInputElement>("input")?.value).toBe("Plan (branch)");
    await click("Create branch");
    expect(host.textContent).toContain("The branch was created, but its draft could not be restored.");
    await click("Open new branch");
    expect(open).toHaveBeenCalledExactlyOnceWith("forked-task");
    expect(submit).toHaveBeenCalledOnce();
  });
});
