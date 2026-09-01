import { redo, undo } from "@codemirror/commands";
import { EditorSelection, Facet, Prec, StateField, type ChangeSpec, type Extension, type Text } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate
} from "@codemirror/view";

export type WorkspaceMarkdownTableAction =
  | "add-row-above"
  | "add-row-below"
  | "delete-row"
  | "add-column-left"
  | "add-column-right"
  | "delete-column"
  | "delete-table";

export interface WorkspaceMarkdownTableLabels {
  readonly addRowAbove: string;
  readonly addRowBelow: string;
  readonly deleteRow: string;
  readonly addColumnLeft: string;
  readonly addColumnRight: string;
  readonly deleteColumn: string;
  readonly deleteTable: string;
}

export interface WorkspaceMarkdownTableModel {
  readonly header: readonly string[];
  readonly alignments: readonly ("left" | "center" | "right" | null)[];
  readonly rows: readonly (readonly string[])[];
  /** Keep source widths so a drag can be serialized deterministically. */
  readonly sourceWidths?: readonly number[];
  /** Source-relative cell content ranges let ordinary edits avoid reformatting the table. */
  readonly headerSources?: readonly (WorkspaceMarkdownTableCellSource | undefined)[];
  readonly rowSources?: readonly (readonly (WorkspaceMarkdownTableCellSource | undefined)[])[];
}

export interface WorkspaceMarkdownTableCellSource {
  readonly from: number;
  readonly to: number;
}

export interface WorkspaceMarkdownTableBlock {
  readonly from: number;
  readonly to: number;
  readonly source: string;
  readonly model: WorkspaceMarkdownTableModel;
  readonly startLine: number;
  readonly endLine: number;
}

export interface WorkspaceMarkdownLinePreview {
  readonly kind: "heading" | "quote" | "task" | "bullet" | "ordered" | "horizontal-rule" | "text";
  readonly level?: number;
  readonly prefixFrom: number;
  readonly prefixTo: number;
  readonly marker?: string;
}

export const DEFAULT_WORKSPACE_MARKDOWN_TABLE_LABELS: WorkspaceMarkdownTableLabels = {
  addRowAbove: "Add row above",
  addRowBelow: "Add row below",
  deleteRow: "Delete row",
  addColumnLeft: "Add column left",
  addColumnRight: "Add column right",
  deleteColumn: "Delete column",
  deleteTable: "Delete table"
};

const tableLabelsFacet = Facet.define<WorkspaceMarkdownTableLabels, WorkspaceMarkdownTableLabels>({
  combine: (values) => values[0] ?? DEFAULT_WORKSPACE_MARKDOWN_TABLE_LABELS
});

const menuCleanup = new WeakMap<HTMLElement, () => void>();

/** Markdown-only extensions used by the shared workspace CodeMirror surface. */
export function workspaceMarkdownLivePreviewExtensions(labels: WorkspaceMarkdownTableLabels): readonly Extension[] {
  return [
    tableLabelsFacet.of(labels),
    workspaceMarkdownTableField,
    workspaceMarkdownFormattingKeymap,
    workspaceMarkdownLinePreviewPlugin,
    workspaceMarkdownMouseSelection
  ];
}

export function classifyWorkspaceMarkdownLine(text: string): WorkspaceMarkdownLinePreview {
  const heading = /^(#{1,6})\s+/u.exec(text);
  if (heading !== null) return {
    kind: "heading",
    level: heading[1]!.length,
    prefixFrom: 0,
    prefixTo: heading[0].length
  };
  const task = /^(\s*)[-*+]\s+\[([ xX])\]\s+/u.exec(text);
  if (task !== null) return {
    kind: "task",
    prefixFrom: task[1]!.length,
    prefixTo: task[0].length,
    marker: task[2]!.toLowerCase() === "x" ? "checked" : "unchecked"
  };
  const bullet = /^(\s*)[-*+]\s+/u.exec(text);
  if (bullet !== null) return {
    kind: "bullet",
    prefixFrom: bullet[1]!.length,
    prefixTo: bullet[0].length,
    marker: "bullet"
  };
  const ordered = /^(\s*)(\d+[.)])\s+/u.exec(text);
  if (ordered !== null) return {
    kind: "ordered",
    prefixFrom: ordered[1]!.length,
    prefixTo: ordered[0].length,
    marker: `${ordered[2]} `
  };
  const quote = /^(\s*)>\s?/u.exec(text);
  if (quote !== null) return {
    kind: "quote",
    prefixFrom: quote[1]!.length,
    prefixTo: quote[0].length
  };
  const horizontalRule = /^(\s*)(?:-{3,}|\*{3,}|_{3,})\s*$/u.exec(text);
  if (horizontalRule !== null) return {
    kind: "horizontal-rule",
    prefixFrom: horizontalRule[1]!.length,
    prefixTo: text.length
  };
  return { kind: "text", prefixFrom: 0, prefixTo: 0 };
}

type FenceRole = "first" | "body" | "last";

export function computeWorkspaceMarkdownFenceLines(doc: Text): ReadonlyMap<number, FenceRole> {
  const roles = new Map<number, FenceRole>();
  for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
    const opener = /^ {0,3}(`{3,}|~{3,})/u.exec(doc.line(lineNumber).text)?.[1];
    if (opener === undefined) continue;
    const character = opener[0] === "`" ? "`" : "~";
    const closing = new RegExp(`^ {0,3}${character}{${opener.length},}\\s*$`, "u");
    let closingLine = -1;
    for (let candidate = lineNumber + 1; candidate <= doc.lines; candidate += 1) {
      if (closing.test(doc.line(candidate).text)) {
        closingLine = candidate;
        break;
      }
    }
    if (closingLine < 0) break;
    roles.set(lineNumber, "first");
    for (let bodyLine = lineNumber + 1; bodyLine < closingLine; bodyLine += 1) roles.set(bodyLine, "body");
    roles.set(closingLine, "last");
    lineNumber = closingLine;
  }
  return roles;
}

class MarkdownMarkerWidget extends WidgetType {
  constructor(
    private readonly kind: "empty" | "bullet" | "ordered" | "checked" | "unchecked",
    private readonly label = ""
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const marker = document.createElement("span");
    marker.className = `cm-md-marker cm-md-marker-${this.kind}`;
    marker.setAttribute("aria-hidden", "true");
    marker.textContent = this.kind === "bullet"
      ? "• "
      : this.kind === "checked"
        ? "☑ "
        : this.kind === "unchecked"
          ? "☐ "
          : this.kind === "ordered"
            ? this.label
            : "";
    return marker;
  }

  override eq(other: MarkdownMarkerWidget): boolean {
    return other.kind === this.kind && other.label === this.label;
  }
}

class MarkdownHorizontalRuleWidget extends WidgetType {
  toDOM(): HTMLElement {
    const rule = document.createElement("span");
    rule.className = "cm-md-horizontal-rule";
    rule.setAttribute("aria-hidden", "true");
    return rule;
  }
}

const emptyMarker = Decoration.replace({ widget: new MarkdownMarkerWidget("empty") });
const bulletMarker = Decoration.replace({ widget: new MarkdownMarkerWidget("bullet") });
const checkedMarker = Decoration.replace({ widget: new MarkdownMarkerWidget("checked") });
const uncheckedMarker = Decoration.replace({ widget: new MarkdownMarkerWidget("unchecked") });
const horizontalRule = Decoration.replace({ widget: new MarkdownHorizontalRuleWidget() });

const workspaceMarkdownLinePreviewPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  private fenceLines: ReadonlyMap<number, FenceRole>;
  private tableLines: ReadonlySet<number>;

  constructor(view: EditorView) {
    this.fenceLines = computeWorkspaceMarkdownFenceLines(view.state.doc);
    this.tableLines = workspaceMarkdownTableLineNumbers(view.state.doc);
    this.decorations = this.build(view);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged) {
      this.fenceLines = computeWorkspaceMarkdownFenceLines(update.state.doc);
      this.tableLines = workspaceMarkdownTableLineNumbers(update.state.doc);
    }
    if (update.docChanged || update.viewportChanged || update.selectionSet || update.focusChanged) {
      this.decorations = this.build(update.view);
    }
  }

  private build(view: EditorView): DecorationSet {
    const ranges: ReturnType<Decoration["range"]>[] = [];
    const seen = new Set<number>();
    for (const visible of view.visibleRanges) {
      let line = view.state.doc.lineAt(visible.from);
      while (line.from <= visible.to) {
        if (!seen.has(line.number) && !this.tableLines.has(line.number)) {
          seen.add(line.number);
          const fenceRole = this.fenceLines.get(line.number);
          const revealed = lineIsRevealed(view, line.from, line.to);
          if (fenceRole !== undefined) {
            ranges.push(Decoration.line({ class: `cm-md-fence-line cm-md-fence-${fenceRole}` }).range(line.from));
            if (!revealed && fenceRole !== "body" && line.from < line.to) {
              ranges.push(emptyMarker.range(line.from, line.to));
            }
          } else {
            addLinePreviewRanges(ranges, line.from, line.text, revealed);
          }
        }
        if (line.to >= view.state.doc.length) break;
        line = view.state.doc.line(line.number + 1);
      }
    }
    return Decoration.set(ranges, true);
  }
}, { decorations: (plugin) => plugin.decorations });

function lineIsRevealed(view: EditorView, lineFrom: number, lineTo: number): boolean {
  if (!view.hasFocus) return false;
  return view.state.selection.ranges.some((selection) => {
    const from = Math.min(selection.anchor, selection.head);
    const to = Math.max(selection.anchor, selection.head);
    return selection.empty
      ? selection.anchor >= lineFrom && selection.anchor <= lineTo
      : from <= lineTo && to >= lineFrom;
  });
}

function addLinePreviewRanges(
  ranges: ReturnType<Decoration["range"]>[],
  lineFrom: number,
  text: string,
  revealed: boolean
): void {
  const preview = classifyWorkspaceMarkdownLine(text);
  const lineClass = preview.kind === "heading"
    ? `cm-md-heading-line cm-md-heading-${preview.level}`
    : preview.kind === "quote"
      ? "cm-md-quote-line"
      : preview.kind === "task"
        ? "cm-md-list-line cm-md-task-line"
        : preview.kind === "bullet" || preview.kind === "ordered"
          ? "cm-md-list-line"
          : undefined;
  if (lineClass !== undefined) ranges.push(Decoration.line({ class: lineClass }).range(lineFrom));
  if (revealed) return;

  if (preview.kind === "horizontal-rule") {
    if (preview.prefixFrom < preview.prefixTo) ranges.push(horizontalRule.range(lineFrom + preview.prefixFrom, lineFrom + preview.prefixTo));
    return;
  }
  if (preview.prefixFrom < preview.prefixTo) {
    const marker = preview.kind === "bullet"
      ? bulletMarker
      : preview.kind === "ordered"
        ? Decoration.replace({ widget: new MarkdownMarkerWidget("ordered", preview.marker) })
        : preview.kind === "task"
          ? preview.marker === "checked" ? checkedMarker : uncheckedMarker
          : emptyMarker;
    ranges.push(marker.range(lineFrom + preview.prefixFrom, lineFrom + preview.prefixTo));
  }

  for (const marker of inlineMarkdownMarkerRanges(text, preview.prefixTo)) {
    ranges.push(emptyMarker.range(lineFrom + marker.from, lineFrom + marker.to));
  }
}

/** Paired markers are concealed as independent source ranges off the cursor line. */
export function inlineMarkdownMarkerRanges(text: string, from = 0): readonly { readonly from: number; readonly to: number }[] {
  const candidates: { from: number; to: number; pairFrom: number; pairTo: number; priority: number }[] = [];
  const patterns: readonly { readonly expression: RegExp; readonly markerLength: number; readonly priority: number }[] = [
    { expression: /\*\*([^*\n]+)\*\*/gu, markerLength: 2, priority: 0 },
    { expression: /__([^_\n]+)__/gu, markerLength: 2, priority: 0 },
    { expression: /~~([^~\n]+)~~/gu, markerLength: 2, priority: 0 },
    { expression: /`([^`\n]+)`/gu, markerLength: 1, priority: 1 },
    { expression: /\*([^*\n]+)\*/gu, markerLength: 1, priority: 2 },
    { expression: /_([^_\n]+)_/gu, markerLength: 1, priority: 2 }
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern.expression)) {
      const start = match.index;
      if (start === undefined || start < from) continue;
      const end = start + match[0].length;
      candidates.push({
        from: start,
        to: start + pattern.markerLength,
        pairFrom: end - pattern.markerLength,
        pairTo: end,
        priority: pattern.priority
      });
    }
  }
  candidates.sort((left, right) => left.from - right.from || left.priority - right.priority || right.pairTo - left.pairTo);
  const occupied: { from: number; to: number }[] = [];
  const markers: { from: number; to: number }[] = [];
  for (const candidate of candidates) {
    if (occupied.some((range) => candidate.from < range.to && candidate.pairTo > range.from)) continue;
    occupied.push({ from: candidate.from, to: candidate.pairTo });
    markers.push(
      { from: candidate.from, to: candidate.to },
      { from: candidate.pairFrom, to: candidate.pairTo }
    );
  }
  return markers.sort((left, right) => left.from - right.from || left.to - right.to);
}

