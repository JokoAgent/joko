import type { ArtifactDownloadContext } from "../model.js";
import { Box, Download, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState, type JSX } from "react";
import { createPortal } from "react-dom";
import { IconButton, Spinner } from "./ui.js";

import { WorkspaceModelViewer, type WorkspaceModelViewerLabels } from "./WorkspaceModelViewer.js";
import {
  resetWorkspaceModelCamera,
  zoomWorkspaceModelCamera,
  type WorkspaceModelViewerElement
} from "./workspace-model-runtime.js";

export interface WorkspaceModelLightboxLabels extends WorkspaceModelViewerLabels {
  readonly close: string;
  readonly download: string;
  readonly downloadFailed: string;
  readonly zoomIn: string;
  readonly zoomOut: string;
  readonly reset: string;
  readonly interactionHint: string;
}

export interface WorkspaceModelLightboxProps {
  /** Stable identity while an asynchronous source is loading. */
  readonly ownerKey?: string;
  readonly src: string | undefined;
  readonly sourceError?: string;
  readonly name: string;
  readonly labels: WorkspaceModelLightboxLabels;
  readonly returnFocus?: HTMLElement | null;
  readonly onClose: () => void;
  readonly onDownload: (context: ArtifactDownloadContext) => unknown | Promise<unknown>;
}

/** Full-screen orbit/zoom model viewer; it receives only an artifact URL and display name. */
export function WorkspaceModelLightbox(props: WorkspaceModelLightboxProps): JSX.Element {
  return <ModelLightboxContent key={props.ownerKey ?? props.src ?? props.name} {...props} />;
}

