// @vitest-environment jsdom

import { unicodeCorpus } from "../i18n/test-corpus.js";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { translate } from "../i18n.js";
import { DesktopPageSearchBar } from "./DesktopPageSearchBar.js";
import { findDesktopPageMatches, PAGE_SEARCH_ACTIVE_HIGHLIGHT, PAGE_SEARCH_HIGHLIGHT } from "./desktop-page-search.js";

const roots: Root[] = [];
const restores: Array<() => void> = [];
let highlights: Map<string, Set<Range>>;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    queueMicrotask(() => callback(0));
    return 1;
  });
  highlights = installPaintHost(window);
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
  for (const restore of restores.splice(0).reverse()) restore();
  Reflect.deleteProperty(window, "jokoDesktop");
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  vi.restoreAllMocks();
});

describe("DesktopPageSearchBar", () => {
  it("keeps composition and candidate keys in the input, then highlights committed text", async () => {
    document.body.innerHTML = unicodeCorpus.repeatedCjkParagraph;
    const nativeStart = vi.fn();
    await render(nativeStart);
    await pressFindShortcut();
    const input = searchInput();
    await act(async () => {
      input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      setInput(input, "zhong");
    });
    for (const key of ["Enter", "Escape"]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      await act(async () => input.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
    }
    expect(highlights.size).toBe(0);
    expect(document.activeElement).toBe(input);
    await act(async () => {
      setInput(input, unicodeCorpus.cjkWord);
      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: unicodeCorpus.cjkWord }));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(count()).toBe("1/2");
    expect(highlights.get(PAGE_SEARCH_HIGHLIGHT)?.size).toBe(2);
    await pressInputKey("Enter");
    expect(count()).toBe("2/2");
    expect(nativeStart).not.toHaveBeenCalled();
  });

  it("never matches its own query, navigates without moving focus or caret, and clears only its own highlights", async () => {
    document.body.innerHTML = '<button id="return">Return</button><p>needle and <strong>needle</strong></p>';
    const returnFocus = document.querySelector<HTMLButtonElement>("#return")!;
    returnFocus.focus();
    const other = new Set<Range>();
    highlights.set("other-feature", other);
    await render();
    await pressFindShortcut();
    await typeQuery("needle");
    const input = searchInput();
    input.setSelectionRange(2, 4);
    expect(count()).toBe("1/2");
    expect([...highlights.get(PAGE_SEARCH_ACTIVE_HIGHLIGHT)!][0]!.startContainer.parentElement?.tagName).toBe("P");
    await pressInputKey("Enter");
    expect(count()).toBe("2/2");
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 4]);
    await pressInputKey("Enter", true);
    expect(count()).toBe("1/2");
    await typeQuery("Find in page");
    expect(count()).toBe("0/0");
    await pressInputKey("Escape");
    expect(document.querySelector('[role="search"]')).toBeNull();
    expect(document.activeElement).toBe(returnFocus);
    expect(highlights).toEqual(new Map([["other-feature", other]]));
  });

  it("refreshes streamed text and visibility without losing the current occurrence or input selection", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<p id="first">needle</p><p id="second">needle</p><details><summary>More</summary><p>needle</p></details>';
    await render();
    await pressFindShortcut();
    await typeQuery("needle");
    await pressInputKey("Enter");
    const input = searchInput();
    input.setSelectionRange(1, 1);
    await act(async () => {
      document.querySelector("#first")!.textContent = "needle needle";
      document.querySelector("details")!.setAttribute("open", "");
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(count()).toBe("3/4");
    expect([...highlights.get(PAGE_SEARCH_ACTIVE_HIGHLIGHT)!][0]!.startContainer.parentElement?.id).toBe("second");
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([1, 1]);
    await act(async () => {
      document.querySelector<HTMLElement>("#second")!.hidden = true;
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(count()).toBe("3/3");
    await pressInputKey("Escape");
    await act(async () => {
      document.querySelector("p")!.textContent += " needle";
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(highlights.has(PAGE_SEARCH_HIGHLIGHT)).toBe(false);
  });

  it("leaves document Find to a visible owner and leaves ordinary browsers to native Find", async () => {
    await render();
    const owner = document.createElement("section");
    owner.dataset.localPageSearchOwner = "true";
    document.body.append(owner);
    expect((await pressFindShortcut()).defaultPrevented).toBe(false);
    expect(document.querySelector('[role="search"]')).toBeNull();
    owner.hidden = true;
    await pressFindShortcut();
    expect(searchInput()).not.toBeNull();
    await pressInputKey("Escape");
    Reflect.deleteProperty(window, "jokoDesktop");
    await act(async () => roots[0]!.render(<DesktopPageSearchBar overrides={{}} t={(key) => key} />));
    expect((await pressFindShortcut()).defaultPrevented).toBe(false);
  });
});

describe("rendered page text matching", () => {
  it("maps normalized Unicode across inline nodes back to complete original glyphs", () => {
    document.body.innerHTML = unicodeCorpus.mixedNormalizationParagraph;
    for (const [query, expected] of [["café", "Cafe\u0301"], ["strasse", "STRAẞE"], ["한", "한"], ["file", "ﬁle"], ["🐾", "🐾"]]) {
      expect(findDesktopPageMatches(document, query!).matches.map((match) => match.range.toString())).toEqual([expected]);
    }
    document.body.innerHTML = "<p>ß</p><p>one<br>two</p>";
    expect(findDesktopPageMatches(document, "s").matches.map((match) => match.range.toString())).toEqual(["ß"]);
    expect(findDesktopPageMatches(document, "one two").matches.map((match) => match.range.toString())).toEqual(["onetwo"]);
    expect(findDesktopPageMatches(document, "ßone").matches).toHaveLength(0);
  });

  it("excludes nonpainted and clipped text while retaining aria-hidden and scrollable offscreen text", () => {
    document.body.innerHTML = '<p hidden>needle</p><p style="display:none">needle</p><p style="opacity:0">needle</p><div inert>needle</div><details><summary>More</summary>needle</details><p aria-hidden="true">needle</p><div style="overflow-y:hidden" data-box="clip"><span data-box="offscreen">needle</span></div><div style="overflow-y:auto" data-box="clip"><span data-box="offscreen">needle</span></div>';
    expect(findDesktopPageMatches(document, "needle").matches).toHaveLength(2);
  });

  it("matches rendered segment breaks without deleting Korean spaces or preformatted whitespace", () => {
    document.body.innerHTML = unicodeCorpus.cjkAndKoreanWhitespaceParagraphs;
    expect(findDesktopPageMatches(document, unicodeCorpus.cjkWord).matches.map((match) => match.range.toString())).toEqual([unicodeCorpus.cjkWordAcrossLine]);
    expect(findDesktopPageMatches(document, "한글").matches).toHaveLength(0);
    expect(findDesktopPageMatches(document, "한 글").matches).toHaveLength(1);
    expect(findDesktopPageMatches(document, "visible").matches).toHaveLength(1);
  });

  it("includes accessible frame text at its document position and ignores inaccessible frames", () => {
    document.body.innerHTML = '<p>needle before</p><iframe></iframe><p>needle after</p>';
    const frame = document.querySelector("iframe")!;
    frame.contentDocument!.body.innerHTML = "<p>needle inside</p>";
    installPaintHost(frame.contentWindow! as Window & typeof globalThis);
    const result = findDesktopPageMatches(document, "needle");
    expect(result.matches.map((match) => match.range.startContainer.textContent)).toEqual(["needle before", "needle inside", "needle after"]);
    Object.defineProperty(frame, "contentDocument", { configurable: true, get: () => { throw new DOMException("Blocked", "SecurityError"); } });
    expect(findDesktopPageMatches(document, "needle").matches).toHaveLength(2);
  });
});

function replaceProperty(target: object, key: PropertyKey, value: unknown): void {
  const previous = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, value });
  restores.push(() => {
    if (previous === undefined) Reflect.deleteProperty(target, key);
    else Object.defineProperty(target, key, previous);
  });
}

function installPaintHost(owner: Window & typeof globalThis): Map<string, Set<Range>> {
  const values = new Map<string, Set<Range>>();
  replaceProperty(owner, "CSS", { highlights: values });
  replaceProperty(owner, "Highlight", class extends Set<Range> { constructor(...ranges: Range[]) { super(ranges); } });
  const box = (element: Element | null): DOMRect => {
    const y = element?.closest('[data-box="offscreen"]') !== null ? 500 : 10;
    return { x: 10, y, left: 10, right: 110, top: y, bottom: y + 20, width: 100, height: 20, toJSON: () => ({}) };
  };
  replaceProperty(owner.Range.prototype, "getClientRects", function (this: Range) { return [box(this.startContainer.parentElement)]; });
  replaceProperty(owner.Range.prototype, "getBoundingClientRect", function (this: Range) { return box(this.startContainer.parentElement); });
  replaceProperty(owner.Element.prototype, "getBoundingClientRect", function (this: Element) { return box(this); });
  replaceProperty(owner.Element.prototype, "scrollIntoView", vi.fn());
  return values;
}

async function render(nativeStart = vi.fn()): Promise<void> {
  Object.defineProperty(window, "jokoDesktop", { configurable: true, value: { capabilities: ["page.search"], pageSearch: { start: nativeStart } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<DesktopPageSearchBar overrides={{}} t={(key, values) => translate("en", key, values)} />));
}

function searchInput(): HTMLInputElement { return document.querySelector<HTMLInputElement>('[role="search"] input')!; }
function count(): string | null { return document.querySelector(".desktop-page-search-bar__count")!.textContent; }
function setInput(input: HTMLInputElement, text: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
async function typeQuery(text: string): Promise<void> { await act(async () => setInput(searchInput(), text)); }
async function pressInputKey(key: string, shiftKey = false): Promise<void> {
  await act(async () => searchInput().dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true })));
}
async function pressFindShortcut(): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { key: "f", code: "KeyF", ctrlKey: true, bubbles: true, cancelable: true });
  await act(async () => window.dispatchEvent(event));
  return event;
}
