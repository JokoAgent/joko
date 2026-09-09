// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

import { VideoPreview, type VideoPreviewLabels } from "./VideoPreview.js";

const labels: VideoPreviewLabels = { open: "Play clip", player: "Clip video player", loading: "Loading video", unavailable: "Video unavailable", close: "Close video", playBlocked: "Use video controls to play" };
let root: Root | undefined;
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
});
afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  document.body.className = "";
  Reflect.deleteProperty(document, "fullscreenElement");
  vi.restoreAllMocks();
});

it("opens a keyboard-accessible cover into native playback and closes without intercepting controls or IME", async () => {
  const render = mount(undefined, document, true);
  await render();
  const cover = document.querySelector<HTMLVideoElement>("video")!;
  const trigger = document.querySelector<HTMLButtonElement>(`button[aria-label='${labels.open}']`)!;
  expect(cover.controls).toBe(false);
  expect(cover.muted).toBe(true);
  expect(cover.preload).toBe("metadata");
  expect(cover.getAttribute("src")).toBe("blob:first");
  expect(document.querySelector('[role="status"]')).not.toBeNull();
  await act(async () => cover.dispatchEvent(new Event("loadedmetadata")));
  expect(document.querySelector('[role="status"]')).toBeNull();
  trigger.focus();
  await act(async () => trigger.click());
  const dialog = document.querySelector<HTMLDivElement>('[role="dialog"]')!;
  const player = dialog.querySelector("video")!;
  expect(player.controls).toBe(true);
  expect(player.autoplay).toBe(true);
  expect(player.loop).toBe(true);
  expect(player.playsInline).toBe(true);
  expect(player.preload).toBe("auto");
  expect(player.play).toHaveBeenCalledTimes(2);
  expect(player.getAttribute("src")).toBe("blob:first");
  expect(document.activeElement).toBe(player);
  expect(document.body.classList.contains("modal-open")).toBe(true);
  await act(async () => player.dispatchEvent(new Event("canplay")));
  expect(dialog.querySelector('[role="status"]')).toBeNull();
  await act(async () => player.dispatchEvent(new Event("waiting")));
  expect(dialog.querySelector('[role="status"]')).not.toBeNull();
  await act(async () => player.dispatchEvent(new Event("playing")));
  expect(dialog.querySelector('[role="status"]')).toBeNull();
  await act(async () => player.click());
  expect(document.querySelector('[role="dialog"]')).toBe(dialog);
  const nativeTab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  player.dispatchEvent(nativeTab);
  expect(nativeTab.defaultPrevented).toBe(false);
  const guards = dialog.querySelectorAll<HTMLElement>(".video-lightbox__focus-guard");
  guards[0]!.focus();
  expect(document.activeElement?.getAttribute("aria-label")).toBe(labels.close);
  guards[1]!.focus();
  expect(document.activeElement).toBe(player);
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true })));
  expect(document.querySelector('[role="dialog"]')).toBe(dialog);
  Object.defineProperty(document, "fullscreenElement", { configurable: true, value: player });
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(document.querySelector('[role="dialog"]')).toBe(dialog);
  Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(player.hasAttribute("src")).toBe(false);
  expect(document.activeElement).toBe(trigger);
  expect(document.body.classList.contains("modal-open")).toBe(false);
  await act(async () => trigger.click());
  await act(async () => document.querySelector<HTMLDivElement>('[role="dialog"]')!.click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  document.body.classList.add("modal-open");
  await act(async () => trigger.click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("retains controls when autoplay is blocked and shows a recoverable media error when decoding fails", async () => {
  const failure = vi.fn();
  vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new DOMException("gesture required", "NotAllowedError"));
  await mount(failure)();
  await act(async () => document.querySelector<HTMLButtonElement>("button")!.click());
  const player = document.querySelector<HTMLVideoElement>('[role="dialog"] video')!;
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(labels.playBlocked);
  expect(player.controls).toBe(true);
  expect(failure).not.toHaveBeenCalled();
  await act(async () => player.dispatchEvent(new Event("playing")));
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain(labels.playBlocked);
  await act(async () => player.dispatchEvent(new Event("error")));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(labels.unavailable);
  expect(player.hasAttribute("src")).toBe(false);
  expect(failure).toHaveBeenCalledTimes(1);
});

it("retires open playback and late play failures on source or task changes without restoring stale focus", async () => {
  const failure = vi.fn();
  const render = mount(failure);
  await render();
  for (const [owner, src] of [["task-two", "blob:first"], ["task-two", "blob:second"]] as const) {
    let rejectPlay!: (error: Error) => void;
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectPlay = reject; }));
    const trigger = document.querySelector<HTMLButtonElement>("button")!;
    const restore = vi.spyOn(trigger, "focus");
    await act(async () => trigger.click());
    const player = document.querySelector<HTMLVideoElement>('[role="dialog"] video')!;
    await render(owner, src);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(player.hasAttribute("src")).toBe(false);
    expect(restore).not.toHaveBeenCalled();
    await act(async () => rejectPlay(new DOMException("old media failed", "NotSupportedError")));
    expect(failure).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')).toBeNull();
  }
});

it("uses the invoking document for its portal, modal lock, playback, keyboard and focus restoration", async () => {
  const frame = document.body.appendChild(document.createElement("iframe"));
  const childDocument = frame.contentDocument!;
  const childPrototype = Object.getPrototypeOf(childDocument.createElement("video"));
  const play = vi.spyOn(childPrototype, "play").mockResolvedValue(undefined);
  vi.spyOn(childPrototype, "pause").mockImplementation(() => undefined);
  vi.spyOn(childPrototype, "load").mockImplementation(() => undefined);
  await mount(undefined, childDocument)();
  const trigger = childDocument.querySelector<HTMLButtonElement>("button")!;
  trigger.focus();
  await act(async () => trigger.click());
  expect(play).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(childDocument.querySelector('[role="dialog"]')).not.toBeNull();
  expect(childDocument.body.classList.contains("modal-open")).toBe(true);
  expect(document.body.classList.contains("modal-open")).toBe(false);
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(childDocument.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => childDocument.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(childDocument.querySelector('[role="dialog"]')).toBeNull();
  expect(childDocument.activeElement).toBe(trigger);
  expect(childDocument.body.classList.contains("modal-open")).toBe(false);
});

function mount(onError?: () => void, ownerDocument = document, strict = false) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  return async (ownerKey = "task-one", src = "blob:first") => act(async () => {
    const preview = <VideoPreview src={src} ownerKey={ownerKey} labels={labels} onError={onError} />;
    const content = ownerDocument === document ? preview : createPortal(preview, ownerDocument.body);
    root!.render(strict ? <StrictMode>{content}</StrictMode> : content);
  });
}
