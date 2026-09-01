import { Download, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./ui.js";

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
  readonly src: string;
  readonly name: string;
  readonly labels: WorkspaceModelLightboxLabels;
  readonly returnFocus?: HTMLElement | null;
  readonly onClose: () => void;
  readonly onDownload: () => void | Promise<void>;
}

/** Full-screen orbit/zoom model viewer; it receives only an artifact URL and display name. */
export function WorkspaceModelLightbox({
  src,
  name,
  labels,
  returnFocus,
  onClose,
  onDownload
}: WorkspaceModelLightboxProps): JSX.Element {
  const overlayRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<WorkspaceModelViewerElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const closingRef = useRef(false);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string>();

  const close = useCallback((): void => {
    if (closingRef.current) return;
    closingRef.current = true;
    (document.activeElement as HTMLElement | null)?.blur?.();
    setVisible(false);
    window.setTimeout(() => closeRef.current(), 200);
  }, []);

  useEffect(() => {
    const body = document.body;
    const ownedModalLock = !body.classList.contains("modal-open");
    body.classList.add("workspace-model-lightbox-open", "modal-open");
    const frame = window.requestAnimationFrame(() => {
      setVisible(true);
      overlayRef.current?.focus({ preventScroll: true });
    });
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing) return;
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
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown, true);
      body.classList.remove("workspace-model-lightbox-open");
      if (ownedModalLock && document.querySelector(".modal-layer, .workspace-image-lightbox, .workspace-model-lightbox") === null) {
        body.classList.remove("modal-open");
      }
      if (returnFocus?.isConnected === true) returnFocus.focus({ preventScroll: true });
    };
  }, [close, returnFocus]);

  const download = (): void => {
    if (busy) return;
    setBusy(true);
    setFeedback(undefined);
    void Promise.resolve(onDownload()).catch(() => setFeedback(labels.downloadFailed)).finally(() => setBusy(false));
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
      <WorkspaceModelViewer
        src={src}
        name={name}
        labels={labels}
        className="workspace-model-lightbox__viewer"
        onViewer={(viewer) => { viewerRef.current = viewer; }}
      />
      <div className="workspace-model-lightbox__title"><strong>{name}</strong><span>{labels.interactionHint}</span></div>
    </div>
    <div className="workspace-model-lightbox__toolbar" onPointerDown={(event) => event.stopPropagation()}>
      <ModelLightboxButton label={labels.zoomOut} onClick={() => zoomWorkspaceModelCamera(viewerRef.current, 1.25)}><ZoomOut /></ModelLightboxButton>
      <ModelLightboxButton label={labels.reset} onClick={() => resetWorkspaceModelCamera(viewerRef.current)}><RotateCcw /></ModelLightboxButton>
      <ModelLightboxButton label={labels.zoomIn} onClick={() => zoomWorkspaceModelCamera(viewerRef.current, 0.8)}><ZoomIn /></ModelLightboxButton>
      <span aria-hidden="true" />
      <ModelLightboxButton label={labels.download} disabled={busy} onClick={download}><Download /></ModelLightboxButton>
      <ModelLightboxButton label={labels.close} onClick={close}><X /></ModelLightboxButton>
    </div>
    {feedback !== undefined && <div className="workspace-model-lightbox__feedback" role="alert">{feedback}</div>}
  </div>, document.body);
}

function ModelLightboxButton({ label, disabled, onClick, children }: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: JSX.Element;
}): JSX.Element {
  return <IconButton label={label} disabled={disabled} disabledReason={disabled ? label : undefined} onClick={onClick}>{children}</IconButton>;
}
