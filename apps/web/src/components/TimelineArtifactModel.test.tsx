// @vitest-environment jsdom

import { act, StrictMode, type JSX } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ArtifactView, TimelineItemView } from "../model.js";
import { ArtifactBlock, MessageAttachment } from "./Timeline.js";
import { TimelineArtifactModel } from "./TimelineArtifactModel.js";
import { NativeFileActionsContext } from "./NativeFileCopyMenu.js";
import { useTimelineArtifactUrlCache } from "./timeline-artifact-url-cache.js";
import type { Translator } from "./types.js";

vi.mock("./workspace-model-runtime.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./workspace-model-runtime.js")>(),
  ensureWorkspaceModelViewer: vi.fn(async () => undefined)
}));

class PreviewModel extends HTMLElement {
  loaded = false;
  getCameraOrbit = () => ({ theta: 1, phi: 2, radius: 3 });
  jumpCameraToGoal = vi.fn();
}

const roots: Root[] = [];
const fetchSource = vi.fn<typeof fetch>();
const createUrl = vi.fn<(blob: Blob) => string>();
const revokeUrl = vi.fn<(url: string) => void>();
const t: Translator = (key, values) => `${key}${values?.name === undefined ? "" : `:${String(values.name)}`}`;

beforeAll(() => { customElements.define("model-viewer", PreviewModel); });
beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  createUrl.mockReset().mockImplementation(() => `blob:materialized-${createUrl.mock.calls.length}`);
  revokeUrl.mockReset();
  fetchSource.mockReset();
  vi.stubGlobal("fetch", fetchSource);
  vi.stubGlobal("URL", class extends URL {
    static override createObjectURL = createUrl;
    static override revokeObjectURL = revokeUrl;
  });
  Reflect.deleteProperty(window, "jokoDesktop");
});
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0).reverse()) root.unmount(); });
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  document.body.className = "";
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.deleteProperty(window, "jokoDesktop");
});

