// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ measure: undefined as undefined | ((event: { nativeEvent: { lines: unknown[] } }) => void) }));
vi.mock("react-native", () => ({
  StyleSheet: { create: (value: unknown) => value },
  View: ({ children, accessibilityElementsHidden, pointerEvents, importantForAccessibility }: {
    children?: ReactNode; accessibilityElementsHidden?: boolean; pointerEvents?: string; importantForAccessibility?: string;
  }) => createElement("div", { "aria-hidden": accessibilityElementsHidden, "data-pointer": pointerEvents,
    "data-accessibility": importantForAccessibility }, children),
  Text: ({ children, testID, numberOfLines, onTextLayout, selectable, accessibilityRole, accessibilityLabel,
    accessibilityState, onPress }: { children?: ReactNode; testID?: string; numberOfLines?: number;
    onTextLayout?: typeof native.measure; selectable?: boolean; accessibilityRole?: string; accessibilityLabel?: string;
    accessibilityState?: { expanded?: boolean }; onPress?: () => void }) => {
    if (onTextLayout) native.measure = onTextLayout;
    return createElement("span", { "data-testid": testID, "data-lines": numberOfLines, "data-selectable": selectable,
      role: accessibilityRole, "aria-label": accessibilityLabel, "aria-expanded": accessibilityState?.expanded, onClick: onPress }, children);
  }
}));
import { MobileUserMessageContent, type MobileUserMessageContentProps } from "./MobileUserMessageContent";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.body.appendChild(document.createElement("div")); root = createRoot(host); native.measure = undefined;
});
afterEach(() => { act(() => root.unmount()); host.remove(); Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT"); });
const props: MobileUserMessageContentProps = { ownerKey: "task/message", text: "Visible source ".repeat(15), automation: false,
  selectable: true, locale: "en", colors: { ink: "#111", muted: "#666" } };
function render(patch: Partial<MobileUserMessageContentProps> = {}) { act(() => root.render(createElement(MobileUserMessageContent, { ...props, ...patch }))); }
const body = () => host.querySelector('[data-testid="message.userBody"]')!;
const toggle = () => host.querySelector<HTMLElement>('[data-testid="message.userCollapse"]');
function measure(lines: number) { act(() => native.measure!({ nativeEvent: { lines: Array.from({ length: lines }) } })); }

it("uses bounded native visual lines, latches a collapsed bubble and preserves the complete selectable source", () => {
  render();
  expect(body().getAttribute("data-lines")).toBeNull();
  expect(host.querySelector('[data-testid="message.userMeasure"]')?.getAttribute("data-lines")).toBe("15");
  expect(host.querySelector('[aria-hidden="true"][data-pointer="none"][data-accessibility="no-hide-descendants"]')).not.toBeNull();
  measure(14); expect(toggle()).toBeNull();
  measure(15); expect(body().getAttribute("data-lines")).toBe("10");
  expect(body().textContent).toBe(props.text);
  expect(body().getAttribute("data-selectable")).toBe("true");
  measure(10); expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
  act(() => toggle()!.click()); expect(body().getAttribute("data-lines")).toBeNull();
  render({ locale: "zh-TW" }); expect(toggle()?.getAttribute("aria-label")).toBe("收合訊息");
  act(() => toggle()!.click()); expect(body().getAttribute("data-lines")).toBe("10");
});

it("uses the scheduler threshold and retires old native callbacks and expansion when the owner or source changes", () => {
  render({ automation: true });
  expect(host.querySelector('[data-testid="message.userMeasure"]')?.getAttribute("data-lines")).toBe("5");
  expect(body().getAttribute("data-lines")).toBe("3");
  act(() => toggle()!.click()); expect(body().getAttribute("data-lines")).toBeNull();
  const old = native.measure!;
  render({ ownerKey: "other-task/message", text: "A short input", automation: true, selectable: false });
  act(() => old({ nativeEvent: { lines: Array.from({ length: 5 }) } }));
  expect(body().textContent).toBe("A short input");
  expect(body().getAttribute("data-lines")).toBeNull(); expect(toggle()).toBeNull();
  render({ text: "Changed input ".repeat(10), automation: true });
  expect(body().getAttribute("data-lines")).toBe("3");
});
