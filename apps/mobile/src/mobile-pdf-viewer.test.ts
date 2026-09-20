import { describe, expect, it } from "vitest";
import {
  buildMobilePdfViewerCommand,
  buildMobilePdfViewerHtml,
  createMobilePdfViewerLifecycle,
  mobilePdfViewerLimits,
  parseMobilePdfViewerMessage,
  type MobilePdfJsRuntimeBundle
} from "./mobile-pdf-viewer";

describe("mobile PDF viewer protocol", () => {
  it("serializes only bounded exact begin/chunk/commit/dispose commands", () => {
    expect(JSON.parse(buildMobilePdfViewerCommand("pdf-1", {
      command: "begin", byteSize: 64, sha256Hex: "a".repeat(64)
    }))).toEqual({ type: "joko-pdf-viewer/command", instanceId: "pdf-1", command: "begin",
      byteSize: 64, sha256Hex: "a".repeat(64) });
    expect(JSON.parse(buildMobilePdfViewerCommand("pdf-1", {
      command: "chunk", index: 0, offset: 0, base64: "AQID"
    }))).toMatchObject({ command: "chunk", index: 0, offset: 0, base64: "AQID" });
    expect(JSON.parse(buildMobilePdfViewerCommand("pdf-1", { command: "commit" }))).toMatchObject({ command: "commit" });
    expect(JSON.parse(buildMobilePdfViewerCommand("pdf-1", { command: "dispose" }))).toMatchObject({ command: "dispose" });
    expect(() => buildMobilePdfViewerCommand("pdf-1", {
      command: "begin", byteSize: 63, sha256Hex: "a".repeat(64)
    })).toThrow(/identity/u);
    expect(() => buildMobilePdfViewerCommand("pdf-1", {
      command: "chunk", index: 0, offset: 0, base64: "not base64"
    })).toThrow(/chunk/u);
  });

  it("accepts exact instance-bound status and acknowledgements only", () => {
    expect(parseMobilePdfViewerMessage(JSON.stringify({
      type: "joko-pdf-viewer/status", instanceId: "pdf-1", state: "rendering",
      pageCount: 12, renderedPages: 4, zoomPercent: 125, error: null
    }), "pdf-1")).toMatchObject({ state: "rendering", pageCount: 12, renderedPages: 4 });
    expect(parseMobilePdfViewerMessage(JSON.stringify({
      type: "joko-pdf-viewer/ack", instanceId: "pdf-1", command: "chunk", index: 2
    }), "pdf-1")).toEqual({ type: "joko-pdf-viewer/ack", instanceId: "pdf-1", command: "chunk", index: 2 });
    expect(parseMobilePdfViewerMessage(JSON.stringify({
      type: "joko-pdf-viewer/status", instanceId: "forged", state: "complete",
      pageCount: 1, renderedPages: 1, zoomPercent: 100, error: null
    }), "pdf-1")).toBeUndefined();
    expect(parseMobilePdfViewerMessage(JSON.stringify({
      type: "joko-pdf-viewer/status", instanceId: "pdf-1", state: "complete",
      pageCount: 1, renderedPages: 2, zoomPercent: 100, error: null
    }), "pdf-1")).toBeUndefined();
    expect(parseMobilePdfViewerMessage(JSON.stringify({
      type: "joko-pdf-viewer/ack", instanceId: "pdf-1", command: "chunk", index: 2, extra: true
    }), "pdf-1")).toBeUndefined();
  });
});

describe("mobile PDF viewer HTML", () => {
  it("embeds the pinned complete offline runtime and a no-network/no-file all-page viewer", () => {
    const html = buildMobilePdfViewerHtml({
      instanceId: "pdf-1",
      title: "Proof <final>",
      background: "#ffffff",
      surface: "#f5f5f5",
      ink: "#111111",
      muted: "#666666",
      accent: "#3366ff",
      border: "#dddddd"
    }, runtimeBundle());
    expect(html).toContain("Pages of Proof &lt;final&gt;");
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("worker-src 'none'");
    expect(html).toContain("useWorkerFetch: false");
    expect(html).toContain("BinaryDataFactory: EmbeddedBinaryDataFactory");
    expect(html).toContain("UniGB-UTF16-H.bcmap");
    expect(html).toContain("FoxitSymbol.pfb");
    expect(html).toContain("FoxitDingbats.pfb");
    expect(html).toContain("for (var pageNumber = 1; pageNumber <= pageCount; pageNumber += 1)");
    expect(html).toContain("IntersectionObserver");
    expect(html).toContain(`var MAX_RESIDENT = ${mobilePdfViewerLimits.maximumResidentCanvases}`);
    expect(html).toContain("Fit PDF pages to width");
    expect(html).not.toContain("http://");
    expect(html).not.toContain("file://");
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map((match) => match[1]!);
    expect(scripts).toHaveLength(2);
    expect(() => new Function(scripts[1]!)).not.toThrow();
  });

  it("rejects incomplete or unpinned embedded resources", () => {
    const runtime = runtimeBundle();
    expect(() => buildMobilePdfViewerHtml({
      instanceId: "pdf-1", title: "Proof", background: "#ffffff", surface: "#f5f5f5",
      ink: "#111111", muted: "#666666", accent: "#3366ff", border: "#dddddd"
    }, { ...runtime, version: "5.7.283" })).toThrow(/runtime bundle/u);
    const { ["UniGB-UTF16-H.bcmap"]: _removed, ...missingCMap } = runtime.cMaps;
    expect(() => buildMobilePdfViewerHtml({
      instanceId: "pdf-1", title: "Proof", background: "#ffffff", surface: "#f5f5f5",
      ink: "#111111", muted: "#666666", accent: "#3366ff", border: "#dddddd"
    }, { ...runtime, cMaps: missingCMap })).toThrow(/runtime bundle/u);
  });
});

describe("mobile PDF viewer lifecycle", () => {
  it("reloads once after background/process loss and then fails closed", () => {
    const lifecycle = createMobilePdfViewerLifecycle();
    lifecycle.onBackground();
    expect(lifecycle.consumeReloadOnActive()).toBe("reload");
    expect(lifecycle.onProcessLost(true)).toBe("failed");
    lifecycle.reset();
    expect(lifecycle.onProcessLost(false)).toBe("wait");
    expect(lifecycle.consumeReloadOnActive()).toBe("reload");
  });
});

function runtimeBundle(): MobilePdfJsRuntimeBundle {
  const cMaps: Record<string, string> = { LICENSE: "AA==", "UniGB-UTF16-H.bcmap": "AA==" };
  for (let index = 0; index < 167; index += 1) cMaps[`Map-${index}.bcmap`] = "AA==";
  const standardFonts: Record<string, string> = {
    "FoxitSymbol.pfb": "AA==",
    "FoxitDingbats.pfb": "AA==",
    LICENSE_FOXIT: "AA==",
    LICENSE_LIBERATION: "AA=="
  };
  for (let index = 0; index < 12; index += 1) standardFonts[`Font-${index}.pfb`] = "AA==";
  return {
    version: "5.7.284",
    script: "var pdfjsLib = {}, pdfjsWorker = {};" + " ".repeat(500_000),
    scriptSha256Hex: "a".repeat(64),
    cMaps,
    cMapByteSize: 1_167_747,
    cMapSha256Hex: "b".repeat(64),
    standardFonts,
    standardFontByteSize: 780_306,
    standardFontSha256Hex: "c".repeat(64)
  };
}
