import { describe, expect, it } from "vitest";

import { protoToolResult } from "./proto-mapper.js";

describe("tool result Artifact projection", () => {
  it("publishes the complete output BlobRef when the wire preview is truncated", () => {
    const result = protoToolResult("preview", {
      id: "artifact-complete-output",
      mimeType: "application/json",
      byteLength: 1_337,
      sha256: "a".repeat(64)
    });

    expect(result.truncated).toBe(true);
    expect(result.completeOutput).toMatchObject({
      blobId: "artifact-complete-output",
      mediaType: "application/json",
      byteSize: 1_337n,
      sha256Hex: "a".repeat(64)
    });
  });
});
