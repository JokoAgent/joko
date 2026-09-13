import { Check, Clipboard } from "lucide-react";
import { useCallback, useMemo, useState, type JSX, type ReactNode } from "react";
import { writeClipboardText } from "../clipboard-action.js";
import { useClipboardAction } from "./use-clipboard-action.js";
import type { Translator } from "./types.js";
import { IconButton } from "./ui.js";
import { timelineCodeHighlight, timelineCodeLanguage, timelineCodeLanguageLabel } from "./timeline-code-highlighting.js";
import { TimelineMarkdownDiffRows } from "./TimelineMarkdownDiffRows.js";
import "./timeline-code-block.css";

export function TimelineCodeBlock({ ownerKey, source, codeClassName, t }: {
  readonly ownerKey: string;
  readonly source: string;
  readonly codeClassName?: string;
  readonly t: Translator;
}): JSX.Element {
  const language = timelineCodeLanguage(codeClassName);
  const tokens = useMemo(() => language === "diff" ? [] : timelineCodeHighlight(source, language), [language, source]);
  const [ownerDocument, setOwnerDocument] = useState<Document>();
  const attach = useCallback((node: HTMLDivElement | null): void => setOwnerDocument(node?.ownerDocument), []);
  const copy = useClipboardAction({ ownerKey, sourceKey: source, ownerDocument, feedbackDurationMs: 1_500 });
  const label = copy.state === "copied"
    ? t("timeline.codeCopied")
    : copy.state === "failed"
      ? t("timeline.codeCopyFailed")
      : t("timeline.copyCode");

  return <div ref={attach} className="timeline-code-block" data-language={language ?? "text"}>
    <div className="timeline-code-block__toolbar">
      <span>{timelineCodeLanguageLabel(language, t("timeline.codePlainText"))}</span>
    </div>
    <pre className={language === "diff" ? "timeline-code-block__diff" : undefined} tabIndex={language === "diff" ? 0 : undefined} aria-label={language === "diff" ? timelineCodeLanguageLabel(language, t("timeline.codePlainText")) : undefined}>
      <code className={codeClassName}>{language === "diff" ? <TimelineMarkdownDiffRows source={source} /> : highlightedCode(source, tokens)}</code>
    </pre>
    <IconButton className="timeline-code-block__copy" label={label} aria-disabled={copy.pending} aria-busy={copy.pending} onClick={(event) => copy.run(event.currentTarget.ownerDocument, (context) => writeClipboardText(source, context))}>
      {copy.state === "copied" ? <Check aria-hidden="true" /> : <Clipboard aria-hidden="true" />}
    </IconButton>
    {copy.state === "failed" && <span className="sr-only" role="alert">{label}</span>}
  </div>;
}

function highlightedCode(source: string, tokens: readonly { readonly from: number; readonly to: number; readonly className: string }[]): ReactNode {
  if (tokens.length === 0) return source;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  tokens.forEach((token, index) => {
    if (token.from > cursor) nodes.push(source.slice(cursor, token.from));
    nodes.push(<span className={token.className} key={`${token.from}:${token.to}:${index}`}>{source.slice(token.from, token.to)}</span>);
    cursor = token.to;
  });
  if (cursor < source.length) nodes.push(source.slice(cursor));
  return nodes;
}
