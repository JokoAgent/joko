import { useMemo, type JSX } from "react";
import type { Components } from "react-markdown";
import rehypeKatex from "rehype-katex";

import { TimelineMarkdownDocument } from "./TimelineMarkdownDocument.js";
import { highlightedCode } from "./TimelineCodeBlock.js";
import { timelineCodeHighlight, timelineCodeLanguage } from "./timeline-code-highlighting.js";
import { WorkspaceTextEditor, workspaceEditorLanguageId } from "./WorkspaceTextEditor.js";
import { TIMELINE_REMARK_PLUGINS } from "./timeline-markdown.js";
import { normalizeTimelineMathDelimiters } from "./timeline-markdown-math.js";

const REHYPE_PLUGINS: NonNullable<Parameters<typeof TimelineMarkdownDocument>[0]["rehypePlugins"]> = [[rehypeKatex, { strict: "ignore", errorColor: "inherit" }]];
const MARKDOWN_COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  img: ({ node: _node, ...props }) => props.src
    ? <img {...props} loading="lazy" referrerPolicy="no-referrer" />
    : <span>{props.alt}</span>,
  code: ({ className, children }) => <MarkdownCode className={className} source={String(children)} />
};

// An artifact grants its own bytes, not a filesystem parent or sibling files.
function markdownUrl(url: string, attribute: string): string {
  if (attribute === "href" && url.startsWith("#")) return url;
  try {
    const target = new URL(url);
    if (target.username || target.password) return "";
    return target.protocol === "https:" || target.protocol === "http:" || attribute === "href" && target.protocol === "mailto:" ? url : "";
  } catch { return ""; }
}

function MarkdownCode({ source, className }: { readonly source: string; readonly className?: string }): JSX.Element {
  const language = timelineCodeLanguage(className);
  const tokens = useMemo(() => timelineCodeHighlight(source, language), [source, language]);
  return <code className={[className, language === undefined ? undefined : "timeline-code-block"].filter(Boolean).join(" ") || undefined}>{highlightedCode(source, tokens)}</code>;
}

export function TimelineTextAttachmentBody({ sourceKey, fileName, text, label }: {
  readonly sourceKey: string;
  readonly fileName: string;
  readonly text: string;
  readonly label: string;
}): JSX.Element {
  const language = workspaceEditorLanguageId(fileName);
  const markdown = useMemo(() => language === "markdown" ? normalizeTimelineMathDelimiters(text) : "", [language, text]);
  if (language === "markdown") return <div className="text-attachment-lightbox__markdown" tabIndex={0}>
    <TimelineMarkdownDocument remarkPlugins={TIMELINE_REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={MARKDOWN_COMPONENTS} urlTransform={markdownUrl} skipHtml>{markdown}</TimelineMarkdownDocument>
  </div>;
  if (language !== "text") return <WorkspaceTextEditor key={sourceKey} path={fileName} value={text} readOnly focusable rememberScroll={false}
    scrollKey={sourceKey} ariaLabel={label} />;
  return <pre tabIndex={0}>{text}</pre>;
}
