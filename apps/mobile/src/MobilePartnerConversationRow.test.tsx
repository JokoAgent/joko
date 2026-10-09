// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { MobilePartnerConversationRow } from "./MobilePartnerConversationRow";
import { MobilePartnerEntranceLedger } from "./mobile-partner-entrance";
import type { TimelineRow } from "./timeline";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { environment, animations } = vi.hoisted(() => ({ environment: { reduced: false }, animations: [] as Record<string, unknown>[] }));
vi.mock("react-native", async () => {
  const { createElement: element } = await import("react");
  const primitive = (tag: "span" | "div") => ({ children, testID, style }: { children?: ReactNode; testID?: string; style?: unknown }) =>
    element(tag, { "data-testid": testID, "data-style": JSON.stringify(style) }, children);
  class Value { setValue() {} interpolate(value: unknown) { return value; } }
  return { View: primitive("div"), Text: primitive("span"), StyleSheet: { create: (value: unknown) => value },
    AccessibilityInfo: { isReduceMotionEnabled: async () => environment.reduced, addEventListener: () => ({ remove: () => undefined }) },
    Animated: { Value, View: primitive("div"), timing: (_value: unknown, config: Record<string, unknown>) => ({
      start: () => animations.push(config), stop: () => undefined
    }) }, Easing: { bezier: () => "ease-out" } };
});
const colors = { background: "#fff", surface: "#eee", ink: "#111", muted: "#666", border: "#ddd", accent: "#287", brandBackground: "#eaf", negative: "#b00" };
function row(id: string, kind: TimelineRow["kind"] = "assistant"): TimelineRow {
  return { id, eventId: id, sequence: 1n, kind, text: "Reply", label: "Ada", completed: true, startedAtMs: Date.now() - 100 };
}

describe("mobile Partner native conversation rows", () => {
  it("preserves original children/actions with the fixed reply portrait, gap, centered time and user bubble", async () => {
    const container = document.createElement("div"); const root = createRoot(container); const reply = row("geometry");
    try {
      await act(async () => root.render(createElement(MobilePartnerConversationRow, { row: reply, ownerKey: "owner", preset: "orbit",
        timestamp: Date.now(), colors, locale: "en", animate: false, children: createElement("button", {}, "Original action") })));
      expect(container.querySelector('[data-testid="partner.avatar.orbit"]')?.getAttribute("data-style")).toContain('"width":28');
      expect(container.innerHTML).toContain('gap&quot;:10');
      expect(container.querySelector('[data-testid="partner.conversation.time"]')?.textContent).toBeTruthy();
      expect(container.querySelector("button")?.textContent).toBe("Original action");
      await act(async () => root.render(createElement(MobilePartnerConversationRow, { row: row("user", "user"), ownerKey: "owner", preset: "orbit",
        colors, locale: "en", animate: false, children: "User message" })));
      expect(container.querySelector('[data-testid="partner.avatar.orbit"]')).toBeNull();
      expect(container.innerHTML).toContain('maxWidth&quot;:&quot;86%');
    } finally { act(() => root.unmount()); }
  });

  it("animates a fresh message once with native transforms and obeys reduced motion and history", async () => {
    const container = document.createElement("div"); let root = createRoot(container); const reply = row("fresh-once");
    const props = { row: reply, ownerKey: "motion", preset: "spark", colors, locale: "en" as const, animate: true, children: "Reply" };
    const before = animations.length;
    try {
      environment.reduced = true;
      await act(async () => root.render(createElement(MobilePartnerConversationRow, { ...props, row: row("reduce") })));
      expect(animations).toHaveLength(before);
      environment.reduced = false;
      await act(async () => root.render(createElement(MobilePartnerConversationRow, props)));
      expect(animations.at(-1)).toMatchObject({ useNativeDriver: true, duration: 200, toValue: 1 });
      expect(animations).toHaveLength(before + 1);
      act(() => root.unmount()); root = createRoot(container);
      await act(async () => root.render(createElement(MobilePartnerConversationRow, props)));
      expect(animations).toHaveLength(before + 1);
      await act(async () => root.render(createElement(MobilePartnerConversationRow, { ...props, row: row("history"), animate: false })));
      expect(animations).toHaveLength(before + 1);
    } finally { environment.reduced = false; act(() => root.unmount()); }
  });

  it("bounds entrance identity memory and never animates an old or future row", () => {
    const ledger = new MobilePartnerEntranceLedger(); const now = 100_000;
    expect(ledger.claim("old", now - 15_000, now)).toBe(false);
    expect(ledger.claim("future", now + 1, now)).toBe(false);
    expect(ledger.claim("invalid", Number.NaN, now)).toBe(false);
    expect(ledger.claim("fresh", now, now)).toBe(true); expect(ledger.claim("fresh", now, now)).toBe(false);
    for (let index = 0; index < 200; index++) expect(ledger.claim(`key-${index}`, now, now)).toBe(true);
    expect(ledger.claim("fresh", now, now)).toBe(true);
  });
});
