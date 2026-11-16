// @vitest-environment jsdom

import { act } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
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
  sourceRevealAvailable: false,
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
    for (const fileName of ["main.zig", "events.jsonl", "movie.srt", "Gemfile", ".gitignore", ".env", "production.env.local"]) {
      expect(timelineArtifactSupportsTextPreview({ kind: "file", fileName, mediaType: "application/octet-stream" })).toBe(true);
    }
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
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
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
    const sourceArtifact = { ...artifact, fileName: "main.zig", mediaType: "application/octet-stream" };
    await mount({ artifact: sourceArtifact, loadUrl, onDownload, onClose });

    await flush();
    expect(document.body.textContent).toContain(text);
    expect(loadUrl).toHaveBeenCalledWith("blob-1");

    await click(button(`${labels.preview}: main.zig`));
    expect(writeText).toHaveBeenCalledWith("main.zig");
    await click(button(labels.copy));
    expect(writeText).toHaveBeenCalledWith(text);
    await click(button(labels.download));
    expect(onDownload).toHaveBeenCalledWith("blob-1", "main.zig", { ownerDocument: document, signal: expect.any(AbortSignal) });

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

  it("renders Markdown headings, lists, GFM tables and fenced code while copying the original bytes", async () => {
    const text = "# Heading\n\n- First\n- Second\n\n| Name | Value |\n| --- | --- |\n| **Alpha** | 42 |\n\n- [x] Complete\n\n~~Removed~~\n\n```ts\nconst count: number = 42;\n```\n\n[Unsafe](javascript:alert(1))\n\n![Sibling](private.png)\n\n<script>window.bad = true</script>";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, blob: async () => ({ size: text.length, text: async () => text }) })));
    const onDownload = vi.fn();
    await mount({ artifact, loadUrl: async () => "blob:markdown", onDownload, onClose: vi.fn() });
    const body = required(document.querySelector<HTMLElement>(".text-attachment-lightbox__markdown"));
    expect(body.querySelector("h1")?.textContent).toBe("Heading");
    expect(body.querySelectorAll("li")).toHaveLength(3);
    expect(body.querySelector("tbody td strong")?.textContent).toBe("Alpha");
    expect(body.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
    expect(body.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled).toBe(true);
    expect(body.querySelector("del")?.textContent).toBe("Removed");
    expect(body.querySelector("pre code.language-ts span")).not.toBeNull();
    expect(body.querySelector("script")).toBeNull();
    expect(body.querySelector("a")?.getAttribute("href")).toBeFalsy();
    expect(body.querySelector("img")).toBeNull();
    expect(body.textContent).toContain("Sibling");
    await click(button(labels.copy));
    expect(writeText).toHaveBeenLastCalledWith(text);
    await click(button(labels.download));
    expect(onDownload).toHaveBeenCalledWith("blob-1", "notes.md", { ownerDocument: document, signal: expect.any(AbortSignal) });
  });

  it("uses the existing read-only code editor with syntax, line numbers and keyboard focus for a code attachment", async () => {
    const text = "const answer: number = 42;\nconsole.log(answer);\n";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, blob: async () => ({ size: text.length, text: async () => text }) })));
    await mount({ artifact: { ...artifact, fileName: "answer.ts", mediaType: "text/plain" }, loadUrl: async () => "blob:code", onDownload: vi.fn(), onClose: vi.fn() });
    const host = required(document.querySelector<HTMLElement>('.workspace-text-editor[data-language="typescript"]'));
    const view = required(EditorView.findFromDOM(required(host.querySelector<HTMLElement>(".cm-editor"))));
    expect(view.state.doc.toString()).toBe(text);
    expect(view.state.facet(EditorState.readOnly)).toBe(true);
    expect(view.state.facet(EditorView.editable)).toBe(false);
    expect(host.querySelector(".cm-lineNumbers")).not.toBeNull();
    expect(host.querySelector(".cm-line span")).not.toBeNull();
    expect(view.contentDOM.getAttribute("tabindex")).toBe("0");
    view.contentDOM.focus();
    expect(document.activeElement).toBe(view.contentDOM);
    await click(button(labels.copy));
    expect(writeText).toHaveBeenLastCalledWith(text);
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
    expect(document.querySelector(".text-attachment-lightbox__markdown")?.textContent).toBe("second");
    await render(artifact);
    expect(document.querySelector(".text-attachment-lightbox__markdown")?.textContent).toBe("current first");
    await act(async () => releaseOld());
    expect(document.querySelector(".text-attachment-lightbox__markdown")?.textContent).toBe("current first");
    await click(button(labels.copy));
    expect(writeText).toHaveBeenLastCalledWith("current first");
    expect((fetch.mock.calls[0]![1] as RequestInit).signal?.aborted).toBe(true);
    act(() => window.dispatchEvent(new Event("pagehide")));
    expect(document.querySelector(".text-attachment-lightbox__markdown")?.textContent).toBe("current first");
    await render({ ...artifact, byteSize: TIMELINE_TEXT_PREVIEW_LIMIT_BYTES + 1 });
    expect(document.querySelector(".text-attachment-lightbox__markdown")).toBeNull();
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
    expect(detached.querySelector(".text-attachment-lightbox__markdown")?.textContent).toBe("current");
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
