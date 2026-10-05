// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ImageLoadEventData, ImageProps } from "expo-image";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileImageGalleryPageSession } from "./mobile-image-gallery";
import { mobileMessage } from "./mobile-messages";

const native = vi.hoisted(() => ({ state: "active", listeners: new Set<(state: string) => void>(),
  images: new Map<string, ImageProps>(), layout: undefined as ((event: unknown) => void) | undefined,
  burn: vi.fn() }));
vi.mock("react-native", () => {
  const box = ({ children }: { children?: ReactNode }) => createElement("div", {}, children);
  return { View: ({ children, accessibilityRole, onLayout }: { children?: ReactNode; accessibilityRole?: string; onLayout?: (event: unknown) => void }) => {
    if (accessibilityRole === "image") native.layout = onLayout;
    return createElement("div", {}, children);
  }, Text: ({ children }: { children?: ReactNode }) => createElement("span", {}, children),
    Modal: ({ children, visible }: { children?: ReactNode; visible: boolean }) => visible ? createElement("div", { role: "dialog" }, children) : null,
    ActivityIndicator: box,
    Pressable: ({ children, onPress, accessibilityLabel, disabled }: { children?: ReactNode; onPress?: () => void; accessibilityLabel?: string; disabled?: boolean }) =>
      createElement("button", { onClick: onPress, "aria-label": accessibilityLabel, disabled }, children),
    PanResponder: { create: () => ({ panHandlers: {} }) },
    StyleSheet: { create: (value: unknown) => value, absoluteFillObject: {} },
    AppState: { get currentState() { return native.state; }, addEventListener: (_event: string, listener: (state: string) => void) => {
      native.listeners.add(listener); return { remove: () => native.listeners.delete(listener) };
    } }
  };
});
vi.mock("expo-image", () => ({ Image: (props: ImageProps) => {
  const source = props.source as { uri: string }; native.images.set(source.uri, props); return createElement("span", { "data-image": source.uri });
} }));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: ({ children }: { children?: ReactNode }) => createElement("div", {}, children) }));
vi.mock("react-native-svg", () => ({ SvgXml: () => null }));
vi.mock("./use-mobile-annotation-burn", () => ({ useMobileAnnotationBurn: () => ({ burnIn: native.burn, host: null }) }));
import { MobileImageLightbox } from "./MobileImageLightbox";

let host: HTMLDivElement; let root: Root;
const close = vi.fn(); const share = vi.fn<(signal: AbortSignal, onDispatch: () => void) => Promise<void>>(); const add = vi.fn();
const decoded = vi.fn(); const output = vi.fn(); const save = vi.fn(); const nativeActivity = vi.fn();
const nativeFailed = vi.fn(); const retry = vi.fn(); const previewFailed = vi.fn();
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); native.state = "active"; native.images.clear(); native.burn.mockReset();
  close.mockReset(); share.mockReset(); share.mockImplementation(async (_signal, onDispatch) => onDispatch()); add.mockReset(); add.mockResolvedValue(undefined);
  decoded.mockReset(); output.mockReset(); save.mockReset(); nativeActivity.mockReset();
  nativeFailed.mockReset(); retry.mockReset(); previewFailed.mockReset();
  host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); native.listeners.clear();
  vi.useRealTimers();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});
function session(mediaType: string, animated: boolean, id = "page-one"): MobileImageGalleryPageSession {
  return { leaseId: id, galleryLeaseId: "gallery", pageId: id, pageIndex: 0, pageCount: 2, sourceKind: "timeline", sourceLabel: "Task message",
    previewUri: "data:" + mediaType + ";base64," + id, sourceBase64: "AA==", sourceMediaType: mediaType, fileName: "image",
    initialStrokes: [], annotatable: false, addable: true, maximumBytes: 1_024, expectedWidthPixels: 1, expectedHeightPixels: 1, expectedAnimated: animated };
}
async function render(page: MobileImageGalleryPageSession) {
  await act(async () => root.render(createElement(MobileImageLightbox, { session: page, locale: "en", onClose: close, onSave: save,
    onOutputAction: output, onNativeActivityChange: nativeActivity, gallery: controls(page) })));
  await act(async () => native.layout?.({ nativeEvent: { layout: { width: 400, height: 300 } } }));
}
function controls(page: MobileImageGalleryPageSession) {
  return { descriptor: { leaseId: page.galleryLeaseId, sourceKind: page.sourceKind, sourceLabel: page.sourceLabel, initialIndex: 0,
    pages: Array.from({ length: page.pageCount }, (_, index) => ({ pageId: index === page.pageIndex ? page.pageId : `other-${index}`,
      title: page.fileName, mediaType: page.sourceMediaType as "image/png", byteSize: 1, sha256Hex: "a".repeat(64) })) },
    pageIndex: page.pageIndex, pageKey: `request-${page.pageId}`, busy: false, onNavigate: vi.fn(), onAddOriginal: add,
    onShareOriginal: share, onDecoded: decoded, onRetry: retry, onNativeFailed: nativeFailed, onPreviewFailed: previewFailed };
}
function button(key: Parameters<typeof mobileMessage>[1]) {
  return Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((node) => node.getAttribute("aria-label") === mobileMessage("en", key));
}
async function load(page: MobileImageGalleryPageSession, isAnimated = page.expectedAnimated) {
  await act(async () => native.images.get(page.previewUri)!.onLoad!({ cacheType: "none", source: { url: page.previewUri, width: 1, height: 1,
    mediaType: page.previewMediaType ?? page.sourceMediaType, isAnimated } } as ImageLoadEventData));
}

