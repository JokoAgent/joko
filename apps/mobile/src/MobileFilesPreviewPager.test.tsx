// @vitest-environment jsdom
import { act, createElement, forwardRef, useImperativeHandle, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { ArtifactSchema } from "@joko/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileFilesPreviewPager } from "./MobileFilesPreviewPager";
import { MobileFileTextPreview } from "./MobileFileTextPreview";
import { mobileFilesPreviewCanSwipe, mobileGeneratedPreviewPages, type MobileFilesPreviewPager as Pager } from "./mobile-files-preview-pager";
import type { MobileFilePreview } from "./workspace-files";

interface ListProps {
  horizontal?: boolean; data: readonly unknown[]; scrollEnabled?: boolean;
  renderItem(value: { item: unknown; index: number }): ReactNode;
  getItemLayout(data: unknown, index: number): { length: number; offset: number; index: number };
  onMomentumScrollEnd(event: { nativeEvent: { layoutMeasurement: { width: number }; contentOffset: { x: number } } }): void;
}
const native = vi.hoisted(() => ({
  width: 360, scroll: vi.fn(),
  pager: undefined as ListProps | undefined,
  layout: undefined as ((event: { nativeEvent: { layout: { width: number } } }) => void) | undefined
}));
vi.mock("./rich-markdown-runtime.richjs", () => ({ default: { mermaidScript: "", katexScript: "", katexCss: "" } }));
vi.mock("./mobile-resource-pressure", () => ({ mobileResourcePressureSupported: () => true,
  subscribeMobileResourcePressure: () => ({ remove() {} }) }));
vi.mock("react-native-webview", () => ({ WebView: forwardRef(({ source }: { source: { html: string } }, ref) => {
  useImperativeHandle(ref, () => ({ injectJavaScript() {} }));
  return createElement("div", { "data-html": source.html });
}) }));
vi.mock("react-native", () => ({
  View: ({ children, onLayout }: { children?: ReactNode; onLayout?: typeof native.layout }) => {
    if (onLayout) native.layout = onLayout; return createElement("div", {}, children);
  },
  Text: ({ children }: { children?: ReactNode }) => createElement("span", {}, children),
  Pressable: ({ children, onPress, accessibilityLabel, disabled }: {
    children?: ReactNode; onPress(): void; accessibilityLabel?: string; disabled?: boolean
  }) => createElement("button", { onClick: onPress, "aria-label": accessibilityLabel, disabled }, children),
  FlatList: forwardRef((props: ListProps, ref) => {
    if (props.horizontal) native.pager = props;
    useImperativeHandle(ref, () => ({ scrollToOffset: native.scroll, scrollToIndex() {} }));
    return createElement("div", { "data-horizontal": props.horizontal }, props.data.map((item, index) =>
      createElement("div", { key: index }, props.renderItem({ item, index }))));
  }),
  useWindowDimensions: () => ({ width: native.width, height: 800, scale: 1, fontScale: 1 }),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }, Platform: { select: (options: { android: string }) => options.android },
  AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) }, Linking: { openURL: vi.fn(), canOpenURL: vi.fn() }
}));
const colors = { ink: "#111111", muted: "#666666", accent: "#ff9800", negative: "#cc634e", surface: "#fafafa", background: "#ffffff", border: "#cccccc" };
const pages = mobileGeneratedPreviewPages(["gamma", "alpha", "beta"].map((name) => create(ArtifactSchema, {
  artifactId: name, sessionId: "session", title: name,
  blob: { blobId: name, fileName: name + ".txt", mediaType: "text/plain", byteSize: 4n, sha256Hex: "a".repeat(64) }
})), "name", "beta");
const pager: Pager = { id: "window", pages, index: 1, sort: "name" };
const momentum = (list: ListProps, index: number, width: number) =>
  list.onMomentumScrollEnd({ nativeEvent: { layoutMeasurement: { width }, contentOffset: { x: index * width } } });

