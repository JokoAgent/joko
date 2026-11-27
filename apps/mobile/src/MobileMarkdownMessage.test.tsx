// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { MobileMarkdownMessage } from "./MobileMarkdownMessage";
import type { MobileMarkdownResourceClient } from "./use-mobile-markdown-resources";

vi.mock("./MobileSelectableMessageText", () => ({ MobileSelectableMessageText: () => null }));

const { copy, openUrl, appStateListeners, pressureListeners, nativeImages, scrollLayouts, richSurface, shareDiagram } = vi.hoisted(() => ({
  copy: vi.fn(async () => undefined), openUrl: vi.fn(async () => undefined),
  appStateListeners: new Set<(state: string) => void>(), pressureListeners: new Set<() => void>(),
  nativeImages: new Map<string, { onError(): void; onLoad(event: { source: { width: number; height: number; isAnimated?: boolean } }): void }>(),
  scrollLayouts: new WeakMap<HTMLElement, (event: { nativeEvent: { layout: { width: number } } }) => void>(),
  richSurface: { mounted: false, inject: vi.fn(), receive: new WeakMap<HTMLElement, (raw: string) => void>(), dismiss: undefined as (() => void) | undefined },
  shareDiagram: vi.fn(async (
    _action: string, _source: unknown, _rendered: unknown, _signal: AbortSignal, beforeDispatch: () => void
  ) => beforeDispatch())
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: copy }));
vi.mock("expo-video", () => ({ VideoView: () => null, useVideoPlayer: vi.fn() }));
vi.mock("lucide-react-native", () => ({ Mail: () => null, CalendarDays: () => null, Folder: () => null,
  ChartColumn: () => null, Check: () => null, Info: () => null, Clock: () => null, MapPin: () => null,
  Coffee: () => null, Image: () => null, Users: () => null, Star: () => null }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: async () => undefined } }));
vi.mock("react-native-svg", () => ({ default: () => null, Path: () => null, Rect: () => null, Ellipse: () => null,
  Polygon: () => null, Polyline: () => null, Line: () => null, Circle: () => null, Text: () => null }));
