// @vitest-environment jsdom
import { act, createElement, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { FileKind, WorkspaceEntrySchema } from "@joko/contracts";
import type { ImageProps } from "expo-image";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileFilesThumbnailPreview } from "./mobile-files-thumbnails";

const native = vi.hoisted(() => ({ state: "active", listeners: new Set<(state: string) => void>(), images: new Map<string, ImageProps>() }));
vi.mock("react-native", () => ({ View: ({ children }: { children?: ReactNode }) => createElement("div", {}, children),
  Text: ({ children, numberOfLines, allowFontScaling }: { children?: ReactNode; numberOfLines?: number; allowFontScaling?: boolean }) => createElement("span", { "data-lines": numberOfLines, "data-font-scaling": String(allowFontScaling) }, children),
  Platform: { select: (value: { android: unknown }) => value.android }, StyleSheet: { create: (value: unknown) => value }, AppState: { get currentState() { return native.state; }, addEventListener: (_event: string, listener: (state: string) => void) => {
    native.listeners.add(listener); return { remove: () => native.listeners.delete(listener) };
  } } }));
vi.mock("expo-image", () => ({ Image: (props: ImageProps) => {
  const source = props.source as { uri: string }; native.images.set(source.uri, props);
  const styleInput: unknown[] = [props.style]; const style = Object.assign({}, ...styleInput.flat(Infinity).filter(Boolean));
  return createElement("span", { "data-image": source.uri, "data-opacity": style.opacity ?? 1 });
} }));
import { MobileFileThumbnail } from "./MobileFileThumbnail";

type Props = ComponentProps<typeof MobileFileThumbnail>;
const prepare = vi.fn<NonNullable<Props["client"]>["prepareFilesThumbnail"]>();
const confirm = vi.fn<NonNullable<Props["client"]>["confirmFilesThumbnail"]>();
const release = vi.fn<NonNullable<Props["client"]>["releaseFilesThumbnail"]>();
let host: HTMLDivElement; let root: Root | undefined; let props: Props;
function image(id: string): MobileFilesThumbnailPreview { return { leaseId: id, content: { kind: "image", uri: "data:image/webp;base64," + id, width: 256, height: 128, mediaType: "image/webp", animated: false } }; }
function source(mediaType = "image/png") { return { kind: "workspace-entry" as const, entry: create(WorkspaceEntrySchema, { workspaceId: "workspace", relativePath: "current", kind: FileKind.REGULAR, mediaType }) }; }
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.useFakeTimers(); native.state = "active"; native.images.clear(); prepare.mockReset(); confirm.mockReset(); release.mockReset();
  let id = 0; prepare.mockImplementation(async () => image("image-" + ++id));
  props = { client: { prepareFilesThumbnail: prepare, confirmFilesThumbnail: confirm, releaseFilesThumbnail: release }, source: source(), ownerKey: "current-owner",
    scopeKey: "current-folder", enabled: true, grid: true, colors: { surface: "white", border: "gray", muted: "black" }, children: "type glyph" };
  host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host.remove(); native.listeners.clear(); vi.useRealTimers(); Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT"); });
async function render(changes: Partial<Props> = {}) { props = { ...props, ...changes }; await act(async () => root!.render(createElement(MobileFileThumbnail, props))); }
async function tick(milliseconds = 200) { await act(async () => vi.advanceTimersByTimeAsync(milliseconds)); }
async function background(state: string) { native.state = state; await act(async () => { for (const listener of native.listeners) listener(state); }); }

describe("mounted decorative Files miniatures", () => {
  it("waits for cell residence, verifies native load, cancels replaced/background sources and ignores old callbacks", async () => {
    await render(); await tick(199); expect(prepare).not.toHaveBeenCalled(); await tick(1);
    expect(prepare).toHaveBeenCalledExactlyOnceWith("current-owner", props.source, expect.any(AbortSignal));
    const uri = "data:image/webp;base64,image-1"; const imageProps = native.images.get(uri)!;
    expect(imageProps).toMatchObject({ contentFit: "cover", cachePolicy: "none", autoplay: false }); expect(host.querySelector("[data-image]")?.getAttribute("data-opacity")).toBe("0");
    const load = { cacheType: "none" as const, source: { url: uri, width: 256, height: 128, mediaType: "image/webp", isAnimated: false } };
    await act(async () => imageProps.onLoad!(load)); expect(confirm).toHaveBeenCalledWith("image-1", load.source);
    expect(host.querySelector("[data-image]")?.getAttribute("data-opacity")).toBe("1");
    await render({ source: source() }); expect(prepare.mock.calls[0]![2].aborted).toBe(true); expect(release).toHaveBeenCalledWith("image-1"); expect(host.querySelector("[data-image]")).toBeNull();
    await act(async () => imageProps.onLoad!(load)); expect(confirm).toHaveBeenCalledOnce();
    await tick(); await background("background"); expect(prepare.mock.calls[1]![2].aborted).toBe(true); expect(host.querySelector("[data-image]")).toBeNull();
    await background("active"); await tick(); expect(prepare).toHaveBeenCalledTimes(3); await render({ enabled: false }); expect(release).toHaveBeenCalledWith("image-3");
  });
  it("renders actual document text, never adopts a late old image and leaves failures as silent placeholders", async () => {
    let finish!: (preview: MobileFilesThumbnailPreview) => void;
    prepare.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await render(); await tick(); prepare.mockResolvedValue({ leaseId: "doc", content: { kind: "text", text: "# actual source\nconst answer = 42" } });
    await render({ source: source("text/markdown") }); await tick(); expect(host.textContent).toContain("# actual source");
    expect(host.querySelector('[data-lines="14"]')?.getAttribute("data-font-scaling")).toBe("false");
    await act(async () => finish(image("old-image"))); expect(release).toHaveBeenCalledWith("old-image"); expect(host.querySelector("[data-image]")).toBeNull();
    prepare.mockRejectedValue(new Error("Private transport error")); await render({ scopeKey: "new-folder" }); await tick();
    expect(host.textContent).not.toContain("error"); expect(host.textContent).not.toContain("actual source");
    await render({ source: { kind: "workspace-entry", entry: create(WorkspaceEntrySchema, { kind: FileKind.DIRECTORY }) } }); await tick();
    expect(host.textContent).toBe("type glyph"); expect(prepare).toHaveBeenCalledTimes(3);
  });
  it("releases failed or unconfirmed native images without automatic retries, and skips cells unmounted before residence", async () => {
    await render(); await tick(); await act(async () => native.images.get("data:image/webp;base64,image-1")!.onError!({ error: "failed" }));
    expect(release).toHaveBeenCalledWith("image-1", true); expect(host.querySelector("[data-image]")).toBeNull(); await tick(500); expect(prepare).toHaveBeenCalledOnce();
    await render({ scopeKey: "next" }); await tick(); await tick(12_000); expect(release).toHaveBeenCalledWith("image-2", true);
    await render({ scopeKey: "fast-scroll" }); await act(async () => root!.unmount()); root = undefined; await tick(); expect(prepare).toHaveBeenCalledTimes(2);
  });
});
