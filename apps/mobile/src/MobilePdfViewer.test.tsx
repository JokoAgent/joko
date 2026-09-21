// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobilePdfViewer } from "./MobilePdfViewer";
import type { MobilePdfChunkFileDriver, MobilePdfChunkReader } from "./mobile-pdf-transfer";

const runtime = vi.hoisted(() => {
  const cMaps: Record<string, string> = { LICENSE: "AA==", "UniGB-UTF16-H.bcmap": "AA==" };
  for (let index = 0; index < 167; index += 1) cMaps[`Map-${index}.bcmap`] = "AA==";
  const standardFonts: Record<string, string> = {
    "FoxitSymbol.pfb": "AA==", "FoxitDingbats.pfb": "AA==", LICENSE_FOXIT: "AA==", LICENSE_LIBERATION: "AA=="
  };
  for (let index = 0; index < 12; index += 1) standardFonts[`Font-${index}.pfb`] = "AA==";
  return { version: "5.7.284", script: "var pdfjsLib={},pdfjsWorker={};" + " ".repeat(500_000),
    scriptSha256Hex: "a".repeat(64), cMaps, cMapByteSize: 1_167_747, cMapSha256Hex: "b".repeat(64),
    standardFonts, standardFontByteSize: 780_306, standardFontSha256Hex: "c".repeat(64) };
});

vi.mock("./pdfjs-runtime.pdfjs", () => ({ default: runtime }));

const bridge = vi.hoisted(() => ({
  appState: "active",
  mounts: 0,
  onAppStateChange: ((_state: string): void => undefined),
  onResourcePressure: (() => undefined) as () => void,
  props: undefined as undefined | {
    allowFileAccess: boolean;
    allowFileAccessFromFileURLs: boolean;
    allowUniversalAccessFromFileURLs: boolean;
    onContentProcessDidTerminate: () => void;
    onMessage: (event: { nativeEvent: { data: string } }) => void;
    onRenderProcessGone: () => boolean;
    source: { html: string; baseUrl: string };
  },
  postMessage: vi.fn<(value: string) => void>(),
  stopLoading: vi.fn<() => void>()
}));

vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  return {
    AppState: {
      get currentState() { return bridge.appState; },
      addEventListener: (_type: string, listener: (state: string) => void) => {
        bridge.onAppStateChange = listener;
        return { remove: () => { bridge.onAppStateChange = () => undefined; } };
      }
    },
    Pressable: ({ children, onPress, style: _style, ...props }: {
      children?: import("react").ReactNode; onPress?: () => void; style?: unknown; [key: string]: unknown;
    }) => createElement("button", { ...props, onClick: onPress }, children),
    StyleSheet: { create: (value: unknown) => value },
    Text: "span",
    View: "div"
  };
});

vi.mock("./mobile-resource-pressure", () => ({
  mobileResourcePressureSupported: () => true,
  subscribeMobileResourcePressure: (listener: () => void) => {
    bridge.onResourcePressure = listener;
    return { remove: () => { bridge.onResourcePressure = () => undefined; } };
  }
}));

vi.mock("react-native-webview", async () => {
  const { forwardRef, useEffect, useImperativeHandle } = await import("react");
  return {
    WebView: forwardRef((props: NonNullable<typeof bridge.props>, ref) => {
      bridge.props = props;
      useImperativeHandle(ref, () => ({ postMessage: bridge.postMessage, stopLoading: bridge.stopLoading }), []);
      useEffect(() => { bridge.mounts += 1; }, []);
      return null;
    })
  };
});

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  bridge.appState = "active";
  bridge.mounts = 0;
  bridge.props = undefined;
  bridge.postMessage.mockReset();
  bridge.stopLoading.mockReset();
  bridge.onAppStateChange = () => undefined;
  bridge.onResourcePressure = () => undefined;
});

