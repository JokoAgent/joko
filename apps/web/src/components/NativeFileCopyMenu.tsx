import { AppWindow, ChevronRight, Clipboard, Ellipsis, ExternalLink, FolderOpen } from "lucide-react";
import { createContext, useLayoutEffect, useRef, useState, type JSX } from "react";

import type { MessageKey } from "../i18n.js";
import type { ArtifactView, OperationApi } from "../model.js";
import {
  listNativeFileOpenApplications,
  nativeArtifactSourceRevealAvailable,
  nativeFileCopyAvailable,
  nativeFileOpenAvailable,
  nativeFileOpenWithAvailable,
  retireNativeFileOpenApplicationList,
  type NativeFileOpenApplication,
  type NativeFileOpenApplicationList
} from "../native-file-actions.js";
import { RENDERED_SHARE_EXCLUDE_ATTRIBUTE } from "./rendered-share-dom.js";
import type { Translator } from "./types.js";
import "./native-file-actions.css";

export interface NativeArtifactFileActions {
  readonly copyFile?: OperationApi["copyArtifactFile"];
  readonly openFile?: OperationApi["openArtifactFile"];
  readonly openFileWithApplication?: OperationApi["openArtifactFileWithApplication"];
  readonly revealSource?: OperationApi["revealArtifactSource"];
}

export const NativeFileActionsContext = createContext<NativeArtifactFileActions | undefined>(undefined);

export function NativeArtifactFileActionsMenu({ actions, artifact, ownerKey, t }: {
  readonly actions: NativeArtifactFileActions | undefined;
  readonly artifact: Pick<ArtifactView, "id" | "blobId" | "sourceSessionId" | "sourceRevealAvailable" | "fileName" | "byteSize">;
  readonly ownerKey: string;
  readonly t: Translator;
}): JSX.Element | null {
  return <NativeFileActionsMenu
    actions={actions}
    artifactId={artifact.id}
    blobId={artifact.blobId}
    name={artifact.fileName}
    byteSize={artifact.byteSize}
    {...(artifact.sourceSessionId === undefined ? {} : { sourceSessionId: artifact.sourceSessionId })}
    sourceRevealAvailable={artifact.sourceRevealAvailable}
    ownerKey={ownerKey}
    t={t}
  />;
}

type Feedback =
  | "copied"
  | "copy-failed"
  | "copy-capacity"
  | "copy-unknown"
  | "copy-blocked"
  | "opened"
  | "open-failed"
  | "open-capacity"
  | "open-unknown"
  | "revealed"
  | "reveal-failed"
  | "reveal-unknown"
  | "source-unavailable";

const FEEDBACK_KEYS: Record<Feedback, MessageKey> = {
  copied: "media.fileCopied",
  "copy-failed": "media.fileCopyFailed",
  "copy-capacity": "media.fileCopyCapacity",
  "copy-unknown": "media.fileCopyUnknown",
  "copy-blocked": "media.fileCopyBlocked",
  opened: "media.fileOpened",
  "open-failed": "media.fileOpenFailed",
  "open-capacity": "media.fileOpenCapacity",
  "open-unknown": "media.fileOpenUnknown",
  revealed: "media.sourceRevealed",
  "reveal-failed": "media.sourceRevealFailed",
  "reveal-unknown": "media.sourceRevealUnknown",
  "source-unavailable": "media.sourceUnavailable"
};

interface MenuOwner {
  readonly abort: AbortController;
  readonly document: Document;
  readonly node: HTMLDivElement;
  request?: AbortController;
  timer?: number;
  openWithEpoch: number;
  openWithRequest?: AbortController;
  openWithList?: NativeFileOpenApplicationList;
  openWithFlight?: NativeFileOpenApplicationList;
}

type OpenWithState =
  | { readonly phase: "loading" }
  | { readonly phase: "listed"; readonly list: NativeFileOpenApplicationList }
  | { readonly phase: "failed" };

