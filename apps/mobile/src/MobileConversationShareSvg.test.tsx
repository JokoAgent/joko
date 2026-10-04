// @vitest-environment jsdom
import { act, createElement, createRef, forwardRef, useImperativeHandle, useLayoutEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { MobileConversationShareSvg } from "./MobileConversationShareSvg";
import type { MobileConversationShareRendererHandle } from "./mobile-conversation-share-export";
import { encodeMobileBase64 } from "./mobile-image-annotation";

const { capture } = vi.hoisted(() => ({ capture: vi.fn<(callback: (base64: string) => void) => void>() }));
vi.mock("./connection-artwork", () => ({ mobileConnectionAppIcon: () => "<svg/>" }));
vi.mock("react-native", () => ({
  Platform: { OS: "android" }, StyleSheet: { create: (value: unknown) => value },
  Image: ({ onError }: { onError: () => void }) => createElement("img", { "data-probe": "true", onError }),
  View: ({ children, onLayout }: { children?: ReactNode; onLayout?: () => void }) => {
    useLayoutEffect(() => { onLayout?.(); }, [onLayout]);
    return createElement("div", {}, children);
  }
}));
vi.mock("react-native-svg", () => ({
  default: forwardRef(function Svg({ children }: { children?: ReactNode }, ref) {
    useImperativeHandle(ref, () => ({ toDataURL: capture }));
    return createElement("svg", {}, children);
  }),
  Rect: () => null, SvgXml: () => null,
  Image: () => createElement("image", { "data-rendered-image": "true" }),
  Text: ({ children }: { children?: ReactNode }) => createElement("text", {}, children),
  TSpan: ({ children }: { children?: ReactNode }) => createElement("tspan", {}, children)
}));

const colors = { background: "#ffffff", surfaceElevated: "#eeeeee", textPrimary: "#111111", textSecondary: "#555555", textTertiary: "#888888" };
const bytes = Uint8Array.of(1, 2, 3);

describe("native conversation PNG export", () => {
  it("waits for native decoding and the fallback layout commit before capturing once", async () => {
    capture.mockReset().mockImplementation((callback) => callback(encodeMobileBase64(bytes)));
    const container = document.createElement("div"); const root = createRoot(container);
    const ref = createRef<MobileConversationShareRendererHandle>();
    await act(async () => root.render(createElement(MobileConversationShareSvg, { ref, colors, width: 390, dark: false,
      snapshot: { leaseId: "share", allShareableIds: ["a"], messages: [{ clientId: "a", kind: "assistant", body: "",
        bodyParts: [{ kind: "text", text: "before" }, { kind: "image", key: "image", label: "Missing image" }, { kind: "text", text: "after" }],
        attachments: [], images: new Map([["image", { uri: "data:image/png;base64,AA==", width: 10, height: 10 }]]) }] } })));
    let exported!: Promise<Uint8Array>;
    await act(async () => { exported = ref.current!.exportPng(new AbortController().signal); });
    expect(capture).not.toHaveBeenCalled();
    await act(async () => { container.querySelector("img")!.dispatchEvent(new Event("error")); });
    await expect(exported).resolves.toEqual(bytes);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(container.querySelector("image")).toBeNull();
    expect(container.textContent).toContain("Missing image");
    expect(container.textContent!.indexOf("before")).toBeLessThan(container.textContent!.indexOf("Missing image"));
    await act(async () => root.unmount());
  });

  it("rejects cancellation and ignores a native capture callback arriving afterward", async () => {
    capture.mockReset();
    let callback!: (base64: string) => void;
    capture.mockImplementation((value) => { callback = value; });
    const container = document.createElement("div"); const root = createRoot(container);
    const ref = createRef<MobileConversationShareRendererHandle>();
    await act(async () => root.render(createElement(MobileConversationShareSvg, { ref, colors, width: 390, dark: false,
      snapshot: { leaseId: "share", allShareableIds: ["a"], messages: [{ clientId: "a", kind: "user", body: "text",
        bodyParts: [{ kind: "text", text: "text" }], attachments: [] }] } })));
    const controller = new AbortController(); let exported!: Promise<Uint8Array>;
    await act(async () => { exported = ref.current!.exportPng(controller.signal); });
    expect(capture).toHaveBeenCalledTimes(1);
    const rejected = expect(exported).rejects.toThrow(/cancelled/u);
    await act(async () => controller.abort()); await rejected;
    callback(encodeMobileBase64(bytes));
    expect(capture).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });
});