export function parseWorkspaceMarkdownTable(source: string): WorkspaceMarkdownTableModel | null {
  const lines = splitTableLinesWithOffsets(source);
  if (lines.length < 2 || !isTableSeparator(lines[1]!.text)) return null;
  const headerCells = splitTableRowWithRanges(lines[0]!.text, lines[0]!.from);
  const separatorCells = splitTableRowWithRanges(lines[1]!.text, lines[1]!.from);
  const header = headerCells.map((cell) => cell.text.trim());
  const separator = separatorCells.map((cell) => cell.text.trim());
  if (header.length < 2 || separator.length < 2) return null;
  const columnCount = Math.max(header.length, separator.length);
  const rowCells = lines.slice(2).map((line) => splitTableRowWithRanges(line.text, line.from));
  return {
    header: normalizeTableRow(header, columnCount),
    alignments: normalizeTableAlignments(separator.map(tableAlignment), columnCount),
    rows: rowCells.map((cells) => normalizeTableRow(cells.map((cell) => cell.text.trim()), columnCount)),
    sourceWidths: computeTableSourceWidths([headerCells, separatorCells, ...rowCells], separatorCells, columnCount),
    headerSources: normalizeTableSources(headerCells.map((cell) => ({ from: cell.contentFrom, to: cell.contentTo })), columnCount),
    rowSources: rowCells.map((cells) => normalizeTableSources(
      cells.map((cell) => ({ from: cell.contentFrom, to: cell.contentTo })),
      columnCount
    ))
  };
}

export function serializeWorkspaceMarkdownTable(
  model: WorkspaceMarkdownTableModel,
  targetWidths = computeWorkspaceMarkdownColumnWidths(model)
): string {
  const columnCount = workspaceMarkdownTableColumnCount(model);
  const widths = normalizeWorkspaceMarkdownColumnWidths(targetWidths, columnCount);
  const row = (cells: readonly string[]): string => `| ${widths.map((width, column) => escapeTableCell(cells[column] ?? "").padEnd(width)).join(" | ")} |`;
  const separator = `| ${widths.map((width, column) => {
    const dashes = "-".repeat(width);
    const alignment = model.alignments[column] ?? null;
    if (alignment === "left") return `:${dashes.slice(1)}`;
    if (alignment === "right") return `${dashes.slice(0, -1)}:`;
    if (alignment === "center") return `:${dashes.slice(2)}:`;
    return dashes;
  }).join(" | ")} |`;
  return [row(model.header), separator, ...model.rows.map(row)].join("\n");
}

export function mutateWorkspaceMarkdownTable(
  model: WorkspaceMarkdownTableModel,
  action: Exclude<WorkspaceMarkdownTableAction, "delete-table">,
  rowIndex: number,
  columnIndex: number
): WorkspaceMarkdownTableModel | null {
  const columnCount = workspaceMarkdownTableColumnCount(model);
  const header = [...normalizeTableRow(model.header, columnCount)];
  const alignments = [...normalizeTableAlignments(model.alignments, columnCount)];
  const rows = model.rows.map((row) => [...normalizeTableRow(row, columnCount)]);
  const sourceWidths = normalizeWorkspaceMarkdownColumnWidths(model.sourceWidths ?? [], columnCount);

  if (action === "add-row-above" || action === "add-row-below") {
    const bodyIndex = rowIndex <= 0 ? 0 : Math.min(rowIndex - 1, rows.length);
    const insertion = action === "add-row-above" ? bodyIndex : Math.min(bodyIndex + 1, rows.length);
    rows.splice(insertion, 0, Array.from({ length: columnCount }, () => ""));
  } else if (action === "delete-row") {
    if (rowIndex <= 0 || rows.length === 0) return null;
    rows.splice(Math.min(rowIndex - 1, rows.length - 1), 1);
  } else if (action === "add-column-left" || action === "add-column-right") {
    const insertion = Math.min(
      Math.max(0, columnIndex + (action === "add-column-right" ? 1 : 0)),
      columnCount
    );
    header.splice(insertion, 0, "");
    alignments.splice(insertion, 0, null);
    sourceWidths.splice(insertion, 0, Math.max(3, sourceWidths[columnIndex] ?? 8));
    for (const row of rows) row.splice(insertion, 0, "");
  } else {
    if (columnCount <= 2) return null;
    const removal = Math.min(Math.max(0, columnIndex), columnCount - 1);
    header.splice(removal, 1);
    alignments.splice(removal, 1);
    sourceWidths.splice(removal, 1);
    for (const row of rows) row.splice(removal, 1);
  }
  return { header, alignments, rows, sourceWidths };
}

export function workspaceMarkdownTableInsertion(
  source: string,
  requestedPosition: number
): { readonly from: number; readonly to: number; readonly insert: string; readonly cursor: number } {
  return workspaceMarkdownTableInsertionAt(source, requestedPosition, false)!;
}

