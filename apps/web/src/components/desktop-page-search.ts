export interface DesktopPageMatch {
  readonly range: Range;
  readonly document: Document;
}

interface TextPart {
  readonly node: Text;
  readonly start: number;
  readonly end: number;
}

interface FoldedText {
  readonly text: string;
  readonly starts: readonly number[];
  readonly ends: readonly number[];
}

export const PAGE_SEARCH_HIGHLIGHT = "joko-page-search";
export const PAGE_SEARCH_ACTIVE_HIGHLIGHT = "joko-page-search-active";
const SKIP_ELEMENTS = "script, style, noscript, template, input, textarea, select, [data-page-search-ignore]";
const INLINE_DISPLAYS = new Set(["inline", "inline-block", "inline-flex", "inline-grid", "contents", "ruby", "ruby-base", "ruby-text", ""]);

/** Search rendered text without changing DOM content, focus, or the user's selection. */
export function findDesktopPageMatches(root: Document, query: string): {
  readonly matches: readonly DesktopPageMatch[];
  readonly documents: readonly Document[];
} {
  const matches: DesktopPageMatch[] = [];
  const documents: Document[] = [];
  const needle = foldText(query).text;
  const visit = (owner: Document): void => {
    if (documents.includes(owner) || owner.body === null) return;
    documents.push(owner);
    const styles = new Map<Element, CSSStyleDeclaration>();
    const style = (element: Element): CSSStyleDeclaration => {
      let value = styles.get(element);
      if (value === undefined) {
        value = owner.defaultView!.getComputedStyle(element);
        styles.set(element, value);
      }
      return value;
    };
    let parts: TextPart[] = [];
    let text = "";
    let previousBlock: Element | undefined;
    let preserveWhitespace = false;
    const flush = (): void => {
      if (text !== "" && needle !== "") {
        const folded = foldText(text, preserveWhitespace);
        let offset = 0;
        let lastStart = -1;
        let lastEnd = -1;
        let firstPartIndex = 0;
        let lastPartIndex = 0;
        for (;;) {
          const found = folded.text.indexOf(needle, offset);
          if (found < 0) break;
          offset = found + Math.max(1, needle.length);
          const start = folded.starts[found]!;
          const end = folded.ends[found + needle.length - 1]!;
          if (start === lastStart && end === lastEnd) continue;
          lastStart = start;
          lastEnd = end;
          while (firstPartIndex < parts.length && parts[firstPartIndex]!.end <= start) firstPartIndex += 1;
          while (lastPartIndex < parts.length && parts[lastPartIndex]!.end < end) lastPartIndex += 1;
          const first = parts[firstPartIndex];
          const last = parts[lastPartIndex];
          if (first === undefined || last === undefined || first.start > start || last.start >= end) continue;
          const range = owner.createRange();
          range.setStart(first.node, start - first.start);
          range.setEnd(last.node, end - last.start);
          if (rangeIsPainted(range, style)) matches.push({ range, document: owner });
        }
      }
      text = "";
      parts = [];
    };
    const walker = owner.createTreeWalker(owner.body, 5 /* SHOW_ELEMENT | SHOW_TEXT */);
    let node: Node | null;
    while ((node = walker.nextNode()) !== null) {
      if (node.nodeType === 1) {
        if ((node as Element).tagName === "IFRAME" && desktopPageElementVisible(node as Element, style)) {
          flush();
          previousBlock = undefined;
          try {
            const child = (node as HTMLIFrameElement).contentDocument;
            if (child !== null) visit(child);
          } catch { /* Cross-origin frames own their own page search surface. */ }
        }
        if ((node as Element).tagName === "BR" && desktopPageElementVisible(node as Element, style)) text += "\n";
        continue;
      }
      const parent = node.parentElement;
      if (parent === null || node.textContent === "" || !desktopPageElementVisible(parent, style)) continue;
      let block = parent;
      while (block.parentElement !== null && INLINE_DISPLAYS.has(style(block).display)) block = block.parentElement;
      const nextPreserveWhitespace = ["pre", "pre-wrap", "break-spaces"].includes(style(parent).whiteSpace);
      if (block !== previousBlock || nextPreserveWhitespace !== preserveWhitespace) flush();
      previousBlock = block;
      preserveWhitespace = nextPreserveWhitespace;
      const start = text.length;
      text += node.textContent;
      parts.push({ node: node as Text, start, end: text.length });
    }
    flush();
  };
  visit(root);
  return { matches, documents };
}

/** Visibility is visual: aria-hidden alone does not hide painted text. */
export function desktopPageElementVisible(
  element: Element,
  style: (element: Element) => CSSStyleDeclaration = (candidate) => candidate.ownerDocument.defaultView!.getComputedStyle(candidate)
): boolean {
  if (element.closest(SKIP_ELEMENTS) !== null) return false;
  const ownStyle = style(element);
  if (ownStyle.visibility === "hidden" || ownStyle.visibility === "collapse") return false;
  for (let current: Element | null = element; current !== null; current = current.parentElement) {
    if (current.hasAttribute("hidden") || current.hasAttribute("inert")) return false;
    if (current.tagName === "DIALOG" && !current.hasAttribute("open")) return false;
    if (current.tagName === "DETAILS" && !current.hasAttribute("open")) {
      const summary = [...current.children].find((child) => child.tagName === "SUMMARY");
      if (summary === undefined || !summary.contains(element)) return false;
    }
    const computed = style(current);
    if (computed.display === "none" || computed.contentVisibility === "hidden" || computed.opacity === "0") return false;
  }
  return true;
}

