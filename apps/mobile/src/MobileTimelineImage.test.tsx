// @vitest-environment jsdom
import { act, createElement, forwardRef, useImperativeHandle, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { View } from "react-native";
import type { ImageLoadEventData, ImageProps } from "expo-image";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileTimelineImagePreview } from "./mobile-timeline-images";
import { mobileMessage } from "./mobile-messages";

const native = vi.hoisted(() => ({ state: "active", listeners: new Set<(state: string) => void>(),
  rect: [0, 80, 280, 140], images: new Map<string, ImageProps>(),
  buttons: new Map<string, { style: unknown; disabled?: boolean }>() }));
vi.mock("react-native", () => {
  const box = ({ children }: { children?: ReactNode }) => createElement("div", {}, children);
  return { View: forwardRef(({ children }: { children?: ReactNode }, ref) => {
    useImperativeHandle(ref, () => ({ measureInWindow: (callback: (...rect: number[]) => void) => callback(...native.rect) }));
    return createElement("div", {}, children);
  }), Text: ({ children }: { children?: ReactNode }) => createElement("span", {}, children), ActivityIndicator: box,
    Pressable: ({ children, onPress, accessibilityLabel, disabled, style }: {
      children?: ReactNode; onPress?: () => void; accessibilityLabel: string; disabled?: boolean; style?: unknown;
    }) => {
      native.buttons.set(accessibilityLabel, { style, ...(disabled === undefined ? {} : { disabled }) });
      return createElement("button", { onClick: onPress, "aria-label": accessibilityLabel, disabled }, children);
    }, StyleSheet: { create: (value: unknown) => value },
    AppState: { get currentState() { return native.state; }, addEventListener: (_event: string, listener: (state: string) => void) => {
      native.listeners.add(listener); return { remove: () => native.listeners.delete(listener) };
    } }
  };
});
vi.mock("expo-image", () => ({ Image: (props: ImageProps) => {
  const source = props.source as { uri: string }; native.images.set(source.uri, props); return createElement("span", { "data-image": source.uri });
} }));
import { MobileTimelineImage } from "./MobileTimelineImage";

type Props = ComponentProps<typeof MobileTimelineImage>;
const prepare = vi.fn<Props["client"]["prepareTimelineImagePreview"]>();
const confirm = vi.fn<Props["client"]["confirmTimelineImagePreview"]>();
const release = vi.fn<Props["client"]["releaseTimelineImagePreview"]>();
const open = vi.fn();
let host: HTMLDivElement; let root: Root; let props: Props;
function image(id: string): MobileTimelineImagePreview {
  return { leaseId: id, uri: `data:image/png;base64,${id}`, width: 800, height: 400, mediaType: "image/png", animated: false };
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); native.state = "active"; native.rect = [0, 80, 280, 140];
  native.images.clear(); native.buttons.clear(); prepare.mockReset(); confirm.mockReset(); release.mockReset(); open.mockReset();
  let next = 0; prepare.mockImplementation(async () => image(`preview-${++next}`));
  props = { client: { prepareTimelineImagePreview: prepare, confirmTimelineImagePreview: confirm, releaseTimelineImagePreview: release },
    page: { pageId: "canonical-page", title: "diagram.png", mediaType: "image/png", byteSize: 200, sha256Hex: "a".repeat(64), widthPixels: 800, heightPixels: 400 },
    eventId: "canonical-event", ownerKey: "current-task", eligible: true, viewportPulse: 0,
    viewportRef: { current: { measureInWindow: (callback: (...rect: number[]) => void) => callback(0, 0, 400, 300) } as unknown as View },
    maximumWidth: 330, openLabel: "Open diagram", disabled: false, locale: "en", colors: { accent: "blue", muted: "gray", background: "white" }, onOpen: open };
  host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); native.listeners.clear(); vi.useRealTimers();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});
async function render(changes: Partial<Props> = {}) {
  props = { ...props, ...changes }; await act(async () => root.render(createElement(MobileTimelineImage, props)));
}
function button(label: string) { return Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((node) => node.getAttribute("aria-label") === label); }
function loadData(uri: string): ImageLoadEventData {
  return { cacheType: "none", source: { url: uri, width: 800, height: 400, mediaType: "image/png", isAnimated: false } };
}
async function load(id = "preview-1") {
  const uri = image(id).uri; await act(async () => native.images.get(uri)!.onLoad!(loadData(uri)));
}
async function decodeError(id: string) { await act(async () => native.images.get(image(id).uri)!.onError!({ error: "decoder failed" })); }