/** The Enter binding only expands a sole `/table` line. */
export function workspaceMarkdownSlashTableInsertion(
  source: string,
  requestedPosition: number
): { readonly from: number; readonly to: number; readonly insert: string; readonly cursor: number } | null {
  return workspaceMarkdownTableInsertionAt(source, requestedPosition, true);
}

function workspaceMarkdownTableInsertionAt(
  source: string,
  requestedPosition: number,
  requireSlashCommand: boolean
): { readonly from: number; readonly to: number; readonly insert: string; readonly cursor: number } | null {
  const position = Math.min(Math.max(0, requestedPosition), source.length);
  const lineFrom = source.lastIndexOf("\n", Math.max(0, position - 1)) + 1;
  const nextBreak = source.indexOf("\n", position);
  const lineTo = nextBreak < 0 ? source.length : nextBreak;
  const line = source.slice(lineFrom, lineTo);
  const trimmed = line.trim();
  const table = "| Header 1 | Header 2 |\n| --- | --- |\n|  |  |\n|  |  |";
  if (requireSlashCommand && trimmed !== "/table") return null;
  if (trimmed === "/table") return { from: lineFrom, to: lineTo, insert: table, cursor: lineFrom + table.length };
  if (trimmed === "") {
    const previousLine = lineFrom > 0
      ? source.slice(source.lastIndexOf("\n", Math.max(0, lineFrom - 2)) + 1, lineFrom - 1)
      : "";
    const followingFrom = lineTo < source.length ? lineTo + 1 : source.length;
    const followingBreak = source.indexOf("\n", followingFrom);
    const followingLine = source.slice(followingFrom, followingBreak < 0 ? source.length : followingBreak);
    const insert = `${isMarkdownTableSourceLine(previousLine) ? "\n" : ""}${table}${isMarkdownTableSourceLine(followingLine) ? "\n" : ""}`;
    return { from: lineFrom, to: lineTo, insert, cursor: lineFrom + insert.length };
  }
  const leadingBreak = lineTo < source.length ? "\n\n" : "\n";
  const followingFrom = lineTo < source.length ? lineTo + 1 : source.length;
  const followingBreak = source.indexOf("\n", followingFrom);
  const followingLine = source.slice(followingFrom, followingBreak < 0 ? source.length : followingBreak);
  const insert = `${leadingBreak}${table}${isMarkdownTableSourceLine(followingLine) ? "\n" : ""}`;
  return { from: lineTo, to: lineTo, insert, cursor: lineTo + insert.length };
}

export function insertWorkspaceMarkdownTable(view: EditorView, coordinates?: { readonly x: number; readonly y: number }): boolean {
  if (view.state.readOnly) return false;
  const coordinatePosition = coordinates === undefined ? null : view.posAtCoords(coordinates, false);
  const insertion = workspaceMarkdownTableInsertion(
    view.state.doc.toString(),
    coordinatePosition ?? view.state.selection.main.from
  );
  view.dispatch({
    changes: { from: insertion.from, to: insertion.to, insert: insertion.insert },
    selection: EditorSelection.cursor(insertion.cursor),
    userEvent: "input"
  });
  view.focus();
  return true;
}

function insertWorkspaceMarkdownTableShortcut(view: EditorView): boolean {
  if (view.state.readOnly || !view.state.selection.main.empty) return false;
  const insertion = workspaceMarkdownSlashTableInsertion(view.state.doc.toString(), view.state.selection.main.from);
  if (insertion === null) return false;
  view.dispatch({
    changes: { from: insertion.from, to: insertion.to, insert: insertion.insert },
    selection: EditorSelection.cursor(insertion.cursor),
    userEvent: "input"
  });
  return true;
}

function toggleWorkspaceMarkdownStrong(view: EditorView): boolean {
  if (view.state.readOnly) return false;
  const transaction = view.state.changeByRange((range) => {
    const doc = view.state.doc;
    const from = Math.min(range.anchor, range.head);
    const to = Math.max(range.anchor, range.head);
    const line = doc.lineAt(from);
    const overlap = findWorkspaceDocumentStrongRange(line.text, from, to, line.from);
    if (overlap !== null) {
      const selectionFrom = range.empty
        ? Math.min(Math.max(range.from - 2, overlap.openFrom), overlap.closeFrom - 2)
        : Math.max(from - 2, overlap.openFrom);
      const selectionTo = range.empty ? selectionFrom : Math.min(to - 2, overlap.closeFrom - 2);
      return {
        changes: [
          { from: overlap.closeFrom, to: overlap.closeTo },
          { from: overlap.openFrom, to: overlap.openTo }
        ],
        range: range.empty
          ? EditorSelection.cursor(selectionFrom)
          : EditorSelection.range(selectionFrom, selectionTo)
      };
    }
    if (!range.empty) {
      return {
        changes: [{ from: to, insert: "**" }, { from, insert: "**" }],
        range: EditorSelection.range(from + 2, to + 2)
      };
    }
    const word = findWorkspaceDocumentStrongTarget(doc, range.from);
    if (word !== null) {
      return {
        changes: [{ from: word.to, insert: "**" }, { from: word.from, insert: "**" }],
        range: EditorSelection.range(word.from + 2, word.to + 2)
      };
    }
    return {
      changes: { from: range.from, insert: "****" },
      range: EditorSelection.cursor(range.from + 2)
    };
  });
  view.dispatch(transaction, { userEvent: "input" });
  return true;
}

function findWorkspaceDocumentStrongRange(
  text: string,
  from: number,
  to: number,
  lineFrom: number
): { readonly openFrom: number; readonly openTo: number; readonly closeFrom: number; readonly closeTo: number } | null {
  for (const match of text.matchAll(/\*\*([^*\n]+)\*\*/gu)) {
    const start = match.index;
    if (start === undefined) continue;
    const range = {
      openFrom: lineFrom + start,
      openTo: lineFrom + start + 2,
      closeFrom: lineFrom + start + match[0].length - 2,
      closeTo: lineFrom + start + match[0].length
    };
    if (from === to) {
      if (from >= range.openTo && from <= range.closeFrom) return range;
    } else if (from < range.closeTo && to > range.openFrom) {
      return range;
    }
  }
  return null;
}

function findWorkspaceDocumentStrongTarget(doc: Text, position: number): { readonly from: number; readonly to: number } | null {
  const line = doc.lineAt(position);
  const text = line.text;
  let local = position - line.from;
  if (local > 0 && (local === text.length || workspaceMarkdownStrongBoundary(text[local]))) local -= 1;
  if (local < 0 || local >= text.length || workspaceMarkdownStrongBoundary(text[local])) return null;
  let from = line.from + local;
  let to = from + 1;
  while (from > line.from && !workspaceMarkdownStrongBoundary(doc.sliceString(from - 1, from))) from -= 1;
  while (to < line.to && !workspaceMarkdownStrongBoundary(doc.sliceString(to, to + 1))) to += 1;
  return from < to ? { from, to } : null;
}

const workspaceMarkdownFormattingKeymap = Prec.high(keymap.of([
  { key: "Mod-z", run: (view) => runWorkspaceHistoryPreservingScroll(view, undo) },
  { key: "Mod-Shift-z", run: (view) => runWorkspaceHistoryPreservingScroll(view, redo) },
  { key: "Mod-y", run: (view) => runWorkspaceHistoryPreservingScroll(view, redo) },
  { key: "Enter", run: insertWorkspaceMarkdownTableShortcut },
  { key: "Mod-b", run: toggleWorkspaceMarkdownStrong }
]));

// Conceal/reveal can reflow a Markdown line between clicks. Reuse the first
// click's document coordinate so double/triple click and drag keep targeting
// the character the user actually aimed at.
const lastWorkspaceMarkdownPrimaryClickPosition = new WeakMap<EditorView, number>();

const workspaceMarkdownMouseSelection = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0 || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false;
    const target = event.target instanceof Element ? event.target : null;
    if (target !== null && target.closest(".cm-md-table-widget, .cm-md-image-widget, .cm-md-mermaid-widget") !== null) return false;
    const coordinatePosition = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
    if (coordinatePosition === null) return false;
    const stored = event.detail >= 2 ? lastWorkspaceMarkdownPrimaryClickPosition.get(view) : undefined;
    const position = stored === undefined ? coordinatePosition : Math.min(stored, view.state.doc.length);
    if (event.detail === 1) lastWorkspaceMarkdownPrimaryClickPosition.set(view, coordinatePosition);
    if (event.detail === 2) {
      event.preventDefault();
      view.focus();
      const word = findWorkspaceMarkdownVisibleWordAt(view, position);
      view.dispatch({ selection: EditorSelection.range(word.from, word.to) });
      return true;
    }
    if (event.detail >= 3) {
      event.preventDefault();
      view.focus();
      const line = view.state.doc.lineAt(position);
      view.dispatch({ selection: EditorSelection.range(line.from, line.to) });
      return true;
    }
    event.preventDefault();
    view.focus();
    view.dispatch({ selection: EditorSelection.cursor(position) });
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    const cleanup = (): void => {
      document.removeEventListener("mousemove", onMouseMove, true);
      document.removeEventListener("mouseup", onMouseUp, true);
    };
    const onMouseMove = (moveEvent: MouseEvent): void => {
      const moved = Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY);
      if (!dragging && moved <= 4) return;
      dragging = true;
      moveEvent.preventDefault();
      const head = view.posAtCoords({ x: moveEvent.clientX, y: moveEvent.clientY }, false);
      if (head !== null) view.dispatch({ selection: EditorSelection.range(position, head) });
    };
    const onMouseUp = (upEvent: MouseEvent): void => {
      cleanup();
      upEvent.preventDefault();
      if (!dragging) view.dispatch({ selection: EditorSelection.cursor(position) });
    };
    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("mouseup", onMouseUp, true);
    return true;
  }
});

