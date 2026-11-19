import { defaultUrlTransform } from "react-markdown";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified, type PluggableList } from "unified";
import { scanChatUrls } from "../chat-url-boundary.js";
import { remarkChatUrlBoundaries } from "./remark-chat-url-boundaries.js";
import { normalizeTimelineMathDelimiters, remarkStrictTimelineInlineMath } from "./timeline-markdown-math.js";

export const TIMELINE_REMARK_PLUGINS: PluggableList = [
  [remarkGfm, { singleTilde: false }], remarkCjkFriendly, remarkMath,
  remarkStrictTimelineInlineMath, remarkChatUrlBoundaries
];
const parser = unified().use(remarkParse).use(TIMELINE_REMARK_PLUGINS);
interface MarkdownNode {
  readonly type: string;
  readonly value?: string;
  readonly url?: string;
  readonly identifier?: string;
  readonly children?: readonly MarkdownNode[];
}

/** Use the same Markdown parsing and URL policy as the message renderer. Code,
 * math, raw HTML and unresolved image references cannot count as delivery. */
export function renderedTimelineMarkdownImageTargets(markdown: string): readonly string[] {
  if (!markdown.includes("![")) return [];
  const normalized = normalizeTimelineMathDelimiters(markdown);
  const tree = parser.runSync(parser.parse(normalized));
  const definitions = new Map<string, string>();
  const images: Array<{ readonly url?: string; readonly identifier?: string }> = [];
  const visit = (node: MarkdownNode): void => {
    if (node.type === "definition" && node.identifier !== undefined && node.url !== undefined) definitions.set(node.identifier, node.url);
    if (node.type === "image" || node.type === "imageReference") images.push(node);
    node.children?.forEach(visit);
  };
  visit(tree);
  return [...new Set(images.flatMap((image) => {
    const url = image.url ?? (image.identifier === undefined ? undefined : definitions.get(image.identifier));
    return url === undefined || defaultUrlTransform(url) === "" ? [] : [url];
  }))];
}

const speechBreaks = new Set(["paragraph", "heading", "break", "tableCell", "thematicBreak"]);

export function timelineMarkdownProse(markdown: string): string {
  const tree = parser.runSync(parser.parse(normalizeTimelineMathDelimiters(markdown)));
  const parts: string[] = [];
  const visit = (node: MarkdownNode): void => {
    if (node.type === "link" && node.children?.length === 1) {
      const label = node.children[0]?.value;
      if (label !== undefined && (label === node.url || `http://${label}` === node.url || `mailto:${label}` === node.url)) return;
    }
    if ((node.type === "text" || node.type === "inlineCode") && node.value !== undefined) {
      let offset = 0;
      for (const url of scanChatUrls(node.value)) {
        parts.push(node.value.slice(offset, url.start));
        offset = url.end;
      }
      parts.push(node.value.slice(offset));
    }
    node.children?.forEach(visit);
    if (speechBreaks.has(node.type)) parts.push(" ");
  };
  visit(tree);
  return parts.join("").replace(/\s+/gu, " ").trim();
}
