import { create } from "@bufbuild/protobuf";
import { EventSchema, MessageRole } from "@joko/contracts";
import { describe, expect, it } from "vitest";
import { timelineRows } from "./timeline";

function completed(blocks: any[], role = MessageRole.ASSISTANT) {
  return create(EventSchema, {
    eventId: "complete",
    identity: { sessionId: "session" },
    cursor: { generation: 1n, sequence: 1n },
    payload: { kind: { case: "messageCompleted", value: {
      messageId: "message",
      role,
      blocks
    } } }
  });
}

describe("mobile Timeline quote source", () => {
  it("exposes exact completed assistant pure text and nothing else as quote authority", () => {
    expect(timelineRows([completed([
      { content: { case: "text", value: "first" } },
      { content: { case: "text", value: "second" } }
    ])])[0]?.quoteSource).toEqual({
      sourceMessageId: "message",
      sourceEventId: "complete",
      text: "first\nsecond"
    });
    expect(timelineRows([completed([
      { content: { case: "text", value: "first" } },
      { content: { case: "artifact", value: {} } }
    ])])[0]?.quoteSource).toBeUndefined();
    expect(timelineRows([completed([{ content: { case: "text", value: "user" } }], MessageRole.USER)])[0]?.quoteSource)
      .toBeUndefined();
    expect(timelineRows([completed([{ content: { case: "text", value: "   " } }])])[0]?.quoteSource)
      .toBeUndefined();
  });

  it("keeps exact supported non-image artifact occurrences beside completed messages", () => {
    const row = timelineRows([completed([
      { content: { case: "artifact", value: { label: "Recording", blob: {
        blobId: "recording", fileName: "recording.mp3", mediaType: "audio/mpeg",
        byteSize: 256n, sha256Hex: "a".repeat(64)
      } } } },
      { content: { case: "artifact", value: { label: "Model", blob: {
        blobId: "model", fileName: "model.glb", mediaType: "model/gltf-binary",
        byteSize: 256n, sha256Hex: "b".repeat(64)
      } } } }
    ])])[0];
    expect(row?.artifacts).toMatchObject([
      { eventId: "complete", messageId: "message", contentIndex: 0, title: "Recording", previewKind: "media" },
      { eventId: "complete", messageId: "message", contentIndex: 1, title: "Model", previewKind: "model" }
    ]);
  });

  it("keeps arbitrary and over-preview-limit files shareable without duplicating gallery images", () => {
    const row = timelineRows([completed([
      { content: { case: "artifact", value: { label: "Archive", blob: {
        blobId: "archive", fileName: "archive.zip", mediaType: "application/zip",
        byteSize: 256n, sha256Hex: "a".repeat(64)
      } } } },
      { content: { case: "artifact", value: { label: "Large image", blob: {
        blobId: "large-image", fileName: "large.png", mediaType: "image/png",
        byteSize: 33_554_433n, sha256Hex: "b".repeat(64)
      } } } },
      { content: { case: "artifact", value: { label: "Small image", blob: {
        blobId: "small-image", fileName: "small.png", mediaType: "image/png",
        byteSize: 256n, sha256Hex: "c".repeat(64)
      } } } }
    ])])[0];

    expect(row?.images).toMatchObject([{ title: "Small image", mediaType: "image/png" }]);
    expect(row?.artifacts).toMatchObject([
      { contentIndex: 0, title: "Archive" },
      { contentIndex: 1, title: "Large image" }
    ]);
    expect(row?.artifacts?.every((artifact) => artifact.previewKind === undefined)).toBe(true);
  });
});