function findWorkspaceMarkdownVisibleWordAt(view: EditorView, position: number): { readonly from: number; readonly to: number } {
  const line = view.state.doc.lineAt(position);
  const visibleStart = workspaceMarkdownVisibleContentStart(line.text);
  const localPosition = position - line.from;
  if (localPosition < visibleStart) return { from: line.from, to: line.from + visibleStart };
  let from = localPosition;
  let to = localPosition;
  while (from > visibleStart && !workspaceMarkdownStrongBoundary(line.text[from - 1])) from -= 1;
  while (to < line.text.length && !workspaceMarkdownStrongBoundary(line.text[to])) to += 1;
  if (from === to) {
    if (from > visibleStart) from -= 1;
    else if (to < line.text.length) to += 1;
  }
  return { from: line.from + from, to: line.from + to };
}

function workspaceMarkdownVisibleContentStart(text: string): number {
  return /^#{1,6}\s+/u.exec(text)?.[0].length
    ?? /^\s*[-*+]\s+\[[ xX]\]\s+/u.exec(text)?.[0].length
    ?? /^\s*[-*+]\s+/u.exec(text)?.[0].length
    ?? /^\s*\d+[.)]\s+/u.exec(text)?.[0].length
    ?? /^\s*>\s?/u.exec(text)?.[0].length
    ?? 0;
}

const workspaceMarkdownTableField = StateField.define<DecorationSet>({
  create: (state) => buildWorkspaceMarkdownTableDecorations(state.doc),
  update(value, transaction) {
    return transaction.docChanged ? buildWorkspaceMarkdownTableDecorations(transaction.state.doc) : value;
  },
  provide: (field) => EditorView.decorations.from(field)
});

function buildWorkspaceMarkdownTableDecorations(doc: Text): DecorationSet {
  return Decoration.set(collectWorkspaceMarkdownTables(doc).map((block) => Decoration.replace({
    block: true,
    widget: new WorkspaceMarkdownTableWidget(block)
  }).range(block.from, block.to)), true);
}

function collectWorkspaceMarkdownTables(doc: Text): readonly WorkspaceMarkdownTableBlock[] {
  const blocks: WorkspaceMarkdownTableBlock[] = [];
  const fenceLines = computeWorkspaceMarkdownFenceLines(doc);
  let lineNumber = 1;
  while (lineNumber < doc.lines) {
    const header = doc.line(lineNumber);
    const separator = doc.line(lineNumber + 1);
    if (fenceLines.has(lineNumber) || fenceLines.has(lineNumber + 1) || !looksLikeTableRow(header.text) || !isTableSeparator(separator.text)) {
      lineNumber += 1;
      continue;
    }
    let endLine = lineNumber + 1;
    while (endLine < doc.lines && looksLikeTableRow(doc.line(endLine + 1).text)) endLine += 1;
    const from = header.from;
    const to = doc.line(endLine).to;
    const source = doc.sliceString(from, to);
    const model = parseWorkspaceMarkdownTable(source);
    if (model !== null) blocks.push({ from, to, source, model, startLine: lineNumber, endLine });
    lineNumber = endLine + 1;
  }
  return blocks;
}

function workspaceMarkdownTableLineNumbers(doc: Text): ReadonlySet<number> {
  const lines = new Set<number>();
  for (const block of collectWorkspaceMarkdownTables(doc)) {
    for (let line = block.startLine; line <= block.endLine; line += 1) lines.add(line);
  }
  return lines;
}

class WorkspaceMarkdownTableWidget extends WidgetType {
  constructor(private readonly block: WorkspaceMarkdownTableBlock) {
    super();
  }

  override eq(other: WorkspaceMarkdownTableWidget): boolean {
    return other.block.from === this.block.from && other.block.source === this.block.source;
  }

  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement("div");
    root.className = "cm-md-table-widget";
    root.contentEditable = "false";
    const table = document.createElement("table");
    const colgroup = document.createElement("colgroup");
    const columnCount = workspaceMarkdownTableColumnCount(this.block.model);
    const sourceWidths = normalizeWorkspaceMarkdownColumnWidths(this.block.model.sourceWidths ?? [], columnCount);
    sourceWidths.forEach((_, column) => {
      const element = document.createElement("col");
      element.dataset.column = String(column);
      colgroup.append(element);
    });
    table.append(colgroup);
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    this.block.model.header.forEach((text, column) => headRow.append(this.createCell(view, root, "th", 0, column, text)));
    head.append(headRow);
    table.append(head);
    const body = document.createElement("tbody");
    this.block.model.rows.forEach((row, rowIndex) => {
      const element = document.createElement("tr");
      row.forEach((text, column) => element.append(this.createCell(view, root, "td", rowIndex + 1, column, text)));
      body.append(element);
    });
    table.append(body);
    root.append(table, this.createMenu(view, root));
    applyWorkspaceMarkdownColumnWidths(root, sourceWidths);

