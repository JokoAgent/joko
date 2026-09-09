import { FileText } from "lucide-react";
import { useMemo, useState, type JSX } from "react";
import type { Translator } from "./types.js";
import type { SentPastedTextMessageSegment } from "./sent-pasted-text.js";
import { SentPastedTextLightbox } from "./SentPastedTextLightbox.js";
import "./sent-pasted-text.css";

export function SentPastedTextInline({ ownerKey, segment, t }: {
  readonly ownerKey: string;
  readonly segment: SentPastedTextMessageSegment;
  readonly t: Translator;
}): JSX.Element {
  const sourceOwner = useMemo(() => ({}), [ownerKey, segment.text]);
  const [preview, setPreview] = useState<{
    readonly owner: object;
    readonly text: string;
    readonly display: string;
    readonly trigger: HTMLElement;
  }>();

  return <>
    <span className="message-user__text">
      {segment.tokens.map((token, index) => token.kind === "text"
        ? <span key={`text:${index}`}>{token.text}</span>
        : <button
            className="message-user__pasted-text-chip"
            type="button"
            aria-label={token.display}
            title={token.display}
            key={`pasted:${index}`}
            onClick={(event) => setPreview({ owner: sourceOwner, text: token.text, display: token.display, trigger: event.currentTarget })}
          ><FileText aria-hidden="true" /><span>{token.display}</span></button>)}
    </span>
    {preview !== undefined && preview.owner === sourceOwner && <SentPastedTextLightbox
      ownerKey={ownerKey}
      text={preview.text}
      display={preview.display}
      labels={{
        title: t("timeline.pastedTextTitle"),
        lines: (count) => t("composer.pastedTextLineCount", { count }),
        copy: t("timeline.copy"),
        copied: t("timeline.blockCopied"),
        copyFailed: t("timeline.blockCopyFailed"),
        close: t("common.close")
      }}
      returnFocus={preview.trigger}
      onClose={() => setPreview(undefined)}
    />}
  </>;
}
