// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ArtifactDownloadContext, ArtifactView } from "../model.js";
import { TimelineTextAttachmentLightbox } from "./TimelineTextAttachmentLightbox.js";
import {
  TIMELINE_TEXT_PREVIEW_LIMIT_BYTES,
  timelineArtifactSupportsTextPreview,
  timelineTextPreviewLikelyBinary
} from "./timeline-text-attachment.js";

const labels = {
  preview: "Preview",
  loading: "Loading preview",
  unavailable: "Preview unavailable",
  tooLarge: "Preview is too large",
  copy: "Copy content",
  copied: "Copied",
  copyFailed: "Copy failed",
  download: "Download",
  close: "Close"
};

const artifact: ArtifactView = {
  id: "artifact-1",
  blobId: "blob-1",
  title: "Notes",
  kind: "file",
  fileName: "notes.md",
  mediaType: "text/markdown",
  byteSize: 18
};

const roots: Root[] = [];

describe("timeline text attachment eligibility", () => {
  it("recognizes source, markup, structured text, and conventional extensionless files", () => {
    expect(timelineArtifactSupportsTextPreview(artifact)).toBe(true);
    expect(timelineArtifactSupportsTextPreview({ kind: "tool", fileName: "payload.bin", mediaType: "application/problem+json" })).toBe(true);
    expect(timelineArtifactSupportsTextPreview({ kind: "file", fileName: "Dockerfile", mediaType: "application/octet-stream" })).toBe(true);
    expect(timelineArtifactSupportsTextPreview({ kind: "file", fileName: "archive.zip", mediaType: "application/zip" })).toBe(false);
    expect(timelineArtifactSupportsTextPreview({ kind: "image", fileName: "image.svg", mediaType: "image/svg+xml" })).toBe(false);
  });

  it("fails closed for text payloads with binary control density", () => {
    expect(timelineTextPreviewLikelyBinary("plain\ntext\tcontent")).toBe(false);
    expect(timelineTextPreviewLikelyBinary("abc\u0000def")).toBe(true);
    expect(timelineTextPreviewLikelyBinary("\u0001\u0002\u0003visible")).toBe(true);
  });
});

