// @vitest-environment jsdom
import { unicodeCorpus } from "../i18n/test-corpus.js";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TimelineMarkdownDocument } from "./TimelineMarkdownDocument.js";
import { StreamingMarkdown, Timeline } from "./Timeline.js";
import type { Translator } from "./types.js";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

it("reuses unchanged blocks but applies later document definitions and current URL policy", async () => {
  const paragraphs = vi.fn();
  const components: Components = { p: ({ node: _node, ...props }) => { paragraphs(props.children); return <p {...props} />; } };
  const plugins = [remarkGfm];
  const render = (text: string, transform?: (url: string) => string): void => {
    act(() => root.render(<TimelineMarkdownDocument components={components} remarkPlugins={plugins} skipHtml urlTransform={transform}>{text}</TimelineMarkdownDocument>));
  };
  render("Stable **block**.\n\n[reference][target]\n\nTail");
  const stable = host.querySelector("strong")!.firstChild!;
  const range = document.createRange();
  range.selectNodeContents(stable);
  window.getSelection()!.addRange(range);
  paragraphs.mockClear();
  render("Stable **block**.\n\n[reference][target]\n\nTail grows");
  expect(paragraphs).toHaveBeenCalledTimes(1);
  expect(window.getSelection()!.anchorNode).toBe(stable);
  expect(host.querySelector("strong")!.firstChild).toBe(stable);
  render("Stable **block**.\n\n[reference][target]\n\nTail grows\n\n[target]: https://example.test\n\n<script>hidden()</script>");
  expect(host.querySelector("a")?.href).toBe("https://example.test/");
  expect(host.querySelector("script")).toBeNull();
  render("Stable **block**.\n\n[reference][target]\n\nTail grows\n\n[target]: https://example.test", () => "");
  expect(host.querySelector("a")?.getAttribute("href")).toBe("");
});

it("keeps mounted word timing and selection through appends and renders completed thinking code in its Markdown surface", async ({ onTestFinished }) => {
  vi.useFakeTimers();
  let now = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const t = ((key: string) => key) as Translator;
  const render = async (text: string, streaming = true): Promise<void> => {
    await act(async () => {
      root.render(<StreamingMarkdown text={text} streaming={streaming} streamFadeKey="mounted-word-continuity" t={t} />);
    });
    now += 150;
    await act(async () => vi.advanceTimersByTime(150));
  };
  await render("First paragraph.\n\nNext");
  const word = host.querySelector<HTMLElement>(".stream-word")!;
  const text = word.firstChild!;
  const style = word.getAttribute("style");
  const range = document.createRange();
  range.selectNodeContents(text);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  const mutations: MutationRecord[] = [];
  const observer = new MutationObserver((records) => mutations.push(...records));
  observer.observe(word, { attributes: true, childList: true, subtree: true, characterData: true });
  await render("First paragraph.\n\nNext words\n\n```diff\n- old\n+ ne");
  expect(host.querySelector(".timeline-markdown-diff__row--added .timeline-markdown-diff__text")?.textContent).toBe("ne");
  await render("First paragraph.\n\nNext words\n\n```diff\n- old\n+ new");
  expect(host.querySelector(".timeline-markdown-diff__row--added .timeline-markdown-diff__text")?.textContent).toBe("new");
  expect(host.querySelector(".stream-word")).toBe(word);
  expect(word.getAttribute("style")).toBe(style);
  expect(window.getSelection()!.anchorNode).toBe(text);
  expect(mutations).toHaveLength(0);
  observer.disconnect();
  await render("First paragraph.\n\nNext words\n\n```diff\n- old\n+ new\n```", false);
  expect(host.querySelector(".stream-word")).toBeNull();
  expect(host.textContent).toContain("Next words");
  expect(host.querySelectorAll(".timeline-markdown-diff__row")).toHaveLength(2);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
  const previousScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  onTestFinished(() => {
    if (previousScrollTo === undefined) Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
    else Object.defineProperty(HTMLElement.prototype, "scrollTo", previousScrollTo);
  });
  await act(async () => root.render(<Timeline
    ownerKey="thinking-owner" sessionId="thinking-session" sessionName="Thinking" sessionActive={false}
    items={[{ id: "thinking", sequence: 1n, kind: "thinking", createdAt: 0, text: "```diff\n- old\n+ " + "long line ".repeat(50) + "\n```" }]}
    messageNavRailEnabled={false} streamFadeEnabled={false} hasEarlier={false} historyLoading={false}
    locale="en" t={t} onLoadEarlier={async () => undefined}
    onArtifactUrl={async () => ""} onArtifactUrlRelease={() => undefined} onArtifactDownload={async () => "dispatched"}
  />));
  await act(async () => vi.advanceTimersByTime(32));
  await act(async () => host.querySelector<HTMLButtonElement>(".work-group__header")!.click());
  const thinkingCode = host.querySelector(".thinking-block pre");
  expect(thinkingCode).not.toBeNull();
  expect(thinkingCode?.closest(".markdown")).toBe(host.querySelector(".thinking-block__content"));
  expect(thinkingCode?.getAttribute("tabindex")).toBe("0");
});

it("preserves explicit URL destinations while a streamed bare link returns punctuation and adjacent prose to text", async () => {
  vi.useFakeTimers();
  const t = ((key: string) => key) as Translator;
  const render = async (text: string, streaming = true): Promise<void> => {
    await act(async () => root.render(<StreamingMarkdown text={text} streaming={streaming} t={t} />));
    await act(async () => vi.advanceTimersByTime(150));
  };
  await render(unicodeCorpus.streamedUnclosedMarkdownLink);
  expect(host.querySelector("a")).toBeNull();
  const stable = host.querySelector("strong")!.firstChild!;
  const range = document.createRange();
  range.selectNodeContents(stable);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  const source = unicodeCorpus.streamedCompleteMarkdownLinks;
  await render(source);
  expect([...host.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual([
    "https://example.test/search?q=%5Ba%5D", "https://example.test/x;",
    "https://example.test/path%EF%BC%88%E8%AF%B4%E6%98%8E%EF%BC%89",
    "https://example.test/foo/93", "https://other.test/y"
  ]);
  expect(host.textContent).toContain(unicodeCorpus.bareLinksWithCjkProse);
  expect(host.querySelector("strong")!.firstChild).toBe(stable);
  expect(window.getSelection()!.anchorNode).toBe(stable);
  await render(source, false);
  expect(host.querySelectorAll("a")).toHaveLength(5);
  await render(unicodeCorpus.explicitLinksCodeAndCjkHeading, false);
  expect([...host.querySelectorAll("a")].map((link) => decodeURIComponent(link.href))).toEqual([
    unicodeCorpus.urlWithLiteralCjkParentheses, "https://example.test/search?q=[a]#part{b}", "https://example.test/search?q=a)b"
  ]);
  expect(host.querySelector("code")?.textContent).toBe(unicodeCorpus.codeUrlWithCjkParentheses);
  expect(host.querySelector("strong")?.textContent).toBe(unicodeCorpus.cjkHeadingWithColon);
});
