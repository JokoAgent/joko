// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TimelineItemView } from "../model.js";
import { Timeline } from "./Timeline.js";
import type { Translator } from "./types.js";

type TimelineProps = ComponentProps<typeof Timeline>;
interface PendingFrame { readonly callback: FrameRequestCallback; cancelled: boolean }
interface ScrollWrite { readonly node: HTMLElement; readonly top: number; readonly behavior: ScrollBehavior | undefined }

let host: HTMLDivElement;
let root: Root;
let props: TimelineProps;
let extent: number;
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
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) { return this.classList.contains("timeline") ? 600 : 80; });
  vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(620);
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) { return this.classList.contains("timeline") ? extent : 80; });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("timeline") ? 600 : 80; });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(656);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const viewport = this.classList.contains("timeline") ? this : this.closest<HTMLElement>(".timeline");
    const row = this.closest<HTMLElement>(".timeline__row");
    const start = Number.parseFloat(row?.style.transform.replace(/^translateY\(/, "") ?? "0") || 0;
    const isRoot = this === viewport;
    const top = isRoot ? 0 : start - (viewport?.scrollTop ?? 0);
    const height = isRoot ? 600 : this.classList.contains("timeline__virtual") ? extent : 80;
    const left = isRoot ? 0 : 64;
    return { x: left, y: top, left, top, right: left + 592, bottom: top + height, width: 592, height, toJSON: () => ({}) };
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value(this: HTMLElement, options: ScrollToOptions): void {
      const top = Math.max(0, Math.min(extent - 600, options.top ?? this.scrollTop));
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
    const content = host.querySelector<HTMLElement>(".timeline__virtual")!;
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
  await act(async () => {
    const content = host.querySelector(".timeline__virtual")!;
    for (const observer of [...observers]) if (observer.targets.has(content)) observer.callback([], observer);
  });
  await flushFrames();
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
