import { Play, VideoOff, X } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState, type JSX, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { registerExclusiveMediaPlayback } from "../media-playback.js";
import { IconButton, Spinner } from "./ui.js";
import "./video-preview.css";

export interface VideoPreviewLabels {
  readonly open: string;
  readonly player: string;
  readonly loading: string;
  readonly unavailable: string;
  readonly close: string;
  readonly playBlocked: string;
}

export interface VideoPreviewProps {
  readonly src: string;
  readonly ownerKey: string;
  readonly labels: VideoPreviewLabels;
  readonly onError?: () => void;
  readonly actions?: ReactNode;
}

/** The caller owns the authenticated URL lease; the preview owns its media elements. */
export function VideoPreview(props: VideoPreviewProps): JSX.Element {
  return <VideoPreviewContent key={`${props.ownerKey}\u0000${props.src}`} {...props} />;
}

function VideoPreviewContent({ src, labels, onError, actions }: VideoPreviewProps): JSX.Element {
  const coverRef = useRef<HTMLVideoElement>(null);
  const [trigger, setTrigger] = useState<HTMLButtonElement>();
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const errorRef = useRef(onError);
  errorRef.current = onError;
  const fail = useCallback((): void => {
    releaseVideoSource(coverRef.current);
    setTrigger(undefined);
    setFailed(true);
    errorRef.current?.();
  }, []);

  useLayoutEffect(() => {
    const cover = coverRef.current;
    if (cover !== null && cover.getAttribute("src") !== src) cover.setAttribute("src", src);
    return () => releaseVideoSource(cover);
  }, [src]);

  return <div className="video-preview">
    {failed ? <div className="video-preview__unavailable" role="alert"><VideoOff aria-hidden="true" /><span>{labels.unavailable}</span></div> : <button
      type="button"
      className="video-preview__open"
      aria-label={labels.open}
      onClick={(event) => {
        const document = event.currentTarget.ownerDocument;
        if (document.body.classList.contains("modal-open") || document.querySelector('[aria-modal="true"]') !== null) return;
        setTrigger(event.currentTarget);
      }}
    >
      <video ref={coverRef} src={src} muted playsInline preload="metadata" aria-hidden="true" onLoadedMetadata={() => setLoaded(true)} onError={fail} />
      <span className="video-preview__play" aria-hidden="true"><Play /></span>
      {!loaded && <span className="video-preview__loading"><Spinner label={labels.loading} /></span>}
    </button>}
    {trigger === undefined && actions}
    {trigger !== undefined && <VideoLightbox src={src} labels={labels} trigger={trigger} onClose={() => setTrigger(undefined)} onError={fail} actions={actions} />}
  </div>;
}

function VideoLightbox({ src, labels, trigger, onClose, onError, actions }: {
  readonly src: string;
  readonly labels: VideoPreviewLabels;
  readonly trigger: HTMLButtonElement;
  readonly onClose: () => void;
  readonly onError: () => void;
  readonly actions?: ReactNode;
}): JSX.Element {
  const ownerDocument = trigger.ownerDocument;
  const dialogRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);
  const closedRef = useRef(false);
  const latest = useRef({ onClose, onError });
  latest.current = { onClose, onError };
  const [loading, setLoading] = useState(true);
  const [playBlocked, setPlayBlocked] = useState(false);
  const close = useCallback((): void => {
    if (closedRef.current) return;
    closedRef.current = true;
    restoreFocusRef.current = true;
    videoRef.current?.pause();
    latest.current.onClose();
  }, []);
  const fail = useCallback((): void => {
    if (closedRef.current) return;
    closedRef.current = true;
    videoRef.current?.pause();
    latest.current.onError();
  }, []);

  useLayoutEffect(() => {
    const video = videoRef.current;
    const dialog = dialogRef.current;
    if (video === null || dialog === null) return;
    if (video.getAttribute("src") !== src) video.setAttribute("src", src);
    let alive = true;
    const releasePlayback = registerExclusiveMediaPlayback(video);
    const body = ownerDocument.body;
    const ownedModalLock = !body.classList.contains("modal-open");
    body.classList.add("video-lightbox-open", "modal-open");
    video.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing || event.defaultPrevented) return;
      if (event.key === "Escape") {
        if (dialog.querySelector(".native-file-actions details[open]") !== null) return;
        if (ownerDocument.fullscreenElement) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
      } else if (event.key === "Tab" && !dialog.contains(ownerDocument.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? closeButtonRef.current : video)?.focus({ preventScroll: true });
      }
    };
    ownerDocument.addEventListener("keydown", onKeyDown, true);
    void video.play().catch((error: unknown) => {
      if (!alive || closedRef.current) return;
      const name = (error as { readonly name?: string } | null)?.name;
      if (name === "NotAllowedError") setPlayBlocked(true);
      else if (name !== "AbortError") fail();
    });
    return () => {
      alive = false;
      releasePlayback?.();
      releaseVideoSource(video);
      ownerDocument.removeEventListener("keydown", onKeyDown, true);
      body.classList.remove("video-lightbox-open");
      if (ownedModalLock && ![...ownerDocument.querySelectorAll('[aria-modal="true"]')].some((element) => element !== dialog)) body.classList.remove("modal-open");
      if (restoreFocusRef.current && trigger.isConnected && trigger.ownerDocument === ownerDocument) trigger.focus({ preventScroll: true });
    };
  }, [close, fail, ownerDocument, src, trigger]);

  return createPortal(<div
    ref={dialogRef}
    className="video-lightbox"
    role="dialog"
    aria-modal="true"
    aria-label={labels.player}
    onClick={(event) => { if (event.target === event.currentTarget) close(); }}
  >
    <span className="video-lightbox__focus-guard" tabIndex={0} aria-hidden="true" onFocus={() => closeButtonRef.current?.focus({ preventScroll: true })} />
    <div className="video-lightbox__content">
      <video
        ref={videoRef}
        src={src}
        controls
        autoPlay
        loop
        playsInline
        preload="auto"
        tabIndex={0}
        aria-label={labels.player}
        onLoadedData={() => setLoading(false)}
        onCanPlay={() => setLoading(false)}
        onWaiting={() => setLoading(true)}
        onPlaying={() => { setLoading(false); setPlayBlocked(false); }}
        onError={fail}
      />
      <div className="video-lightbox__toolbar">
        {actions}
        <div className="video-lightbox__feedback" aria-live="polite">
          {playBlocked ? <span role="status">{labels.playBlocked}</span> : loading ? <Spinner label={labels.loading} /> : null}
        </div>
        <IconButton buttonRef={closeButtonRef} label={labels.close} onClick={close}><X aria-hidden="true" /></IconButton>
      </div>
    </div>
    <span className="video-lightbox__focus-guard" tabIndex={0} aria-hidden="true" onFocus={() => videoRef.current?.focus({ preventScroll: true })} />
  </div>, ownerDocument.body);
}

function releaseVideoSource(video: HTMLVideoElement | null): void {
  if (video === null) return;
  video.pause();
  video.removeAttribute("src");
  video.load();
}
