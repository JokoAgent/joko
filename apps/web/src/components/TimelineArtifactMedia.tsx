import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { AlertCircle } from "lucide-react";

import type { ArtifactView } from "../model.js";
import type { Translator } from "./types.js";
import { Spinner, cx } from "./ui.js";

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
  const [urlState, setUrlState] = useState<MediaUrlState>({ status: "loading" });
  const [metadataLoaded, setMetadataLoaded] = useState(false);
  const mediaRef = useRef<HTMLMediaElement>(null);
  const loadUrlRef = useRef(loadUrl);
  loadUrlRef.current = loadUrl;

  useEffect(() => {
    let active = true;
    setUrlState({ status: "loading" });
    setMetadataLoaded(false);
    if (kind === undefined) return () => { active = false; };
    void loadUrlRef.current(artifact.blobId).then((url) => {
      if (active) setUrlState({ status: "ready", url });
    }).catch(() => {
      if (active) setUrlState({ status: "error" });
    });
    return () => {
      active = false;
      stopMediaPlayback(mediaRef.current);
    };
  }, [artifact.blobId, kind, playbackOwnerKey]);

  if (kind === undefined) return null;
  const playerLabel = t(kind === "audio" ? "timeline.audioPlayer" : "timeline.videoPlayer", { name: artifact.title || artifact.fileName });
  const failMedia = (): void => {
    stopMediaPlayback(mediaRef.current);
    setUrlState({ status: "error" });
  };

  return <div className={cx("timeline-artifact-media", `timeline-artifact-media--${kind}`, className)}>
    {urlState.status === "loading" && <div className="timeline-artifact-media__state"><Spinner label={t("timeline.mediaLoading")} /></div>}
    {urlState.status === "error" && <div className="timeline-artifact-media__state is-error" role="alert"><AlertCircle aria-hidden="true" /><span>{t("timeline.mediaUnavailable")}</span></div>}
    {urlState.status === "ready" && <>
      {kind === "audio"
        ? <audio ref={(node) => { if (node !== null) mediaRef.current = node; }} aria-label={playerLabel} controls preload="metadata" src={urlState.url} onLoadedMetadata={() => setMetadataLoaded(true)} onError={failMedia} />
        : <video ref={(node) => { if (node !== null) mediaRef.current = node; }} aria-label={playerLabel} controls playsInline preload="metadata" src={urlState.url} onLoadedMetadata={() => setMetadataLoaded(true)} onError={failMedia} />}
      {!metadataLoaded && <div className="timeline-artifact-media__loading"><Spinner label={t("timeline.mediaLoading")} /></div>}
    </>}
  </div>;
}

function stopMediaPlayback(media: HTMLMediaElement | null): void {
  if (media === null) return;
  media.pause();
  media.removeAttribute("src");
  media.load();
}
