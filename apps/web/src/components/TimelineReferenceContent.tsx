import { FileText, Folder, FolderKanban, Link2, MessageSquare } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX, MouseEvent, ReactNode } from "react";
import type { Translator } from "./types.js";
import { WorkspaceImageLightbox } from "./WorkspaceImageLightbox.js";
import { parseSentMessageReferences, resolveTimelineReference, type TimelineReferenceTarget } from "./timeline-references.js";

export interface TimelineWorkspaceAsset {
  readonly path: string;
  readonly name: string;
  readonly url: string;
  readonly mediaType?: string;
}

export interface TimelineReferenceActions {
  readonly sessionId: string;
  readonly onOpenHttpLink?: (url: string, options?: { readonly forceExternal?: boolean; readonly forceSidebar?: boolean }) => void;
  readonly onLoadWorkspaceAsset?: (path: string) => Promise<TimelineWorkspaceAsset>;
  readonly onWorkspaceImageToComposer?: (file: File) => void | Promise<void>;
}

export function SentMessageReferenceText({ text, actions }: {
  readonly text: string;
  readonly actions: TimelineReferenceActions;
}): JSX.Element {
  const segments = useMemo(() => parseSentMessageReferences(text, actions.sessionId), [actions.sessionId, text]);
  return <span className="message-user__text">{segments.map((segment, index) => segment.kind === "text"
    ? <span key={`text:${index}`}>{segment.text}</span>
    : <TimelineReferenceLink
        target={segment.target}
        actions={actions}
        mention={segment.mention}
        key={`reference:${index}`}
      >{segment.text}</TimelineReferenceLink>)}</span>;
}

export function TimelineMarkdownLink({ href, children, actions, onOpenHttpLinkMenu, anchorProps }: {
  readonly href?: string;
  readonly children: ReactNode;
  readonly actions: TimelineReferenceActions;
  readonly onOpenHttpLinkMenu?: (url: string, x: number, y: number) => void;
  readonly anchorProps?: Omit<JSX.IntrinsicElements["a"], "children" | "href">;
}): JSX.Element {
  const target = href === undefined ? undefined : resolveTimelineReference(href, actions.sessionId);
  if (target === undefined) return <span>{children}</span>;
  return <TimelineReferenceLink
    target={target}
    actions={actions}
    onOpenHttpLinkMenu={onOpenHttpLinkMenu}
    anchorProps={anchorProps}
  >{children}</TimelineReferenceLink>;
}

export function TimelineMarkdownImage({ src, alt, actions, t, onOpenHttpLinkMenu }: {
  readonly src?: string;
  readonly alt?: string;
  readonly actions: TimelineReferenceActions;
  readonly t: Translator;
  readonly onOpenHttpLinkMenu?: (url: string, x: number, y: number) => void;
}): JSX.Element {
  const target = src === undefined ? undefined : resolveTimelineReference(src, actions.sessionId);
  if (target?.kind === "workspace" && !target.directory && actions.onLoadWorkspaceAsset !== undefined) {
    return <TimelineWorkspaceImage path={target.path} alt={alt} actions={actions} t={t} />;
  }
  if (target?.kind === "external") {
    return <TimelineReferenceLink target={target} actions={actions} onOpenHttpLinkMenu={onOpenHttpLinkMenu} className="markdown-image-link">
      {t("timeline.externalImageLink")}{alt === undefined || alt.length === 0 ? "" : `: ${alt}`}
    </TimelineReferenceLink>;
  }
  return <span className="markdown-image-blocked">[{t("timeline.externalImageBlocked")}{alt === undefined || alt.length === 0 ? "" : `: ${alt}`}]</span>;
}

