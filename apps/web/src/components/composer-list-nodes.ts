import { InputRule, Node, mergeAttributes, wrappingInputRule, type NodeConfig } from "@tiptap/core";
import { Fragment, type Node as ProseMirrorNode, type NodeType } from "@tiptap/pm/model";
import { liftListItem, splitListItem } from "@tiptap/pm/schema-list";
import { Selection, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

const BULLET_MARKER_RE = /^([-+*•])([ \t]+)$/u;
const ORDERED_MARKER_RE = /^([1-9]\d{0,8})([.)])([ \t]+)$/u;
const CJK_ORDERED_MARKER_RE = /^([1-9]\d{0,8})(、)$/u;

type BulletMarker = "-" | "+" | "*" | "•";
type OrderedMarker = "." | ")" | "、";

interface OrderedListAttrs {
  readonly start: number;
  readonly marker: OrderedMarker;
  readonly separator: string;
}

interface SelectedTaskPrefix {
  readonly from: number;
  readonly to: number;
  readonly bodyIsEmpty: boolean;
  readonly caretAtOrAfterPrefix: boolean;
  readonly caretAtParagraphEnd: boolean;
}

interface PlainListParagraphMarker {
  readonly kind: "bullet" | "ordered";
  readonly prefixLength: number;
  readonly attrs: Readonly<Record<string, unknown>>;
}

interface FenceState {
  readonly character: "`" | "~";
  readonly length: number;
}

function fenceOpening(text: string): FenceState | undefined {
  const match = text.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
  if (match === null || match[1] === undefined || match[2] === undefined) return undefined;
  const character = match[1][0] as FenceState["character"];
  if (character === "`" && match[2].includes("`")) return undefined;
  return { character, length: match[1].length };
}

function isFenceClosing(text: string, state: FenceState): boolean {
  return new RegExp(`^ {0,3}${state.character}{${state.length},}[ \\t]*$`, "u").test(text);
}

function scanFenceState(text: string, initial: FenceState | undefined): FenceState | undefined {
  let fence = initial;
  for (const line of text.split("\n")) {
    if (fence !== undefined) {
      if (isFenceClosing(line, fence)) fence = undefined;
    } else fence = fenceOpening(line);
  }
  return fence;
}

function paragraphOffsetIsInsideFence(paragraph: ProseMirrorNode, offset: number): boolean {
  return scanFenceState(paragraph.textBetween(0, offset, "\n", "\n"), undefined) !== undefined;
}

function documentFenceStateBefore(document: ProseMirrorNode, position: number): FenceState | undefined {
  let fence: FenceState | undefined;
  document.forEach((node, offset) => {
    if (offset < position && node.type.name === "paragraph") {
      fence = scanFenceState(node.textBetween(0, node.content.size, "\n", "\n"), fence);
    }
  });
  return fence;
}

function plainListParagraphMarker(text: string): PlainListParagraphMarker | undefined {
  const bullet = text.match(/^([-+*•])([ \t]+)/u);
  if (bullet !== null) return { kind: "bullet", prefixLength: bullet[0].length, attrs: { marker: bullet[1], separator: bullet[2] } };
  const ordered = text.match(/^([1-9]\d{0,8})([.)])([ \t]+)/u);
  if (ordered !== null) return {
    kind: "ordered",
    prefixLength: ordered[0].length,
    attrs: { start: Number(ordered[1]), marker: ordered[2], separator: ordered[3] }
  };
  const cjk = text.match(/^([1-9]\d{0,8})(、)([ \t]*)/u);
  if (cjk !== null) return {
    kind: "ordered",
    prefixLength: (cjk[1]?.length ?? 0) + 1,
    attrs: { start: Number(cjk[1]), marker: "、", separator: "" }
  };
  return undefined;
}

