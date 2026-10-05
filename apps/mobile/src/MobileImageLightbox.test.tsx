// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ImageLoadEventData, ImageProps } from "expo-image";
import type { GestureResponderEvent, PanResponderCallbacks, PanResponderGestureState } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileImageGalleryPageSession } from "./mobile-image-gallery";
import { mobileMessage } from "./mobile-messages";

const native = vi.hoisted(() => ({ state: "active", listeners: new Set<(state: string) => void>(),
  images: new Map<string, ImageProps>(), layout: undefined as ((event: unknown) => void) | undefined,
  gestures: undefined as PanResponderCallbacks | undefined, offset: 0, spring: vi.fn(), burn: vi.fn(), valueIndex: 0, pageOffset: 0,
  autoAnimate: true, timing: vi.fn(), finishAnimation: undefined as ((result: { finished: boolean }) => void) | undefined }));
vi.mock("react-native", () => {
  const box = ({ children, testID, pointerEvents, accessibilityElementsHidden, importantForAccessibility }: {
    children?: ReactNode; testID?: string; pointerEvents?: string; accessibilityElementsHidden?: boolean; importantForAccessibility?: string;
  }) => createElement("div", { "data-testid": testID, "data-pointer-events": pointerEvents,
    "aria-hidden": accessibilityElementsHidden, "data-accessibility": importantForAccessibility }, children);
  return { View: ({ children, accessibilityRole, onLayout }: { children?: ReactNode; accessibilityRole?: string; onLayout?: (event: unknown) => void }) => {
    if (accessibilityRole === "image") native.layout = onLayout;
    return createElement("div", {}, children);
  }, Text: ({ children }: { children?: ReactNode }) => createElement("span", {}, children),
    Modal: ({ children, visible }: { children?: ReactNode; visible: boolean }) => visible ? createElement("div", { role: "dialog" }, children) : null,
    ActivityIndicator: box, StatusBar: box, Platform: { OS: "android" },
    Pressable: ({ children, onPress, accessibilityLabel, disabled }: { children?: ReactNode; onPress?: () => void; accessibilityLabel?: string; disabled?: boolean }) =>
      createElement("button", { onClick: onPress, "aria-label": accessibilityLabel, disabled }, children),
    PanResponder: { create: (gestures: PanResponderCallbacks) => { native.gestures = gestures; return { panHandlers: {} }; } },
    Animated: { View: box, Value: class {
      readonly index = native.valueIndex++;
      setValue(value: number) { if (this.index === 0) native.offset = value; else if (this.index === 1) native.pageOffset = value; }
      stopAnimation() {}
      interpolate() { return 1; }
    }, spring: (...args: unknown[]) => { native.spring(...args); return { start() {} }; },
    timing: (...args: unknown[]) => { native.timing(...args); return { start(callback: (result: { finished: boolean }) => void) {
      native.finishAnimation = callback; if (native.autoAnimate) callback({ finished: true });
    } }; } },
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
  native.gestures = undefined; native.offset = 0; native.spring.mockReset();
  native.valueIndex = 0; native.pageOffset = 0; native.autoAnimate = true; native.timing.mockReset(); native.finishAnimation = undefined;
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
function touch(points = [{ x: 200, y: 150 }]): GestureResponderEvent {
  return { nativeEvent: { locationX: points[0]?.x ?? 200, locationY: points[0]?.y ?? 150,
    touches: points.map((point) => ({ locationX: point.x, locationY: point.y })) } } as GestureResponderEvent;
}
function motion(dx = 0, dy = 0, vy = 0): PanResponderGestureState {
  return { dx, dy, vy, vx: 0, numberActiveTouches: 1 } as PanResponderGestureState;
}
async function tap() {
  await act(async () => { native.gestures!.onPanResponderGrant!(touch(), motion()); native.gestures!.onPanResponderRelease!(touch(), motion()); });
}
async function drag(dx: number, dy: number, vy = 0) {
  await act(async () => {
    native.gestures!.onPanResponderGrant!(touch(), motion());
    native.gestures!.onPanResponderMove!(touch([{ x: 200 + dx, y: 150 + dy }]), motion(dx, dy, vy));
    native.gestures!.onPanResponderRelease!(touch([]), motion(dx, dy, vy));
  });
}

describe("lightbox dismissal and gesture ownership", () => {
  it("follows horizontal drags with cached neighbors, commits a distance or fast swipe, and retires bounce and slide callbacks", async () => {
    vi.useFakeTimers(); native.autoAnimate = false;
    const page = session("image/png", false); const navigate = vi.fn();
    const preview = { leaseId: "neighbor", uri: "data:image/png;base64,neighbor", width: 1, height: 1, mediaType: "image/png", animated: false };
    const gallery = { ...controls(page), onNavigate: navigate, adjacentPreviews: [{ pageIndex: 1, preview }] };
    await act(async () => root.render(createElement(MobileImageLightbox, { session: page, locale: "en", onClose: close, onSave: save, gallery })));
    await act(async () => native.layout?.({ nativeEvent: { layout: { width: 400, height: 300 } } }));
    expect(native.images.get(preview.uri)?.autoplay).toBe(false);
    const oldNeighborError = native.images.get(preview.uri)!.onError!;
    await act(async () => native.gestures!.onPanResponderGrant!(touch(), motion()));
    await act(async () => native.gestures!.onPanResponderMove!(touch([{ x: 120, y: 150 }]), motion(-80)));
    expect(native.pageOffset).toBe(-80); expect(navigate).not.toHaveBeenCalled();
    await act(async () => native.gestures!.onPanResponderRelease!(touch([]), motion(-80)));
    expect(native.timing).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ toValue: -400, useNativeDriver: true }));
    expect(navigate).not.toHaveBeenCalled(); await act(async () => native.finishAnimation!({ finished: true }));
    expect(navigate).toHaveBeenCalledExactlyOnceWith(1); expect(native.pageOffset).toBe(0);
    navigate.mockClear();
    await drag(40, 0); expect(native.pageOffset).toBe(10); expect(navigate).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(1_000)); expect(native.pageOffset).toBe(0);
    await drag(-30, 0); expect(native.pageOffset).toBe(-30);
    await act(async () => vi.advanceTimersByTime(1_000)); expect(native.pageOffset).toBe(0); expect(navigate).not.toHaveBeenCalled();
    await act(async () => {
      native.gestures!.onPanResponderGrant!(touch(), motion());
      native.gestures!.onPanResponderMove!(touch([{ x: 170, y: 150 }]), motion(-30));
      native.gestures!.onPanResponderRelease!(touch([]), { ...motion(-30), vx: -0.801 });
    });
    expect(native.timing).toHaveBeenCalledTimes(2);
    await act(async () => native.finishAnimation!({ finished: true })); expect(navigate).toHaveBeenCalledExactlyOnceWith(1);
    navigate.mockClear(); await drag(-80, 0);
    const retired = native.finishAnimation!;
    await act(async () => native.layout?.({ nativeEvent: { layout: { width: 300, height: 400 } } }));
    await act(async () => retired({ finished: true })); expect(navigate).not.toHaveBeenCalled(); expect(native.pageOffset).toBe(0);
    await act(async () => native.gestures!.onPanResponderGrant!(touch(), motion()));
    await act(async () => native.gestures!.onPanResponderMove!(touch([{ x: 120, y: 150 }]), motion(-80)));
    await act(async () => native.gestures!.onPanResponderMove!(touch([{ x: 180, y: 150 }, { x: 220, y: 150 }]), motion(-80)));
    expect(native.pageOffset).toBe(0); await act(async () => native.gestures!.onPanResponderRelease!(touch([]), motion(-80)));
    expect(navigate).not.toHaveBeenCalled();
    await render(session("image/png", false, "different-page"));
    await act(async () => oldNeighborError({ error: "retired preview" })); expect(previewFailed).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled(); expect(output).not.toHaveBeenCalled();
  });

  it("lets pinch and zoomed pan own the whole canvas and restores overlay controls after release, cancellation and rotation", async () => {
    const page = { ...session("image/png", false), annotatable: true }; await render(page); await load(page);
    const chrome = () => host.querySelector('[data-testid="image-lightbox-chrome"]')!;
    const available = () => {
      expect(chrome().getAttribute("data-pointer-events")).toBe("box-none");
      expect(chrome().getAttribute("aria-hidden")).toBe("false");
      expect(chrome().getAttribute("data-accessibility")).toBe("auto");
    };
    const hidden = () => {
      expect(chrome().getAttribute("data-pointer-events")).toBe("none");
      expect(chrome().getAttribute("aria-hidden")).toBe("true");
      expect(chrome().getAttribute("data-accessibility")).toBe("no-hide-descendants");
    };
    available();
    await act(async () => native.gestures!.onPanResponderGrant!(touch([{ x: 150, y: 150 }, { x: 250, y: 150 }]), motion())); hidden();
    await act(async () => native.gestures!.onPanResponderMove!(touch([{ x: 100, y: 150 }, { x: 300, y: 150 }]), motion()));
    await act(async () => native.gestures!.onPanResponderRelease!(touch([]), motion())); available();
    await act(async () => native.gestures!.onPanResponderGrant!(touch(), motion())); available();
    await act(async () => native.gestures!.onPanResponderMove!(touch([{ x: 215, y: 150 }]), motion(15))); hidden();
    await act(async () => native.gestures!.onPanResponderTerminate!(touch([]), motion(15))); available();
    await act(async () => native.gestures!.onPanResponderGrant!(touch([{ x: 150, y: 150 }, { x: 250, y: 150 }]), motion())); hidden();
    const old = native.gestures!;
    const next = { ...page, ...session("image/png", false, "new-canvas"), annotatable: true }; await render(next); await load(next); available();
    await act(async () => old.onPanResponderMove!(touch([{ x: 100, y: 150 }, { x: 300, y: 150 }]), motion())); available();
    await act(async () => native.gestures!.onPanResponderGrant!(touch([{ x: 150, y: 150 }, { x: 250, y: 150 }]), motion())); hidden();
    await act(async () => native.layout?.({ nativeEvent: { layout: { width: 300, height: 400 } } })); available();
    await act(async () => button("image.annotate")!.click());
    await act(async () => native.gestures!.onPanResponderGrant!(touch(), motion())); available();
    await act(async () => native.gestures!.onPanResponderMove!(touch([{ x: 205, y: 155 }]), motion(5, 5))); available();
    await act(async () => native.gestures!.onPanResponderRelease!(touch([]), motion(5, 5))); available();
    expect(close).not.toHaveBeenCalled(); expect(output).not.toHaveBeenCalled();
  });

  it("delays single-tap dismissal for double-tap zoom and never closes after zoomed, long or returning drag gestures", async () => {
    vi.useFakeTimers();
    const page = session("image/png", false); await render(page);
    await tap(); await act(async () => vi.advanceTimersByTime(279)); expect(close).not.toHaveBeenCalled();
    await tap(); await act(async () => vi.advanceTimersByTime(300)); expect(close).not.toHaveBeenCalled();
    expect(host.textContent).toContain("2.5");
    await tap(); await act(async () => vi.advanceTimersByTime(300)); expect(close).not.toHaveBeenCalled();
    await act(async () => button("image.reset")!.click());
    await act(async () => {
      native.gestures!.onPanResponderGrant!(touch(), motion());
      native.gestures!.onPanResponderMove!(touch([{ x: 230, y: 150 }]), motion(30));
      native.gestures!.onPanResponderMove!(touch(), motion());
      native.gestures!.onPanResponderRelease!(touch(), motion());
    });
    await act(async () => vi.advanceTimersByTime(300)); expect(close).not.toHaveBeenCalled();
    await act(async () => native.gestures!.onPanResponderGrant!(touch(), motion()));
    await act(async () => vi.advanceTimersByTime(501));
    await act(async () => native.gestures!.onPanResponderRelease!(touch(), motion()));
    await act(async () => vi.advanceTimersByTime(300)); expect(close).not.toHaveBeenCalled();
    await tap(); await act(async () => vi.advanceTimersByTime(280)); expect(close).toHaveBeenCalledOnce();
    expect(decoded).not.toHaveBeenCalled(); expect(output).not.toHaveBeenCalled();
  });

  it("moves and springs a short vertical drag, closes at the distance or converted speed threshold, and preserves horizontal navigation", async () => {
    vi.useFakeTimers(); const page = session("image/png", false); await render(page);
    await drag(0, 120, 0.8); expect(close).not.toHaveBeenCalled(); expect(native.offset).toBe(120);
    expect(native.spring).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ toValue: 0, useNativeDriver: true }));
    await act(async () => vi.advanceTimersByTime(1_000)); expect(native.offset).toBe(0);
    const navigate = vi.fn();
    await act(async () => root.render(createElement(MobileImageLightbox, { session: page, locale: "en", onClose: close, onSave: save,
      gallery: { ...controls(page), onNavigate: navigate } })));
    await drag(-80, 10); expect(navigate).toHaveBeenCalledWith(1); expect(close).not.toHaveBeenCalled();
    await drag(0, -121); expect(close).toHaveBeenCalledOnce();
    await render(session("image/png", false, "fast-page"));
    await drag(0, 20, 0.801); expect(close).toHaveBeenCalledTimes(2); expect(output).not.toHaveBeenCalled();
  });

  it("retires pending taps and old callbacks on page, orientation, annotation, multi-touch, effects and background changes", async () => {
    vi.useFakeTimers(); const first = { ...session("image/png", false), annotatable: true }; await render(first); await load(first);
    await tap(); const old = native.gestures!;
    const second = { ...first, ...session("image/png", false, "second"), annotatable: true }; await render(second); await load(second);
    await act(async () => { old.onPanResponderGrant!(touch(), motion()); old.onPanResponderRelease!(touch(), motion()); });
    await act(async () => vi.advanceTimersByTime(300)); expect(close).not.toHaveBeenCalled();
    await tap(); await act(async () => native.layout?.({ nativeEvent: { layout: { width: 300, height: 400 } } }));
    await act(async () => vi.advanceTimersByTime(300)); expect(close).not.toHaveBeenCalled();
    await tap(); await act(async () => button("image.annotate")!.click()); await drag(0, 150, 1);
    await act(async () => vi.advanceTimersByTime(300)); expect(close).not.toHaveBeenCalled();
    await act(async () => button("image.annotate")!.click());
    await tap(); await act(async () => {
      native.gestures!.onPanResponderGrant!(touch(), motion());
      native.gestures!.onPanResponderMove!(touch([{ x: 180, y: 150 }, { x: 220, y: 150 }]), motion(0, 150, 1));
      native.gestures!.onPanResponderMove!(touch([{ x: 200, y: 290 }]), motion(0, 140, 1));
      native.gestures!.onPanResponderRelease!(touch([]), motion(0, 140, 1));
    });
    await act(async () => vi.advanceTimersByTime(300)); expect(close).not.toHaveBeenCalled(); expect(native.offset).toBe(0);
    await act(async () => button("common.discard")!.click());
    let finish!: () => void;
    output.mockImplementationOnce(async () => new Promise<void>((resolve) => { finish = resolve; }));
    await tap(); await act(async () => button("image.copy")!.click());
    expect(output).toHaveBeenCalledOnce();
    await drag(0, 150, 1); await act(async () => vi.advanceTimersByTime(300)); expect(close).not.toHaveBeenCalled();
    await act(async () => finish());
    await tap(); await act(async () => { native.state = "background"; native.listeners.forEach((listener) => listener("background")); });
    expect(close).toHaveBeenCalledOnce(); await act(async () => vi.advanceTimersByTime(300)); expect(close).toHaveBeenCalledOnce();
  });

  it("keeps the active lease closeable when a parent replaces its callback and clears timers at unmount", async () => {
    vi.useFakeTimers(); const page = session("image/png", false); await render(page); await tap();
    const nextClose = vi.fn();
    await act(async () => root.render(createElement(MobileImageLightbox, { session: page, locale: "en", onClose: nextClose, onSave: save, gallery: controls(page) })));
    await act(async () => vi.advanceTimersByTime(280)); expect(nextClose).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled();
    await render(session("image/png", false, "unmount-page")); await tap();
    await act(async () => root.render(null)); await act(async () => vi.advanceTimersByTime(300)); expect(close).not.toHaveBeenCalled();
  });
});

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
