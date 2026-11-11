// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ArtifactView, TimelineItemView } from "../model.js";
import { Timeline } from "./Timeline.js";
import type { Translator } from "./types.js";

type TimelineProps = ComponentProps<typeof Timeline>;
interface PendingFrame { readonly callback: FrameRequestCallback; cancelled: boolean }
interface ScrollWrite { readonly node: HTMLElement; readonly top: number; readonly behavior: ScrollBehavior | undefined }

let host: HTMLDivElement;
let root: Root;
let props: TimelineProps;
let extent: number;
let viewportHeight: number;
let frameId: number;
let ownerId = 0;
let frames: Map<number, PendingFrame>;
let scrollWrites: ScrollWrite[];
let observers: Set<ViewportResizeObserver>;
const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
const originalScrollBy = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollBy");

class ViewportResizeObserver implements ResizeObserver {
  readonly targets = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) { observers.add(this); }
  observe(target: Element): void { this.targets.add(target); }
  unobserve(target: Element): void { this.targets.delete(target); }
  disconnect(): void { this.targets.clear(); observers.delete(this); }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  frames = new Map();
  observers = new Set();
  scrollWrites = [];
  extent = 4_000;
  viewportHeight = 600;
  frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++frameId;
    frames.set(id, { callback, cancelled: false });
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    const frame = frames.get(id);
    if (frame !== undefined) frame.cancelled = true;
  });
  vi.stubGlobal("ResizeObserver", ViewportResizeObserver);
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener(): void {},
    removeEventListener(): void {}
  }));
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) { return this.classList.contains("timeline") ? viewportHeight : 80; });
  vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(620);
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) { return this.classList.contains("timeline") ? extent : 80; });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("timeline") ? viewportHeight : 80; });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(656);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const viewport = this.classList.contains("timeline") ? this : this.closest<HTMLElement>(".timeline");
    const row = this.closest<HTMLElement>(".timeline__row");
    const start = Number.parseFloat(row?.style.transform.replace(/^translateY\(/, "") ?? "0") || 0;
    const isRoot = this === viewport;
    const top = isRoot ? 0 : start - (viewport?.scrollTop ?? 0);
    const height = isRoot ? viewportHeight : this.classList.contains("timeline__virtual") ? extent : 80;
    const left = isRoot ? 0 : 64;
    return { x: left, y: top, left, top, right: left + 592, bottom: top + height, width: 592, height, toJSON: () => ({}) };
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value(this: HTMLElement, options: ScrollToOptions): void {
      const top = Math.max(0, Math.min(extent - viewportHeight, options.top ?? this.scrollTop));
      this.scrollTop = top;
      scrollWrites.push({ node: this, top, behavior: options.behavior });
    }
  });
  Object.defineProperty(HTMLElement.prototype, "scrollBy", {
    configurable: true,
    value(this: HTMLElement, options: ScrollToOptions): void { this.scrollTo({ ...options, top: this.scrollTop + (options.top ?? 0) }); }
  });
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const owner = `viewport-owner-${++ownerId}`;
  props = {
    ownerKey: owner,
    viewportOwnerKey: `${owner}:task:1`,
    sessionId: "task",
    sessionName: "Task",
    sessionActive: true,
    items: Array.from({ length: 8 }, (_, index) => item(`initial-${index}`, index + 1, "user")),
    messageNavRailEnabled: true,
    streamFadeEnabled: false,
    hasEarlier: false,
    historyLoading: false,
    locale: "en",
    t: ((key: string) => key) as Translator,
    onLoadEarlier: async () => undefined,
    onArtifactUrl: async () => "",
    onArtifactUrlRelease: () => undefined,
    onArtifactDownload: async () => "dispatched"
  };
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  restorePrototypeMethod("scrollTo", originalScrollTo);
  restorePrototypeMethod("scrollBy", originalScrollBy);
});

