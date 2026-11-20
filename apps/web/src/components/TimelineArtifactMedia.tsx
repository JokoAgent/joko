import { useCallback, useContext, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { AlertCircle } from "lucide-react";

import type { ArtifactView } from "../model.js";
import type { Translator } from "./types.js";
import { Button, Spinner, cx } from "./ui.js";
import { VideoPreview } from "./VideoPreview.js";
import { AudioPreview } from "./AudioPreview.js";
import { NativeArtifactFileActionsMenu, NativeFileActionsContext } from "./NativeFileCopyMenu.js";
import { RENDERED_SHARE_CONTENT_PENDING_ATTRIBUTE } from "./rendered-share-dom.js";

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

interface TimelineArtifactMediaProps {
  readonly artifact: ArtifactView;
  readonly playbackOwnerKey: string;
  readonly loadUrl: (blobId: string) => Promise<string>;
  readonly t: Translator;
  readonly className?: string;
}

export function TimelineArtifactMedia(props: TimelineArtifactMediaProps): JSX.Element | null {
  const kind = timelineArtifactMediaKind(props.artifact.mediaType);
  if (kind === undefined) return null;
  const sourceKey = JSON.stringify([props.playbackOwnerKey, props.artifact.blobId, kind]);
  return <TimelineArtifactMediaContent key={sourceKey} {...props} kind={kind} sourceKey={sourceKey} />;
}

function TimelineArtifactMediaContent({ artifact, loadUrl, t, className, kind, sourceKey }: TimelineArtifactMediaProps & {
  readonly kind: TimelineArtifactMediaKind;
  readonly sourceKey: string;
}): JSX.Element {
  const fileActions = useContext(NativeFileActionsContext);
  const rootRef = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const currentAttemptRef = useRef<number | undefined>(undefined);
  const [loadedUrl, setLoadedUrl] = useState<MediaUrlState & { readonly attempt: number }>(() => ({ status: "loading", attempt }));
  const urlState: MediaUrlState = loadedUrl.attempt === attempt ? loadedUrl : { status: "loading" };
  const loadUrlRef = useRef(loadUrl);
  loadUrlRef.current = loadUrl;

  useEffect(() => {
    let active = true;
    currentAttemptRef.current = attempt;
    setLoadedUrl({ status: "loading", attempt });
    void (async () => {
      try {
        const url = await loadUrlRef.current(artifact.blobId);
        if (active && currentAttemptRef.current === attempt) setLoadedUrl({ status: "ready", url, attempt });
      } catch {
        if (active && currentAttemptRef.current === attempt) setLoadedUrl({ status: "error", attempt });
      }
    })();
    return () => {
      active = false;
      currentAttemptRef.current = undefined;
    };
  }, [artifact.blobId, attempt]);

  const retry = useCallback((): void => {
    if (kind !== "video" || urlState.status !== "error" || currentAttemptRef.current !== attempt || !rootRef.current?.isConnected) return;
    // Retire this attempt immediately, including duplicate events before React renders.
    currentAttemptRef.current = undefined;
    setAttempt(value => value + 1);
  }, [attempt, kind, urlState.status]);

  useEffect(() => {
    if (kind !== "video" || urlState.status !== "error") return;
    const ownerWindow = rootRef.current?.ownerDocument.defaultView;
    ownerWindow?.addEventListener("online", retry);
    ownerWindow?.addEventListener("focus", retry);
    return () => {
      ownerWindow?.removeEventListener("online", retry);
      ownerWindow?.removeEventListener("focus", retry);
    };
  }, [kind, retry, urlState.status]);

  const playerLabel = t(kind === "audio" ? "timeline.audioPlayer" : "timeline.videoPlayer", { name: artifact.title || artifact.fileName });
  const failMedia = (): void => {
    if (currentAttemptRef.current === attempt) setLoadedUrl({ status: "error", attempt });
  };

  return <div ref={rootRef} {...(urlState.status === "loading" ? { [RENDERED_SHARE_CONTENT_PENDING_ATTRIBUTE]: "" } : {})} className={cx("timeline-artifact-media", `timeline-artifact-media--${kind}`, className)}>
    {urlState.status === "loading" && <div className="timeline-artifact-media__state"><Spinner label={t("timeline.mediaLoading")} /></div>}
    {urlState.status === "error" && <div className="timeline-artifact-media__state is-error" role="alert"><AlertCircle aria-hidden="true" /><span>{t("timeline.mediaUnavailable")}</span>{kind === "video" && <Button onClick={retry}>{t("common.retry")}</Button>}</div>}
    {urlState.status === "error" && kind === "video" && <NativeArtifactFileActionsMenu actions={fileActions} artifact={artifact} ownerKey={sourceKey} t={t} />}
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
        : <VideoPreview key={attempt} src={urlState.url} ownerKey={sourceKey} inlineControls pauseWhenHidden labels={{ open: t("media.expandVideo", { name: artifact.title || artifact.fileName }), player: playerLabel, loading: t("timeline.mediaLoading"), unavailable: t("timeline.mediaUnavailable"), close: t("common.close"), playBlocked: t("media.playBlocked") }} onError={failMedia} actions={<NativeArtifactFileActionsMenu actions={fileActions} artifact={artifact} ownerKey={sourceKey} t={t} />} />}
    </>}
  </div>;
}
