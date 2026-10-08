import { create } from "@bufbuild/protobuf";
import {
  AudioArtifactKind,
  AudioArtifactMetadataSchema,
  BlobRefSchema,
  EventPayloadSchema,
  EventCursorSchema,
  EventSchema,
  ImageRefSchema,
  MessageArtifactBlockSchema,
  MessageBlockSchema,
  MessageCompletedEventSchema,
  MessageRole,
  MessageStartedEventSchema,
  type MessageBlock,
  type Event
} from "@joko/contracts";
import { describe, expect, it } from "vitest";
import { producedArtifactEvent, toolMediaEvent } from "./test/timeline-media";
import {
  mobileTimelineArtifacts,
  mobileTimelineArtifactWindowKey,
  mobileTimelinePreviewArtifacts,
  mobileTimelinePreviewWindowKey,
  resolveMobileTimelineArtifact,
  resolveMobileTimelinePreviewArtifact
} from "./mobile-timeline-artifacts";

describe("mobile Timeline preview artifacts", () => {
  it("keeps canonical audio information complete and retires its selected occurrence when metadata changes", () => {
    const metadata = () => create(AudioArtifactMetadataSchema, { kind: AudioArtifactKind.MUSIC, title: "x".repeat(513),
      description: "Full description\n".repeat(400), durationSeconds: 12,
      artwork: create(ImageRefSchema, { widthPixels: 2, heightPixels: 3, altText: "Cover",
        blob: create(BlobRefSchema, { blobId: "cover", sha256Hex: "b".repeat(64), byteSize: 24n, mediaType: "image/png", fileName: "cover.png" }) }) });
    const audioBlock = () => {
      const block = artifactBlock("song.mp3", "audio/mpeg", "File label");
      if (block.content.case !== "artifact") throw new Error("fixture");
      block.content.value.audioMetadata = metadata();
      return block;
    };
    const original = completedEvent([audioBlock()]);
    const selected = mobileTimelinePreviewArtifacts(original)[0]!;
    expect(selected).toMatchObject({ title: "x".repeat(513), audioMetadata: { kind: "music", title: "x".repeat(513),
      description: "Full description\n".repeat(400), durationSeconds: 12, artwork: { blob: { blobId: "cover" }, width: 2, height: 3, alt: "Cover" } } });
    expect(resolveMobileTimelinePreviewArtifact([completedEvent([audioBlock()])], selected)).toBeDefined();
    const changes = [
      { title: "New title" }, { description: "Updated description" }, { durationSeconds: 13 },
      { artwork: create(ImageRefSchema, { ...metadata().artwork!, blob: create(BlobRefSchema, { ...metadata().artwork!.blob!, sha256Hex: "c".repeat(64) }) }) }
    ];
    for (const change of changes) {
      const block = audioBlock();
      if (block.content.case !== "artifact") throw new Error("fixture");
      block.content.value.audioMetadata = create(AudioArtifactMetadataSchema, { ...metadata(), ...change });
      const changed = completedEvent([block]);
      expect(resolveMobileTimelinePreviewArtifact([changed], selected)).toBeUndefined();
      expect(mobileTimelinePreviewWindowKey([changed])).not.toBe(mobileTimelinePreviewWindowKey([original]));
      expect(mobileTimelineArtifactWindowKey([changed])).not.toBe(mobileTimelineArtifactWindowKey([original]));
    }
    const withoutMetadata = completedEvent([artifactBlock("song.mp3", "audio/mpeg", "File label")]);
    expect(resolveMobileTimelinePreviewArtifact([withoutMetadata], selected)).toBeUndefined();
    expect(mobileTimelinePreviewArtifacts(withoutMetadata)[0]).toMatchObject({ title: "File label", previewKind: "media" });
    expect(mobileTimelinePreviewArtifacts(withoutMetadata)[0]?.audioMetadata).toBeUndefined();
  });

  it("resolves exact typed tool and produced occurrences and retires replaced or foreign scope", () => {
    const original = completedEvent([artifactBlock("clip.mp4", "video/mp4", "Clip")]);
    const tool = toolMediaEvent(original, "toolCallUpdated");
    const selected = mobileTimelineArtifacts(tool)[0]!;
    expect(selected.source).toMatchObject({ kind: "tool", contentIndex: 0 });
    expect(resolveMobileTimelineArtifact([tool], selected)?.blob.fileName).toBe("clip.mp4");
    if (tool.payload?.kind.case !== "toolCallUpdated") throw new Error("fixture");
    const part = tool.payload.kind.value.incrementalResult!.parts[0]!.content;
    if (part.case !== "artifact") throw new Error("fixture");
    part.value.artifactId = "replacement-native-artifact";
    expect(resolveMobileTimelineArtifact([tool], selected)).toBeUndefined();
    const terminal = toolMediaEvent(create(EventSchema, { ...original, eventId: "terminal", cursor: create(EventCursorSchema, { generation: 1n, sequence: 5n }) }));
    expect(resolveMobileTimelineArtifact([tool, terminal], selected)).toBeUndefined();
    const produced = producedArtifactEvent(original);
    const artifact = mobileTimelineArtifacts(produced)[0]!;
    expect(artifact.source).toMatchObject({ kind: "artifactProduced", artifactId: "canonical-file" });
    expect(resolveMobileTimelineArtifact([produced], artifact)?.blob.fileName).toBe("clip.mp4");
    if (produced.payload?.kind.case !== "artifactProduced" || tool.payload?.kind.case !== "toolCallUpdated") throw new Error("fixture");
    produced.payload.kind.value.artifact!.runId = "foreign-run";
    tool.payload.kind.value.toolCall!.sessionId = "foreign-session";
    expect(mobileTimelineArtifacts(produced)).toEqual([]);
    expect(mobileTimelineArtifacts(tool)).toEqual([]);
  });
  it("projects supported durable artifact blocks in message order", () => {
    const event = completedEvent([
      artifactBlock("movie.mp4", "video/mp4", "Demo"),
      create(MessageBlockSchema, { content: { case: "text", value: "body" } }),
      artifactBlock("notes.pdf", "application/pdf", "Notes"),
      artifactBlock("mesh.glb", "model/gltf-binary", "Mesh"),
      artifactBlock("page.html", "text/html", "Page"),
      artifactBlock("source.zig", "application/octet-stream", "Source"),
      artifactBlock(".env", "application/octet-stream", "Config")
    ]);
    expect(mobileTimelinePreviewArtifacts(event)).toMatchObject([
      { source: { kind: "timeline", contentIndex: 0 }, title: "Demo", mediaType: "video/mp4", previewKind: "media" },
      { source: { kind: "timeline", contentIndex: 2 }, title: "Notes", mediaType: "application/pdf", previewKind: "pdf" },
      { source: { kind: "timeline", contentIndex: 3 }, title: "Mesh", mediaType: "model/gltf-binary", previewKind: "model" },
      { source: { kind: "timeline", contentIndex: 4 }, title: "Page", mediaType: "text/html", previewKind: "text" },
      { source: { kind: "timeline", contentIndex: 5 }, title: "Source", mediaType: "application/octet-stream", previewKind: "text" },
      { source: { kind: "timeline", contentIndex: 6 }, title: "Config", mediaType: "application/octet-stream", previewKind: "text" }
    ]);
  });

  it("projects arbitrary bounded files for sharing while keeping preview bounds distinct", () => {
    const event = completedEvent([
      artifactBlock("archive.zip", "application/zip", "Archive"),
      artifactBlock("empty.txt", "text/plain", "Empty", { byteSize: 0n }),
      artifactBlock("large.pdf", "application/pdf", "Large", { byteSize: 33_554_433n }),
      artifactBlock("large.html", "text/html", "Large page", { byteSize: 2_097_153n })
    ]);
    expect(mobileTimelineArtifacts(event)).toMatchObject([
      { source: { kind: "timeline", contentIndex: 0 }, title: "Archive", mediaType: "application/zip" },
      { source: { kind: "timeline", contentIndex: 1 }, title: "Empty", mediaType: "text/plain" },
      { source: { kind: "timeline", contentIndex: 2 }, title: "Large", mediaType: "application/pdf" },
      { source: { kind: "timeline", contentIndex: 3 }, title: "Large page", mediaType: "text/html" }
    ]);
    expect(mobileTimelinePreviewArtifacts(event)).toMatchObject([{ title: "Empty", previewKind: "text", byteSize: 0n }]);
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
