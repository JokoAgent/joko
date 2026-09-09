import { Clipboard, Ellipsis } from "lucide-react";
import { createContext, useLayoutEffect, useRef, useState, type JSX } from "react";
import type { OperationApi } from "../model.js";
import { nativeFileCopyAvailable } from "../native-file-actions.js";
import type { Translator } from "./types.js";

export const NativeFileCopyContext = createContext<OperationApi["copyArtifactFile"] | undefined>(undefined);

export function NativeFileCopyMenu({ copyFile, blobId, name, byteSize, ownerKey, t }: {
  readonly copyFile: OperationApi["copyArtifactFile"] | undefined;
  readonly blobId: string;
  readonly name: string;
  readonly byteSize: number;
  readonly ownerKey: string;
  readonly t: Translator;
}): JSX.Element | null {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [epoch, setEpoch] = useState(0);
  const owner = useRef<{ readonly abort: AbortController; readonly document: Document; readonly node: HTMLDivElement; request?: AbortController; timer?: number } | undefined>(undefined);
  const [feedback, setFeedback] = useState<"copied" | "failed" | "capacity" | "unknown" | "blocked">();
  const [pending, setPending] = useState(false);
  const available = copyFile !== undefined && nativeFileCopyAvailable();
  const ownerDocument = node?.ownerDocument;
  useLayoutEffect(() => {
    if (node === null || ownerDocument === undefined || !available) return;
    const current = { abort: new AbortController(), document: ownerDocument, node, request: undefined as AbortController | undefined, timer: undefined as number | undefined };
    const ownerWindow = ownerDocument.defaultView;
    owner.current = current;
    setPending(false); setFeedback(undefined);
    const retire = (): void => {
      current.abort.abort(); current.request?.abort();
      if (current.timer !== undefined) ownerWindow?.clearTimeout(current.timer);
      if (owner.current === current) { setPending(false); setFeedback(undefined); }
    };
    const restore = (): void => { if (owner.current === current && current.abort.signal.aborted && ownerWindow?.document === ownerDocument && node.isConnected) setEpoch((value) => value + 1); };
    const outside = (event: PointerEvent): void => { if (!node.contains(event.target as Node)) node.querySelector("details")?.removeAttribute("open"); };
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
  }, [available, blobId, byteSize, copyFile, epoch, name, node, ownerDocument, ownerKey]);
  if (!available) return null;
  const start = (): void => {
    const current = owner.current;
    if (current === undefined || current.request !== undefined || current.abort.signal.aborted || !current.node.isConnected || current.node.ownerDocument !== current.document || current.document.defaultView?.document !== current.document) return;
    const request = new AbortController(); current.request = request;
    if (current.timer !== undefined) current.document.defaultView?.clearTimeout(current.timer);
    setPending(true); setFeedback(undefined);
    const details = current.node.querySelector("details");
    details?.removeAttribute("open"); details?.querySelector("summary")?.focus();
    const isCurrent = (): boolean => owner.current === current && current.request === request && !current.abort.signal.aborted && !request.signal.aborted && current.node.isConnected && current.node.ownerDocument === current.document && current.document.defaultView?.document === current.document;
    void copyFile(blobId, name, byteSize, { ownerDocument: current.document, signal: AbortSignal.any([request.signal, current.abort.signal]) }).then((result) => {
      if (!isCurrent()) return;
      if (result.status === "copied") {
        setFeedback("copied");
        current.timer = current.document.defaultView?.setTimeout(() => { if (owner.current === current && !current.abort.signal.aborted && current.request === undefined) setFeedback(undefined); }, 3_000);
      } else if (result.status === "unknown") setFeedback("unknown");
      else if (result.status === "blocked") setFeedback("blocked");
      else if (result.status !== "cancelled") setFeedback(result.status === "failed" && result.reason === "capacity" ? "capacity" : "failed");
    }).catch(() => { if (isCurrent()) setFeedback("failed"); }).finally(() => {
      if (!isCurrent()) return;
      current.request = undefined; setPending(false);
    });
  };
  const text = feedback === "copied" ? t("media.fileCopied") : feedback === "unknown" ? t("media.fileCopyUnknown") : feedback === "blocked" ? t("media.fileCopyBlocked") : feedback === "capacity" ? t("media.fileCopyCapacity") : t("media.fileCopyFailed");
  return <div ref={setNode} className="native-file-copy" aria-busy={pending}>
    <details className="message-action-menu" onKeyDown={(event) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); }
      else if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); event.currentTarget.open = true; event.currentTarget.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus(); }
      else if (event.key === "Tab") event.currentTarget.open = false;
    }}>
      <summary aria-label={t("media.fileActions")}><Ellipsis aria-hidden="true" /></summary>
      <div role="menu" aria-label={t("media.fileActions")} className="message-action-menu__panel">
        <button role="menuitem" type="button" disabled={pending} onClick={start}><Clipboard aria-hidden="true" />{t(pending ? "media.copyingFile" : "media.copyFile")}</button>
      </div>
    </details>
    {pending && <span role="status">{t("media.copyingFile")}</span>}
    {feedback !== undefined && <span role={feedback === "copied" ? "status" : "alert"}>{text}</span>}
  </div>;
}
