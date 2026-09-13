/**
 * Math preprocessing for chat Markdown.
 *
 * react-markdown consumes backslash escapes before remark plugins run, so
 * `\\(...\\)` and `\\[...\\]` must be normalized before parsing. The scanner
 * deliberately skips fenced/inline code and Markdown link destinations.
 */

interface MarkdownPosition {
  readonly start: { readonly offset?: number };
  readonly end: { readonly offset?: number };
}

interface MarkdownNode {
  type: string;
  value?: string;
  position?: MarkdownPosition;
  children?: MarkdownNode[];
}

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/u;
const REFERENCE_LINK_LINE = /^ {0,3}\[[^\]\n]*\]:/gmu;

function linkDestinationRanges(text: string): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf("](", cursor);
    if (open < 0) break;
    let index = open + 2;
    let depth = 1;
    while (index < text.length && depth > 0) {
      const character = text[index];
      if (character === "\\") {
        index += 2;
        continue;
      }
      if (character === "\n") break;
      if (character === "(") depth += 1;
      else if (character === ")") depth -= 1;
      index += 1;
    }
    if (depth === 0) ranges.push([open, index]);
    cursor = Math.max(open + 2, index);
  }
  for (const match of text.matchAll(REFERENCE_LINK_LINE)) {
    const lineEnd = text.indexOf("\n", match.index);
    ranges.push([match.index, lineEnd < 0 ? text.length : lineEnd]);
  }
  return ranges.sort((left, right) => left[0] - right[0]);
}

function normalizePlainMath(text: string): string {
  if (!text.includes("\\(") && !text.includes("\\[")) return text;
  const ranges = text.includes("](") || text.includes("]:") ? linkDestinationRanges(text) : [];
  let rangeIndex = 0;
  let consumed = 0;
  let scan = 0;
  let output = "";
  let noParenCloser = false;
  let noBracketCloser = false;

  while (scan < text.length) {
    const open = text.indexOf("\\", scan);
    if (open < 0 || open + 1 >= text.length) break;
    const kind = text[open + 1];
    if (kind !== "(" && kind !== "[") {
      scan = open + 1;
      continue;
    }
    while (rangeIndex < ranges.length && ranges[rangeIndex]![1] <= open) rangeIndex += 1;
    const range = ranges[rangeIndex];
    if (range !== undefined && open >= range[0] && open < range[1]) {
      scan = range[1];
      continue;
    }

    const display = kind === "[";
    if (display ? noBracketCloser : noParenCloser) {
      scan = open + 2;
      continue;
    }
    const closer = display ? "\\]" : "\\)";
    const close = text.indexOf(closer, open + 2);
    if (close < 0) {
      if (display) noBracketCloser = true;
      else noParenCloser = true;
      scan = open + 2;
      continue;
    }
    if (close === open + 2) {
      scan = close + 2;
      continue;
    }
    const body = text.slice(open + 2, close).trim();
    output += text.slice(consumed, open);
    output += display ? `\n\n$$\n${body}\n$$\n\n` : `$${body}$`;
    consumed = close + 2;
    scan = consumed;
  }
  return output + text.slice(consumed);
}

function normalizeOutsideInlineCode(text: string): string {
  if (!text.includes("`")) return normalizePlainMath(text);
  let cursor = 0;
  let output = "";
  const missingClosers = new Set<number>();
  while (cursor < text.length) {
    const tick = text.indexOf("`", cursor);
    if (tick < 0) break;
    let openEnd = tick;
    while (text[openEnd] === "`") openEnd += 1;
    const length = openEnd - tick;
    let closeStart = -1;
    let closeEnd = openEnd;
    if (!missingClosers.has(length)) {
      let probe = openEnd;
      while (probe < text.length) {
        const candidate = text.indexOf("`", probe);
        if (candidate < 0) break;
        let candidateEnd = candidate;
        while (text[candidateEnd] === "`") candidateEnd += 1;
        if (candidateEnd - candidate === length) {
          closeStart = candidate;
          closeEnd = candidateEnd;
          break;
        }
        probe = candidateEnd;
      }
      if (closeStart < 0) missingClosers.add(length);
    }
    output += normalizePlainMath(text.slice(cursor, tick));
    if (closeStart < 0) {
      output += text.slice(tick, openEnd);
      cursor = openEnd;
      continue;
    }
    output += text.slice(tick, closeEnd);
    cursor = closeEnd;
  }
  return output + normalizePlainMath(text.slice(cursor));
}

export function normalizeTimelineMathDelimiters(markdown: string): string {
  if (!markdown.includes("\\(") && !markdown.includes("\\[")) return markdown;
  const output: string[] = [];
  let prose: string[] = [];
  let fence: string | undefined;
  const flush = (): void => {
    if (prose.length === 0) return;
    output.push(normalizeOutsideInlineCode(prose.join("\n")));
    prose = [];
  };

  for (const line of markdown.split("\n")) {
    const marker = line.match(FENCE_LINE)?.[1];
    if (fence === undefined) {
      if (marker === undefined) {
        prose.push(line);
        continue;
      }
      flush();
      fence = marker;
      output.push(line);
      continue;
    }
    output.push(line);
    if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
  }
  flush();
  return output.join("\n");
}

export function isLooseTimelineInlineMath(raw: string, nextCharacter: string): boolean {
  const body = raw.replace(/^\$+/u, "").replace(/\$+$/u, "");
  return /^\s|\s$/u.test(body) || body.includes("\n") || body.includes("`") || /^\d/u.test(nextCharacter);
}

/** Downgrade remark-math's loose currency/cross-code matches back to text. */
export function remarkStrictTimelineInlineMath(): (tree: MarkdownNode, file: unknown) => void {
  return (tree, file): void => {
    const source = String(file);
    const visit = (parent: MarkdownNode): void => {
      const children = parent.children;
      if (children === undefined) return;
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index]!;
        if (child.type === "inlineMath") {
          const start = child.position?.start.offset;
          const end = child.position?.end.offset;
          if (start !== undefined && end !== undefined) {
            const raw = source.slice(start, end);
            if (isLooseTimelineInlineMath(raw, source[end] ?? "")) children[index] = { type: "text", value: raw };
          }
        } else visit(child);
      }
    };
    visit(tree);
  };
}
