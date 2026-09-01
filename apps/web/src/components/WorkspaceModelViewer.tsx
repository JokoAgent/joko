import { Box } from "lucide-react";
import { createElement, useCallback, useEffect, useState, type JSX } from "react";

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
  const [runtime, setRuntime] = useState<"loading" | "ready" | "error">("loading");
  const [viewer, setViewer] = useState<WorkspaceModelViewerElement | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let active = true;
    setRuntime("loading");
    void ensureWorkspaceModelViewer().then(() => {
      if (active) setRuntime("ready");
    }, () => {
      if (!active) return;
      setRuntime("error");
      setLoadState("error");
      onError?.();
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    onViewer?.(viewer);
    return () => onViewer?.(null);
  }, [onViewer, viewer]);

  useEffect(() => {
    if (viewer === null) return;
    setLoadState(viewer.loaded === true ? "ready" : "loading");
    const loaded = (): void => setLoadState("ready");
    const failed = (): void => {
      setLoadState("error");
      onError?.();
    };
    viewer.addEventListener("load", loaded);
    viewer.addEventListener("error", failed);
    return () => {
      viewer.removeEventListener("load", loaded);
      viewer.removeEventListener("error", failed);
    };
  }, [onError, src, viewer]);

  const captureViewer = useCallback((element: HTMLElement | null): void => {
    setViewer(element as WorkspaceModelViewerElement | null);
  }, []);
  const failed = runtime === "error" || loadState === "error";

  return <div className={cx("workspace-model-viewer", failed && "is-error", className)} data-load-state={failed ? "error" : loadState}>
    {runtime === "ready" && createElement("model-viewer", {
      ref: captureViewer,
      src,
      alt: name,
      autoplay: true,
      "camera-controls": interactive,
      "interaction-prompt": "none",
      "shadow-intensity": "0.8",
      exposure: "1",
      loading: "eager",
      reveal: "auto",
      tabIndex: interactive ? 0 : -1,
      "aria-label": name
    })}
    {!failed && loadState !== "ready" && <div className="workspace-model-viewer__state" role="status"><Spinner label={labels.loading} /><span>{labels.loading}</span></div>}
    {failed && <div className="workspace-model-viewer__state is-error" role="alert"><Box aria-hidden="true" /><span>{labels.unavailable}</span></div>}
  </div>;
}