vi.mock("expo-crypto", () => ({ randomUUID: () => "render-1" }));
vi.mock("./rich-markdown-runtime.richjs", () => ({ default: { mermaidScript: "", katexScript: "", katexCss: "" } }));
vi.mock("./mobile-image-output", () => ({ mobileImageOutput: { perform: shareDiagram } }));
vi.mock("./use-mobile-preview-resource-lifecycle", () => ({
  useMobilePreviewResourceLifecycle: () => ({ rendererMounted: richSurface.mounted, rendererToken: "view-token",
    ownsRenderer: (token: string) => token === "view-token", onRendererReady() {} })
}));
vi.mock("react-native-webview", async () => {
  const { forwardRef, useImperativeHandle } = await vi.importActual<typeof import("react")>("react");
  return { WebView: forwardRef<{ injectJavaScript: typeof richSurface.inject }, {
    source: { html: string }; onMessage?: (event: { nativeEvent: { data: string } }) => void;
  }>(function TestWebView({ source, onMessage }, ref) {
    useImperativeHandle(ref, () => ({ injectJavaScript: richSurface.inject }), []);
    return createElement("div", { "data-rich-web-view": true, "data-html": source.html, ref: (element: HTMLDivElement | null) => {
      if (element && onMessage) richSurface.receive.set(element, (data) => onMessage({ nativeEvent: { data } }));
    } });
  }) };
});
vi.mock("./mobile-resource-pressure", () => ({ subscribeMobileResourcePressure: (listener: () => void) => {
  pressureListeners.add(listener); return { remove: () => pressureListeners.delete(listener) };
} }));
vi.mock("expo-image", () => ({ Image: (props: { source: { uri: string }; accessibilityLabel: string; onError(): void;
  onLoad(event: { source: { width: number; height: number; isAnimated?: boolean } }): void }) => {
  nativeImages.set(props.accessibilityLabel, props); return createElement("img", { src: props.source.uri, alt: props.accessibilityLabel });
} }));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: ({ children }: { children?: ReactNode }) => createElement("div", {}, children) }));
vi.mock("react-native", () => {
  const box = ({ children, accessibilityLabel, style }: { children?: ReactNode; accessibilityLabel?: string; style?: unknown }) => {
    const viewStyle = Array.isArray(style) ? Object.assign({}, ...style.flat()) : style as Record<string, unknown> | undefined;
    return createElement("div", { "aria-label": accessibilityLabel, "data-width": viewStyle?.width,
      "data-height": viewStyle?.height, "data-flex": viewStyle?.flex }, children);
  };
  const scroll = ({ children, horizontal, scrollEnabled, onLayout }: { children?: ReactNode; horizontal?: boolean;
    scrollEnabled?: boolean; onLayout?: (event: { nativeEvent: { layout: { width: number } } }) => void }) =>
    createElement("div", { "data-horizontal": horizontal, "data-scroll-enabled": scrollEnabled,
      ref: (element: HTMLDivElement | null) => { if (element && onLayout) scrollLayouts.set(element, onLayout); } }, children);
  return { View: box, ScrollView: scroll, useWindowDimensions: () => ({ width: 360, height: 800, scale: 1, fontScale: 1 }),
    TextInput: ({ value, onChangeText }: { value: string; onChangeText(value: string): void }) => createElement("input", { value, onChange: (event: { target: { value: string } }) => onChangeText(event.target.value) }),
    Switch: ({ value, onValueChange }: { value: boolean; onValueChange(value: boolean): void }) => createElement("button", { role: "switch", "aria-checked": value, onClick: () => onValueChange(!value) }),
    Text: ({ children, onPress, accessibilityRole, accessibilityLabel, selectable, style }: {
    children?: ReactNode; onPress?: () => void; accessibilityRole?: string; accessibilityLabel?: string; selectable?: boolean; style?: unknown;
    }) => {
      const textStyle = Array.isArray(style) ? Object.assign({}, ...style.flat()) : style as Record<string, unknown> | undefined;
      return createElement("span", { onClick: onPress, role: accessibilityRole, "aria-label": accessibilityLabel,
        "data-selectable": selectable === undefined ? undefined : String(selectable), "data-line-height": textStyle?.lineHeight,
        "data-decoration": textStyle?.textDecorationLine, "data-weight": textStyle?.fontWeight, "data-slant": textStyle?.fontStyle,
        "data-font": textStyle?.fontFamily }, children);
    },
    Platform: { OS: "ios" },
    Modal: ({ visible, children, onDismiss }: { visible: boolean; children?: ReactNode; onDismiss?: () => void }) => {
      richSurface.dismiss = onDismiss;
      return visible ? createElement("div", { "data-native-modal": true }, children) : null;
    },
    Pressable: ({ onPress, children, accessibilityRole, accessibilityLabel, disabled }: { onPress: () => void; children?: ReactNode;
      accessibilityRole?: string; accessibilityLabel?: string; disabled?: boolean }) =>
      createElement("button", { onClick: onPress, role: accessibilityRole, disabled, "aria-label": accessibilityLabel }, children),
    StyleSheet: { create: (value: unknown) => value }, Linking: { openURL: openUrl },
    AppState: { currentState: "active", addEventListener: (_kind: string, listener: (state: string) => void) => {
      appStateListeners.add(listener); return { remove: () => appStateListeners.delete(listener) };
    } }
  };
});

