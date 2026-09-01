import { useEffect, useRef, useState, type JSX } from "react";
import { File, RefreshCcw } from "lucide-react";

import type { Theme } from "../model.js";
import viewerUrl from "../vendor/drawio/viewer-static.min.js?url";
import { Button, Spinner } from "./ui.js";

interface DrawioGraphViewer {
  createViewerForElement(element: HTMLElement): unknown;
}

declare global {
  interface Window {
    GraphViewer?: DrawioGraphViewer;
  }
}

let viewerLoadPromise: Promise<DrawioGraphViewer> | undefined;

export interface WorkspaceDrawioPreviewProps {
  readonly workspaceId: string;
  readonly path: string;
  readonly name: string;
  readonly theme: Theme;
  readonly xml: string;
  readonly metadata: readonly string[];
  readonly loadingLabel: string;
  readonly unavailableLabel: string;
  readonly retryLabel: string;
  /** Re-reads the same workspace-relative file through Orchestrator before rendering again. */
  readonly onRetry: () => Promise<void>;
}

type DrawioRenderState = "loading" | "rendered" | "error";

/** Offline GraphViewer integration, isolated behind a lazy vendor chunk. */
export function WorkspaceDrawioPreview({
  workspaceId,
  path,
  name,
  theme,
  xml,
  metadata,
  loadingLabel,
  unavailableLabel,
  retryLabel,
  onRetry
}: WorkspaceDrawioPreviewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const sourceKey = `${workspaceId}\u0000${path}`;
  const currentSourceKeyRef = useRef(sourceKey);
  currentSourceKeyRef.current = sourceKey;
  const retryingRef = useRef(false);
  const retrySequenceRef = useRef(0);
  const [renderAttempt, setRenderAttempt] = useState(0);
  const [state, setState] = useState<DrawioRenderState>("loading");

  useEffect(() => () => {
    retrySequenceRef.current += 1;
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    let cancelled = false;
    container.replaceChildren();
    setState("loading");
    void loadDrawioViewer().then((viewer) => {
      if (cancelled) return;
      const host = document.createElement("div");
      host.className = "mxgraph";
      host.style.maxWidth = "100%";
      host.setAttribute("data-mxgraph", JSON.stringify({
        xml,
        highlight: "#0000ff",
        nav: true,
        resize: true,
        "dark-mode": theme === "system" ? "auto" : theme,
        "check-visible-state": false
      }));
      container.append(host);
      viewer.createViewerForElement(host);
      if (!cancelled) setState("rendered");
    }).catch(() => {
      if (!cancelled) setState("error");
    });
    return () => {
      cancelled = true;
      container.replaceChildren();
    };
  }, [renderAttempt, sourceKey, theme, xml]);

  const retry = async (): Promise<void> => {
    if (retryingRef.current) return;
    const requestedSourceKey = sourceKey;
    const sequence = retrySequenceRef.current + 1;
    retrySequenceRef.current = sequence;
    retryingRef.current = true;
    setState("loading");
    try {
      await onRetry();
      if (currentSourceKeyRef.current !== requestedSourceKey || retrySequenceRef.current !== sequence) return;
      setRenderAttempt((current) => current + 1);
    } catch {
      if (currentSourceKeyRef.current === requestedSourceKey && retrySequenceRef.current === sequence) setState("error");
    } finally {
      if (retrySequenceRef.current === sequence) retryingRef.current = false;
    }
  };

  if (state === "error") {
    return <WorkspaceDrawioUnavailable
      name={name}
      metadata={metadata}
      unavailableLabel={unavailableLabel}
      retryLabel={retryLabel}
      onRetry={() => { void retry(); }}
    />;
  }
  return <div className="workspace-drawio-preview" data-drawio-path={path}>
    <div className="workspace-drawio-preview__stage"><div ref={containerRef} /></div>
    {state === "loading" && <div className="workspace-drawio-preview__loading" role="status"><Spinner label={loadingLabel} /><span>{loadingLabel}</span></div>}
  </div>;
}

export function WorkspaceDrawioUnavailable({ name, metadata, unavailableLabel, retryLabel, onRetry }: {
  readonly name: string;
  readonly metadata: readonly string[];
  readonly unavailableLabel: string;
  readonly retryLabel: string;
  readonly onRetry: () => void;
}): JSX.Element {
  return <div className="workspace-drawio-preview__fallback" role="status">
    <span className="workspace-drawio-preview__file-icon" aria-hidden="true"><File /></span>
    <div className="workspace-drawio-preview__fallback-copy">
      <strong>{name}</strong>
      {metadata.length > 0 && <span className="workspace-drawio-preview__metadata">{metadata.join(" · ")}</span>}
      <p>{unavailableLabel}</p>
    </div>
    <Button tone="primary" className="workspace-drawio-preview__retry" onClick={onRetry}>
      <RefreshCcw aria-hidden="true" />{retryLabel}
    </Button>
  </div>;
}

function loadDrawioViewer(): Promise<DrawioGraphViewer> {
  if (window.GraphViewer !== undefined) return Promise.resolve(window.GraphViewer);
  if (viewerLoadPromise !== undefined) return viewerLoadPromise;
  viewerLoadPromise = new Promise<DrawioGraphViewer>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = viewerUrl;
    script.async = true;
    script.dataset.jokoDrawioViewer = "";
    script.addEventListener("load", () => {
      if (window.GraphViewer !== undefined) resolve(window.GraphViewer);
      else {
        viewerLoadPromise = undefined;
        reject(new Error("The diagrams.net viewer loaded without GraphViewer."));
      }
    }, { once: true });
    script.addEventListener("error", () => {
      viewerLoadPromise = undefined;
      reject(new Error("The diagrams.net viewer could not be loaded."));
    }, { once: true });
    document.head.append(script);
  });
  return viewerLoadPromise;
}
