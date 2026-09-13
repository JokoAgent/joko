// @vitest-environment jsdom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import type { WorkspaceFilePreviewView } from "../model.js";
import { WorkspaceFileBody } from "./WorkspaceFileBody.js";
import type { MaterializeWorkspaceGltfSourceInput } from "./workspace-gltf-source.js";
import type { WorkspaceMarkdownImageResolver, WorkspaceMarkdownResolvedImage } from "./workspace-markdown-images.js";
import { WORKSPACE_MARKDOWN_IMAGE_OPEN_EVENT } from "./workspace-markdown-images.js";

const boundary = vi.hoisted(() => ({ resolver: undefined as WorkspaceMarkdownImageResolver | undefined, models: [] as MaterializeWorkspaceGltfSourceInput[], loadInLayout: false, images: [] as (WorkspaceMarkdownResolvedImage | undefined)[] }));
vi.mock("./WorkspaceTextEditor.js", async () => {
  const { useLayoutEffect } = await import("react");
  return { WorkspaceTextEditor: (props: { readonly markdownImageResolver?: WorkspaceMarkdownImageResolver }) => {
    boundary.resolver = props.markdownImageResolver;
    useLayoutEffect(() => {
      if (boundary.loadInLayout) void props.markdownImageResolver?.("image.png").then((image) => boundary.images.push(image));
    }, [props.markdownImageResolver]);
    return <div />;
  } };
});
vi.mock("./workspace-gltf-source.js", () => ({ materializeWorkspaceModelSource: (input: MaterializeWorkspaceGltfSourceInput) => {
  boundary.models.push(input);
  return new Promise(() => undefined);
} }));

