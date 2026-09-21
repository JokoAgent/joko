// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileModelViewer } from "./MobileModelViewer";
import type { MobileModelPreviewLease } from "./mobile-model-preview";
import type { MobileModelChunkFileDriver } from "./mobile-model-transfer";

const runtime = vi.hoisted(() => ({
  modelViewerVersion: "4.3.1",
  threeVersion: "0.183.2",
  script: "window.jokoModelViewerRuntime = { ready: Promise.resolve(true) };" + " ".repeat(100_000),
  scriptSha256Hex: "a".repeat(64)
}));

vi.mock("./model-viewer-runtime.modeljs", () => ({ default: runtime }));

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

describe("MobileModelViewer", () => {
  it("streams only after exact ready/acks, exposes no file authority, and bounds recovery", async () => {
    const bytes = new Uint8Array(80).fill(7);
    const close = vi.fn();
    const driver: MobileModelChunkFileDriver = {
      async open() {
        let offset = 0;
        return { byteSize: bytes.byteLength, read(maximum) {
          const chunk = bytes.slice(offset, offset + maximum); offset += chunk.byteLength; return chunk;
        }, close };
      }
    };
    const onStatusChange = vi.fn();
    root = createRoot(document.createElement("div"));
    await act(async () => root!.render(createElement(MobileModelViewer, {
      accent: "#3366ff", background: "#ffffff", border: "#dddddd", ink: "#111111",
      lease: lease(80), locale: "en", muted: "#666666", onStatusChange, readerDriver: driver,
      surface: "#f5f5f5", title: "Scene"
    })));

    expect(bridge.mounts).toBe(1);
    expect(bridge.props).toMatchObject({ allowFileAccess: false, allowFileAccessFromFileURLs: false,
      allowUniversalAccessFromFileURLs: false });
    expect(bridge.props?.source.html).not.toContain("file:///cache");
    await message({ type: "joko-model-viewer/status", instanceId: "model-1",
      state: "ready", fileCount: 0, zoomPercent: 100, error: null });
    expect(lastCommand()).toMatchObject({ command: "begin", instanceId: "model-1", byteSize: 80 });
    await message({ type: "joko-model-viewer/ack", instanceId: "model-1", command: "begin",
      fileIndex: -1, index: -1, offset: 0, byteSize: 80 });
    expect(lastCommand()).toMatchObject({ command: "chunk", fileIndex: 0, index: 0, offset: 0 });
    await message({ type: "joko-model-viewer/ack", instanceId: "model-1", command: "chunk",
      fileIndex: 0, index: 0, offset: 0, byteSize: 80 });
    expect(lastCommand()).toMatchObject({ command: "commit" });
    await message({ type: "joko-model-viewer/ack", instanceId: "model-1", command: "commit",
      fileIndex: -1, index: 0, offset: 80, byteSize: 80 });
    expect(close).toHaveBeenCalledOnce();

    await message({ type: "joko-model-viewer/status", instanceId: "forged",
      state: "complete", fileCount: 1, zoomPercent: 100, error: null });
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

  it("disposes the exact renderer before replacing its owner presentation", () => {
    root = createRoot(document.createElement("div"));
    const render = (surface: string) => createElement(MobileModelViewer, {
      accent: "#3366ff", background: "#ffffff", border: "#dddddd", ink: "#111111",
      lease: lease(80), locale: "en" as const, muted: "#666666", surface, title: "Owner"
    });
    act(() => root!.render(render("#f5f5f5")));
    act(() => root!.render(render("#eeeeee")));
    expect(lastCommand()).toMatchObject({ command: "dispose" });
    expect(bridge.stopLoading).toHaveBeenCalledOnce();
    expect(bridge.mounts).toBe(2);
  });

  it("disposes, aborts, and stops loading on unmount", async () => {
    let resolve!: (value: { byteSize: number; read(): Uint8Array; close(): void }) => void;
    const close = vi.fn();
    const driver: MobileModelChunkFileDriver = { open: async () => new Promise((done) => { resolve = done; }) };
    root = createRoot(document.createElement("div"));
    await act(async () => root!.render(createElement(MobileModelViewer, {
      accent: "#3366ff", background: "#ffffff", border: "#dddddd", ink: "#111111",
      lease: lease(80), locale: "en", muted: "#666666", readerDriver: driver, surface: "#f5f5f5", title: "Scene"
    })));
    await message({ type: "joko-model-viewer/status", instanceId: "model-1",
      state: "ready", fileCount: 0, zoomPercent: 100, error: null });
    act(() => root!.unmount());
    root = undefined;
    resolve({ byteSize: 80, read: () => new Uint8Array(80), close });
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(lastCommand()).toMatchObject({ command: "dispose", instanceId: "model-1" });
    expect(bridge.stopLoading).toHaveBeenCalled();
  });

  it("releases on native pressure and ignores status from the retired WebGL renderer", async () => {
    const onStatusChange = vi.fn();
    root = createRoot(document.createElement("div"));
    await act(async () => root!.render(createElement(MobileModelViewer, {
      accent: "#3366ff", background: "#ffffff", border: "#dddddd", ink: "#111111",
      lease: lease(80), locale: "en", muted: "#666666", onStatusChange,
      readerDriver: { async open() {
        return { byteSize: 80, read: () => new Uint8Array(80), close: () => undefined };
      } }, surface: "#f5f5f5", title: "Scene"
    })));
    const retired = bridge.props;
    act(() => bridge.onResourcePressure());
    expect(lastCommand()).toMatchObject({ command: "dispose", instanceId: "model-1" });
    expect(bridge.mounts).toBe(2);
    await act(async () => retired?.onMessage({ nativeEvent: { data: JSON.stringify({
      type: "joko-model-viewer/status", instanceId: "model-1", state: "complete",
      fileCount: 1, zoomPercent: 100, error: null
    }) } }));
    expect(onStatusChange).not.toHaveBeenCalledWith(expect.objectContaining({ state: "complete" }));
  });
});

function lease(byteSize: number): MobileModelPreviewLease {
  return {
    leaseId: "model-1", profileId: "profile-1",
    uri: "file:///cache/joko-model-preview/preview-model-1.joko-model",
    fileName: "preview-model-1.joko-model", mediaType: "model/gltf+json", modelKind: "gltf",
    modelPath: "scene.gltf", localByteSize: byteSize, packageSha256Hex: "a".repeat(64),
    files: [{ path: "scene.gltf", mediaType: "model/gltf+json", byteOffset: 0,
      byteSize, sha256Hex: "b".repeat(64) }],
    references: []
  };
}

async function message(value: object): Promise<void> {
  await act(async () => {
    bridge.props?.onMessage({ nativeEvent: { data: JSON.stringify(value) } });
    await Promise.resolve();
  });
}

function lastCommand(): Record<string, unknown> {
  return JSON.parse(bridge.postMessage.mock.calls.at(-1)![0]) as Record<string, unknown>;
}
