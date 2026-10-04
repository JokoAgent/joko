// @vitest-environment jsdom
import { act, createElement, createRef, forwardRef, useImperativeHandle } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { MobileConversationShareRenderer } from "./MobileConversationShareRenderer";
import type { MobileConversationShareRendererHandle } from "./mobile-conversation-share-export";

const { native, fallback } = vi.hoisted(() => ({
  native: { renderHtmlToPng: vi.fn<(...args: unknown[]) => Promise<unknown>>(), cancelRender: vi.fn(async () => true) },
  fallback: vi.fn(async () => new Uint8Array())
}));
vi.mock("expo", () => ({ requireOptionalNativeModule: () => native }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("./rich-markdown-runtime.richjs", () => ({ default: { mermaidScript: "", katexScript: "", katexCss: "" } }));
vi.mock("./connection-artwork", () => ({ mobileConnectionAppIcon: () => "<svg/>" }));
vi.mock("./MobileConversationShareSvg", () => ({
  MobileConversationShareSvg: forwardRef(function Svg(_props, ref) {
    useImperativeHandle(ref, () => ({ exportPng: fallback }));
    return createElement("div");
  })
}));

describe("mounted conversation image renderer lifetime", () => {
  it("shares one native render promise and cleans it up on unmount before any fallback can run", async () => {
    native.renderHtmlToPng.mockReset().mockImplementation(() => new Promise(() => {}));
    native.cancelRender.mockClear(); fallback.mockClear();
    const root = createRoot(document.createElement("div")); const ref = createRef<MobileConversationShareRendererHandle>();
    await act(async () => root.render(createElement(MobileConversationShareRenderer, { ref, width: 390, dark: false,
      colors: { background: "#ffffff", surfaceElevated: "#eeeeee", textPrimary: "#111111", textSecondary: "#555555", textTertiary: "#888888" },
      snapshot: { leaseId: "lease", allShareableIds: ["a"], messages: [
        { clientId: "a", kind: "assistant", body: "Message", bodyParts: [{ kind: "text", text: "Message" }], attachments: [] }
      ] } })));
    const signal = new AbortController().signal;
    const promise = ref.current!.exportPng(signal);
    expect(ref.current!.exportPng(signal)).toBe(promise);
    expect(native.renderHtmlToPng).toHaveBeenCalledTimes(1);
    const failure = expect(promise).rejects.toThrow();
    await act(async () => root.unmount()); await failure;
    expect(native.cancelRender).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });
});