    root.addEventListener("focusin", (event) => {
      const cell = tableCellFromTarget(root, event.target);
      if (cell === null) return;
      rememberActiveCell(root, cell);
      renderWorkspaceMarkdownTableCells(root, cell);
    });
    root.addEventListener("focusout", (event) => {
      if (event.relatedTarget instanceof Node && root.contains(event.relatedTarget)) return;
      this.commit(view, root);
      renderWorkspaceMarkdownTableCells(root, null);
    });
    root.addEventListener("contextmenu", (event) => {
      const cell = tableCellFromTarget(root, event.target);
      if (cell === null || view.state.readOnly) return;
      event.preventDefault();
      event.stopPropagation();
      rememberActiveCell(root, cell);
      renderWorkspaceMarkdownTableCells(root, cell);
      openTableMenu(root, cell, event.clientX, event.clientY);
    });
    root.addEventListener("pointerdown", (event) => {
      if (event.target instanceof Element && event.target.closest(".cm-md-table-menu") !== null) return;
      closeTableMenu(root);
    }, true);
    return root;
  }

  override ignoreEvent(event: Event): boolean {
    return event.type !== "blur";
  }

  override destroy(dom: HTMLElement): void {
    closeTableMenu(dom);
  }

  private createCell(
    view: EditorView,
    root: HTMLElement,
    tag: "th" | "td",
    row: number,
    column: number,
    text: string
  ): HTMLTableCellElement {
    const cell = document.createElement(tag);
    cell.contentEditable = view.state.readOnly ? "false" : "true";
    cell.spellcheck = false;
    cell.dataset.row = String(row);
    cell.dataset.column = String(column);
    cell.dataset.sourceText = text;
    renderWorkspaceInlineMarkdown(cell, text);

    if (tag === "th") {
      const handle = document.createElement("span");
      handle.className = "cm-md-table-resize-handle";
      handle.contentEditable = "false";
      handle.setAttribute("aria-hidden", "true");
      handle.addEventListener("pointerdown", (event) => this.startColumnResize(view, root, column, event));
      cell.append(handle);
    }

    cell.addEventListener("keydown", (event) => {
      const isMac = isMacPlatform();
      const shortcut = workspaceMarkdownTableShortcutAction(event, isMac);
      if (shortcut === "undo" || shortcut === "redo") {
        event.preventDefault();
        event.stopPropagation();
        cell.dataset.sourceText = workspaceMarkdownTableCellEditingText(cell);
        this.commit(view, root, { preserveFocus: true });
        const command = shortcut === "redo" ? redo : undo;
        runWorkspaceHistoryPreservingScroll(view, command);
        return;
      }
      if (shortcut === "bold") {
        event.preventDefault();
        toggleWorkspaceStrongInTableCell(cell);
        return;
      }
      if (shortcut === "break") {
        event.preventDefault();
        insertWorkspaceMarkdownTableCellBreak(cell);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        cell.dataset.sourceText = workspaceMarkdownTableCellEditingText(cell);
        this.commit(view, root);
        cell.blur();
      } else if (event.key === "Tab") {
        event.preventDefault();
        cell.dataset.sourceText = workspaceMarkdownTableCellEditingText(cell);
        focusAdjacentTableCell(root, cell, event.shiftKey ? -1 : 1);
      }
      if (!WORKSPACE_TABLE_NAVIGATION_KEYS.has(event.key)) {
        window.requestAnimationFrame(() => {
          if (!workspaceMarkdownTableCellIsComposing(cell)) renderActiveWorkspaceMarkdownTableCell(cell);
        });
      }
    });
    cell.addEventListener("compositionstart", () => {
      cell.dataset.composing = "true";
    });
    cell.addEventListener("compositionend", () => {
      delete cell.dataset.composing;
      cell.dataset.sourceText = workspaceMarkdownTableCellEditingText(cell);
      window.requestAnimationFrame(() => renderActiveWorkspaceMarkdownTableCell(cell));
    });
    cell.addEventListener("input", () => {
      if (workspaceMarkdownTableCellIsComposing(cell)) return;
      cell.dataset.sourceText = workspaceMarkdownTableCellEditingText(cell);
      renderActiveWorkspaceMarkdownTableCell(cell);
    });
    cell.addEventListener("mouseup", () => {
      window.requestAnimationFrame(() => {
        rememberActiveCell(root, cell);
        renderActiveWorkspaceMarkdownTableCell(cell);
      });
    });
    return cell;
  }

  private startColumnResize(
    view: EditorView,
    root: HTMLElement,
    column: number,
    event: PointerEvent
  ): void {
    if (view.state.readOnly) return;
    event.preventDefault();
    event.stopPropagation();
    this.commit(view, root, { preserveFocus: true });

    const startX = event.clientX;
    const resizeStepPx = Math.max(1, estimateWorkspaceMarkdownCharacterWidth(root) * 0.25);
    const currentModel = tableModelFromDom(root, this.block.model);
    const startWidths = normalizeWorkspaceMarkdownColumnWidths(
      currentModel.sourceWidths ?? this.block.model.sourceWidths ?? [],
      workspaceMarkdownTableColumnCount(currentModel)
    );
    let nextWidths = [...startWidths];
    applyWorkspaceMarkdownColumnWidths(root, startWidths);

    const onPointerMove = (moveEvent: PointerEvent): void => {
      moveEvent.preventDefault();
      const deltaCharacters = Math.round((moveEvent.clientX - startX) / resizeStepPx);
      nextWidths = [...startWidths];
      nextWidths[column] = Math.max(3, (startWidths[column] ?? 3) + deltaCharacters);
      applyWorkspaceMarkdownColumnWidths(root, nextWidths);
    };
    const onPointerUp = (upEvent: PointerEvent): void => {
      document.removeEventListener("pointermove", onPointerMove, true);
      document.removeEventListener("pointerup", onPointerUp, true);
      upEvent.preventDefault();
      const model = tableModelFromDom(root, this.block.model);
      const insert = serializeWorkspaceMarkdownTable(model, nextWidths);
      if (insert === this.block.source) return;
      const widgetIndex = [...view.dom.querySelectorAll<HTMLElement>(".cm-md-table-widget")].indexOf(root);
      dispatchTableChange(view, { from: this.block.from, to: this.block.to, insert }, this.block.from);
      focusRebuiltWorkspaceMarkdownTableCell(view, widgetIndex, 0, column);
    };
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("pointerup", onPointerUp, true);
  }

  private createMenu(view: EditorView, root: HTMLElement): HTMLElement {
    const menu = document.createElement("div");
    menu.className = "cm-md-table-menu";
    menu.setAttribute("role", "menu");
    const labels = view.state.facet(tableLabelsFacet);
    const entries: readonly { readonly action: WorkspaceMarkdownTableAction; readonly label: string }[] = [
      { action: "add-row-above", label: labels.addRowAbove },
      { action: "add-row-below", label: labels.addRowBelow },
      { action: "delete-row", label: labels.deleteRow },
      { action: "add-column-left", label: labels.addColumnLeft },
      { action: "add-column-right", label: labels.addColumnRight },
      { action: "delete-column", label: labels.deleteColumn },
      { action: "delete-table", label: labels.deleteTable }
    ];
    entries.forEach((entry, index) => {
      if (index === 3 || index === 6) {
        const separator = document.createElement("div");
        separator.className = "cm-md-table-menu-separator";
        separator.setAttribute("role", "separator");
        menu.append(separator);
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "cm-md-table-menu-item";
      button.dataset.tableAction = entry.action;
      button.setAttribute("role", "menuitem");
      button.textContent = entry.label;
      button.addEventListener("pointerdown", (event) => event.preventDefault());
      button.addEventListener("click", (event) => {
        event.preventDefault();
        if (button.disabled) return;
        closeTableMenu(root);
        this.applyAction(view, root, entry.action);
      });
      menu.append(button);
    });
    return menu;
  }

  private applyAction(view: EditorView, root: HTMLElement, action: WorkspaceMarkdownTableAction): void {
    if (action === "delete-table") {
      dispatchTableChange(view, { from: this.block.from, to: this.block.to, insert: "" }, this.block.from);
      view.focus();
      return;
    }
    const active = activeTableCell(root);
    const model = tableModelFromDom(root, this.block.model);
    const next = mutateWorkspaceMarkdownTable(model, action, active.row, active.column);
    if (next === null) return;
    const insert = serializeWorkspaceMarkdownTable(next, next.sourceWidths);
    const widgetIndex = [...view.dom.querySelectorAll<HTMLElement>(".cm-md-table-widget")].indexOf(root);
    dispatchTableChange(view, { from: this.block.from, to: this.block.to, insert }, this.block.from);
    focusRebuiltWorkspaceMarkdownTableCell(
      view,
      widgetIndex,
      workspaceMarkdownFocusRowAfterAction(action, active.row, next),
      workspaceMarkdownFocusColumnAfterAction(action, active.column, next)
    );
  }

  private commit(view: EditorView, root: HTMLElement, options?: { readonly preserveFocus?: boolean }): void {
    const changes: { from: number; to: number; insert: string }[] = [];
    let needsFullSerialization = false;
    root.querySelectorAll<HTMLTableCellElement>("th, td").forEach((cell) => {
      const row = Number(cell.dataset.row);
      const column = Number(cell.dataset.column);
      if (!Number.isInteger(row) || !Number.isInteger(column)) return;
      const nextText = workspaceMarkdownTableCellText(cell);
      const originalText = row === 0 ? this.block.model.header[column] : this.block.model.rows[row - 1]?.[column];
      if (originalText === undefined || originalText === nextText) return;
      const source = row === 0
        ? this.block.model.headerSources?.[column]
        : this.block.model.rowSources?.[row - 1]?.[column];
      if (source === undefined) {
        needsFullSerialization = true;
        return;
      }
      changes.push({
        from: this.block.from + source.from,
        to: this.block.from + source.to,
        insert: escapeTableCell(nextText)
      });
    });
    if (needsFullSerialization) {
      const model = tableModelFromDom(root, this.block.model);
      const insert = serializeWorkspaceMarkdownTable(model, model.sourceWidths);
      if (insert !== this.block.source) {
        dispatchTableChange(view, { from: this.block.from, to: this.block.to, insert }, options?.preserveFocus ? undefined : this.block.from);
      }
      return;
    }
    if (changes.length === 0) return;
    changes.sort((left, right) => right.from - left.from);
    dispatchTableChange(view, changes, options?.preserveFocus ? undefined : this.block.from);
  }
}

export function runWorkspaceHistoryPreservingScroll(view: EditorView, command: (target: EditorView) => boolean): boolean {
  const top = view.scrollDOM.scrollTop;
  const left = view.scrollDOM.scrollLeft;
  const handled = command(view);
  if (!handled) return false;
  window.requestAnimationFrame(() => {
    view.scrollDOM.scrollTop = top;
    view.scrollDOM.scrollLeft = left;
  });
  return true;
}

function dispatchTableChange(view: EditorView, changes: ChangeSpec, selection?: number): void {
  const snapshot = view.scrollSnapshot();
  const description = view.state.changes(changes);
  const mappedSnapshot = snapshot.map(description);
  view.dispatch({
    changes,
    ...(selection === undefined ? {} : { selection: { anchor: selection } }),
    effects: mappedSnapshot === undefined ? [] : [mappedSnapshot],
    userEvent: "input"
  });
}

function tableModelFromDom(root: HTMLElement, fallback: WorkspaceMarkdownTableModel): WorkspaceMarkdownTableModel {
  const columnCount = workspaceMarkdownTableColumnCount(fallback);
  const header = [...normalizeTableRow(fallback.header, columnCount)];
  const rows = fallback.rows.map((row) => [...normalizeTableRow(row, columnCount)]);
  root.querySelectorAll<HTMLTableCellElement>("th, td").forEach((cell) => {
    const row = Number(cell.dataset.row);
    const column = Number(cell.dataset.column);
    if (!Number.isInteger(row) || !Number.isInteger(column)) return;
    if (row === 0) header[column] = workspaceMarkdownTableCellText(cell);
    else if (rows[row - 1] !== undefined) rows[row - 1]![column] = workspaceMarkdownTableCellText(cell);
  });
  return {
    header,
    alignments: [...fallback.alignments],
    rows,
    sourceWidths: [...(fallback.sourceWidths ?? [])]
  };
}

