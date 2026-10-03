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

it("keeps mounted words through appends and fresh application actions, and renders completed thinking code in its Markdown surface", async ({ onTestFinished }) => {
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
  const previousScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  onTestFinished(() => {
    if (previousScrollTo === undefined) Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
    else Object.defineProperty(HTMLElement.prototype, "scrollTo", previousScrollTo);
  });
  let now = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const t = ((key: string) => key) as Translator;
  const oldOpen = vi.fn();
  const currentOpen = vi.fn();
  const render = async (text: string, streaming = true, onOpen = currentOpen): Promise<void> => {
    await act(async () => {
      root.render(<Timeline
        ownerKey="mounted-word-owner" viewportOwnerKey="mounted-word-viewport" sessionId="mounted-word-continuity" sessionName="Words" sessionActive={streaming}
        items={[{ id: "answer", sequence: 1n, kind: "assistant", createdAt: 0, text, streaming }]}
        messageNavRailEnabled={false} streamFadeEnabled hasEarlier={false} historyLoading={false}
        locale="en" t={t} onLoadEarlier={async () => undefined}
        onOpenHttpLink={(url, options) => { onOpen(url, options); }}
        onArtifactUrl={async () => ""} onArtifactUrlRelease={() => undefined} onArtifactDownload={async () => "dispatched"}
      />);
    });
    now += 150;
    await act(async () => vi.advanceTimersByTime(150));
  };
  const stableParagraph = "First paragraph. [link](https://example.test/current)";
  await render(`${stableParagraph}\n\nNext`, true, oldOpen);
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
  await render(`${stableParagraph}\n\nNext words\n\n\`\`\`diff\n- old\n+ ne`);
  expect(host.querySelector(".timeline-markdown-diff__row--added .timeline-markdown-diff__text")?.textContent).toBe("ne");
  await render(`${stableParagraph}\n\nNext words\n\n\`\`\`diff\n- old\n+ new`);
  expect(host.querySelector(".timeline-markdown-diff__row--added .timeline-markdown-diff__text")?.textContent).toBe("new");
  expect(host.querySelector(".stream-word")).toBe(word);
  expect(word.getAttribute("style")).toBe(style);
  expect(window.getSelection()!.anchorNode).toBe(text);
  expect(mutations).toHaveLength(0);
  observer.disconnect();
  await act(async () => host.querySelector<HTMLAnchorElement>("a")!.click());
  expect(oldOpen).not.toHaveBeenCalled();
  expect(currentOpen).toHaveBeenCalledTimes(1);
  expect(currentOpen.mock.calls[0]![0]).toBe("https://example.test/current");
  await render(`${stableParagraph}\n\nNext words\n\n\`\`\`diff\n- old\n+ new\n\`\`\``, false);
  expect(host.querySelector(".stream-word")).toBeNull();
  expect(host.textContent).toContain("Next words");
  expect(host.querySelectorAll(".timeline-markdown-diff__row")).toHaveLength(2);
  await act(async () => root.render(<Timeline
    ownerKey="thinking-owner" viewportOwnerKey="thinking-viewport" sessionId="thinking-session" sessionName="Thinking" sessionActive={false}
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

it("uses the current streaming animation admission for incomplete Markdown repair", async ({ onTestFinished }) => {
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
  const previousScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
  const previousMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  let reducedMotion = false;
  const motion = new EventTarget();
  Object.defineProperty(motion, "matches", { get: () => reducedMotion });
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => motion as MediaQueryList });
  onTestFinished(() => {
    if (previousScrollTo === undefined) Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
    else Object.defineProperty(HTMLElement.prototype, "scrollTo", previousScrollTo);
    if (previousMatchMedia === undefined) Reflect.deleteProperty(window, "matchMedia");
    else Object.defineProperty(window, "matchMedia", previousMatchMedia);
  });
  const t = ((key: string) => key) as Translator;
  const incomplete = ["**unfinished", "[label](https://example.test/unfinished", "![image"];
  const render = async (streamFadeEnabled: boolean, streaming = true): Promise<void> => {
    await act(async () => root.render(<Timeline
      ownerKey="repair-admission" viewportOwnerKey="repair-admission-viewport" sessionId="repair-session" sessionName="Repair" sessionActive={streaming}
      items={incomplete.map((text, index) => ({ id: `incomplete-${index}`, sequence: BigInt(index + 1), kind: "assistant", createdAt: 0, text, streaming }))}
      messageNavRailEnabled={false} streamFadeEnabled={streamFadeEnabled} hasEarlier={false} historyLoading={false}
      locale="en" t={t} onLoadEarlier={async () => undefined}
      onArtifactUrl={async () => ""} onArtifactUrlRelease={() => undefined} onArtifactDownload={async () => "dispatched"}
    />));
  };
  const bodies = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(".message-assistant__body")];
  const expectRepaired = (): void => {
    expect(bodies().map((body) => body.textContent)).toEqual(["unfinished", "label", "image"]);
    expect(bodies()[0]!.querySelector("strong")?.textContent).toBe("unfinished");
    expect(host.querySelector(".stream-word")).not.toBeNull();
  };
  const expectRaw = (): void => {
    expect(bodies().map((body) => body.textContent)).toEqual(incomplete);
    expect(bodies()[0]!.querySelector("strong")).toBeNull();
    expect(host.querySelector(".stream-word")).toBeNull();
  };
  const setReducedMotion = async (value: boolean): Promise<void> => {
    reducedMotion = value;
    const event = new Event("change");
    Object.defineProperty(event, "matches", { value });
    await act(async () => { motion.dispatchEvent(event); });
  };
  await render(true);
  await act(async () => vi.advanceTimersByTime(32));
  expectRepaired();
  await render(false);
  expectRaw();
  await render(true);
  expectRepaired();
  await setReducedMotion(true);
  expectRaw();
  await setReducedMotion(false);
  expectRepaired();
  await render(true, false);
  expectRaw();
});
