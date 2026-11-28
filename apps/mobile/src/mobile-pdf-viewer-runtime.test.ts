// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMobilePdfViewerCommand,
  buildMobilePdfViewerHtml,
  type MobilePdfJsRuntimeBundle
} from "./mobile-pdf-viewer";

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.innerHTML = "<head></head><body></body>";
});

describe("offline mobile PDF viewer runtime", () => {
  it.each([false, true])("opens verified bytes and reaches the selected reading position by a PDF link or resume, resume=%s", async (resume) => {
    const posted: Record<string, unknown>[] = [];
    let captured: Uint8Array | undefined;
    const targetRef = { num: 5, gen: 0 };
    const getPageIndex = vi.fn(async () => 1);
    const getPermissions = vi.fn(async () => [512]); // The PDF allows accessibility extraction and denies ordinary copying.
    const streamTextContent = vi.fn();
    const scrollToDestination = vi.fn();
    const testWindow = window as unknown as Window & {
      ReactNativeWebView: { postMessage(value: string): void };
      pdfjsWorker: object;
      pdfjsLib: { AnnotationType: { LINK: number }; PermissionFlag: { COPY: number }; getDocument(input: { data: Uint8Array }): {
        promise: Promise<{ numPages: number; getPage(pageNumber: number): Promise<unknown>;
          getPermissions(): Promise<number[]>;
          getPageIndex(ref: typeof targetRef): Promise<number>; destroy(): Promise<void> }>;
        destroy(): Promise<void>;
      } };
    };
    testWindow.ReactNativeWebView = { postMessage(value) { posted.push(JSON.parse(value) as Record<string, unknown>); } };
    testWindow.pdfjsWorker = {};
    testWindow.pdfjsLib = {
      AnnotationType: { LINK: 2 },
      PermissionFlag: { COPY: 16 },
      getDocument(input) {
        captured = Uint8Array.from(input.data);
        return {
          promise: Promise.resolve({
            numPages: 2,
            getPageIndex,
            getPermissions,
            async getPage(pageNumber) {
              return {
                view: [0, 0, 100, 120],
                streamTextContent,
                getViewport({ scale }: { scale: number }) {
                  const point = (x: number, y: number) => [x * scale, (120 - y) * scale];
                  return { width: 100 * scale, height: 120 * scale, convertToViewportPoint: point,
                    convertToViewportRectangle: ([left, bottom, right, top]: [number, number, number, number]) => [
                      ...point(left, bottom), ...point(right, top)
                    ] };
                },
                async getAnnotations() { return pageNumber === 1 ? [
                  { annotationType: 2, rect: [10, 90, 40, 110], dest: [targetRef, { name: "XYZ" }, 20, 80, null] },
                  { annotationType: 2, rect: [10, 60, 40, 80], url: "https://example.invalid/" },
                  { annotationType: 2, rect: [10, 30, 40, 50], dest: "named-destination" }
                ] : []; },
                render() { return { promise: Promise.resolve(), cancel() {} }; }
              };
            },
            async destroy() {}
          }),
          async destroy() {}
        };
      }
    };
    Object.defineProperty(window, "crypto", { configurable: true, value: {} });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const scrollToPage = vi.fn();
    const findElement = document.getElementById.bind(document);
    vi.spyOn(document, "getElementById").mockImplementation(id => {
      const element = findElement(id);
      if (id === "page-2" && element !== null) element.scrollIntoView = scrollToPage;
      if (id === "pages" && element !== null) element.scrollTo = scrollToDestination;
      return element;
    });
    if (!resume) vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return this.id === "page-2" || this instanceof HTMLCanvasElement && this.closest("#page-2")
        ? new DOMRect(0, 960, 240, 288) : new DOMRect(0, 0, 250, 300);
    });

    const html = buildMobilePdfViewerHtml({ instanceId: "runtime-1", locale: "en", title: "Runtime proof",
      background: "#ffffff", surface: "#f5f5f5", ink: "#111111", muted: "#666666",
      accent: "#3366ff", border: "#dddddd",
      resumeAt: resume ? { page: 2, zoomPercent: 125, fitToWidth: false } : undefined }, runtimeBundle());
    document.documentElement.innerHTML = html;
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map((match) => match[1]!);
    new Function(scripts[1]!)();
    expect(posted.at(-1)).toMatchObject({ type: "joko-pdf-viewer/status", state: "ready" });

    const bytes = Uint8Array.from({ length: 80 }, (_, index) => index);
    const sha256Hex = createHash("sha256").update(bytes).digest("hex");
    dispatch(buildMobilePdfViewerCommand("runtime-1", { command: "begin", byteSize: bytes.byteLength, sha256Hex }));
    expect(posted.at(-1)).toMatchObject({ type: "joko-pdf-viewer/ack", command: "begin", index: -1 });
    dispatch(buildMobilePdfViewerCommand("runtime-1", {
      command: "chunk", index: 0, offset: 0, base64: Buffer.from(bytes).toString("base64")
    }));
    expect(posted.at(-1)).toMatchObject({ type: "joko-pdf-viewer/ack", command: "chunk", index: 0 });
    dispatch(buildMobilePdfViewerCommand("runtime-1", { command: "commit" }));

    await vi.waitFor(() => expect(posted).toContainEqual(expect.objectContaining({
      type: "joko-pdf-viewer/ack", command: "commit", index: 0
    })));
    if (!resume) {
      await vi.waitFor(() => expect(document.querySelector('[role="link"]')).not.toBeNull());
      const links = document.querySelectorAll<HTMLButtonElement>('[role="link"]');
      expect(links).toHaveLength(1);
      expect(links[0]!.style.left).toBe("10%");
      expect(links[0]!.style.width).toBe("30%");
      expect(document.querySelector("#page-2 canvas")).toBeNull();
      expect(getPageIndex).not.toHaveBeenCalled();
      links[0]!.click();
      await vi.waitFor(() => expect(scrollToDestination).toHaveBeenCalledWith({ top: 1056, left: 48 }));
      expect(getPageIndex).toHaveBeenCalledWith(targetRef);
    }
    await vi.waitFor(() => expect(posted).toContainEqual(expect.objectContaining({
      type: "joko-pdf-viewer/status", state: "complete", pageCount: 2, renderedPages: 2
    })));
    expect(posted).toContainEqual({ type: "joko-pdf-viewer/position", instanceId: "runtime-1", page: 2,
      zoomPercent: resume ? 125 : 100, fitToWidth: !resume });
    expect(scrollToPage).toHaveBeenCalledTimes(resume ? 1 : 0);
    expect(captured).toEqual(bytes);
    expect(posted.some((message) => message["state"] === "error")).toBe(false);
    expect(document.querySelectorAll(".page")).toHaveLength(2);
    expect(document.querySelectorAll("canvas")).toHaveLength(2);
    expect(getPermissions).toHaveBeenCalledOnce();
    expect(streamTextContent).not.toHaveBeenCalled();
    expect(document.querySelector(".page-text")).toBeNull();
    dispatch(buildMobilePdfViewerCommand("runtime-1", { command: "find" }));
    expect(document.querySelector<HTMLFormElement>("#find-form")?.hidden).toBe(true);
    expect(posted.at(-1)).toMatchObject({ canFind: false });

    dispatch(buildMobilePdfViewerCommand("runtime-1", { command: "dispose" }));
    await vi.waitFor(() => expect(document.querySelectorAll(".page")).toHaveLength(0));
  });
});

function dispatch(data: string): void {
  window.dispatchEvent(new MessageEvent("message", { data }));
}

function runtimeBundle(): MobilePdfJsRuntimeBundle {
  const cMaps: Record<string, string> = { LICENSE: "AA==", "UniGB-UTF16-H.bcmap": "AA==" };
  for (let index = 0; index < 167; index += 1) cMaps[`Map-${index}.bcmap`] = "AA==";
  const standardFonts: Record<string, string> = {
    "FoxitSymbol.pfb": "AA==", "FoxitDingbats.pfb": "AA==", LICENSE_FOXIT: "AA==", LICENSE_LIBERATION: "AA=="
  };
  for (let index = 0; index < 12; index += 1) standardFonts[`Font-${index}.pfb`] = "AA==";
  return { version: "5.7.284", script: "var pdfjsLib={},pdfjsWorker={};" + " ".repeat(500_000),
    scriptSha256Hex: "a".repeat(64), cMaps, cMapByteSize: 1_167_747, cMapSha256Hex: "b".repeat(64),
    standardFonts, standardFontByteSize: 780_306, standardFontSha256Hex: "c".repeat(64) };
}
