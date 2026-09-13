import { advanceChatUrlContext, chatUrlEnd, createChatUrlContext, scanChatUrls } from "../chat-url-boundary.js";

interface MarkdownNode {
  readonly type: string;
  value?: string;
  url?: string;
  readonly position?: { readonly start: { readonly offset?: number }; readonly end: { readonly offset?: number } };
  children?: MarkdownNode[];
}

/** Runs after GFM has identified literal links; authored destinations remain untouched. */
export function remarkChatUrlBoundaries(): (tree: MarkdownNode) => void {
  return (tree) => {
    const pending = [tree];
    while (pending.length > 0) {
      const parent = pending.pop()!;
      if (parent.children === undefined || ["link", "image", "linkReference", "code", "inlineCode"].includes(parent.type)) continue;
      const context = createChatUrlContext();
      const children: MarkdownNode[] = [];
      for (let index = 0; index < parent.children.length; index += 1) {
        const node = parent.children[index]!;
        const child = literalLinkText(node);
        if (child !== undefined && node.url !== undefined) {
          restoreQueryClosers(node, child, parent.children[index + 1]);
          const cut = chatUrlEnd(node.url, context);
          if (cut > 0 && cut < node.url.length) {
            const tail = node.url.slice(cut);
            node.url = node.url.slice(0, cut);
            child.value = node.url;
            children.push(node, ...tailNodes(tail));
            advanceChatUrlContext(context, node.url + tail);
            continue;
          }
        }
        children.push(node);
        advanceChatUrlContext(context, visibleText(node));
        pending.push(node);
      }
      parent.children = children;
    }
  };
}

function literalLinkText(node: MarkdownNode): MarkdownNode | undefined {
  if (node.type !== "link" || node.children?.length !== 1 || node.url === undefined) return undefined;
  const child = node.children[0]!;
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return child.type === "text" && child.value === node.url && start !== undefined && end !== undefined
    && child.position?.start.offset === start && child.position?.end.offset === end ? child : undefined;
}

function restoreQueryClosers(node: MarkdownNode, child: MarkdownNode, next: MarkdownNode | undefined): void {
  if (node.url === undefined || next?.type !== "text" || next.value === undefined) return;
  const query = node.url.search(/[?#]/u);
  if (query < 0) return;
  const closers: string[] = [];
  for (const character of node.url.slice(query)) {
    if (character === "[") closers.push("]");
    else if (character === "{") closers.push("}");
    else if (character === closers.at(-1)) closers.pop();
  }
  let consumed = 0;
  while (closers.length > 0 && next.value[consumed] === closers.at(-1)) { closers.pop(); consumed += 1; }
  if (consumed === 0) return;
  node.url += next.value.slice(0, consumed);
  child.value = node.url;
  next.value = next.value.slice(consumed);
}

function tailNodes(text: string): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];
  let cursor = 0;
  for (const match of scanChatUrls(text)) {
    if (match.start > cursor) nodes.push({ type: "text", value: text.slice(cursor, match.start) });
    nodes.push({ type: "link", url: match.url, children: [{ type: "text", value: match.url }] });
    cursor = match.end;
  }
  if (cursor < text.length) nodes.push({ type: "text", value: text.slice(cursor) });
  return nodes;
}

function visibleText(node: MarkdownNode): string {
  if (node.value !== undefined) return node.value;
  return node.children?.map(visibleText).join("") ?? "";
}
