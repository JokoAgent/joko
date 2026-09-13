import { AlertCircle, Check, Copy } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState, type JSX } from "react";

import { registerExclusiveMediaPlayback } from "../media-playback.js";
import type { AudioArtifactMetadataView } from "../model.js";
import { AudioArtwork } from "./AudioArtwork.js";
import { Spinner } from "./ui.js";
import "./audio-preview.css";

export interface AudioPreviewLabels {
  readonly player: string;
  readonly loading: string;
  readonly unavailable: string;
  readonly copyDescription: string;
  readonly copying: string;
  readonly copied: string;
  readonly copyFailed: string;
}

export interface AudioPreviewProps {
  readonly src: string;
  readonly ownerKey: string;
  readonly name: string;
  readonly description?: string;
  readonly metadata?: AudioArtifactMetadataView;
  readonly labels: AudioPreviewLabels;
}

interface AudioScope {
  readonly media: HTMLAudioElement;
  readonly document: Document;
  active: boolean;
}

type CopyState = "idle" | "pending" | "copied" | "failed";

/** The caller retains the authenticated audio URL; this view owns only playback. */
export function AudioPreview(props: AudioPreviewProps): JSX.Element {
  return <AudioPreviewContent key={JSON.stringify([props.ownerKey, props.src])} {...props} />;
}

function AudioPreviewContent({ src, ownerKey, name, description, metadata, labels }: AudioPreviewProps): JSX.Element {
  const [media, setMedia] = useState<HTMLAudioElement | null>(null);
  const attachMedia = useCallback((element: HTMLAudioElement | null) => { setMedia(element); }, []);
  const document = media?.ownerDocument;
  const scopeRef = useRef<AudioScope | undefined>(undefined);
  const copyRequest = useRef<object | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [duration, setDuration] = useState<number>();
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const copyText = metadata?.kind === "sound_effect" ? "" : (metadata?.description ?? description)?.trim() ?? "";
  const title = metadata?.title.trim() || name;
  const descriptionRef = useRef(copyText);
  descriptionRef.current = copyText;

  useLayoutEffect(() => {
    if (media === null || document === undefined) return;
    const scope: AudioScope = { media, document, active: true };
    scopeRef.current = scope;
    copyRequest.current = undefined;
    setLoading(true);
    setFailed(false);
    setCopyState("idle");
    if (media.getAttribute("src") !== src) media.setAttribute("src", src);
    const current = (): boolean => scope.active && scopeRef.current === scope && media.ownerDocument === document;
    const ready = (): void => {
      if (!current()) return;
      setLoading(false);
      if (Number.isFinite(media.duration) && media.duration > 0) setDuration(media.duration);
    };
    const waiting = (): void => { if (current()) setLoading(true); };
    const ended = (): void => {
      if (!current()) return;
      setLoading(false);
      media.currentTime = 0;
    };
    const fail = (): void => {
      if (!current()) return;
      setLoading(false);
      setFailed(true);
      stopAudio(media);
    };
    const releasePlayback = registerExclusiveMediaPlayback(media);
    media.addEventListener("loadedmetadata", ready);
    media.addEventListener("canplay", ready);
    media.addEventListener("playing", ready);
    media.addEventListener("waiting", waiting);
    media.addEventListener("ended", ended);
    media.addEventListener("error", fail);
    const retire = (): void => { scope.active = false; copyRequest.current = undefined; setCopyState("idle"); stopAudio(media); };
    const restore = (): void => {
      if (scopeRef.current !== scope || media.ownerDocument !== document || !media.isConnected) return;
      scope.active = true; setFailed(false); setLoading(true); setDuration(undefined); media.setAttribute("src", src);
    };
    document.defaultView?.addEventListener("pagehide", retire);
    document.defaultView?.addEventListener("pageshow", restore);
    return () => {
      scope.active = false;
      if (scopeRef.current === scope) {
        scopeRef.current = undefined;
        copyRequest.current = undefined;
      }
      media.removeEventListener("loadedmetadata", ready);
      media.removeEventListener("canplay", ready);
      media.removeEventListener("playing", ready);
      media.removeEventListener("waiting", waiting);
      media.removeEventListener("ended", ended);
      media.removeEventListener("error", fail);
      document.defaultView?.removeEventListener("pagehide", retire);
      document.defaultView?.removeEventListener("pageshow", restore);
      releasePlayback?.();
      stopAudio(media);
    };
  }, [document, media, src]);

  useLayoutEffect(() => {
    copyRequest.current = undefined;
    setCopyState("idle");
  }, [copyText]);

  const copyDescription = async (button: HTMLButtonElement): Promise<void> => {
    const scope = scopeRef.current;
    if (copyText === "" || copyRequest.current !== undefined || scope === undefined || !scope.active || button.ownerDocument !== scope.document) return;
    const request = {};
    copyRequest.current = request;
    setCopyState("pending");
    const current = (): boolean => scope.active && scopeRef.current === scope && copyRequest.current === request
      && scope.media.ownerDocument === scope.document && descriptionRef.current === copyText;
    try {
      const clipboard = scope.document.defaultView?.navigator.clipboard;
      if (clipboard === undefined) throw new Error("Clipboard is unavailable.");
      await clipboard.writeText(copyText);
      if (current()) setCopyState("copied");
    } catch {
      if (current()) setCopyState("failed");
    } finally {
      if (current()) copyRequest.current = undefined;
    }
  };

  return <div className="audio-preview">
    <div className="audio-preview__heading">
      <AudioArtwork ownerKey={ownerKey} artwork={metadata?.kind === "sound_effect" ? undefined : metadata?.artwork} />
      <div className="audio-preview__details">
        <strong className="audio-preview__title" title={title}>{title}</strong>
        {copyText !== "" && <p className="audio-preview__description" title={copyText}>{copyText}</p>}
      </div>
      {copyText !== "" && <button
        type="button"
        className="icon-button audio-preview__copy"
        aria-label={labels.copyDescription}
        title={labels.copyDescription}
        aria-disabled={copyState === "pending"}
        aria-busy={copyState === "pending"}
        onClick={(event) => { void copyDescription(event.currentTarget); }}
      >{copyState === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}</button>}
    </div>
    <audio ref={attachMedia} src={src} controls preload="metadata" aria-label={labels.player} hidden={failed} />
    {(duration ?? metadata?.durationSeconds) !== undefined && <span className="audio-preview__duration">{formatDuration(duration ?? metadata!.durationSeconds!)}</span>}
    {failed ? <div className="audio-preview__feedback is-error" role="alert"><AlertCircle aria-hidden="true" /><span>{labels.unavailable}</span></div>
      : loading ? <div className="audio-preview__feedback"><Spinner label={labels.loading} /></div> : null}
    {copyState !== "idle" && <span className="audio-preview__feedback" role={copyState === "failed" ? "alert" : "status"}>
      {copyState === "pending" ? labels.copying : copyState === "copied" ? labels.copied : labels.copyFailed}
    </span>}
  </div>;
}

function stopAudio(media: HTMLAudioElement): void {
  media.pause();
  media.removeAttribute("src");
  media.load();
}

function formatDuration(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}
