// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspacePdfCanvas } from "./WorkspacePdfCanvas.js";

const { getDocument } = vi.hoisted(() => ({ getDocument: vi.fn() }));
vi.mock("pdfjs-dist", () => ({ getDocument, GlobalWorkerOptions: {} }));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "/pdf.worker.mjs" }));

class PageObserver {
  static current: PageObserver | undefined;
  readonly targets = new Set<Element>();
  readonly disconnect = vi.fn();

  constructor(readonly callback: IntersectionObserverCallback, readonly options: IntersectionObserverInit) {
    PageObserver.current = this;
  }

  observe(target: Element): void { this.targets.add(target); }

  change(target: Element, isIntersecting: boolean): void {
    this.callback([{ target, isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

const roots: Root[] = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("IntersectionObserver", PageObserver);
  vi.stubGlobal("devicePixelRatio", 5);
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  PageObserver.current = undefined;
  getDocument.mockReset();
  vi.unstubAllGlobals();
});

it("allocates backing stores only near the viewport and preserves measured page sizes after eviction", async () => {
  const first = pdfPage(500, 500);
  const large = pdfPage(15_000, 15_000);
  const pdf = pdfDocument(100, number => number === 1 ? first : large);
  getDocument.mockReturnValue(pdf.task);
  const view = await mount("blob:report");
  const observer = await vi.waitFor(() => required(PageObserver.current));
  expect(observer.options).toEqual({ root: view.scrollRoot(), rootMargin: "400px 0px", threshold: 0 });
  expect(observer.targets.size).toBe(100);
  expect(pdf.getPage).not.toHaveBeenCalled();
  expect(view.host.querySelector('[role="status"]')?.textContent).toContain("Loading");

  const firstPlaceholder = view.page(1);
  await act(async () => observer.change(firstPlaceholder, true));
  const firstCanvas = await vi.waitFor(() => required(firstPlaceholder.querySelector("canvas")));
  expect(firstCanvas.width).toBe(1000);
  expect(firstCanvas.height).toBe(1000);
  expect(view.sheet(1).style.width).toBe("500px");
  expect(view.host.querySelector('[role="status"]')).toBeNull();
  expect(pdf.getPage.mock.calls).toEqual([[1]]);

  const largePlaceholder = view.page(2);
  await act(async () => {
    observer.change(firstPlaceholder, false);
    observer.change(largePlaceholder, true);
  });
  const largeCanvas = await vi.waitFor(() => required(largePlaceholder.querySelector("canvas")));
  expect(largeCanvas.width * largeCanvas.height).toBeGreaterThan(0);
  expect(largeCanvas.width * largeCanvas.height).toBeLessThanOrEqual(4_000_000);
  expect(view.sheet(2).style.height).toBe("15000px");
  expect(firstPlaceholder.querySelector("canvas")).toBeNull();
  expect([firstCanvas.width, firstCanvas.height]).toEqual([0, 0]);
  expect(view.sheet(1).style.height).toBe("500px");

  await act(async () => {
    observer.change(largePlaceholder, false);
    observer.change(firstPlaceholder, true);
  });
  const reentered = await vi.waitFor(() => required(firstPlaceholder.querySelector("canvas")));
  expect(reentered).not.toBe(firstCanvas);
  expect(pdf.getPage.mock.calls).toEqual([[1], [2], [1]]);
  expect([largeCanvas.width, largeCanvas.height]).toEqual([0, 0]);
  expect(view.host.querySelectorAll("canvas")).toHaveLength(1);
});

it("cancels an unfinished offscreen page and only reports a current render failure", async () => {
  const page = pdfPage(918, 1188);
  const offscreen = deferredRender();
  const current = deferredRender();
  page.render.mockReturnValueOnce(offscreen.task).mockReturnValueOnce(current.task);
  const pdf = pdfDocument(1, () => page);
  getDocument.mockReturnValue(pdf.task);
  const view = await mount("blob:active");
  const observer = await vi.waitFor(() => required(PageObserver.current));
  const placeholder = view.page(1);

  await act(async () => observer.change(placeholder, true));
  await vi.waitFor(() => expect(page.render).toHaveBeenCalledOnce());
  expect(view.host.querySelector('[role="status"]')?.textContent).toContain("Loading");
  const originalCanvas = page.render.mock.calls[0]![0].canvas;
  await act(async () => observer.change(placeholder, false));
  expect(offscreen.task.cancel).toHaveBeenCalledOnce();
  expect([originalCanvas.width, originalCanvas.height]).toEqual([0, 0]);

  await act(async () => {
    observer.change(placeholder, true);
    offscreen.reject(new Error("A retired raster failed."));
  });
  await vi.waitFor(() => expect(page.render).toHaveBeenCalledTimes(2));
  expect(view.onError).not.toHaveBeenCalled();
  await act(async () => current.reject(new Error("The current raster failed.")));
  expect(view.onError).toHaveBeenCalledOnce();
  expect(pdf.task.destroy).toHaveBeenCalledOnce();
  expect(observer.disconnect).toHaveBeenCalledOnce();
  expect(view.host.querySelector("canvas")).toBeNull();
});

it("retires the old observer, worker and canvas on an authenticated URL change", async () => {
  const previous = pdfPage(918, 1188);
  const replacement = pdfPage(918, 1188);
  const oldPdf = pdfDocument(1, () => previous);
  const nextPdf = pdfDocument(1, () => replacement);
  getDocument.mockReturnValueOnce(oldPdf.task).mockReturnValueOnce(nextPdf.task);
  const view = await mount("blob:previous");
  const oldObserver = await vi.waitFor(() => required(PageObserver.current));
  const oldPage = view.page(1);
  await act(async () => oldObserver.change(oldPage, true));
  const oldCanvas = await vi.waitFor(() => required(oldPage.querySelector("canvas")));

  await view.render("blob:replacement");
  const newObserver = await vi.waitFor(() => {
    const observer = required(PageObserver.current);
    expect(observer).not.toBe(oldObserver);
    return observer;
  });
  expect(oldObserver.disconnect).toHaveBeenCalledOnce();
  expect(oldPdf.task.destroy).toHaveBeenCalledOnce();
  expect([oldCanvas.width, oldCanvas.height]).toEqual([0, 0]);
  await act(async () => oldObserver.change(oldPage, true));
  expect(nextPdf.getPage).not.toHaveBeenCalled();
  await act(async () => newObserver.change(view.page(1), true));
  expect(nextPdf.getPage.mock.calls).toEqual([[1]]);
  expect(view.page(1).querySelector("canvas")).not.toBeNull();
  expect(view.onError).not.toHaveBeenCalled();
});

it("renders only page one when IntersectionObserver is unavailable", async () => {
  vi.stubGlobal("IntersectionObserver", undefined);
  const page = pdfPage(918, 1188);
  const pdf = pdfDocument(100, () => page);
  getDocument.mockReturnValue(pdf.task);
  const view = await mount("blob:fallback");
  await vi.waitFor(() => expect(view.host.querySelectorAll("canvas")).toHaveLength(1));
  expect(pdf.getPage.mock.calls).toEqual([[1]]);
  expect(view.page(1).querySelector("canvas")).not.toBeNull();
});

async function mount(url: string) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  roots.push(root);
  const onError = vi.fn();
  const render = async (source: string) => act(async () => root.render(<Preview url={source} onError={onError} />));
  await render(url);
  return {
    host, render, onError,
    scrollRoot: () => required(host.firstElementChild),
    page: (number: number) => required(host.querySelector<HTMLElement>(`[data-pdf-page="${number}"]`)),
    sheet: (number: number) => required(host.querySelector<HTMLElement>(`[data-pdf-page="${number}"] .workspace-file-body__pdf-sheet`))
  };
}

function Preview({ url, onError }: { readonly url: string; readonly onError: () => void }) {
  const scrollRoot = useRef<HTMLDivElement>(null);
  return <div ref={scrollRoot}><WorkspacePdfCanvas url={url} label="PDF" loadingLabel="Loading" scrollRoot={scrollRoot} onError={onError} /></div>;
}

function pdfPage(width: number, height: number) {
  return {
    getViewport: vi.fn(() => ({ width, height })),
    render: vi.fn((_input: { canvas: HTMLCanvasElement }) => ({ cancel: vi.fn(), promise: Promise.resolve() })),
    cleanup: vi.fn()
  };
}

function pdfDocument(numPages: number, page: (pageNumber: number) => ReturnType<typeof pdfPage>) {
  const getPage = vi.fn(async (pageNumber: number) => page(pageNumber));
  return { getPage, task: { promise: Promise.resolve({ numPages, getPage }), destroy: vi.fn(async () => undefined) } };
}

function deferredRender() {
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((_resolve, rejectRender) => { reject = rejectRender; });
  return { task: { promise, cancel: vi.fn() }, reject };
}

function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("Expected the PDF page or observer to be present.");
  return value;
}
