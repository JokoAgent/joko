import type { ArtifactDownloadContext } from "../model.js";
// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { WorkspaceImageLightbox, type WorkspaceImageLightboxLabels } from "./WorkspaceImageLightbox.js";

const labels: WorkspaceImageLightboxLabels = {
  close: "Close",
  copy: "Copy",
  copied: "Copied",
  copyFailed: "Copy failed",
  saveAs: "Save",
  saveFailed: "Save failed",
  annotate: "Annotate",
  discardAnnotation: "Discard",
  undoAnnotation: "Undo",
  sendToChat: "Send",
  sendFailed: "Send failed",
  previousImage: "Previous image",
  nextImage: "Next image",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  fitImage: "Fit",
  actualSize: "Actual size",
  loading: "Loading image",
  unavailable: "Image unavailable"
};

const roots: Root[] = [];
const cleanups: Array<() => void> = [];

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  document.body.className = "";
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("WorkspaceImageLightbox gallery surface", () => {
  it("keeps one modal mounted while loading and routes buttons and arrow keys through the gallery", () => {
    const previous = vi.fn();
    const next = vi.fn();
    mount(<WorkspaceImageLightbox
      ownerKey="gallery"
      src=""
      name="render.png"
      labels={labels}
      status="loading"
      gallery={{ index: 1, total: 3, onPrevious: previous, onNext: next }}
      showZoomControls
      onClose={() => undefined}
      onDownload={() => undefined}
    />);

    expect(document.querySelector('[role="dialog"][aria-label="render.png"]')).not.toBeNull();
    expect(document.querySelector(".workspace-image-lightbox__status")?.textContent).toBe("Loading image");
    expect(document.querySelector(".workspace-image-lightbox__counter")?.textContent).toBe("2 / 3");
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Previous image"]')?.click());
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(previous).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="Copy"]')?.disabled).toBe(true);
  });

  it("announces a failed authenticated preview without exposing a broken image", () => {
    mount(<WorkspaceImageLightbox
      ownerKey="gallery"
      src=""
      name="render.png"
      labels={labels}
      status="error"
      onClose={() => undefined}
      onDownload={() => undefined}
    />);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Image unavailable");
    expect(document.querySelector("img")).toBeNull();
  });

  it("keeps pinch focus, continues one-finger pan, and drops cancelled or previous-image pointers", () => {
    const close = vi.fn();
    const next = vi.fn();
    const render = (src: string, status: "ready" | "error" = "ready") => <WorkspaceImageLightbox ownerKey="gallery" src={src} status={status} name="render.png" labels={labels} showZoomControls
      gallery={{ index: 0, total: 2, onPrevious: () => undefined, onNext: next }} onClose={close} onDownload={() => undefined} />;
    const root = mount(render("blob:first"));
    const wrap = imageGestureSurface();
    const overlay = document.querySelector<HTMLDivElement>('[role="dialog"]')!;
    pointer(wrap, "pointerdown", 40, 200, 150, "mouse");
    pointer(overlay, "pointerup", 40, 200, 150, "mouse");
    // Browsers retarget click/dblclick after pointer capture to its overlay owner.
    act(() => overlay.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 200, clientY: 150 })));
    expect(wrap.style.transform).toBe("translate(0px, 0px) scale(2)");
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Fit"]')!.click());
    pointer(wrap, "pointerdown", 1, 150, 150);
    pointer(document.querySelector<HTMLDivElement>('[role="dialog"]')!, "pointerdown", 2, 250, 150);
    pointer(wrap, "pointermove", 2, 350, 150);
    expect(wrap.style.transform).toBe("translate(50px, 0px) scale(2)");
    act(() => overlay.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 200, clientY: 150 })));
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]')!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(wrap.style.transform).toBe("translate(50px, 0px) scale(2)");
    pointer(wrap, "pointerup", 2, 350, 150);
    pointer(wrap, "pointermove", 1, 170, 160);
    expect(wrap.style.transform).toBe("translate(70px, 10px) scale(2)");
    pointer(wrap, "pointercancel", 1, 170, 160);
    pointer(wrap, "pointermove", 1, 320, 250);
    expect(wrap.style.transform).toBe("translate(70px, 10px) scale(2)");
    expect(close).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();

    pointer(wrap, "pointerdown", 3, 140, 150);
    pointer(wrap, "pointerdown", 4, 240, 150);
    act(() => root.render(render("blob:second")));
    pointer(wrap, "pointermove", 4, 340, 150);
    expect(wrap.style.transform).toBe("translate(0px, 0px) scale(1)");
    pointer(wrap, "pointerdown", 5, 150, 150);
    pointer(wrap, "pointerdown", 6, 250, 150);
    pointer(wrap, "pointermove", 6, 350, 150);
    expect(wrap.style.transform).toBe("translate(50px, 0px) scale(2)");
    pointer(wrap, "lostpointercapture", 5, 150, 150);
    pointer(wrap, "pointermove", 6, 380, 150);
    expect(wrap.style.transform).toBe("translate(50px, 0px) scale(2)");
    pointer(wrap, "pointerdown", 7, 100, 100);
    pointer(wrap, "pointerdown", 8, 200, 100);
    pointer(wrap, "pointerdown", 9, 300, 100);
    pointer(wrap, "pointermove", 9, 380, 200);
    expect(wrap.style.transform).toBe("translate(50px, 0px) scale(2)");
    pointer(wrap, "pointerup", 7, 100, 100);
    pointer(wrap, "pointermove", 8, 200, 100);
    expect(wrap.style.transform).toBe("translate(50px, 0px) scale(2)");
    pointer(wrap, "pointermove", 8, -5000, -5000);
    expect(wrap.style.transform).toContain("scale(8)");
    const beforeError = wrap.style.transform;
    act(() => root.render(render("blob:second", "error")));
    pointer(wrap, "pointermove", 9, 100, 100);
    pointer(wrap, "pointerup", 8, -5000, -5000);
    act(() => root.render(render("blob:second")));
    pointer(wrap, "pointermove", 9, 150, 100);
    expect(wrap.style.transform).toBe(beforeError);
  });

  it("reserves annotation strokes for one pointer and uses two touches only to transform the image", () => {
    mount(<WorkspaceImageLightbox ownerKey="gallery" src="blob:image" name="render.png" labels={labels} showZoomControls
      onClose={() => undefined} onDownload={() => undefined} onSendToChat={() => undefined} />);
    const wrap = imageGestureSurface();
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Annotate"]')!.click());
    pointer(wrap, "pointerdown", 1, 150, 150);
    pointer(wrap, "pointermove", 99, 350, 250);
    expect(wrap.querySelector("path")?.getAttribute("d")).toBe("M 150.0 150.0 L 150.1 150.0");
    pointer(wrap, "pointerdown", 2, 250, 150);
    pointer(wrap, "pointermove", 2, 350, 150);
    expect(wrap.style.transform).toBe("translate(50px, 0px) scale(2)");
    expect(wrap.querySelector("path")).toBeNull();
    pointer(wrap, "pointerup", 2, 350, 150);
    pointer(wrap, "pointermove", 1, 160, 160);
    pointer(wrap, "pointerup", 1, 160, 160);
    expect(wrap.querySelector("path")).toBeNull();
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="Undo"]')!.disabled).toBe(true);

    pointer(wrap, "pointerdown", 3, 100, 100);
    pointer(wrap, "pointermove", 3, 120, 120);
    pointer(wrap, "pointercancel", 3, 120, 120);
    expect(wrap.querySelector("path")).toBeNull();
    pointer(wrap, "pointerdown", 4, 100, 100);
    pointer(wrap, "pointermove", 4, 120, 120);
    pointer(wrap, "pointerup", 4, 120, 120);
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="Undo"]')!.disabled).toBe(false);
    expect(wrap.querySelectorAll("g")).toHaveLength(1);
    pointer(wrap, "pointerdown", 5, 140, 140, "pen");
    pointer(wrap, "pointerdown", 6, 300, 200);
    pointer(wrap, "pointermove", 6, 350, 250);
    pointer(wrap, "pointermove", 5, 160, 160, "pen");
    pointer(wrap, "pointerup", 5, 160, 160, "pen");
    expect(wrap.querySelectorAll("g")).toHaveLength(2);
    expect(wrap.querySelectorAll("path")[2]?.getAttribute("d")).toBe("M 140.0 140.0 L 160.0 160.0");
  });

  it("uses the detached document for keyboard, encoding, clipboard and focus", async () => {
    vi.useFakeTimers();
    const frame = document.body.appendChild(document.createElement("iframe"));
    const ownerDocument = frame.contentDocument!;
    const ownerWindow = ownerDocument.defaultView!;
    const browser = imageBrowser(ownerDocument);
    const trigger = ownerDocument.body.appendChild(ownerDocument.createElement("button"));
    const focus = vi.spyOn(trigger, "focus");
    const onClose = vi.fn();
    const next = vi.fn();
    const send = vi.fn(async (_file: File) => undefined);
    const render = (src: string) => <WorkspaceImageLightbox ownerKey="detached" src={src} name="render.jpg" labels={labels} returnFocus={trigger} showZoomControls
      gallery={{ index: 0, total: 2, onPrevious: vi.fn(), onNext: next }} onClose={onClose} onDownload={vi.fn()} onSendToChat={send} />;
    const root = mount(render("blob:first"));
    await act(async () => vi.advanceTimersByTime(20));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(ownerDocument.activeElement?.getAttribute("role")).toBe("dialog");
    expect(document.body.classList.contains("modal-open")).toBe(false);
    expect(ownerDocument.body.classList.contains("modal-open")).toBe(true);
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(next).not.toHaveBeenCalled();
    act(() => ownerDocument.dispatchEvent(new ownerWindow.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(next).toHaveBeenCalledOnce();
    const wrap = imageGestureSurface(ownerDocument);
    act(() => ownerDocument.querySelector<HTMLButtonElement>('button[aria-label="Annotate"]')!.click());
    pointer(wrap, "pointerdown", 1, 100, 100, "pen");
    pointer(wrap, "pointermove", 1, 120, 120, "pen");
    pointer(wrap, "pointerup", 1, 120, 120, "pen");
    act(() => ownerDocument.dispatchEvent(new ownerWindow.KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true })));
    expect(ownerDocument.querySelector<HTMLButtonElement>('button[aria-label="Undo"]')?.disabled).toBe(false);
    await act(async () => ownerDocument.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click());
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(ownerWindow.File);
    expect(send.mock.calls[0]?.[0].name).toBe("render.png");
    expect(browser.canvases.every((canvas) => canvas.ownerDocument === ownerDocument)).toBe(true);
    expect(browser.context.moveTo.mock.calls).toEqual([[100, 100], [100, 100]]);
    await act(async () => root.render(render("blob:second")));
    await act(async () => vi.advanceTimersByTime(200));
    expect(onClose).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    await act(async () => ownerDocument.querySelector<HTMLButtonElement>('button[aria-label="Copy"]')!.click());
    expect(browser.clipboard).toHaveBeenCalledOnce();
    expect(ownerDocument.querySelector('[role="status"]')?.textContent).toBe("Copied");
    expect(browser.fetchSource.mock.calls.every(([url]) => url === "blob:first" || url === "blob:second")).toBe(true);
    act(() => ownerDocument.dispatchEvent(new ownerWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await act(async () => vi.advanceTimersByTime(160));
    expect(onClose).toHaveBeenCalledOnce();
    act(() => root.render(null));
    expect(ownerDocument.activeElement).toBe(trigger);
    expect(ownerDocument.body.classList.contains("modal-open")).toBe(false);
    expect(browser.revokeUrl).toHaveBeenCalledTimes(2);
  });

  it("freezes action strokes before reading bytes and aborts decode or encode before dispatch", async () => {
    const browser = imageBrowser(document);
    const bytes = deferred<Blob>();
    const original = browser.fetchSource.getMockImplementation()!;
    browser.fetchSource.mockResolvedValueOnce({ ok: true, blob: () => bytes.promise } as Response);
    const send = vi.fn(async (_file: File) => undefined);
    const render = (ownerKey: string) => <WorkspaceImageLightbox ownerKey={ownerKey} src="blob:shared" name="image.png" labels={labels} onClose={vi.fn()} onDownload={vi.fn()} onSendToChat={send} />;
    const root = mount(render("one"));
    const wrap = imageGestureSurface();
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Annotate"]')!.click());
    pointer(wrap, "pointerdown", 1, 100, 100);
    pointer(wrap, "pointerup", 1, 100, 100);
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click());
    pointer(wrap, "pointerdown", 2, 200, 200);
    pointer(wrap, "pointerup", 2, 200, 200);
    expect(wrap.querySelectorAll("g")).toHaveLength(2);
    await act(async () => bytes.resolve(new Blob(["source"], { type: "image/png" })));
    expect(browser.context.moveTo.mock.calls).toEqual([[100, 100], [100, 100]]);
    expect(send).toHaveBeenCalledOnce();

    // Source ownership is independent of URL strings and rejects A -> B -> A completions.
    act(() => root.render(render("two")));
    const decoding = deferred<void>();
    browser.decode.mockReturnValueOnce(decoding.promise);
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Copy"]')!.click());
    const fetchOptions = browser.fetchSource.mock.calls.at(-1)?.[1];
    act(() => root.render(render("one")));
    expect(fetchOptions?.signal?.aborted).toBe(true);
    await act(async () => decoding.resolve());
    expect(browser.clipboard).not.toHaveBeenCalled();
    expect(document.querySelector('[role="status"]')).toBeNull();

    let finishEncoding!: BlobCallback;
    browser.encode.mockImplementationOnce((callback) => { finishEncoding = callback; });
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Copy"]')!.click());
    act(() => root.render(render("two")));
    await act(async () => finishEncoding(new Blob(["encoded"], { type: "image/png" })));
    expect(browser.clipboard).not.toHaveBeenCalled();
    expect(browser.fetchSource.getMockImplementation()).toBe(original);
    expect(browser.createUrl.mock.calls.length).toBe(browser.revokeUrl.mock.calls.length);
  });

  it("does not replay an issued clipboard action or let old save/send completions affect the current owner", async () => {
    vi.useFakeTimers();
    const browser = imageBrowser(document);
    const write = deferred<void>();
    browser.clipboard.mockReturnValueOnce(write.promise);
    const saving = deferred<void>();
    const sending = deferred<void>();
    const download = vi.fn((_context: ArtifactDownloadContext) => saving.promise);
    const send = vi.fn(() => sending.promise);
    const onClose = vi.fn();
    const frame = document.body.appendChild(document.createElement("iframe"));
    const detachedTrigger = frame.contentDocument!.body.appendChild(frame.contentDocument!.createElement("button"));
    const render = (ownerKey: string, returnFocus?: HTMLElement) => <WorkspaceImageLightbox ownerKey={ownerKey} src="blob:shared" name="image.png" labels={labels} returnFocus={returnFocus} onClose={onClose} onDownload={download} onSendToChat={send} />;
    const root = mount(render("one"));
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Copy"]')!.click());
    expect(browser.clipboard).toHaveBeenCalledOnce();
    act(() => root.render(render("one", detachedTrigger)));
    act(() => root.render(render("one")));
    await act(async () => write.reject(new Error("unknown clipboard result")));
    expect(browser.clipboard).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="status"]')).toBeNull();
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Save"]')!.click());
    expect(download).toHaveBeenCalledOnce();
    const savingContext = download.mock.calls[0]![0];
    expect(savingContext.ownerDocument).toBe(document);
    expect(savingContext.signal.aborted).toBe(false);
    act(() => root.render(render("two")));
    expect(savingContext.signal.aborted).toBe(true);
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click());
    expect(send).toHaveBeenCalledOnce();
    act(() => root.render(render("three")));
    await act(async () => { saving.reject(new Error("late save")); sending.resolve(); vi.advanceTimersByTime(200); });
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[role="status"]')).toBeNull();
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="Copy"]')?.disabled).toBe(false);

    const reading = deferred<Blob>();
    browser.fetchSource.mockResolvedValueOnce({ ok: true, blob: () => reading.promise } as Response);
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click());
    act(() => root.render(render("four")));
    await act(async () => reading.resolve(new Blob(["late"], { type: "image/png" })));
    expect(send).toHaveBeenCalledOnce();
  });
});