const roots: Root[] = [];
beforeAll(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => { boundary.resolver = undefined; boundary.models.length = 0; boundary.loadInLayout = false; boundary.images.length = 0; });
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Workspace file resource ownership", () => {
  it("admits the mounted Markdown editor after layout replay while retiring the earlier generation", async () => {
    boundary.loadInLayout = true;
    const current = controller(async () => "blob:current-layout");
    const mounted = await mount(current.value, markdownPreview(), true);
    expect(boundary.images.some((image) => image?.url === "blob:current-layout")).toBe(true);
    expect(current.acquire).toHaveBeenCalledTimes(1);
    await mounted.unmount();
    expect(current.release).toHaveBeenCalledExactlyOnceWith("shared-blob");
  });

  it("closes a Markdown image when the same profile replaces its artifact gateway", async () => {
    const first = controller(async () => "blob:old-open-image");
    const second = controller(async () => "blob:new-open-image");
    const mounted = await mount(first.value, markdownPreview());
    const image = await boundary.resolver!("image.png");
    const holder = document.createElement("button");
    mounted.container.querySelector(".workspace-file-body__source")!.append(holder);
    act(() => holder.dispatchEvent(new CustomEvent(WORKSPACE_MARKDOWN_IMAGE_OPEN_EVENT, { bubbles: true, detail: { ...image, returnFocus: holder } })));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await mounted.render(second.value);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(first.release).toHaveBeenCalledExactlyOnceWith("shared-blob");
    expect(second.release).not.toHaveBeenCalled();
  });

  it.each([
    ["image", "pending"], ["image", "ready"], ["audio", "pending"], ["audio", "ready"]
  ] as const)("keeps a %s %s lease with its original gateway when the same profile reconnects", async (kind, phase) => {
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    const oldUrl = deferred<string>();
    const first = controller(() => oldUrl.promise);
    const second = controller(async () => "blob:new-gateway");
    const mounted = await mount(first.value, kind === "image" ? imagePreview("image.png") : audioPreview());
    if (phase === "ready") await act(async () => oldUrl.resolve("blob:old-gateway"));
    await mounted.render(second.value);
    expect(second.acquire).toHaveBeenCalledTimes(1);
    expect(mounted.container.querySelector(kind === "image" ? "img" : "audio")?.getAttribute("src")).toBe("blob:new-gateway");
    await act(async () => oldUrl.resolve("blob:old-gateway"));
    expect(first.release).toHaveBeenCalledExactlyOnceWith("shared-blob");
    expect(second.release).not.toHaveBeenCalled();
    expect(mounted.container.querySelector(kind === "image" ? "img" : "audio")?.getAttribute("src")).toBe("blob:new-gateway");
    await mounted.render({ ...second.value, state: { ...second.value.state } });
    expect(second.acquire).toHaveBeenCalledTimes(1);
    await mounted.unmount();
    expect(first.release).toHaveBeenCalledTimes(1);
    expect(second.release).toHaveBeenCalledExactlyOnceWith("shared-blob");
  });

  it("keeps audio download and decode failures scoped to the active source and gateway", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    const failedDownload = deferred<"dispatched">();
    const first = controller(async () => "blob:old-audio");
    const second = controller(async () => "blob:new-audio");
    const firstDownload = vi.fn(() => failedDownload.promise);
    const nextDownload = vi.fn().mockRejectedValueOnce(new Error("download failed")).mockResolvedValue(undefined);
    first.value.downloadArtifact = firstDownload;
    second.value.downloadArtifact = nextDownload;
    const mounted = await mount(first.value, audioPreview());
    const download = mounted.container.querySelector<HTMLButtonElement>(".workspace-file-body__download")!;
    await act(async () => { download.click(); download.click(); });
    expect(firstDownload).toHaveBeenCalledExactlyOnceWith("shared-blob", "recording.wav", { ownerDocument: document, signal: expect.any(AbortSignal) });
    const firstSignal = (firstDownload.mock.calls[0] as unknown as [string, string, { signal: AbortSignal }])[2].signal;
    expect(download.getAttribute("aria-busy")).toBe("true");
    await mounted.render(second.value);
    expect(firstSignal.aborted).toBe(true);
    await act(async () => failedDownload.reject(new Error("old gateway download failed")));
    expect(mounted.container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => mounted.container.querySelector("audio")!.dispatchEvent(new Event("error")));
    expect(mounted.container.querySelector('[role="alert"]')?.textContent).toBe("This file cannot be previewed in Joko.");
    const currentDownload = mounted.container.querySelector<HTMLButtonElement>(".workspace-file-body__download")!;
    expect(currentDownload.disabled).toBe(false);
    await act(async () => currentDownload.click());
    expect(nextDownload).toHaveBeenCalledExactlyOnceWith("shared-blob", "recording.wav", { ownerDocument: document, signal: expect.any(AbortSignal) });
    expect([...mounted.container.querySelectorAll('[role="alert"]')].some((element) => element.textContent === "Download is unavailable for this preview.")).toBe(true);
    await act(async () => currentDownload.click());
    expect(nextDownload).toHaveBeenCalledTimes(2);
    expect([...mounted.container.querySelectorAll('[role="alert"]')].some((element) => element.textContent === "Download is unavailable for this preview.")).toBe(false);
    expect(currentDownload.getAttribute("aria-busy")).toBe("false");
    await mounted.unmount();
    expect(first.release).toHaveBeenCalledExactlyOnceWith("shared-blob");
    expect(second.release).toHaveBeenCalledExactlyOnceWith("shared-blob");
  });

  it.each(["missing", "rejected"] as const)("shows a %s audio lease without hiding metadata or overstating download availability", async (failure) => {
    const owner = controller(async () => { throw new Error("private ticket failure"); });
    const preview = audioPreview();
    const mounted = await mount(owner.value, { ...preview, ...(failure === "missing" ? { blobId: "" } : {}) });
    expect(mounted.container.querySelector("audio")).toBeNull();
    expect(mounted.container.querySelector('[role="alert"]')?.textContent).toBe("This file cannot be previewed in Joko.");
    expect(mounted.container.textContent).toContain("recording.wav");
    expect(mounted.container.textContent).toContain("44 B");
    expect(mounted.container.querySelector<HTMLButtonElement>(".workspace-file-body__download")?.disabled).toBe(failure === "missing");
    expect(owner.acquire).toHaveBeenCalledTimes(failure === "missing" ? 0 : 1);
    expect(owner.release).not.toHaveBeenCalled();
  });

  it.each(["read", "acquire"] as const)("retires Markdown resolution at the %s boundary without borrowing or releasing the new gateway's same blob", async (phase) => {
    const oldRead = deferred<WorkspaceFilePreviewView>();
    const oldUrl = deferred<string>();
    const first = controller(() => oldUrl.promise);
    first.read.mockImplementation(() => phase === "read" ? oldRead.promise : Promise.resolve(imagePreview("image.png")));
    const second = controller(async () => "blob:new-markdown");
    const mounted = await mount(first.value, markdownPreview());
    const previousResolver = boundary.resolver!;
    const pending = previousResolver("image.png");
    await act(async () => { await Promise.resolve(); });
    await mounted.render(second.value);
    const newResolver = boundary.resolver!;
    expect(newResolver).not.toBe(previousResolver);
    await expect(newResolver("image.png")).resolves.toMatchObject({ url: "blob:new-markdown" });
    await act(async () => { oldRead.resolve(imagePreview("image.png")); oldUrl.resolve("blob:old-markdown"); });
    await expect(pending).resolves.toBeUndefined();
    await expect(previousResolver("another.png")).resolves.toBeUndefined();
    expect(first.read).toHaveBeenCalledTimes(1);
    expect(first.acquire).toHaveBeenCalledTimes(phase === "read" ? 0 : 1);
    expect(first.release).toHaveBeenCalledTimes(phase === "read" ? 0 : 1);
    expect(second.acquire).toHaveBeenCalledTimes(1);
    expect(second.release).not.toHaveBeenCalled();
    await mounted.unmount();
    expect(second.release).toHaveBeenCalledExactlyOnceWith("shared-blob");
  });

  it.each(["read", "acquire"] as const)("stops retired model dependency work at the %s boundary and keeps cleanup on its original gateway", async (phase) => {
    const oldRead = deferred<WorkspaceFilePreviewView>();
    const oldResource = deferred<string>();
    const first = controller(async (blobId) => blobId === "shared-blob" ? "blob:old-model" : oldResource.promise);
    first.read.mockImplementation(() => phase === "read" ? oldRead.promise : Promise.resolve(imagePreview("texture.png", "texture-blob")));
    const second = controller(async () => "blob:new-model");
    const mounted = await mount(first.value, { ...imagePreview("scene.gltf"), kind: "blob", mediaType: "model/gltf+json" });
    const originalMaterialization = boundary.models[0]!;
    const pending = originalMaterialization.loadResource("texture.png");
    const outcome = pending.then(() => undefined, (error: unknown) => error);
    await act(async () => { await Promise.resolve(); });
    await mounted.render(second.value);
    await act(async () => { oldRead.resolve(imagePreview("texture.png", "texture-blob")); oldResource.resolve("blob:old-texture"); });
    expect(await outcome).toBeInstanceOf(Error);
    expect((await outcome as Error).message).toContain("no longer active");
    await expect(originalMaterialization.loadResource("another.png")).rejects.toThrow("no longer active");
    expect(first.read).toHaveBeenCalledTimes(1);
    expect(first.acquire.mock.calls.filter(([blobId]) => blobId === "texture-blob")).toHaveLength(phase === "read" ? 0 : 1);
    expect(first.release.mock.calls.filter(([blobId]) => blobId === "texture-blob")).toHaveLength(phase === "read" ? 0 : 1);
    expect(second.acquire.mock.calls.map(([blobId]) => blobId)).toEqual(["shared-blob"]);
    expect(second.release).not.toHaveBeenCalled();
  });
});

