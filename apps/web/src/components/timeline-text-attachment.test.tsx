// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ArtifactView } from "../model.js";
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
    expect(onDownload).toHaveBeenCalledWith("blob-1", "notes.md");

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
});

async function mount(props: Omit<Parameters<typeof TimelineTextAttachmentLightbox>[0], "labels">): Promise<void> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(<TimelineTextAttachmentLightbox {...props} labels={labels} />));
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
