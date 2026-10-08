// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import type { MobileThinkingView } from "./mobile-thinking-projection";
import { mobileExpandedBlockStore } from "./mobile-expanded-block-memory";
import { mobileThinkingMessage } from "./mobile-thinking-messages";
import { tokenizeMobileThinkingText } from "./mobile-thinking-text";

const native = vi.hoisted(() => ({ state: "active", listeners: new Set<(state: string) => void>() }));
vi.mock("react-native", () => {
  const flatten = (style: unknown): Record<string, unknown> => Array.isArray(style)
    ? Object.assign({}, ...style.map(flatten)) : style && typeof style === "object" ? style as Record<string, unknown> : {};
  const box = ({ children, style }: { children?: ReactNode; style?: unknown }) => createElement("div", { style: flatten(style) }, children);
  return {
    View: box,
    Text: ({ children, style, numberOfLines, selectable }: { children?: ReactNode; style?: unknown; numberOfLines?: number; selectable?: boolean }) =>
      createElement("span", { style: flatten(style), "data-lines": numberOfLines, "data-selectable": selectable }, children),
    Pressable: ({ children, onPress, accessibilityLabel, accessibilityState, disabled, style }: {
      children?: ReactNode; onPress?: () => void; accessibilityLabel?: string;
      accessibilityState?: { expanded?: boolean; disabled?: boolean }; disabled?: boolean; style?: unknown;
    }) => createElement("button", { onClick: onPress, "aria-label": accessibilityLabel,
      "aria-expanded": accessibilityState?.expanded, "aria-disabled": accessibilityState?.disabled,
      disabled, style: flatten(style) }, children),
    ActivityIndicator: ({ accessibilityLabel }: { accessibilityLabel?: string }) => createElement("span", { role: "progressbar", "aria-label": accessibilityLabel }),
    StyleSheet: { create: (value: unknown) => value },
    AppState: { get currentState() { return native.state; }, addEventListener: (_event: string, listener: (state: string) => void) => {
      native.listeners.add(listener); return { remove: () => native.listeners.delete(listener) };
    } }
  };
});
import { MobileThinkingCard, type MobileThinkingCardProps } from "./MobileThinkingCard";
import { MobileWorkGroupCard } from "./MobileWorkGroupCard";

const colors = { background: "#fff", surface: "#fafafa", ink: "#111", muted: "#666", border: "#ccc", accent: "#ff9800", negative: "#b00", brandBackground: "#fff4df" };
const thinking: MobileThinkingView = {
  key: "thinking-one", ownerScope: "session-one/generation-one", runScope: "run-one", messageScope: "message-one",
  sessionId: "session-one", messageId: "message-one", contentIndex: 0, eventId: "event-one", sequence: 1n,
  text: "**Inspecting files** with `git status`\nA longer second line.", redacted: false, completed: true, streaming: false
};
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  native.state = "active";
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove(); native.listeners.clear(); mobileExpandedBlockStore.reset();
  vi.useRealTimers();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});
function render(patch: Partial<MobileThinkingCardProps> = {}, key = "card") {
  act(() => root.render(createElement(MobileThinkingCard, { thinking, ownerKey: "owner-one", colors, locale: "en", enabled: true, ...patch, key })));
}
function button(label: string): HTMLButtonElement {
  const element = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(element, label).not.toBeNull();
  return element!;
}
function press(label: string): void {
  act(() => button(label).click());
}
function appState(state: string): void {
  act(() => { native.state = state; for (const listener of [...native.listeners]) listener(state); });
}

