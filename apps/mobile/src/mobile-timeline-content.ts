import { MessageRole, ToolCallOutputMode, ToolCallState, type BlobRef, type Event, type ImageRef } from "@joko/contracts";
import { mobileToolCallScopeKey } from "./mobile-tool-call";

/** An exact public occurrence, never an execution or file-path grant. */
export type MobileTimelineContentSource =
  | { readonly kind: "timeline"; readonly eventId: string; readonly messageId: string;
      readonly contentKind: "block" | "inputPart"; readonly contentIndex: number }
  | { readonly kind: "tool"; readonly eventId: string; readonly scopeKey: string; readonly contentIndex: number; readonly artifactId?: string }
  | { readonly kind: "artifactProduced"; readonly eventId: string; readonly artifactId: string; readonly runId: string }
  | { readonly kind: "imageProduced"; readonly eventId: string; readonly messageId: string };

export interface MobileTimelineContent {
  readonly source: MobileTimelineContentSource;
  readonly kind: "image" | "artifact";
  readonly blob: BlobRef;
  readonly label: string;
  readonly image?: ImageRef;
}

export function mobileTimelineContent(event: Event): readonly MobileTimelineContent[] {
  const payload = event.payload?.kind;
  const sessionId = event.identity?.sessionId ?? "";
  if (!validIdentity(event.eventId) || !validIdentity(sessionId)) return [];
  const imageContent = (image: ImageRef, source: MobileTimelineContentSource): MobileTimelineContent[] =>
    image.blob ? [{ source, kind: "image", blob: image.blob, label: image.altText, image }] : [];
  if (payload?.case === "messageCompleted" && validIdentity(payload.value.messageId)
    && [MessageRole.USER, MessageRole.ASSISTANT, MessageRole.SYSTEM, MessageRole.TOOL].includes(payload.value.role)) {
    return payload.value.blocks.flatMap((block, contentIndex) => {
      const source: MobileTimelineContentSource = { kind: "timeline", eventId: event.eventId,
        messageId: payload.value.messageId, contentKind: "block", contentIndex };
      if (block.content.case === "image") return imageContent(block.content.value, source);
      if (block.content.case === "artifact" && block.content.value.blob) return [{
        source, kind: "artifact", blob: block.content.value.blob, label: block.content.value.label
      }];
      return [];
    });
  }
  if (payload?.case === "messageStarted" && validIdentity(payload.value.messageId)
    && payload.value.role === MessageRole.USER && payload.value.userInputAccepted) {
    return (payload.value.userInput?.parts ?? []).flatMap((part, contentIndex) =>
      part.content.case === "image" ? imageContent(part.content.value, { kind: "timeline", eventId: event.eventId,
        messageId: payload.value.messageId, contentKind: "inputPart", contentIndex }) : []);
  }
  if (payload?.case === "toolCallStarted" || payload?.case === "toolCallUpdated" || payload?.case === "toolCallCompleted") {
    const scopeKey = mobileToolCallScopeKey(event);
    if (!scopeKey) return [];
    const result = payload.case === "toolCallUpdated" ? payload.value.incrementalResult : payload.value.toolCall?.result;
    return (result?.parts ?? []).slice(0, 256).flatMap((part, contentIndex) => {
      const source: MobileTimelineContentSource = { kind: "tool", eventId: event.eventId, scopeKey, contentIndex };
      if (part.content.case === "image") return imageContent(part.content.value, source);
      if (part.content.case === "artifact" && part.content.value.blob) {
        const artifact = part.content.value;
        if (artifact.artifactId && !validIdentity(artifact.artifactId)) return [];
        return [{ source: { ...source, artifactId: artifact.artifactId }, kind: "artifact", blob: artifact.blob!, label: artifact.title }];
      }
      return [];
    });
  }
  if (payload?.case === "artifactProduced") {
    const artifact = payload.value.artifact;
    if (!artifact?.blob || !validIdentity(artifact.artifactId) || artifact.sessionId !== sessionId
      || (event.identity?.runId && artifact.runId !== event.identity.runId)) return [];
    return [{ source: { kind: "artifactProduced", eventId: event.eventId, artifactId: artifact.artifactId, runId: artifact.runId },
      kind: "artifact", blob: artifact.blob, label: artifact.title }];
  }
  if (payload?.case === "imageProduced" && validIdentity(payload.value.messageId) && payload.value.image) {
    return imageContent(payload.value.image, { kind: "imageProduced", eventId: event.eventId, messageId: payload.value.messageId });
  }
  return [];
}

export function mobileTimelineContentSourceKey(source: MobileTimelineContentSource): string {
  switch (source.kind) {
    case "timeline": return JSON.stringify([source.kind, source.eventId, source.messageId, source.contentKind, source.contentIndex]);
    case "tool": return JSON.stringify([source.kind, source.eventId, source.scopeKey, source.contentIndex, source.artifactId ?? ""]);
    case "artifactProduced": return JSON.stringify([source.kind, source.eventId, source.artifactId, source.runId]);
    case "imageProduced": return JSON.stringify([source.kind, source.eventId, source.messageId]);
  }
}

/** Only output occurrences retained by the current append/replace/terminal projection. */
export function mobileTimelineToolMediaEvents(events: readonly Event[]): ReadonlyMap<string, readonly Event[]> {
  const calls = new Map<string, { events: Event[]; terminal: boolean }>();
  const ordered = [...new Map(events.map((event) => [event.eventId, event])).values()]
    .sort((a, b) => (a.cursor?.sequence ?? 0n) < (b.cursor?.sequence ?? 0n) ? -1
      : (a.cursor?.sequence ?? 0n) > (b.cursor?.sequence ?? 0n) ? 1 : 0);
  for (const event of ordered) {
    const scopeKey = mobileToolCallScopeKey(event);
    const payload = event.payload?.kind;
    if (!scopeKey || (payload?.case !== "toolCallStarted" && payload?.case !== "toolCallUpdated"
      && payload?.case !== "toolCallCompleted")) continue;
    const previous = calls.get(scopeKey);
    if (previous?.terminal) continue;
    const call = payload.value.toolCall!;
    const result = payload.case === "toolCallUpdated" ? payload.value.incrementalResult : call.result;
    const append = payload.case === "toolCallUpdated" && payload.value.outputMode === ToolCallOutputMode.APPEND;
    calls.set(scopeKey, {
      events: result === undefined ? previous?.events ?? [] : append ? [...(previous?.events ?? []), event] : [event],
      terminal: [ToolCallState.SUCCEEDED, ToolCallState.FAILED, ToolCallState.ABORTED].includes(call.state)
    });
  }
  return new Map([...calls].map(([key, value]) => [key, value.events]));
}

function validIdentity(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
}