describe("native Files preview paging", () => {
  beforeEach(() => {
    native.width = 360; native.scroll.mockClear(); native.pager = undefined; native.layout = undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => { callback(0); return 1; });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("mounts only the selected reader, synchronizes controls and anchors its source through layout, rotation and retired native callbacks", async () => {
    const node = document.createElement("div"); const root = createRoot(node); const navigate = vi.fn();
    const render = (value: Pager, disabled = false) => createElement(MobileFilesPreviewPager, {
      pager: value, colors, locale: "en", disabled, canSwipe: true, onNavigate: navigate,
      children: createElement("div", { "data-reader": true }, value.pages[value.index]!.title)
    });
    await act(async () => { root.render(render(pager)); });
    expect(node.querySelectorAll("[data-reader]")).toHaveLength(1); expect(node.textContent).toContain("2 of 3");
    expect(native.scroll).toHaveBeenLastCalledWith({ offset: 360, animated: false });
    const old = native.pager!; const oldLayout = native.layout!;
    await act(async () => { node.querySelector<HTMLButtonElement>('[aria-label="Next file"]')!.click(); });
    expect(navigate).toHaveBeenLastCalledWith("window", pages[2]!.key);
    await act(async () => { root.render(render({ ...pager, index: 2 })); });
    expect(node.textContent).toContain("3 of 3"); expect(node.querySelector<HTMLButtonElement>('[aria-label="Next file"]')!.disabled).toBe(true);
    expect(native.scroll).toHaveBeenLastCalledWith({ offset: 720, animated: false });
    navigate.mockClear(); await act(async () => { momentum(old, 0, 360); oldLayout({ nativeEvent: { layout: { width: 20 } } }); });
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => { native.layout!({ nativeEvent: { layout: { width: 320 } } }); });
    expect(native.pager!.getItemLayout(null, 2)).toEqual({ length: 320, offset: 640, index: 2 });
    const beforeRotation = native.pager!;
    native.width = 640; await act(async () => { root.render(render({ ...pager, index: 2 })); });
    expect(native.scroll).toHaveBeenLastCalledWith({ offset: 1280, animated: false });
    await act(async () => { momentum(beforeRotation, 0, 320); momentum(native.pager!, 1, 320); });
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => { momentum(native.pager!, 1, 640); }); expect(navigate).toHaveBeenLastCalledWith("window", pages[1]!.key);
    navigate.mockClear(); await act(async () => { root.render(render({ ...pager, index: 2 }, true)); });
    expect(native.pager!.scrollEnabled).toBe(false);
    await act(async () => { momentum(native.pager!, 0, 640); });
    expect(navigate).not.toHaveBeenCalled();
    const retired = native.pager!; await act(async () => { root.unmount(); momentum(retired, 0, 640); });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("gives rendered HTML and PDF their inner gestures while Source and explicit file buttons remain usable", async () => {
    const text = "<button>HTML</button>"; const size = BigInt(new TextEncoder().encode(text).length);
    const html: MobileFilePreview = { kind: "text", title: "Page", sourceLabel: "page.html", fileName: "page.html", mediaType: "text/html",
      byteSize: size, revisionKey: "html-r1", text, languageId: "", startByte: 0n, endByte: size, totalLines: 1, truncated: false };
    const pdf: MobileFilePreview = { kind: "pdf", title: "PDF", sourceLabel: "page.pdf", mediaType: "application/pdf", byteSize: 1n, revisionKey: "pdf-r1",
      leaseId: "pdf", profileId: "profile", uri: "file:///pdf/page.pdf", fileName: "page.pdf", localByteSize: 1, sha256Hex: "a".repeat(64) };
    const navigate = vi.fn(); const node = document.createElement("div"); const root = createRoot(node);
    function Reader({ preview }: { preview: MobileFilePreview }) {
      const [mode, setMode] = useState<"rendered" | "source">("rendered");
      return createElement(MobileFilesPreviewPager, { pager, colors, locale: "en", disabled: false,
        canSwipe: mobileFilesPreviewCanSwipe(preview, mode === "source"), onNavigate: navigate,
        children: preview.kind === "text" ? createElement(MobileFileTextPreview, { preview, colors, locale: "en", onViewChange: setMode })
          : createElement("div", { "data-pdf": true })
      });
    }
    await act(async () => { root.render(createElement(Reader, { preview: html })); });
    expect(native.pager!.scrollEnabled).toBe(false); expect(node.querySelector("[data-html]")).toBeTruthy();
    await act(async () => { momentum(native.pager!, 0, 360); }); expect(navigate).not.toHaveBeenCalled();
    await act(async () => { node.querySelector<HTMLButtonElement>('[aria-label="Next file"]')!.click(); });
    expect(navigate).toHaveBeenLastCalledWith("window", pages[2]!.key); navigate.mockClear();
    await act(async () => { node.querySelector<HTMLButtonElement>('[aria-label="Source"]')!.click(); });
    expect(native.pager!.scrollEnabled).toBe(true); expect(node.querySelector("[data-html]")).toBeNull();
    await act(async () => { momentum(native.pager!, 0, 360); }); expect(navigate).toHaveBeenLastCalledWith("window", pages[0]!.key);
    await act(async () => { root.render(createElement(Reader, { preview: pdf })); });
    expect(native.pager!.scrollEnabled).toBe(false); expect(node.querySelector("[data-pdf]")).toBeTruthy();
    navigate.mockClear(); await act(async () => { momentum(native.pager!, 0, 360); });
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => { root.unmount(); });
  });
});
