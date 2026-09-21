import type { MobileImageAnnotationStroke } from "./mobile-image-annotation";

export type MobileComposerImageEditorRequest =
  | { readonly surface: "task"; readonly attachmentId: string }
  | { readonly surface: "new-task"; readonly targetId: string; readonly attachmentId: string };

export interface MobileComposerImageEditorSession {
  readonly leaseId: string;
  readonly previewUri: string;
  readonly sourceBase64: string;
  readonly sourceMediaType: string;
  readonly fileName: string;
  readonly initialStrokes: readonly MobileImageAnnotationStroke[];
  readonly annotatable: boolean;
  readonly maximumBytes: number;
}

export interface MobileBurnedImage {
  readonly bytes: Uint8Array;
  readonly mediaType: "image/jpeg" | "image/png";
  readonly width: number;
  readonly height: number;
}

export interface MobileComposerImageCommitResult {
  readonly surface: "task" | "new-task";
  readonly draft: import("./mobile-composer-document").MobileComposerDraft;
}

export function mobileAnnotatedImageFileName(fileName: string, mediaType: "image/jpeg" | "image/png"): string {
  const leaf = fileName.split(/[\\/]/u).at(-1)?.trim() || "image";
  const base = leaf.replace(/\.[^.]+$/u, "").trim().slice(0, 480) || "image";
  return `${base}-annotated.${mediaType === "image/jpeg" ? "jpg" : "png"}`;
}