function hardBreakListInputRule(
  find: RegExp,
  type: NodeType,
  getAttributes: (match: RegExpMatchArray) => object = () => ({})
): InputRule {
  return new InputRule({
    find: (text) => {
      const lineStart = text.lastIndexOf("\n");
      if (lineStart < 0) return null;
      const line = text.slice(lineStart + 1);
      const match = line.match(find);
      return match === null ? null : { text: line, index: lineStart + 1, data: { attributes: getAttributes(match) } };
    },
    handler: ({ state, range, match, commands }) => {
      const markerStart = state.doc.resolve(range.from);
      if (markerStart.depth !== 1 || markerStart.parent.type.name !== "paragraph") return null;
      const paragraph = markerStart.parent;
      const paragraphStart = markerStart.start();
      const markerOffset = range.from - paragraphStart;
      const hardBreak = paragraph.nodeAt(markerOffset - 1);
      if (hardBreak?.type.name !== "hardBreak") return null;
      if (paragraphOffsetIsInsideFence(paragraph, markerOffset)) return null;
      if (documentFenceStateBefore(state.doc, markerStart.before(1)) !== undefined) return null;
      const paragraphType = state.schema.nodes["paragraph"];
      const itemType = state.schema.nodes["listItem"];
      if (paragraphType === undefined || itemType === undefined) return null;
      const before = paragraph.content.cut(0, markerOffset - hardBreak.nodeSize);
      const after = paragraph.content.cut(range.to - paragraphStart);
      const leading = paragraph.type.create(paragraph.attrs, before, paragraph.marks);
      const listParagraph = paragraph.type.create(paragraph.attrs, after, paragraph.marks);
      const list = type.create((match.data?.["attributes"] as Record<string, unknown> | undefined) ?? {}, itemType.create(null, listParagraph));
      const paragraphPosition = markerStart.before(1);
      commands.command(({ tr }) => {
        tr.replaceWith(
          paragraphPosition,
          paragraphPosition + paragraph.nodeSize,
          Fragment.fromArray([leading, list])
        );
        tr.setSelection(TextSelection.create(tr.doc, paragraphPosition + leading.nodeSize + 3));
        return true;
      });
      return undefined;
    }
  });
}

function fenceAwareWrappingInputRule(config: Parameters<typeof wrappingInputRule>[0]): InputRule {
  const rule = wrappingInputRule(config);
  return new InputRule({
    find: rule.find,
    handler: (props) => {
      const markerStart = props.state.doc.resolve(props.range.from);
      if (markerStart.depth === 1 && documentFenceStateBefore(props.state.doc, markerStart.before(1)) !== undefined) return null;
      return rule.handler(props);
    }
  });
}

const listItemConfig: NodeConfig = {
  name: "listItem",
  group: "block",
  content: "paragraph block*",
  defining: true,
  parseHTML: () => [{ tag: "li" }],
  renderHTML: ({ HTMLAttributes }) => ["li", mergeAttributes(HTMLAttributes), 0]
};

export const ComposerListItem = Node.create(listItemConfig);

export const ComposerBulletList = Node.create({
  name: "bulletList",
  group: "block",
  content: "listItem+",
  defining: true,
  addAttributes() {
    return {
      marker: {
        default: "-",
        parseHTML: (element: HTMLElement) => ["+", "*", "•"].includes(element.getAttribute("data-marker") ?? "") ? element.getAttribute("data-marker") : "-",
        renderHTML: (attrs: Record<string, unknown>) => attrs["marker"] === "-" ? {} : { "data-marker": attrs["marker"] }
      },
      separator: {
        default: " ",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-separator") || " ",
        renderHTML: (attrs: Record<string, unknown>) => attrs["separator"] === " " ? {} : { "data-separator": attrs["separator"] }
      }
    };
  },
  parseHTML: () => [{ tag: "ul" }],
  renderHTML: ({ HTMLAttributes }) => ["ul", mergeAttributes(HTMLAttributes), 0],
  addInputRules() {
    return [
      fenceAwareWrappingInputRule({
        find: BULLET_MARKER_RE,
        type: this.type,
        joinPredicate: (match, before) => before.attrs["marker"] === match[1] && before.attrs["separator"] === match[2],
        getAttributes: (match) => ({ marker: match[1] as BulletMarker, separator: match[2] })
      }),
      hardBreakListInputRule(BULLET_MARKER_RE, this.type, (match) => ({ marker: match[1] as BulletMarker, separator: match[2] }))
    ];
  }
});

function orderedAttrs(match: RegExpMatchArray): OrderedListAttrs {
  const marker = (match[2] ?? "、") as OrderedMarker;
  return { start: Number(match[1] ?? 1), marker, separator: marker === "、" ? "" : (match[3] ?? " ") };
}

function canJoinOrderedList(match: RegExpMatchArray, before: ProseMirrorNode): boolean {
  const attrs = orderedAttrs(match);
  return before.attrs["marker"] === attrs.marker
    && (before.attrs["separator"] ?? (attrs.marker === "、" ? "" : " ")) === attrs.separator
    && Number(before.attrs["start"]) + before.childCount === attrs.start;
}

