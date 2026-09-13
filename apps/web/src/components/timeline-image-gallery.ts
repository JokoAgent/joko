import type { TimelineItemView } from "../model.js";

export interface TimelineGalleryImage {
  readonly id: string;
  readonly blobId: string;
  readonly title: string;
  readonly fileName: string;
  readonly byteSize: number;
}

export type ImageLightboxKeyboardAction =
  | "close"
  | "previous"
  | "next"
  | "zoomIn"
  | "zoomOut"
  | "fit"
  | "actualSize";

export interface ImageLightboxKeyboardInput {
  readonly key: string;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly isComposing?: boolean;
}

/**
 * Builds the complete session gallery from the durable source window rather
 * than the virtualized DOM. Duplicate blobs are deliberately preserved: each
 * occurrence has its own stable source identity and place in the conversation.
 */
export function collectTimelineGalleryImages(items: readonly TimelineItemView[]): readonly TimelineGalleryImage[] {
  const images: TimelineGalleryImage[] = [];
  for (const item of items) {
    if (item.kind === "image" && item.artifact !== undefined) {
      images.push({
        id: timelineArtifactGalleryId(item.id, item.artifact.id),
        blobId: item.artifact.blobId,
        title: item.artifact.title,
        fileName: item.artifact.fileName,
        byteSize: item.artifact.byteSize
      });
    }
    item.attachments?.forEach((attachment, index) => {
      if (attachment.kind !== "image") return;
      images.push({
        id: timelineMessageAttachmentGalleryId(item.id, attachment.id, index),
        blobId: attachment.blobId,
        title: attachment.title,
        fileName: attachment.fileName,
        byteSize: attachment.byteSize
      });
    });
  }
  return images;
}

export function timelineArtifactGalleryId(itemId: string, artifactId: string): string {
  return `artifact:${itemId}:${artifactId}`;
}

export function timelineMessageAttachmentGalleryId(itemId: string, artifactId: string, index: number): string {
  return `attachment:${itemId}:${artifactId}:${index}`;
}

export function moveTimelineGalleryIndex(index: number, count: number, direction: -1 | 1): number {
  if (count <= 0) return 0;
  return (index + direction + count) % count;
}

export function resolveImageLightboxKey(input: ImageLightboxKeyboardInput): ImageLightboxKeyboardAction | undefined {
  if (input.isComposing === true || input.altKey === true || input.ctrlKey === true || input.metaKey === true) return undefined;
  switch (input.key) {
    case "Escape": return "close";
    case "ArrowLeft": return "previous";
    case "ArrowRight": return "next";
    case "+":
    case "=": return "zoomIn";
    case "-":
    case "_": return "zoomOut";
    case "0": return "fit";
    case "1": return "actualSize";
    default: return undefined;
  }
}
