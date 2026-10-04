// @vitest-environment jsdom
import { act, createElement, forwardRef, useImperativeHandle, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { MobileFileTextPreview } from "./MobileFileTextPreview";

const { scrollTo, layout } = vi.hoisted(() => ({ scrollTo: vi.fn(),
  layout: { current: undefined as ((event: { nativeEvent: { lines: { text: string; y: number }[] } }) => void) | undefined } }));
vi.mock("react-native", () => ({
  ScrollView: forwardRef(({ children }: { children?: ReactNode }, ref) => {
    useImperativeHandle(ref, () => ({ scrollTo })); return createElement("div", {}, children);
  }),
  Text: ({ children, onTextLayout, selectable, accessibilityRole }: { children?: ReactNode; selectable?: boolean; accessibilityRole?: string;
    onTextLayout?: (event: { nativeEvent: { lines: { text: string; y: number }[] } }) => void }) => {
    if (onTextLayout) layout.current = onTextLayout;
    return createElement("span", { role: accessibilityRole, "data-selectable": selectable }, children);
  },
  Platform: { select: (options: { android: string }) => options.android }, StyleSheet: { create: (value: unknown) => value }
}));

describe("native file line focus", () => {
  it("scrolls to the wrapped native line containing the requested column and preserves the entire selectable source", async () => {
    const container = document.createElement("div"); const root = createRoot(container);
    const text = "first\nwrap this line\nlast\n";
    const preview = { kind: "text" as const, title: "Source", sourceLabel: "source.txt", mediaType: "text/plain", byteSize: 25n,
      revisionKey: "source-r1", text, languageId: "", startByte: 0n, endByte: 25n, totalLines: 4, truncated: false,
      focusLine: 2, focusColumn: 7 };
    const props = { preview, locale: "en" as const, colors: { ink: "#111111", muted: "#666666", accent: "#ff9800", negative: "#cc634e" } };
    await act(async () => { root.render(createElement(MobileFileTextPreview, props)); });
    expect(container.querySelector('[data-selectable="true"]')?.textContent).toBe(text);
    await act(async () => { layout.current!({ nativeEvent: { lines: [
      { text: "first\n", y: 0 }, { text: "wrap ", y: 80 }, { text: "this line\n", y: 100 }, { text: "last\n", y: 120 }
    ] } }); });
    expect(scrollTo).toHaveBeenCalledWith({ y: 60, animated: false });
    await act(async () => { root.render(createElement(MobileFileTextPreview, { ...props,
      preview: { ...preview, focusLine: 99, truncated: true } })); });
    expect(container.textContent).toContain("Line 99 is outside this preview.");
    expect(container.textContent).toContain("Preview is truncated");
    expect(container.querySelector('[data-selectable="true"]')?.textContent).toBe(text);
    await act(async () => { root.unmount(); });
  });
});