describe("timeline text attachment lightbox", () => {
  const writeText = vi.fn(async () => undefined);

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  });

  afterEach(async () => {
    for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
    document.body.replaceChildren();
    document.body.className = "";
    vi.unstubAllGlobals();
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("loads a bounded artifact, copies filename/content, downloads, owns modal state, and closes with Escape", async () => {
    const text = "# Heading\n\nbody";
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      blob: async () => ({ size: text.length, text: async () => text })
    })));
    const onClose = vi.fn();
    const onDownload = vi.fn();
    const loadUrl = vi.fn(async () => "blob:https://joko.test/preview");
    await mount({ artifact, loadUrl, onDownload, onClose });

    await flush();
    expect(document.body.textContent).toContain(text);
    expect(loadUrl).toHaveBeenCalledWith("blob-1");

    await click(button(`${labels.preview}: notes.md`));
    expect(writeText).toHaveBeenCalledWith("notes.md");
    await click(button(labels.copy));
    expect(writeText).toHaveBeenCalledWith(text);
    await click(button(labels.download));
    expect(onDownload).toHaveBeenCalledWith("blob-1", "notes.md", { ownerDocument: document, signal: expect.any(AbortSignal) });

    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not fetch an artifact beyond the preview cap and leaves download available", async () => {
    const loadUrl = vi.fn(async () => "blob:unused");
    await mount({
      artifact: { ...artifact, byteSize: TIMELINE_TEXT_PREVIEW_LIMIT_BYTES + 1 },
      loadUrl,
      onDownload: vi.fn(),
      onClose: vi.fn()
    });
    expect(document.body.textContent).toContain(labels.tooLarge);
    expect(loadUrl).not.toHaveBeenCalled();
    expect(buttons(labels.download).length).toBeGreaterThan(0);
  });

  it("closes only from the separate backdrop, not an interaction inside the document card", async () => {
    const text = "content";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, blob: async () => ({ size: text.length, text: async () => text }) })));
    const onClose = vi.fn();
    await mount({ artifact, loadUrl: async () => "blob:preview", onDownload: vi.fn(), onClose });
    await flush();
    const dialog = required(document.querySelector<HTMLElement>("[role=dialog]"));
    act(() => dialog.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(onClose).not.toHaveBeenCalled();
    await click(required(document.querySelector<HTMLButtonElement>(".text-attachment-lightbox__backdrop")));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("cancels a pending download when the same text source moves to another Document", async () => {
    const frame = document.body.appendChild(document.createElement("iframe"));
    const detached = frame.contentDocument!;
    const trigger = document.body.appendChild(document.createElement("button"));
    const nextTrigger = detached.body.appendChild(detached.createElement("button"));
    const large = { ...artifact, byteSize: TIMELINE_TEXT_PREVIEW_LIMIT_BYTES + 1 };
    const loadUrl = vi.fn(async () => "blob:unused");
    const attempts: { context: ArtifactDownloadContext; reject: (reason: unknown) => void }[] = [];
    const onDownload = vi.fn((_blobId: string, _fileName: string, context: ArtifactDownloadContext) => new Promise<void>((_resolve, reject) => { attempts.push({ context, reject }); }));
    const onClose = vi.fn();
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    roots.push(root);
    const render = (returnFocus: HTMLElement) => act(async () => root.render(<TimelineTextAttachmentLightbox ownerKey="task" artifact={large} labels={labels} returnFocus={returnFocus} loadUrl={loadUrl} onDownload={onDownload} onClose={onClose} />));
    await render(trigger);
    await click(button(labels.download));
    expect(attempts[0]!.context.ownerDocument).toBe(document);
    await render(nextTrigger);
    expect(attempts[0]!.context.signal.aborted).toBe(true);
    const currentDownload = detached.querySelector<HTMLButtonElement>('button[aria-label="Download"]')!;
    await click(currentDownload);
    expect(attempts[1]!.context.ownerDocument).toBe(detached);
    await act(async () => attempts[0]!.reject(new Error("old download failed")));
    expect(detached.querySelector('[role="alert"]')).toBeNull();
    expect(currentDownload.getAttribute("aria-busy")).toBe("true");
    await click(detached.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!);
    expect(attempts[1]!.context.signal.aborted).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
    await act(async () => attempts[1]!.reject(new Error("closed download failed")));
    expect(detached.querySelector('[role="alert"]')).toBeNull();
  });

  it.each(["blob", "text"] as const)("rejects a retired %s read across a source ABA and copies only the current bounded text", async (stage) => {
    let releaseOld!: () => void;
    const firstBlob = { size: 7, text: async () => "retired" };
    const lateBlob = stage === "blob"
      ? new Promise<typeof firstBlob>((resolve) => { releaseOld = () => resolve(firstBlob); })
      : Promise.resolve({ size: 7, text: () => new Promise<string>((resolve) => { releaseOld = () => resolve("retired"); }) });
    const response = (text: string) => ({ ok: true, blob: async () => ({ size: text.length, text: async () => text }) });
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, blob: () => lateBlob })
      .mockResolvedValueOnce(response("second"))
      .mockResolvedValueOnce(response("current first"));
    vi.stubGlobal("fetch", fetch);
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    roots.push(root);
    const loadUrl = vi.fn(async (blobId: string) => `blob:${blobId}`);
    const onClose = vi.fn();
    const render = (current: ArtifactView) => act(async () => root.render(<TimelineTextAttachmentLightbox ownerKey="task" artifact={current} labels={labels} loadUrl={loadUrl} onDownload={vi.fn()} onClose={onClose} />));
    await render(artifact);
    await render({ ...artifact, blobId: "second" });
    expect(document.querySelector("pre")?.textContent).toBe("second");
    await render(artifact);
    expect(document.querySelector("pre")?.textContent).toBe("current first");
    await act(async () => releaseOld());
    expect(document.querySelector("pre")?.textContent).toBe("current first");
    await click(button(labels.copy));
    expect(writeText).toHaveBeenLastCalledWith("current first");
    expect((fetch.mock.calls[0]![1] as RequestInit).signal?.aborted).toBe(true);
    act(() => window.dispatchEvent(new Event("pagehide")));
    expect(document.querySelector("pre")?.textContent).toBe("current first");
    await render({ ...artifact, byteSize: TIMELINE_TEXT_PREVIEW_LIMIT_BYTES + 1 });
    expect(document.querySelector("pre")).toBeNull();
    expect(document.body.textContent).toContain(labels.tooLarge);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("retires an unresolved URL before changing windows and reports clipboard failure in the current dialog", async () => {
    const frame = document.body.appendChild(document.createElement("iframe"));
    const detached = frame.contentDocument!;
    const trigger = document.body.appendChild(document.createElement("button"));
    const nextTrigger = detached.body.appendChild(detached.createElement("button"));
    const oldFocus = vi.spyOn(trigger, "focus");
    const mainFetch = vi.fn();
    vi.stubGlobal("fetch", mainFetch);
    const detachedFetch = vi.fn(async () => ({ ok: true, blob: async () => ({ size: 7, text: async () => "current" }) }));
    Object.defineProperty(detached.defaultView, "fetch", { configurable: true, value: detachedFetch });
    Object.defineProperty(detached.defaultView!.navigator, "clipboard", { configurable: true, value: undefined });
    let releaseUrl!: (url: string) => void;
    const loadUrl = vi.fn().mockImplementationOnce(() => new Promise<string>((resolve) => { releaseUrl = resolve; })).mockResolvedValue("blob:current");
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    roots.push(root);
    const onClose = vi.fn();
    const render = (returnFocus: HTMLElement) => act(async () => root.render(<TimelineTextAttachmentLightbox ownerKey="task" artifact={artifact} labels={labels} returnFocus={returnFocus} loadUrl={loadUrl} onDownload={vi.fn()} onClose={onClose} />));
    await render(trigger);
    expect(document.body.textContent).toContain(labels.loading);
    act(() => window.dispatchEvent(new Event("pagehide")));
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(labels.unavailable);
    expect(document.body.textContent).not.toContain(labels.loading);
    await render(nextTrigger);
    await act(async () => releaseUrl("blob:retired"));
    expect(mainFetch).not.toHaveBeenCalled();
    expect(detachedFetch).toHaveBeenCalledOnce();
    expect(detached.querySelector("pre")?.textContent).toBe("current");
    expect(oldFocus).not.toHaveBeenCalled();
    await click(detached.querySelector<HTMLButtonElement>('button[aria-label="Copy content"]')!);
    expect(detached.querySelector('[role="alert"]')?.textContent).toBe(labels.copyFailed);
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    act(() => detached.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true })));
    expect(onClose).not.toHaveBeenCalled();
    act(() => detached.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(onClose).toHaveBeenCalledOnce();
    expect(detached.activeElement).toBe(nextTrigger);
  });
});

async function mount(props: Omit<Parameters<typeof TimelineTextAttachmentLightbox>[0], "labels" | "ownerKey">): Promise<void> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(<TimelineTextAttachmentLightbox ownerKey="task" {...props} labels={labels} />));
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function click(element: HTMLButtonElement): Promise<void> {
  await act(async () => element.click());
}

function button(label: string): HTMLButtonElement {
  return required(buttons(label)[0]);
}

function buttons(label: string): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].filter((candidate) => candidate.getAttribute("aria-label") === label);
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected mounted element.");
  return value;
}
