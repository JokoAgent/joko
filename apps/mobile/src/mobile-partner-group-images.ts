import type { PartnerGroupSummary } from "@joko/contracts";
import type { MobileAttachmentFiles } from "./mobile-attachment-files";
import type { MobileAttachmentPolicy, MobileLocalComposerAttachment } from "./mobile-attachments";
import { assertMobileAttachmentCandidate, normalizeMobileComposerAttachment } from "./mobile-attachments";
import { mobileAnnotatedImageFileName, mobileRasterizedImageFileName, type MobileBurnedImage, type MobileComposerImageEditorSession } from "./mobile-composer-image-editor";
import { MOBILE_ANNOTATION_MAX_BURN_DIMENSION, canAnnotateMobileImage, encodeMobileBase64, mobileAnnotationOutputMediaType, mobileImageRequiresNativeRaster, normalizeMobileAnnotationStrokes, sniffMobileImageMediaType, type MobileImageAnnotationStroke } from "./mobile-image-annotation";
import { inspectMobileImageGalleryBytes, mobileImageGalleryMediaType, mobileImageGalleryPreviewUri } from "./mobile-image-gallery";

/** The same owned image bytes and burn-in rules used by the task composer. */
export function createMobileGroupImageTools(input: { files: MobileAttachmentFiles; profileId: string; newId(): string; current(signal: AbortSignal): void;
  policy(group: PartnerGroupSummary, signal: AbortSignal): Promise<MobileAttachmentPolicy> }) {
  type Lease = { id: string; groupId: string; attachment: MobileLocalComposerAttachment; bytes: Uint8Array; source: NonNullable<MobileLocalComposerAttachment["annotation"]>["source"]; stored: boolean; session: MobileComposerImageEditorSession };
  let lease: Lease | undefined;
  return {
    cancelImage: (id: string) => { if (lease?.id === id) lease = undefined; },
    prepareImage: async (group: PartnerGroupSummary, attachment: MobileLocalComposerAttachment, signal: AbortSignal): Promise<MobileComposerImageEditorSession> => {
      input.current(signal); const exact = normalizeMobileComposerAttachment(attachment); if (exact.state !== "local" || exact.kind !== "image") throw new Error("The group image is not an owned local attachment.");
      const policy = await input.policy(group, signal), source = exact.annotation?.source ?? { storageId: exact.attachmentId, fileName: exact.fileName, mediaType: exact.mediaType, byteSize: exact.byteSize, sha256Hex: exact.sha256Hex, capturedAtUnixMs: exact.capturedAtUnixMs };
      const owned = await input.files.readOwnedBytes(input.profileId, source.storageId, source.byteSize, source.sha256Hex, signal); input.current(signal);
      const image = mobileImageGalleryMediaType(source.mediaType) ? inspectMobileImageGalleryBytes(owned.bytes, source.mediaType) : undefined;
      let annotatable = !image?.animated && !image?.originalOnly && canAnnotateMobileImage(source.mediaType);
      if (annotatable) try { assertMobileAttachmentCandidate({ fileName: mobileAnnotatedImageFileName(source.fileName, mobileAnnotationOutputMediaType(source.mediaType)), mediaType: mobileAnnotationOutputMediaType(source.mediaType), byteSize: 1 }, policy); } catch { annotatable = false; }
      const id = input.newId(), session: MobileComposerImageEditorSession = { leaseId: id, previewUri: image ? mobileImageGalleryPreviewUri(owned.bytes, image) : owned.uri,
        sourceBase64: encodeMobileBase64(owned.bytes), sourceMediaType: source.mediaType, fileName: source.fileName, initialStrokes: exact.annotation?.strokes ?? [], annotatable,
        ...(image ? { expectedWidthPixels: image.width, expectedHeightPixels: image.height } : {}), ...(image?.nativeQuarterTurn ? { nativeQuarterTurn: true } : {}),
        animated: image?.animated === true, originalOnly: image?.originalOnly === true, ...(image?.previewMediaType ? { previewMediaType: image.previewMediaType } : {}), maximumBytes: policy.maximumBytes };
      lease = { id, groupId: group.id, attachment: exact, bytes: owned.bytes, source: exact.annotation ? source : { ...source, storageId: input.newId() }, stored: !!exact.annotation, session }; return session;
    },
    commitImage: async (group: PartnerGroupSummary, id: string, attachment: MobileLocalComposerAttachment, strokes: readonly MobileImageAnnotationStroke[], burned: MobileBurnedImage | undefined, signal: AbortSignal): Promise<MobileLocalComposerAttachment> => {
      input.current(signal); const owned = lease;
      if (!owned || owned.id !== id || owned.groupId !== group.id || owned.attachment.attachmentId !== attachment.attachmentId || owned.attachment.sha256Hex !== attachment.sha256Hex) throw new Error("The group image editor owner changed.");
      const exactStrokes = normalizeMobileAnnotationStrokes(strokes), policy = await input.policy(group, signal); input.current(signal);
      if (!exactStrokes.length && !attachment.annotation) { lease = undefined; return attachment; }
      if (exactStrokes.length && !owned.session.annotatable) throw new Error("This image cannot be rendered with annotations.");
      let bytes = owned.bytes, mediaType = owned.source.mediaType, fileName = owned.source.fileName;
      if (exactStrokes.length || mobileImageRequiresNativeRaster(mediaType)) {
        const expected = mobileAnnotationOutputMediaType(mediaType);
        if (!owned.session.annotatable || !burned || burned.mediaType !== expected || sniffMobileImageMediaType(burned.bytes) !== expected
          || !Number.isSafeInteger(burned.width) || burned.width < 1 || burned.width > MOBILE_ANNOTATION_MAX_BURN_DIMENSION
          || !Number.isSafeInteger(burned.height) || burned.height < 1 || burned.height > MOBILE_ANNOTATION_MAX_BURN_DIMENSION) throw new Error("The rendered annotation output is invalid.");
        bytes = burned.bytes; mediaType = burned.mediaType; fileName = exactStrokes.length ? mobileAnnotatedImageFileName(fileName, burned.mediaType) : mobileRasterizedImageFileName(fileName, burned.mediaType);
      }
      const sha256Hex = await input.files.digestOwnedBytes(bytes, signal); let sourceStaged = false, output: MobileLocalComposerAttachment | undefined;
      try {
        if (exactStrokes.length && !owned.stored) { await input.files.stageOwnedBytes(input.profileId, owned.source.storageId, owned.bytes, owned.source.sha256Hex, signal); sourceStaged = true; }
        output = await input.files.stageVerifiedBytes(input.profileId, [], policy, { bytes, fileName, mediaType, byteSize: bytes.byteLength, sha256Hex }, input.newId, signal); input.current(signal);
        if (lease !== owned) throw new Error("The group image editor owner changed.");
        lease = undefined; return exactStrokes.length ? { ...output, annotation: { source: owned.source, strokes: exactStrokes } } : output;
      } catch (error) { if (output) await input.files.removeVisibleBytes(input.profileId, output).catch(() => undefined); if (sourceStaged) await input.files.removeOwnedBytes(input.profileId, owned.source.storageId).catch(() => undefined); throw error; }
    }
  };
}
