import { AlertTriangle, Pen } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { downloadArtifactBlob } from "../artifact-download.js";
import { assertBrowserActionCurrent, type BrowserActionContext } from "../browser-action.js";
import { WorkspaceImageLightbox, type WorkspaceImageLightboxLabels } from "./WorkspaceImageLightbox.js";
import type { Translator } from "./types.js";
import { IconButton } from "./ui.js";

interface GeneratedImage {
  readonly scope: object;
  readonly blob: Blob;
  readonly url: string;
  readonly trigger: HTMLButtonElement;
  readonly release: () => void;
}

export interface GeneratedImageAnnotationLabels extends WorkspaceImageLightboxLabels {
  readonly prepareFailed: string;
}

export function generatedImageAnnotationLabels(t: Translator): GeneratedImageAnnotationLabels {
  return {
    close: t("common.close"), copy: t("workspace.imageCopy"), copied: t("workspace.imageCopied"), copyFailed: t("workspace.imageCopyFailed"),
    saveAs: t("workspace.imageSaveAs"), saveFailed: t("workspace.imageSaveFailed"), annotate: t("workspace.imageAnnotate"),
    discardAnnotation: t("workspace.imageDiscardAnnotation"), undoAnnotation: t("workspace.imageUndoAnnotation"),
    sendToChat: t("workspace.imageSendToChat"), sendFailed: t("workspace.imageSendFailed"), prepareFailed: t("timeline.imagePreviewFailed")
  };
}

export function GeneratedImageAnnotationButton({ ownerKey, sourceKey, ownerDocument, name, className, buildImage, onSendToChat, labels, onPreviewOpen, onPreviewClose }: {
  readonly ownerKey: string;
  readonly sourceKey: string;
  readonly ownerDocument: Document | undefined;
  readonly name: string;
  readonly className?: string;
  readonly buildImage: (context: BrowserActionContext) => Promise<Blob>;
  readonly onSendToChat: (file: File) => void | Promise<void>;
  readonly labels: GeneratedImageAnnotationLabels;
  readonly onPreviewOpen?: () => void;
  readonly onPreviewClose?: () => void;
}) {
  const scope = useMemo(() => ({}), [ownerKey, sourceKey, ownerDocument, name]);
  const scopeRef = useRef<object | undefined>(undefined);
  const requestRef = useRef<AbortController | undefined>(undefined);
  const imageRef = useRef<GeneratedImage | undefined>(undefined);
  const [image, setImage] = useState<GeneratedImage>();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const cancel = useCallback((): void => {
    requestRef.current?.abort();
    requestRef.current = undefined;
    imageRef.current?.release();
    imageRef.current = undefined;
    setImage(undefined);
    setPending(false);
    setFailed(false);
  }, []);
  useLayoutEffect(() => {
    scopeRef.current = scope;
    const ownerWindow = ownerDocument?.defaultView;
    ownerWindow?.addEventListener("pagehide", cancel);
    return () => {
      ownerWindow?.removeEventListener("pagehide", cancel);
      if (scopeRef.current === scope) { scopeRef.current = undefined; cancel(); }
    };
  }, [scope, ownerDocument, cancel]);
  const open = (trigger: HTMLButtonElement): void => {
    if (ownerDocument === undefined || scopeRef.current !== scope || requestRef.current !== undefined || imageRef.current !== undefined || trigger.ownerDocument !== ownerDocument) return;
    const request = new AbortController();
    requestRef.current = request;
    const context = { ownerDocument, signal: request.signal };
    const current = (): boolean => scopeRef.current === scope && requestRef.current === request && !request.signal.aborted
      && trigger.isConnected && trigger.ownerDocument === ownerDocument;
    setPending(true);
    setFailed(false);
    void (async () => {
      try {
        assertBrowserActionCurrent(context);
        const blob = await buildImage(context);
        assertBrowserActionCurrent(context);
        if (!current()) return;
        const ownerWindow = ownerDocument.defaultView! as Window & typeof globalThis;
        const url = ownerWindow.URL.createObjectURL(blob);
        let released = false;
        const item: GeneratedImage = { scope, blob, url, trigger, release() {
          if (released) return;
          released = true;
          ownerWindow.URL.revokeObjectURL(url);
        } };
        if (!current()) { item.release(); return; }
        imageRef.current = item;
        setImage(item);
        onPreviewOpen?.();
      } catch {
        if (current()) setFailed(true);
      } finally {
        if (requestRef.current === request) { requestRef.current = undefined; setPending(false); }
      }
    })();
  };
  return <>
    <IconButton className={className} label={failed ? labels.prepareFailed : labels.annotate} aria-busy={pending} aria-disabled={pending} onClick={(event) => open(event.currentTarget)}>{failed ? <AlertTriangle aria-hidden="true" /> : <Pen aria-hidden="true" />}</IconButton>
    {failed && <span className="sr-only" role="alert">{labels.prepareFailed}</span>}
    {image?.scope === scope && <WorkspaceImageLightbox
      ownerKey={JSON.stringify([ownerKey, sourceKey])}
      src={image.url}
      name={name}
      mediaType="image/png"
      startAnnotating
      returnFocus={image.trigger}
      labels={labels}
      onClose={() => { if (imageRef.current === image) { cancel(); onPreviewClose?.(); } }}
      onDownload={(context) => downloadArtifactBlob(image.blob, name, context)}
      onSendToChat={onSendToChat}
    />}
  </>;
}
