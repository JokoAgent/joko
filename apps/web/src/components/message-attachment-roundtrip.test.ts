// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { ArtifactView } from "../model.js";
import {
  restoreMessageAttachmentDrafts,
  sameMessageAttachments
} from "./message-attachment-roundtrip.js";

describe("message attachment draft round trip", () => {
  it("rehydrates every durable input artifact in order", async () => {
    const artifacts = [artifact("image", "capture.png", "image/png", 3), artifact("file", "notes.txt", "text/plain", 4)];
    let next = 0;
    const drafts = await restoreMessageAttachmentDrafts(
      artifacts,
      { images: true, files: true, maximumItems: 4, maximumBytes: 10 },
      async (value) => new Blob([value.kind === "image" ? "img" : "note"], { type: value.mediaType }),
      () => `draft-${++next}`
    );
    expect(drafts.map((draft) => ({ id: draft.id, kind: draft.kind, name: draft.file.name, size: draft.file.size, type: draft.file.type }))).toEqual([
      { id: "draft-1", kind: "image", name: "capture.png", size: 3, type: "image/png" },
      { id: "draft-2", kind: "file", name: "notes.txt", size: 4, type: "text/plain" }
    ]);
    expect(drafts.every((draft) => draft.previewUrl === undefined)).toBe(true);
  });

  it("does not invent an item-count limit when the capability declares none", async () => {
    const artifacts = Array.from({ length: 17 }, (_value, index) => artifact("file", `note-${index + 1}.txt`, "text/plain", 1));
    const drafts = await restoreMessageAttachmentDrafts(
      artifacts,
      { images: true, files: true, maximumBytes: 10 },
      async () => new Blob(["x"], { type: "text/plain" }),
      () => crypto.randomUUID()
    );
    expect(drafts).toHaveLength(17);
  });

  it("does not invent a byte limit when the capability declares none", async () => {
    const blob = new Blob(["x"], { type: "application/octet-stream" });
    Object.defineProperty(blob, "size", { configurable: true, value: 25 * 1024 * 1024 + 1 });
    const drafts = await restoreMessageAttachmentDrafts(
      [artifact("file", "large.bin", "application/octet-stream", 0)],
      { images: true, files: true },
      async () => blob,
      () => "large-draft"
    );
    expect(drafts).toHaveLength(1);
  });

  it("fails closed before loading when the current capability cannot resend a kind", async () => {
    const load = vi.fn(async () => new Blob(["img"], { type: "image/png" }));
    await expect(restoreMessageAttachmentDrafts(
      [artifact("image", "capture.png", "image/png", 3)],
      { images: false, files: true, maximumItems: 4, maximumBytes: 10 },
      load,
      () => "draft"
    )).rejects.toMatchObject({ reason: "unsupported" });
    expect(load).not.toHaveBeenCalled();
  });

  it("rejects a changed blob instead of publishing a partial attachment tray", async () => {
    await expect(restoreMessageAttachmentDrafts(
      [artifact("file", "notes.txt", "text/plain", 4)],
      { images: true, files: true, maximumItems: 4, maximumBytes: 10 },
      async () => new Blob(["different"], { type: "text/plain" }),
      () => "draft"
    )).rejects.toMatchObject({ reason: "blobMismatch" });
  });

  it("compares the complete ordered descriptor after asynchronous loading", () => {
    const first = [artifact("file", "notes.txt", "text/plain", 4)];
    expect(sameMessageAttachments(first, [{ ...first[0]! }])).toBe(true);
    expect(sameMessageAttachments(first, [{ ...first[0]!, blobId: "replacement" }])).toBe(false);
    expect(sameMessageAttachments(first, [])).toBe(false);
  });
});

function artifact(kind: "image" | "file", fileName: string, mediaType: string, byteSize: number): ArtifactView {
  return { id: `${kind}-${fileName}`, blobId: `blob-${kind}-${fileName}`, title: fileName, kind, fileName, mediaType, byteSize };
}