function openTableMenu(root: HTMLElement, cell: HTMLTableCellElement, clientX: number, clientY: number): void {
  const menu = root.querySelector<HTMLElement>(".cm-md-table-menu");
  if (menu === null) return;
  root.dataset.menuOpen = "true";
  const row = Number(cell.dataset.row);
  const columns = root.querySelectorAll("thead th").length;
  menu.querySelectorAll<HTMLButtonElement>("button[data-table-action]").forEach((button) => {
    button.disabled = (button.dataset.tableAction === "delete-row" && row <= 0)
      || (button.dataset.tableAction === "delete-column" && columns <= 2);
  });
  const rootRect = root.getBoundingClientRect();
  const menuWidth = 168;
  const menuHeight = 248;
  const minimumLeft = root.scrollLeft + 6;
  const maximumLeft = root.scrollLeft + window.innerWidth - rootRect.left - menuWidth - 6;
  const minimumTop = root.scrollTop + 6;
  const maximumTop = root.scrollTop + window.innerHeight - rootRect.top - menuHeight - 6;
  const left = clampWorkspaceMarkdownMenuPosition(clientX - rootRect.left + root.scrollLeft, minimumLeft, maximumLeft);
  const top = clampWorkspaceMarkdownMenuPosition(clientY - rootRect.top + root.scrollTop, minimumTop, maximumTop);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const closeOnOutsidePointer = (event: PointerEvent): void => {
    if (event.target instanceof Node && root.contains(event.target)) return;
    closeTableMenu(root);
  };
  const closeOnEscape = (event: KeyboardEvent): void => {
    if (event.key === "Escape") closeTableMenu(root);
  };
  menuCleanup.get(root)?.();
  document.addEventListener("pointerdown", closeOnOutsidePointer);
  document.addEventListener("keydown", closeOnEscape);
  menuCleanup.set(root, () => {
    document.removeEventListener("pointerdown", closeOnOutsidePointer);
    document.removeEventListener("keydown", closeOnEscape);
  });
}

function clampWorkspaceMarkdownMenuPosition(value: number, minimum: number, maximum: number): number {
  return maximum < minimum ? minimum : Math.min(Math.max(value, minimum), maximum);
}

function closeTableMenu(root: HTMLElement): void {
  delete root.dataset.menuOpen;
  menuCleanup.get(root)?.();
  menuCleanup.delete(root);
}

function tableCellFromTarget(root: HTMLElement, target: EventTarget | null): HTMLTableCellElement | null {
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  const cell = element?.closest("th, td");
  return cell instanceof HTMLTableCellElement && root.contains(cell) ? cell : null;
}

function rememberActiveCell(root: HTMLElement, cell: HTMLTableCellElement): void {
  root.dataset.activeRow = cell.dataset.row;
  root.dataset.activeColumn = cell.dataset.column;
}

function activeTableCell(root: HTMLElement): { readonly row: number; readonly column: number } {
  const active = root.ownerDocument.activeElement;
  const cell = active instanceof HTMLTableCellElement && root.contains(active) ? active : null;
  const row = Number(cell?.dataset.row ?? root.dataset.activeRow ?? 0);
  const column = Number(cell?.dataset.column ?? root.dataset.activeColumn ?? 0);
  return {
    row: Number.isInteger(row) ? row : 0,
    column: Number.isInteger(column) ? column : 0
  };
}

const WORKSPACE_TABLE_NAVIGATION_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown"
]);

function isMacPlatform(): boolean {
  if (typeof window !== "undefined" && window.jokoDesktop?.platform !== undefined) {
    return window.jokoDesktop.platform === "darwin";
  }
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/u.test(navigator.platform);
}

export function workspaceMarkdownTableShortcutAction(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
  isMac: boolean
): "undo" | "redo" | "bold" | "break" | undefined {
  const key = event.key.toLowerCase();
  const primary = isMac ? event.metaKey : event.ctrlKey;
  if (!event.altKey) {
    if (primary && !event.shiftKey && key === "z") return "undo";
    if (isMac
      ? event.metaKey && event.shiftKey && key === "z"
      : event.ctrlKey && (key === "y" || (event.shiftKey && key === "z"))) return "redo";
    if (primary && !event.shiftKey && key === "b") return "bold";
  }
  if (event.key === "Enter" && ((isMac && event.metaKey) || (!isMac && event.shiftKey))) return "break";
  return undefined;
}

function workspaceMarkdownTableCellText(cell: HTMLTableCellElement): string {
  return cell.dataset.sourceText ?? workspaceMarkdownTableCellEditingText(cell);
}

function workspaceMarkdownTableCellEditingText(cell: HTMLTableCellElement): string {
  const clone = cell.cloneNode(true) as HTMLTableCellElement;
  clone.querySelectorAll(".cm-md-table-resize-handle").forEach((handle) => handle.remove());
  return serializeWorkspaceMarkdownTableCellNodes(clone);
}

function renderWorkspaceMarkdownTableCells(root: Element, active: HTMLTableCellElement | null): void {
  root.querySelectorAll<HTMLTableCellElement>("th, td").forEach((cell) => {
    if (cell !== active) renderWorkspaceInlineMarkdown(cell, cell.dataset.sourceText ?? "");
  });
  if (active !== null) renderActiveWorkspaceMarkdownTableCell(active);
}

function renderActiveWorkspaceMarkdownTableCell(cell: HTMLTableCellElement): void {
  if (workspaceMarkdownTableCellIsComposing(cell) || document.activeElement !== cell) return;
  const source = workspaceMarkdownTableCellText(cell);
  const selection = workspaceMarkdownTableCellSelectionOffsets(cell);
  const revealRanges = selection === null ? [] : [selection];
  renderWorkspaceInlineMarkdown(cell, source, revealRanges);
  if (selection !== null) {
    setWorkspaceMarkdownTableCellSelection(
      cell,
      sourceOffsetToRenderedOffset(source, selection.from, revealRanges),
      sourceOffsetToRenderedOffset(source, selection.to, revealRanges)
    );
  }
}

function workspaceMarkdownTableCellIsComposing(cell: HTMLTableCellElement): boolean {
  return cell.dataset.composing === "true";
}

