import { Check, Copy } from "lucide-react";
import { useCallback, useRef, useState, type JSX, type ReactNode } from "react";
import { assertBrowserActionCurrent } from "../browser-action.js";
import { copyTimelinePng, timelineDomToPng } from "./timeline-image-export.js";
import { useClipboardAction } from "./use-clipboard-action.js";
import { GeneratedImageAnnotationButton, generatedImageAnnotationLabels } from "./GeneratedImageAnnotationButton.js";
import type { Translator } from "./types.js";
import { IconButton } from "./ui.js";

export function TimelineCopyAsImageBlock({ children, ownerKey, sourceKey, imageName, onSendToChat, t, className, contentClassName, extractPlainText }: {
  readonly children: ReactNode;
  readonly ownerKey: string;
  readonly sourceKey: string;
  readonly imageName: string;
  readonly onSendToChat?: (file: File) => void | Promise<void>;
  readonly t: Translator;
  readonly className?: string;
  readonly contentClassName?: string;
  readonly extractPlainText?: (node: HTMLElement) => string | undefined;
}): JSX.Element {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [ownerDocument, setOwnerDocument] = useState<Document>();
  const bindContent = useCallback((node: HTMLDivElement | null): void => {
    contentRef.current = node;
    setOwnerDocument(node?.ownerDocument);
  }, []);
  const copy = useClipboardAction({ ownerKey, sourceKey, ownerDocument });
  const label = copy.state === "copied"
    ? t("timeline.blockCopied")
    : copy.state === "failed"
      ? t("timeline.blockCopyFailed")
      : t("timeline.blockCopy");

  return <div className={`timeline-copy-block${className === undefined ? "" : ` ${className}`}`}>
    <div ref={bindContent} className={contentClassName}>{children}</div>
    <IconButton className="timeline-copy-block__button" aria-disabled={copy.pending} aria-busy={copy.pending} label={label} onClick={(event) => {
      const node = contentRef.current;
      if (node === null) return;
      copy.run(event.currentTarget.ownerDocument, async (context) => {
        const plainText = extractPlainText?.(node);
        const blob = await timelineDomToPng(node, context);
        assertBrowserActionCurrent(context);
        if (contentRef.current !== node || !node.isConnected || node.ownerDocument !== context.ownerDocument) throw new Error("Content is no longer available.");
        await copyTimelinePng(blob, plainText, context);
      });
    }}>
      {copy.state === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
    </IconButton>
    {onSendToChat !== undefined && <GeneratedImageAnnotationButton
      ownerKey={ownerKey} sourceKey={sourceKey} ownerDocument={ownerDocument} name={imageName} labels={generatedImageAnnotationLabels(t)}
      className="timeline-copy-block__button timeline-copy-block__annotate" onSendToChat={onSendToChat}
      buildImage={async (context) => {
        const node = contentRef.current;
        if (node === null) throw new Error("Content is no longer available.");
        const blob = await timelineDomToPng(node, context);
        assertBrowserActionCurrent(context);
        if (contentRef.current !== node || !node.isConnected || node.ownerDocument !== context.ownerDocument) throw new Error("Content is no longer available.");
        return blob;
      }}
    />}
    {copy.state === "failed" && <span className="sr-only" role="alert">{label}</span>}
  </div>;
}