function controller(acquire: (blobId: string) => Promise<string>) {
  const getArtifactUrl = vi.fn(acquire);
  const releaseArtifactUrl = vi.fn<(blobId: string) => void>();
  const readWorkspaceFile = vi.fn(async (_workspaceId: string, path: string) => imagePreview(path));
  return {
    acquire: getArtifactUrl, release: releaseArtifactUrl, read: readWorkspaceFile,
    value: {
      state: { activeProfile: { id: "profile", serverId: "server" }, preferences: { locale: "en" } },
      getArtifactUrl, releaseArtifactUrl, readWorkspaceFile, writeWorkspaceTextFile: vi.fn(), downloadArtifact: vi.fn()
    } as unknown as AppController
  };
}

async function mount(initial: AppController, preview: WorkspaceFilePreviewView, strict = false) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const render = async (controller: AppController) => act(async () => {
    const body = <WorkspaceFileBody controller={controller} sessionId="session" workspaceId="workspace" path={preview.path} preview={preview} canWrite={false} />;
    root.render(strict ? <StrictMode>{body}</StrictMode> : body);
  });
  await render(initial);
  return { container, render, unmount: async () => { await act(async () => root.unmount()); roots.splice(roots.indexOf(root), 1); } };
}

function imagePreview(path: string, blobId = "shared-blob"): WorkspaceFilePreviewView {
  return { path, name: path, kind: "image", mediaType: "image/png", blobId, truncated: false };
}

function audioPreview(): WorkspaceFilePreviewView {
  return { path: "recording.wav", name: "recording.wav", kind: "blob", mediaType: "audio/wav", blobId: "shared-blob", byteSize: 44, truncated: false };
}

function markdownPreview(): WorkspaceFilePreviewView {
  return { path: "README.md", name: "README.md", kind: "text", text: "![image](image.png)", language: "markdown", revision: "one", truncated: false };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
