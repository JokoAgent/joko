import { downloadArtifactUrl } from "../artifact-download.js";
import { Clipboard, FileText, Folder, FolderKanban, Globe2, Link2, MessageSquare, PanelRight } from "lucide-react";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { JSX, MouseEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { assertBrowserActionCurrent, WorkspaceHtmlExternalUnavailableError, type HttpLinkOpenOptions } from "../browser-action.js";
import { writeClipboardText } from "../clipboard-action.js";
import { useClipboardAction } from "./use-clipboard-action.js";
import { TimelineLinkMenu } from "./TimelineLinkMenu.js";
import type { ArtifactView, OperationApi, TimelineInputMentionRangeView, TimelineInputMentionView } from "../model.js";
import type { Translator } from "./types.js";
import { WorkspaceImageLightbox } from "./WorkspaceImageLightbox.js";
import { parseSentMessageReferences, resolveSentSessionMention, resolveSentWorkspaceMention, resolveTimelineReference, sentInputMentionSegments, type TimelineReferenceTarget } from "./timeline-references.js";
import "./timeline-references.css";

export const TimelineLinkSourceContext = createContext("");

export interface TimelineWorkspaceAsset {
  readonly release: () => void;
  readonly path: string;
  readonly name: string;
  readonly url: string;
  readonly mediaType?: string;
}

export interface TimelineReferenceActions {
  readonly ownerKey: string;
  readonly sessionId: string;
  readonly t: Translator;
  readonly sourceKey?: string;
  readonly workspaceId?: string;
  readonly onReadArtifact?: OperationApi["readSessionArtifact"];
  readonly renderArtifactPreview?: (artifact: ArtifactView, trigger: HTMLElement, onClose: () => void) => ReactNode;
  readonly onOpenHttpLink?: (url: string, options?: HttpLinkOpenOptions) => void | Promise<void>;
  readonly onOpenWorkspaceHtml?: (path: string, options?: HttpLinkOpenOptions) => void | Promise<void>;
  readonly onLoadWorkspaceAsset?: (path: string) => Promise<TimelineWorkspaceAsset>;
  readonly onWorkspaceImageToComposer?: (file: File) => void | Promise<void>;
}

export function SentMessageReferenceText({ text, inputMentions = [], mentionRanges = [], actions }: {
  readonly text: string;
  readonly inputMentions?: readonly TimelineInputMentionView[];
  readonly mentionRanges?: readonly TimelineInputMentionRangeView[];
  readonly actions: TimelineReferenceActions;
}): JSX.Element {
  const segments = useMemo(() => sentInputMentionSegments(text, inputMentions, mentionRanges), [text, inputMentions, mentionRanges]);
  return <span className="message-user__text">{segments.map((segment, index) => segment.kind === "mention"
    ? <SentInputMention key={`mention:${index}`} mention={segment.mention} actions={{ ...actions, sourceKey: actions.sourceKey ?? text }}>{segment.text}</SentInputMention>
    : parseSentMessageReferences(segment.text, actions.sessionId).map((reference, referenceIndex) => reference.kind === "text"
      ? <span key={`text:${index}:${referenceIndex}`}>{reference.text}</span>
      : <TimelineReferenceLink
        target={reference.target}
        actions={{ ...actions, sourceKey: text }}
        mention={reference.mention}
        key={`reference:${index}:${referenceIndex}`}
      >{reference.text}</TimelineReferenceLink>))}</span>;
}

export function SentMessageReferenceChips({ mentions, actions }: {
  readonly mentions: readonly TimelineInputMentionView[];
  readonly actions: TimelineReferenceActions;
}): JSX.Element | null {
  return mentions.length === 0 ? null : <span className="message-input-references" role="group" aria-label={actions.t("timeline.inputReferences")}>
    {mentions.map((mention, index) => <SentInputMention mention={mention} actions={actions} key={index}>
      {mention.displayText || actions.t("timeline.inputReferences")}
    </SentInputMention>)}
  </span>;
}

function SentInputMention({ mention, actions, children }: {
  readonly mention: TimelineInputMentionView;
  readonly actions: TimelineReferenceActions;
  readonly children: ReactNode;
}): JSX.Element {
  if (mention.kind === "artifact") return <TimelineArtifactMention mention={mention} actions={actions}>{children}</TimelineArtifactMention>;
  const target = mention.kind === "workspace"
    ? resolveSentWorkspaceMention(mention, actions.sessionId, actions.workspaceId)
    : mention.kind === "session"
      ? resolveSentSessionMention(mention, actions.sessionId)
      : undefined;
  if (target !== undefined) return <TimelineReferenceLink target={target} actions={actions} mention>{children}</TimelineReferenceLink>;
  return <span className="timeline-reference-chip is-mention is-unavailable" aria-disabled="true" title={actions.t("timeline.referenceUnavailable")}>
    {mention.kind === "session"
      ? <MessageSquare aria-hidden="true" />
      : mention.kind === "workspace" && mention.directory
        ? <Folder aria-hidden="true" />
        : <FileText aria-hidden="true" />}
    <span>{children}</span><small>{actions.t("timeline.referenceUnavailable")}</small>
  </span>;
}

function TimelineArtifactMention({ mention, actions, children }: {
  readonly mention: Extract<TimelineInputMentionView, { readonly kind: "artifact" }>;
  readonly actions: TimelineReferenceActions;
  readonly children: ReactNode;
}): JSX.Element {
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const [epoch, setEpoch] = useState(0);
  const ownerDocument = trigger?.ownerDocument;
  const sourceOwner = useMemo(() => ({}), [actions.ownerKey, actions.sessionId, actions.sourceKey, actions.onReadArtifact, mention.sourceSessionId, mention.artifactId, ownerDocument, epoch]);
  const scopeRef = useRef<AbortController | undefined>(undefined);
  const requestRef = useRef<AbortController | undefined>(undefined);
  const [state, setState] = useState<{ readonly owner: object; readonly status: "loading" | "error" | "ready"; readonly artifact?: ArtifactView }>();
  const current = state?.owner === sourceOwner ? state : undefined;
  const available = actions.onReadArtifact !== undefined && actions.renderArtifactPreview !== undefined;
  useLayoutEffect(() => {
    const scope = new AbortController(); scopeRef.current = scope;
    const retire = (): void => { scope.abort(); requestRef.current?.abort(); requestRef.current = undefined; setState(undefined); };
    const restore = (): void => { if (scope.signal.aborted) setEpoch((value) => value + 1); };
    ownerDocument?.defaultView?.addEventListener("pagehide", retire);
    ownerDocument?.defaultView?.addEventListener("pageshow", restore);
    return () => {
      retire();
      if (scopeRef.current === scope) scopeRef.current = undefined;
      ownerDocument?.defaultView?.removeEventListener("pagehide", retire);
      ownerDocument?.defaultView?.removeEventListener("pageshow", restore);
    };
  }, [sourceOwner, ownerDocument]);
  const open = (): void => {
    const scope = scopeRef.current;
    const read = actions.onReadArtifact;
    if (!available || read === undefined || scope === undefined || scope.signal.aborted || requestRef.current !== undefined || !trigger?.isConnected) return;
    const request = new AbortController(); requestRef.current = request;
    const signal = AbortSignal.any([scope.signal, request.signal]);
    const isCurrent = (): boolean => !signal.aborted && scopeRef.current === scope && requestRef.current === request;
    setState({ owner: sourceOwner, status: "loading" });
    void read(mention.sourceSessionId, mention.artifactId, signal).then((artifact) => {
      if (!isCurrent()) return;
      if (artifact.id !== mention.artifactId || artifact.blobId === "") throw new Error("The referenced Artifact is unavailable.");
      setState({ owner: sourceOwner, status: "ready", artifact });
    }).catch(() => { if (isCurrent()) setState({ owner: sourceOwner, status: "error" }); })
      .finally(() => { if (isCurrent()) requestRef.current = undefined; });
  };
  return <>
    <button ref={setTrigger} type="button" className="timeline-reference-chip is-mention" disabled={!available}
      aria-busy={current?.status === "loading"} aria-disabled={!available || current?.status === "loading"}
      title={mention.displayText} onClick={open}>
      <FileText aria-hidden="true" /><span>{children}</span>
      {current?.status === "loading" && <small role="status">{actions.t("common.loading")}</small>}
      {(!available || current?.status === "error") && <small role="status">{actions.t("timeline.referenceUnavailable")}</small>}
    </button>
    {current?.status === "ready" && current.artifact !== undefined && trigger !== null
      && actions.renderArtifactPreview?.(current.artifact, trigger, () => setState(undefined))}
  </>;
}

export function TimelineMarkdownLink({ href, children, actions, anchorProps }: {
  readonly href?: string;
  readonly children: ReactNode;
  readonly actions: TimelineReferenceActions;
  readonly anchorProps?: Omit<JSX.IntrinsicElements["a"], "children" | "href">;
}): JSX.Element {
  const target = href === undefined ? undefined : resolveTimelineReference(href, actions.sessionId);
  if (target === undefined) return <span>{children}</span>;
  return <TimelineReferenceLink
    target={target}
    actions={actions}
    anchorProps={anchorProps}
  >{children}</TimelineReferenceLink>;
}

export function TimelineMarkdownImage({ src, alt, actions, t }: {
  readonly src?: string;
  readonly alt?: string;
  readonly actions: TimelineReferenceActions;
  readonly t: Translator;
}): JSX.Element {
  const target = src === undefined ? undefined : resolveTimelineReference(src, actions.sessionId);
  if (target?.kind === "workspace" && !target.directory && actions.onLoadWorkspaceAsset !== undefined) {
    return <TimelineWorkspaceImage key={JSON.stringify([actions.ownerKey, target.path])} path={target.path} alt={alt} actions={actions} t={t} />;
  }
  if (target?.kind === "external") {
    return <TimelineReferenceLink target={target} actions={actions} className="markdown-image-link">
      {t("timeline.externalImageLink")}{alt === undefined || alt.length === 0 ? "" : `: ${alt}`}
    </TimelineReferenceLink>;
  }
  return <span className="markdown-image-blocked">[{t("timeline.externalImageBlocked")}{alt === undefined || alt.length === 0 ? "" : `: ${alt}`}]</span>;
}

function TimelineReferenceLink({ target, actions, mention = false, anchorProps, className, children }: {
  readonly target: TimelineReferenceTarget;
  readonly actions: TimelineReferenceActions;
  readonly mention?: boolean;
  readonly anchorProps?: Omit<JSX.IntrinsicElements["a"], "children" | "href">;
  readonly className?: string;
  readonly children: ReactNode;
}): JSX.Element {
  const external = target.kind === "external";
  const html = target.kind === "workspace" && !target.directory && /\.html?$/iu.test(target.path);
  const canOpen = html ? actions.onOpenWorkspaceHtml !== undefined : actions.onOpenHttpLink !== undefined;
  const [trigger, setTrigger] = useState<HTMLAnchorElement | null>(null);
  const [menu, setMenu] = useState<{ readonly x: number; readonly y: number }>();
  const [opening, setOpening] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const [externalUnavailable, setExternalUnavailable] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const scopeRef = useRef<AbortController | undefined>(undefined);
  const requestRef = useRef<AbortController | undefined>(undefined);
  const ownerDocument = trigger?.ownerDocument;
  const markdownSource = useContext(TimelineLinkSourceContext);
  const sourceKey = actions.sourceKey ?? markdownSource;
  const copy = useClipboardAction({ ownerKey: JSON.stringify([actions.ownerKey, actions.sessionId]),
    sourceKey: JSON.stringify([target.href, sourceKey]), ownerDocument });
  useLayoutEffect(() => {
    const scope = new AbortController();
    scopeRef.current = scope;
    setMenu(undefined); setOpening(false); setOpenFailed(false);
    const retire = (): void => {
      scope.abort(); requestRef.current?.abort(); requestRef.current = undefined;
      setMenu(undefined); setOpening(false); setOpenFailed(false);
    };
    const restore = (): void => { if (scope.signal.aborted) setEpoch((value) => value + 1); };
    ownerDocument?.defaultView?.addEventListener("pagehide", retire);
    ownerDocument?.defaultView?.addEventListener("pageshow", restore);
    return () => {
      retire();
      if (scopeRef.current === scope) scopeRef.current = undefined;
      ownerDocument?.defaultView?.removeEventListener("pagehide", retire);
      ownerDocument?.defaultView?.removeEventListener("pageshow", restore);
    };
  }, [actions.ownerKey, actions.sessionId, sourceKey, target.href, ownerDocument, epoch]);
  const close = (restoreFocus: boolean): void => {
    setMenu(undefined);
    copy.cancel(); requestRef.current?.abort(); requestRef.current = undefined; setOpening(false);
    if (restoreFocus && !scopeRef.current?.signal.aborted && trigger?.isConnected && trigger.ownerDocument === ownerDocument) trigger.focus({ preventScroll: true });
  };
  const openLink = (options: HttpLinkOpenOptions): void => {
    const scope = scopeRef.current;
    if (scope === undefined || scope.signal.aborted || requestRef.current !== undefined || copy.pending || !trigger?.isConnected || ownerDocument === undefined || trigger.ownerDocument !== ownerDocument) return;
    const request = new AbortController(); requestRef.current = request;
    const action = { ownerDocument, signal: AbortSignal.any([scope.signal, request.signal]) };
    const current = (): boolean => !action.signal.aborted && scopeRef.current === scope && requestRef.current === request;
    setOpening(true); setOpenFailed(false); setExternalUnavailable(false);
    void (async () => {
      try {
        assertBrowserActionCurrent(action);
        if (html && target.kind === "workspace") await actions.onOpenWorkspaceHtml?.(target.path, { ...options, action });
        else await actions.onOpenHttpLink?.(target.href, { ...options, action });
        if (current()) { setMenu(undefined); trigger.focus({ preventScroll: true }); }
      } catch (error) { if (current()) { setOpenFailed(true); setExternalUnavailable(error instanceof WorkspaceHtmlExternalUnavailableError); } }
      finally { if (current()) { requestRef.current = undefined; setOpening(false); } }
    })();
  };
  const open = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (event.button !== 0) return;
    if (external || (html && canOpen)) {
      if (!canOpen) return;
      event.preventDefault();
      openLink({ forceExternal: event.metaKey || event.ctrlKey });
      return;
    }
    event.preventDefault();
    const ownerWindow = event.currentTarget.ownerDocument.defaultView;
    if (ownerWindow !== null) ownerWindow.location.hash = target.href;
  };
  const icon = target.kind === "workspace"
    ? target.directory ? <Folder aria-hidden="true" /> : <FileText aria-hidden="true" />
    : target.kind === "session"
      ? <MessageSquare aria-hidden="true" />
      : target.kind === "project"
        ? <FolderKanban aria-hidden="true" />
        : <Link2 aria-hidden="true" />;
  return <><a
    {...anchorProps}
    ref={setTrigger}
    className={[className, !external && "timeline-reference-chip", mention && "is-mention"].filter(Boolean).join(" ") || undefined}
    href={target.href}
    aria-busy={opening || copy.pending}
    {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
    onClick={open}
    onKeyDown={(event) => {
      if (event.nativeEvent.isComposing) return;
      if ((target.kind === "workspace" || external) && (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey))) {
        event.preventDefault();
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        setMenu({ x: rect.left, y: rect.bottom });
      } else anchorProps?.onKeyDown?.(event);
    }}
    onContextMenu={target.kind !== "workspace" && !external ? undefined : (event) => {
      event.preventDefault();
      event.stopPropagation();
      setMenu({ x: event.clientX, y: event.clientY });
    }}
  >{!external && icon}{children}</a>
    {menu !== undefined && trigger !== null && <TimelineLinkMenu trigger={trigger} position={menu}
      label={actions.t(external ? "timeline.linkOpenMenu" : "workspace.fileActions")} onClose={close}>
      {(external || html) && <>
        <button type="button" role="menuitem" disabled={opening || copy.pending || !canOpen} onClick={() => openLink({ forceSidebar: true })}><PanelRight aria-hidden="true" />{actions.t("timeline.openInSidebarBrowser")}</button>
        <button type="button" role="menuitem" disabled={opening || copy.pending || !canOpen} onClick={() => openLink({ forceExternal: true })}><Globe2 aria-hidden="true" />{actions.t(html ? "timeline.openInManagedBrowser" : "timeline.openInDefaultBrowser")}</button>
        <span role="separator" />
      </>}
      <button type="button" role="menuitem" disabled={opening || copy.pending} onClick={() => {
        if (requestRef.current !== undefined || scopeRef.current?.signal.aborted) return;
        const value = target.kind === "workspace" ? `${target.path}${target.line === undefined ? "" : `:${target.line}${target.column === undefined ? "" : `:${target.column}`}`}` : target.href;
        copy.run(trigger.ownerDocument, (context) => writeClipboardText(value, context));
      }}><Clipboard aria-hidden="true" />{actions.t(external ? "timeline.copyUrl" : "workspace.copyRelativePath")}</button>
      {(copy.state !== "idle" || opening || openFailed) && <span role="status" aria-live="polite">{actions.t(
        opening ? "timeline.linkOpening" : openFailed ? externalUnavailable ? "timeline.htmlExternalUnavailable" : "timeline.linkOpenFailed" : copy.pending ? "timeline.linkCopying"
          : copy.state === "failed" ? "timeline.linkCopyFailed" : external ? "timeline.linkCopied" : "workspace.pathCopied"
      )}</span>}
    </TimelineLinkMenu>}
    {menu === undefined && (opening || openFailed) && ownerDocument !== undefined && createPortal(
      <span className="timeline-link-feedback" role="status" aria-live="polite">{actions.t(opening ? "timeline.linkOpening" : externalUnavailable ? "timeline.htmlExternalUnavailable" : "timeline.linkOpenFailed")}</span>, ownerDocument.body)}
  </>;
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
    let acquired: TimelineWorkspaceAsset | undefined;
    setState({ status: "loading" });
    void loaderRef.current?.(path).then(
      (asset) => {
        if (!active) { asset.release(); return; }
        acquired = asset;
        setState({ status: "ready", asset });
      },
      () => { if (active) setState({ status: "error" }); }
    );
    return () => { active = false; acquired?.release(); };
  }, [path]);
  if (state.status === "loading") return <span className="timeline-workspace-image is-loading" role="status">{t("workspace.loadingPreview")}</span>;
  if (state.status === "error") return <span className="markdown-image-blocked">[{t("workspace.imageUnavailable")}{alt === undefined || alt.length === 0 ? "" : `: ${alt}`}]</span>;
  const asset = state.asset;
  return <>
    <button ref={triggerRef} type="button" className="timeline-workspace-image" aria-label={`${t("workspace.imageOpen")}: ${asset.name}`} onClick={() => setOpen(true)}>
      <img src={asset.url} alt={alt ?? asset.name} loading="lazy" />
    </button>
    {open && <WorkspaceImageLightbox
      ownerKey={JSON.stringify([actions.ownerKey, actions.sessionId, path])}
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
      onDownload={(context) => downloadArtifactUrl(asset.url, asset.name, context)}
      onSendToChat={actions.onWorkspaceImageToComposer}
    />}
  </>;
}