function renderWorkspaceInlineMarkdown(
  cell: HTMLTableCellElement,
  source: string,
  revealRanges: readonly { readonly from: number; readonly to: number }[] = []
): void {
  const handle = cell.querySelector(".cm-md-table-resize-handle");
  handle?.remove();
  cell.textContent = "";
  cell.dataset.revealRanges = serializeWorkspaceMarkdownRevealRanges(revealRanges);

  let position = 0;
  const pattern = /(\*\*([^*\n]+)\*\*|`([^`\n]+)`|<br\s*\/?>)/giu;
  for (const match of source.matchAll(pattern)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (start > position) cell.append(document.createTextNode(source.slice(position, start)));
    if (match[0].toLowerCase().startsWith("<br")) {
      cell.append(document.createElement("br"));
      position = end;
      continue;
    }
    if (workspaceMarkdownInlineTokenIsRevealed(start, end, revealRanges)) {
      cell.append(document.createTextNode(match[0]));
      position = end;
      continue;
    }
    if (match[2] !== undefined) {
      const strong = document.createElement("strong");
      strong.textContent = match[2];
      cell.append(strong);
    } else if (match[3] !== undefined) {
      const code = document.createElement("code");
      code.textContent = match[3];
      cell.append(code);
    }
    position = end;
  }
  if (position < source.length) cell.append(document.createTextNode(source.slice(position)));
  if (handle !== null) cell.append(handle);
}

function workspaceMarkdownInlineTokenIsRevealed(
  from: number,
  to: number,
  revealRanges: readonly { readonly from: number; readonly to: number }[]
): boolean {
  return revealRanges.some((range) => range.from === range.to
    ? range.from >= from && range.from <= to
    : range.from < to && range.to > from);
}

function toggleWorkspaceStrongInTableCell(cell: HTMLTableCellElement): void {
  const source = workspaceMarkdownTableCellText(cell);
  const selection = workspaceMarkdownTableCellSelectionOffsets(cell) ?? { from: source.length, to: source.length };
  const next = toggleWorkspaceMarkdownStrongText(source, selection.from, selection.to);
  const revealRanges = [{ from: next.from, to: next.to }];
  cell.dataset.sourceText = next.text;
  renderWorkspaceInlineMarkdown(cell, next.text, revealRanges);
  setWorkspaceMarkdownTableCellSelection(
    cell,
    sourceOffsetToRenderedOffset(next.text, next.from, revealRanges),
    sourceOffsetToRenderedOffset(next.text, next.to, revealRanges)
  );
}

function insertWorkspaceMarkdownTableCellBreak(cell: HTMLTableCellElement): void {
  const source = workspaceMarkdownTableCellText(cell);
  const selection = workspaceMarkdownTableCellSelectionOffsets(cell) ?? { from: source.length, to: source.length };
  const next = workspaceMarkdownTableCellBreak(source, selection.from, selection.to);
  cell.dataset.sourceText = next.text;
  renderWorkspaceInlineMarkdown(cell, next.text);
  const rendered = sourceOffsetToRenderedOffset(next.text, next.offset, []);
  setWorkspaceMarkdownTableCellSelection(cell, rendered, rendered);
}

export function workspaceMarkdownTableCellBreak(
  text: string,
  requestedFrom: number,
  requestedTo: number
): { readonly text: string; readonly offset: number } {
  const from = Math.min(Math.max(0, requestedFrom), text.length);
  const to = Math.min(Math.max(from, requestedTo), text.length);
  return {
    text: `${text.slice(0, from)}<br>${text.slice(to)}`,
    offset: from + 4
  };
}

export function toggleWorkspaceMarkdownStrongText(
  text: string,
  requestedFrom: number,
  requestedTo: number
): { readonly text: string; readonly from: number; readonly to: number } {
  let from = Math.min(Math.max(0, requestedFrom), text.length);
  let to = Math.min(Math.max(from, requestedTo), text.length);
  const strong = findWorkspaceMarkdownStrongRange(text, from, to);
  if (strong !== null) {
    const nextText = text.slice(0, strong.openFrom)
      + text.slice(strong.openTo, strong.closeFrom)
      + text.slice(strong.closeTo);
    const nextFrom = Math.max(strong.openFrom, from - 2);
    const nextTo = from === to ? nextFrom : Math.max(nextFrom, to - 2);
    return { text: nextText, from: nextFrom, to: nextTo };
  }
  if (from === to) {
    const word = findWorkspaceMarkdownStrongWordTarget(text, from);
    if (word === null) {
      return { text: `${text.slice(0, from)}****${text.slice(from)}`, from: from + 2, to: from + 2 };
    }
    from = word.from;
    to = word.to;
  }
  return {
    text: `${text.slice(0, from)}**${text.slice(from, to)}**${text.slice(to)}`,
    from: from + 2,
    to: to + 2
  };
}

function findWorkspaceMarkdownStrongRange(
  text: string,
  from: number,
  to: number
): { readonly openFrom: number; readonly openTo: number; readonly closeFrom: number; readonly closeTo: number } | null {
  for (const match of text.matchAll(/\*\*([^*\n]+)\*\*/gu)) {
    const start = match.index;
    if (start === undefined) continue;
    const range = {
      openFrom: start,
      openTo: start + 2,
      closeFrom: start + match[0].length - 2,
      closeTo: start + match[0].length
    };
    if (from === to) {
      if (from >= range.openTo && from <= range.closeFrom) return range;
    } else if (from < range.closeTo && to > range.openFrom) {
      return range;
    }
  }
  return null;
}

function findWorkspaceMarkdownStrongWordTarget(text: string, position: number): { readonly from: number; readonly to: number } | null {
  let local = position;
  if (local > 0 && (local === text.length || workspaceMarkdownStrongBoundary(text[local]))) local -= 1;
  if (local < 0 || local >= text.length || workspaceMarkdownStrongBoundary(text[local])) return null;
  let from = local;
  let to = local + 1;
  while (from > 0 && !workspaceMarkdownStrongBoundary(text[from - 1])) from -= 1;
  while (to < text.length && !workspaceMarkdownStrongBoundary(text[to])) to += 1;
  return from < to ? { from, to } : null;
}

function workspaceMarkdownStrongBoundary(character: string | undefined): boolean {
  return character === undefined || /[\s\p{P}\p{S}]/u.test(character);
}

function workspaceMarkdownTableCellSelectionOffsets(cell: HTMLTableCellElement): { readonly from: number; readonly to: number } | null {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!cell.contains(range.startContainer) || !cell.contains(range.endContainer)) return null;
  const before = document.createRange();
  before.selectNodeContents(cell);
  before.setEnd(range.startContainer, range.startOffset);
  const selected = document.createRange();
  selected.selectNodeContents(cell);
  selected.setEnd(range.endContainer, range.endOffset);
  const source = workspaceMarkdownTableCellText(cell);
  const revealRanges = parseWorkspaceMarkdownRevealRanges(cell.dataset.revealRanges);
  const from = renderedOffsetToSourceOffset(source, workspaceMarkdownRenderedRangeLength(before), revealRanges);
  const to = renderedOffsetToSourceOffset(source, workspaceMarkdownRenderedRangeLength(selected), revealRanges);
  return { from: Math.min(from, to), to: Math.max(from, to) };
}

function setWorkspaceMarkdownTableCellSelection(cell: HTMLTableCellElement, from: number, to: number): void {
  const selection = window.getSelection();
  if (selection === null) return;
  const start = findWorkspaceMarkdownRenderedPosition(cell, from);
  const end = findWorkspaceMarkdownRenderedPosition(cell, to);
  if (start === null || end === null) {
    placeWorkspaceMarkdownTableCaretAtEnd(cell);
    return;
  }
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  selection.removeAllRanges();
  selection.addRange(range);
}

function placeWorkspaceMarkdownTableCaretAtEnd(cell: HTMLTableCellElement): void {
  const selection = window.getSelection();
  if (selection === null) return;
  const range = document.createRange();
  range.selectNodeContents(cell);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function serializeWorkspaceMarkdownTableCellNodes(root: Node): string {
  let output = "";
  root.childNodes.forEach((node) => {
    if (node instanceof HTMLElement && node.classList.contains("cm-md-table-resize-handle")) return;
    if (node.nodeType === Node.TEXT_NODE) {
      output += node.textContent ?? "";
    } else if (node instanceof HTMLBRElement) {
      output += "<br>";
    } else if (node instanceof HTMLElement && node.tagName === "STRONG") {
      output += `**${serializeWorkspaceMarkdownTableCellNodes(node)}**`;
    } else if (node instanceof HTMLElement && node.tagName === "CODE") {
      output += `\`${node.textContent ?? ""}\``;
    } else {
      output += serializeWorkspaceMarkdownTableCellNodes(node);
    }
  });
  return output;
}

function serializeWorkspaceMarkdownRevealRanges(ranges: readonly { readonly from: number; readonly to: number }[]): string {
  return ranges.map((range) => `${range.from}:${range.to}`).join(",");
}

function parseWorkspaceMarkdownRevealRanges(value: string | undefined): readonly { readonly from: number; readonly to: number }[] {
  if (value === undefined || value.length === 0) return [];
  return value.split(",").map((chunk) => {
    const [from, to] = chunk.split(":").map(Number);
    return Number.isFinite(from) && Number.isFinite(to) ? { from: from!, to: to! } : null;
  }).filter((range): range is { readonly from: number; readonly to: number } => range !== null);
}

function workspaceMarkdownRenderedRangeLength(range: Range): number {
  const fragment = range.cloneContents();
  fragment.querySelectorAll?.(".cm-md-table-resize-handle").forEach((handle) => handle.remove());
  return workspaceMarkdownRenderedNodeLength(fragment);
}

function workspaceMarkdownRenderedNodeLength(root: Node): number {
  let length = 0;
  root.childNodes.forEach((node) => {
    if (node instanceof HTMLElement && node.classList.contains("cm-md-table-resize-handle")) return;
    if (node.nodeType === Node.TEXT_NODE) length += node.textContent?.length ?? 0;
    else if (node instanceof HTMLBRElement) length += 1;
    else length += workspaceMarkdownRenderedNodeLength(node);
  });
  return length;
}

export function renderedOffsetToSourceOffset(
  source: string,
  renderedOffset: number,
  revealRanges: readonly { readonly from: number; readonly to: number }[]
): number {
  let sourcePosition = 0;
  let rendered = 0;
  const pattern = /(\*\*([^*\n]+)\*\*|`([^`\n]+)`|<br\s*\/?>)/giu;
  for (const match of source.matchAll(pattern)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (start > sourcePosition) {
      const textLength = start - sourcePosition;
      if (renderedOffset <= rendered + textLength) return sourcePosition + Math.max(0, renderedOffset - rendered);
      rendered += textLength;
    }
    if (match[0].toLowerCase().startsWith("<br")) {
      if (renderedOffset <= rendered) return start;
      if (renderedOffset <= rendered + 1) return end;
      rendered += 1;
      sourcePosition = end;
      continue;
    }
    if (workspaceMarkdownInlineTokenIsRevealed(start, end, revealRanges)) {
      const tokenLength = end - start;
      if (renderedOffset <= rendered + tokenLength) return start + Math.max(0, renderedOffset - rendered);
      rendered += tokenLength;
      sourcePosition = end;
      continue;
    }
    const contentFrom = match[2] !== undefined ? start + 2 : start + 1;
    const contentLength = match[2]?.length ?? match[3]?.length ?? 0;
    if (renderedOffset <= rendered + contentLength) return contentFrom + Math.max(0, renderedOffset - rendered);
    rendered += contentLength;
    sourcePosition = end;
  }
  if (sourcePosition < source.length && renderedOffset <= rendered + source.length - sourcePosition) {
    return sourcePosition + Math.max(0, renderedOffset - rendered);
  }
  return source.length;
}

export function sourceOffsetToRenderedOffset(
  source: string,
  sourceOffset: number,
  revealRanges: readonly { readonly from: number; readonly to: number }[]
): number {
  let sourcePosition = 0;
  let rendered = 0;
  const pattern = /(\*\*([^*\n]+)\*\*|`([^`\n]+)`|<br\s*\/?>)/giu;
  for (const match of source.matchAll(pattern)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (start > sourcePosition) {
      if (sourceOffset <= start) return rendered + Math.max(0, sourceOffset - sourcePosition);
      rendered += start - sourcePosition;
    }
    if (match[0].toLowerCase().startsWith("<br")) {
      if (sourceOffset <= start) return rendered;
      if (sourceOffset <= end) return rendered + 1;
      rendered += 1;
      sourcePosition = end;
      continue;
    }
    if (workspaceMarkdownInlineTokenIsRevealed(start, end, revealRanges)) {
      if (sourceOffset <= end) return rendered + Math.max(0, sourceOffset - start);
      rendered += end - start;
      sourcePosition = end;
      continue;
    }
    const contentFrom = match[2] !== undefined ? start + 2 : start + 1;
    const contentTo = match[2] !== undefined ? end - 2 : end - 1;
    if (sourceOffset <= contentFrom) return rendered;
    if (sourceOffset <= contentTo) return rendered + sourceOffset - contentFrom;
    rendered += contentTo - contentFrom;
    sourcePosition = end;
  }
  return rendered + Math.max(0, Math.min(sourceOffset, source.length) - sourcePosition);
}

