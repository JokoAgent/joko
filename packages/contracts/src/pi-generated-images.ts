import type { BlobRef } from "./gen/joko/v1/common_pb.js";
import type { Event } from "./gen/joko/v1/event_pb.js";
import { ToolCallState } from "./gen/joko/v1/tool_pb.js";

/** Identify final hosted generation media from the ordinary Pi tool receipt. */
export function readPiGeneratedImages(event: Event): readonly BlobRef[] {
  const payload = event.payload?.kind;
  const call = payload?.case === "toolCallCompleted" ? payload.value.toolCall : undefined;
  const owner = event.identity;
  // The cursor belongs to the Orchestrator runtime. The identity belongs to the native session binding.
  if (owner?.backendId !== "pi" || !owner.sessionId || !owner.runId || !owner.attemptId || owner.generation <= 0n
    || event.cursor === undefined || event.cursor.generation <= 0n || !call?.toolCallId || call.toolId !== "image_generate"
    || call.sessionId !== owner.sessionId || call.runId !== owner.runId || call.attemptId !== owner.attemptId
    || call.state !== ToolCallState.SUCCEEDED || !call.result || call.result.truncated) return [];

  return call.result.parts.flatMap(part => {
    const blob = part.content.case === "image" ? part.content.value.blob : undefined;
    return blob && blob.blobId && blob.byteSize > 0n && /^[a-f0-9]{64}$/u.test(blob.sha256Hex)
      && ["image/png", "image/jpeg", "image/webp"].includes(blob.mediaType) ? [blob] : [];
  });
}
