export const WORKSPACE_FILE_QUOTE_MAXIMUM_CHARACTERS = 4_000;

export interface WorkspaceFileSelectionQuote {
  readonly text: string;
  readonly startLine: number;
  readonly endLine: number;
}

export function normalizeWorkspaceFileSource(text: string): string {
  return text.replace(/\r\n?/gu, "\n");
}

/**
 * Converts a source-document selection into a 1-based closed line range.
 * Offsets are UTF-16 positions in the LF-normalized document, matching DOM and
 * CodeMirror selection offsets. Line metadata is computed before text truncation.
 */
export function workspaceFileQuoteFromOffsets(
  rawSource: string,
  anchorOffset: number,
  focusOffset: number
): WorkspaceFileSelectionQuote | undefined {
  const source = normalizeWorkspaceFileSource(rawSource);
  if (
    !Number.isSafeInteger(anchorOffset) ||
    !Number.isSafeInteger(focusOffset) ||
    anchorOffset < 0 ||
    focusOffset < 0 ||
    anchorOffset > source.length ||
    focusOffset > source.length ||
    anchorOffset === focusOffset
  ) return undefined;

  let start = Math.min(anchorOffset, focusOffset);
  let end = Math.max(anchorOffset, focusOffset);
  while (start < end && source[start] === "\n") start += 1;
  while (end > start && source[end - 1] === "\n") end -= 1;
  if (start >= end) return undefined;
  const completeText = source.slice(start, end);
  if (completeText.trim() === "") return undefined;

  const startLine = lineNumberAt(source, start);
  const endLine = Math.max(startLine, lineNumberAt(source, end - 1));
  const text = completeText.length > WORKSPACE_FILE_QUOTE_MAXIMUM_CHARACTERS
    ? `${completeText.slice(0, WORKSPACE_FILE_QUOTE_MAXIMUM_CHARACTERS)}…`
    : completeText;
  return { text, startLine, endLine };
}

/** Maps a live DOM selection back to the source text without trusting rendered markup. */
export function readWorkspaceFileDomSelection(
  container: HTMLElement,
  rawSource: string,
  selection: Selection | null
): WorkspaceFileSelectionQuote | undefined {
  if (
    selection === null ||
    selection.isCollapsed ||
    selection.anchorNode === null ||
    selection.focusNode === null ||
    !container.contains(selection.anchorNode) ||
    !container.contains(selection.focusNode)
  ) return undefined;
  const source = normalizeWorkspaceFileSource(rawSource);
  if (normalizeWorkspaceFileSource(container.textContent ?? "") !== source) return undefined;
  const anchorOffset = domBoundarySourceOffset(container, selection.anchorNode, selection.anchorOffset);
  const focusOffset = domBoundarySourceOffset(container, selection.focusNode, selection.focusOffset);
  if (anchorOffset === undefined || focusOffset === undefined) return undefined;
  return workspaceFileQuoteFromOffsets(source, anchorOffset, focusOffset);
}

function domBoundarySourceOffset(
  container: HTMLElement,
  node: Node,
  offset: number
): number | undefined {
  const document = container.ownerDocument;
  const range = document.createRange();
  try {
    range.selectNodeContents(container);
    range.setEnd(node, offset);
    return normalizeWorkspaceFileSource(range.toString()).length;
  } catch {
    return undefined;
  } finally {
    range.detach();
  }
}

function lineNumberAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}