describe("native image gallery formats and ownership", () => {
  it("opens a pending page with an independent preview and keeps that layer through original fetch and native decode", async () => {
    const page = session("image/png", false); const preview = { leaseId: "cached-preview", uri: "data:image/png;base64,cached", width: 1, height: 1, mediaType: "image/png", animated: false };
    const pending = { ...controls(page), preview, busy: true };
    await act(async () => root.render(createElement(MobileImageLightbox, { locale: "en", onClose: close, onSave: save, onOutputAction: output, gallery: pending })));
    await act(async () => native.layout?.({ nativeEvent: { layout: { width: 400, height: 300 } } }));
    expect(host.querySelector('[data-image="' + preview.uri + '"]')).not.toBeNull();
    expect(button("image.next")!.disabled).toBe(false); expect(button("image.copy")!.disabled).toBe(true); expect(button("image.share")!.disabled).toBe(true);
    await act(async () => root.render(createElement(MobileImageLightbox, { session: page, locale: "en", onClose: close, onSave: save, onOutputAction: output, gallery: { ...pending, busy: false } })));
    expect(host.querySelector('[data-image="' + preview.uri + '"]')).not.toBeNull(); expect(native.images.get(page.previewUri)).toBeDefined();
    expect(button("image.share")!.disabled).toBe(true); expect(button("image.addOriginal")!.disabled).toBe(true);
    await load(page);
    expect(host.querySelector('[data-image="' + preview.uri + '"]')).toBeNull(); expect(button("image.share")!.disabled).toBe(false);
    expect(button("image.addOriginal")!.disabled).toBe(false); expect(decoded).toHaveBeenCalledOnce();
  });

  it("keeps failed current pages navigable, retries in place and fences old decode and cache-layer errors", async () => {
    const first = session("image/png", false); await render(first); await load(first);
    const oldLoad = native.images.get(first.previewUri)!.onLoad!;
    const second = { ...session("image/png", false, "page-two"), pageIndex: 1 };
    const failed = { ...controls(second), error: mobileMessage("en", "image.previewFailed") };
    await act(async () => root.render(createElement(MobileImageLightbox, { locale: "en", gallery: failed, onClose: close, onSave: save, onOutputAction: output })));
    expect(host.textContent).toContain("2 / 2"); expect(button("image.previous")!.disabled).toBe(false); expect(button("image.share")!.disabled).toBe(true);
    const label = mobileMessage("en", "image.previewRetry", { name: second.fileName });
    const retryButton = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((node) => node.getAttribute("aria-label") === label)!;
    await act(async () => retryButton.click()); expect(retry).toHaveBeenCalledOnce();
    await act(async () => oldLoad({ cacheType: "none", source: { url: first.previewUri, width: 1, height: 1, isAnimated: false } } as ImageLoadEventData));
    expect(decoded).toHaveBeenCalledOnce(); expect(host.textContent).toContain("2 / 2");
    const preview = { leaseId: "preview-two", uri: "data:image/png;base64,preview-two", width: 1, height: 1, mediaType: "image/png", animated: false };
    await act(async () => root.render(createElement(MobileImageLightbox, { locale: "en", gallery: { ...controls(second), preview, busy: true }, onClose: close, onSave: save })));
    await act(async () => native.images.get(preview.uri)!.onError!({ error: "cache decode failed" }));
    expect(previewFailed).toHaveBeenCalledExactlyOnceWith("preview-two"); expect(nativeFailed).not.toHaveBeenCalled();
  });

  it("reports original decode failures and deadlines without enabling original-file effects", async () => {
    vi.useFakeTimers(); const page = session("image/png", false); await render(page);
    await act(async () => native.images.get(page.previewUri)!.onError!({ error: "decode failed" }));
    expect(nativeFailed).toHaveBeenCalledWith(page.leaseId); expect(button("image.share")!.disabled).toBe(true);
    await act(async () => vi.advanceTimersByTime(12_000)); expect(nativeFailed).toHaveBeenCalledWith(page.leaseId, false);
    expect(share).not.toHaveBeenCalled(); expect(add).not.toHaveBeenCalled(); vi.useRealTimers();
  });
  it.each(["image/gif", "image/svg+xml", "image/png", "image/webp"])("forwards %s originals after verified native decode and exposes no static render actions", async (mediaType) => {
    const page = session(mediaType, mediaType !== "image/svg+xml"); await render(page);
    expect(button("image.copy")).toBeUndefined(); expect(button("image.save")).toBeUndefined(); expect(button("image.annotate")).toBeUndefined();
    expect(button("image.share")!.disabled).toBe(true); expect(button("image.addOriginal")!.disabled).toBe(true);
    await load(page); expect(decoded).toHaveBeenCalledOnce(); expect(button("image.share")!.disabled).toBe(false);
    await act(async () => button("image.addOriginal")!.click());
    expect(add).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal)); expect(close).toHaveBeenCalledOnce();
    expect(output).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled(); expect(native.burn).not.toHaveBeenCalled();
  });

  it("single-flights original sharing, stops animation during native inactivity, and retires the page after the share sheet returns", async () => {
    let finish!: () => void; share.mockImplementationOnce((_signal, onDispatch) => { onDispatch(); return new Promise<void>((resolve) => { finish = resolve; }); });
    const page = session("image/gif", true); await render(page); await load(page);
    await act(async () => button("image.share")!.click()); await act(async () => button("image.sharing")!.click());
    expect(share).toHaveBeenCalledOnce(); expect(nativeActivity).toHaveBeenCalledWith(true);
    await act(async () => { native.state = "inactive"; native.listeners.forEach((listener) => listener("inactive")); });
    expect(native.images.get(page.previewUri)!.autoplay).toBe(false); expect(close).not.toHaveBeenCalled();
    await act(async () => finish()); expect(close).toHaveBeenCalledOnce(); expect(nativeActivity).toHaveBeenLastCalledWith(false);
    expect(output).not.toHaveBeenCalled(); expect(native.burn).not.toHaveBeenCalled();
  });

  it("accepts an Android animatable single-frame GIF while preserving original-file actions", async () => {
    const page = session("image/gif", false); await render(page); await load(page, true);
    expect(decoded).toHaveBeenCalledOnce(); expect(button("image.share")!.disabled).toBe(false);
    expect(button("image.copy")).toBeUndefined(); expect(button("image.annotate")).toBeUndefined();
    await act(async () => button("image.share")!.click());
    expect(share).toHaveBeenCalledOnce(); expect(output).not.toHaveBeenCalled(); expect(native.burn).not.toHaveBeenCalled();
  });

  it("keeps the ICO preview and multiple-page TIFF original-only while forwarding the actual native preview MIME", async () => {
    for (const mediaType of ["image/x-icon", "image/tiff", "image/apng"]) {
      const page = { ...session(mediaType, mediaType === "image/apng", mediaType), originalOnly: true,
        previewMediaType: mediaType === "image/tiff" ? "image/tiff" : "image/png" };
      await render(page); await load(page);
      expect(decoded).toHaveBeenLastCalledWith(expect.objectContaining({ mediaType: page.previewMediaType }));
      expect(button("image.copy")).toBeUndefined(); expect(button("image.save")).toBeUndefined(); expect(button("image.annotate")).toBeUndefined();
      expect(button("image.share")!.disabled).toBe(false);
    }
  });

  it("cancels preparation on inactivity before dispatch and refuses a late native share effect", async () => {
    let finish!: () => void;
    share.mockImplementationOnce(async (_signal, onDispatch) => { await new Promise<void>((resolve) => { finish = resolve; }); onDispatch(); });
    const page = session("image/gif", true); await render(page); await load(page);
    await act(async () => button("image.share")!.click());
    const signal = share.mock.calls[0]![0]; expect(nativeActivity).not.toHaveBeenCalledWith(true);
    await act(async () => { native.state = "inactive"; native.listeners.forEach((listener) => listener("inactive")); });
    expect(signal.aborted).toBe(true); expect(close).toHaveBeenCalledOnce();
    await act(async () => finish()); expect(nativeActivity).not.toHaveBeenCalledWith(true); expect(output).not.toHaveBeenCalled();
  });

  it("rejects a flattened animation and ignores native callbacks from an old page or a backgrounded owner", async () => {
    const first = session("image/png", true); await render(first); const oldLoad = native.images.get(first.previewUri)!.onLoad!;
    await load(first, false); expect(host.textContent).toContain(mobileMessage("en", "image.galleryMetadata"));
    expect(decoded).not.toHaveBeenCalled(); expect(button("image.share")!.disabled).toBe(true);
    const second = session("image/gif", true, "page-two"); await render(second);
    await act(async () => oldLoad({ cacheType: "none", source: { url: first.previewUri, width: 1, height: 1, isAnimated: true } } as ImageLoadEventData));
    expect(decoded).not.toHaveBeenCalled(); await load(second); expect(decoded).toHaveBeenCalledOnce();
    await act(async () => { native.state = "background"; native.listeners.forEach((listener) => listener("background")); });
    expect(close).toHaveBeenCalledOnce(); await load(second); expect(decoded).toHaveBeenCalledOnce(); expect(share).not.toHaveBeenCalled();
  });
});
