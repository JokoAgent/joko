// @vitest-environment jsdom
import { act, createElement, forwardRef, useImperativeHandle, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MobileFileTextPreview } from "./MobileFileTextPreview";
import type { MobileMarkdownResourceDescriptor } from "./mobile-markdown-resources";
import type { MobileClient } from "./mobile-client";
import { createOnShouldStartLoadWithRequest } from "react-native-webview/src/WebViewShared";
import type { MobileFileHtmlClient } from "./MobileFileHtmlPreview";
import type { MobileFileHtmlDescriptor } from "./mobile-file-html-reader";
import { useMobileFileTextActions } from "./use-mobile-file-text-actions";
import { MobileFilesClipboard, type MobileFilesClipboardLease } from "./mobile-files-clipboard";
import type { MobileFilePreview } from "./workspace-files";

const native = vi.hoisted(() => ({
  scrollToIndex: vi.fn(), scrollToOffset: vi.fn(), inject: vi.fn(), openURL: vi.fn(async (_url: string) => undefined), canOpenURL: vi.fn(async () => true),
  currentState: "active", appListeners: new Set<(value: string) => void>(), pressureListeners: new Set<() => void>(),
  layout: undefined as ((event: { nativeEvent: { lines: { text: string; y: number }[] } }) => void) | undefined,
  web: undefined as { source: { html: string }; originWhitelist: readonly string[]; onLoad?(): void; onLoadEnd?(): void;
    menuItems?: readonly { key: string; label: string }[];
    onCustomMenuSelection?(event: { nativeEvent: { key: string; label: string; selectedText: string } }): void;
    onRenderProcessGone?(): void; onShouldStartLoadWithRequest(request: { url: string }): boolean } | undefined,
  list: undefined as { data: readonly string[]; onScrollToIndexFailed(info: { averageItemLength: number; index: number }): void } | undefined
}));
vi.mock("./rich-markdown-runtime.richjs", () => ({ default: { mermaidScript: "", katexScript: "", katexCss: "" } }));
vi.mock("./mobile-resource-pressure", () => ({ mobileResourcePressureSupported: () => true, subscribeMobileResourcePressure: (listener: () => void) => {
  native.pressureListeners.add(listener); return { remove: () => native.pressureListeners.delete(listener) };
} }));
vi.mock("react-native-webview", () => ({ WebView: forwardRef((props: NonNullable<typeof native.web>, ref) => {
  useImperativeHandle(ref, () => ({ injectJavaScript: native.inject })); native.web = props;
  return createElement("div", { "data-document": props.source.html });
}) }));
vi.mock("react-native", () => {
  const box = ({ children }: { children?: ReactNode }) => createElement("div", {}, children);
  return { View: box,
    FlatList: forwardRef((props: { data: readonly string[]; renderItem(value: { item: string; index: number }): ReactNode;
      onScrollToIndexFailed(info: { averageItemLength: number; index: number }): void }, ref) => {
      native.list = props; useImperativeHandle(ref, () => ({ scrollToIndex: native.scrollToIndex, scrollToOffset: native.scrollToOffset }));
      return createElement("div", {}, props.data.map((item, index) => createElement("div", { key: index }, props.renderItem({ item, index }))));
    }),
    Text: ({ children, onTextLayout, selectable, accessibilityRole }: { children?: ReactNode; selectable?: boolean; accessibilityRole?: string;
      onTextLayout?: typeof native.layout }) => {
      if (onTextLayout) native.layout = onTextLayout;
      return createElement("span", { role: accessibilityRole, "data-selectable": selectable }, children);
    },
    Pressable: ({ children, onPress, accessibilityLabel, accessibilityState, disabled }: { children?: ReactNode; onPress(): void; accessibilityLabel?: string; disabled?: boolean;
      accessibilityState?: { selected?: boolean } }) => createElement("button", { onClick: onPress, "aria-label": accessibilityLabel,
        disabled, "aria-pressed": accessibilityState?.selected }, children),
    Linking: { openURL: native.openURL, canOpenURL: native.canOpenURL }, Platform: { select: (options: { android: string }) => options.android },
    StyleSheet: { create: (value: unknown) => value },
    AppState: { get currentState() { return native.currentState; }, addEventListener: (_type: string, listener: (state: string) => void) => {
      native.appListeners.add(listener); return { remove: () => native.appListeners.delete(listener) };
    } }
  };
});
const colors = { ink: "#111111", muted: "#666666", accent: "#ff9800", negative: "#cc634e", surface: "#fafafa", background: "#ffffff", border: "#cccccc" };
const base = { kind: "text" as const, title: "Source", sourceLabel: "source.txt", fileName: "source.txt", mediaType: "text/plain", byteSize: 25n,
  revisionKey: "source-r1", languageId: "", startByte: 0n, endByte: 25n, totalLines: 4, truncated: false };
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("native file reading", () => {
  beforeEach(() => { native.currentState = "active"; native.scrollToIndex.mockClear(); native.inject.mockClear(); native.openURL.mockClear(); });
  it("quotes from the native Markdown selection menu, copies exact source and rejects the retired rendered menu", async () => {
    const container = document.createElement("div"); const root = createRoot(container);
    const preview = { ...base, fileName: "README.md", text: "\uFEFF# Heading\r\n\r\nSelected 😀 text" };
    const quoted = vi.fn(); const add = vi.fn(async () => undefined); const write = vi.fn(async () => true);
    const clipboard = new MobileFilesClipboard(write);
    const client = { filesHtmlResourceOwnerKey: () => "owner", subscribe: () => () => undefined,
      prepareFileTextSourceCopy: vi.fn(async () => ({ kind: "source" as const, text: preview.text, assertCurrent() {} })), addFileTextQuoteToComposer: add };
    function Reader() {
      const actions = useMobileFileTextActions({ client, preview, clipboard, disabled: false, locale: "en", onQuoted: quoted });
      return createElement("div", {}, createElement("output", {}, actions.error || actions.copyResult), createElement(MobileFileTextPreview, { preview, colors, locale: "en", actions }));
    }
    await act(async () => { root.render(createElement(Reader)); });
    expect(native.web?.menuItems).toEqual([{ key: "joko-file-quote", label: "Add to conversation" }]);
    const rendered = native.web!; await act(async () => { rendered.onLoad!(); });
    await act(async () => { native.web!.onCustomMenuSelection!({ nativeEvent: { key: "joko-file-quote", label: "", selectedText: "x".repeat(4_001) } }); });
    expect(container.textContent).toContain("Select at most 4,000 characters"); expect(add).not.toHaveBeenCalled();
    await act(async () => { native.web!.onCustomMenuSelection!({ nativeEvent: { key: "joko-file-quote", label: "", selectedText: "Selected 😀 text" } }); });
    expect(add).toHaveBeenCalledExactlyOnceWith(preview, "Selected 😀 text", expect.any(AbortSignal)); expect(quoted).toHaveBeenCalledOnce();
    await act(async () => { (container.querySelector('[aria-label="Source"]') as HTMLButtonElement).click(); });
    await act(async () => { (container.querySelector('[aria-label="Copy source"]') as HTMLButtonElement).click(); });
    expect(write).toHaveBeenCalledExactlyOnceWith(preview.text); expect(container.querySelector("output")?.textContent).toBe("copied");
    await act(async () => { rendered.onCustomMenuSelection!({ nativeEvent: { key: "joko-file-quote", label: "", selectedText: "late" } }); });
    expect(add).toHaveBeenCalledOnce(); await act(async () => { root.unmount(); });
  });

  it("cancels old source preparation on preview and background changes, preserving a failed quotation for an explicit retry", async () => {
    const container = document.createElement("div"); const root = createRoot(container);
    let finish!: (value: MobileFilesClipboardLease) => void; let signal!: AbortSignal;
    const first = { ...base, text: "first" }; const second = { ...base, revisionKey: "second-r1", fileName: "second.md", text: "second" };
    const write = vi.fn(async () => true); const clipboard = new MobileFilesClipboard(write); const quoted = vi.fn();
    let current: MobileFilePreview = first;
    const client = { filesHtmlResourceOwnerKey: (preview: MobileFilePreview) => current === preview ? "owner" : undefined, subscribe: () => () => undefined,
      prepareFileTextSourceCopy: vi.fn((_preview: MobileFilePreview, cancellation: AbortSignal) => { signal = cancellation; return new Promise<MobileFilesClipboardLease>((resolve) => { finish = resolve; }); }),
      addFileTextQuoteToComposer: vi.fn(async () => { throw new Error("Draft changed"); }) };
    function Reader({ preview }: { preview: Extract<MobileFilePreview, { kind: "text" }> }) {
      const actions = useMobileFileTextActions({ client, preview, clipboard, disabled: false, locale: "en", onQuoted: quoted });
      return createElement("div", {}, createElement("output", {}, actions.error), createElement(MobileFileTextPreview, { preview, colors, locale: "en", actions }));
    }
    await act(async () => { root.render(createElement(Reader, { preview: first })); });
    await act(async () => { (container.querySelector('[aria-label="Copy source"]') as HTMLButtonElement).click(); });
    const old = finish; current = second;
    await act(async () => { root.render(createElement(Reader, { preview: second })); }); expect(signal.aborted).toBe(true);
    await act(async () => { old({ kind: "source", text: "old", assertCurrent() {} }); }); expect(write).not.toHaveBeenCalled();
    await act(async () => { native.web!.onLoad!(); });
    await act(async () => { native.web!.onCustomMenuSelection!({ nativeEvent: { key: "joko-file-quote", label: "", selectedText: "second" } }); });
    expect(container.querySelector("output")?.textContent).toBe("Draft changed"); expect(quoted).not.toHaveBeenCalled();
    await act(async () => { (container.querySelector('[aria-label="Source"]') as HTMLButtonElement).click(); });
    await act(async () => { (container.querySelector('[aria-label="Copy source"]') as HTMLButtonElement).click(); });
    await act(async () => { native.currentState = "background"; native.appListeners.forEach((listener) => listener("background")); });
    expect(signal.aborted).toBe(true);
    await act(async () => { finish({ kind: "source", text: "background", assertCurrent() {} }); }); expect(write).not.toHaveBeenCalled();
    await act(async () => { root.unmount(); });
  });
  it("shows real source line numbers and focuses a wrapped column, retiring old focus on a different preview", async () => {
    const container = document.createElement("div"); const root = createRoot(container); const text = "first\nwrap this line\nlast\n";
    const props = { preview: { ...base, text, focusLine: 2, focusColumn: 7 }, locale: "en" as const, colors };
    await act(async () => { root.render(createElement(MobileFileTextPreview, props)); });
    expect(Array.from(container.querySelectorAll('[data-selectable="true"]')).map((node) => node.textContent)).toEqual(["first", "wrap this line", "last", " "]);
    expect(Array.from(container.querySelectorAll('[data-selectable="false"]')).map((node) => node.textContent)).toEqual(["1", "2", "3", "4"]);
    await act(async () => { native.layout!({ nativeEvent: { lines: [{ text: "wrap ", y: 0 }, { text: "this line", y: 20 }] } }); });
    expect(native.scrollToIndex).toHaveBeenLastCalledWith({ index: 1, animated: false, viewPosition: 0.3, viewOffset: -20 });
    const oldLayout = native.layout; native.scrollToIndex.mockClear();
    await act(async () => { root.render(createElement(MobileFileTextPreview, { ...props, preview: { ...props.preview, focusLine: 99, truncated: true } })); });
    expect(container.textContent).toContain("Line 99 is outside this preview."); expect(container.textContent).toContain("Preview is truncated");
    await act(async () => { oldLayout!({ nativeEvent: { lines: [{ text: "wrap this line", y: 0 }] } }); });
    expect(native.scrollToIndex).not.toHaveBeenCalled(); await act(async () => { root.unmount(); });
  });

  it("opens Markdown rendered, switches the same source without rereading, adopts images without reload and fences retired navigation", async () => {
    const container = document.createElement("div"); const root = createRoot(container); let finish!: (value: MobileMarkdownResourceDescriptor) => void;
    const descriptor = { leaseId: "file-resource", references: new Map([['["image","pixel.png"]', {
      key: '["image","pixel.png"]', kind: "image" as const, label: "Pixel", relativePath: "docs/pixel.png", image: { uri: "data:image/png;base64,AAAA", width: 1, height: 1 }
    }]]) };
    const client: Pick<MobileClient, "filesMarkdownResourceOwnerKey" | "prepareFilesMarkdownResources" | "assertMarkdownResourcesCurrent" | "releaseMarkdownResources" | "subscribe"> & MobileFileHtmlClient = {
      filesHtmlResourceOwnerKey: () => undefined, prepareFilesHtmlResources: vi.fn(), assertFilesHtmlResourcesCurrent: vi.fn(), releaseFilesHtmlResources: vi.fn(),
      filesMarkdownResourceOwnerKey: () => "file-owner", prepareFilesMarkdownResources: vi.fn(() => new Promise<MobileMarkdownResourceDescriptor>((resolve) => { finish = resolve; })),
      assertMarkdownResourcesCurrent: vi.fn(), releaseMarkdownResources: vi.fn(), subscribe: () => () => undefined
    };
    const preview = { ...base, sourceLabel: "docs/README.md", fileName: "README.md", text: "# Heading\n\n**bold** ![Pixel](pixel.png)\n\n[web](https://example.invalid)\n", totalLines: 7 };
    const props = { preview, colors, locale: "en" as const, client };
    await act(async () => { root.render(createElement(MobileFileTextPreview, props)); });
    expect(container.querySelector('[aria-label="Rendered"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(native.web!.source.html).toContain("<h1>Heading</h1>"); const html = native.web!.source.html;
    await act(async () => { native.web!.onLoad!(); finish(descriptor); });
    expect(native.web!.source.html).toBe(html); expect(native.inject).toHaveBeenLastCalledWith(expect.stringContaining("data:image/png;base64,AAAA"));
    const retired = native.web!; const loadRequest = vi.fn();
    const navigation = createOnShouldStartLoadWithRequest(loadRequest, retired.originWhitelist, retired.onShouldStartLoadWithRequest);
    const navigate = (url: string) => navigation({ nativeEvent: { url, lockIdentifier: 1 } } as Parameters<typeof navigation>[0]);
    navigate("https://example.invalid"); expect(loadRequest).toHaveBeenLastCalledWith(false, "https://example.invalid", 1); expect(native.openURL).toHaveBeenCalledOnce();
    navigate("file:///private"); expect(loadRequest).toHaveBeenLastCalledWith(false, "file:///private", 1); expect(native.openURL).toHaveBeenCalledOnce();
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Source"]')!.click(); });
    expect(client.releaseMarkdownResources).toHaveBeenCalledWith(descriptor.leaseId); expect(client.prepareFilesMarkdownResources).toHaveBeenCalledOnce();
    expect(native.list!.data.join("\n")).toBe(preview.text); expect(container.querySelector("[data-document]")).toBeNull();
    navigate("https://example.invalid/late"); expect(native.openURL).toHaveBeenCalledOnce(); expect(native.canOpenURL).not.toHaveBeenCalled();
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Rendered"]')!.click(); });
    const pending = finish;
    await act(async () => { native.currentState = "background"; native.appListeners.forEach((listener) => listener("background")); });
    await act(async () => { pending({ ...descriptor, leaseId: "late-resource" }); });
    expect(container.querySelector("[data-document]")).toBeNull(); expect(client.releaseMarkdownResources).toHaveBeenCalledWith("late-resource");
    await act(async () => { root.unmount(); });
  });

  it("renders complete HTML with scripts and bounded SDK navigation, and switches the same loaded full source", async () => {
    const container = document.createElement("div"); const root = createRoot(container);
    const text = '<!doctype html><p>HTML</p>\n' + '<!-- line -->\n'.repeat(5_001) + '<button onclick="this.textContent=\'Done\'">Go</button>';
    const size = BigInt(new TextEncoder().encode(text).length);
    const preview = { ...base, sourceLabel: "docs/page.htm", fileName: "page.htm", text, byteSize: size, endByte: size, totalLines: 5_003 };
    await act(async () => { root.render(createElement(MobileFileTextPreview, { preview, colors, locale: "en" })); });
    expect(container.querySelector('[aria-label="Rendered"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(native.web!.source.html).toContain(text); expect(container.textContent).not.toContain("first 5000 lines");
    expect(native.web).toMatchObject({ allowFileAccess: false, mediaCapturePermissionGrantType: "deny", setSupportMultipleWindows: false, domStorageEnabled: false, incognito: true });
    expect(native.web).not.toHaveProperty("onMessage");
    const retired = native.web!; const loadRequest = vi.fn();
    const navigation = createOnShouldStartLoadWithRequest(loadRequest, retired.originWhitelist, retired.onShouldStartLoadWithRequest);
    const navigate = (url: string) => navigation({ nativeEvent: { url, lockIdentifier: 7 } } as Parameters<typeof navigation>[0]);
    navigate("about:blank"); expect(loadRequest).toHaveBeenLastCalledWith(true, "about:blank", 7);
    await act(async () => { retired.onLoadEnd!(); });
    for (const url of ["about:blank", "about:srcdoc", "https://example.invalid/private", "data:text/html,hello", "file:///private", "javascript:alert(1)"]) {
      navigate(url); expect(loadRequest).toHaveBeenLastCalledWith(false, url, 7);
    }
    navigate("about:blank#section"); expect(loadRequest).toHaveBeenLastCalledWith(true, "about:blank#section", 7);
    expect(native.openURL).not.toHaveBeenCalled(); expect(native.canOpenURL).not.toHaveBeenCalled();
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Source"]')!.click(); });
    expect(native.list!.data).toHaveLength(5_000); expect(container.textContent).toContain("first 5000 lines");
    navigate("about:blank#late"); expect(loadRequest).toHaveBeenLastCalledWith(false, "about:blank#late", 7);
    await act(async () => { root.render(createElement(MobileFileTextPreview, { preview: { ...preview, truncated: true }, colors, locale: "en" })); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Rendered"]')!.click(); });
    expect(container.querySelector("[data-document]")).toBeNull(); expect(container.textContent).toContain("requires a complete file");
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Source"]')!.click(); }); expect(native.list!.data).toHaveLength(5_000);
    await act(async () => { root.unmount(); });
  });

  it("waits for one complete resource batch, reports partial failure and retires background, process-loss and old-page callbacks", async () => {
    const container = document.createElement("div"); const root = createRoot(container); let finish!: (value: MobileFileHtmlDescriptor) => void;
    const text = '<img src="pixel.png"><p>HTML</p>'; const size = BigInt(new TextEncoder().encode(text).length);
    const preview = { ...base, sourceLabel: "docs/index.html", fileName: "index.html", text, byteSize: size, endByte: size };
    const client = { filesHtmlResourceOwnerKey: () => "html-owner", prepareFilesHtmlResources: vi.fn(() => new Promise<MobileFileHtmlDescriptor>((resolve) => { finish = resolve; })),
      assertFilesHtmlResourcesCurrent: vi.fn(), releaseFilesHtmlResources: vi.fn(), subscribe: () => () => undefined,
      filesMarkdownResourceOwnerKey: () => undefined, prepareFilesMarkdownResources: vi.fn(), assertMarkdownResourcesCurrent: vi.fn(), releaseMarkdownResources: vi.fn() };
    await act(async () => { root.render(createElement(MobileFileTextPreview, { preview, colors, locale: "en", client })); });
    expect(container.querySelector("[data-document]")).toBeNull(); expect(container.textContent).toContain("Loading local resources");
    const descriptor = { leaseId: "html-one", html: '<p>complete</p><img src="data:image/png;base64,AAAA">', total: 2, failed: 1, overBudget: 1, overLimit: 0 };
    await act(async () => { finish(descriptor); }); expect(native.web!.source.html).toContain(descriptor.html);
    expect(container.textContent).toContain("1 local resources could not be loaded"); expect(container.textContent).toContain("preview limits");
    const old = native.web!;
    await act(async () => { old.onRenderProcessGone!(); }); expect(client.releaseFilesHtmlResources).toHaveBeenCalledWith("html-one");
    expect(old.onShouldStartLoadWithRequest({ url: "about:blank#old" })).toBe(false); expect(container.querySelector("[data-document]")).toBeNull();
    const late = finish;
    await act(async () => { native.currentState = "background"; native.appListeners.forEach((listener) => listener("background")); });
    await act(async () => { late({ ...descriptor, leaseId: "html-late" }); }); expect(client.releaseFilesHtmlResources).toHaveBeenCalledWith("html-late");
    expect(container.querySelector("[data-document]")).toBeNull();
    await act(async () => { root.unmount(); });
  });

  it("limits actual source rows and reports a focus outside them, using canonical filename rather than a display title", async () => {
    const container = document.createElement("div"); const root = createRoot(container);
    const preview = { ...base, title: "spoof.md", text: Array.from({ length: 5_002 }, (_, i) => "row " + i).join("\n"), totalLines: 5_002, focusLine: 5_001 };
    await act(async () => { root.render(createElement(MobileFileTextPreview, { preview, colors, locale: "en" })); });
    expect(native.list!.data).toHaveLength(5_000); expect(container.textContent).toContain("Showing the first 5000 lines.");
    expect(container.textContent).toContain("Line 5001 is outside this preview."); expect(container.querySelector('[aria-label="Rendered"]')).toBeNull();
    await act(async () => { root.render(createElement(MobileFileTextPreview, { preview: { ...base, text: "", totalLines: 0 }, colors, locale: "en" })); });
    expect(container.textContent).toContain("(empty file)"); await act(async () => { root.unmount(); });
  });
});
