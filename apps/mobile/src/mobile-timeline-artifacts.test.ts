import { create } from "@bufbuild/protobuf";
import {
  BlobRefSchema,
  EventPayloadSchema,
  EventSchema,
  MessageArtifactBlockSchema,
  MessageBlockSchema,
  MessageCompletedEventSchema,
  MessageRole,
  MessageStartedEventSchema,
  type MessageBlock,
  type Event
} from "@joko/contracts";
import { describe, expect, it } from "vitest";
import {
  mobileTimelineArtifacts,
  mobileTimelineArtifactWindowKey,
  mobileTimelinePreviewArtifacts,
  mobileTimelinePreviewWindowKey,
  resolveMobileTimelineArtifact,
  resolveMobileTimelinePreviewArtifact
} from "./mobile-timeline-artifacts";

describe("mobile Timeline preview artifacts", () => {
  it("projects supported durable artifact blocks in message order", () => {
    const event = completedEvent([
      artifactBlock("movie.mp4", "video/mp4", "Demo"),
      create(MessageBlockSchema, { content: { case: "text", value: "body" } }),
      artifactBlock("notes.pdf", "application/pdf", "Notes"),
      artifactBlock("mesh.glb", "model/gltf-binary", "Mesh")
    ]);
    expect(mobileTimelinePreviewArtifacts(event)).toMatchObject([
      { contentIndex: 0, title: "Demo", mediaType: "video/mp4", previewKind: "media" },
      { contentIndex: 2, title: "Notes", mediaType: "application/pdf", previewKind: "pdf" },
      { contentIndex: 3, title: "Mesh", mediaType: "model/gltf-binary", previewKind: "model" }
    ]);
  });

  it("projects arbitrary bounded files for sharing while keeping preview bounds distinct", () => {
    const event = completedEvent([
      artifactBlock("archive.zip", "application/zip", "Archive"),
      artifactBlock("empty.txt", "text/plain", "Empty", { byteSize: 0n }),
      artifactBlock("large.pdf", "application/pdf", "Large", { byteSize: 33_554_433n })
    ]);
    expect(mobileTimelineArtifacts(event)).toMatchObject([
      { contentIndex: 0, title: "Archive", mediaType: "application/zip" },
      { contentIndex: 1, title: "Empty", mediaType: "text/plain" },
      { contentIndex: 2, title: "Large", mediaType: "application/pdf" }
    ]);
    expect(mobileTimelinePreviewArtifacts(event)).toEqual([]);
    const selected = mobileTimelineArtifacts(event)[0]!;
    expect(resolveMobileTimelineArtifact([event], selected)?.blob.fileName).toBe("archive.zip");
  });

  it("rejects imported, malformed, oversized and non-completed sources", () => {
    const malformed = completedEvent([
      artifactBlock("song.mp3", "audio/mpeg", "", { sha256Hex: "bad" }),
      artifactBlock("huge.pdf", "application/pdf", "", { byteSize: 33_554_433n }),
      artifactBlock("missing.pdf", "application/pdf", "", { blobId: "" }),
      artifactBlock("wrong.bin", "model/gltf-binary", "")
    ]);
    expect(mobileTimelinePreviewArtifacts(malformed)).toEqual([]);
    expect(mobileTimelineArtifacts(malformed)).toHaveLength(2);
    expect(mobileTimelinePreviewArtifacts(create(EventSchema, {
      ...malformed,
      eventId: "started",
      payload: create(EventPayloadSchema, { kind: { case: "messageStarted", value: create(MessageStartedEventSchema, {
        messageId: "message", role: MessageRole.USER, userInputAccepted: true
      }) } })
    }))).toEqual([]);
  });

  it("resolves one exact event/message/content/blob occurrence and fences its window", () => {
    const event = completedEvent([artifactBlock("song.mp3", "audio/mpeg", "Song")]);
    const selected = mobileTimelinePreviewArtifacts(event)[0]!;
    expect(resolveMobileTimelinePreviewArtifact([event], selected)?.blob.fileName).toBe("song.mp3");
    expect(resolveMobileTimelinePreviewArtifact([event, event], selected)).toBeUndefined();
    const replaced = completedEvent([artifactBlock("other.mp3", "audio/mpeg", "Song")]);
    expect(resolveMobileTimelinePreviewArtifact([replaced], selected)).toBeUndefined();
    expect(mobileTimelinePreviewWindowKey([event])).not.toBe(mobileTimelinePreviewWindowKey([replaced]));
    expect(mobileTimelineArtifactWindowKey([event])).not.toBe(mobileTimelineArtifactWindowKey([replaced]));
    const contentReplaced = completedEvent([
      artifactBlock("song.mp3", "audio/mpeg", "Song", { sha256Hex: "b".repeat(64) })
    ]);
    expect(resolveMobileTimelinePreviewArtifact([contentReplaced], selected)).toBeUndefined();
    expect(mobileTimelinePreviewWindowKey([event])).not.toBe(mobileTimelinePreviewWindowKey([contentReplaced]));
    const appended = create(EventSchema, {
      eventId: "later",
      identity: { sessionId: "session" },
      cursor: { opaqueToken: "later-cursor", generation: 1n, sequence: 5n },
      payload: create(EventPayloadSchema, { kind: { case: "messageStarted", value: create(MessageStartedEventSchema, {
        messageId: "later-message", role: MessageRole.ASSISTANT
      }) } })
    });
    expect(resolveMobileTimelinePreviewArtifact([event, appended], selected)?.blob.fileName).toBe("song.mp3");
    expect(mobileTimelinePreviewWindowKey([event])).not.toBe(mobileTimelinePreviewWindowKey([event, appended]));
  });
});

function artifactBlock(
  fileName: string,
  mediaType: string,
  label: string,
  override: Partial<{ blobId: string; sha256Hex: string; byteSize: bigint }> = {}
) {
  return create(MessageBlockSchema, { content: { case: "artifact", value: create(MessageArtifactBlockSchema, {
    label,
    blob: create(BlobRefSchema, {
      blobId: override.blobId ?? `blob-${fileName}`,
      fileName,
      mediaType,
      byteSize: override.byteSize ?? 128n,
      sha256Hex: override.sha256Hex ?? "a".repeat(64)
    })
  }) } });
}

function completedEvent(blocks: MessageBlock[]): Event {
  return create(EventSchema, {
    eventId: "event",
    identity: { sessionId: "session" },
    cursor: { opaqueToken: "cursor", generation: 1n, sequence: 4n },
    payload: { kind: { case: "messageCompleted", value: create(MessageCompletedEventSchema, {
      messageId: "message",
      role: MessageRole.ASSISTANT,
      blocks
    }) } }
  });
}
