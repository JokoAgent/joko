import { Clipboard, Ellipsis, ExternalLink, FolderOpen } from "lucide-react";
import { createContext, useLayoutEffect, useRef, useState, type JSX } from "react";

import type { OperationApi } from "../model.js";
import type { MessageKey } from "../i18n.js";
import { nativeArtifactSourceRevealAvailable, nativeFileCopyAvailable, nativeFileOpenAvailable } from "../native-file-actions.js";
import type { Translator } from "./types.js";
import "./native-file-actions.css";

export interface NativeArtifactFileActions {
  readonly copyFile?: OperationApi["copyArtifactFile"];
  readonly openFile?: OperationApi["openArtifactFile"];
  readonly revealSource?: OperationApi["revealArtifactSource"];
}

export const NativeFileActionsContext = createContext<NativeArtifactFileActions | undefined>(undefined);

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
  const owner = useRef<{
    readonly abort: AbortController;
    readonly document: Document;
    readonly node: HTMLDivElement;
    request?: AbortController;
    timer?: number;
  } | undefined>(undefined);
  const [feedback, setFeedback] = useState<Feedback>();
  const [pending, setPending] = useState<"copy" | "open" | "reveal">();
  const copyFile = actions?.copyFile;
  const openFile = actions?.openFile;
  const revealSource = actions?.revealSource;
  const copyAvailable = copyFile !== undefined && nativeFileCopyAvailable();
  const openAvailable = openFile !== undefined && nativeFileOpenAvailable();
  const revealAvailable = revealSource !== undefined && sourceRevealAvailable && sourceSessionId !== undefined &&
    sourceSessionId.length > 0 && artifactId.length > 0 && nativeArtifactSourceRevealAvailable();
  const available = copyAvailable || openAvailable || revealAvailable;
  const ownerDocument = node?.ownerDocument;

  useLayoutEffect(() => {
    if (node === null || ownerDocument === undefined || !available) return;
    const current = {
      abort: new AbortController(),
      document: ownerDocument,
      node,
      request: undefined as AbortController | undefined,
      timer: undefined as number | undefined
    };
    const ownerWindow = ownerDocument.defaultView;
    owner.current = current;
    setPending(undefined);
    setFeedback(undefined);
    const retire = (): void => {
      current.abort.abort();
      current.request?.abort();
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
      if (!node.contains(event.target as Node)) node.querySelector("details")?.removeAttribute("open");
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
  }, [artifactId, available, blobId, byteSize, copyFile, epoch, name, node, openFile, ownerDocument, ownerKey, revealSource, sourceRevealAvailable, sourceSessionId]);

  if (!available) return null;
  const start = (kind: "copy" | "open" | "reveal"): void => {
    const actionAvailable = kind === "copy" ? copyAvailable : kind === "open" ? openAvailable : revealAvailable;
    const current = owner.current;
    if (!actionAvailable || current === undefined || current.request !== undefined ||
      current.abort.signal.aborted || !current.node.isConnected || current.node.ownerDocument !== current.document ||
      current.document.defaultView?.document !== current.document) return;
    const request = new AbortController();
    current.request = request;
    if (current.timer !== undefined) current.document.defaultView?.clearTimeout(current.timer);
    setPending(kind);
    setFeedback(undefined);
    const details = current.node.querySelector("details");
    details?.removeAttribute("open");
    details?.querySelector("summary")?.focus();
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
        ? openFile!(blobId, name, byteSize, context)
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
        else if (copyResult.status === "failed") {
          setFeedback(copyResult.reason === "capacity" ? "copy-capacity" : "copy-failed");
        }
      } else if (kind === "open") {
        const openResult = result as Awaited<ReturnType<OperationApi["openArtifactFile"]>>;
        if (openResult.status === "opened") {
          setFeedback("opened");
          current.timer = current.document.defaultView?.setTimeout(() => {
            if (owner.current === current && !current.abort.signal.aborted && current.request === undefined) setFeedback(undefined);
          }, 3_000);
        } else if (openResult.status === "unknown") setFeedback("open-unknown");
        else if (openResult.status === "failed") {
          setFeedback(openResult.reason === "capacity" ? "open-capacity" : "open-failed");
        }
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
      if (!isCurrent()) return;
      current.request = undefined;
      setPending(undefined);
    });
  };
  const text = feedback === undefined ? undefined : t(FEEDBACK_KEYS[feedback]);
  const pendingText = pending === "copy" ? t("media.copyingFile") : pending === "open" ? t("media.openingFile") : pending === "reveal" ? t("media.revealingSource") : undefined;
  return <div ref={setNode} className="native-file-actions" aria-busy={pending !== undefined}>
    <details className="message-action-menu" onKeyDown={(event) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.open = false;
        event.currentTarget.querySelector("summary")?.focus();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.currentTarget.open = true;
        event.currentTarget.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
      } else if (event.key === "Tab") event.currentTarget.open = false;
    }}>
      <summary aria-label={t("media.fileActions")}><Ellipsis aria-hidden="true" /></summary>
      <div role="menu" aria-label={t("media.fileActions")} className="message-action-menu__panel">
        {openAvailable && <button role="menuitem" type="button" disabled={pending !== undefined} onClick={() => start("open")}><ExternalLink aria-hidden="true" />{t(pending === "open" ? "media.openingFile" : "media.openFile")}</button>}
        {copyAvailable && <button role="menuitem" type="button" disabled={pending !== undefined} onClick={() => start("copy")}><Clipboard aria-hidden="true" />{t(pending === "copy" ? "media.copyingFile" : "media.copyFile")}</button>}
        {revealAvailable && <button role="menuitem" type="button" disabled={pending !== undefined} onClick={() => start("reveal")}><FolderOpen aria-hidden="true" />{t(pending === "reveal" ? "media.revealingSource" : "media.revealSource")}</button>}
      </div>
    </details>
    {pendingText !== undefined && <span role="status">{pendingText}</span>}
    {feedback !== undefined && <span role={feedback === "copied" || feedback === "opened" || feedback === "revealed" ? "status" : "alert"}>{text}</span>}
  </div>;
}
