import { defaultUrlTransform } from "react-markdown";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified, type PluggableList } from "unified";
import { remarkChatUrlBoundaries } from "./remark-chat-url-boundaries.js";
import { normalizeTimelineMathDelimiters, remarkStrictTimelineInlineMath } from "./timeline-markdown-math.js";

export const TIMELINE_REMARK_PLUGINS: PluggableList = [
  [remarkGfm, { singleTilde: false }], remarkCjkFriendly, remarkMath,
  remarkStrictTimelineInlineMath, remarkChatUrlBoundaries
];
const imageParser = unified().use(remarkParse).use(TIMELINE_REMARK_PLUGINS);
interface MarkdownNode {
  readonly type: string;
  readonly url?: string;
  readonly identifier?: string;
  readonly children?: readonly MarkdownNode[];
}

/** Use the same Markdown parsing and URL policy as the message renderer. Code,
 * math, raw HTML and unresolved image references cannot count as delivery. */
export function renderedTimelineMarkdownImageTargets(markdown: string): readonly string[] {
  if (!markdown.includes("![")) return [];
  const normalized = normalizeTimelineMathDelimiters(markdown);
  const tree = imageParser.runSync(imageParser.parse(normalized));
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
