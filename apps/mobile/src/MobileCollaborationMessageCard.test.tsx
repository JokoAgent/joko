// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mobileExpandedBlockStore } from "./mobile-expanded-block-memory";
import type { MobileSupportedLocale } from "./mobile-locale-preference";

const native = vi.hoisted(() => ({ state: "active", listeners: new Set<(state: string) => void>() }));
vi.mock("react-native", () => {
  const flatten = (style: unknown): Record<string, unknown> => Array.isArray(style) ? Object.assign({}, ...style.map(flatten))
    : style && typeof style === "object" ? style as Record<string, unknown> : {};
  const box = ({ children, style, selectable }: { children?: ReactNode; style?: unknown; selectable?: boolean }) =>
    createElement("div", { style: flatten(style), "data-selectable": selectable }, children);
  return { View: box, Text: box, ActivityIndicator: () => createElement("span", { role: "progressbar" }),
    Pressable: ({ children, onPress, accessibilityLabel, accessibilityState, disabled, style }: {
      children?: ReactNode; onPress?: () => void; accessibilityLabel?: string; accessibilityState?: { expanded?: boolean }; disabled?: boolean; style?: unknown;
    }) => createElement("button", { onClick: onPress, "aria-label": accessibilityLabel, "aria-expanded": accessibilityState?.expanded, disabled, style: flatten(style) }, children),
    StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
    AppState: { get currentState() { return native.state; }, addEventListener: (_event: string, listener: (state: string) => void) => {
      native.listeners.add(listener); return { remove: () => native.listeners.delete(listener) };
    } }
  };
});
import { MobileCollaborationMessageCard, type MobileCollaborationMessageCardProps } from "./MobileCollaborationMessageCard";

const colors = { background: "#fff", surface: "#fafafa", ink: "#111", muted: "#666", border: "#ccc", accent: "#ff9800", negative: "#b00", brandBackground: "#fff4df" };
const dispatch = { variant: "dispatch" as const, action: "create" as const, label: "Developer", body: "Implement the task\nKeep the evidence", state: "running" as const };
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); native.state = "active";
  host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); native.listeners.clear(); mobileExpandedBlockStore.reset(); Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT"); });
function render(patch: Partial<MobileCollaborationMessageCardProps> = {}, key = "card"): void {
  act(() => root.render(createElement(MobileCollaborationMessageCard, { message: dispatch, ownerKey: "original", blockKey: "dispatch", colors, locale: "en",
    enabled: true, canOpen: true, ...patch, key })));
}
function button(label: string): HTMLButtonElement {
  const element = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`); expect(element).not.toBeNull(); return element!;
}
function press(label: string): void { act(() => button(label).click()); }

it("keeps collaboration bodies folded by default, selectable when expanded and remembered only within their owner", () => {
  render(); expect(host.textContent).not.toContain(dispatch.body); expect(host.querySelector('[role="progressbar"]')).not.toBeNull();
  expect(button("Expand Assign work to Developer").style.minHeight).toBe("44px");
  press("Expand Assign work to Developer"); expect(host.textContent).toContain(dispatch.body); expect(host.querySelector('[data-selectable="true"]')).not.toBeNull();
  render({ message: { ...dispatch, state: "succeeded" } }, "remount"); expect(button("Collapse Assign work to Developer")).not.toBeNull();
  expect(host.textContent).toContain("Completed"); expect(host.querySelector('[role="progressbar"]')).toBeNull();
  render({ ownerKey: "other" }); expect(button("Expand Assign work to Developer").getAttribute("aria-expanded")).toBe("false");
  render({ message: { ...dispatch, body: "", state: "failed", error: "Worker could not start" } });
  expect(host.querySelector("button")).toBeNull(); expect(host.textContent).toContain("Failed"); expect(host.textContent).toContain("Worker could not start");
});

it.each(["en", "zh-CN", "zh-TW", "ja", "ko"] as MobileSupportedLocale[])("localizes report and batch headings in %s without altering user text", locale => {
  render({ locale, message: { ...dispatch, action: "batch", count: 2, label: "" } });
  const toggle = host.querySelector("button")!; expect(toggle.getAttribute("aria-label")).not.toContain("{count}");
  act(() => toggle.click()); expect(host.textContent).toContain(dispatch.body);
  render({ locale, message: { variant: "report", action: "report", label: "Reviewer", body: "Evidence from worker" } }, "report");
  expect(host.querySelector("button")?.getAttribute("aria-label")).not.toContain("{name}");
});

it("keeps report navigation single-flight, shows a retryable failure and retires requests in background", async () => {
  const origin = { $typeName: "joko.v1.CollaborationReportOrigin" as const, goalId: "goal", workerId: "worker", leadSessionId: "lead", workerSessionId: "worker-task", workerLabel: "Reviewer", body: "Evidence" };
  let reject: (error: Error) => void = () => {}, request: AbortSignal | undefined;
  const onOpen = vi.fn((_origin, signal: AbortSignal) => { request = signal; return new Promise<void>((_resolve, fail) => { reject = fail; }); });
  const message = { variant: "report" as const, action: "report" as const, label: "Reviewer", body: "Evidence", origin };
  render({ message, onOpen }); press("From worker Reviewer"); press("From worker Reviewer"); expect(onOpen).toHaveBeenCalledOnce();
  await act(async () => reject(new Error("Unavailable"))); expect(host.textContent).toContain("Could not open the reporting task");
  press("From worker Reviewer"); expect(onOpen).toHaveBeenCalledTimes(2);
  act(() => { native.state = "background"; for (const listener of native.listeners) listener("background"); }); expect(request?.aborted).toBe(true);
  await act(async () => reject(new Error("Late failure"))); expect(host.textContent).not.toContain("Could not open the reporting task");
  expect(button("From worker Reviewer").disabled).toBe(true);
});
