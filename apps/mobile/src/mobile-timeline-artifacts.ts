import { MessageRole, type BlobRef, type Event } from "@joko/contracts";
import { mobileMediaPreviewKind } from "./mobile-media-preview";
import { isMobilePdfPreviewMediaType } from "./mobile-pdf-preview";
import { MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES } from "./network";
import { normalizeMediaType } from "./workspace-files";

export interface MobileTimelinePreviewArtifact {
  readonly artifactId: string;
  readonly eventId: string;
  readonly messageId: string;
  readonly contentIndex: number;
  readonly title: string;
  readonly mediaType: string;
  readonly byteSize: bigint;
  readonly sourceKey: string;
  readonly previewKind: "media" | "pdf";
}

export interface MobileTimelinePreviewArtifactSource {
  readonly artifact: MobileTimelinePreviewArtifact;
  readonly blob: BlobRef;
  readonly event: Event;
}

export function mobileTimelinePreviewArtifacts(event: Event): readonly MobileTimelinePreviewArtifact[] {
  const payload = event.payload?.kind;
  const sessionId = event.identity?.sessionId ?? "";
  if (payload?.case !== "messageCompleted" || !event.eventId || !sessionId
    || !payload.value.messageId || !previewableRole(payload.value.role)) return [];
  return payload.value.blocks.flatMap((block, contentIndex) => {
    if (block.content.case !== "artifact" || !block.content.value.blob) return [];
    const blob = block.content.value.blob;
    const mediaType = normalizeMediaType(blob.mediaType);
    const previewKind = mobileMediaPreviewKind(mediaType) ? "media"
      : isMobilePdfPreviewMediaType(mediaType) ? "pdf" : undefined;
    if (!previewKind || !validBlobIdentity(blob)) return [];
    const title = boundedLabel(block.content.value.label) || boundedLabel(blob.fileName) || "Message file";
    return [{
      artifactId: JSON.stringify([event.eventId, payload.value.messageId, contentIndex, blob.blobId]),
      eventId: event.eventId,
      messageId: payload.value.messageId,
      contentIndex,
      title,
      mediaType,
      byteSize: blob.byteSize,
      sourceKey: JSON.stringify([
        blob.blobId, blob.fileName, mediaType, blob.byteSize.toString(10), blob.sha256Hex
      ]),
      previewKind
    }];
  });
}

export function resolveMobileTimelinePreviewArtifact(
  events: readonly Event[],
  selected: MobileTimelinePreviewArtifact
): MobileTimelinePreviewArtifactSource | undefined {
  const matchingEvents = events.filter((event) => event.eventId === selected.eventId);
  if (matchingEvents.length !== 1) return undefined;
  const event = matchingEvents[0]!;
  const payload = event.payload?.kind;
  if (payload?.case !== "messageCompleted" || payload.value.messageId !== selected.messageId) return undefined;
  const artifact = mobileTimelinePreviewArtifacts(event)
    .find((candidate) => candidate.contentIndex === selected.contentIndex);
  const block = payload.value.blocks[selected.contentIndex];
  if (!artifact || !sameMobileTimelinePreviewArtifact(artifact, selected)
    || block?.content.case !== "artifact" || !block.content.value.blob) return undefined;
  return { artifact, blob: block.content.value.blob, event };
}

export function mobileTimelinePreviewWindowKey(events: readonly Event[]): string {
  return JSON.stringify(events.map((event, eventIndex) => [
    eventIndex.toString(10),
    event.eventId,
    event.identity?.sessionId ?? "",
    event.cursor?.generation.toString(10) ?? "",
    event.cursor?.sequence.toString(10) ?? "",
    event.cursor?.opaqueToken ?? "",
    event.payload?.kind.case ?? "",
    mobileTimelinePreviewArtifacts(event).map((artifact) => [
      artifact.artifactId,
      artifact.sourceKey,
      artifact.mediaType,
      artifact.byteSize.toString(10),
      artifact.title
    ])
  ]));
}

export function sameMobileTimelinePreviewArtifact(
  left: MobileTimelinePreviewArtifact,
  right: MobileTimelinePreviewArtifact
): boolean {
  return left.artifactId === right.artifactId
    && left.eventId === right.eventId
    && left.messageId === right.messageId
    && left.contentIndex === right.contentIndex
    && left.title === right.title
    && left.mediaType === right.mediaType
    && left.byteSize === right.byteSize
    && left.sourceKey === right.sourceKey
    && left.previewKind === right.previewKind;
}

function validBlobIdentity(blob: BlobRef): boolean {
  return Boolean(blob.blobId && blob.fileName && /^[a-f0-9]{64}$/u.test(blob.sha256Hex)
    && blob.byteSize > 0n && blob.byteSize <= BigInt(MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES));
}

function previewableRole(role: MessageRole): boolean {
  return [MessageRole.USER, MessageRole.ASSISTANT, MessageRole.SYSTEM, MessageRole.TOOL].includes(role);
}

function boundedLabel(value: string): string {
  const label = value.trim();
  return label.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(label) ? label : "";
}
