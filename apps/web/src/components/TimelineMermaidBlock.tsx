import { Check, Code2, Copy, Expand, Eye } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from "react";
import { writeClipboardText } from "../clipboard-action.js";
import { WorkspaceMermaidLightbox, type WorkspaceMermaidHostLabels } from "./WorkspaceMermaidHosts.js";
import type { WorkspaceMermaidOpenDetail } from "./workspace-markdown-mermaid.js";
import { renderMermaid } from "./mermaid-render.js";
import { copyMermaid } from "./mermaid-image-export.js";
import { generatedImageAnnotationLabels } from "./GeneratedImageAnnotationButton.js";
import { useMermaidTheme } from "./use-mermaid-theme.js";
import { useClipboardAction } from "./use-clipboard-action.js";
import { repairTimelineMermaidSource } from "./timeline-mermaid-autofix.js";
import type { Translator } from "./types.js";
import { IconButton } from "./ui.js";

export const TimelineMermaidBlock = memo(function TimelineMermaidBlock({ ownerKey, source, onSendToChat, t }: {
  readonly ownerKey: string;
  readonly source: string;
  readonly onSendToChat?: (file: File) => void | Promise<void>;
  readonly t: Translator;
}): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [ownerDocument, setOwnerDocument] = useState<Document>();
  const bindRoot = useCallback((node: HTMLDivElement | null): void => { rootRef.current = node; setOwnerDocument(node?.ownerDocument); }, []);
  const theme = useMermaidTheme(ownerDocument);
  const [pageEpoch, setPageEpoch] = useState(0);
  const scope = useMemo(() => ({ request: undefined as AbortController | undefined }), [ownerKey, source, theme, ownerDocument, pageEpoch]);
  const scopeRef = useRef<object | undefined>(undefined);
  const [result, setResult] = useState<{ readonly scope: object; readonly svg?: string; readonly error?: string }>();
  const [sourceViewScope, setSourceViewScope] = useState<object>();
  const [opened, setOpened] = useState<{ readonly scope: object; readonly detail: WorkspaceMermaidOpenDetail }>();
  const copy = useClipboardAction({ ownerKey, sourceKey: JSON.stringify([source, theme, result?.scope === scope ? result.svg : undefined]), ownerDocument, connectionOwner: scope });
  useLayoutEffect(() => {
    const request = new AbortController();
    scope.request = request;
    scopeRef.current = scope;
    const retire = (): void => { request.abort(); setOpened(undefined); };
    const resume = (): void => { if (request.signal.aborted) setPageEpoch((value) => value + 1); };
    ownerDocument?.defaultView?.addEventListener("pagehide", retire);
    ownerDocument?.defaultView?.addEventListener("pageshow", resume);
    return () => {
      if (scopeRef.current === scope) scopeRef.current = undefined;
      request.abort();
      ownerDocument?.defaultView?.removeEventListener("pagehide", retire);
      ownerDocument?.defaultView?.removeEventListener("pageshow", resume);
    };
  }, [scope, ownerDocument]);
  useEffect(() => {
    const request = scope.request;
    if (ownerDocument === undefined || request === undefined || source.trim() === "") return;
    const context = { ownerDocument, signal: request.signal };
    void (async () => {
      try {
        let svg: string;
        try { svg = await renderMermaid(source.trim(), theme, context); }
        catch (cause) {
          context.signal.throwIfAborted();
          const repaired = repairTimelineMermaidSource(source.trim());
          if (repaired === source.trim()) throw cause;
          try { svg = await renderMermaid(repaired, theme, context); }
          catch { throw cause; }
        }
        if (scopeRef.current === scope && !context.signal.aborted) setResult({ scope, svg });
      } catch (cause) {
        if (scopeRef.current === scope && !context.signal.aborted) setResult({ scope, error: cause instanceof Error ? cause.message : String(cause) });
      }
    })();
  }, [scope, source, theme, ownerDocument]);
  const svg = result?.scope === scope ? result.svg : undefined;
  const error = result?.scope === scope ? result.error : undefined;
  const sourceView = sourceViewScope === scope || svg === undefined && error !== undefined;
  const open = (trigger: HTMLElement): void => {
    const request = scope.request;
    if (svg === undefined || request === undefined || ownerDocument === undefined || trigger.ownerDocument !== ownerDocument || scopeRef.current !== scope || request.signal.aborted) return;
    setOpened({ scope, detail: { svg, source, returnFocus: trigger, signal: request.signal,
      isCurrent: () => scopeRef.current === scope && scope.request === request && !request.signal.aborted && rootRef.current?.isConnected === true && rootRef.current.ownerDocument === ownerDocument
    } });
  };
  const labels = useMemo<WorkspaceMermaidHostLabels>(() => ({
    editTitle: t("workspace.mermaidEditTitle"), source: t("workspace.mermaidSource"), cancel: t("common.cancel"),
    apply: t("workspace.mermaidApply"), targetMissing: t("workspace.mermaidTargetMissing"), zoomOut: t("workspace.mermaidZoomOut"),
    zoomIn: t("workspace.mermaidZoomIn"), copy: t("timeline.mermaidCopy"), copied: t("timeline.mermaidCopied"),
    copyFailed: t("timeline.mermaidCopyFailed"), close: t("common.close")
  }), [t]);
  const copyLabel = copy.state === "copied" ? labels.copied : copy.state === "failed" ? labels.copyFailed : labels.copy;
  return <div ref={bindRoot} className="timeline-mermaid">
    {sourceView ? <pre className="timeline-mermaid__source"><code className="language-mermaid">{source}</code></pre> : svg !== undefined ? (
      <div ref={cardRef} className="timeline-mermaid__diagram" role="button" tabIndex={0} aria-label={t("timeline.mermaidZoom")} title={t("timeline.mermaidZoom")}
        onClick={(event) => open(event.currentTarget)}
        onKeyDown={(event) => {
          if (event.defaultPrevented || event.nativeEvent.isComposing || event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault(); open(event.currentTarget);
        }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    ) : <pre className="timeline-mermaid__source is-loading"><code className="language-mermaid">{source}</code></pre>}
    {error !== undefined && <p className="timeline-mermaid__error" title={error}>{t("timeline.mermaidRenderFailed")}</p>}
    <div className="timeline-mermaid__toolbar">
      {svg !== undefined && !sourceView && <IconButton label={t("timeline.mermaidZoom")} onClick={(event) => open(event.currentTarget)}><Expand aria-hidden="true" /></IconButton>}
      {svg !== undefined && <IconButton label={sourceView ? t("timeline.mermaidViewDiagram") : t("timeline.mermaidViewSource")} onClick={() => setSourceViewScope(sourceView ? undefined : scope)}>{sourceView ? <Eye aria-hidden="true" /> : <Code2 aria-hidden="true" />}</IconButton>}
      <IconButton label={copyLabel} aria-busy={copy.pending} aria-disabled={copy.pending} onClick={(event) => {
        const card = cardRef.current ?? rootRef.current;
        copy.run(event.currentTarget.ownerDocument, (context) => svg === undefined || card === null
          ? writeClipboardText(source, context) : copyMermaid(svg, source, card, context));
      }}>{copy.state === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}</IconButton>
    </div>
    {copy.state === "failed" && <span className="sr-only" role="alert">{copyLabel}</span>}
    {opened?.scope === scope && <WorkspaceMermaidLightbox ownerKey={ownerKey} detail={opened.detail} labels={labels}
      annotationLabels={generatedImageAnnotationLabels(t)} onSendToChat={onSendToChat} onClose={() => setOpened(undefined)} />}
  </div>;
});