describe("Timeline model previews", () => {
  it("opens both artifact entries on demand, validates self-contained GLB/glTF and retains downloads", async () => {
    const acquire = vi.fn(async (id: string) => `blob:${id}`);
    const release = vi.fn();
    const download = vi.fn();
    fetchSource.mockImplementation(async (input) => String(input).endsWith("glb")
      ? new Response(glb({ asset: { version: "2.0" } }))
      : new Response(JSON.stringify({ asset: { version: "2.0" }, buffers: [{ uri: "data:application/octet-stream;base64,AAAA", byteLength: 3 }] })));
    const model = artifact("glb", "robot.glb", "application/octet-stream");
    const standalone = artifact("gltf", "scene.data", " Model/GLTF+JSON; charset=utf-8 ");
    function Entries(): JSX.Element {
      const loadUrl = useTimelineArtifactUrlCache("owner", acquire, release);
      return <>
        <MessageAttachment artifact={model} t={t} onArtifactUrl={loadUrl} onArtifactDownload={download} />
        <ArtifactBlock item={item(standalone)} icon={<span />} locale="en" t={t} onArtifactUrl={loadUrl} onArtifactDownload={download} />
        <MessageAttachment artifact={artifact("other", "scene.fbx", "application/octet-stream")} t={t} onArtifactUrl={loadUrl} onArtifactDownload={download} />
      </>;
    }
    const root = await mount(<StrictMode><Entries /></StrictMode>);
    const openers = [...document.querySelectorAll<HTMLButtonElement>('button[aria-label^="workspace.modelOpen:"]')];
    expect(openers).toHaveLength(2);
    expect(acquire).not.toHaveBeenCalled();
    expect(fetchSource).not.toHaveBeenCalled();
    for (const [index, opener] of openers.entries()) {
      await act(async () => opener.click());
      const viewer = document.querySelector("model-viewer") as unknown as PreviewModel;
      expect(viewer).toBeInstanceOf(PreviewModel);
      expect(viewer.hasAttribute("camera-controls")).toBe(true);
      expect(viewer.hasAttribute("autoplay")).toBe(true);
      await act(async () => viewer.dispatchEvent(new Event("load")));
      expect(document.querySelector('[role="dialog"] .workspace-model-viewer')?.getAttribute("data-load-state")).toBe("ready");
      await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="workspace.modelZoomIn"]')!.click());
      expect(viewer.jumpCameraToGoal).toHaveBeenCalled();
      await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="workspace.downloadFile"]')!.click());
      expect(download).toHaveBeenLastCalledWith(index === 0 ? "glb" : "gltf", index === 0 ? "robot.glb" : "scene.data", { ownerDocument: document, signal: expect.any(AbortSignal) });
      await close();
      expect(document.activeElement).toBe(opener);
      expect(viewer.isConnected).toBe(false);
      expect(viewer.hasAttribute("src")).toBe(false);
    }
    expect(acquire.mock.calls).toEqual([["glb"], ["gltf"]]);
    expect(revokeUrl).toHaveBeenCalledWith("blob:materialized-1");
    await act(async () => root.render(null));
    expect(release.mock.calls).toEqual([["glb"], ["gltf"]]);
  });

  it("reports missing dependencies without fetching paths or external URLs and keeps download available", async () => {
    const download = vi.fn();
    const source = artifact("model", "scene.gltf", "model/gltf+json");
    const root = await mount(<TimelineArtifactModel artifact={source} ownerKey="one" loadUrl={async () => "blob:source"} onDownload={download} t={t} />);
    for (const uri of ["geometry.bin", "https://example.invalid/geometry.bin", "../../private.bin"]) {
      fetchSource.mockResolvedValue(new Response(JSON.stringify({ asset: { version: "2.0" }, buffers: [{ uri }] })));
      await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label^="workspace.modelOpen:"]')!.click());
      const error = document.querySelector('[role="dialog"] [role="alert"]')?.textContent;
      expect(error).toBe(uri === "geometry.bin" ? "workspace.modelDependenciesUnavailable" : "workspace.modelUnavailable");
      expect(document.querySelector("model-viewer")).toBeNull();
      expect(document.querySelector<HTMLButtonElement>('button[aria-label="workspace.modelZoomIn"]')?.disabled).toBe(true);
      await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="workspace.downloadFile"]')!.click());
      await close();
    }
    expect(download).toHaveBeenCalledTimes(3);
    expect(fetchSource.mock.calls.map(([url]) => url)).toEqual(["blob:source", "blob:source", "blob:source"]);
    expect(createUrl).not.toHaveBeenCalled();
    await act(async () => root.render(null));
  });

  it("offers the exact canonical model to the default app even when preview decoding fails", async () => {
    Object.defineProperty(window, "jokoDesktop", { configurable: true, value: { capabilities: ["files.open"] } });
    const openFile = vi.fn<import("../model.js").OperationApi["openArtifactFile"]>().mockResolvedValue({ status: "opened" });
    const source = artifact("model", "scene.gltf", "model/gltf+json");
    fetchSource.mockResolvedValue(new Response(JSON.stringify({ asset: { version: "2.0" }, buffers: [{ uri: "geometry.bin" }] })));
    await mount(<NativeFileActionsContext.Provider value={{ openFile }}><TimelineArtifactModel artifact={source} ownerKey="one" loadUrl={async () => "blob:source"} onDownload={vi.fn()} t={t} /></NativeFileActionsContext.Provider>);
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label^="workspace.modelOpen:"]')!.click());
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe("workspace.modelDependenciesUnavailable");
    const menu = document.querySelector<HTMLDetailsElement>('[role="dialog"] details')!;
    menu.open = true;
    await act(async () => menu.querySelector<HTMLButtonElement>('[role="menuitem"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(menu.open).toBe(false);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => menu.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
    expect(openFile).toHaveBeenCalledWith("model", "scene.gltf", 100, { ownerDocument: document, signal: expect.any(AbortSignal) });
    expect(document.querySelector('[role="status"]')?.textContent).toBe("media.fileOpened");
  });

  it("retires pending materialization and the open viewer on task changes without disturbing the next owner", async () => {
    const late = deferred<string>();
    const acquire = vi.fn(async () => `blob:lease-${acquire.mock.calls.length}`);
    const release = vi.fn();
    const source = artifact("shared", "scene.gltf", "model/gltf+json");
    fetchSource.mockImplementation(async (input) => String(input) === "blob:lease-1"
      ? { ok: true, text: () => late.promise } as Response
      : new Response('{"asset":{"version":"2.0"}}'));
    function Entry({ owner }: { readonly owner: string }): JSX.Element {
      const loadUrl = useTimelineArtifactUrlCache(owner, acquire, release);
      return <TimelineArtifactModel artifact={source} ownerKey={owner} loadUrl={loadUrl} onDownload={vi.fn()} t={t} />;
    }
    const root = await mount(<Entry owner="profile-a" />);
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label^="workspace.modelOpen:"]')!.click());
    expect(document.querySelector('[role="dialog"] [role="status"]')).not.toBeNull();
    await act(async () => root.render(<Entry owner="profile-b" />));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const nextTrigger = document.querySelector<HTMLButtonElement>('button[aria-label^="workspace.modelOpen:"]')!;
    const focus = vi.spyOn(nextTrigger, "focus");
    await act(async () => nextTrigger.click());
    const nextViewer = document.querySelector("model-viewer")!;
    expect(nextViewer.getAttribute("src")).toBe("blob:materialized-1");
    await act(async () => late.resolve('{"asset":{"version":"2.0"}}'));
    expect(revokeUrl.mock.calls).toEqual([["blob:materialized-2"]]);
    expect(document.querySelector("model-viewer")).toBe(nextViewer);
    expect(focus).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    await act(async () => root.render(null));
    expect(revokeUrl).toHaveBeenCalledWith("blob:materialized-1");
    expect(nextViewer.hasAttribute("src")).toBe(false);
    expect(release).toHaveBeenCalledTimes(2);
  });
});

async function mount(content: JSX.Element): Promise<Root> {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(content));
  return root;
}

async function close(): Promise<void> {
  await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="common.close"]')!.click());
  await act(async () => vi.advanceTimersByTime(200));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
}

function artifact(blobId: string, fileName: string, mediaType: string): ArtifactView {
  return { id: blobId, blobId, sourceRevealAvailable: false, title: fileName, fileName, mediaType, byteSize: 100, kind: "file" };
}

function item(artifact: ArtifactView): TimelineItemView {
  return { id: "result", kind: "artifact", sequence: 1n, createdAt: 0, artifact };
}

function glb(document: unknown): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(document));
  const length = Math.ceil(json.byteLength / 4) * 4;
  const buffer = new ArrayBuffer(20 + length);
  const view = new DataView(buffer);
  [0x46546c67, 2, buffer.byteLength, length, 0x4e4f534a].forEach((value, index) => view.setUint32(index * 4, value, true));
  const bytes = new Uint8Array(buffer);
  bytes.fill(0x20, 20);
  bytes.set(json, 20);
  return buffer;
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}
