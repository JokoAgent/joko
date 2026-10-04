import { type BlobRef, type Event } from "@joko/contracts";
import { mobileTimelineContent, mobileTimelineContentSourceKey, mobileTimelineToolMediaEvents,
  type MobileTimelineContentSource } from "./mobile-timeline-content";
import { mobileMediaPreviewKind } from "./mobile-media-preview";
import { mobileModelPreviewKind } from "./mobile-model-preview";
import { isMobilePdfPreviewMediaType } from "./mobile-pdf-preview";
import { MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES, MOBILE_FILE_SHARE_MAXIMUM_BYTES } from "./network";
import { normalizeMediaType } from "./workspace-files";

export interface MobileTimelineArtifact {
  readonly artifactId: string;
  readonly eventId: string;
  readonly source: MobileTimelineContentSource;
  readonly title: string;
  readonly mediaType: string;
  readonly byteSize: bigint;
  readonly sourceKey: string;
  readonly previewKind?: "media" | "pdf" | "model";
}

export interface MobileTimelinePreviewArtifact extends MobileTimelineArtifact {
  readonly previewKind: "media" | "pdf" | "model";
}

export interface MobileTimelineArtifactSource<TArtifact extends MobileTimelineArtifact = MobileTimelineArtifact> {
  readonly artifact: TArtifact;
  readonly blob: BlobRef;
  readonly event: Event;
}

export function mobileTimelineArtifacts(event: Event): readonly MobileTimelineArtifact[] {
  return mobileTimelineContent(event).flatMap((content) => {
    const blob = content.blob;
    const mediaType = normalizeMediaType(blob.mediaType);
    const previewKind = mobileMediaPreviewKind(mediaType) ? "media"
      : isMobilePdfPreviewMediaType(mediaType) ? "pdf"
        : mobileModelPreviewKind(mediaType, blob.fileName) ? "model" : undefined;
    if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mediaType)
      || !validBlobIdentity(blob, MOBILE_FILE_SHARE_MAXIMUM_BYTES)) return [];
    const title = boundedLabel(content.label) || boundedLabel(blob.fileName) || "Task file";
    return [{
      artifactId: JSON.stringify([mobileTimelineContentSourceKey(content.source), blob.blobId]),
      eventId: event.eventId,
      source: content.source,
      title,
      mediaType,
      byteSize: blob.byteSize,
      sourceKey: JSON.stringify([
        blob.blobId, blob.fileName, mediaType, blob.byteSize.toString(10), blob.sha256Hex
      ]),
      ...(previewKind && blob.byteSize <= BigInt(MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES) ? { previewKind } : {})
    }];
  });
}

export function mobileTimelinePreviewArtifacts(event: Event): readonly MobileTimelinePreviewArtifact[] {
  return mobileTimelineArtifacts(event).filter(isMobileTimelinePreviewArtifact);
}

export function isMobileTimelinePreviewArtifact(
  artifact: MobileTimelineArtifact
): artifact is MobileTimelinePreviewArtifact {
  return artifact.previewKind !== undefined;
}

export function resolveMobileTimelineArtifact(
  events: readonly Event[],
  selected: MobileTimelineArtifact
): MobileTimelineArtifactSource | undefined {
  const matchingEvents = events.filter((event) => event.eventId === selected.eventId);
  if (matchingEvents.length !== 1) return undefined;
  const event = matchingEvents[0]!;
  if (selected.source.kind === "tool" && !mobileTimelineToolMediaEvents(events).get(selected.source.scopeKey)
    ?.some((sourceEvent) => sourceEvent.eventId === event.eventId)) return undefined;
  const sourceKey = mobileTimelineContentSourceKey(selected.source);
  const artifact = mobileTimelineArtifacts(event)
    .find((candidate) => mobileTimelineContentSourceKey(candidate.source) === sourceKey);
  const content = mobileTimelineContent(event).find((candidate) => mobileTimelineContentSourceKey(candidate.source) === sourceKey);
  if (!artifact || !sameMobileTimelineArtifact(artifact, selected) || !content) return undefined;
  return { artifact, blob: content.blob, event };
}

export function resolveMobileTimelinePreviewArtifact(
  events: readonly Event[],
  selected: MobileTimelinePreviewArtifact
): MobileTimelineArtifactSource<MobileTimelinePreviewArtifact> | undefined {
  const source = resolveMobileTimelineArtifact(events, selected);
  if (!source || source.artifact.previewKind === undefined) return undefined;
  return { ...source, artifact: source.artifact as MobileTimelinePreviewArtifact };
}

export function mobileTimelineArtifactWindowKey(events: readonly Event[]): string {
  return timelineWindowKey(events, mobileTimelineArtifacts);
}

export function mobileTimelinePreviewWindowKey(events: readonly Event[]): string {
  return timelineWindowKey(events, mobileTimelinePreviewArtifacts);
}

function timelineWindowKey(
  events: readonly Event[],
  project: (event: Event) => readonly MobileTimelineArtifact[]
): string {
  return JSON.stringify(events.map((event, eventIndex) => [
    eventIndex.toString(10),
    event.eventId,
    event.identity?.sessionId ?? "",
    event.cursor?.generation.toString(10) ?? "",
    event.cursor?.sequence.toString(10) ?? "",
    event.cursor?.opaqueToken ?? "",
    event.payload?.kind.case ?? "",
    project(event).map((artifact) => [
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
  return sameMobileTimelineArtifact(left, right)
    && left.previewKind === right.previewKind;
}

export function sameMobileTimelineArtifact(
  left: MobileTimelineArtifact,
  right: MobileTimelineArtifact
): boolean {
  return left.artifactId === right.artifactId
    && left.eventId === right.eventId
    && mobileTimelineContentSourceKey(left.source) === mobileTimelineContentSourceKey(right.source)
    && left.title === right.title
    && left.mediaType === right.mediaType
    && left.byteSize === right.byteSize
    && left.sourceKey === right.sourceKey
    && left.previewKind === right.previewKind;
}

function validBlobIdentity(blob: BlobRef, maximumBytes: number): boolean {
  const fileName = boundedLabel(blob.fileName);
  return Boolean(blob.blobId && fileName && !fileName.includes("/") && !fileName.includes("\\")
    && /^[a-f0-9]{64}$/u.test(blob.sha256Hex)
    && blob.byteSize >= 0n && blob.byteSize <= BigInt(maximumBytes));
}

function boundedLabel(value: string): string {
  const label = value.trim();
  return label.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(label) ? label : "";
}
