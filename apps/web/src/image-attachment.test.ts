// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttachmentDraft } from "./model.js";
import { editImageAttachment, materializeImageAttachment } from "./image-attachment.js";

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
const strokes = [{ points: [{ x: 0.25, y: 0.5 }, { x: 0.75, y: 0.6 }] }];

describe("editable image drafts", () => {
  it("retains the original file and identity, snapshots vectors and clears back to the original", () => {
    const source: AttachmentDraft = { id: "image", kind: "image", file: new File(["original"], "original.jpg", { type: "image/jpeg" }), previewUrl: "blob:original" };
    const next = editImageAttachment([source], source, strokes), saved = next[0]!;
    expect(saved.id).toBe(source.id); expect(saved.file).toBe(source.file); expect(saved.previewUrl).toBe(source.previewUrl);
    expect(saved.annotationStrokes).toEqual(strokes); expect(saved.annotationStrokes).not.toBe(strokes);
    expect(saved.annotationStrokes![0]!.points[0]).not.toBe(strokes[0]!.points[0]);
    expect(source.annotationStrokes).toBeUndefined();
    expect(editImageAttachment(next, saved, strokes)).toBe(next);
    expect(editImageAttachment([source], source, [])[0]).toBe(source);
    expect(editImageAttachment(next, saved, [])[0]).toEqual(source);
    expect(() => editImageAttachment(next, source, [])).toThrow("changed");
    expect(() => editImageAttachment([{ ...source, file: new File(["replacement"], source.file.name) }], source, strokes)).toThrow("changed");
    expect(() => editImageAttachment([], saved, strokes)).toThrow("changed");
    expect(() => editImageAttachment([source], source, [{ points: [{ x: Number.NaN, y: 0 }] }])).toThrow("invalid");
  });

  it("returns unmarked files without decoding or changing their format", async () => {
    const source: AttachmentDraft = { id: "plain", kind: "image", file: new File(["jpeg"], "plain.jpg", { type: "image/jpeg" }) };
    const create = vi.spyOn(document, "createElement");
    expect(await materializeImageAttachment(source, new AbortController().signal)).toBe(source.file);
    expect(create).not.toHaveBeenCalled();
  });

  it("renders the captured original and vectors in the owning document without overwriting the editable source", async () => {
    const frame = document.body.appendChild(document.createElement("iframe")), owner = frame.contentDocument!, target = canvasFixture(owner);
    const source: AttachmentDraft = { id: "marked", kind: "image", file: new File(["jpeg"], "photo.jpg", { type: "image/jpeg", lastModified: 123 }), annotationStrokes: strokes };
    const result = await materializeImageAttachment(source, new AbortController().signal, owner);
    expect(result).toBeInstanceOf(owner.defaultView!.File); expect(result).not.toBe(source.file);
    expect([result.name, result.type, result.lastModified, result.size]).toEqual(["photo.png", "image/png", 123, 7]);
    expect(target.context.drawImage).toHaveBeenCalledExactlyOnceWith(target.image, 0, 0);
    expect(target.context.moveTo).toHaveBeenCalledWith(100, 150);
    expect(target.context.lineTo).toHaveBeenCalledWith(300, 180);
    expect(target.createUrl).toHaveBeenCalledExactlyOnceWith(source.file); expect(target.revokeUrl).toHaveBeenCalledExactlyOnceWith("blob:owned-source");
    expect(source.file.type).toBe("image/jpeg"); expect(source.annotationStrokes).toEqual(strokes);
    expect([target.canvas.width, target.canvas.height]).toEqual([0, 0]);
  });

  it.each(["failure", "retirement"] as const)("does not return an unmarked fallback after encoding %s", async mode => {
    const target = canvasFixture(document), request = new AbortController();
    let finish!: BlobCallback;
    target.encode.mockImplementation(callback => { finish = callback; });
    const source: AttachmentDraft = { id: "marked", kind: "image", file: new File(["original"], "source.png", { type: "image/png" }), annotationStrokes: strokes };
    const materializing = materializeImageAttachment(source, request.signal);
    const rejected = expect(materializing).rejects.toThrow(mode === "failure" ? "encoding failed" : "Original draft retired");
    await vi.waitFor(() => expect(target.encode).toHaveBeenCalledOnce());
    if (mode === "retirement") request.abort(new Error("Original draft retired"));
    finish(mode === "failure" ? null : new Blob(["late"], { type: "image/png" }));
    await rejected;
    expect(source.annotationStrokes).toEqual(strokes); expect(target.revokeUrl).toHaveBeenCalledOnce();
    expect([target.canvas.width, target.canvas.height]).toEqual([0, 0]);
  });
});

function canvasFixture(owner: Document) {
  const ownerWindow = owner.defaultView!, image = owner.createElement("img"), canvas = owner.createElement("canvas");
  const context = { drawImage: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn() };
  Object.defineProperties(image, { naturalWidth: { value: 400 }, naturalHeight: { value: 300 },
    src: { configurable: true, set() { queueMicrotask(() => image.dispatchEvent(new ownerWindow.Event("load"))); } } });
  const encode = vi.fn<(callback: BlobCallback, type?: string) => void>(callback => callback(new ownerWindow.Blob(["encoded"], { type: "image/png" })));
  Object.defineProperties(canvas, { getContext: { value: () => context }, toBlob: { value: encode } });
  const create = owner.createElement.bind(owner);
  vi.spyOn(owner, "createElement").mockImplementation(((tag: string) => tag === "img" ? image : tag === "canvas" ? canvas : create(tag)) as typeof owner.createElement);
  const createUrl = vi.fn(() => "blob:owned-source"), revokeUrl = vi.fn();
  Object.defineProperties(ownerWindow.URL, { createObjectURL: { configurable: true, value: createUrl }, revokeObjectURL: { configurable: true, value: revokeUrl } });
  return { image, canvas, context, encode, createUrl, revokeUrl };
}
