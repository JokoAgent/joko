import { create } from "@bufbuild/protobuf";
import { ArtifactProducedEventSchema, ArtifactRefSchema, ArtifactSchema, AudioArtifactKind, AudioArtifactMetadataSchema, BlobRefSchema,
  EventSchema, ImageRefSchema, MessageBlockSchema, MessageCompletedEventSchema, MessageRole,
  ToolCallSchema, ToolCallState, ToolResultSchema, type Event } from "@joko/contracts";
import { describe, expect, it } from "vitest";
import { mobileTimelineContent } from "./mobile-timeline-content";

describe("mobile canonical Timeline content", () => {
  it("retains each typed Artifact's own audio metadata across message, tool and produced sources", () => {
    const audioMetadata = create(AudioArtifactMetadataSchema, { kind: AudioArtifactKind.MUSIC,
      title: "Published track", description: "Full canonical description", durationSeconds: 12,
      artwork: create(ImageRefSchema, { widthPixels: 2, heightPixels: 3, altText: "Cover",
        blob: create(BlobRefSchema, { blobId: "cover", sha256Hex: "b".repeat(64), byteSize: 24n, mediaType: "image/png", fileName: "cover.png" }) }) });
    const blob = create(BlobRefSchema, { blobId: "song", sha256Hex: "a".repeat(64), byteSize: 128n, mediaType: "audio/mpeg", fileName: "song.mp3" });
    const artifact = create(ArtifactSchema, { artifactId: "track", sessionId: "session", runId: "run", title: "File label", blob, audioMetadata });
    const message = create(EventSchema, { eventId: "message-event", identity: { sessionId: "session", runId: "run" },
      payload: { kind: { case: "messageCompleted", value: create(MessageCompletedEventSchema, { messageId: "message", role: MessageRole.ASSISTANT,
        blocks: [create(MessageBlockSchema, { content: { case: "artifact", value: { label: "File label", blob, audioMetadata } } }),
          create(MessageBlockSchema, { content: { case: "artifact", value: { label: "Same bytes, no metadata", blob } } })] }) } } });
    const result = create(ToolResultSchema, { parts: [{ content: { case: "artifact", value: create(ArtifactRefSchema, {
      artifactId: artifact.artifactId, title: artifact.title, blob, audioMetadata
    }) } }] });
    const toolCall = create(ToolCallSchema, { toolCallId: "call", toolId: "media", toolProviderId: "provider",
      sessionId: "session", runId: "run", attemptId: "attempt", state: ToolCallState.RUNNING, result });
    const events: Event[] = [message,
      create(EventSchema, { eventId: "start", identity: { sessionId: "session", runId: "run", attemptId: "attempt" },
        payload: { kind: { case: "toolCallStarted", value: { toolCall } } } }),
      create(EventSchema, { eventId: "update", identity: { sessionId: "session", runId: "run", attemptId: "attempt" },
        payload: { kind: { case: "toolCallUpdated", value: { toolCall, incrementalResult: result } } } }),
      create(EventSchema, { eventId: "complete", identity: { sessionId: "session", runId: "run", attemptId: "attempt" },
        payload: { kind: { case: "toolCallCompleted", value: { toolCall: create(ToolCallSchema, { ...toolCall, state: ToolCallState.SUCCEEDED }) } } } }),
      create(EventSchema, { eventId: "produced", identity: { sessionId: "session", runId: "run" },
        payload: { kind: { case: "artifactProduced", value: create(ArtifactProducedEventSchema, { artifact }) } } })];
    for (const event of events) {
      const content = mobileTimelineContent(event);
      expect(content[0]).toMatchObject({ kind: "artifact", blob, audioMetadata: { kind: "music", title: "Published track",
        description: "Full canonical description", durationSeconds: 12,
        artwork: { width: 2, height: 3, alt: "Cover", blob: { blobId: "cover", sha256Hex: "b".repeat(64) } } } });
      expect(content[0]?.audioMetadata?.artwork?.blob).not.toBe(audioMetadata.artwork?.blob);
    }
    expect(mobileTimelineContent(message)[1]?.audioMetadata).toBeUndefined();
    expect(mobileTimelineContent(message)).toHaveLength(2);
  });
});