function findWorkspaceMarkdownRenderedPosition(
  cell: HTMLTableCellElement,
  target: number
): { readonly node: Node; readonly offset: number } | null {
  let rendered = 0;
  const visit = (parent: Node): { readonly node: Node; readonly offset: number } | null => {
    const children = [...parent.childNodes];
    for (let index = 0; index < children.length; index += 1) {
      const node = children[index]!;
      if (node instanceof HTMLElement && node.classList.contains("cm-md-table-resize-handle")) continue;
      if (node.nodeType === Node.TEXT_NODE) {
        const length = node.textContent?.length ?? 0;
        if (target <= rendered + length) return { node, offset: Math.max(0, target - rendered) };
        rendered += length;
      } else if (node instanceof HTMLBRElement) {
        if (target <= rendered) return { node: parent, offset: index };
        if (target <= rendered + 1) return { node: parent, offset: index + 1 };
        rendered += 1;
      } else {
        const found = visit(node);
        if (found !== null) return found;
      }
    }
    return null;
  };
  return visit(cell) ?? { node: cell, offset: cell.childNodes.length };
}

function applyWorkspaceMarkdownColumnWidths(root: Element, widths: readonly number[]): void {
  const total = widths.reduce((sum, width) => sum + Math.max(3, width), 0);
  root.querySelectorAll<HTMLTableColElement>("col").forEach((column, index) => {
    const width = Math.max(3, widths[index] ?? 3);
    column.style.width = `${(width / total) * 100}%`;
  });
}

function estimateWorkspaceMarkdownCharacterWidth(root: Element): number {
  const probe = document.createElement("span");
  probe.textContent = "0000000000";
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  root.append(probe);
  const width = probe.getBoundingClientRect().width / 10;
  probe.remove();
  return width > 0 ? width : 8;
}

function focusRebuiltWorkspaceMarkdownTableCell(
  view: EditorView,
  tableIndex: number,
  row: number,
  column: number
): void {
  window.requestAnimationFrame(() => {
    const widget = tableIndex >= 0 ? view.dom.querySelectorAll<HTMLElement>(".cm-md-table-widget")[tableIndex] : undefined;
    if (widget === undefined) {
      view.focus();
      return;
    }
    const target = widget.querySelector<HTMLTableCellElement>(`[data-row="${row}"][data-column="${column}"]`);
    if (target === null) {
      view.focus();
      return;
    }
    target.focus({ preventScroll: true });
    rememberActiveCell(widget, target);
    renderWorkspaceMarkdownTableCells(widget, target);
    placeWorkspaceMarkdownTableCaretAtEnd(target);
  });
}

function workspaceMarkdownFocusRowAfterAction(
  action: WorkspaceMarkdownTableAction,
  row: number,
  model: WorkspaceMarkdownTableModel
): number {
  if (action === "add-row-below") return Math.min(row + 1, model.rows.length);
  if (action === "delete-row") return Math.min(Math.max(1, row), model.rows.length);
  return row;
}

function workspaceMarkdownFocusColumnAfterAction(
  action: WorkspaceMarkdownTableAction,
  column: number,
  model: WorkspaceMarkdownTableModel
): number {
  const maximum = Math.max(0, workspaceMarkdownTableColumnCount(model) - 1);
  return action === "add-column-right"
    ? Math.min(column + 1, maximum)
    : Math.min(column, maximum);
}

function focusAdjacentTableCell(root: HTMLElement, current: HTMLTableCellElement, delta: -1 | 1): void {
  const cells = [...root.querySelectorAll<HTMLTableCellElement>("th, td")];
  const target = cells[cells.indexOf(current) + delta];
  if (target === undefined) return;
  target.focus();
  selectWorkspaceMarkdownTableCellText(target);
}

function selectWorkspaceMarkdownTableCellText(cell: HTMLTableCellElement): void {
  const selection = window.getSelection();
  if (selection === null) return;
  const range = document.createRange();
  range.selectNodeContents(cell);
  selection.removeAllRanges();
  selection.addRange(range);
}

function looksLikeTableRow(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.includes("|");
}

function isMarkdownTableSourceLine(text: string): boolean {
  return /^\s*\|.*\|\s*$/u.test(text);
}

function isTableSeparator(text: string): boolean {
  const cells = splitTableRow(text);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell.trim()));
}

function splitTableRow(line: string): string[] {
  let source = line.trim();
  if (source.startsWith("|")) source = source.slice(1);
  if (source.endsWith("|")) source = source.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  let escaped = false;
  for (const character of source) {
    if (escaped) {
      cell += character;
      escaped = false;
    } else if (character === "\\") {
      cell += character;
      escaped = true;
    } else if (character === "|") {
      cells.push(cell);
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell);
  return cells;
}

function splitTableLinesWithOffsets(source: string): readonly { readonly text: string; readonly from: number }[] {
  const lines: { text: string; from: number }[] = [];
  let from = 0;
  for (const text of source.split(/\r?\n/u)) {
    lines.push({ text, from });
    from += text.length + 1;
  }
  return lines;
}

function splitTableRowWithRanges(
  line: string,
  lineFrom: number
): readonly { readonly text: string; readonly contentFrom: number; readonly contentTo: number; readonly rawWidth: number }[] {
  const cells: { text: string; from: number; to: number }[] = [];
  let start = line.startsWith("|") ? 1 : 0;
  let current = "";
  let escaped = false;
  for (let index = start; index < line.length; index += 1) {
    const character = line[index]!;
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\") {
      current += character;
      escaped = true;
    } else if (character === "|") {
      cells.push({ text: current, from: start, to: index });
      start = index + 1;
      current = "";
    } else {
      current += character;
    }
  }
  if (start < line.length || !line.endsWith("|")) cells.push({ text: current, from: start, to: line.length });
  return cells.map((cell) => {
    const leading = cell.text.match(/^\s*/u)?.[0].length ?? 0;
    const trailing = cell.text.match(/\s*$/u)?.[0].length ?? 0;
    return {
      text: cell.text,
      contentFrom: lineFrom + cell.from + leading,
      contentTo: lineFrom + cell.to - trailing,
      rawWidth: cell.to - cell.from
    };
  });
}

function computeTableSourceWidths(
  rows: readonly (readonly { readonly rawWidth: number }[])[],
  separatorCells: readonly { readonly rawWidth: number }[],
  count: number
): readonly number[] {
  const separatorWidths = Array.from({ length: count }, (_, index) => Math.max(3, separatorCells[index]?.rawWidth ?? 0));
  if (new Set(separatorWidths).size > 1) return separatorWidths;
  return Array.from({ length: count }, (_, index) => Math.max(3, ...rows.map((row) => row[index]?.rawWidth ?? 0)));
}

function tableAlignment(cell: string): "left" | "center" | "right" | null {
  const value = cell.trim();
  if (value.startsWith(":") && value.endsWith(":")) return "center";
  if (value.endsWith(":")) return "right";
  if (value.startsWith(":")) return "left";
  return null;
}

function normalizeTableRow(row: readonly string[], count: number): string[] {
  return Array.from({ length: count }, (_, index) => row[index] ?? "");
}

function normalizeTableAlignments(
  alignments: readonly ("left" | "center" | "right" | null)[],
  count: number
): ("left" | "center" | "right" | null)[] {
  return Array.from({ length: count }, (_, index) => alignments[index] ?? null);
}

function normalizeTableSources(
  sources: readonly (WorkspaceMarkdownTableCellSource | undefined)[],
  count: number
): (WorkspaceMarkdownTableCellSource | undefined)[] {
  return Array.from({ length: count }, (_, index) => sources[index]);
}

function workspaceMarkdownTableColumnCount(model: WorkspaceMarkdownTableModel): number {
  return Math.max(2, model.header.length, model.alignments.length, ...model.rows.map((row) => row.length));
}

function computeWorkspaceMarkdownColumnWidths(model: WorkspaceMarkdownTableModel): readonly number[] {
  const count = workspaceMarkdownTableColumnCount(model);
  return Array.from({ length: count }, (_, column) => Math.max(
    3,
    escapeTableCell(model.header[column] ?? "").length,
    ...model.rows.map((row) => escapeTableCell(row[column] ?? "").length)
  ));
}

function normalizeWorkspaceMarkdownColumnWidths(widths: readonly number[], count: number): number[] {
  return Array.from({ length: count }, (_, index) => Math.max(3, widths[index] ?? 3));
}

function escapeTableCell(value: string): string {
  return value.replace(/(?<!\\)\|/gu, "\\|").replace(/\r?\n/gu, "<br>");
}