export const ComposerOrderedList = Node.create({
  name: "orderedList",
  group: "block",
  content: "listItem+",
  defining: true,
  addAttributes() {
    return {
      start: {
        default: 1,
        parseHTML: (element: HTMLElement) => {
          const value = Number(element.getAttribute("start"));
          return Number.isInteger(value) && value > 0 ? value : 1;
        },
        renderHTML: (attrs: Record<string, unknown>) => attrs["start"] === 1 ? {} : { start: attrs["start"] }
      },
      marker: {
        default: ".",
        parseHTML: (element: HTMLElement) => [")", "、"].includes(element.getAttribute("data-marker") ?? "") ? element.getAttribute("data-marker") : ".",
        renderHTML: (attrs: Record<string, unknown>) => attrs["marker"] === "." ? {} : { "data-marker": attrs["marker"] }
      },
      separator: {
        default: " ",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-marker") === "、" ? "" : (element.getAttribute("data-separator") || " "),
        renderHTML: (attrs: Record<string, unknown>) => attrs["marker"] === "、" || attrs["separator"] === " " ? {} : { "data-separator": attrs["separator"] }
      }
    };
  },
  parseHTML: () => [{ tag: "ol" }],
  renderHTML: ({ node, HTMLAttributes }) => {
    const start = Number(node.attrs["start"]);
    const finalOrdinal = start + Math.max(node.childCount - 1, 0);
    const markerDigits = Number.isInteger(start) && start > 0 && Number.isInteger(finalOrdinal) ? String(finalOrdinal).length : 1;
    return ["ol", mergeAttributes(HTMLAttributes, { "data-marker-digits": String(markerDigits) }), 0];
  },
  addInputRules() {
    return [
      fenceAwareWrappingInputRule({ find: ORDERED_MARKER_RE, type: this.type, joinPredicate: canJoinOrderedList, getAttributes: orderedAttrs }),
      fenceAwareWrappingInputRule({ find: CJK_ORDERED_MARKER_RE, type: this.type, joinPredicate: canJoinOrderedList, getAttributes: orderedAttrs }),
      hardBreakListInputRule(ORDERED_MARKER_RE, this.type, orderedAttrs),
      hardBreakListInputRule(CJK_ORDERED_MARKER_RE, this.type, orderedAttrs)
    ];
  }
});

function selectedListItemDepth(view: EditorView): number | undefined {
  const from = view.state.selection.$from;
  for (let depth = from.depth; depth > 0; depth -= 1) if (from.node(depth).type.name === "listItem") return depth;
  return undefined;
}

function selectedListItemIsEmpty(view: EditorView, depth: number): boolean {
  const item = view.state.selection.$from.node(depth);
  const paragraph = item.firstChild;
  return item.childCount === 1 && paragraph?.type.name === "paragraph"
    && paragraph.content.content.every((node) => node.isText && !(node.text ?? "").trim());
}

function selectedTaskPrefix(view: EditorView): SelectedTaskPrefix | undefined {
  const from = view.state.selection.$from;
  if (from.parent.type.name !== "paragraph") return undefined;
  const text = from.parent.textBetween(0, from.parent.content.size, "\uFFFC", "\uFFFC");
  const match = text.match(/^\[[ xX]\](?:[ \t]+|$)/u);
  if (match === null) return undefined;
  return {
    from: from.start(),
    to: from.start() + match[0].length,
    bodyIsEmpty: text.slice(match[0].length).trim().length === 0,
    caretAtOrAfterPrefix: from.parentOffset >= match[0].length,
    caretAtParagraphEnd: from.parentOffset === from.parent.content.size
  };
}

function selectedListItemIsOnlyTaskParagraph(view: EditorView, depth: number): boolean {
  const item = view.state.selection.$from.node(depth);
  return item.childCount === 1 && item.firstChild === view.state.selection.$from.parent;
}

function liftEmptyItem(view: EditorView, itemType: NodeType): boolean {
  const from = view.state.selection.$from;
  if (from.parent.type.name === "paragraph" && from.parent.content.size > 0) {
    view.dispatch(view.state.tr.delete(from.start(), from.end()));
  }
  return liftListItem(itemType)(view.state, view.dispatch);
}

function clearTaskPrefixAndLift(view: EditorView, depth: number, prefix: SelectedTaskPrefix): boolean {
  if (!prefix.bodyIsEmpty || !prefix.caretAtParagraphEnd || !selectedListItemIsOnlyTaskParagraph(view, depth)) return false;
  view.dispatch(view.state.tr.delete(prefix.from, prefix.to));
  const itemType = view.state.schema.nodes["listItem"];
  return itemType === undefined ? true : liftListItem(itemType)(view.state, view.dispatch);
}

function backspaceAfterList(view: EditorView): boolean {
  const { state } = view;
  const from = state.selection.$from;
  if (!state.selection.empty || from.depth !== 1 || from.parent.type.name !== "paragraph" || from.parent.content.size !== 0 || from.parentOffset !== 0) return false;
  const paragraphPosition = from.before(1);
  const previous = state.doc.resolve(paragraphPosition).nodeBefore;
  if (previous?.type.name !== "bulletList" && previous?.type.name !== "orderedList") return false;
  const transaction = state.tr.delete(paragraphPosition, paragraphPosition + from.parent.nodeSize);
  transaction.setSelection(Selection.near(transaction.doc.resolve(paragraphPosition), -1));
  view.dispatch(transaction.scrollIntoView());
  return true;
}

