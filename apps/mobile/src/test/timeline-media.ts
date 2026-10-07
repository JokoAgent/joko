import { create } from "@bufbuild/protobuf";
import { ArtifactProducedEventSchema, ArtifactSchema, EventIdentitySchema, EventPayloadSchema, EventSchema, ImageProducedEventSchema,
  ToolCallSchema, ToolCallStartedEventSchema, ToolCallUpdatedEventSchema, ToolCallCompletedEventSchema,
  ToolCallState, ToolCallOutputMode, ToolResultSchema, ToolResultPartSchema,
  type Event } from "@joko/contracts";

export function toolMediaEvent(
  event: Event,
  phase: "toolCallStarted" | "toolCallUpdated" | "toolCallCompleted" = "toolCallCompleted",
  outputMode = ToolCallOutputMode.REPLACE
): Event {
  const message = event.payload?.kind;
  if (message?.case !== "messageCompleted") throw new Error("A completed message fixture is required.");
  const parts = message.value.blocks.flatMap((block) => {
    if (block.content.case === "image") return [create(ToolResultPartSchema, { content: block.content })];
    if (block.content.case === "artifact") return [create(ToolResultPartSchema, { content: {
      case: "artifact", value: { artifactId: `artifact-${block.content.value.blob?.blobId}`, title: block.content.value.label,
        blob: block.content.value.blob }
    } })];
    if (block.content.case === "text") return [create(ToolResultPartSchema, { content: block.content })];
    return [];
  });
  const result = create(ToolResultSchema, { parts });
  const toolCall = create(ToolCallSchema, { toolCallId: "media-call", toolId: "media", toolProviderId: "provider",
    sessionId: event.identity?.sessionId ?? "", runId: event.identity?.runId || "media-run",
    state: phase === "toolCallCompleted" ? ToolCallState.SUCCEEDED : ToolCallState.RUNNING,
    ...(phase === "toolCallUpdated" ? {} : { result }) });
  const identity = create(EventIdentitySchema, event.identity);
  identity.runId = toolCall.runId;
  return create(EventSchema, { ...event, identity,
    payload: create(EventPayloadSchema, { kind: phase === "toolCallUpdated"
      ? { case: phase, value: create(ToolCallUpdatedEventSchema, { toolCall, incrementalResult: result, outputMode }) }
      : phase === "toolCallStarted" ? { case: phase, value: create(ToolCallStartedEventSchema, { toolCall }) }
        : { case: phase, value: create(ToolCallCompletedEventSchema, { toolCall }) } })
  });
}

export function producedArtifactEvent(event: Event): Event {
  const message = event.payload?.kind;
  if (message?.case !== "messageCompleted") throw new Error("A completed message fixture is required.");
  const block = message.value.blocks.find((entry) => entry.content.case === "artifact" || entry.content.case === "image")?.content;
  if (block?.case !== "artifact" && block?.case !== "image") throw new Error("An artifact or image fixture is required.");
  const label = block.case === "artifact" ? block.value.label : block.value.altText;
  const identity = create(EventIdentitySchema, event.identity);
  identity.runId ||= "media-run";
  return create(EventSchema, { ...event, identity,
    payload: create(EventPayloadSchema, { kind: { case: "artifactProduced", value: create(ArtifactProducedEventSchema, { artifact: create(ArtifactSchema, {
      artifactId: "canonical-file", sessionId: event.identity?.sessionId ?? "", runId: event.identity?.runId || "media-run",
      title: label, blob: block.value.blob
    }) }) } })
  });
}

export function producedImageEvent(event: Event): Event {
  const message = event.payload?.kind;
  if (message?.case !== "messageCompleted") throw new Error("A completed message fixture is required.");
  const image = message.value.blocks.find((block) => block.content.case === "image")?.content;
  if (image?.case !== "image") throw new Error("An image fixture is required.");
  return create(EventSchema, { ...event,
    payload: create(EventPayloadSchema, { kind: { case: "imageProduced", value: create(ImageProducedEventSchema, {
      messageId: message.value.messageId, image: image.value
    }) } })
  });
}
