// @vitest-environment jsdom

import { act, StrictMode } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AudioPreview, type AudioPreviewProps } from "./AudioPreview.js";
import { AudioArtworkContext } from "./AudioArtwork.js";

const roots: Root[] = [];
const labels = { player: "Audio player", loading: "Loading audio", unavailable: "Audio unavailable", copyDescription: "Copy description", copying: "Copying description", copied: "Description copied", copyFailed: "Copy failed" };
const initial: AudioPreviewProps = { src: "blob:audio-one", ownerKey: "profile-one:session-one", name: "A real title", description: "  Gentle melody\nPiano and strings  ", labels };

beforeAll(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
});
afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("AudioPreview", () => {
  it("retires artwork through the original gateway and listens only to its owning Document", async () => {
    const pending = deferred<string>();
    const original = { acquire: vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue("blob:original"), release: vi.fn() };
    const replacement = { acquire: vi.fn().mockResolvedValue("blob:replacement"), release: vi.fn() };
    const frame = document.createElement("iframe"); document.body.append(frame);
    const frameWindow = frame.contentWindow as Window & typeof globalThis;
    vi.spyOn(frameWindow.HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(frameWindow.HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container); roots.push(root);
    const render = async (gateway: typeof original) => act(async () => root.render(createPortal(
      <AudioArtworkContext.Provider value={gateway}><AudioPreview {...initial} metadata={{ kind: "music", title: "Track", description: "",
        artwork: { blobId: "cover", width: 2, height: 2, alt: "Artwork" } }} /></AudioArtworkContext.Provider>, frameWindow.document.body
    )));
    await render(original);
    await render(replacement);
    await act(async () => pending.resolve("blob:late-original"));
    expect(original.release).toHaveBeenCalledExactlyOnceWith("cover");
    expect(frameWindow.document.querySelector("img")?.src).toBe("blob:replacement");
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    expect(replacement.release).not.toHaveBeenCalled();
    await act(async () => frameWindow.dispatchEvent(new frameWindow.Event("pagehide")));
    expect(frameWindow.document.querySelector("img")).toBeNull();
    expect(replacement.release).toHaveBeenCalledExactlyOnceWith("cover");
    await act(async () => frameWindow.dispatchEvent(new frameWindow.Event("pageshow")));
    expect(replacement.acquire).toHaveBeenCalledTimes(2);
    expect(frameWindow.document.querySelector("img")?.src).toBe("blob:replacement");
  });

  it("keeps cover leases independent of playback through failures, source ABA and page restore", async () => {
    const first = deferred<string>();
    const third = deferred<string>();
    const gateway = { acquire: vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce("blob:cover-b").mockReturnValueOnce(third.promise).mockResolvedValue("blob:restored"), release: vi.fn() };
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container); roots.push(root);
    const render = async (id: string, kind: "music" | "sound_effect" = "music") => act(async () => root.render(<AudioArtworkContext.Provider value={gateway}>
      <AudioPreview {...initial} metadata={{ kind, title: "Track", description: "Real tags", durationSeconds: 65, artwork: { blobId: id, alt: "Cover art", width: 2, height: 2 } }} />
    </AudioArtworkContext.Provider>));
    await render("a");
    const audio = required(container.querySelector("audio"));
    audio.currentTime = 4;
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("1:05");
    await render("b");
    expect(container.querySelector("audio")).toBe(audio);
    expect(audio.currentTime).toBe(4);
    await render("a");
    await act(async () => first.resolve("blob:old-a"));
    expect(container.querySelector("img")).toBeNull();
    await act(async () => third.resolve("blob:new-a"));
    expect(container.querySelector("img")?.src).toBe("blob:new-a");
    await act(async () => required(container.querySelector("img")).dispatchEvent(new Event("error")));
    expect(container.querySelector("img")).toBeNull();
    expect(audio.currentTime).toBe(4);
    expect(audio.hasAttribute("src")).toBe(true);
    Object.defineProperty(audio, "duration", { configurable: true, value: 9 });
    await act(async () => audio.dispatchEvent(new Event("loadedmetadata")));
    expect(container.textContent).toContain("0:09");
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    expect(audio.hasAttribute("src")).toBe(false);
    await act(async () => window.dispatchEvent(new Event("pageshow")));
    expect(container.querySelector("img")?.src).toBe("blob:restored");
    expect(audio.getAttribute("src")).toBe(initial.src);
    await render("a", "sound_effect");
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("p")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
    expect(gateway.acquire).toHaveBeenCalledTimes(4);
    expect(gateway.release.mock.calls.map(([id]) => id)).toEqual(["b", "a", "a", "a"]);
  });

  it("keeps native playback usable without tags, follows media states and retires the source", async () => {
    const mounted = await mount({ ...initial, description: "" });
    const audio = required(mounted.container.querySelector("audio"));
    expect(audio.controls).toBe(true);
    expect(audio.preload).toBe("metadata");
    expect(audio.autoplay).toBe(false);
    expect(audio.loop).toBe(false);
    expect(mounted.container.querySelector("strong")?.textContent).toBe(initial.name);
    expect(mounted.container.querySelector("button")).toBeNull();
    expect(mounted.container.querySelector("img")).toBeNull();
    expect(mounted.container.textContent).not.toMatch(/artist|album/iu);
    expect(mounted.container.querySelector('[aria-label="Loading audio"]')).not.toBeNull();
    await act(async () => audio.dispatchEvent(new Event("loadedmetadata")));
    expect(mounted.container.querySelector('[aria-label="Loading audio"]')).toBeNull();
    await act(async () => audio.dispatchEvent(new Event("waiting")));
    expect(mounted.container.querySelector('[aria-label="Loading audio"]')).not.toBeNull();
    await act(async () => audio.dispatchEvent(new Event("canplay")));
    audio.currentTime = 7;
    await act(async () => audio.dispatchEvent(new Event("ended")));
    expect(audio.currentTime).toBe(0);
    await mounted.render({ ...initial, src: "blob:audio-two" });
    expect(audio.hasAttribute("src")).toBe(false);
    await act(async () => audio.dispatchEvent(new Event("error")));
    expect(mounted.container.querySelector('[role="alert"]')).toBeNull();
    const next = required(mounted.container.querySelector("audio"));
    await act(async () => next.dispatchEvent(new Event("error")));
    expect(next.hidden).toBe(true);
    expect(next.hasAttribute("src")).toBe(false);
    expect(mounted.container.querySelector('[role="alert"]')?.textContent).toBe(labels.unavailable);
    expect(mounted.container.querySelector("strong")?.textContent).toBe(initial.name);
    expect(mounted.container.querySelector('button[aria-label="Copy description"]')).not.toBeNull();
    await mounted.unmount();
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalled();
  });

  it("copies the real description once per attempt with failure, retry and retained focus", async () => {
    const first = deferred<void>();
    const writeText = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const mounted = await mount(initial);
    const copy = required(mounted.container.querySelector("button"));
    copy.focus();
    await act(async () => { copy.click(); copy.click(); });
    expect(writeText).toHaveBeenCalledExactlyOnceWith("Gentle melody\nPiano and strings");
    expect(copy.getAttribute("aria-busy")).toBe("true");
    expect(document.activeElement).toBe(copy);
    await act(async () => first.reject(new Error("private system error")));
    expect(mounted.container.querySelector('[role="alert"]')?.textContent).toBe(labels.copyFailed);
    expect(mounted.container.textContent).not.toContain("private system error");
    await act(async () => copy.click());
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(copy.getAttribute("aria-busy")).toBe("false");
    expect(mounted.container.textContent).toContain(labels.copied);
    expect(document.activeElement).toBe(copy);
    await mounted.render({ ...initial, description: "<img src=untrusted>" });
    expect(mounted.container.querySelector("img")).toBeNull();
    expect(mounted.container.querySelector("p")?.textContent).toBe("<img src=untrusted>");
    expect(mounted.container.textContent).not.toContain(labels.copied);
  });

  it("uses the owning Document clipboard and ignores pending source ABA and Document changes", async () => {
    const old = deferred<void>();
    const current = deferred<void>();
    const mainWrite = vi.fn().mockReturnValue(current.promise);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: mainWrite } });
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const frameWindow = frame.contentWindow as Window & typeof globalThis;
    const frameDocument = frameWindow.document;
    vi.spyOn(frameWindow.HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(frameWindow.HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    const frameWrite = vi.fn().mockReturnValue(old.promise);
    Object.defineProperty(frameWindow.navigator, "clipboard", { configurable: true, value: { writeText: frameWrite } });
    const mounted = await mount(initial, frameDocument);
    await act(async () => required(frameDocument.querySelector("button")).click());
    expect(frameWrite).toHaveBeenCalledOnce();
    expect(mainWrite).not.toHaveBeenCalled();
    await mounted.render({ ...initial, src: "blob:audio-two" }, frameDocument);
    await mounted.render(initial, document);
    await act(async () => old.reject(new Error("late detached failure")));
    expect(mounted.container.querySelector('[role="alert"]')).toBeNull();
    const copy = required(mounted.container.querySelector("button"));
    await act(async () => copy.click());
    expect(mainWrite).toHaveBeenCalledOnce();
    await mounted.render({ ...initial, ownerKey: "profile-two:session-one" });
    await act(async () => current.resolve());
    expect(mounted.container.textContent).not.toContain(labels.copied);
    expect(mounted.container.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("keeps an active copy independent of a later description and does not replay unavailable clipboard writes", async () => {
    const pending = deferred<void>();
    const writeText = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const mounted = await mount(initial);
    await act(async () => required(mounted.container.querySelector("button")).click());
    await mounted.render({ ...initial, description: "Updated description" });
    await act(async () => pending.reject(new Error("old write")));
    expect(mounted.container.querySelector('[role="alert"]')).toBeNull();
    Reflect.deleteProperty(navigator, "clipboard");
    await act(async () => required(mounted.container.querySelector("button")).click());
    expect(mounted.container.querySelector('[role="alert"]')?.textContent).toBe(labels.copyFailed);
    expect(writeText).toHaveBeenCalledOnce();
  });
});

async function mount(props: AudioPreviewProps, ownerDocument = document) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const render = async (next: AudioPreviewProps, nextDocument = document) => act(async () => root.render(
    <StrictMode>{nextDocument === document ? <AudioPreview {...next} /> : createPortal(<AudioPreview {...next} />, nextDocument.body)}</StrictMode>
  ));
  await render(props, ownerDocument);
  return { container, render, unmount: async () => { await act(async () => root.unmount()); roots.splice(roots.indexOf(root), 1); } };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function required<T>(value: T | null): T {
  if (value === null) throw new Error("Missing mounted audio control.");
  return value;
}