export function NativeFileActionsMenu({ actions, artifactId, blobId, name, byteSize, sourceSessionId, sourceRevealAvailable, ownerKey, t }: {
  readonly actions: NativeArtifactFileActions | undefined;
  readonly artifactId: string;
  readonly blobId: string;
  readonly name: string;
  readonly byteSize: number;
  readonly sourceSessionId?: string;
  readonly sourceRevealAvailable: boolean;
  readonly ownerKey: string;
  readonly t: Translator;
}): JSX.Element | null {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [epoch, setEpoch] = useState(0);
  const owner = useRef<MenuOwner | undefined>(undefined);
  const [feedback, setFeedback] = useState<Feedback>();
  const [pending, setPending] = useState<"copy" | "open" | "reveal">();
  const [openWithState, setOpenWithState] = useState<OpenWithState>();
  const copyFile = actions?.copyFile;
  const openFile = actions?.openFile;
  const openFileWithApplication = actions?.openFileWithApplication;
  const revealSource = actions?.revealSource;
  const copyAvailable = copyFile !== undefined && nativeFileCopyAvailable();
  const openAvailable = openFile !== undefined && nativeFileOpenAvailable();
  const openWithAvailable = openAvailable && openFileWithApplication !== undefined && nativeFileOpenWithAvailable();
  const revealAvailable = revealSource !== undefined && sourceRevealAvailable && sourceSessionId !== undefined &&
    sourceSessionId.length > 0 && artifactId.length > 0 && nativeArtifactSourceRevealAvailable();
  const available = copyAvailable || openAvailable || revealAvailable;
  const ownerDocument = node?.ownerDocument;

  const resetOpenWith = (current: MenuOwner, includeFlight: boolean): void => {
    current.openWithEpoch += 1;
    current.node.querySelector<HTMLDetailsElement>(".native-file-actions__open-with")?.removeAttribute("open");
    current.openWithRequest?.abort();
    current.openWithRequest = undefined;
    if (current.openWithList !== undefined) retireNativeFileOpenApplicationList(current.openWithList);
    current.openWithList = undefined;
    if (includeFlight && current.openWithFlight !== undefined) {
      retireNativeFileOpenApplicationList(current.openWithFlight);
      current.openWithFlight = undefined;
    }
    if (owner.current === current) setOpenWithState(undefined);
  };

  useLayoutEffect(() => {
    if (node === null || ownerDocument === undefined || !available) return;
    const current: MenuOwner = {
      abort: new AbortController(),
      document: ownerDocument,
      node,
      request: undefined,
      timer: undefined,
      openWithEpoch: 0,
      openWithRequest: undefined,
      openWithList: undefined,
      openWithFlight: undefined
    };
    const ownerWindow = ownerDocument.defaultView;
    owner.current = current;
    setPending(undefined);
    setFeedback(undefined);
    setOpenWithState(undefined);
    const retire = (): void => {
      current.abort.abort();
      current.request?.abort();
      resetOpenWith(current, true);
      if (current.timer !== undefined) ownerWindow?.clearTimeout(current.timer);
      if (owner.current === current) {
        setPending(undefined);
        setFeedback(undefined);
      }
    };
    const restore = (): void => {
      if (owner.current === current && current.abort.signal.aborted && ownerWindow?.document === ownerDocument && node.isConnected) {
        setEpoch((value) => value + 1);
      }
    };
    const outside = (event: PointerEvent): void => {
      if (!node.contains(event.target as Node)) node.querySelector(":scope > details")?.removeAttribute("open");
    };
    ownerWindow?.addEventListener("pagehide", retire);
    ownerWindow?.addEventListener("pageshow", restore);
    ownerDocument.addEventListener("pointerdown", outside);
    return () => {
      retire();
      if (owner.current === current) owner.current = undefined;
      ownerWindow?.removeEventListener("pagehide", retire);
      ownerWindow?.removeEventListener("pageshow", restore);
      ownerDocument.removeEventListener("pointerdown", outside);
    };
  }, [artifactId, available, blobId, byteSize, copyFile, epoch, name, node, openFile, openFileWithApplication, ownerDocument, ownerKey, revealSource, sourceRevealAvailable, sourceSessionId]);

  if (!available) return null;

  const loadOpenWithApplications = (): void => {
    const current = owner.current;
    if (!openWithAvailable || current === undefined || current.request !== undefined || current.openWithRequest !== undefined ||
      current.openWithList !== undefined || current.openWithFlight !== undefined || current.abort.signal.aborted ||
      !current.node.isConnected || current.node.ownerDocument !== current.document ||
      current.document.defaultView?.document !== current.document) return;
    const request = new AbortController();
    const listEpoch = ++current.openWithEpoch;
    current.openWithRequest = request;
    setOpenWithState({ phase: "loading" });
    const context = {
      ownerDocument: current.document,
      signal: AbortSignal.any([request.signal, current.abort.signal])
    };
    void listNativeFileOpenApplications(name, context).then((result) => {
      const isCurrent = owner.current === current && current.openWithRequest === request &&
        current.openWithEpoch === listEpoch && !context.signal.aborted && current.node.isConnected &&
        current.node.ownerDocument === current.document && current.document.defaultView?.document === current.document;
      if (!isCurrent) {
        if (result.status === "listed") retireNativeFileOpenApplicationList(result.list);
        return;
      }
      current.openWithRequest = undefined;
      if (result.status === "listed") {
        current.openWithList = result.list;
        setOpenWithState({ phase: "listed", list: result.list });
      } else {
        setOpenWithState({ phase: "failed" });
      }
    }).catch(() => {
      if (owner.current === current && current.openWithRequest === request && current.openWithEpoch === listEpoch && !context.signal.aborted) {
        current.openWithRequest = undefined;
        setOpenWithState({ phase: "failed" });
      }
    });
  };

  const start = (kind: "copy" | "open" | "reveal", openWith?: {
    readonly list: NativeFileOpenApplicationList;
    readonly application: NativeFileOpenApplication;
  }): void => {
    const actionAvailable = kind === "copy" ? copyAvailable : kind === "open"
      ? openWith === undefined ? openAvailable : openWithAvailable
      : revealAvailable;
    const current = owner.current;
    if (!actionAvailable || current === undefined || current.request !== undefined ||
      current.abort.signal.aborted || !current.node.isConnected || current.node.ownerDocument !== current.document ||
      current.document.defaultView?.document !== current.document ||
      (openWith !== undefined && current.openWithList !== openWith.list)) return;
    const request = new AbortController();
    current.request = request;
    if (openWith !== undefined) {
      // The menu closes immediately, but this exact list occurrence remains
      // owned by the admitted canonical-Blob flight until it settles. Any
      // page/owner retirement still aborts the flight and invalidates Main.
      current.openWithFlight = openWith.list;
      current.openWithList = undefined;
    }
    if (current.timer !== undefined) current.document.defaultView?.clearTimeout(current.timer);
    setPending(kind);
    setFeedback(undefined);
    const details = current.node.querySelector<HTMLDetailsElement>(":scope > details");
    details?.removeAttribute("open");
    details?.querySelector<HTMLElement>(":scope > summary")?.focus();
    const isCurrent = (): boolean => owner.current === current && current.request === request &&
      !current.abort.signal.aborted && !request.signal.aborted && current.node.isConnected &&
      current.node.ownerDocument === current.document && current.document.defaultView?.document === current.document;
    const context = {
      ownerDocument: current.document,
      signal: AbortSignal.any([request.signal, current.abort.signal])
    };
    const operation = kind === "copy"
      ? copyFile!(blobId, name, byteSize, context)
      : kind === "open"
        ? openWith === undefined
          ? openFile!(blobId, name, byteSize, context)
          : openFileWithApplication!(blobId, name, byteSize, openWith.list, openWith.application, context)
        : revealSource!(sourceSessionId!, artifactId, context);
    void operation.then((result) => {
      if (!isCurrent()) return;
      if (kind === "copy") {
        const copyResult = result as Awaited<ReturnType<OperationApi["copyArtifactFile"]>>;
        if (copyResult.status === "copied") {
          setFeedback("copied");
          current.timer = current.document.defaultView?.setTimeout(() => {
            if (owner.current === current && !current.abort.signal.aborted && current.request === undefined) setFeedback(undefined);
          }, 3_000);
        } else if (copyResult.status === "unknown") setFeedback("copy-unknown");
        else if (copyResult.status === "blocked") setFeedback("copy-blocked");
        else if (copyResult.status === "failed") setFeedback(copyResult.reason === "capacity" ? "copy-capacity" : "copy-failed");
      } else if (kind === "open") {
        const openResult = result as Awaited<ReturnType<OperationApi["openArtifactFile"]>>;
        if (openResult.status === "opened") {
          setFeedback("opened");
          current.timer = current.document.defaultView?.setTimeout(() => {
            if (owner.current === current && !current.abort.signal.aborted && current.request === undefined) setFeedback(undefined);
          }, 3_000);
        } else if (openResult.status === "unknown") setFeedback("open-unknown");
        else if (openResult.status === "unavailable" && openWith !== undefined) setFeedback("open-failed");
        else if (openResult.status === "failed") setFeedback(openResult.reason === "capacity" ? "open-capacity" : "open-failed");
      } else {
        const revealResult = result as Awaited<ReturnType<OperationApi["revealArtifactSource"]>>;
        if (revealResult.status === "revealed") {
          setFeedback("revealed");
          current.timer = current.document.defaultView?.setTimeout(() => {
            if (owner.current === current && !current.abort.signal.aborted && current.request === undefined) setFeedback(undefined);
          }, 3_000);
        } else if (revealResult.status === "unknown") setFeedback("reveal-unknown");
        else if (revealResult.status === "unavailable") setFeedback("source-unavailable");
        else if (revealResult.status === "failed") setFeedback("reveal-failed");
      }
    }).catch(() => {
      if (isCurrent()) setFeedback(kind === "copy" ? "copy-failed" : kind === "open" ? "open-failed" : "reveal-failed");
    }).finally(() => {
      if (openWith !== undefined && current.openWithFlight === openWith.list) {
        retireNativeFileOpenApplicationList(openWith.list);
        current.openWithFlight = undefined;
      }
      if (!isCurrent()) return;
      current.request = undefined;
      setPending(undefined);
      setOpenWithState(undefined);
    });
  };

  const text = feedback === undefined ? undefined : t(FEEDBACK_KEYS[feedback]);
  const pendingText = pending === "copy" ? t("media.copyingFile") : pending === "open" ? t("media.openingFile") : pending === "reveal" ? t("media.revealingSource") : undefined;
  return <div ref={setNode} {...{ [RENDERED_SHARE_EXCLUDE_ATTRIBUTE]: "" }} className="native-file-actions" aria-busy={pending !== undefined}>
    <details className="message-action-menu" onToggle={(event) => {
      if (!event.currentTarget.open) {
        const current = owner.current;
        if (current !== undefined) resetOpenWith(current, false);
      }
    }} onKeyDown={(event) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.open = false;
        event.currentTarget.querySelector<HTMLElement>(":scope > summary")?.focus();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.currentTarget.open = true;
        event.currentTarget.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
      } else if (event.key === "Tab") event.currentTarget.open = false;
    }}>
      <summary aria-label={t("media.fileActions")} aria-disabled={pending !== undefined} onClick={(event) => {
        if (pending !== undefined) event.preventDefault();
      }}><Ellipsis aria-hidden="true" /></summary>
      <div role="menu" aria-label={t("media.fileActions")} className="message-action-menu__panel">
        {openWithAvailable ? <details className="native-file-actions__open-with" onToggle={(event) => {
          if (event.currentTarget.open) loadOpenWithApplications();
        }} onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "ArrowRight") {
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.open = true;
            event.currentTarget.querySelector<HTMLButtonElement>('button[role="menuitem"]')?.focus();
          } else if (event.key === "ArrowLeft") {
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.open = false;
            event.currentTarget.querySelector<HTMLElement>(":scope > summary")?.focus();
          }
        }}>
          <summary role="menuitem" aria-haspopup="menu"><AppWindow aria-hidden="true" />{t("media.openWith")}<ChevronRight aria-hidden="true" /></summary>
          <div role="menu" aria-label={t("media.openWith")} className="native-file-actions__open-with-panel" aria-busy={openWithState?.phase === "loading"}>
            <button role="menuitem" type="button" disabled={pending !== undefined} onClick={() => start("open")}><ExternalLink aria-hidden="true" />{t(pending === "open" ? "media.openingFile" : "media.openFile")}</button>
            {openWithState?.phase === "loading" && <span className="native-file-actions__open-with-status" role="status">{t("media.loadingApplications")}</span>}
            {openWithState?.phase === "listed" && openWithState.list.applications.map((application) => <button
              role="menuitem"
              type="button"
              disabled={pending !== undefined}
              onClick={() => start("open", { list: openWithState.list, application })}
              key={application.appId}
            >{application.iconDataUrl === undefined
                ? <AppWindow aria-hidden="true" />
                : <img src={application.iconDataUrl} alt="" aria-hidden="true" />}
              {application.label}
            </button>)}
          </div>
        </details> : openAvailable && <button role="menuitem" type="button" disabled={pending !== undefined} onClick={() => start("open")}><ExternalLink aria-hidden="true" />{t(pending === "open" ? "media.openingFile" : "media.openFile")}</button>}
        {copyAvailable && <button role="menuitem" type="button" disabled={pending !== undefined} onClick={() => start("copy")}><Clipboard aria-hidden="true" />{t(pending === "copy" ? "media.copyingFile" : "media.copyFile")}</button>}
        {revealAvailable && <button role="menuitem" type="button" disabled={pending !== undefined} onClick={() => start("reveal")}><FolderOpen aria-hidden="true" />{t(pending === "reveal" ? "media.revealingSource" : "media.revealSource")}</button>}
      </div>
    </details>
    {pendingText !== undefined && <span role="status">{pendingText}</span>}
    {feedback !== undefined && <span role={feedback === "copied" || feedback === "opened" || feedback === "revealed" ? "status" : "alert"}>{text}</span>}
  </div>;
}
