// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { translate } from "../i18n.js";
import type { AttachmentDraft } from "../model.js";
import { ComposerAttachmentTray } from "./ComposerAttachmentTray.js";
import { editImageAttachment } from "../image-attachment.js";

const roots: Root[] = [];
const t = (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]): string => translate("en", key, values);

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:attachment-preview") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
});

afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0).reverse()) root.unmount(); });
  document.body.replaceChildren();
  document.body.className = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("composer attachment tray", () => {
  it("saves editable vectors on the original attachment and reopens the cleared original without encoding", async () => {
    vi.useFakeTimers();
    const original: AttachmentDraft = { id: "original", kind: "image", file: new File(["original"], "photo.jpg", { type: "image/jpeg" }), previewUrl: "blob:original",
      annotationStrokes: [{ points: [{ x: 0.25, y: 0.5 }] }] };
    let attachments: readonly AttachmentDraft[] = [original];
    const onSave = vi.fn((source: AttachmentDraft, strokes: NonNullable<AttachmentDraft["annotationStrokes"]>) => {
      attachments = editImageAttachment(attachments, source, strokes);
      root.render(<ComposerAttachmentTray ownerKey="draft" attachments={attachments} t={t} onRemove={vi.fn()} onSaveImageAnnotations={onSave} />);
    });
    const root = mount(attachments, vi.fn(), onSave);
    act(() => document.querySelector<HTMLButtonElement>("button.attachment-chip__content")!.click());
    const image = document.querySelector<HTMLImageElement>('.workspace-image-lightbox__image-wrap img')!;
    Object.defineProperties(image, { naturalWidth: { value: 400 }, naturalHeight: { value: 300 } });
    act(() => image.dispatchEvent(new Event("load")));
    expect(document.querySelector('.workspace-image-lightbox__image-wrap img')?.getAttribute("src")).toBe(original.previewUrl);
    expect(document.querySelector('.workspace-image-lightbox__image-wrap path')).not.toBeNull();
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Annotate"]')!.click());
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Undo last stroke"]')!.click());
    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="Save"]')!.click(); await Promise.resolve(); });
    await act(async () => vi.advanceTimersByTime(160));
    expect(onSave).toHaveBeenCalledExactlyOnceWith(original, []);
    expect(attachments[0]!.file).toBe(original.file); expect(attachments[0]!.id).toBe(original.id); expect(attachments[0]!.annotationStrokes).toBeUndefined();
    expect(document.querySelector(".workspace-image-lightbox")).toBeNull();
    act(() => document.querySelector<HTMLButtonElement>("button.attachment-chip__content")!.click());
    expect(document.querySelector('.workspace-image-lightbox__image-wrap path')).toBeNull();
    act(() => root.render(<ComposerAttachmentTray ownerKey="draft" attachments={attachments} t={t} removeDisabled onRemove={vi.fn()} onSaveImageAnnotations={onSave} />));
    expect(document.querySelector('button[aria-label="Annotate"]')).toBeNull();
    vi.useRealTimers();
  });

  it("shows a viewport-aware image preview, opens the image viewer, and does not reopen on restored focus", async () => {
    mount([{ id: "image", kind: "image", file: new File(["image"], "preview.png", { type: "image/png" }), previewUrl: "blob:image" }]);
    const trigger = document.querySelector<HTMLButtonElement>("button.attachment-chip__content");
    expect(trigger?.getAttribute("aria-label")).toContain("preview.png");
    if (trigger === null) throw new Error("Image preview trigger was not rendered.");
    trigger.getBoundingClientRect = () => ({
      top: 8, bottom: 48, left: 20, right: 80, width: 60, height: 40, x: 20, y: 8,
      toJSON: () => ({})
    }) as DOMRect;

    act(() => trigger.focus());
    const hover = document.querySelector<HTMLElement>(".composer-image-hover-preview");
    expect(hover?.style.transform).toBe("translate(-50%, 0)");
    expect(Number.parseFloat(hover?.style.maxWidth ?? "0")).toBeLessThanOrEqual(224);

    act(() => trigger.click());
    expect(document.querySelector(".composer-image-hover-preview")).toBeNull();
    expect(document.querySelector('[role="dialog"][aria-label="preview.png"]')).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      // The viewer owns a 160 ms exit transition before returning focus.
      await new Promise((resolve) => window.setTimeout(resolve, 180));
    });
    expect(document.activeElement).toBe(trigger);
    expect(document.querySelector(".composer-image-hover-preview")).toBeNull();
  });

  it("opens recognized text and code files in the bounded read-only text viewer", async () => {
    const text = "alpha\nbeta";
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      blob: async () => ({ size: text.length, text: async () => text })
    })));
    mount([{ id: "text", kind: "file", file: new File(["alpha\nbeta"], "notes.md", { type: "text/markdown" }) }]);
    const trigger = document.querySelector<HTMLButtonElement>("button.attachment-chip__content");
    await act(async () => {
      trigger?.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(document.querySelector(".text-attachment-lightbox [role=dialog]")?.textContent).toContain("notes.md");
    expect(document.querySelector(".text-attachment-lightbox__markdown p")?.textContent).toBe("alpha\nbeta");
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("opens the original ordinary document in Desktop and leaves other files available to send", async () => {
    const openFile = vi.fn<NonNullable<Window["jokoDesktop"]>["openFile"]>()
      .mockResolvedValueOnce({ status: "opened" }).mockResolvedValueOnce({ status: "failed", reason: "open" });
    vi.stubGlobal("jokoDesktop", { capabilities: ["files.open"], openFile, cancelFileOpen: vi.fn(async () => undefined) });
    const pdf = new File(["pdf"], "report.pdf", { type: "application/pdf" });
    const sheet = new File(["zip"], "sheet.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    Object.defineProperty(pdf, "arrayBuffer", { value: async () => Uint8Array.of(112, 100, 102).buffer });
    Object.defineProperty(sheet, "arrayBuffer", { value: async () => Uint8Array.of(122, 105, 112).buffer });
    const executable = new File(["exe"], "report.pdf.exe", { type: "application/pdf" });
    const remove = vi.fn();
    mount([{ id: "pdf", kind: "file", file: pdf }, { id: "sheet", kind: "file", file: sheet },
      { id: "executable", kind: "file", file: executable }], remove, undefined, true);

    expect([...document.querySelectorAll(".attachment-chip__type")].map(element => element.textContent)).toEqual(["PDF", "XLSX"]);
    expect(document.querySelector('button[aria-label="Open with default app: report.pdf.exe"]')).toBeNull();
    expect(document.querySelector('button[aria-label="Remove attachment: report.pdf.exe"]')).not.toBeNull();
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Open with default app: report.pdf"]')!.click());
    expect(openFile).toHaveBeenCalledExactlyOnceWith({ requestId: expect.any(String),
      file: { name: pdf.name, mediaType: pdf.type, bytes: Uint8Array.of(112, 100, 102) } });
    expect(document.querySelector("[role=status]")?.textContent).toContain("File opened");
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Open with default app: sheet.xlsx"]')!.click());
    expect(openFile).toHaveBeenCalledTimes(2);
    expect(document.querySelectorAll("[role=status]")[1]?.textContent).toContain("Couldn't open the file");
    expect(document.querySelector(".attachment-list")?.textContent).toContain(sheet.name);
    expect(remove).not.toHaveBeenCalled();
  });

  it("shows the document type without offering native open in a browser", () => {
    mount([{ id: "pdf", kind: "file", file: new File(["pdf"], "report.pdf", { type: "application/pdf" }) }], vi.fn(), undefined, true);
    expect(document.querySelector(".attachment-chip__type")?.textContent).toBe("PDF");
    expect(document.querySelector("button.attachment-chip__content")).toBeNull();
  });

  it("shows a native thumbnail for the attached file and discards a retired rendition", async () => {
    const thumbnail = "data:image/png;base64,dGVzdA==";
    let resolvePdf!: (value: string) => void;
    const thumbnailDraftFile = vi.fn(async ({ name }: { name: string }) => {
      if (name === "original.pdf") return new Promise<string>(resolve => { resolvePdf = resolve; });
      return thumbnail;
    });
    vi.stubGlobal("jokoDesktop", { capabilities: ["files.draftThumbnail"], thumbnailDraftFile });
    const pdf = new File(["pdf"], "original.pdf", { type: "application/pdf" });
    const replacement = new File(["doc"], "replacement.docx");
    Object.defineProperty(pdf, "arrayBuffer", { value: async () => Uint8Array.of(1).buffer });
    Object.defineProperty(replacement, "arrayBuffer", { value: async () => Uint8Array.of(2).buffer });
    const root = mount([{ id: "same-slot", kind: "file", file: pdf }], vi.fn(), undefined, true);
    await act(async () => {});
    expect(thumbnailDraftFile).toHaveBeenCalledExactlyOnceWith({ name: pdf.name, bytes: Uint8Array.of(1) });
    await act(async () => root.render(<ComposerAttachmentTray ownerKey="draft" attachments={[{ id: "same-slot", kind: "file", file: replacement }]}
      t={t} onRemove={vi.fn()} documentPreviewEnabled />));
    expect(thumbnailDraftFile).toHaveBeenLastCalledWith({ name: replacement.name, bytes: Uint8Array.of(2) });
    expect(document.querySelector(".attachment-chip__thumbnail")?.getAttribute("src")).toBe(thumbnail);
    await act(async () => resolvePdf("data:image/png;base64,b2xk"));
    expect(document.querySelector(".attachment-chip__thumbnail")?.getAttribute("src")).toBe(thumbnail);
  });

  it("does not offer an unsafe generic opener while keeping removal available", () => {
    const remove = vi.fn();
    mount([{ id: "binary", kind: "file", file: new File(["binary"], "bundle.zip", { type: "application/zip" }) }], remove);

    expect(document.querySelector("button.attachment-chip__content")).toBeNull();
    expect(document.querySelector(".attachment-chip__content")?.getAttribute("title")).toBe("This file cannot be previewed in Joko.");
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Remove attachment: bundle.zip"]')?.click());
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ id: "binary" }));
  });
});

function mount(
  attachments: readonly AttachmentDraft[],
  onRemove = vi.fn(),
  onSaveImageAnnotations?: Parameters<typeof ComposerAttachmentTray>[0]["onSaveImageAnnotations"],
  documentPreviewEnabled = false
): Root {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<ComposerAttachmentTray ownerKey="draft" attachments={attachments} t={t} onRemove={onRemove}
    onSaveImageAnnotations={onSaveImageAnnotations} documentPreviewEnabled={documentPreviewEnabled} />));
  return root;
}
