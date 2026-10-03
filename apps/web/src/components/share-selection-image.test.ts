import { describe, expect, it, vi } from "vitest";
import type { TimelineItemView } from "../model.js";
import { deferredShareValue, pngBlob, shareImageTestSurface } from "./share-image.test-support.js";
import { copyShareSelectionImagePng, downloadShareSelectionImagePng, shareSelectionImageMessages } from "./share-selection-image.js";

describe("multi-message share projection and effects", () => {
  it("preserves selected order using only the rich renderer's content shape", () => {
    const selected = shareSelectionImageMessages([
      { ...item("one", "user"), attachments: [{ id: "attachment", blobId: "blob", sourceRevealAvailable: false, fileName: "result.txt", title: "Result", kind: "file", mediaType: "text/plain", byteSize: 6 }] },
      item("three", "assistant")
    ]);
    expect(selected).toEqual([
      { id: "one", text: "one", attachmentNames: ["result.txt"] },
      { id: "three", text: "three", attachmentNames: [] }
    ]);
  });

  it("never includes Joko's private quote marker in projected user content", () => {
    const quoted = { ...item("quoted", "user", "> <!-- joko-selection-quote -->\n> selected\n\nreply"), quotesEncoded: true };
    const selected = shareSelectionImageMessages([quoted]);
    expect(selected[0]?.text).toBe("> selected\n\nreply");
    expect(selected[0]?.text).not.toContain("joko-selection-quote");
  });

  it("keeps a user-typed marker visible when no product quote gate exists", () => {
    const typed = item("typed", "user", "> <!-- joko-selection-quote -->\n> ordinary text");
    expect(shareSelectionImageMessages([typed])[0]?.text).toContain("joko-selection-quote");
  });

  it("writes PNG through the initiating clipboard and reports missing image capability", async () => {
    const surface = shareImageTestSurface();
    const blob = pngBlob();
    await copyShareSelectionImagePng(blob, surface.action);
    expect(surface.write).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({ items: { "image/png": blob } })]);
    Reflect.deleteProperty(surface.window, "ClipboardItem");
    await expect(copyShareSelectionImagePng(blob, surface.action)).rejects.toThrow();
    expect(surface.write).toHaveBeenCalledOnce();
  });

  it.each(["copy", "download"] as const)("does not dispatch %s after retirement during validation", async (kind) => {
    const surface = shareImageTestSurface();
    const bytes = deferredShareValue<ArrayBuffer>();
    const blob = pngBlob();
    vi.spyOn(blob, "slice").mockReturnValue({ arrayBuffer: () => bytes.promise } as Blob);
    const pending = kind === "copy" ? copyShareSelectionImagePng(blob, surface.action) : downloadShareSelectionImagePng(blob, "Task", 0, surface.action);
    const rejected = expect(pending).rejects.toThrow();
    surface.abort.abort();
    bytes.resolve(await pngBlob().arrayBuffer());
    await rejected;
    expect(surface.write).not.toHaveBeenCalled();
    expect(surface.click).not.toHaveBeenCalled();
  });

  it("keeps the result of an already dispatched clipboard write", async () => {
    const surface = shareImageTestSurface();
    surface.write.mockImplementationOnce(async () => { surface.abort.abort(); });
    await expect(copyShareSelectionImagePng(pngBlob(), surface.action)).resolves.toBeUndefined();
    expect(surface.write).toHaveBeenCalledOnce();
  });
});

function item(id: string, kind: "user" | "assistant", text = id): TimelineItemView {
  return { id, kind, text, sequence: BigInt(id.length), createdAt: id.length };
}
