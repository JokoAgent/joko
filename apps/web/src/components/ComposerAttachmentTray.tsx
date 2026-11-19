import { draftDocumentAttachmentType, NATIVE_DRAFT_THUMBNAIL_INPUT_BYTES, NATIVE_DRAFT_THUMBNAIL_PNG_BYTES } from "@joko/contracts";
import { downloadArtifactBlob } from "../artifact-download.js";
import { assertBrowserActionCurrent } from "../browser-action.js";
import type { ArtifactDownloadContext } from "../model.js";
import { File, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";

import type { ArtifactView, AttachmentDraft } from "../model.js";
import type { MessageKey } from "../i18n.js";
import type { ImageAnnotationStroke } from "../image-annotations.js";
import { captureNativeFileOpen, nativeFileOpenAvailable, NATIVE_FILE_OPEN_MAXIMUM_BYTES, openNativeArtifactFile } from "../native-file-actions.js";
import { AnnotatedImage } from "./AnnotatedImage.js";
import { ComposerImageHoverPreview } from "./ComposerImageHoverPreview.js";
import { TimelineTextAttachmentLightbox } from "./TimelineTextAttachmentLightbox.js";
import { timelineArtifactSupportsTextPreview } from "./timeline-text-attachment.js";
import type { Translator } from "./types.js";
import { IconButton, cx, formatBytes } from "./ui.js";
import { useArtifactDownload } from "./use-artifact-download.js";
import { WorkspaceImageLightbox } from "./WorkspaceImageLightbox.js";

type AttachmentPreviewKind = "image" | "text";
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";

export function ComposerAttachmentTray({ ownerKey, attachments, removeDisabled = false, documentPreviewEnabled = false, t, onRemove, onSaveImageAnnotations }: {
  readonly ownerKey: string;
  readonly attachments: readonly AttachmentDraft[];
  readonly removeDisabled?: boolean;
  readonly documentPreviewEnabled?: boolean;
  readonly t: Translator;
  readonly onRemove: (attachment: AttachmentDraft) => void;
  readonly onSaveImageAnnotations?: (attachment: AttachmentDraft, strokes: readonly ImageAnnotationStroke[]) => void | Promise<void>;
}): JSX.Element {
  return <div className="attachment-list" aria-label={t("composer.attachments")}>
    {attachments.map((attachment) => <ComposerAttachmentItem
      key={JSON.stringify([ownerKey, attachment.id])}
      ownerKey={ownerKey}
      attachment={attachment}
      removeDisabled={removeDisabled}
      documentPreviewEnabled={documentPreviewEnabled}
      t={t}
      onRemove={onRemove}
      onSaveImageAnnotations={onSaveImageAnnotations}
    />)}
  </div>;
}

function ComposerAttachmentItem({ ownerKey, attachment, removeDisabled, documentPreviewEnabled, t, onRemove, onSaveImageAnnotations }: {
  readonly ownerKey: string;
  readonly attachment: AttachmentDraft;
  readonly removeDisabled: boolean;
  readonly documentPreviewEnabled: boolean;
  readonly t: Translator;
  readonly onRemove: (attachment: AttachmentDraft) => void;
  readonly onSaveImageAnnotations?: (attachment: AttachmentDraft, strokes: readonly ImageAnnotationStroke[]) => void | Promise<void>;
}): JSX.Element {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const chipRef = useRef<HTMLDivElement>(null);
  const textObjectUrlRef = useRef<string | undefined>(undefined);
  const suppressRestoredFocusPreviewRef = useRef(false);
  const [hovered, setHovered] = useState(false);
  const [imageOpen, setImageOpen] = useState(false);
  const [imageSnapshot, setImageSnapshot] = useState<AttachmentDraft>();
  const [textPreviewTrigger, setTextPreviewTrigger] = useState<HTMLButtonElement>();
  const [nativeFeedback, setNativeFeedback] = useState<{ readonly file: File; readonly message: MessageKey }>();
  const [thumbnail, setThumbnail] = useState<{ readonly file: File; readonly dataUrl: string }>();
  const previewKind = composerAttachmentPreviewKind(attachment);
  const documentSuffix = documentPreviewEnabled && attachment.kind === "file"
    ? draftDocumentAttachmentType(attachment.file.name) : undefined;
  const nativeOpen = previewKind === undefined && documentSuffix !== undefined
    && attachment.file.size <= NATIVE_FILE_OPEN_MAXIMUM_BYTES && nativeFileOpenAvailable();
  const action = useArtifactDownload(ownerKey, attachment.file);
  const nativeMessage = nativeFeedback?.file === attachment.file ? t(nativeFeedback.message) : undefined;
  const thumbnailDataUrl = thumbnail?.file === attachment.file && documentSuffix !== undefined ? thumbnail.dataUrl : undefined;
  const openLabel = previewKind === "image"
    ? t("timeline.openImage", { name: attachment.file.name })
    : `${t(nativeOpen ? "media.openFile" : "workspace.preview")}: ${attachment.file.name}`;

  useEffect(() => () => {
    const url = textObjectUrlRef.current;
    textObjectUrlRef.current = undefined;
    if (url !== undefined) URL.revokeObjectURL(url);
  }, [attachment.file]);

  useEffect(() => {
    const file = attachment.file, node = chipRef.current, desktop = window.jokoDesktop;
    if (!documentSuffix || !node || !desktop?.capabilities.includes("files.draftThumbnail")
      || desktop.thumbnailDraftFile === undefined || file.size === 0 || file.size > NATIVE_DRAFT_THUMBNAIL_INPUT_BYTES) return;
    const read = desktop.thumbnailDraftFile.bind(desktop), ownerDocument = node.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    const abort = new AbortController(), context = { ownerDocument, signal: abort.signal };
    const retire = () => abort.abort();
    let observer: IntersectionObserver | undefined;
    let loading = false;
    const load = (): void => {
      if (loading) return;
      loading = true;
      observer?.disconnect();
      void (async () => {
        assertBrowserActionCurrent(context);
        const bytes = new Uint8Array(await file.arrayBuffer());
        assertBrowserActionCurrent(context);
        const dataUrl = await read({ name: file.name, bytes });
        assertBrowserActionCurrent(context);
        if (dataUrl?.startsWith(PNG_DATA_URL_PREFIX) && dataUrl.length <= PNG_DATA_URL_PREFIX.length + 4 * Math.ceil(NATIVE_DRAFT_THUMBNAIL_PNG_BYTES / 3)) {
          setThumbnail({ file, dataUrl });
        }
      })().catch(() => undefined);
    };
    ownerWindow?.addEventListener("pagehide", retire, { once: true });
    if (typeof IntersectionObserver === "undefined") load();
    else {
      observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) load(); });
      observer.observe(node);
    }
    return () => {
      retire();
      observer?.disconnect();
      ownerWindow?.removeEventListener("pagehide", retire);
    };
  }, [attachment.file, documentSuffix]);

  const textArtifact = useMemo<ArtifactView>(() => ({
    id: attachment.id,
    blobId: attachment.id,
    sourceRevealAvailable: false,
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

  const download = useCallback((context: ArtifactDownloadContext) => downloadArtifactBlob(attachment.file, attachment.file.name || "attachment", context), [attachment.file]);

  const contents = <>
    {attachment.previewUrl !== undefined
      ? <AnnotatedImage className="attachment-chip__image" src={attachment.previewUrl} strokes={attachment.annotationStrokes} cover />
      : thumbnailDataUrl !== undefined
        ? <img className="attachment-chip__thumbnail" alt="" src={thumbnailDataUrl} />
        : documentSuffix !== undefined
          ? <span className="attachment-chip__type" aria-hidden="true">{documentSuffix}</span>
          : <File aria-hidden="true" />}
    <span><strong>{attachment.file.name}</strong><small>{formatBytes(attachment.file.size)}</small>
      {nativeMessage !== undefined && <small aria-hidden="true">{nativeMessage}</small>}
    </span>
  </>;

  const interactive = previewKind !== undefined || nativeOpen;
  return <div ref={chipRef} className={cx("attachment-chip", interactive ? "is-interactive" : "is-static")}>
    {!interactive
      ? <div className="attachment-chip__content" title={t("workspace.filePreviewUnavailable")}>{contents}</div>
      : <button
        ref={triggerRef}
        className="attachment-chip__content"
        type="button"
        aria-label={openLabel}
        aria-busy={nativeOpen ? action.pending : undefined}
        aria-disabled={nativeOpen ? action.pending : undefined}
        title={nativeMessage ?? openLabel}
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
            setImageSnapshot(attachment);
            setImageOpen(true);
          } else if (previewKind === "text") {
            setTextPreviewTrigger(event.currentTarget);
          } else if (nativeOpen) {
            const file = attachment.file;
            const host = captureNativeFileOpen();
            action.run(event.currentTarget.ownerDocument, async context => {
              setNativeFeedback(undefined);
              let message: MessageKey = "media.fileOpenFailed";
              try {
                const result = await openNativeArtifactFile(file, file.name, context, host);
                if (result.status === "cancelled") return;
                if (result.status === "opened") message = "media.fileOpened";
                else if (result.status === "unknown") message = "media.fileOpenUnknown";
                else if (result.status === "failed" && result.reason === "capacity") message = "media.fileOpenCapacity";
              } catch { /* Keep the generic failure for an undispatched request. */ }
              if (!context.signal.aborted) setNativeFeedback({ file, message });
            });
          }
        }}
      >{contents}</button>}
    <IconButton
      label={`${t("composer.removeAttachment")}: ${attachment.file.name}`}
      disabled={removeDisabled}
      disabledReason={removeDisabled ? t("common.working") : undefined}
      onClick={() => onRemove(attachment)}
    ><X aria-hidden="true" /></IconButton>
    {nativeMessage !== undefined && <span className="sr-only" role="status">{nativeMessage}</span>}

    {previewKind === "image" && attachment.previewUrl !== undefined && <ComposerImageHoverPreview
      open={hovered && !imageOpen}
      anchorRef={triggerRef}
      src={attachment.previewUrl}
      annotationStrokes={attachment.annotationStrokes}
    />}
    {imageOpen && imageSnapshot?.previewUrl !== undefined && <WorkspaceImageLightbox
      ownerKey={JSON.stringify([ownerKey, attachment.id])}
      src={imageSnapshot.previewUrl}
      name={imageSnapshot.file.name}
      mediaType={imageSnapshot.file.type}
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
      onDownload={context => downloadArtifactBlob(imageSnapshot.file, imageSnapshot.file.name || "attachment", context)}
      annotationEdit={{ initialStrokes: imageSnapshot.annotationStrokes, onSave: !removeDisabled && onSaveImageAnnotations ? strokes => onSaveImageAnnotations(imageSnapshot, strokes) : undefined }}
    />}
    {textPreviewTrigger !== undefined && <TimelineTextAttachmentLightbox
      ownerKey={JSON.stringify([ownerKey, attachment.id])}
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
      onDownload={(_blobId, _name, context) => download(context)}
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
