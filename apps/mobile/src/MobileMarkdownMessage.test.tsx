// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { MobileMarkdownMessage } from "./MobileMarkdownMessage";
import type { MobileMarkdownResourceClient } from "./use-mobile-markdown-resources";

const { copy, appStateListeners, pressureListeners, nativeImages } = vi.hoisted(() => ({
  copy: vi.fn(async () => undefined), appStateListeners: new Set<(state: string) => void>(), pressureListeners: new Set<() => void>(),
  nativeImages: new Map<string, { onError(): void; onLoad(event: { source: { width: number; height: number; isAnimated?: boolean } }): void }>()
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: copy }));
vi.mock("expo-crypto", () => ({ randomUUID: () => "render-1" }));
vi.mock("./rich-markdown-runtime.richjs", () => ({ default: { mermaidScript: "", katexScript: "", katexCss: "" } }));
vi.mock("./use-mobile-preview-resource-lifecycle", () => ({ useMobilePreviewResourceLifecycle: () => ({ rendererMounted: false }) }));
vi.mock("react-native-webview", () => ({ WebView: () => null }));
vi.mock("./mobile-resource-pressure", () => ({ subscribeMobileResourcePressure: (listener: () => void) => {
  pressureListeners.add(listener); return { remove: () => pressureListeners.delete(listener) };
} }));
vi.mock("expo-image", () => ({ Image: (props: { source: { uri: string }; accessibilityLabel: string; onError(): void;
  onLoad(event: { source: { width: number; height: number; isAnimated?: boolean } }): void }) => {
  nativeImages.set(props.accessibilityLabel, props); return createElement("img", { src: props.source.uri, alt: props.accessibilityLabel });
} }));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: ({ children }: { children?: ReactNode }) => createElement("div", {}, children) }));
vi.mock("react-native", () => {
  const box = ({ children, accessibilityLabel }: { children?: ReactNode; accessibilityLabel?: string }) => createElement("div", { "aria-label": accessibilityLabel }, children);
  return { View: box, ScrollView: box, Text: ({ children, onPress, accessibilityRole, accessibilityLabel, selectable, style }: {
    children?: ReactNode; onPress?: () => void; accessibilityRole?: string; accessibilityLabel?: string; selectable?: boolean; style?: unknown;
  }) => createElement("span", { onClick: onPress, role: accessibilityRole, "aria-label": accessibilityLabel,
    "data-selectable": selectable === undefined ? undefined : String(selectable),
    "data-line-height": (Array.isArray(style) ? Object.assign({}, ...style) : style)?.lineHeight }, children),
    Modal: ({ visible, children }: { visible: boolean; children?: ReactNode }) => visible ? createElement("div", {}, children) : null,
    Pressable: ({ onPress, children, accessibilityRole, accessibilityLabel, disabled }: { onPress: () => void; children?: ReactNode;
      accessibilityRole?: string; accessibilityLabel?: string; disabled?: boolean }) =>
      createElement("button", { onClick: onPress, role: accessibilityRole, disabled, "aria-label": accessibilityLabel }, children),
    StyleSheet: { create: (value: unknown) => value }, Linking: { openURL: vi.fn() },
    AppState: { currentState: "active", addEventListener: (_kind: string, listener: (state: string) => void) => {
      appStateListeners.add(listener); return { remove: () => appStateListeners.delete(listener) };
    } }
  };
});

describe("native message Markdown", () => {
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
});
