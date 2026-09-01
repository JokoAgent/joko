import { Check, Clipboard } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import type { Translator } from "./types.js";
import { IconButton } from "./ui.js";
import { timelineCodeHighlight, timelineCodeLanguage, timelineCodeLanguageLabel } from "./timeline-code-highlighting.js";
import "./timeline-code-block.css";

export function TimelineCodeBlock({ source, codeClassName, t }: {
  readonly source: string;
  readonly codeClassName?: string;
  readonly t: Translator;
}): JSX.Element {
  const language = timelineCodeLanguage(codeClassName);
  const tokens = useMemo(() => timelineCodeHighlight(source, language), [language, source]);
  const timerRef = useRef<number | undefined>(undefined);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => () => {
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
  }, []);

  const copy = (): void => {
    void navigator.clipboard.writeText(source).then(() => {
      setCopyState("copied");
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopyState("idle"), 1_500);
    }, () => setCopyState("failed"));
  };
  const label = copyState === "copied"
    ? t("timeline.codeCopied")
    : copyState === "failed"
      ? t("timeline.codeCopyFailed")
      : t("timeline.copyCode");

  return <div className="timeline-code-block" data-language={language ?? "text"}>
    <div className="timeline-code-block__toolbar">
      <span>{timelineCodeLanguageLabel(language, t("timeline.codePlainText"))}</span>
    </div>
    <pre><code className={codeClassName}>{highlightedCode(source, tokens)}</code></pre>
    <IconButton className="timeline-code-block__copy" label={label} onClick={copy}>
      {copyState === "copied" ? <Check aria-hidden="true" /> : <Clipboard aria-hidden="true" />}
    </IconButton>
    {copyState === "failed" && <span className="sr-only" role="alert">{label}</span>}
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