describe("native message Markdown", () => {
  it("fits short tables to measured message width and retains horizontal scrolling for wide tables", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const colors = { surface: "#fff", background: "#fafafa", ink: "#111", muted: "#666",
      border: "#ccc", accent: "#f90", negative: "#c33" };
    const render = (text: string) => act(async () => root.render(
      <MobileMarkdownMessage text={text} colors={colors} locale="en" ownerKey="message-table" />
    ));
    const scrollView = () => container.querySelector<HTMLElement>('[data-horizontal="true"]')!;
    const measure = (width: number) => act(async () => scrollLayouts.get(scrollView())!({ nativeEvent: { layout: { width } } }));
    const row = (index: number) => scrollView().firstElementChild!.children[index]!;
    const widths = (index: number) => Array.from(row(index).children, (cell) => Number(cell.getAttribute("data-width")));
    try {
      await render("| A | B | C |\n| --- | --- | --- |\n| AA | BB | CC |");
      await measure(326);
      expect(widths(0)).toEqual([109, 109, 108]);
      expect(widths(1)).toEqual(widths(0));
      expect(row(1).querySelectorAll('[data-selectable="true"]')).toHaveLength(3);
      expect(scrollView().dataset.scrollEnabled).toBe("false");
      await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Copy table"]')!.click());
      expect(copy).toHaveBeenLastCalledWith("A\tB\tC\nAA\tBB\tCC");

      await measure(280);
      expect(widths(0)).toEqual([96, 96, 96]);
      expect(scrollView().dataset.scrollEnabled).toBe("true");
      await render("| A | B | C | D | E |\n| --- | --- | --- | --- | --- |\n| A | B | C | D | E |");
      await measure(326);
      expect(widths(1)).toEqual([96, 96, 96, 96, 96]);
      expect(row(1).textContent).toBe("ABCDE");
      expect(scrollView().dataset.scrollEnabled).toBe("true");
      await render("Before\n\n| Name | Value |\n| --- | --- |\n| **Alice** | [Shown](https://example.test) |\n| ![Photo](photo.png) | |\n\nAfter");
      await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Copy table"]')!.click());
      expect(copy).toHaveBeenLastCalledWith("Name\tValue\nAlice\tShown\nPhoto\t");
    } finally { await act(async () => root.unmount()); }
  });

  it("offers whole-table copy after streaming and retires it during share selection", async () => {
    const container = document.createElement("div"), root = createRoot(container);
    const colors = { surface: "#fff", background: "#fafafa", ink: "#111", muted: "#666", border: "#ccc", accent: "#f90", negative: "#c33" };
    const header = "| Name | Value |\n| --- | --- |\n| First | 1 |";
    const complete = header + "\n| Last | 2 |";
    const render = (text: string, streaming: boolean, tableCopyEnabled: boolean) => act(async () => root.render(
      <MobileMarkdownMessage text={text} colors={colors} locale="en" ownerKey="task-reply" streaming={streaming} tableCopyEnabled={tableCopyEnabled} />
    ));
    const button = () => container.querySelector<HTMLButtonElement>('button[aria-label="Copy table"]');
    let finish: (() => void) | undefined;
    copy.mockClear();
    try {
      await render(header, true, true);
      expect(container.textContent).toContain("First");
      expect(button()).toBeNull();
      await render(complete, true, true);
      expect(container.textContent).toContain("Last");
      expect(button()).toBeNull();
      await render(complete, false, true);
      copy.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(undefined); }));
      await act(async () => button()!.click());
      await render(complete, false, false);
      expect(button()).toBeNull();
      await act(async () => finish?.());
      await render(complete, false, true);
      expect(container.textContent).not.toContain("Source copied.");
      await act(async () => button()!.click());
      expect(copy.mock.calls).toEqual([["Name\tValue\nFirst\t1\nLast\t2"], ["Name\tValue\nFirst\t1\nLast\t2"]]);
      expect(container.textContent).toContain("Source copied.");
    } finally { finish?.(); await act(async () => root.unmount()); }
  });

  it("sends a previewed rich answer only on click and retains acceptance across native row remounts", async () => {
    const container = document.createElement("div"), root = createRoot(container);
    let finish!: (accepted: boolean) => void;
    const send = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const body = JSON.stringify({ seq: 1, op: "create", id: "go", kind: "button", props: { label: "Continue", send: "Literal /review text" } }) + "\n";
    const props = { text: '```joko-ui\n' + body, streaming: true, answerStateKey: "mobile/rich-send", ownerKey: "runtime-one",
      colors: { background: "#fff", surface: "#fff", ink: "#111", muted: "#666", border: "#ccc", accent: "#ff9800", negative: "#cc634e" }, locale: "en" as const,
      onSendRichAnswer: send };
    try {
      await act(async () => root.render(createElement(MobileMarkdownMessage, props)));
      expect(container.querySelector('button')?.disabled).toBe(true);
      const complete = { ...props, text: props.text + '```', streaming: false };
      await act(async () => root.render(createElement(MobileMarkdownMessage, complete)));
      expect(container.textContent).toContain("Literal /review text");
      expect(send).not.toHaveBeenCalled();
      await act(async () => { container.querySelector('button')!.click(); container.querySelector('button')!.click(); });
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]).toEqual(["Literal /review text", expect.stringContaining(":sent:go")]);
      await act(async () => root.render(null));
      await act(async () => root.render(createElement(MobileMarkdownMessage, complete)));
      expect(container.querySelector('button')?.disabled).toBe(true);
      await act(async () => finish(true));
      expect(container.querySelector('button')?.textContent).toBe("Sent");
      await act(async () => root.render(createElement(MobileMarkdownMessage, { ...complete, answerStateKey: "mobile/other-task", onSendRichAnswer: undefined })));
      expect(container.querySelector('button')?.disabled).toBe(true);
      expect(send).toHaveBeenCalledTimes(1);
    } finally { await act(async () => root.unmount()); }
  });
  it("mounts rich answer controls, retains local edits across streamed patches and isolates another owner", async () => {
    const container = document.createElement("div"); const root = createRoot(container);
    const body = '{"seq":1,"op":"create","id":"flag","kind":"check","props":{"label":"Enabled","default":false}}\n'
      + '{"seq":2,"op":"create","id":"result","kind":"stat","props":{"label":"Result","value":{"op":"if","args":[{"ref":"flag"},"On","Off"]}}}\n';
    const props = { text: 'Before\n```joko-ui\n' + body, streaming: true, answerStateKey: "node/task/rich-message", ownerKey: "runtime-one",
      colors: { background: "#fff", surface: "#fff", ink: "#111", muted: "#666", border: "#ccc", accent: "#ff9800", negative: "#cc634e" }, locale: "en" as const };
    try {
      await act(async () => root.render(createElement(MobileMarkdownMessage, props)));
      expect(container.textContent).toContain("Off"); expect(container.textContent).not.toContain('"op"');
      await act(async () => container.querySelector<HTMLElement>('[role="switch"]')!.click());
      expect(container.textContent).toContain("On");
      await act(async () => root.render(createElement(MobileMarkdownMessage, { ...props, ownerKey: "runtime-two", text: props.text + '{"seq":3,"op":"patch","id":"flag","props":{"default":false}}\n```' })));
      expect(container.textContent).toContain("On");
      await act(async () => root.render(createElement(MobileMarkdownMessage, { ...props, answerStateKey: "other-node/task/rich-message" })));
      expect(container.textContent).toContain("Off");
    } finally { await act(async () => root.unmount()); }
  });
  it.each([false, true])("keeps math and diagram messages mounted with the full application theme, dark=%s", async (dark) => {
    const container = document.createElement("div"); const root = createRoot(container);
    const colors = { background: "#f7f6f3", surface: dark ? "#24292d" : "#ffffff", ink: dark ? "#f4f4f2" : "#242a2d",
      muted: "#637073", border: "#e1e2df", accent: "#ff9800", negative: "#cc634e", brandBackground: "#fff1db", dark };
    try {
      await act(async () => root.render(createElement(MobileMarkdownMessage, {
        text: "Before\n\n$$\nx^2\n$$\n\n```mermaid\ngraph TD; A-->B\n```\n\nAfter",
        colors, locale: "en", ownerKey: "theme-message"
      })));
      expect(container.textContent).toContain("Before");
      expect(container.textContent).toContain("x^2");
      expect(container.textContent).toContain("graph TD; A-->B");
      expect(container.textContent).toContain("After");
    } finally { await act(async () => root.unmount()); }
  });

  it("fills the expanded diagram viewport and keeps the original selectable source available", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const source = "flowchart TD\nA --> B";
    const colors = { surface: "#fff", background: "#fafafa", ink: "#111", muted: "#666",
      border: "#ccc", accent: "#f90", negative: "#c33" };
    const view = "[data-rich-web-view]";
    const modal = () => container.querySelector<HTMLElement>("[data-native-modal]")!;
    const press = (label: string) => act(async () => {
      const button = Array.from(modal().querySelectorAll("button")).find((item) => item.textContent === label);
      expect(button).toBeDefined();
      button!.click();
    });
    richSurface.mounted = true;
    try {
      await act(async () => root.render(<MobileMarkdownMessage text={"```mermaid\n" + source + "\n```"}
        colors={colors} locale="en" ownerKey="diagram-detail" />));
      expect(container.querySelector<HTMLElement>(view)?.parentElement?.dataset.height).toBe("220");
      await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Expand"]')!.click());
      const chart = modal().querySelector<HTMLElement>(view)!;
      expect(chart.parentElement?.dataset).toMatchObject({ flex: "1" });
      expect(chart.parentElement?.dataset.height).toBeUndefined();
      expect(chart.dataset.html).toContain("height:calc(100vh - 16px)");
      await press("Source");
      expect(modal().querySelector(view)).toBeNull();
      expect(modal().querySelector('[data-selectable="true"]')?.textContent).toBe(source);
      await press("Diagram");
      expect(modal().querySelector(view)).not.toBeNull();
      await press("Close");
      expect(modal()).toBeNull();
    } finally {
      richSurface.mounted = false;
      await act(async () => root.unmount());
    }
  });

  it("shares the ready original diagram once and retires a receipt when leaving its chart", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const colors = { surface: "#fff", background: "#fafafa", ink: "#111", muted: "#666",
      border: "#ccc", accent: "#f90", negative: "#c33" };
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const button = (name: string) => Array.from(container.querySelectorAll<HTMLButtonElement>("[data-native-modal] button"))
      .find((item) => item.textContent === name)!;
    richSurface.mounted = true;
    richSurface.inject.mockClear();
    shareDiagram.mockClear();
    try {
      await act(async () => root.render(<MobileMarkdownMessage text={"```mermaid\nflowchart TD\nA --> B\n```"}
        colors={colors} locale="en" ownerKey="chart-export" />));
      await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Expand"]')!.click());
      const chart = container.querySelector<HTMLElement>("[data-native-modal] [data-rich-web-view]")!;
      const receive = richSurface.receive.get(chart)!;
      const reply = (requestId: string) => receive(JSON.stringify({
        type: "joko-rich-markdown/png", instanceId: "render-1", requestId, base64: png
      }));
      expect(button("Export image").disabled).toBe(true);
      await act(async () => receive(JSON.stringify({
        type: "joko-rich-markdown/status", instanceId: "render-1", state: "ready", height: 120
      })));
      expect(button("Export image").disabled).toBe(false);
      await act(async () => { const exportButton = button("Export image"); exportButton.click(); exportButton.click(); });
      expect(richSurface.inject).toHaveBeenCalledTimes(1);
      expect(button("Exporting…").disabled).toBe(true);
      await act(async () => reply("another-request"));
      expect(shareDiagram).not.toHaveBeenCalled();
      await act(async () => reply("render-1"));
      expect(shareDiagram).toHaveBeenCalledExactlyOnceWith("share", expect.objectContaining({
        fileName: "Joko-diagram.png", mediaType: "image/png", width: 1, height: 1
      }), undefined, expect.any(AbortSignal), expect.any(Function));
      await act(async () => button("Export image").click());
      await act(async () => button("Source").click());
      await act(async () => reply("render-1"));
      expect(shareDiagram).toHaveBeenCalledTimes(1);
    } finally {
      richSurface.mounted = false;
      await act(async () => root.unmount());
    }
  });

  it("opens annotation only when the original chart handoff has dismissed", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const colors = { surface: "#fff", background: "#fafafa", ink: "#111", muted: "#666",
      border: "#ccc", accent: "#f90", negative: "#c33" };
    const annotate = vi.fn();
    const render = (ownerKey: string) => act(async () => root.render(<MobileMarkdownMessage
      text={"```mermaid\nflowchart TD\nA --> B\n```"} colors={colors} locale="en" ownerKey={ownerKey} onAnnotateDiagram={annotate} />));
    const request = async () => {
      await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Expand"]')!.click());
      const chart = container.querySelector<HTMLElement>("[data-native-modal] [data-rich-web-view]")!;
      const receive = richSurface.receive.get(chart)!;
      await act(async () => receive(JSON.stringify({ type: "joko-rich-markdown/status", instanceId: "render-1", state: "ready", height: 120 })));
      const action = Array.from(container.querySelectorAll<HTMLButtonElement>("[data-native-modal] button"))
        .find(button => button.textContent === "Annotate")!;
      await act(async () => action.click());
      const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
      await act(async () => receive(JSON.stringify({ type: "joko-rich-markdown/png", instanceId: "render-1", requestId: "render-1", base64: png })));
      expect(container.querySelector("[data-native-modal]")).toBeNull();
    };
    richSurface.mounted = true;
    shareDiagram.mockClear();
    try {
      await render("diagram-owner-one");
      await request();
      expect(annotate).not.toHaveBeenCalled();
      await act(async () => { richSurface.dismiss?.(); richSurface.dismiss?.(); });
      expect(annotate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ mediaType: "image/png", width: 1, height: 1 }));
      await request();
      await render("another-task");
      await act(async () => richSurface.dismiss?.());
      expect(annotate).toHaveBeenCalledTimes(1);
      expect(shareDiagram).not.toHaveBeenCalled();
    } finally {
      richSurface.mounted = false;
      await act(async () => root.unmount());
    }
  });

  it.each([false, true])("keeps marked links, code and inline math selectable after a streamed append, dark=%s", async dark => {
    const container = document.createElement("div"), root = createRoot(container);
    const colors = { background: dark ? "#15191d" : "#ffffff", surface: dark ? "#24292d" : "#fafafa",
      ink: dark ? "#f4f4f2" : "#111111", muted: "#637073", border: "#e1e2df", accent: "#ff9800", negative: "#cc634e", dark };
    const props = { colors, locale: "en" as const, ownerKey: "nested-markdown" };
    const source = 'Read ~~**_[Docs](https://example.test)_ and `value` and $x^2$**';
    try {
      await act(async () => root.render(createElement(MobileMarkdownMessage, { ...props, text: source, streaming: true })));
      expect(container.textContent).toBe("Read ~~Docs and value and x²");
      await act(async () => root.render(createElement(MobileMarkdownMessage, { ...props, text: source + "~~", streaming: false })));
      const link = container.querySelector<HTMLElement>('[role="link"]')!;
      expect(link.textContent).toBe("Docs");
      expect(link.dataset).toMatchObject({ weight: "700", slant: "italic", decoration: "underline line-through" });
      expect(link.closest('[data-selectable="true"]')?.textContent).toBe("Read Docs and value and x²");
      expect(container.querySelector('[data-font="monospace"][data-weight="700"]')?.textContent).toBe("value");
      await act(async () => link.click());
      expect(openUrl).toHaveBeenLastCalledWith("https://example.test");
    } finally { await act(async () => root.unmount()); }
  });

  it("mounts authorized resources, restores interrupted authority, and retires decode, background, pressure and late resources", async () => {
    const container = document.createElement("div"); const root = createRoot(container);
    const imageKey = JSON.stringify(["image", "images/a.png"]); const pathKey = JSON.stringify(["code", "README.md:7"]);
    const descriptor = { leaseId: "resources-1", references: new Map([
      [imageKey, { key: imageKey, kind: "image" as const, label: "Picture", relativePath: "images/a.png", image: { uri: "data:image/png;base64,AAAA", width: 6, height: 4, nativeQuarterTurn: true as const } }],
      [pathKey, { key: pathKey, kind: "file" as const, label: "README.md:7", relativePath: "README.md" }]
    ]) };
    let resourceOwner: string | undefined = "resources-owner";
    let notifyOwner = () => {};
    const client: MobileMarkdownResourceClient = {
      prepareMarkdownResources: vi.fn(async () => descriptor), assertMarkdownResourcesCurrent: vi.fn(), releaseMarkdownResources: vi.fn(),
      markdownResourceOwnerKey: () => resourceOwner,
      subscribe: (listener) => { notifyOwner = () => listener(undefined!); return () => { notifyOwner = () => {}; }; }
    };
    const onOpenImage = vi.fn(); const onOpenPath = vi.fn();
    const props = { text: "Before\n\n![Picture](images/a.png)\n\n`README.md:7` ![External](https://example.invalid/a.png) `missing`\n\nAfter",
      colors: { background: "#ffffff", surface: "#fafafa", ink: "#111111", muted: "#666666", border: "#cccccc", accent: "#ff9800", negative: "#cc634e" },
      locale: "en" as const, ownerKey: "message-owner", resourceClient: client, resourceOwnerKey: "resources-owner",
      messageId: "completed-1", onOpenImage, onOpenPath };
    await act(async () => { root.render(createElement(MobileMarkdownMessage, props)); });
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(container.querySelector("img")?.closest('[data-selectable="true"]')).toBeNull();
    expect(container.querySelector("img")?.closest("span[data-line-height]")).toBeNull();
    expect(container.querySelector('[role="link"]')?.closest('[data-selectable="true"]')?.textContent).toContain("After");
    expect(container.textContent).toContain("External");
    await act(async () => nativeImages.get("Picture")!.onLoad({ source: { width: 4, height: 6, isAnimated: false } }));
    expect(container.querySelector("img")).not.toBeNull();
    await act(async () => {
      container.querySelector<HTMLElement>('[role="button"][aria-label="Picture"]')!.click();
      container.querySelector<HTMLElement>('[role="link"]')!.click();
    });
    expect(onOpenImage).toHaveBeenCalledWith("resources-1", imageKey);
    expect(onOpenPath).toHaveBeenCalledWith("resources-1", pathKey);
    expect(onOpenImage).toHaveBeenCalledTimes(1);
    await act(async () => { nativeImages.get("Picture")!.onError(); });
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('[role="button"][aria-label="Picture"]')?.textContent).toBe("Picture");
    await act(async () => { appStateListeners.forEach((listener) => listener("background")); });
    expect(container.querySelector('[role="link"]')).toBeNull();
    expect(client.releaseMarkdownResources).toHaveBeenCalledWith("resources-1");
    await act(async () => { appStateListeners.forEach((listener) => listener("active")); });
    expect(container.querySelector("img")).not.toBeNull();
    await act(async () => { resourceOwner = undefined; notifyOwner(); });
    expect(container.querySelector("img")).toBeNull();
    expect(client.prepareMarkdownResources).toHaveBeenCalledTimes(2);
    await act(async () => { resourceOwner = "resources-owner"; notifyOwner(); });
    expect(container.querySelector("img")).not.toBeNull();
    expect(client.prepareMarkdownResources).toHaveBeenCalledTimes(3);
    await act(async () => { notifyOwner(); });
    expect(client.prepareMarkdownResources).toHaveBeenCalledTimes(3);
    await act(async () => { pressureListeners.forEach((listener) => listener()); });
    expect(client.prepareMarkdownResources).toHaveBeenCalledTimes(4);
    await act(async () => { pressureListeners.forEach((listener) => listener()); });
    expect(container.querySelector("img")).toBeNull();
    await act(async () => { resourceOwner = undefined; notifyOwner(); resourceOwner = "resources-owner"; notifyOwner(); });
    expect(container.querySelector("img")).toBeNull();
    expect(client.prepareMarkdownResources).toHaveBeenCalledTimes(4);
    let finish!: (value: typeof descriptor) => void;
    vi.mocked(client.prepareMarkdownResources).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => { root.render(createElement(MobileMarkdownMessage, { ...props, text: props.text + " next" })); });
    const signal = vi.mocked(client.prepareMarkdownResources).mock.calls.at(-1)![2];
    await act(async () => { root.unmount(); });
    expect(signal.aborted).toBe(true);
    await act(async () => { finish({ ...descriptor, leaseId: "late-resources" }); });
    expect(client.releaseMarkdownResources).toHaveBeenCalledWith("late-resources");
    expect(container.textContent).toBe("");
  });

  it("keeps an explicit Workspace link clickable after the initial probe returns no reference", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    let owner: string | undefined = "workspace-owner";
    const releaseMarkdownResources = vi.fn();
    const client: MobileMarkdownResourceClient = {
      prepareMarkdownResources: vi.fn(async () => ({ leaseId: "empty-lease", references: new Map() })),
      assertMarkdownResourcesCurrent: vi.fn(), releaseMarkdownResources,
      markdownResourceOwnerKey: () => owner, subscribe: () => () => {}
    };
    const onRetryPath = vi.fn();
    const text = "[指南](./docs/guide.md:7) `./docs/example.md`";
    await act(async () => root.render(<MobileMarkdownMessage text={text} ownerKey="task/message" locale="zh-CN"
      colors={{ background: "#fff", surface: "#fff", ink: "#222", muted: "#555", border: "#ccc", accent: "#96f", negative: "#c21" }}
      resourceClient={client} resourceOwnerKey="workspace-owner" messageId="completed-1" onRetryPath={onRetryPath} />));

    expect(releaseMarkdownResources).toHaveBeenCalledWith("empty-lease");
    const links = container.querySelectorAll<HTMLElement>('[role="link"]');
    expect(Array.from(links, link => link.textContent)).toEqual(["指南"]);
    await act(async () => links[0]!.click());
    expect(onRetryPath).toHaveBeenCalledWith("completed-1", text, JSON.stringify(["link", "./docs/guide.md:7"]));
    owner = undefined;
    await act(async () => links[0]!.click());
    expect(onRetryPath).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it("mounts formatted text, keeps its prefix on append and copies the exact code source", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const colors = { background: "#ffffff", surface: "#fafafa", ink: "#111111", muted: "#666666", border: "#cccccc", accent: "#ff9800", negative: "#cc634e" };
    const prefix = "# Heading\n\n**Important**\n\n";
    await act(async () => { root.render(createElement(MobileMarkdownMessage, { text: prefix, colors, locale: "en", ownerKey: "owner-1" })); });
    const heading = Array.from(container.querySelectorAll("span")).find((node) => node.textContent === "Heading");
    expect(heading).toBeDefined();
    await act(async () => { root.render(createElement(MobileMarkdownMessage, { text: prefix + "```ts\nconst text = '<tag>&';\n```", colors, locale: "en", ownerKey: "owner-1" })); });
    expect(heading?.isConnected || container.contains(heading!)).toBe(true);
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Copy source"]');
    expect(button).not.toBeNull();
    await act(async () => { button!.click(); });
    expect(copy).toHaveBeenCalledWith("const text = '<tag>&';");
    expect(container.textContent).toContain("Source copied.");
    await act(async () => { root.unmount(); });
  });

  it.each(["settled", "late"] as const)("retires the %s copy receipt when the same streaming code block changes", async (timing) => {
    const container = document.createElement("div"), root = createRoot(container);
    const colors = { surface: "#fff", background: "#fafafa", ink: "#111", muted: "#666", border: "#ccc", accent: "#f90", negative: "#c33" };
    const original = "const started = 1;", updated = original + "\nconst continued = 2;";
    const render = (source: string, suffix = "") => act(async () => root.render(<MobileMarkdownMessage
      text={"```ts\n" + source + "\n```" + suffix} colors={colors} locale="en" ownerKey="same-streaming-message" streaming />));
    const button = () => container.querySelector<HTMLButtonElement>('button[aria-label="Copy source"]')!;
    const copied = () => container.textContent?.includes("Source copied.");
    let finish: (() => void) | undefined;
    copy.mockClear();
    if (timing === "late") copy.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(undefined); }));
    try {
      await render(original);
      await act(async () => button().click());
      expect(copy).toHaveBeenNthCalledWith(1, original);
      expect(copied()).toBe(timing === "settled");
      await render(original, "\n\nUnrelated continuation.");
      expect(copied()).toBe(timing === "settled");
      await render(updated);
      await act(async () => finish?.());
      expect(copied()).toBe(false);
      await act(async () => button().click());
      expect(copy).toHaveBeenNthCalledWith(2, updated);
      expect(copied()).toBe(true);
    } finally {
      finish?.();
      await act(async () => root.unmount());
    }
  });
});
