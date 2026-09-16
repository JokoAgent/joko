import { Box } from "lucide-react";
import { useContext, useEffect, useState, type JSX } from "react";

import type { ArtifactView, OperationApi } from "../model.js";
import type { Translator } from "./types.js";
import { IconButton } from "./ui.js";
import { WorkspaceModelLightbox } from "./WorkspaceModelLightbox.js";
import { materializeWorkspaceModelSource } from "./workspace-gltf-source.js";
import { NativeFileActionsContext, NativeFileActionsMenu } from "./NativeFileCopyMenu.js";

interface TimelineArtifactModelProps {
  readonly artifact: ArtifactView;
  readonly ownerKey: string;
  readonly loadUrl: (blobId: string) => Promise<string>;
  readonly onDownload: OperationApi["downloadArtifact"];
  readonly t: Translator;
  readonly className?: string;
}

export function timelineArtifactModelKind(artifact: Pick<ArtifactView, "fileName" | "mediaType">): "glb" | "gltf" | undefined {
  const mediaType = artifact.mediaType.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType === "model/gltf-binary") return "glb";
  if (mediaType === "model/gltf+json") return "gltf";
  if (/\.glb$/iu.test(artifact.fileName)) return "glb";
  if (/\.gltf$/iu.test(artifact.fileName)) return "gltf";
  return undefined;
}

export function TimelineArtifactModel(props: TimelineArtifactModelProps): JSX.Element {
  return <ArtifactModelEntry key={JSON.stringify([props.ownerKey, props.artifact.blobId, props.artifact.fileName, props.artifact.mediaType])} {...props} />;
}

function ArtifactModelEntry({ artifact, ownerKey, loadUrl, onDownload, t, className }: TimelineArtifactModelProps): JSX.Element {
  const [trigger, setTrigger] = useState<HTMLButtonElement>();
  return <>
    <IconButton
      className={className}
      label={`${t("workspace.modelOpen")}: ${artifact.fileName}`}
      tip={t("workspace.modelOpen")}
      onClick={(event) => {
        const ownerDocument = event.currentTarget.ownerDocument;
        if (ownerDocument.body.classList.contains("modal-open") || ownerDocument.querySelector("[role='dialog'][aria-modal='true']") !== null) return;
        setTrigger(event.currentTarget);
      }}
    ><Box aria-hidden="true" /></IconButton>
    {trigger !== undefined && <ArtifactModelLightbox artifact={artifact} ownerKey={ownerKey} trigger={trigger} loadUrl={loadUrl} onDownload={onDownload} t={t} onClose={() => setTrigger(undefined)} />}
  </>;
}

type ModelSourceState = { readonly kind: "loading" } | { readonly kind: "ready"; readonly url: string } | { readonly kind: "error"; readonly missingDependencies: boolean };

function ArtifactModelLightbox({ artifact, ownerKey, trigger, loadUrl, onDownload, t, onClose }: TimelineArtifactModelProps & {
  readonly trigger: HTMLElement;
  readonly onClose: () => void;
}): JSX.Element {
  const fileActions = useContext(NativeFileActionsContext);
  const [source, setSource] = useState<ModelSourceState>({ kind: "loading" });
  useEffect(() => {
    const request = new AbortController();
    let materialized: Awaited<ReturnType<typeof materializeWorkspaceModelSource>> | undefined;
    let missingDependencies = false;
    void loadUrl(artifact.blobId).then(async (url) => {
      if (request.signal.aborted) return;
      const result = await materializeWorkspaceModelSource({
        sourceUrl: url,
        // This is a format identifier, never an inferred filesystem location.
        modelPath: `model.${timelineArtifactModelKind(artifact) ?? "gltf"}`,
        fetchSource: (input, init) => fetch(input, { ...init, signal: request.signal }),
        loadResource: async () => {
          missingDependencies = true;
          throw new Error("The model's dependency files are not attached.");
        }
      });
      materialized = result;
      if (request.signal.aborted) result.dispose();
      else setSource({ kind: "ready", url: result.url });
    }).catch(() => {
      if (!request.signal.aborted) setSource({ kind: "error", missingDependencies });
    });
    return () => {
      request.abort();
      materialized?.dispose();
    };
    // Each entry is keyed to the artifact and Timeline owner. loadUrl is the
    // existing Timeline cache owner and retains/releases the original lease.
  }, []);

  return <WorkspaceModelLightbox
    ownerKey={JSON.stringify([ownerKey, artifact.blobId])}
    src={source.kind === "ready" ? source.url : undefined}
    sourceError={source.kind === "error" ? t(source.missingDependencies ? "workspace.modelDependenciesUnavailable" : "workspace.modelUnavailable") : undefined}
    name={artifact.fileName}
    labels={{
      loading: t("workspace.modelLoading"),
      unavailable: t("workspace.modelUnavailable"),
      close: t("common.close"),
      download: t("workspace.downloadFile"),
      downloadFailed: t("workspace.modelDownloadFailed"),
      zoomIn: t("workspace.modelZoomIn"),
      zoomOut: t("workspace.modelZoomOut"),
      reset: t("workspace.modelReset"),
      interactionHint: t("workspace.modelInteractionHint")
    }}
    returnFocus={trigger}
    actions={<NativeFileActionsMenu actions={fileActions} blobId={artifact.blobId} name={artifact.fileName} byteSize={artifact.byteSize} ownerKey={JSON.stringify([ownerKey, artifact.blobId, "native-file"])} t={t} />}
    onDownload={(context) => onDownload(artifact.blobId, artifact.fileName, context)}
    onClose={onClose}
  />;
}