function TimelineReferenceLink({ target, actions, mention = false, onOpenHttpLinkMenu, anchorProps, className, children }: {
  readonly target: TimelineReferenceTarget;
  readonly actions: TimelineReferenceActions;
  readonly mention?: boolean;
  readonly onOpenHttpLinkMenu?: (url: string, x: number, y: number) => void;
  readonly anchorProps?: Omit<JSX.IntrinsicElements["a"], "children" | "href">;
  readonly className?: string;
  readonly children: ReactNode;
}): JSX.Element {
  const external = target.kind === "external";
  const open = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (event.button !== 0) return;
    if (external) {
      if (actions.onOpenHttpLink === undefined) return;
      event.preventDefault();
      actions.onOpenHttpLink(target.href, { forceExternal: event.metaKey || event.ctrlKey });
      return;
    }
    event.preventDefault();
    window.location.hash = target.href;
  };
  const icon = target.kind === "workspace"
    ? target.directory ? <Folder aria-hidden="true" /> : <FileText aria-hidden="true" />
    : target.kind === "session"
      ? <MessageSquare aria-hidden="true" />
      : target.kind === "project"
        ? <FolderKanban aria-hidden="true" />
        : <Link2 aria-hidden="true" />;
  return <a
    {...anchorProps}
    className={[className, !external && "timeline-reference-chip", mention && "is-mention"].filter(Boolean).join(" ") || undefined}
    href={target.href}
    {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
    onClick={open}
    onContextMenu={!external || onOpenHttpLinkMenu === undefined ? undefined : (event) => {
      event.preventDefault();
      event.stopPropagation();
      onOpenHttpLinkMenu(target.href, event.clientX, event.clientY);
    }}
  >{!external && icon}{children}</a>;
}

function TimelineWorkspaceImage({ path, alt, actions, t }: {
  readonly path: string;
  readonly alt?: string;
  readonly actions: TimelineReferenceActions;
  readonly t: Translator;
}): JSX.Element {
  const [state, setState] = useState<{ readonly status: "loading" } | { readonly status: "error" } | { readonly status: "ready"; readonly asset: TimelineWorkspaceAsset }>({ status: "loading" });
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const loaderRef = useRef(actions.onLoadWorkspaceAsset);
  loaderRef.current = actions.onLoadWorkspaceAsset;
  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    void loaderRef.current?.(path).then(
      (asset) => { if (active) setState({ status: "ready", asset }); },
      () => { if (active) setState({ status: "error" }); }
    );
    return () => { active = false; };
  }, [path]);
  if (state.status === "loading") return <span className="timeline-workspace-image is-loading" role="status">{t("workspace.loadingPreview")}</span>;
  if (state.status === "error") return <span className="markdown-image-blocked">[{t("workspace.imageUnavailable")}{alt === undefined || alt.length === 0 ? "" : `: ${alt}`}]</span>;
  const asset = state.asset;
  return <>
    <button ref={triggerRef} type="button" className="timeline-workspace-image" aria-label={`${t("workspace.imageOpen")}: ${asset.name}`} onClick={() => setOpen(true)}>
      <img src={asset.url} alt={alt ?? asset.name} loading="lazy" />
    </button>
    {open && <WorkspaceImageLightbox
      src={asset.url}
      name={asset.name}
      mediaType={asset.mediaType}
      labels={{
        close: t("common.close"),
        copy: t("workspace.imageCopy"),
        copied: t("workspace.imageCopied"),
        copyFailed: t("workspace.imageCopyFailed"),
        saveAs: t("workspace.imageSaveAs"),
        saveFailed: t("workspace.imageSaveFailed"),
        annotate: t("workspace.imageAnnotate"),
        discardAnnotation: t("workspace.imageDiscardAnnotation"),
        undoAnnotation: t("workspace.imageUndoAnnotation"),
        sendToChat: t("workspace.imageSendToChat"),
        sendFailed: t("workspace.imageSendFailed")
      }}
      returnFocus={triggerRef.current}
      onClose={() => setOpen(false)}
      onDownload={() => downloadWorkspaceAsset(asset)}
      onSendToChat={actions.onWorkspaceImageToComposer}
    />}
  </>;
}

function downloadWorkspaceAsset(asset: TimelineWorkspaceAsset): void {
  const anchor = document.createElement("a");
  anchor.href = asset.url;
  anchor.download = asset.name;
  anchor.rel = "noreferrer";
  anchor.click();
}
