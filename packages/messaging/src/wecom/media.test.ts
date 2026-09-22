import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import { MessagingTransportError } from "../types.js";
import {
  classifyWeComOutbound,
  safeWeComFileName,
  validateWeComDownload,
  WECOM_MAXIMUM_IMAGE_BYTES
} from "./media.js";

describe("WeCom media", () => {
  it("sanitizes traversal and Windows device names", () => {
    expect(safeWeComFileName("../../bad:name?.png", "image.jpg")).toBe("bad_name_.png");
    expect(safeWeComFileName("CON.txt", "attachment")).toBe("_CON.txt");
  });

  it("enforces the inbound image limit", () => {
    expect(() => validateWeComDownload({
      bytes: Buffer.alloc(WECOM_MAXIMUM_IMAGE_BYTES + 1),
      fileName: "large.jpg",
      fallbackName: "image.jpg",
      maximumBytes: WECOM_MAXIMUM_IMAGE_BYTES
    })).toThrowError(expect.objectContaining<Partial<MessagingTransportError>>({ code: "payload_too_large" }));
  });

  it("selects outbound image, voice, video and file media types", () => {
    const bytes = new Uint8Array([1]);
    expect(classifyWeComOutbound({ kind: "image", bytes, fileName: "a.png", mimeType: "image/png" }).mediaType).toBe("image");
    expect(classifyWeComOutbound({ kind: "file", bytes, fileName: "a.wav", mimeType: "audio/wav" }).mediaType).toBe("voice");
    expect(classifyWeComOutbound({ kind: "file", bytes, fileName: "a.mp4", mimeType: "video/mp4" }).mediaType).toBe("video");
    expect(classifyWeComOutbound({ kind: "file", bytes, fileName: "a.txt", mimeType: "text/plain" }).mediaType).toBe("file");
  });
});