function rangeIsPainted(range: Range, style: (element: Element) => CSSStyleDeclaration): boolean {
  const rectangles = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
  if (rectangles.length === 0) return false;
  for (let ancestor = range.commonAncestorContainer.nodeType === 1
    ? range.commonAncestorContainer as Element : range.commonAncestorContainer.parentElement;
    ancestor !== null; ancestor = ancestor.parentElement) {
    if (ancestor === ancestor.ownerDocument.body || ancestor === ancestor.ownerDocument.documentElement) continue;
    const computed = style(ancestor);
    const clipX = computed.overflowX === "hidden" || computed.overflowX === "clip";
    const clipY = computed.overflowY === "hidden" || computed.overflowY === "clip";
    if (!clipX && !clipY) continue;
    const bounds = ancestor.getBoundingClientRect();
    if (rectangles.some((rect) => (clipX && (rect.left < bounds.left - 1 || rect.right > bounds.right + 1))
      || (clipY && (rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1)))) return false;
  }
  return true;
}

function foldText(value: string, preserveWhitespace = false): FoldedText {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  const segments = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)];
  const eastAsian = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
  for (let index = 0; index < segments.length; index += 1) {
    const part = segments[index]!;
    // Normal white-space removes a segment break between ideographic glyphs;
    // Korean word boundaries and preformatted content keep their separators.
    if (!preserveWhitespace && /[\r\n]/u.test(part.segment)
      && eastAsian.test(segments[index - 1]?.segment ?? "") && eastAsian.test(segments[index + 1]?.segment ?? "")) continue;
    const folded = part.segment.normalize("NFKC").toUpperCase().toLowerCase().replace(/ß/gu, "ss");
    for (const character of folded) {
      const normalized = !preserveWhitespace && /[\t\n\f\r ]/u.test(character) ? " " : character;
      if (!preserveWhitespace && normalized === " " && text.endsWith(" ")) {
        ends[ends.length - 1] = part.index + part.segment.length;
        continue;
      }
      text += normalized;
      for (let offset = 0; offset < normalized.length; offset += 1) {
        starts.push(part.index);
        ends.push(part.index + part.segment.length);
      }
    }
  }
  return { text, starts, ends };
}

interface HighlightWindow {
  readonly CSS?: { readonly highlights?: Map<string, unknown> };
  readonly Highlight?: new () => { add(range: Range): unknown };
}

/** Own only these two highlight names; selection and other feature highlights survive. */
export function paintDesktopPageMatches(
  documents: readonly Document[], matches: readonly DesktopPageMatch[], activeIndex: number
): boolean {
  for (const owner of documents) {
    const target = owner.defaultView as unknown as HighlightWindow | null;
    if (target?.CSS?.highlights === undefined || target.Highlight === undefined) return false;
    const allHighlights = new target.Highlight();
    const activeHighlight = new target.Highlight();
    for (const match of matches) if (match.document === owner) allHighlights.add(match.range);
    const active = matches[activeIndex];
    if (active?.document === owner) activeHighlight.add(active.range);
    target.CSS.highlights.set(PAGE_SEARCH_HIGHLIGHT, allHighlights);
    target.CSS.highlights.set(PAGE_SEARCH_ACTIVE_HIGHLIGHT, activeHighlight);
  }
  return true;
}

export function clearDesktopPageHighlights(documents: Iterable<Document>): void {
  for (const owner of documents) {
    const target = owner.defaultView as unknown as HighlightWindow | null;
    target?.CSS?.highlights?.delete(PAGE_SEARCH_HIGHLIGHT);
    target?.CSS?.highlights?.delete(PAGE_SEARCH_ACTIVE_HIGHLIGHT);
  }
}

export function scrollDesktopPageMatch(match: DesktopPageMatch): void {
  const owner = match.document;
  const element = match.range.startContainer.parentElement;
  if (element === null) return;
  // Reveal the text's containing scrollers first, then center the actual range
  // rather than a potentially very tall paragraph. Neither operation moves focus.
  element.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
  for (let ancestor = element.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
    const style = owner.defaultView!.getComputedStyle(ancestor);
    const rect = match.range.getBoundingClientRect();
    const bounds = ancestor.getBoundingClientRect();
    if ((style.overflowY === "auto" || style.overflowY === "scroll")
      && (rect.top < bounds.top || rect.bottom > bounds.bottom)) {
      ancestor.scrollTop += rect.top - bounds.top - Math.max(0, (ancestor.clientHeight - rect.height) / 2);
    }
    if ((style.overflowX === "auto" || style.overflowX === "scroll")
      && (rect.left < bounds.left || rect.right > bounds.right)) {
      ancestor.scrollLeft += rect.left - bounds.left - Math.max(0, (ancestor.clientWidth - rect.width) / 2);
    }
  }
  const rect = match.range.getBoundingClientRect();
  if (rect.top < 0 || rect.bottom > owner.defaultView!.innerHeight) {
    owner.defaultView!.scrollBy({ top: rect.top - Math.max(0, (owner.defaultView!.innerHeight - rect.height) / 2), behavior: "instant" });
  }
  try { owner.defaultView?.frameElement?.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch { /* Separate origin. */ }
}