describe("Timeline viewport journeys", () => {
  it("routes only a clicked assistant answer through the current timeline host", async () => {
    const send = vi.fn(async () => true);
    const text = '```joko-ui\n' + JSON.stringify({ seq: 1, op: "create", id: "continue", kind: "button",
      props: { label: "Continue answer", send: "Please continue this task" } }) + '\n```';
    await render({ answerStateOwnerKey: "timeline/send-owner", onSendRichAnswer: send,
      items: [{ ...item("rich-answer", 1, "assistant"), text, streaming: false }] });
    await flushFrames();
    expect(send).not.toHaveBeenCalled();
    const button = host.querySelector<HTMLButtonElement>('[data-rich-answer] button');
    expect(button).not.toBeNull();
    await act(async () => button!.click());
    expect(send).toHaveBeenCalledExactlyOnceWith("Please continue this task", expect.stringContaining(":sent:continue"));
    await render({ onSendRichAnswer: undefined, answerStateOwnerKey: "timeline/read-only" });
    expect(host.querySelector<HTMLButtonElement>('[data-rich-answer] button')?.disabled).toBe(true);
  });
  it("reloads failed attachments and images after the same task connection recovers", async () => {
    const artifact: ArtifactView = { id: "recover-image", blobId: "same-blob", kind: "image", fileName: "image.png", title: "Recover image", mediaType: "image/png", byteSize: 8, sourceRevealAvailable: false };
    const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue("blob:recovered-image");
    const release = vi.fn();
    await render({ ownerKey: "same-profile:task:1:offline", onArtifactUrl: load, onArtifactUrlRelease: release, items: [
      { ...item("attachment", 1, "user"), attachments: [artifact] }, { ...item("image", 2, "image"), artifact }
    ] });
    await flushFrames();
    expect(host.querySelectorAll(".image-preview--failed")).toHaveLength(2);
    expect(load).toHaveBeenCalledOnce();
    await render({ ownerKey: "same-profile:task:1:connected" });
    await flushFrames();
    expect(load).toHaveBeenCalledTimes(2);
    expect(host.querySelectorAll('img[src="blob:recovered-image"]')).toHaveLength(2);
    expect(host.querySelector(".image-preview--failed")).toBeNull();
    expect(release).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    root = createRoot(host);
    expect(release).toHaveBeenCalledExactlyOnceWith("same-blob");
  });

  it("lands Home at the history boundary before virtual-row corrections can interrupt native keyboard scrolling", async () => {
    const loadEarlier = vi.fn(async () => undefined);
    await render({ hasEarlier: true, messageNavRailEnabled: false, onLoadEarlier: loadEarlier });
    const viewport = timeline();
    expect(viewport.scrollTop).toBeGreaterThan(0);
    await act(async () => {
      const intent = new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true });
      viewport.dispatchEvent(intent);
      expect(viewport.scrollTop).toBe(0);
      expect(intent.defaultPrevented).toBe(true);
      viewport.dispatchEvent(new Event("scroll"));
    });
    expect(loadEarlier).toHaveBeenCalledTimes(1);
    await flushFrames();
    expect(viewport.scrollTop).toBe(0);
  });

  it("restores the new reading position after Home and a same-owner reopen", async () => {
    extent = 1_080;
    await render({ messageNavRailEnabled: false });
    const viewport = timeline();
    await flushFrames();
    await act(async () => viewport.dispatchEvent(new Event("scroll")));
    expect(viewport.scrollTop).toBe(extent - viewport.clientHeight);
    expect(viewport.querySelectorAll(".timeline__row")).toHaveLength(props.items.length);

    await act(async () => {
      viewport.focus();
      viewport.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
      viewport.dispatchEvent(new Event("scroll"));
    });
    await flushFrames();
    expect(viewport.scrollTop).toBe(0);
    expect(viewport.querySelectorAll(".timeline__row")).toHaveLength(props.items.length);

    await act(async () => root.unmount());
    root = createRoot(host);
    await render();
    await flushFrames();
    expect(timeline().scrollTop).toBe(0);
    expectUnread(0);
  });

  it("leaves Page Up with the focused long tool output while it can scroll upward", async () => {
    await render({ items: [...props.items, {
      ...item("long-tool", 9, "tool"),
      tool: { id: "long-tool", name: "bash", state: "running", input: "", output: "Tool output line\n".repeat(1_200), isError: false }
    }] });
    const output = host.querySelector<HTMLElement>(".windowed-output")!;
    output.style.overflowY = "auto";
    Object.defineProperty(output, "scrollHeight", { value: 500 });
    output.scrollTop = 120;
    await act(async () => output.focus());
    expect(document.activeElement).toBe(output);

    const withinOutput = new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true });
    await act(async () => output.dispatchEvent(withinOutput));
    expect(withinOutput.defaultPrevented).toBe(false);
    expect(jumpLatest()).toBeNull();

    output.scrollTop = 0;
    await act(async () => output.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true })));
    expectUnread(0);
  });

  it("focuses the original ordinary search row once it is highlighted", async () => {
    await render();
    const viewport = timeline();
    await act(async () => viewport.focus());
    const row = viewport.querySelector<HTMLElement>('[data-timeline-item-id="initial-3"]')!;
    expect(row.hasAttribute("tabindex")).toBe(false);

    await render({ focusRequest: { itemId: "initial-3", requestId: 1 } });
    expect(row.getAttribute("aria-current")).toBe("true");
    expect(document.activeElement).toBe(row);

    await act(async () => viewport.focus());
    await append([item("later-answer", 9, "assistant")]);
    expect(document.activeElement).toBe(viewport);
  });

  it("keeps virtual-row corrections from detaching a growing tail after a delayed scroll event", async () => {
    await render({ items: Array.from({ length: 60 }, (_, index) => item(`measured-${index}`, index + 1, "user")) });
    await flushFrames();
    const viewport = timeline();
    await act(async () => viewport.dispatchEvent(new Event("scroll")));
    const above = [...viewport.querySelectorAll<HTMLElement>(".timeline__row")]
      .filter(row => row.getBoundingClientRect().bottom <= 0).slice(0, 2);
    expect(above).toHaveLength(2);
    const before = viewport.scrollTop;
    const now = vi.spyOn(performance, "now").mockReturnValue(10_000);
    await act(async () => {
      for (const observer of [...observers]) {
        const entries = above.filter(row => observer.targets.has(row)).map(target => ({
          target, borderBoxSize: [{ blockSize: 10, inlineSize: 592 }]
        }) as unknown as ResizeObserverEntry);
        if (entries.length > 0) observer.callback(entries, observer);
      }
    });
    expect(viewport.scrollTop).toBeLessThan(before);
    extent += 200;
    now.mockReturnValue(11_000);
    await act(async () => viewport.dispatchEvent(new Event("scroll")));
    expect(jumpLatest()).toBeNull();
    await contentResize();
    expect(viewport.scrollTop).toBe(extent - viewport.clientHeight);
  });

  it("holds the clicked completed work heading through layout and then follows tail growth again", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const header = await renderCompletedWork();
    const viewport = timeline();
    const originalTop = viewport.scrollTop;
    const headerTop = header.getBoundingClientRect().top;

    await act(async () => header.querySelector<HTMLElement>("strong")!.click());
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(header.parentElement?.querySelectorAll("[data-work-child-id]")).toHaveLength(8);
    extent += 480;
    await contentResize();
    expect(viewport.scrollTop).toBe(originalTop);
    expect(header.getBoundingClientRect().top).toBe(headerTop);
    expect(jumpLatest()).toBeNull();

    now.mockReturnValue(1_150);
    extent += 70;
    // A later layout pass may already have applied browser scroll anchoring.
    viewport.scrollTop += 60;
    await act(async () => viewport.dispatchEvent(new Event("scroll")));
    await notifyResize(header.closest(".timeline__row")!);
    expect(viewport.scrollTop).toBe(originalTop);
    expect(header.getBoundingClientRect().top).toBe(headerTop);

    now.mockReturnValue(1_301);
    extent += 90;
    await contentResize();
    expect(viewport.scrollTop).toBe(extent - viewport.clientHeight);
    expect(jumpLatest()).toBeNull();
  });

  it("gives new content in the same streaming tail priority over work group layout", async () => {
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    const header = await renderCompletedWork(true);
    const viewport = timeline();
    const originalTop = viewport.scrollTop;
    await act(async () => header.click());
    extent += 480;
    await contentResize();
    expect(viewport.scrollTop).toBe(originalTop);

    const tail = props.items.at(-1)!;
    extent += 90;
    await render({ items: [...props.items.slice(0, -1), { ...tail, text: `${tail.text} More streamed content.` }] });
    await contentResize();
    expect(viewport.scrollTop).toBe(extent - viewport.clientHeight);
    expect(jumpLatest()).toBeNull();
  });

  it.each(["wheel", "PageDown", "task change", "pagehide"] as const)("retires a pending work group correction after %s", async (input) => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const header = await renderCompletedWork();
    const viewport = timeline();
    now.mockReturnValue(1_100);
    await act(async () => header.click());
    const originalTop = viewport.scrollTop;
    extent += 480;
    viewport.scrollTop += 60;
    await contentResize();
    expect(viewport.scrollTop).toBe(originalTop);

    extent += 80;
    await queueResize(host.querySelector(".timeline__virtual")!);
    const pending = [...frames.values()];
    expect(pending.length).toBeGreaterThan(0);

    if (input === "wheel") {
      await wheel(viewport, -40);
      viewport.scrollTop -= 40;
      await act(async () => viewport.dispatchEvent(new Event("scroll")));
      expectUnread(0);
    } else if (input === "PageDown") {
      await act(async () => header.dispatchEvent(new KeyboardEvent("keydown", { key: input, bubbles: true, cancelable: true })));
      viewport.scrollTop += 160;
      await act(async () => viewport.dispatchEvent(new Event("scroll")));
    } else if (input === "task change") {
      await render({ sessionId: "next-task", viewportOwnerKey: `${props.viewportOwnerKey}:next-task` });
    } else {
      await act(async () => window.dispatchEvent(new Event("pagehide")));
    }

    const nextTop = viewport.scrollTop;
    scrollWrites.length = 0;
    await replayFrames(pending);
    expect(scrollWrites).toHaveLength(0);
    expect(viewport.scrollTop).toBe(nextTop);
    if (input === "wheel") {
      await contentResize();
      expect(viewport.scrollTop).toBe(nextTop);
    }
  });

  it("keeps a following tail at the edge when only the viewport shrinks", async () => {
    await render();
    await flushFrames();
    const viewport = timeline();
    const originalExtent = viewport.scrollHeight;
    expect(viewport.scrollTop).toBe(originalExtent - viewport.clientHeight);

    viewportHeight -= 100;
    await notifyResize(viewport);
    expect(viewport.scrollHeight).toBe(originalExtent);
    expect(viewport.scrollTop).toBe(originalExtent - viewport.clientHeight);
    expect(jumpLatest()).toBeNull();

    await scrollbarPress(viewport);
    const heldTop = viewport.scrollTop;
    viewportHeight -= 100;
    await notifyResize(viewport);
    expect(viewport.scrollTop).toBe(heldTop);
    await act(async () => window.dispatchEvent(new MouseEvent("mouseup", { button: 0 })));
    expect(viewport.scrollTop).toBe(originalExtent - viewport.clientHeight);
  });

  it("shows whole-Run accounting only on its current completion while keeping segment usage private to running status", async () => {
    const segmentUsage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0,
      totalTokens: 15, cost: 0.004, currency: "USD", generationDurationMs: 1_000, generationReliable: true };
    const answer = { ...item("answer", 1, "assistant"), runId: "run", usage: segmentUsage };
    await render({ items: [answer], sessionActive: false });
    expect(host.querySelector(".message-usage-meta")).toBeNull();
    await render({ items: [{ ...answer, turnUsage: { ...segmentUsage, totalTokens: 120, cost: 0.02, costComplete: true } }] });
    expect(host.querySelector(".message-usage-meta")?.textContent).toBe("$0.02");
    await render({ items: [answer] });
    expect(host.querySelector(".message-usage-meta")).toBeNull();
  });

  it("counts durable tail messages while detached and clears unread on downward intent at the edge", async () => {
    await render();
    const viewport = timeline();
    expect(host.querySelector("[data-timeline-item-id]")).not.toBeNull();
    expect(jumpLatest()).toBeNull();
    await wheel(viewport, -40, { ctrlKey: true });
    await wheel(viewport, -40, { metaKey: true });
    expect(jumpLatest()).toBeNull();
    await wheel(viewport, -40);
    expectUnread(0);

    await append([
      item("tool", 9, "tool"), item("thinking", 10, "thinking"),
      { ...item("status", 11, "status"), streaming: true }, item("result", 12, "toolResult")
    ]);
    expectUnread(0);
    await append([
      { ...item("assistant-a", 13, "assistant"), messageId: "answer", streaming: true },
      { ...item("assistant-b", 14, "assistant"), messageId: "answer", contentIndex: 1, streaming: true }
    ]);
    expectUnread(1);
    await render({ items: props.items.map((entry) => entry.messageId === "answer" ? { ...entry, streaming: false, text: "Completed answer" } : entry) });
    expectUnread(1);
    await append([
      interaction("question-row", 15, "question", "question"),
      interaction("plan-row", 16, "plan", "plan"),
      item("foreign-user", 17, "user"),
      { ...item("local-user", 18, "user"), inputOperationId: "local-operation", localUserInput: true },
      { ...item("continuation", 19, "user"), automaticContinuation: { recoveryId: "recovery" } },
      interaction("permission-row", 20, "permission", "permission")
    ]);
    expectUnread(4);
    await render({ items: [item("historical", 0, "assistant"), ...props.items] });
    expectUnread(4);
    await render({ items: [item("replacement-history", 100, "assistant")] });
    expectUnread(4);

    viewport.scrollTop = extent - viewport.clientHeight - 8;
    await wheel(viewport, 30, { ctrlKey: true });
    expectUnread(4);
    await wheel(viewport, 30);
    expect(jumpLatest()).toBeNull();
    expect(viewport.scrollTop).toBe(extent - viewport.clientHeight);
    await append([item("following-answer", 101, "assistant")]);
    expect(jumpLatest()).toBeNull();
  });

  it("suspends pinning during a scrollbar press and observes final drag position before release", async () => {
    await render();
    const viewport = timeline();
    const startingTop = viewport.scrollTop;
    await scrollbarPress(viewport);
    const content = host.querySelector<HTMLElement>(".timeline__virtual")!;
    expect(content.style.minHeight).toBe(`${extent}px`);
    const writesAfterPress = scrollWrites.length;
    extent += 400;
    await append([{ ...item("streamed-answer", 9, "assistant"), streaming: true }]);
    await contentResize();
    expect(viewport.scrollTop).toBe(startingTop);
    expect(scrollWrites).toHaveLength(writesAfterPress);
    expect(jumpLatest()).toBeNull();

    viewport.scrollTop -= 100;
    await act(async () => window.dispatchEvent(new MouseEvent("mousemove", { buttons: 1 })));
    expectUnread(0);
    await act(async () => window.dispatchEvent(new MouseEvent("mouseup", { button: 0 })));
    expect(content.style.minHeight).toBe("");
    const detachedTop = viewport.scrollTop;
    extent += 200;
    await append([item("detached-answer", 10, "assistant")]);
    await contentResize();
    expect(viewport.scrollTop).toBe(detachedTop);
    expectUnread(1);

    await act(async () => jumpLatest()?.click());
    expect(jumpLatest()).toBeNull();
    await scrollbarPress(viewport);
    viewport.scrollTop -= 80;
    // Release receives the browser's final position even without a prior scroll event.
    await act(async () => window.dispatchEvent(new MouseEvent("mouseup", { button: 0 })));
    expectUnread(0);
    await act(async () => jumpLatest()?.click());
    await act(async () => content.dispatchEvent(new MouseEvent("mousedown", { button: 0, clientX: 640, bubbles: true })));
    extent += 100;
    await append([item("content-click-answer", 11, "assistant")]);
    expect(viewport.scrollTop).toBe(extent - viewport.clientHeight);
  });

  it("retires navigation frames and scrollbar ownership across a newer request, generation change and pagehide", async () => {
    await render();
    const viewport = timeline();
    await flushFrames();
    const ticks = host.querySelectorAll<HTMLButtonElement>(".message-nav-rail__tick");
    expect(ticks.length).toBe(8);
    await act(async () => ticks[0]!.click());
    const superseded = [...frames.values()];
    await act(async () => ticks[1]!.click());
    scrollWrites.length = 0;
    await replayFrames(superseded);
    expect(scrollWrites).toHaveLength(0);
    await flushFrames();
    expect(scrollWrites.some((write) => write.behavior === "smooth")).toBe(false);

    await act(async () => host.querySelector<HTMLButtonElement>(".message-nav-rail__tick")?.click());
    const oldOwnerFrames = [...frames.values()];
    await scrollbarPress(viewport);
    await render({ ownerKey: `${props.ownerKey}:next`, viewportOwnerKey: `${props.viewportOwnerKey}:2` });
    expect(host.querySelector<HTMLElement>(".timeline__virtual")!.style.minHeight).toBe("");
    expect(jumpLatest()).toBeNull();
    const writesAfterOwnerChange = scrollWrites.length;
    await replayFrames(oldOwnerFrames);
    await act(async () => window.dispatchEvent(new MouseEvent("mousemove", { buttons: 1 })));
    expect(scrollWrites).toHaveLength(writesAfterOwnerChange);
    extent += 100;
    await append([item("new-generation-answer", 9, "assistant")]);
    expect(viewport.scrollTop).toBe(extent - viewport.clientHeight);

    await act(async () => host.querySelector<HTMLButtonElement>(".message-nav-rail__tick")?.click());
    const hiddenFrames = [...frames.values()];
    await scrollbarPress(viewport);
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    expect(host.querySelector<HTMLElement>(".timeline__virtual")!.style.minHeight).toBe("");
    scrollWrites.length = 0;
    await replayFrames(hiddenFrames);
    await contentResize();
    await act(async () => window.dispatchEvent(new MouseEvent("mouseup", { button: 0 })));
    expect(scrollWrites).toHaveLength(0);
    await act(async () => window.dispatchEvent(new Event("pageshow")));
    await append([item("after-pageshow", 10, "assistant")]);
    expect(scrollWrites.some((write) => write.top === extent - viewport.clientHeight)).toBe(false);
    await render({ followLatestSignal: 1 });
    expect(jumpLatest()).toBeNull();
    expect(viewport.scrollTop).toBe(extent - viewport.clientHeight);
  });
});

