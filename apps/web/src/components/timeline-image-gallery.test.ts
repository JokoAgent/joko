import { describe, expect, it } from "vitest";
import type { ArtifactView, TimelineItemView } from "../model.js";
import { collectTimelineGalleryImages, moveTimelineGalleryIndex, resolveImageLightboxKey } from "./timeline-image-gallery.js";

describe("timeline image gallery", () => {
  it("collects image artifacts and attachments in source order without deduplicating blobs", () => {
    const repeated = image("shared", "shared.png");
    const items: TimelineItemView[] = [
      timelineItem("user", "user", { attachments: [repeated, file("notes"), image("second", "second.png")] }),
      timelineItem("image-row", "image", { artifact: { ...repeated, id: "rendered" } }),
      timelineItem("tool", "tool", { attachments: [{ ...repeated, id: "tool-copy" }] })
    ];

    expect(collectTimelineGalleryImages(items).map((entry) => [entry.id, entry.blobId])).toEqual([
      ["attachment:user:shared:0", "blob-shared"],
      ["attachment:user:second:2", "blob-second"],
      ["artifact:image-row:rendered", "blob-shared"],
      ["attachment:tool:tool-copy:0", "blob-shared"]
    ]);
  });

  it("wraps previous and next navigation across the full gallery", () => {
    expect(moveTimelineGalleryIndex(0, 3, -1)).toBe(2);
    expect(moveTimelineGalleryIndex(2, 3, 1)).toBe(0);
    expect(moveTimelineGalleryIndex(0, 0, 1)).toBe(0);
  });

  it("maps viewer keys while ignoring composition and modified shortcuts", () => {
    expect(resolveImageLightboxKey({ key: "Escape" })).toBe("close");
    expect(resolveImageLightboxKey({ key: "ArrowLeft" })).toBe("previous");
    expect(resolveImageLightboxKey({ key: "ArrowRight" })).toBe("next");
    expect(resolveImageLightboxKey({ key: "+" })).toBe("zoomIn");
    expect(resolveImageLightboxKey({ key: "-" })).toBe("zoomOut");
    expect(resolveImageLightboxKey({ key: "0" })).toBe("fit");
    expect(resolveImageLightboxKey({ key: "1" })).toBe("actualSize");
    expect(resolveImageLightboxKey({ key: "ArrowRight", isComposing: true })).toBeUndefined();
    expect(resolveImageLightboxKey({ key: "1", metaKey: true })).toBeUndefined();
  });
});

function timelineItem(id: string, kind: TimelineItemView["kind"], fields: Pick<TimelineItemView, "artifact" | "attachments">): TimelineItemView {
  return { id, kind, sequence: BigInt(id.length), createdAt: id.length, ...fields };
}

function image(id: string, fileName: string): ArtifactView {
  return { id, blobId: `blob-${id}`, title: id, kind: "image", fileName, mediaType: "image/png", byteSize: 42 };
}

function file(id: string): ArtifactView {
  return { id, blobId: `blob-${id}`, title: id, kind: "file", fileName: `${id}.txt`, mediaType: "text/plain", byteSize: 12 };
}
