import { useEffect, useState } from "react";
import type { ExtensionCardApi } from "../model.js";
import type { Translator } from "./types.js";
import { downloadArtifactUrl } from "../artifact-download.js";
import { WorkspaceImageLightbox } from "./WorkspaceImageLightbox.js";
import { WorkspaceModelLightbox } from "./WorkspaceModelLightbox.js";
import { materializeWorkspaceModelSource } from "./workspace-gltf-source.js";
import { Button, Modal, Spinner } from "./ui.js";

export function ExtensionCardMediaPreview({ api, sessionId, cardId, sources, initialIndex, initial, ownerKey, t, onClose }: {
  api: ExtensionCardApi; sessionId: string; cardId: string; sources: readonly { cardId: string; uri: string }[]; initialIndex: number; initial: string; ownerKey: string; t: Translator; onClose(): void;
}) {
  const [index, setIndex] = useState(initialIndex), selected = sources[index] ?? { cardId, uri: initial }, uri = selected.uri, selectedCardId = selected.cardId, key = `${selectedCardId}:${uri}`;
  const [source, setSource] = useState<Awaited<ReturnType<ExtensionCardApi["loadMedia"]>>>(), [error, setError] = useState(false), [modelUrl, setModelUrl] = useState<string>();
  const [loadedKey, setLoadedKey] = useState<string>();
  const [attempt, retry] = useState(0);
  useEffect(() => {
    const abort = new AbortController(); let retained: typeof source, model: Awaited<ReturnType<typeof materializeWorkspaceModelSource>> | undefined;
    setSource(undefined); setError(false); setModelUrl(undefined);
    void api.loadMedia(sessionId, selectedCardId, uri, abort.signal).then(async value => {
      retained = value; if (abort.signal.aborted) { value.release(); return; }
      if (uri.endsWith(".glb")) {
        model = await materializeWorkspaceModelSource({ sourceUrl: value.url, modelPath: "model.glb", fetchSource: (input, init) => fetch(input, { ...init, signal: abort.signal }), loadResource: async () => { throw new Error("Model dependency files unavailable."); } });
        if (abort.signal.aborted) { model.dispose(); return; } setModelUrl(model.url);
      }
      if (!abort.signal.aborted) { setSource(value); setLoadedKey(key); }
    }).catch(() => { if (!abort.signal.aborted) setError(true); });
    return () => { abort.abort(); retained?.release(); model?.dispose(); };
  }, [api, sessionId, selectedCardId, uri, attempt]);
  const name = source?.blob.fileName || (uri.endsWith(".glb") ? "model.glb" : "image"), download = (context: Parameters<typeof downloadArtifactUrl>[2]) => {
    if (!source) throw new Error("Extension media unavailable."); return downloadArtifactUrl(source.url, name, context);
  };
  if (!source || loadedKey !== key || uri.endsWith(".glb") && !modelUrl) return <Modal open title={t("extensionCards.mediaPreview")} size="small" showClose closeLabel={t("common.close")} onClose={onClose}>
    {error ? <div role="alert"><p>{t("extensionCards.failed")}</p><Button onClick={() => retry(value => value + 1)}>{t("common.retry")}</Button></div> : <Spinner label={t("common.loading")} />}
  </Modal>;
  if (uri.endsWith(".glb")) return <WorkspaceModelLightbox ownerKey={`${ownerKey}:${uri}`} src={modelUrl} sourceError={error ? t("workspace.modelUnavailable") : undefined} name={name}
    labels={{ loading: t("workspace.modelLoading"), unavailable: t("workspace.modelUnavailable"), close: t("common.close"), download: t("workspace.downloadFile"), downloadFailed: t("workspace.modelDownloadFailed"), zoomIn: t("workspace.modelZoomIn"), zoomOut: t("workspace.modelZoomOut"), reset: t("workspace.modelReset"), interactionHint: t("workspace.modelInteractionHint") }} onDownload={download} onClose={onClose} />;
  return <WorkspaceImageLightbox ownerKey={`${ownerKey}:${uri}`} src={source?.url ?? ""} status={error ? "error" : source ? "ready" : "loading"} name={name} mediaType={source?.blob.mediaType}
    labels={{ close: t("common.close"), copy: t("workspace.imageCopy"), copied: t("workspace.imageCopied"), copyFailed: t("workspace.imageCopyFailed"), saveAs: t("workspace.imageSaveAs"), saveFailed: t("workspace.imageSaveFailed"), annotate: t("workspace.imageAnnotate"), discardAnnotation: t("workspace.imageDiscardAnnotation"), undoAnnotation: t("workspace.imageUndoAnnotation"), sendToChat: t("workspace.imageSendToChat"), sendFailed: t("workspace.imageSendFailed"), previousImage: t("timeline.previousImage"), nextImage: t("timeline.nextImage"), zoomIn: t("timeline.zoomIn"), zoomOut: t("timeline.zoomOut"), fitImage: t("timeline.fitImage"), actualSize: t("timeline.actualSize"), loading: t("common.loading"), unavailable: t("timeline.imageUnavailable") }}
    showZoomControls gallery={sources.length > 1 ? { index, total: sources.length, onPrevious: () => setIndex((index + sources.length - 1) % sources.length), onNext: () => setIndex((index + 1) % sources.length) } : undefined} onDownload={download} onClose={onClose} />;
}
