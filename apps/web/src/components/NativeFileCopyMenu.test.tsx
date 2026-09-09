// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { OperationApi } from "../model.js";
import { NativeFileCopyContext, NativeFileCopyMenu } from "./NativeFileCopyMenu.js";
import { TimelineArtifactMedia } from "./TimelineArtifactMedia.js";
import type { Translator } from "./types.js";

const t = ((key: string) => key) as Translator;
let root: Root | undefined;
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { if (root !== undefined) await act(async () => root!.unmount()); root = undefined; Reflect.deleteProperty(window, "jokoDesktop"); document.body.replaceChildren(); document.body.className = ""; vi.restoreAllMocks(); });
const capability = () => Object.defineProperty(window, "jokoDesktop", { configurable: true, value: { capabilities: ["files.copy"] } });
const deferred = () => { let resolve!: (value: JokoDesktopCopyFileResult) => void; const promise = new Promise<JokoDesktopCopyFileResult>((accept) => { resolve = accept; }); return { promise, resolve }; };

it("keeps pending synchronous, presents errors for explicit retry, and fences source ABA, pagehide and connection replacement", async () => {
  capability(); const first = deferred(); const second = deferred();
  const copy = vi.fn<OperationApi["copyArtifactFile"]>().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise).mockResolvedValue({ status: "copied" });
  const node = document.createElement("div"); document.body.append(node); root = createRoot(node);
  const render = async (ownerKey: string, action = copy) => act(async () => root!.render(<NativeFileCopyMenu copyFile={action} blobId="blob" name="video.mp4" byteSize={2} ownerKey={ownerKey} t={t} />));
  const button = () => node.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
  await render("a");
  await act(async () => { button().click(); button().click(); });
  expect(copy).toHaveBeenCalledOnce(); expect(button().disabled).toBe(true);
  expect(document.activeElement).toBe(node.querySelector("summary"));
  await render("b"); await render("a");
  expect(copy.mock.calls[0]![3].signal.aborted).toBe(true);
  await act(async () => button().click());
  await act(async () => first.resolve({ status: "unknown" }));
  expect(node.querySelector('[role="alert"]')).toBeNull(); expect(button().disabled).toBe(true);
  await act(async () => second.resolve({ status: "failed", reason: "capacity" }));
  expect(node.querySelector('[role="alert"]')?.textContent).toBe("media.fileCopyCapacity"); expect(button().disabled).toBe(false);
  await act(async () => { window.dispatchEvent(new Event("pagehide")); button().click(); });
  expect(copy).toHaveBeenCalledTimes(2);
  await act(async () => window.dispatchEvent(new Event("pageshow")));
  const replacement = vi.fn<OperationApi["copyArtifactFile"]>().mockResolvedValueOnce({ status: "blocked" }).mockResolvedValue({ status: "copied" });
  await render("a", replacement);
  await act(async () => button().click());
  expect(replacement).toHaveBeenCalledOnce(); expect(node.querySelector('[role="alert"]')?.textContent).toBe("media.fileCopyBlocked");
  await act(async () => button().click());
  expect(replacement).toHaveBeenCalledTimes(2); expect(node.querySelector('[role="status"]')?.textContent).toBe("media.fileCopied");
});

it("exposes the same authorized video action in the player and after decode failure, with nested Escape preserving playback", async () => {
  capability(); vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined); vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined); vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  const copy = vi.fn<OperationApi["copyArtifactFile"]>().mockResolvedValue({ status: "unknown" });
  const node = document.createElement("div"); document.body.append(node); root = createRoot(node);
  await act(async () => root!.render(<NativeFileCopyContext.Provider value={copy}><TimelineArtifactMedia artifact={{ id: "clip", blobId: "clip-blob", title: "Clip", kind: "file", fileName: "clip.mp4", mediaType: "video/mp4", byteSize: 2 }} playbackOwnerKey="profile:task" loadUrl={async () => "blob:clip"} t={t} /></NativeFileCopyContext.Provider>));
  await act(async () => node.querySelector<HTMLButtonElement>(".video-preview__open")!.click());
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  const menu = dialog.querySelector<HTMLDetailsElement>("details")!;
  await act(async () => { menu.open = true; menu.querySelector("button")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(menu.open).toBe(false); expect(document.querySelector('[role="dialog"]')).toBe(dialog);
  await act(async () => menu.querySelector("button")!.click());
  expect(copy.mock.calls[0]?.slice(0, 3)).toEqual(["clip-blob", "clip.mp4", 2]);
  expect(dialog.querySelector('[role="alert"]')?.textContent).toBe("media.fileCopyUnknown");
  await act(async () => dialog.querySelector("video")!.dispatchEvent(new Event("error")));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(node.querySelector('[role="menuitem"]')).not.toBeNull();
});

it("omits the action when the host does not advertise file clipboard support", async () => {
  const node = document.createElement("div"); document.body.append(node); root = createRoot(node);
  await act(async () => root!.render(<NativeFileCopyMenu copyFile={vi.fn()} blobId="blob" name="clip.mp4" byteSize={2} ownerKey="task" t={t} />));
  expect(node.querySelector("button")).toBeNull();
});
