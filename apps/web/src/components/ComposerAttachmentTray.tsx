import { File, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";

import type { ArtifactView, AttachmentDraft } from "../model.js";
import { ComposerImageHoverPreview } from "./ComposerImageHoverPreview.js";
import { TimelineTextAttachmentLightbox } from "./TimelineTextAttachmentLightbox.js";
import { timelineArtifactSupportsTextPreview } from "./timeline-text-attachment.js";
import type { Translator } from "./types.js";
import { IconButton, cx, formatBytes } from "./ui.js";
import { WorkspaceImageLightbox } from "./WorkspaceImageLightbox.js";

type AttachmentPreviewKind = "image" | "text";

export function ComposerAttachmentTray({ attachments, removeDisabled = false, t, onRemove }: {
  readonly attachments: readonly AttachmentDraft[];
  readonly removeDisabled?: boolean;
  readonly t: Translator;
  readonly onRemove: (attachment: AttachmentDraft) => void;
}): JSX.Element {
  return <div className="attachment-list" aria-label={t("composer.attachments")}>
    {attachments.map((attachment) => <ComposerAttachmentItem
      key={attachment.id}
      attachment={attachment}
      removeDisabled={removeDisabled}
      t={t}
      onRemove={onRemove}
    />)}
  </div>;
}

function ComposerAttachmentItem({ attachment, removeDisabled, t, onRemove }: {
  readonly attachment: AttachmentDraft;
  readonly removeDisabled: boolean;
  readonly t: Translator;
  readonly onRemove: (attachment: AttachmentDraft) => void;
}): JSX.Element {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const textObjectUrlRef = useRef<string | undefined>(undefined);
  const suppressRestoredFocusPreviewRef = useRef(false);
  const [hovered, setHovered] = useState(false);
  const [imageOpen, setImageOpen] = useState(false);
  const [textPreviewTrigger, setTextPreviewTrigger] = useState<HTMLButtonElement>();
  const previewKind = composerAttachmentPreviewKind(attachment);
  const openLabel = previewKind === "image"
    ? t("timeline.openImage", { name: attachment.file.name })
    : `${t("workspace.preview")}: ${attachment.file.name}`;

  useEffect(() => () => {
    const url = textObjectUrlRef.current;
    textObjectUrlRef.current = undefined;
    if (url !== undefined) URL.revokeObjectURL(url);
  }, [attachment.file]);

  const textArtifact = useMemo<ArtifactView>(() => ({
    id: attachment.id,
    blobId: attachment.id,
    title: attachment.file.name,
    kind: "file",
    fileName: attachment.file.name,
    mediaType: attachment.file.type || "application/octet-stream",
    byteSize: attachment.file.size
  }), [attachment.file, attachment.id]);

  const loadTextUrl = useCallback(async (): Promise<string> => {
    textObjectUrlRef.current ??= URL.createObjectURL(attachment.file);
    return textObjectUrlRef.current;
  }, [attachment.file]);

  const download = useCallback((): void => {
    const url = attachment.previewUrl ?? textObjectUrlRef.current ?? URL.createObjectURL(attachment.file);
    if (attachment.previewUrl === undefined && textObjectUrlRef.current === undefined) textObjectUrlRef.current = url;
    const anchor = (triggerRef.current?.ownerDocument ?? document).createElement("a");
    anchor.href = url;
    anchor.download = attachment.file.name || "attachment";
    anchor.rel = "noopener";
    anchor.click();
  }, [attachment]);

  const contents = <>
    {attachment.previewUrl !== undefined
      ? <img src={attachment.previewUrl} alt="" draggable={false} />
      : <File aria-hidden="true" />}
    <span><strong>{attachment.file.name}</strong><small>{formatBytes(attachment.file.size)}</small></span>
  </>;

  return <div className={cx("attachment-chip", previewKind === undefined ? "is-static" : "is-interactive")}>
    {previewKind === undefined
      ? <div className="attachment-chip__content" title={t("workspace.filePreviewUnavailable")}>{contents}</div>
      : <button
        ref={triggerRef}
        className="attachment-chip__content"
        type="button"
        aria-label={openLabel}
        title={openLabel}
        onPointerEnter={() => {
          suppressRestoredFocusPreviewRef.current = false;
          if (previewKind === "image" && !imageOpen) setHovered(true);
        }}
        onPointerLeave={() => setHovered(false)}
        onFocus={() => {
          if (suppressRestoredFocusPreviewRef.current) {
            suppressRestoredFocusPreviewRef.current = false;
            return;
          }
          if (previewKind === "image" && !imageOpen) setHovered(true);
        }}
        onBlur={() => setHovered(false)}
        onClick={(event) => {
          setHovered(false);
          if (previewKind === "image") {
            suppressRestoredFocusPreviewRef.current = true;
            setImageOpen(true);
          }
          else setTextPreviewTrigger(event.currentTarget);
        }}
      >{contents}</button>}
    <IconButton
      label={`${t("composer.removeAttachment")}: ${attachment.file.name}`}
      disabled={removeDisabled}
      disabledReason={removeDisabled ? t("common.working") : undefined}
      onClick={() => onRemove(attachment)}
    ><X aria-hidden="true" /></IconButton>

    {previewKind === "image" && attachment.previewUrl !== undefined && <ComposerImageHoverPreview
      open={hovered && !imageOpen}
      anchorRef={triggerRef}
      src={attachment.previewUrl}
    />}
    {imageOpen && attachment.previewUrl !== undefined && <WorkspaceImageLightbox
      src={attachment.previewUrl}
      name={attachment.file.name}
      mediaType={attachment.file.type}
      labels={{
        close: t("common.close"),
        copy: t("workspace.imageCopy"),
        copied: t("workspace.imageCopied"),
        copyFailed: t("workspace.imageCopyFailed"),
        saveAs: t("workspace.imageSaveAs"),
        saveFailed: t("workspace.imageSaveFailed"),
        annotate: t("workspace.imageAnnotate"),
        discardAnnotation: t("workspace.imageDiscardAnnotation"),
        undoAnnotation: t("workspace.imageUndoAnnotation"),
        sendToChat: t("workspace.imageSendToChat"),
        sendFailed: t("workspace.imageSendFailed"),
        zoomIn: t("timeline.zoomIn"),
        zoomOut: t("timeline.zoomOut"),
        fitImage: t("timeline.fitImage"),
        actualSize: t("timeline.actualSize"),
        loading: t("common.loading"),
        unavailable: t("workspace.imageUnavailable")
      }}
      showZoomControls
      returnFocus={triggerRef.current}
      onClose={() => setImageOpen(false)}
      onDownload={download}
    />}
    {textPreviewTrigger !== undefined && <TimelineTextAttachmentLightbox
      artifact={textArtifact}
      labels={{
        preview: t("workspace.preview"),
        loading: t("workspace.loadingPreview"),
        unavailable: t("workspace.filePreviewUnavailable"),
        tooLarge: t("workspace.previewTruncated"),
        copy: t("timeline.copy"),
        copied: t("timeline.blockCopied"),
        copyFailed: t("timeline.blockCopyFailed"),
        download: t("workspace.downloadFile"),
        close: t("common.close")
      }}
      returnFocus={textPreviewTrigger}
      loadUrl={loadTextUrl}
      onDownload={download}
      onClose={() => setTextPreviewTrigger(undefined)}
    />}
  </div>;
}

export function composerAttachmentPreviewKind(attachment: Pick<AttachmentDraft, "file" | "kind" | "previewUrl">): AttachmentPreviewKind | undefined {
  if (attachment.kind === "image") return attachment.previewUrl === undefined ? undefined : "image";
  return timelineArtifactSupportsTextPreview({
    kind: "file",
    fileName: attachment.file.name,
    mediaType: attachment.file.type
  }) ? "text" : undefined;
}