describe("native Thinking and Work cards", () => {
  it("keeps exact Thinking expansion across remounts and plain/compact regrouping without crossing owners", () => {
    render();
    expect(host.textContent).not.toContain("Inspecting files");
    const toggle = button("Expand thinking");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.style.minHeight).toBe("44px");
    toggle.focus(); press("Expand thinking");
    expect(document.activeElement).toBe(toggle);
    expect(button("Collapse thinking").getAttribute("aria-expanded")).toBe("true");
    expect(host.textContent).toContain("Inspecting files with git status");
    expect(Array.from(host.querySelectorAll("span")).some((span) => span.textContent === "Inspecting files" && span.style.fontWeight === "700")).toBe(true);
    expect(Array.from(host.querySelectorAll("span")).some((span) => span.textContent === "git status" && span.style.fontFamily === "monospace")).toBe(true);
    render({ compact: true }, "regrouped");
    expect(button("Collapse thinking").getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector('[data-selectable="true"]')?.getAttribute("data-lines")).toBeNull();
    render({ ownerKey: "owner-two", compact: true });
    expect(button("Expand thinking").getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector('[data-lines="1"][data-selectable="false"]')).not.toBeNull();
    render();
    expect(button("Collapse thinking").getAttribute("aria-expanded")).toBe("true");
  });

  it("never renders redacted source text, including compact previews or remembered expanded bodies", () => {
    const hidden = { ...thinking, text: "**SECRET BODY** `private-key`", redacted: true, streaming: true, startedAtMs: 1 };
    render({ thinking: hidden, compact: true });
    expect(host.textContent).toContain("Thinking hidden");
    expect(host.textContent).toContain("The model returned no thinking to display.");
    expect(host.textContent).not.toContain("SECRET BODY");
    expect(host.textContent).not.toContain("private-key");
    press("Expand thinking");
    expect(host.textContent).not.toContain("SECRET BODY");
    expect(host.textContent).not.toContain("private-key");
  });

  it("runs only a current foreground streaming clock from its real start and retires it on terminal, owner and unmount", () => {
    vi.useFakeTimers(); vi.setSystemTime(20_000);
    const active = { ...thinking, completed: false, streaming: true, startedAtMs: 10_000 };
    render({ thinking: active });
    expect(host.textContent).toContain("Thinking · 10s elapsed");
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(2_000));
    expect(host.textContent).toContain("Thinking · 12s elapsed");
    appState("background");
    expect(vi.getTimerCount()).toBe(0);
    expect(button("Expand thinking").disabled).toBe(true);
    expect(host.textContent).not.toContain("elapsed");
    act(() => vi.advanceTimersByTime(3_000));
    appState("active");
    expect(host.textContent).toContain("Thinking · 15s elapsed");
    render({ thinking: { ...active, key: "thinking-two", startedAtMs: 24_000 }, ownerKey: "owner-two" });
    expect(vi.getTimerCount()).toBe(1);
    expect(host.textContent).toContain("Thinking · 1s elapsed");
    render({ thinking: { ...active, completed: true, streaming: false } });
    expect(host.textContent).toContain("duration unknown");
    expect(host.textContent).not.toContain("elapsed");
    expect(vi.getTimerCount()).toBe(0);
    render({ thinking: active });
    act(() => root.render(null));
    expect(vi.getTimerCount()).toBe(0);
    expect(native.listeners.size).toBe(0);
  });

  it("does not invent clocks for missing starts, completed history or disabled/offline content", () => {
    vi.useFakeTimers(); vi.setSystemTime(20_000);
    render({ thinking: { ...thinking, completed: false, streaming: true } });
    expect(host.textContent).toContain("Thinking");
    expect(host.textContent).not.toContain("elapsed");
    expect(vi.getTimerCount()).toBe(0);
    render({ thinking: { ...thinking, streaming: true, startedAtMs: 1 } });
    expect(host.textContent).toContain("duration unknown");
    expect(vi.getTimerCount()).toBe(0);
    render({ thinking: { ...thinking, completed: false, streaming: true, startedAtMs: 1 }, enabled: false });
    expect(button("Expand thinking").disabled).toBe(true);
    expect(host.textContent).not.toContain("elapsed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps child Thinking memory independent while Work folds, remounts and changes owner", () => {
    const group = (ownerKey = "owner-one", streaming = true, enabled = true, key = "group") => {
      act(() => root.render(createElement(MobileWorkGroupCard, { blockKey: "work-first-child", ownerKey,
        streaming, enabled, colors, locale: "en", key,
        children: createElement(MobileThinkingCard, { thinking, ownerKey, enabled, colors, locale: "en", compact: true }) })));
    };
    group();
    expect(host.querySelector('[role="progressbar"]')).not.toBeNull();
    expect(host.textContent).not.toContain("duration unknown");
    expect(button("Expand work process").style.minHeight).toBe("44px");
    press("Expand work process"); press("Expand thinking");
    const toggle = button("Collapse work process");
    toggle.focus(); press("Collapse work process");
    expect(document.activeElement).toBe(toggle);
    expect(host.querySelector('[aria-label="Collapse thinking"]')).toBeNull();
    press("Expand work process");
    expect(button("Collapse thinking").getAttribute("aria-expanded")).toBe("true");
    group("owner-one", false, true, "remounted");
    expect(button("Collapse work process").getAttribute("aria-expanded")).toBe("true");
    expect(button("Collapse thinking").getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector('[role="progressbar"]')).toBeNull();
    group("owner-two");
    expect(button("Expand work process").getAttribute("aria-expanded")).toBe("false");
    appState("background");
    expect(button("Expand work process").disabled).toBe(true);
    expect(host.querySelector('[role="progressbar"]')).toBeNull();
    appState("active"); group("owner-two", true, false);
    expect(button("Expand work process").disabled).toBe(true);
    expect(host.querySelector('[role="progressbar"]')).toBeNull();
  });

  it.each([
    { locale: "en", completed: "Thinking · duration unknown", empty: "No thinking yet", work: "Work process" },
    { locale: "zh-CN", completed: "思考 · 时长未知", empty: "暂无思考内容", work: "工作过程" },
    { locale: "zh-TW", completed: "思考 · 時長未知", empty: "尚無思考內容", work: "工作過程" },
    { locale: "ja", completed: "思考 · 所要時間不明", empty: "思考内容はまだありません", work: "作業過程" },
    { locale: "ko", completed: "생각 · 소요 시간 알 수 없음", empty: "아직 생각 내용 없음", work: "작업 과정" }
  ])("redraws completed labels and empty content in $locale without losing expansion", ({ locale, completed, empty, work }) => {
    const language = locale as MobileSupportedLocale;
    render(); press("Expand thinking");
    render({ locale: language, thinking: { ...thinking, text: "" } });
    expect(host.textContent).toContain(completed);
    expect(host.textContent).toContain(empty);
    expect(button(mobileThinkingMessage(language, "collapse")).getAttribute("aria-expanded")).toBe("true");
    act(() => root.render(createElement(MobileWorkGroupCard, { ownerKey: "owner-one", blockKey: "work-one",
      streaming: false, enabled: true, colors, locale: language, children: null })));
    expect(host.textContent).toContain(work);
    expect(button(mobileThinkingMessage(language, "expandWork")).getAttribute("aria-expanded")).toBe("false");
  });

  it("tokenizes only paired strong/code spans while leaving malformed, escaped and unrelated Markdown literal", () => {
    expect(tokenizeMobileThinkingText("**Inspect** with ``a ` b`` and [docs](https://example.com)")).toEqual([
      { kind: "strong", value: "Inspect" }, { kind: "text", value: " with " },
      { kind: "code", value: "a ` b" }, { kind: "text", value: " and [docs](https://example.com)" }
    ]);
    for (const literal of ["**unfinished", String.raw`\**escaped**`, "**/*.ts", "***nested***", "2 ** 3", "`unfinished"]) {
      expect(tokenizeMobileThinkingText(literal)).toEqual([{ kind: "text", value: literal }]);
    }
    expect(tokenizeMobileThinkingText("` line\nnext `")).toEqual([{ kind: "code", value: "line next" }]);
  });
});