function imageGestureSurface(ownerDocument = document): HTMLDivElement {
  const overlay = ownerDocument.querySelector<HTMLDivElement>('[role="dialog"]')!;
  const wrap = ownerDocument.querySelector<HTMLDivElement>(".workspace-image-lightbox__image-wrap")!;
  const image = wrap.querySelector("img")!;
  const rect = { left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON() { return {}; } };
  vi.spyOn(overlay, "getBoundingClientRect").mockReturnValue(rect);
  vi.spyOn(image, "getBoundingClientRect").mockReturnValue(rect);
  Object.defineProperties(image, { naturalWidth: { value: 400, configurable: true }, naturalHeight: { value: 300, configurable: true }, clientWidth: { value: 400, configurable: true }, clientHeight: { value: 300, configurable: true } });
  const captured = new Set<number>();
  overlay.setPointerCapture = (id) => { captured.add(id); };
  overlay.hasPointerCapture = (id) => captured.has(id);
  overlay.releasePointerCapture = (id) => { captured.delete(id); };
  act(() => image.dispatchEvent(new Event("load", { bubbles: false })));
  return wrap;
}

function pointer(target: HTMLElement, type: string, id: number, x: number, y: number, pointerType = "touch"): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, { pointerId: { value: id }, pointerType: { value: pointerType }, button: { value: 0 }, clientX: { value: x }, clientY: { value: y } });
  act(() => target.dispatchEvent(event));
}

