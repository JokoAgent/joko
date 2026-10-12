import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { PartnerGroupAttachmentCategory, type PartnerGroupApi, type PartnerGroupAttachment, type PartnerGroupMessage, type PartnerGroupSummary, type BlobRef, type ImageThumbnail } from "@joko/contracts";
import { MobileFilesThumbnailReader } from "./mobile-files-thumbnails";
import { inspectMobileImageGalleryBytes, mobileImageGalleryDimensionsMatch, mobileImageGalleryNativeAnimationMatches, mobileImageGalleryPreviewUri, type MobileImageGalleryNativeDecode } from "./mobile-image-gallery";
import { encodeMobileBase64 } from "./mobile-image-annotation";
import { inspectMobileImageOutputBytes } from "./mobile-image-output-format";
import type { MobileComposerImageEditorSession } from "./mobile-composer-image-editor";
import type { MobileImageOutputSource } from "./mobile-image-output";
import { MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES, type AuthorizedBlobDownload } from "./network";
import type { MobileFileShare } from "./mobile-file-share";

/** Group media uses the original authenticated Blob and native image owners. */
export function createMobileGroupMedia(input: {
  ownerKey: string; api: PartnerGroupApi; newId(): string; current(signal: AbortSignal): void;
  thumbnail(blob: BlobRef, signal: AbortSignal): Promise<ImageThumbnail | undefined>;
  download(blob: BlobRef, signal: AbortSignal): Promise<{ bytes: Uint8Array; mediaType: string }>;
  authorize(blob: BlobRef, signal: AbortSignal): Promise<AuthorizedBlobDownload>;
  fileShare?: Pick<MobileFileShare, "perform">;
}) {
  const thumbnails = new MobileFilesThumbnailReader();
  type Source = { group: PartnerGroupSummary; message: PartnerGroupMessage; attachment: PartnerGroupAttachment };
  type Lease = Source & { id: string; bytes: Uint8Array; session: MobileComposerImageEditorSession; confirmed: boolean };
  const images = new Map<string, Lease>();
  const revalidate = async (source: Source, signal: AbortSignal) => {
    input.current(signal); const response = await input.api.get(source.group.id, source.message.sequence + 1n, signal); input.current(signal);
    const message = response.detail?.messages.find(item => item.id === source.message.id && item.sequence === source.message.sequence);
    const selected = message?.attachments.find(item => item.id === source.attachment.id), blob = source.attachment.blob;
    if (!blob || !selected?.blob || selected.category !== PartnerGroupAttachmentCategory.IMAGE || selected.name !== source.attachment.name
      || selected.blob.blobId !== blob.blobId || selected.blob.sha256Hex !== blob.sha256Hex || selected.blob.byteSize !== blob.byteSize
      || selected.blob.mediaType !== blob.mediaType || selected.blob.fileName !== blob.fileName) throw new Error("The group image source changed.");
    return blob;
  };
  const lease = (id: string, signal: AbortSignal) => { input.current(signal); const owned = images.get(id); if (!owned) throw new Error("The group image was closed."); return owned; };
  return {
    prepareMediaThumbnail: async (group: PartnerGroupSummary, message: PartnerGroupMessage, attachment: PartnerGroupAttachment, signal: AbortSignal) => {
      const source = { group, message, attachment }, blob = attachment.blob;
      if (!blob || attachment.category !== PartnerGroupAttachmentCategory.IMAGE) throw new Error("Select a current group image.");
      return thumbnails.prepare({ ownerKey: input.ownerKey, sourceKey: JSON.stringify([group.id, message.id, attachment.id, blob.blobId, blob.sha256Hex]),
        assertCurrent: currentSignal => input.current(currentSignal ?? signal), revalidate: currentSignal => revalidate(source, currentSignal).then(() => undefined),
        read: async currentSignal => { const thumbnail = await input.thumbnail(blob, currentSignal); input.current(currentSignal);
          if (thumbnail) return { kind: "image", blob, bytes: thumbnail.data, mediaType: thumbnail.mediaType, thumbnail };
          if (blob.byteSize > BigInt(MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES)) return undefined;
          const download = await input.download(blob, currentSignal); input.current(currentSignal); return { kind: "image", blob, ...download }; }
      }, signal);
    },
    confirmMediaThumbnail: (id: string, decoded: MobileImageGalleryNativeDecode) => thumbnails.confirm(id, decoded),
    releaseMediaThumbnail: (id: string, discard = false) => thumbnails.release(id, discard),
    prepareMediaImage: async (group: PartnerGroupSummary, message: PartnerGroupMessage, attachment: PartnerGroupAttachment, signal: AbortSignal): Promise<MobileComposerImageEditorSession> => {
      const source = { group, message, attachment }, blob = await revalidate(source, signal);
      if (blob.byteSize < 1n || blob.byteSize > BigInt(MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES)) throw new Error("The group image exceeds the viewer limit.");
      const download = await input.download(blob, signal); input.current(signal);
      if (BigInt(download.bytes.length) !== blob.byteSize || download.mediaType !== blob.mediaType || bytesToHex(sha256(download.bytes)) !== blob.sha256Hex) throw new Error("The group image bytes changed.");
      const decoded = inspectMobileImageGalleryBytes(download.bytes, blob.mediaType), id = input.newId();
      const session: MobileComposerImageEditorSession = { leaseId: id, previewUri: mobileImageGalleryPreviewUri(download.bytes, decoded), sourceBase64: encodeMobileBase64(download.bytes),
        sourceMediaType: blob.mediaType, fileName: attachment.name, initialStrokes: [], annotatable: false, expectedWidthPixels: decoded.width, expectedHeightPixels: decoded.height,
        ...(decoded.nativeQuarterTurn ? { nativeQuarterTurn: true } : {}), animated: decoded.animated === true, originalOnly: decoded.originalOnly === true,
        ...(decoded.previewMediaType ? { previewMediaType: decoded.previewMediaType } : {}), maximumBytes: MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES };
      images.set(id, { ...source, id, bytes: download.bytes, session, confirmed: false }); return session;
    },
    confirmMediaImage: (id: string, decoded: MobileImageGalleryNativeDecode) => {
      const owned = lease(id, new AbortController().signal), session = owned.session;
      if (!mobileImageGalleryDimensionsMatch({ width: session.expectedWidthPixels!, height: session.expectedHeightPixels!, nativeQuarterTurn: session.nativeQuarterTurn }, decoded.width, decoded.height)
        || !mobileImageGalleryNativeAnimationMatches(session.sourceMediaType, session.animated === true, decoded.isAnimated)) throw new Error("The decoded group image changed.");
      owned.confirmed = true;
    },
    closeMediaImage: (id: string) => { images.delete(id); },
    prepareMediaOutput: async (id: string, decoded: MobileImageGalleryNativeDecode, signal: AbortSignal): Promise<{ source: MobileImageOutputSource; assertCurrent(): Promise<void> }> => {
      const owned = lease(id, signal); if (!owned.confirmed) throw new Error("Confirm the decoded group image before output.");
      await revalidate(owned, signal); const parsed = inspectMobileImageOutputBytes(owned.bytes, owned.session.sourceMediaType, decoded);
      const assertCurrent = async () => { if (lease(id, signal) !== owned) throw new Error("The group image output owner changed."); await revalidate(owned, signal); };
      return { source: { leaseId: id, fileName: owned.attachment.name, mediaType: parsed.mediaType, byteSize: owned.bytes.length,
        sha256Hex: owned.attachment.blob!.sha256Hex, bytes: owned.bytes, width: parsed.width, height: parsed.height }, assertCurrent };
    },
    shareMediaOriginal: async (id: string, signal: AbortSignal, onDispatch: () => void) => {
      const owned = lease(id, signal); if (!owned.confirmed || !input.fileShare) throw new Error("The group image sharing owner is unavailable.");
      const assertCurrent = async () => { if (lease(id, signal) !== owned) throw new Error("The group image sharing owner changed."); await revalidate(owned, signal); };
      const blob = await revalidate(owned, signal), source = await input.authorize(blob, signal); input.current(signal);
      if (source.blobId !== blob.blobId || BigInt(source.byteSize) !== blob.byteSize || source.sha256Hex !== blob.sha256Hex || source.mediaType !== blob.mediaType) throw new Error("The authorized group image changed.");
      await input.fileShare.perform({ source, signal, assertCurrent, onDispatch });
    }
  };
}
