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
  it("executes the exact chunk/SHA path before opening and rendering every declared page", async () => {
    const posted: Record<string, unknown>[] = [];
    let captured: Uint8Array | undefined;
    const testWindow = window as unknown as Window & {
      ReactNativeWebView: { postMessage(value: string): void };
      pdfjsWorker: object;
      pdfjsLib: { getDocument(input: { data: Uint8Array }): {
        promise: Promise<{ numPages: number; getPage(pageNumber: number): Promise<unknown>; destroy(): Promise<void> }>;
        destroy(): Promise<void>;
      } };
    };
    testWindow.ReactNativeWebView = { postMessage(value) { posted.push(JSON.parse(value) as Record<string, unknown>); } };
    testWindow.pdfjsWorker = {};
    testWindow.pdfjsLib = {
      getDocument(input) {
        captured = Uint8Array.from(input.data);
        return {
          promise: Promise.resolve({
            numPages: 2,
            async getPage() {
              return {
                getViewport({ scale }: { scale: number }) { return { width: 100 * scale, height: 120 * scale }; },
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

    const html = buildMobilePdfViewerHtml({ instanceId: "runtime-1", title: "Runtime proof",
      background: "#ffffff", surface: "#f5f5f5", ink: "#111111", muted: "#666666",
      accent: "#3366ff", border: "#dddddd" }, runtimeBundle());
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
    await vi.waitFor(() => expect(posted).toContainEqual(expect.objectContaining({
      type: "joko-pdf-viewer/status", state: "complete", pageCount: 2, renderedPages: 2
    })));
    expect(captured).toEqual(bytes);
    expect(posted.some((message) => message["state"] === "error")).toBe(false);
    expect(document.querySelectorAll(".page")).toHaveLength(2);
    expect(document.querySelectorAll("canvas")).toHaveLength(2);

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