async function render(update: Partial<TimelineProps> = {}): Promise<void> {
  props = { ...props, ...update };
  await act(async () => root.render(<Timeline {...props} />));
}

async function renderCompletedWork(streaming = false): Promise<HTMLButtonElement> {
  viewportHeight = 240;
  const work = Array.from({ length: 8 }, (_, index) => item(`${props.ownerKey}-work-${index}`, index + 7, "thinking"));
  await render({ sessionActive: streaming, messageNavRailEnabled: false, items: [
    ...props.items.slice(0, 6), ...work, { ...item("short-answer", 15, "assistant"), streaming }
  ] });
  await flushFrames();
  const viewport = timeline();
  const header = viewport.querySelector<HTMLButtonElement>(".work-group__header")!;
  extent = viewport.scrollTop + header.getBoundingClientRect().top + 160;
  await contentResize();
  expect(header.getAttribute("aria-expanded")).toBe("false");
  expect(header.getBoundingClientRect().top).toBeGreaterThan(0);
  expect(header.getBoundingClientRect().bottom).toBeLessThan(viewport.clientHeight);
  expect(viewport.scrollTop).toBe(extent - viewport.clientHeight);
  return header;
}

async function append(items: readonly TimelineItemView[]): Promise<void> { await render({ items: [...props.items, ...items] }); }
function timeline(): HTMLDivElement { return host.querySelector<HTMLDivElement>(".timeline")!; }
function jumpLatest(): HTMLButtonElement | null { return host.querySelector<HTMLButtonElement>(".jump-latest"); }
function expectUnread(count: number): void {
  expect(jumpLatest()).not.toBeNull();
  expect(jumpLatest()?.getAttribute("aria-label")).toBe(`timeline.jumpLatest${count > 0 ? ` (${count})` : ""}`);
}

