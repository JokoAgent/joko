import { create } from "@bufbuild/protobuf";
import { EventSchema, MessageRole } from "@joko/contracts";
import { describe, expect, it } from "vitest";
import {
  inspectMobileImageGalleryBytes,
  mobileImageGalleryMediaType,
  mobileTimelineGalleryPages,
  mobileTimelineGalleryWindowKey
} from "./mobile-image-gallery";

const sha = "a".repeat(64);

describe("mobile image gallery", () => {
  it("accepts bounded static JPEG, PNG, and WebP bytes while rejecting animation and mismatched MIME", () => {
    expect(inspectMobileImageGalleryBytes(png(40, 30), "image/png"))
      .toEqual({ mediaType: "image/png", width: 40, height: 30 });
    expect(inspectMobileImageGalleryBytes(jpeg(320, 240), "image/jpeg"))
      .toEqual({ mediaType: "image/jpeg", width: 320, height: 240 });
    expect(inspectMobileImageGalleryBytes(webpExtended(90, 50), "image/webp"))
      .toEqual({ mediaType: "image/webp", width: 90, height: 50 });
    expect(() => inspectMobileImageGalleryBytes(webpExtended(90, 50, true), "image/webp"))
      .toThrow(/signature or dimensions/u);
    expect(() => inspectMobileImageGalleryBytes(png(40, 30), "image/jpeg"))
      .toThrow(/signature or dimensions/u);
    expect(mobileImageGalleryMediaType("image/gif")).toBeUndefined();
    expect(mobileImageGalleryMediaType("image/svg+xml")).toBeUndefined();
  });

  it("keeps ordered unique raster pages inside one completed message", () => {
    const event = create(EventSchema, {
      eventId: "done",
      identity: { sessionId: "session" },
      cursor: { generation: 4n, sequence: 9n },
      payload: { kind: { case: "messageCompleted", value: {
        messageId: "message",
        role: MessageRole.ASSISTANT,
        blocks: [
          { content: { case: "text", value: "Here" } },
          { content: { case: "image", value: { blob: {
            blobId: "blob-one", fileName: "one.png", mediaType: "image/png", byteSize: 100n, sha256Hex: sha
          }, widthPixels: 20, heightPixels: 10, altText: "First" } } },
          { content: { case: "image", value: { blob: {
            blobId: "blob-one", fileName: "duplicate.png", mediaType: "image/png", byteSize: 100n, sha256Hex: sha
          }, widthPixels: 20, heightPixels: 10 } } },
          { content: { case: "artifact", value: { blob: {
            blobId: "blob-two", fileName: "two.webp", mediaType: "image/webp", byteSize: 90n,
            sha256Hex: "b".repeat(64)
          }, label: "Second" } } },
          { content: { case: "artifact", value: { blob: {
            blobId: "animated", fileName: "moving.gif", mediaType: "image/gif", byteSize: 80n,
            sha256Hex: "c".repeat(64)
          }, label: "Animated" } } }
        ]
      } } }
    });

    expect(mobileTimelineGalleryPages(event).map((page) => ({
      title: page.title,
      source: page.source,
      mediaType: page.mediaType
    }))).toEqual([
      { title: "First", mediaType: "image/png", source: {
        kind: "timeline", eventId: "done", messageId: "message", contentKind: "block", contentIndex: 1
      } },
      { title: "Second", mediaType: "image/webp", source: {
        kind: "timeline", eventId: "done", messageId: "message", contentKind: "block", contentIndex: 3
      } }
    ]);
  });

  it("projects only authoritative accepted user images before a completion event exists", () => {
    const accepted = create(EventSchema, {
      eventId: "accepted",
      identity: { sessionId: "session" },
      cursor: { generation: 1n, sequence: 3n },
      payload: { kind: { case: "messageStarted", value: {
        messageId: "user-message",
        role: MessageRole.USER,
        userInputAccepted: true,
        userInput: { parts: [{ content: { case: "image", value: { blob: {
          blobId: "accepted-image", fileName: "accepted.png", mediaType: "image/png",
          byteSize: 68n, sha256Hex: sha
        }, widthPixels: 0, heightPixels: 0, altText: "Accepted image" } } }] }
      } } }
    });
    const imported = create(EventSchema, {
      eventId: "imported",
      identity: { sessionId: "session" },
      cursor: { generation: 1n, sequence: 4n },
      payload: { kind: { case: "messageStarted", value: {
        messageId: "imported-message",
        role: MessageRole.USER,
        userInputAccepted: false,
        userInput: { parts: [{ content: { case: "image", value: { blob: {
          blobId: "imported-image", fileName: "imported.png", mediaType: "image/png",
          byteSize: 68n, sha256Hex: sha
        }, widthPixels: 1, heightPixels: 1, altText: "Imported image" } } }] }
      } } }
    });

    expect(mobileTimelineGalleryPages(accepted)).toMatchObject([{
      title: "Accepted image",
      source: {
        kind: "timeline",
        eventId: "accepted",
        messageId: "user-message",
        contentKind: "inputPart",
        contentIndex: 0
      }
    }]);
    expect(mobileTimelineGalleryPages(imported)).toEqual([]);
  });

  it("changes the frozen source-window identity when a durable event is added", () => {
    const first = create(EventSchema, {
      eventId: "one", identity: { sessionId: "session" }, cursor: { generation: 1n, sequence: 1n },
      payload: { kind: { case: "runDone", value: { runId: "run" } } }
    });
    const second = create(EventSchema, {
      eventId: "two", identity: { sessionId: "session" }, cursor: { generation: 1n, sequence: 2n },
      payload: { kind: { case: "runDone", value: { runId: "run" } } }
    });
    expect(mobileTimelineGalleryWindowKey([first, second]))
      .not.toBe(mobileTimelineGalleryWindowKey([first]));
    expect(mobileTimelineGalleryWindowKey([first, first]))
      .toBe(mobileTimelineGalleryWindowKey([first]));
  });
});

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(45);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  writeU32Be(bytes, 8, 13);
  bytes.set([73, 72, 68, 82], 12);
  writeU32Be(bytes, 16, width);
  writeU32Be(bytes, 20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  writeU32Be(bytes, 33, 0);
  bytes.set([73, 69, 78, 68], 37);
  return bytes;
}

function jpeg(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    height >>> 8, height & 0xff, width >>> 8, width & 0xff,
    0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9
  ]);
}

function webpExtended(width: number, height: number, animated = false): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([82, 73, 70, 70], 0);
  writeU32Le(bytes, 4, 22);
  bytes.set([87, 69, 66, 80, 86, 80, 56, 88], 8);
  writeU32Le(bytes, 16, 10);
  bytes[20] = animated ? 0x02 : 0;
  writeU24Le(bytes, 24, width - 1);
  writeU24Le(bytes, 27, height - 1);
  return bytes;
}

function writeU24Le(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = value >>> 8 & 0xff;
  bytes[offset + 2] = value >>> 16 & 0xff;
}

function writeU32Be(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value >>> 24 & 0xff;
  bytes[offset + 1] = value >>> 16 & 0xff;
  bytes[offset + 2] = value >>> 8 & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function writeU32Le(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = value >>> 8 & 0xff;
  bytes[offset + 2] = value >>> 16 & 0xff;
  bytes[offset + 3] = value >>> 24 & 0xff;
}
