// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileToolCallView } from "./mobile-tool-call";

const native = vi.hoisted(() => ({
  copy: vi.fn<(value: string) => Promise<boolean>>(),
  listeners: new Set<(state: string) => void>(),
  fileScan: vi.fn(), payloadScan: vi.fn()
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: native.copy }));
vi.mock("@joko/contracts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@joko/contracts")>();
  return { ...actual,
    parseToolFileChangeSet: (...args: Parameters<typeof actual.parseToolFileChangeSet>) => { native.fileScan(); return actual.parseToolFileChangeSet(...args); },
    toolPayloadDiffFiles: (...args: Parameters<typeof actual.toolPayloadDiffFiles>) => { native.payloadScan(); return actual.toolPayloadDiffFiles(...args); }
  };
});
vi.mock("react-native", () => {
  const box = ({ children, accessibilityLabel }: { children?: ReactNode; accessibilityLabel?: string }) => createElement("div", { "aria-label": accessibilityLabel }, children);
  return { View: box, ScrollView: box, Text: ({ children, accessibilityLiveRegion }: { children?: ReactNode; accessibilityLiveRegion?: string }) =>
    createElement("span", { "aria-live": accessibilityLiveRegion }, children),
    Modal: ({ children, visible }: { children?: ReactNode; visible: boolean }) => visible ? createElement("div", { role: "dialog" }, children) : null,
    Pressable: ({ children, onPress, accessibilityLabel, accessibilityState, disabled }: { children?: ReactNode; onPress?: () => void;
      accessibilityLabel?: string; accessibilityState?: { expanded?: boolean; selected?: boolean }; disabled?: boolean }) =>
      createElement("button", { onClick: onPress, "aria-label": accessibilityLabel, disabled,
        "aria-expanded": accessibilityState?.expanded, "aria-pressed": accessibilityState?.selected }, children),
    StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
    AppState: { currentState: "active", addEventListener: (_event: string, listener: (state: string) => void) => {
      native.listeners.add(listener); return { remove: () => native.listeners.delete(listener) };
    } }
  };
});
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: ({ children }: { children?: ReactNode }) => createElement("div", {}, children) }));
import { MobileToolCallCard } from "./MobileToolCallCard";

let host: HTMLDivElement;
let root: Root;
const colors = { background: "#fff", surface: "#fafafa", ink: "#111", muted: "#666", border: "#ccc", accent: "#ff9800", negative: "#b00", brandBackground: "#fff4df" };
const call: MobileToolCallView = { scopeKey: "owned-call", name: "file_change", state: "succeeded", inputRedacted: false,
  inputTruncated: false, outputTruncated: false, error: "", output: "Applied both file changes.", input: '$: ' + JSON.stringify({ changes: [
    { path: "src/a.ts", kind: { type: "update" }, diff: "-old\n+new" },
    { path: "src/old.ts", kind: { type: "update", movePath: "src/new.ts" }, diff: "rename only" }
  ] }) };
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  native.copy.mockReset().mockResolvedValue(true); native.fileScan.mockClear(); native.payloadScan.mockClear();
  host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); document.body.replaceChildren(); native.listeners.clear();
  vi.useRealTimers();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});
async function render(ownerKey = "task-one", locale: "en" | "zh-CN" = "en", value = call) {
  await act(async () => root.render(createElement(MobileToolCallCard, { call: value, ownerKey, enabled: true, colors, locale })));
}
async function click(label: string) {
  const button = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((node) => node.getAttribute("aria-label") === label);
  expect(button, label).toBeDefined(); await act(async () => button!.click());
}

describe("native tool details", () => {
  it("keeps folded rows cheap and opens raw/input/result/multi-file move details with exact clipboard feedback", async () => {
    await render();
    expect(native.fileScan).not.toHaveBeenCalled(); expect(native.payloadScan).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("rename only");
    await click("Expand File changes");
    expect(native.fileScan).not.toHaveBeenCalled();
    await click("View input");
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    expect(native.fileScan).toHaveBeenCalledOnce();
    await click("src/old.ts → src/new.ts");
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain("rename only");
    await click("Copy original text");
    expect(native.copy).toHaveBeenCalledExactlyOnceWith("rename only");
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain("Copied");
    await click("Original text");
    await render("task-one", "zh-CN");
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain(call.input);
    await render();
    await click("Output");
    native.copy.mockResolvedValueOnce(false);
    await click("Copy original text");
    expect(native.copy).toHaveBeenLastCalledWith(call.output);
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain("The text could not be copied.");
    await click("Close");
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it("retires the viewer on owner/background changes and ignores late clipboard feedback while preserving its in-flight fence", async () => {
    vi.useFakeTimers();
    let resolveCopy!: (value: boolean) => void;
    native.copy.mockImplementationOnce(() => new Promise((resolve) => { resolveCopy = resolve; }));
    await render(); await click("Expand File changes"); await click("View result"); await click("Copy original text");
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain("The copy result could not be confirmed.");
    await render("task-two");
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    await click("Expand File changes"); await click("View result");
    expect(Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((node) => node.textContent === "Copying…")?.disabled).toBe(true);
    await act(async () => resolveCopy(true));
    expect(host.querySelector('[role="dialog"]')?.textContent).not.toContain("Copied");
    await act(async () => native.listeners.forEach((listener) => listener("background")));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => native.listeners.forEach((listener) => listener("active")));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector('[aria-expanded="false"]')).not.toBeNull();
  });
});