function ModelLightboxContent({
  src,
  sourceError,
  name,
  labels,
  returnFocus,
  onClose,
  onDownload
}: WorkspaceModelLightboxProps): JSX.Element {
  const ownerDocument = returnFocus?.ownerDocument ?? document;
  const ownerWindow = ownerDocument.defaultView ?? window;
  const overlayRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<WorkspaceModelViewerElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const closingRef = useRef(false);
  const restoreFocusRef = useRef(false);
  const aliveRef = useRef(false);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const sourceKey = JSON.stringify([src, name, sourceError]);
  const sourceOwnerRef = useRef<object | undefined>(undefined);
  const downloadRef = useRef<AbortController | undefined>(undefined);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string>();

  const close = useCallback((): void => {
    if (closingRef.current) return;
    closingRef.current = true;
    downloadRef.current?.abort();
    (ownerDocument.activeElement as HTMLElement | null)?.blur?.();
    setVisible(false);
    closeTimerRef.current = ownerWindow.setTimeout(() => {
      if (!aliveRef.current) return;
      restoreFocusRef.current = true;
      closeRef.current();
    }, ownerWindow.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true ? 0 : 200);
  }, [ownerDocument, ownerWindow]);

  useLayoutEffect(() => {
    aliveRef.current = true;
    closingRef.current = false;
    restoreFocusRef.current = false;
    const body = ownerDocument.body;
    const ownedModalLock = !body.classList.contains("modal-open");
    body.classList.add("workspace-model-lightbox-open", "modal-open");
    const frame = ownerWindow.requestAnimationFrame(() => {
      if (closingRef.current) return;
      setVisible(true);
      overlayRef.current?.focus({ preventScroll: true });
    });
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing || event.defaultPrevented) return;
      if (event.key === "Tab") {
        const overlay = overlayRef.current;
        if (overlay === null) return;
        const focusable = [...overlay.querySelectorAll<HTMLElement>(
          "button:not([disabled]), model-viewer[tabindex='0'], [tabindex]:not([tabindex='-1'])"
        )].filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
        if (focusable.length === 0) {
          event.preventDefault();
          overlay.focus({ preventScroll: true });
          return;
        }
        const active = overlay.ownerDocument.activeElement;
        const index = focusable.indexOf(active as HTMLElement);
        if (index < 0 || (!event.shiftKey && index === focusable.length - 1) || (event.shiftKey && index === 0)) {
          event.preventDefault();
          (event.shiftKey ? focusable.at(-1) : focusable[0])?.focus({ preventScroll: true });
        }
        return;
      }
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
        return;
      }
      if (event.key === "+" || event.key === "=" || event.key === "PageUp") {
        event.preventDefault();
        event.stopImmediatePropagation();
        zoomWorkspaceModelCamera(viewerRef.current, 0.8);
      } else if (event.key === "-" || event.key === "_" || event.key === "PageDown") {
        event.preventDefault();
        event.stopImmediatePropagation();
        zoomWorkspaceModelCamera(viewerRef.current, 1.25);
      } else if (event.key === "0" || event.key.toLocaleLowerCase() === "r") {
        event.preventDefault();
        event.stopImmediatePropagation();
        resetWorkspaceModelCamera(viewerRef.current);
      }
    };
    ownerDocument.addEventListener("keydown", onKeyDown, true);
    return () => {
      aliveRef.current = false;
      ownerWindow.cancelAnimationFrame(frame);
      if (closeTimerRef.current !== undefined) ownerWindow.clearTimeout(closeTimerRef.current);
      ownerDocument.removeEventListener("keydown", onKeyDown, true);
      body.classList.remove("workspace-model-lightbox-open");
      if (ownedModalLock && [...ownerDocument.querySelectorAll(".modal-layer, [role='dialog'][aria-modal='true']")].every((element) => element === overlayRef.current)) {
        body.classList.remove("modal-open");
      }
      if (restoreFocusRef.current && returnFocus?.isConnected === true) returnFocus.focus({ preventScroll: true });
    };
  }, [close, ownerDocument, ownerWindow, returnFocus]);

  useLayoutEffect(() => {
    const owner = {};
    sourceOwnerRef.current = owner;
    downloadRef.current?.abort();
    downloadRef.current = undefined;
    setBusy(false);
    setFeedback(undefined);
    const onPageHide = (): void => {
      downloadRef.current?.abort();
      downloadRef.current = undefined;
      setBusy(false);
    };
    ownerWindow.addEventListener("pagehide", onPageHide);
    return () => {
      ownerWindow.removeEventListener("pagehide", onPageHide);
      if (sourceOwnerRef.current === owner) sourceOwnerRef.current = undefined;
      downloadRef.current?.abort();
      downloadRef.current = undefined;
    };
  }, [sourceKey, ownerDocument, ownerWindow, returnFocus]);

  const download = (): void => {
    if (downloadRef.current !== undefined || closingRef.current || sourceOwnerRef.current === undefined) return;
    const owner = sourceOwnerRef.current;
    const request = new AbortController();
    downloadRef.current = request;
    setBusy(true);
    setFeedback(undefined);
    const current = (): boolean => aliveRef.current && sourceOwnerRef.current === owner && downloadRef.current === request && !closingRef.current;
    void Promise.resolve().then(() => { if (current()) return onDownload({ ownerDocument, signal: request.signal }); }).catch(() => {
      if (current()) setFeedback(labels.downloadFailed);
    }).finally(() => {
      if (!current()) return;
      downloadRef.current = undefined;
      setBusy(false);
    });
  };

  return createPortal(<div
    ref={overlayRef}
    className={`workspace-model-lightbox${visible ? " is-visible" : ""}`}
    role="dialog"
    aria-modal="true"
    aria-label={name}
    tabIndex={-1}
    onPointerDown={(event) => {
      if (event.target === event.currentTarget) close();
    }}
  >
    <div className="workspace-model-lightbox__stage" onPointerDown={(event) => event.stopPropagation()}>
      {sourceError !== undefined || src === undefined ? <div className="workspace-model-viewer workspace-model-lightbox__viewer">
        <div className={`workspace-model-viewer__state${sourceError === undefined ? "" : " is-error"}`} role={sourceError === undefined ? "status" : "alert"}>
          {sourceError === undefined ? <Spinner label={labels.loading} /> : <Box aria-hidden="true" />}
          <span>{sourceError ?? labels.loading}</span>
        </div>
      </div> : <WorkspaceModelViewer
        src={src}
        name={name}
        labels={labels}
        className="workspace-model-lightbox__viewer"
        onViewer={(viewer) => { viewerRef.current = viewer; }}
      />}
      <div className="workspace-model-lightbox__title"><strong>{name}</strong><span>{labels.interactionHint}</span></div>
    </div>
    <div className="workspace-model-lightbox__toolbar" onPointerDown={(event) => event.stopPropagation()}>
      <ModelLightboxButton label={labels.zoomOut} disabled={src === undefined || sourceError !== undefined} onClick={() => zoomWorkspaceModelCamera(viewerRef.current, 1.25)}><ZoomOut /></ModelLightboxButton>
      <ModelLightboxButton label={labels.reset} disabled={src === undefined || sourceError !== undefined} onClick={() => resetWorkspaceModelCamera(viewerRef.current)}><RotateCcw /></ModelLightboxButton>
      <ModelLightboxButton label={labels.zoomIn} disabled={src === undefined || sourceError !== undefined} onClick={() => zoomWorkspaceModelCamera(viewerRef.current, 0.8)}><ZoomIn /></ModelLightboxButton>
      <span aria-hidden="true" />
      <ModelLightboxButton label={labels.download} disabled={busy} onClick={download}><Download /></ModelLightboxButton>
      <ModelLightboxButton label={labels.close} onClick={close}><X /></ModelLightboxButton>
    </div>
    {feedback !== undefined && <div className="workspace-model-lightbox__feedback" role="alert">{feedback}</div>}
  </div>, ownerDocument.body);
}

function ModelLightboxButton({ label, disabled, onClick, children }: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: JSX.Element;
}): JSX.Element {
  return <IconButton label={label} disabled={disabled} disabledReason={disabled ? label : undefined} onClick={onClick}>{children}</IconButton>;
}