async function wheel(target: HTMLElement, deltaY: number, options: WheelEventInit = {}): Promise<void> {
  await act(async () => target.dispatchEvent(new WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true, ...options })));
}

async function scrollbarPress(viewport: HTMLElement): Promise<void> {
  const event = new MouseEvent("mousedown", { button: 0, buttons: 1, bubbles: true });
  Object.defineProperty(event, "offsetX", { value: viewport.clientWidth + 5 });
  await act(async () => viewport.dispatchEvent(event));
}

async function contentResize(): Promise<void> {
  await notifyResize(host.querySelector(".timeline__virtual")!);
}

async function notifyResize(target: Element): Promise<void> {
  await queueResize(target);
  await flushFrames();
}

async function queueResize(target: Element): Promise<void> {
  await act(async () => {
    for (const observer of [...observers]) if (observer.targets.has(target)) observer.callback([], observer);
  });
}

async function flushFrames(): Promise<void> {
  for (let round = 0; round < 5 && frames.size > 0; round += 1) {
    const pending = [...frames.values()];
    frames.clear();
    await act(async () => { for (const frame of pending) if (!frame.cancelled) frame.callback(performance.now()); });
  }
}

async function replayFrames(pending: readonly PendingFrame[]): Promise<void> {
  await act(async () => { for (const frame of pending) frame.callback(performance.now()); });
}

function item(id: string, sequence: number, kind: TimelineItemView["kind"]): TimelineItemView {
  return { id, kind, sequence: BigInt(sequence), createdAt: sequence, text: id, ...(kind === "user" ? { inputDelivery: "prompt" as const } : {}) };
}

function interaction(id: string, sequence: number, kind: NonNullable<TimelineItemView["interaction"]>["kind"], interactionId: string): TimelineItemView {
  return { ...item(id, sequence, "interaction"), interaction: { id: interactionId, kind, state: "pending", title: id, prompt: id, questions: [] } };
}

function restorePrototypeMethod(name: "scrollTo" | "scrollBy", descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) Reflect.deleteProperty(HTMLElement.prototype, name);
  else Object.defineProperty(HTMLElement.prototype, name, descriptor);
}