describe("visible canonical Timeline image presentation", () => {
  it("loads only an intersecting image, verifies native metadata, contains the actual bitmap and opens Gallery", async () => {
    native.rect = [0, 500, 280, 140]; await render(); expect(prepare).not.toHaveBeenCalled();
    await act(async () => button("Open diagram")!.click()); expect(open).toHaveBeenCalledOnce();
    native.rect = [0, 80, 280, 140]; await render({ viewportPulse: 1 });
    expect(prepare).toHaveBeenCalledExactlyOnceWith("canonical-event", "canonical-page", expect.any(AbortSignal));
    expect(host.textContent).toContain(mobileMessage("en", "image.previewLoading"));
    expect(native.images.get(image("preview-1").uri)).toMatchObject({ contentFit: "fill", cachePolicy: "none", autoplay: true });
    expect(Object.assign({}, ...(native.buttons.get("Open diagram")!.style as object[]))).toMatchObject({ width: 280, height: 140, minWidth: 44, minHeight: 44 });
    await load(); expect(confirm).toHaveBeenCalledExactlyOnceWith("preview-1", loadData(image("preview-1").uri).source);
    expect(host.textContent).not.toContain(mobileMessage("en", "image.previewLoading"));
    await act(async () => button("Open diagram")!.click()); expect(open).toHaveBeenCalledTimes(2);
    const oldLoad = native.images.get(image("preview-1").uri)!.onLoad!;
    native.rect = [0, -200, 280, 140]; await render({ viewportPulse: 2 });
    expect(prepare.mock.calls[0]![2].aborted).toBe(true); expect(release).toHaveBeenCalledWith("preview-1");
    expect(host.querySelector("[data-image]")).toBeNull();
    await act(async () => oldLoad(loadData(image("preview-1").uri))); expect(confirm).toHaveBeenCalledOnce();
  });

  it("keeps the presentation aspect inside an independently bounded 44px hit target", async () => {
    prepare.mockResolvedValueOnce({ ...image("wide-preview"), width: 1_000, height: 100 });
    await render();
    const presented = native.images.get(image("wide-preview").uri)!;
    const presentationStyle = Object.assign({}, ...(presented.style as object[])) as { width: number; height: number };
    expect(presentationStyle.width).toBe(280); expect(presentationStyle.height).toBeCloseTo(28);
    expect(Object.assign({}, ...(native.buttons.get("Open diagram")!.style as object[]))).toMatchObject({
      width: 280, height: 44, minWidth: 44, minHeight: 44
    });
  });

  it("refetches a native failure once, preserves the Gallery entry and offers an accessible explicit retry", async () => {
    await render(); await decodeError("preview-1"); expect(prepare).toHaveBeenCalledTimes(2); expect(release).toHaveBeenCalledWith("preview-1", true);
    await decodeError("preview-2"); expect(prepare).toHaveBeenCalledTimes(2); expect(host.querySelector("[data-image]")).toBeNull();
    expect(host.textContent).toContain(mobileMessage("en", "image.previewFailed"));
    const label = mobileMessage("en", "image.previewRetry", { name: "diagram.png" });
    expect(native.buttons.get(label)!.style).toMatchObject({ minHeight: 44, minWidth: 44 });
    await act(async () => button("Open diagram")!.click()); expect(open).toHaveBeenCalledOnce();
    await act(async () => button(label)!.click()); expect(prepare).toHaveBeenCalledTimes(3); await load("preview-3");
    expect(confirm).toHaveBeenCalledOnce(); expect(button(label)).toBeUndefined();
  });

  it("discards mismatched metadata and an undecoded bitmap after its deadline without starting an automatic loop", async () => {
    vi.useFakeTimers(); confirm.mockImplementationOnce(() => { throw new Error("native source mismatch"); });
    await render(); await load(); expect(prepare).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledWith("preview-1", true);
    const label = mobileMessage("en", "image.previewRetry", { name: "diagram.png" });
    await act(async () => button(label)!.click()); expect(prepare).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTime(12_000)); expect(release).toHaveBeenCalledWith("preview-2", true);
    expect(prepare).toHaveBeenCalledTimes(2); expect(host.textContent).toContain(mobileMessage("en", "image.previewFailed"));
  });

  it("retires backgrounded or covered rows and does not adopt a recycled source's late bytes or native callback", async () => {
    let finish!: (value: MobileTimelineImagePreview) => void;
    prepare.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })); await render();
    const oldSignal = prepare.mock.calls[0]![2];
    await render({ page: { ...props.page, pageId: "new-page", sha256Hex: "b".repeat(64) } });
    expect(oldSignal.aborted).toBe(true); expect(prepare.mock.calls[1]![1]).toBe("new-page");
    await act(async () => finish(image("retired-preview")));
    expect(release).toHaveBeenCalledWith("retired-preview"); expect(host.querySelector('[data-image="' + image("retired-preview").uri + '"]')).toBeNull();
    const currentImage = image("preview-1"); const oldLoad = native.images.get(currentImage.uri)!.onLoad!;
    await act(async () => { native.state = "background"; native.listeners.forEach((listener) => listener("background")); });
    expect(prepare.mock.calls[1]![2].aborted).toBe(true); expect(release).toHaveBeenCalledWith("preview-1");
    expect(host.querySelector("[data-image]")).toBeNull();
    await act(async () => oldLoad(loadData(currentImage.uri))); expect(confirm).not.toHaveBeenCalled();
    await render({ eligible: false });
    await act(async () => { native.state = "active"; native.listeners.forEach((listener) => listener("active")); });
    expect(prepare).toHaveBeenCalledTimes(2); expect(button("Open diagram")).toBeDefined();
  });
});