describe("MobilePdfViewer", () => {
  it("streams only after exact ready/acks, exposes no file authority and bounds process recovery", async () => {
    const bytes = new Uint8Array(80).fill(7);
    const close = vi.fn();
    const driver: MobilePdfChunkFileDriver = {
      async open() {
        let offset = 0;
        return { byteSize: bytes.byteLength, read(maximum) {
          const chunk = bytes.slice(offset, offset + maximum); offset += chunk.byteLength; return chunk;
        }, close };
      }
    };
    const onStatusChange = vi.fn();
    root = createRoot(document.createElement("div"));
    await act(async () => root!.render(createElement(MobilePdfViewer, {
      accent: "#3366ff", background: "#ffffff", border: "#dddddd", byteSize: 80,
      fileName: "preview-pdf-1.pdf", ink: "#111111", instanceId: "pdf-1", locale: "en", muted: "#666666",
      onStatusChange, readerDriver: driver, sha256Hex: "a".repeat(64), surface: "#f5f5f5",
      title: "Proof", uri: "file:///cache/joko-pdf-preview/preview-pdf-1.pdf"
    })));

    expect(bridge.mounts).toBe(1);
    expect(bridge.props).toMatchObject({ allowFileAccess: false, allowFileAccessFromFileURLs: false,
      allowUniversalAccessFromFileURLs: false });
    expect(bridge.props?.source.html).not.toContain("file:///cache");
    await message({ type: "joko-pdf-viewer/status", instanceId: "pdf-1", state: "ready",
      pageCount: 0, currentPage: 0, renderedPages: 0, zoomPercent: 100, error: null });
    expect(lastCommand()).toMatchObject({ command: "begin", instanceId: "pdf-1", byteSize: 80 });
    await message({ type: "joko-pdf-viewer/ack", instanceId: "pdf-1", command: "begin", index: -1 });
    expect(lastCommand()).toMatchObject({ command: "chunk", index: 0, offset: 0 });
    await message({ type: "joko-pdf-viewer/ack", instanceId: "pdf-1", command: "chunk", index: 0 });
    expect(lastCommand()).toMatchObject({ command: "commit" });
    await message({ type: "joko-pdf-viewer/ack", instanceId: "pdf-1", command: "commit", index: 0 });
    expect(close).toHaveBeenCalledOnce();

    await message({ type: "joko-pdf-viewer/status", instanceId: "forged", state: "complete",
      pageCount: 1, currentPage: 1, renderedPages: 1, zoomPercent: 100, error: null });
    expect(onStatusChange).toHaveBeenCalledTimes(1);

    act(() => { bridge.appState = "background"; bridge.onAppStateChange("background"); });
    expect(lastCommand()).toMatchObject({ command: "dispose" });
    expect(bridge.stopLoading).toHaveBeenCalled();
    act(() => { bridge.appState = "active"; bridge.onAppStateChange("active"); });
    expect(bridge.mounts).toBe(2);
    act(() => { bridge.props?.onRenderProcessGone(); });
    expect(bridge.mounts).toBe(3);
    act(() => { bridge.props?.onRenderProcessGone(); });
    expect(onStatusChange).toHaveBeenLastCalledWith(expect.objectContaining({ state: "error" }));
  });

  it("aborts transfer on native pressure and rejects retired renderer callbacks", async () => {
    let resolveOpen!: (value: { byteSize: number; read(maximum: number): Uint8Array; close(): void }) => void;
    const close = vi.fn();
    const onStatusChange = vi.fn();
    root = createRoot(document.createElement("div"));
    await act(async () => root!.render(createElement(MobilePdfViewer, {
      accent: "#3366ff", background: "#ffffff", border: "#dddddd", byteSize: 80,
      fileName: "preview-pdf-pressure.pdf", ink: "#111111", instanceId: "pdf-pressure", locale: "en", muted: "#666666",
      onStatusChange, readerDriver: { open: async () => new Promise<MobilePdfChunkReader>((resolve) => {
        resolveOpen = resolve;
      }) },
      sha256Hex: "a".repeat(64), surface: "#f5f5f5", title: "Pressure",
      uri: "file:///cache/joko-pdf-preview/preview-pdf-pressure.pdf"
    })));
    await message({ type: "joko-pdf-viewer/status", instanceId: "pdf-pressure", state: "ready",
      pageCount: 0, currentPage: 0, renderedPages: 0, zoomPercent: 100, error: null });
    const retired = bridge.props;
    act(() => bridge.onResourcePressure());
    resolveOpen({ byteSize: 80, read: () => new Uint8Array(80), close });
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    await act(async () => retired?.onMessage({ nativeEvent: { data: JSON.stringify({
      type: "joko-pdf-viewer/status", instanceId: "pdf-pressure", state: "complete",
      pageCount: 1, currentPage: 1, renderedPages: 1, zoomPercent: 100, error: null
    }) } }));
    expect(onStatusChange).not.toHaveBeenCalledWith(expect.objectContaining({ state: "complete" }));
  });

  it("disposes the exact renderer before replacing its owner presentation", () => {
    root = createRoot(document.createElement("div"));
    const render = (surface: string) => createElement(MobilePdfViewer, {
      accent: "#3366ff", background: "#ffffff", border: "#dddddd", byteSize: 80,
      fileName: "preview-pdf-owner.pdf", ink: "#111111", instanceId: "pdf-owner", locale: "en" as const,
      muted: "#666666", sha256Hex: "a".repeat(64), surface, title: "Owner",
      uri: "file:///cache/joko-pdf-preview/preview-pdf-owner.pdf"
    });
    act(() => root!.render(render("#f5f5f5")));
    act(() => root!.render(render("#eeeeee")));
    expect(lastCommand()).toMatchObject({ command: "dispose", instanceId: "pdf-owner" });
    expect(bridge.stopLoading).toHaveBeenCalledOnce();
    expect(bridge.mounts).toBe(2);
  });

  it("disposes and stops loading when the exact preview unmounts", () => {
    const driver: MobilePdfChunkFileDriver = { async open() {
      return { byteSize: 80, read: () => new Uint8Array(80), close: () => undefined };
    } };
    root = createRoot(document.createElement("div"));
    act(() => root!.render(createElement(MobilePdfViewer, {
      accent: "#3366ff", background: "#ffffff", border: "#dddddd", byteSize: 80,
      fileName: "preview-pdf-2.pdf", ink: "#111111", instanceId: "pdf-2", locale: "en", muted: "#666666",
      readerDriver: driver, sha256Hex: "a".repeat(64), surface: "#f5f5f5", title: "Proof",
      uri: "file:///cache/joko-pdf-preview/preview-pdf-2.pdf"
    })));
    act(() => root!.unmount());
    root = undefined;
    expect(lastCommand()).toMatchObject({ command: "dispose", instanceId: "pdf-2" });
    expect(bridge.stopLoading).toHaveBeenCalled();
  });
});

async function message(value: object): Promise<void> {
  await act(async () => {
    bridge.props?.onMessage({ nativeEvent: { data: JSON.stringify(value) } });
    await Promise.resolve();
  });
}

function lastCommand(): Record<string, unknown> {
  return JSON.parse(bridge.postMessage.mock.calls.at(-1)![0]) as Record<string, unknown>;
}
