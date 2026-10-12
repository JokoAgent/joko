import type { PartnerGroupAttachment, PartnerGroupSummary } from "@joko/contracts";
import type { MobileComposerAttachment, MobileLocalComposerAttachment } from "./mobile-attachments";
import type { MobilePhotoLibrary, MobilePhotoLibraryAsset } from "./mobile-photo-library";
import type { MobileBurnedImage, MobileComposerImageEditorSession } from "./mobile-composer-image-editor";
import type { MobileImageAnnotationStroke } from "./mobile-image-annotation";
import type { MobileComposerPastedImagePayload } from "./mobile-composer-image-paste";
import type { createMobileGroupMedia } from "./mobile-partner-group-media";
export interface MobileGroupAttachmentTransport extends ReturnType<typeof createMobileGroupMedia> {
  readonly ownerKey: string;
  readonly profileId: string;
  readonly photoLibrary: MobilePhotoLibrary;
  pick(group: PartnerGroupSummary, current: readonly MobileComposerAttachment[], signal: AbortSignal, source?: "files" | "photos" | "camera", assets?: readonly MobilePhotoLibraryAsset[]): Promise<readonly MobileLocalComposerAttachment[]>;
  paste(group: PartnerGroupSummary, current: readonly MobileComposerAttachment[], images: readonly MobileComposerPastedImagePayload[], signal: AbortSignal): Promise<readonly MobileLocalComposerAttachment[]>;
  upload(attachment: MobileLocalComposerAttachment, signal: AbortSignal): Promise<PartnerGroupAttachment>;
  prepareImage(group: PartnerGroupSummary, attachment: MobileLocalComposerAttachment, signal: AbortSignal): Promise<MobileComposerImageEditorSession>;
  commitImage(group: PartnerGroupSummary, id: string, attachment: MobileLocalComposerAttachment, strokes: readonly MobileImageAnnotationStroke[], burned: MobileBurnedImage | undefined, signal: AbortSignal): Promise<MobileLocalComposerAttachment>;
  cancelImage(id: string): void;
  removeReplacedImage(original: MobileLocalComposerAttachment, replacement: MobileLocalComposerAttachment): Promise<void>;
  remove(attachment: MobileComposerAttachment): Promise<void>;
}