function mount(element: ReactNode): Root {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(element));
  return root;
}

function imageBrowser(ownerDocument: Document) {
  const ownerWindow = ownerDocument.defaultView!;
  const context = { drawImage: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn() };
  const canvases: HTMLCanvasElement[] = [];
  const decode = vi.fn<() => Promise<void>>(async () => undefined);
  const encode = vi.fn<(callback: BlobCallback) => void>((callback) => callback(new ownerWindow.Blob(["encoded"], { type: "image/png" })));
  const clipboard = vi.fn<(items: readonly ClipboardItem[]) => Promise<void>>(async () => undefined);
  const fetchSource = vi.fn<typeof fetch>(async () => ({ ok: true, blob: async () => new ownerWindow.Blob(["image"], { type: "image/png" }) } as Response));
  const createUrl = vi.fn(() => `blob:local-${createUrl.mock.calls.length}`);
  const revokeUrl = vi.fn();
  const anchorClick = vi.fn();
  const createElement = ownerDocument.createElement.bind(ownerDocument);
  vi.spyOn(ownerDocument, "createElement").mockImplementation(((name: string, options?: ElementCreationOptions) => {
    const element = createElement(name, options);
    if (name === "img") Object.defineProperties(element, {
      decode: { value: decode, configurable: true }, naturalWidth: { value: 400, configurable: true }, naturalHeight: { value: 300, configurable: true }
    });
    if (name === "canvas") {
      canvases.push(element as HTMLCanvasElement);
      Object.defineProperties(element, { getContext: { value: () => context }, toBlob: { value: encode } });
    }
    if (name === "a") Object.defineProperty(element, "click", { value: anchorClick });
    return element;
  }) as typeof ownerDocument.createElement);
  setProperty(ownerWindow, "fetch", fetchSource);
  setProperty(ownerWindow, "ClipboardItem", class { constructor(readonly items: Record<string, Blob>) {} });
  setProperty(ownerWindow.navigator, "clipboard", { write: clipboard });
  setProperty(ownerWindow.URL, "createObjectURL", createUrl);
  setProperty(ownerWindow.URL, "revokeObjectURL", revokeUrl);
  return { context, canvases, decode, encode, clipboard, fetchSource, createUrl, revokeUrl, anchorClick };
}

function setProperty(target: object, key: string, value: unknown): void {
  const before = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  cleanups.push(() => { if (before === undefined) Reflect.deleteProperty(target, key); else Object.defineProperty(target, key, before); });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}