export function handleStructuredListBreak(view: EditorView): boolean {
  const { state } = view;
  const itemType = state.schema.nodes["listItem"];
  const depth = selectedListItemDepth(view);
  if (itemType === undefined || !state.selection.empty || depth === undefined) return false;
  const task = selectedTaskPrefix(view);
  if (task?.bodyIsEmpty === true && task.caretAtOrAfterPrefix && task.caretAtParagraphEnd) return clearTaskPrefixAndLift(view, depth, task);
  if (selectedListItemIsEmpty(view, depth)) return liftEmptyItem(view, itemType);
  const split = splitListItem(itemType)(state, view.dispatch);
  if (split && task?.caretAtOrAfterPrefix === true) view.dispatch(view.state.tr.insertText("[ ] ").scrollIntoView());
  return split;
}

export function handleStructuredListBackspace(view: EditorView): boolean {
  if (backspaceAfterList(view)) return true;
  const { state } = view;
  const itemType = state.schema.nodes["listItem"];
  const depth = selectedListItemDepth(view);
  if (itemType === undefined || depth === undefined || !state.selection.empty) return false;
  const from = state.selection.$from;
  const task = selectedTaskPrefix(view);
  if (task !== undefined) {
    return task.bodyIsEmpty && task.caretAtOrAfterPrefix && task.caretAtParagraphEnd
      ? clearTaskPrefixAndLift(view, depth, task)
      : false;
  }
  const empty = selectedListItemIsEmpty(view, depth);
  if (!empty || (from.parentOffset !== 0 && from.parentOffset !== from.parent.content.size)) return false;
  return liftEmptyItem(view, itemType);
}

function trailingPlainListParagraph(view: EditorView): { readonly paragraph: ProseMirrorNode; readonly marker: PlainListParagraphMarker; readonly position: number } | undefined {
  const { state } = view;
  const from = state.selection.$from;
  if (!state.selection.empty || from.depth !== 1 || from.parent.type.name !== "paragraph" || from.parentOffset !== from.parent.content.size || from.after(1) !== state.doc.content.size) return undefined;
  let hasHardBreak = false;
  from.parent.forEach((child) => { if (child.type.name === "hardBreak") hasHardBreak = true; });
  if (hasHardBreak) return undefined;
  const text = from.parent.textBetween(0, from.parent.content.size, "\uFFFC", "\uFFFC");
  const marker = plainListParagraphMarker(text);
  if (marker === undefined || from.parent.firstChild?.type.name !== "text" || (from.parent.firstChild.text?.length ?? 0) < marker.prefixLength) return undefined;
  return { paragraph: from.parent, marker, position: from.before(1) };
}

export function promoteTrailingPlainListParagraph(view: EditorView): boolean {
  const trailing = trailingPlainListParagraph(view);
  if (trailing === undefined || documentFenceStateBefore(view.state.doc, trailing.position) !== undefined) return false;
  const paragraphType = view.state.schema.nodes["paragraph"];
  const itemType = view.state.schema.nodes["listItem"];
  const listType = view.state.schema.nodes[trailing.marker.kind === "ordered" ? "orderedList" : "bulletList"];
  if (paragraphType === undefined || itemType === undefined || listType === undefined) return false;
  const body = trailing.paragraph.content.cut(trailing.marker.prefixLength);
  const list = listType.create(trailing.marker.attrs, itemType.create(null, paragraphType.create(trailing.paragraph.attrs, body)));
  const transaction = view.state.tr.replaceWith(trailing.position, trailing.position + trailing.paragraph.nodeSize, list);
  transaction.setSelection(TextSelection.atEnd(transaction.doc));
  view.dispatch(transaction.scrollIntoView());
  return true;
}

export function isTrailingEmptyTopLevelParagraph(view: EditorView): boolean {
  const { state } = view;
  const from = state.selection.$from;
  if (!state.selection.empty || from.depth !== 1 || from.parent.type.name !== "paragraph"
    || from.parentOffset !== from.parent.content.size || from.after(1) !== state.doc.content.size) return false;
  return from.parent.content.size === 0
    || (from.parent.childCount === 1 && from.parent.firstChild?.type.name === "hardBreak");
}

export function isTopLevelBlockSelection(view: EditorView): boolean {
  const { state } = view;
  const { $from: from, $to: to } = state.selection;
  if (!state.selection.empty && from.depth === 1 && to.depth === 1
    && from.parentOffset === 0 && to.parentOffset === to.parent.content.size) return true;
  return !state.selection.empty && from.depth === 0 && to.depth === 0
    && from.pos === 0 && to.pos === state.doc.content.size;
}
