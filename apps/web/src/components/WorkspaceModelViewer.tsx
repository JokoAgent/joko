import { Box } from "lucide-react";
import { useEffect, useRef, useState, type JSX } from "react";

import {
  ensureWorkspaceModelViewer,
  type WorkspaceModelViewerElement
} from "./workspace-model-runtime.js";
import { Spinner, cx } from "./ui.js";
import "./workspace-model-viewer.css";

export interface WorkspaceModelViewerLabels {
  readonly loading: string;
  readonly unavailable: string;
}

export interface WorkspaceModelViewerProps {
  readonly src: string;
  readonly name: string;
  readonly labels: WorkspaceModelViewerLabels;
  readonly className?: string;
  readonly interactive?: boolean;
  readonly onViewer?: (viewer: WorkspaceModelViewerElement | null) => void;
  readonly onError?: () => void;
}

/** Authenticated, path-free glTF canvas. Optional decoders are self-hosted. */
export function WorkspaceModelViewer({
  src,
  name,
  labels,
  className,
  interactive = true,
  onViewer,
  onError
}: WorkspaceModelViewerProps): JSX.Element {
  return <ModelViewerSource key={src} src={src} name={name} labels={labels} className={className} interactive={interactive} onViewer={onViewer} onError={onError} />;
}

function ModelViewerSource({ src, name, labels, className, interactive, onViewer, onError }: WorkspaceModelViewerProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const [runtime, setRuntime] = useState<"loading" | "ready" | "error">("loading");
  const [viewer, setViewer] = useState<WorkspaceModelViewerElement | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let active = true;
    let element: WorkspaceModelViewerElement | undefined;
    const loaded = (): void => { if (active) setLoadState("ready"); };
    const failed = (): void => {
      if (!active) return;
      setLoadState("error");
      onErrorRef.current?.();
    };
    void ensureWorkspaceModelViewer().then(() => {
      const host = hostRef.current;
      if (!active || host === null) return;
      // The runtime registers in this realm. Adoption preserves the upgraded
      // custom element when the host belongs to a detached window's document.
      element = document.createElement("model-viewer") as WorkspaceModelViewerElement;
      element.addEventListener("load", loaded);
      element.addEventListener("error", failed);
      element.setAttribute("src", src);
      element.setAttribute("autoplay", "");
      element.setAttribute("interaction-prompt", "none");
      element.setAttribute("shadow-intensity", "0.8");
      element.setAttribute("exposure", "1");
      element.setAttribute("loading", "eager");
      element.setAttribute("reveal", "auto");
      host.prepend(element);
      setViewer(element);
      setRuntime("ready");
      if (element.loaded === true) loaded();
    }).catch(() => {
      if (!active) return;
      setRuntime("error");
      setLoadState("error");
      onErrorRef.current?.();
    });
    return () => {
      active = false;
      if (element === undefined) return;
      element.removeEventListener("load", loaded);
      element.removeEventListener("error", failed);
      element.removeAttribute("autoplay");
      element.removeAttribute("src");
      element.remove();
    };
  }, []);

  useEffect(() => {
    onViewer?.(viewer);
    return () => onViewer?.(null);
  }, [onViewer, viewer]);

  useEffect(() => {
    if (viewer === null) return;
    viewer.setAttribute("alt", name);
    viewer.setAttribute("aria-label", name);
    viewer.toggleAttribute("camera-controls", interactive !== false);
    viewer.tabIndex = interactive !== false ? 0 : -1;
  }, [interactive, name, viewer]);
  const failed = runtime === "error" || loadState === "error";

  return <div ref={hostRef} className={cx("workspace-model-viewer", failed && "is-error", className)} data-load-state={failed ? "error" : loadState}>
    {!failed && loadState !== "ready" && <div className="workspace-model-viewer__state" role="status"><Spinner label={labels.loading} /><span>{labels.loading}</span></div>}
    {failed && <div className="workspace-model-viewer__state is-error" role="alert"><Box aria-hidden="true" /><span>{labels.unavailable}</span></div>}
  </div>;
}
