import { useContext, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { AlertCircle } from "lucide-react";

import type { ArtifactView } from "../model.js";
import type { Translator } from "./types.js";
import { Spinner, cx } from "./ui.js";
import { VideoPreview } from "./VideoPreview.js";
import { AudioPreview } from "./AudioPreview.js";
import { NativeFileCopyContext, NativeFileCopyMenu } from "./NativeFileCopyMenu.js";

export type TimelineArtifactMediaKind = "audio" | "video";

type MediaUrlState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly url: string }
  | { readonly status: "error" };

export function timelineArtifactMediaKind(mediaType: string): TimelineArtifactMediaKind | undefined {
  const normalized = mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (/^audio\/[^/\s]+$/u.test(normalized)) return "audio";
  if (/^video\/[^/\s]+$/u.test(normalized)) return "video";
  return undefined;
}

export function TimelineArtifactMedia({ artifact, playbackOwnerKey, loadUrl, t, className }: {
  readonly artifact: ArtifactView;
  readonly playbackOwnerKey: string;
  readonly loadUrl: (blobId: string) => Promise<string>;
  readonly t: Translator;
  readonly className?: string;
}): JSX.Element | null {
  const kind = timelineArtifactMediaKind(artifact.mediaType);
  const copyFile = useContext(NativeFileCopyContext);
  const sourceKey = JSON.stringify([playbackOwnerKey, artifact.blobId, kind]);
  const [loadedUrl, setLoadedUrl] = useState<MediaUrlState & { readonly owner: string }>(() => ({ status: "loading", owner: sourceKey }));
  const urlState: MediaUrlState = loadedUrl.owner === sourceKey ? loadedUrl : { status: "loading" };
  const loadUrlRef = useRef(loadUrl);
  loadUrlRef.current = loadUrl;

  useEffect(() => {
    let active = true;
    setLoadedUrl({ status: "loading", owner: sourceKey });
    if (kind === undefined) return () => { active = false; };
    void loadUrlRef.current(artifact.blobId).then((url) => {
      if (active) setLoadedUrl({ status: "ready", url, owner: sourceKey });
    }).catch(() => {
      if (active) setLoadedUrl({ status: "error", owner: sourceKey });
    });
    return () => {
      active = false;
    };
  }, [artifact.blobId, kind, sourceKey]);

  if (kind === undefined) return null;
  const playerLabel = t(kind === "audio" ? "timeline.audioPlayer" : "timeline.videoPlayer", { name: artifact.title || artifact.fileName });
  const failMedia = (): void => {
    setLoadedUrl({ status: "error", owner: sourceKey });
  };

  return <div className={cx("timeline-artifact-media", `timeline-artifact-media--${kind}`, className)}>
    {urlState.status === "loading" && <div className="timeline-artifact-media__state"><Spinner label={t("timeline.mediaLoading")} /></div>}
    {urlState.status === "error" && <div className="timeline-artifact-media__state is-error" role="alert"><AlertCircle aria-hidden="true" /><span>{t("timeline.mediaUnavailable")}</span></div>}
    {urlState.status === "error" && kind === "video" && <NativeFileCopyMenu copyFile={copyFile} blobId={artifact.blobId} name={artifact.fileName} byteSize={artifact.byteSize} ownerKey={sourceKey} t={t} />}
    {urlState.status === "ready" && <>
      {kind === "audio"
        ? <AudioPreview
          src={urlState.url}
          ownerKey={sourceKey}
          name={artifact.title.trim() || artifact.fileName}
          description={artifact.description}
          metadata={artifact.audioMetadata}
          labels={{ player: playerLabel, loading: t("timeline.mediaLoading"), unavailable: t("timeline.mediaUnavailable"), copyDescription: t("media.copyDescription"), copying: t("media.copyingDescription"), copied: t("media.descriptionCopied"), copyFailed: t("media.descriptionCopyFailed") }}
        />
        : <VideoPreview src={urlState.url} ownerKey={sourceKey} labels={{ open: t("media.openVideo", { name: artifact.title || artifact.fileName }), player: playerLabel, loading: t("timeline.mediaLoading"), unavailable: t("timeline.mediaUnavailable"), close: t("common.close"), playBlocked: t("media.playBlocked") }} onError={failMedia} actions={<NativeFileCopyMenu copyFile={copyFile} blobId={artifact.blobId} name={artifact.fileName} byteSize={artifact.byteSize} ownerKey={sourceKey} t={t} />} />}
    </>}
  </div>;
}
