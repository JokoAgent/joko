import { Check, Code2, Copy, Expand, Eye } from "lucide-react";
import { memo, useEffect, useId, useMemo, useRef, useState, type JSX } from "react";

import { WorkspaceMermaidLightbox, type WorkspaceMermaidHostLabels } from "./WorkspaceMermaidHosts.js";
import { copyWorkspaceMermaid } from "./workspace-markdown-mermaid.js";
import { repairTimelineMermaidSource } from "./timeline-mermaid-autofix.js";
import type { Translator } from "./types.js";
import { IconButton } from "./ui.js";

type MermaidApi = typeof import("mermaid")["default"];
let mermaidModule: Promise<MermaidApi> | undefined;

function loadMermaid(): Promise<MermaidApi> {
  mermaidModule ??= import("mermaid").then((module) => module.default);
  return mermaidModule;
}

function darkMermaidTheme(): boolean {
  const theme = document.documentElement.dataset.theme;
  return theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
}

function useMermaidTheme(): "dark" | "default" {
  const read = (): "dark" | "default" => darkMermaidTheme() ? "dark" : "default";
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    const update = (): void => setTheme((current) => {
      const next = read();
      return next === current ? current : next;
    });
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", update);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", update);
    };
  }, []);
  return theme;
}

export const TimelineMermaidBlock = memo(function TimelineMermaidBlock({ source, t }: {
  readonly source: string;
  readonly t: Translator;
}): JSX.Element {
  const reactId = useId().replace(/[^A-Za-z0-9]/gu, "");
  const theme = useMermaidTheme();
  const [svg, setSvg] = useState<string>();
  const [error, setError] = useState<string>();
  const [showSource, setShowSource] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const cardRef = useRef<HTMLDivElement>(null);
  const copyTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const trimmed = source.trim();
    if (trimmed === "") {
      setSvg(undefined);
      setError(undefined);
      return;
    }
    void loadMermaid().then(async (api) => {
      api.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        fontFamily: "inherit",
        theme,
        flowchart: { useMaxWidth: false },
        sequence: { useMaxWidth: false },
        class: { useMaxWidth: false },
        state: { useMaxWidth: false },
        er: { useMaxWidth: false },
        gantt: { useMaxWidth: false },
        journey: { useMaxWidth: false },
        pie: { useMaxWidth: false }
      });
      const attempt = async (candidate: string, suffix: string): Promise<string> => {
        await api.parse(candidate);
        return (await api.render(`joko-chat-mermaid-${reactId}-${suffix}`, candidate)).svg;
      };
      try {
        const rendered = await attempt(trimmed, "source");
        if (!cancelled) {
          setSvg(rendered);
          setError(undefined);
        }
      } catch (cause) {
        const repaired = repairTimelineMermaidSource(trimmed);
        if (repaired !== trimmed) {
          try {
            const rendered = await attempt(repaired, "repaired");
            if (!cancelled) {
              setSvg(rendered);
              setError(undefined);
            }
            return;
          } catch {
            // Preserve the original parser error for a source-faithful fallback.
          }
        }
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { cancelled = true; };
  }, [reactId, source, theme]);

  useEffect(() => () => {
    if (copyTimerRef.current !== undefined) window.clearTimeout(copyTimerRef.current);
  }, []);

  const labels = useMemo<WorkspaceMermaidHostLabels>(() => ({
    editTitle: t("workspace.mermaidEditTitle"),
    source: t("workspace.mermaidSource"),
    cancel: t("common.cancel"),
    apply: t("workspace.mermaidApply"),
    targetMissing: t("workspace.mermaidTargetMissing"),
    zoomOut: t("workspace.mermaidZoomOut"),
    zoomIn: t("workspace.mermaidZoomIn"),
    copy: t("timeline.mermaidCopy"),
    copied: t("timeline.mermaidCopied"),
    copyFailed: t("timeline.mermaidCopyFailed"),
    close: t("common.close")
  }), [t]);
  const sourceView = showSource || svg === undefined && error !== undefined;
  const settleCopy = (next: "copied" | "failed"): void => {
    setCopyState(next);
    if (copyTimerRef.current !== undefined) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopyState("idle"), 1_500);
  };
  const copy = (): void => {
    const card = cardRef.current;
    if (svg === undefined || card === null) {
      void navigator.clipboard.writeText(source).then(() => settleCopy("copied")).catch(() => settleCopy("failed"));
      return;
    }
    void copyWorkspaceMermaid(svg, source, card).then(() => settleCopy("copied")).catch(() => settleCopy("failed"));
  };

  return <div className="timeline-mermaid">
    {sourceView ? <pre className="timeline-mermaid__source"><code className="language-mermaid">{source}</code></pre> : svg !== undefined ? (
      <div
        ref={cardRef}
        className="timeline-mermaid__diagram"
        role="button"
        tabIndex={0}
        aria-label={t("timeline.mermaidZoom")}
        title={t("timeline.mermaidZoom")}
        onClick={() => setLightboxOpen(true)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          setLightboxOpen(true);
        }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    ) : <pre className="timeline-mermaid__source is-loading"><code className="language-mermaid">{source}</code></pre>}
    {error !== undefined && svg === undefined && <p className="timeline-mermaid__error" title={error}>{t("timeline.mermaidRenderFailed")}</p>}
    <div className="timeline-mermaid__toolbar">
      {svg !== undefined && !sourceView && <IconButton label={t("timeline.mermaidZoom")} onClick={() => setLightboxOpen(true)}><Expand aria-hidden="true" /></IconButton>}
      {svg !== undefined && <IconButton label={sourceView ? t("timeline.mermaidViewDiagram") : t("timeline.mermaidViewSource")} onClick={() => setShowSource((value) => !value)}>{sourceView ? <Eye aria-hidden="true" /> : <Code2 aria-hidden="true" />}</IconButton>}
      <IconButton label={copyState === "copied" ? t("timeline.mermaidCopied") : copyState === "failed" ? t("timeline.mermaidCopyFailed") : t("timeline.mermaidCopy")} onClick={copy}>{copyState === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}</IconButton>
    </div>
    {copyState === "failed" && <span className="sr-only" role="alert">{t("timeline.mermaidCopyFailed")}</span>}
    {lightboxOpen && svg !== undefined && <WorkspaceMermaidLightbox detail={{ svg, source }} labels={labels} onClose={() => setLightboxOpen(false)} />}
  </div>;
});
