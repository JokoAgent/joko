// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import type { MobileInlinePlan } from "./mobile-plan-projection";

const native = vi.hoisted(() => ({ listeners: new Set<(state: string) => void>() }));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => createElement("div", {}, children),
  Text: ({ children, selectable, numberOfLines }: { children?: ReactNode; selectable?: boolean; numberOfLines?: number }) =>
    createElement("span", { "data-selectable": selectable, "data-lines": numberOfLines }, children),
  Pressable: ({ children, onPress, accessibilityLabel, accessibilityState, disabled, style }: { children?: ReactNode;
    onPress?: () => void; accessibilityLabel?: string; accessibilityState?: { expanded?: boolean }; disabled?: boolean; style?: unknown }) =>
    createElement("button", { onClick: onPress, "aria-label": accessibilityLabel, "aria-expanded": accessibilityState?.expanded,
      disabled, "data-native-style": JSON.stringify(style) }, children),
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
  AppState: { currentState: "active", addEventListener: (_name: string, listener: (state: string) => void) => {
    native.listeners.add(listener); return { remove: () => native.listeners.delete(listener) };
  } }
}));
import { MobilePlanCard } from "./MobilePlanCard";
import { mobileExpandedBlockStore } from "./mobile-expanded-block-memory";

const colors = { background: "#fff", surface: "#fafafa", ink: "#111", muted: "#666", border: "#ccc", accent: "#ff9800", negative: "#b00", brandBackground: "#fff4df" };
const longContent = `Read ${"full ".repeat(1_000)}end of plan`;
const plan: MobileInlinePlan = { identity: "plan-one", sessionId: "session", generation: 2n, nativeGeneration: 7n,
  source: "todo", eventId: "source-two", sequence: 3n, runId: "run", sourceEventIds: ["source-one", "source-two"], sourceToolScopeKeys: ["tool-one", "tool-two"],
  steps: [{ id: "done", content: "Completed work", state: "completed" }, { id: "active", content: "Current work", state: "inProgress", activeForm: "Working" },
    { id: "next", content: longContent, state: "pending" }], completed: 1, total: 3, activeContent: "Current work", streaming: true, sealed: false };
let host: HTMLDivElement; let root: Root;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); mobileExpandedBlockStore.reset();
  host = document.body.appendChild(document.createElement("div")); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); native.listeners.clear();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT"); });
async function render(value = plan, ownerKey = "owner", locale: MobileSupportedLocale = "en", enabled = true) {
  await act(async () => root.render(createElement(MobilePlanCard, { plan: value, ownerKey, locale, enabled, colors })));
}
async function click(label: string) {
  const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button, label).not.toBeNull(); await act(async () => button!.click());
}

describe("native inline plan card", () => {
  it("opens all three states by default, preserves full selectable steps and remembers manual collapse through updates and remounts", async () => {
    await render();
    const toggle = host.querySelector('button[aria-label="Collapse plan"]');
    expect(toggle?.getAttribute("data-native-style")).toContain('"minHeight":44');
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(host.textContent).toContain("Plan 1/3");
    expect(host.textContent).toContain("Completed"); expect(host.textContent).toContain("In progress"); expect(host.textContent).toContain("Pending");
    const full = Array.from(host.querySelectorAll("span")).find((node) => node.textContent === longContent);
    expect(full?.getAttribute("data-selectable")).toBe("true"); expect(full?.hasAttribute("data-lines")).toBe(false);
    await click("Collapse plan"); expect(host.textContent).not.toContain(longContent);
    await render({ ...plan, eventId: "updated-source", sequence: 6n, completed: 3, steps: plan.steps.map((step) => ({ ...step, state: "completed" })) });
    expect(host.querySelector('button[aria-label="Expand plan"]')).not.toBeNull();
    await act(async () => root.render(null)); await render();
    expect(host.querySelector('button[aria-label="Expand plan"]')).not.toBeNull();
    await render({ ...plan, identity: "completed-history", completed: 3, activeContent: longContent,
      steps: plan.steps.map((step) => ({ ...step, state: "completed" })), streaming: false });
    expect(host.querySelector('button[aria-label="Collapse plan"]')).not.toBeNull(); expect(host.textContent).toContain("Plan 3/3");
    await render(plan, "next-owner"); expect(host.querySelector('button[aria-label="Collapse plan"]')).not.toBeNull();
  });

  it("retires hidden controls, resumes the same expansion and localizes summaries without inventing completed steps", async () => {
    const sealed = { ...plan, sealed: true, outcome: "completed" as const, streaming: false };
    await render(sealed); expect(host.textContent).toContain("This plan's turn completed."); expect(host.textContent).toContain("In progress");
    await act(async () => { for (const listener of [...native.listeners]) listener("background"); });
    expect(host.textContent).not.toContain(longContent); expect(host.querySelector("button")?.disabled).toBe(true);
    await act(async () => { for (const listener of [...native.listeners]) listener("active"); });
    expect(host.textContent).toContain(longContent);
    await render(sealed, "owner", "en", false); expect(host.querySelector("button")?.disabled).toBe(true);
    for (const [locale, title, collapse] of [["zh-CN", "计划 1/3", "收起计划"], ["zh-TW", "計畫 1/3", "收合計畫"],
      ["ja", "計画 1/3", "計画を折りたたむ"], ["ko", "계획 1/3", "계획 접기"]] as const) {
      await render(sealed, "owner", locale); expect(host.textContent).toContain(title);
      expect(host.querySelector(`button[aria-label="${collapse}"]`)).not.toBeNull();
    }
  });
});
