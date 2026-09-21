// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileMediaPlayer } from "./MobileMediaPlayer";

const bridge = vi.hoisted(() => ({
  appState: "active",
  mounts: 0,
  onAppStateChange: ((_state: string): void => undefined),
  props: undefined as undefined | {
    onContentProcessDidTerminate: () => void;
    onLoadEnd: () => void;
    onMessage: (event: { nativeEvent: { data: string } }) => void;
    onRenderProcessGone: () => boolean;
    source: { html: string };
  },
  postMessage: vi.fn<(value: string) => void>(),
  stopLoading: vi.fn<() => void>()
}));

vi.mock("react-native", () => ({
  AppState: {
    get currentState() { return bridge.appState; },
    addEventListener: (_type: string, listener: (state: string) => void) => {
      bridge.onAppStateChange = listener;
      return { remove: () => { bridge.onAppStateChange = () => undefined; } };
    }
  },
  View: "div"
}));

vi.mock("react-native-webview", async () => {
  const { forwardRef, useEffect, useImperativeHandle } = await import("react");
  return {
    WebView: forwardRef((props: {
      onContentProcessDidTerminate: () => void;
      onLoadEnd: () => void;
      onMessage: (event: { nativeEvent: { data: string } }) => void;
      onRenderProcessGone: () => boolean;
      source: { html: string };
    }, ref) => {
      bridge.props = props;
      useImperativeHandle(ref, () => ({ postMessage: bridge.postMessage, stopLoading: bridge.stopLoading }));
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
});

describe("MobileMediaPlayer", () => {
  it("accepts only exact status, pauses in background, reloads once and fails closed after repeated process loss", () => {
    const onStatusChange = vi.fn();
    root = createRoot(document.createElement("div"));
    act(() => root!.render(createElement(MobileMediaPlayer, {
      background: "#000000",
      ink: "#ffffff",
      instanceId: "lease-1",
      kind: "video",
      locale: "en",
      mediaType: "video/mp4",
      onStatusChange,
      surface: "#111111",
      title: "Demo",
      uri: "file:///cache/preview-lease-1.mp4"
    })));

    expect(bridge.mounts).toBe(1);
    expect(bridge.props?.source.html).toContain("lease-1");
    act(() => bridge.props?.onMessage({ nativeEvent: { data: JSON.stringify({
      type: "joko-media-player/status",
      instanceId: "lease-1",
      state: "playing",
      currentTime: 2,
      duration: 5,
      error: null
    }) } }));
    expect(onStatusChange).toHaveBeenCalledWith(expect.objectContaining({ state: "playing" }));
    act(() => bridge.props?.onMessage({ nativeEvent: { data: JSON.stringify({
      type: "joko-media-player/status",
      instanceId: "forged",
      state: "playing",
      currentTime: 2,
      duration: 5,
      error: null
    }) } }));
    expect(onStatusChange).toHaveBeenCalledTimes(1);

    act(() => {
      bridge.appState = "background";
      bridge.onAppStateChange("background");
    });
    expect(JSON.parse(bridge.postMessage.mock.calls.at(-1)![0])).toMatchObject({ command: "pause", instanceId: "lease-1" });
    expect(bridge.stopLoading).toHaveBeenCalled();
    act(() => {
      bridge.appState = "active";
      bridge.onAppStateChange("active");
    });
    expect(bridge.mounts).toBe(2);

    act(() => { bridge.props?.onRenderProcessGone(); });
    expect(onStatusChange).toHaveBeenLastCalledWith(expect.objectContaining({ state: "error" }));
  });

  it("pauses and stops loading when the exact preview unmounts", () => {
    root = createRoot(document.createElement("div"));
    act(() => root!.render(createElement(MobileMediaPlayer, {
      background: "#000000",
      ink: "#ffffff",
      instanceId: "lease-2",
      kind: "audio",
      locale: "en",
      mediaType: "audio/mpeg",
      surface: "#111111",
      title: "Voice",
      uri: "file:///cache/preview-lease-2.mp3"
    })));
    act(() => root!.unmount());
    root = undefined;
    expect(bridge.postMessage).toHaveBeenCalled();
    expect(bridge.stopLoading).toHaveBeenCalled();
  });
});
