import { describe, expect, it, vi } from "vitest";
import { deferredShareValue, pngBlob, shareImageTestPalette, shareImageTestSurface } from "./share-image.test-support.js";
import { MAXIMUM_SHARE_IMAGE_EDGE_PIXELS, MAXIMUM_SHARE_IMAGE_PIXELS, MAXIMUM_SHARE_MESSAGE_CHARACTERS, ShareMessageImageTooLargeError } from "./share-message-image.js";
import { buildShareSelectionImagePng, copyShareSelectionImagePng, downloadShareSelectionImagePng, layoutShareSelectionImage, shareSelectionImageMessages } from "./share-selection-image.js";
import type { TimelineItemView } from "../model.js";


describe("multi-message share PNG", () => {
  it("preserves selected timeline order and marks skipped messages honestly", () => {
    const all = [item("one", "user"), item("two", "assistant"), item("three", "user")];
    const selected = shareSelectionImageMessages(all, [all[0]!, all[2]!], { user: "You", assistant: "Agent", attachments: "Attachments" }, () => "now");
    expect(selected.map((message) => [message.id, message.gapBefore])).toEqual([["one", false], ["three", true]]);
  });

  it("never paints Joko's private quote marker into a multi-message share image", () => {
    const quoted = { ...item("quoted", "user", "> <!-- joko-selection-quote -->\n> selected\n\nreply"), quotesEncoded: true };
    const selected = shareSelectionImageMessages([quoted], [quoted], { user: "You", assistant: "Agent", attachments: "Attachments" }, () => "now");
    expect(selected[0]?.text).toBe("> selected\n\nreply");
    expect(selected[0]?.text).not.toContain("joko-selection-quote");
  });

  it("keeps a user-typed marker visible when no product quote gate exists", () => {
    const typed = item("typed", "user", "> <!-- joko-selection-quote -->\n> ordinary text");
    const selected = shareSelectionImageMessages([typed], [typed], { user: "You", assistant: "Agent", attachments: "Attachments" }, () => "now");
    expect(selected[0]?.text).toContain("joko-selection-quote");
  });

  it("lays out multiple redacted cards within the same readable pixel budget", () => {
    const layout = layoutShareSelectionImage({
      sessionName: "Deploy sk-secretvalue123",
      messages: [
        { id: "one", role: "user", roleLabel: "You", text: "token=secretvalue123", attachmentNames: [], attachmentsLabel: "Attachments", gapBefore: false },
        { id: "two", role: "assistant", roleLabel: "Agent", text: "Done", attachmentNames: ["result.txt"], attachmentsLabel: "Attachments", gapBefore: true }
      ]
    }, (value) => value.length * 8);
    expect(layout.title).not.toContain("secretvalue123");
    expect(layout.cards[0]?.lines.join(" ")).not.toContain("secretvalue123");
    expect(layout.cards[1]?.gapBefore).toBe(true);
    expect(layout.width * layout.scale).toBeLessThanOrEqual(MAXIMUM_SHARE_IMAGE_EDGE_PIXELS);
    expect(layout.height * layout.scale).toBeLessThanOrEqual(MAXIMUM_SHARE_IMAGE_EDGE_PIXELS);
    expect(layout.width * layout.height * layout.scale ** 2).toBeLessThanOrEqual(MAXIMUM_SHARE_IMAGE_PIXELS);
  });

  it("rejects selections that exceed the shared readable-content budget", () => {
    expect(() => layoutShareSelectionImage({
      sessionName: "Task",
      messages: [{ id: "one", role: "user", roleLabel: "You", text: "x".repeat(MAXIMUM_SHARE_MESSAGE_CHARACTERS + 1), attachmentNames: [], attachmentsLabel: "Attachments", gapBefore: false }]
    }, () => 1)).toThrow(ShareMessageImageTooLargeError);
  });

  it("encodes in the initiating document and releases the canvas", async () => {
    const surface = shareImageTestSurface();
    await expect(buildShareSelectionImagePng({ sessionName: "Task", messages: [{ id: "one", role: "assistant", roleLabel: "Agent", text: "Done", attachmentNames: [], attachmentsLabel: "Attachments", gapBefore: false }] }, surface.action, shareImageTestPalette)).resolves.toMatchObject({ type: "image/png" });
    expect(surface.canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/png");
    expect([surface.canvas.width, surface.canvas.height]).toEqual([0, 0]);
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
