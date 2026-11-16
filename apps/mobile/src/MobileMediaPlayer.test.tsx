// @vitest-environment jsdom
import { createRequire } from "node:module";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileMediaPlayer } from "./MobileMediaPlayer";
import { buildMobileMediaPlayerHtml, type MobileMediaPlayerStatus } from "./mobile-media-player";

const { JSDOM } = createRequire(import.meta.url)("jsdom");

const bridge = vi.hoisted(() => ({
  appState: "active",
  mounts: 0,
  onAppStateChange: ((_state: string): void => undefined),
  onResourcePressure: (() => undefined) as () => void,
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
    WebView: forwardRef((props: {
      onContentProcessDidTerminate: () => void;
      onLoadEnd: () => void;
      onMessage: (event: { nativeEvent: { data: string } }) => void;
      onRenderProcessGone: () => boolean;
      source: { html: string };
    }, ref) => {
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

describe("MobileMediaPlayer", () => {
  it.each(["playing", "paused"] as const)("restores %s audio at its last trusted position across inactive and background without autoplay", state => {
    const onStatusChange = vi.fn();
    root = createRoot(document.createElement("div"));
    act(() => root!.render(createElement(MobileMediaPlayer, {
      background: "#000000", border: "#333333", ink: "#ffffff", instanceId: "lease-position",
      kind: "audio", locale: "en", mediaType: "audio/mpeg", onStatusChange,
      surface: "#111111", title: "Voice", uri: "file:///cache/position.mp3"
    })));
    const initialSource = bridge.props!.source;
    sendStatus({ instanceId: "lease-position", state, currentTime: 30.25, duration: 120 });
    expect(bridge.props!.source).toBe(initialSource);
    for (const inactive of ["inactive", "background"]) {
      const retired = bridge.props!;
      act(() => { bridge.appState = inactive; bridge.onAppStateChange(inactive); bridge.onAppStateChange(inactive); });
      expect(onStatusChange).toHaveBeenLastCalledWith(expect.objectContaining({ state: "suspended", currentTime: 30.25, duration: 120 }));
      act(() => { bridge.appState = "active"; bridge.onAppStateChange("active"); });
      const recovered = bridge.props!;
      act(() => retired.onMessage({ nativeEvent: { data: JSON.stringify({ type: "joko-media-player/status", instanceId: "lease-position",
        state: "paused", currentTime: 1, duration: 120, error: null }) } }));
      const playback = metadata(recovered.source.html, 120);
      expect(playback.position).toBe(30.25);
      expect(playback.playCalls).toBe(0);
      sendStatus(playback.status);
      expect(bridge.props!.source).toBe(recovered.source);
      expect(onStatusChange).toHaveBeenLastCalledWith(expect.objectContaining({ state: "ready", currentTime: 30.25 }));
    }
    expect(bridge.mounts).toBe(3);
    expect(bridge.postMessage.mock.calls.map(([value]) => JSON.parse(value).command)).not.toContain("play");
    sendStatus({ instanceId: "lease-position", state: "paused", currentTime: 0, duration: 120 });
    act(() => { bridge.appState = "inactive"; bridge.onAppStateChange("inactive"); });
    act(() => { bridge.appState = "active"; bridge.onAppStateChange("active"); });
    expect(metadata(bridge.props!.source.html, 120).position).toBe(0);
  });

  it("retains an unknown-duration position through presentation recovery but never applies it to a replacement media owner", () => {
    root = createRoot(document.createElement("div"));
    const render = (uri: string, surface = "#111111", instanceId = "lease-position") => createElement(MobileMediaPlayer, {
      background: "#000000", border: "#333333", ink: "#ffffff", instanceId,
      kind: "audio" as const, locale: "en" as const, mediaType: "audio/mpeg",
      surface, title: "Voice", uri
    });
    act(() => root!.render(render("file:///cache/original.mp3")));
    sendStatus({ instanceId: "lease-position", state: "paused", currentTime: 45, duration: null });
    const retired = bridge.props!;
    act(() => root!.render(render("file:///cache/original.mp3", "#222222")));
    expect(metadata(bridge.props!.source.html, Number.NaN).position).toBe(45);
    const recoveredSource = bridge.props!.source;
    act(() => retired.onMessage({ nativeEvent: { data: JSON.stringify({ type: "joko-media-player/status", instanceId: "lease-position",
      state: "playing", currentTime: 2, duration: 120, error: null }) } }));
    expect(bridge.props!.source).toBe(recoveredSource);
    act(() => bridge.onResourcePressure());
    const pressureRecovery = metadata(bridge.props!.source.html, Number.NaN);
    expect(pressureRecovery.position).toBe(45);
    sendStatus(pressureRecovery.status);
    act(() => root!.render(render("file:///cache/replacement.mp3")));
    expect(metadata(bridge.props!.source.html, 120).position).toBe(0);
    sendStatus({ instanceId: "lease-position", state: "paused", currentTime: 20, duration: 120 });
    act(() => root!.render(render("file:///cache/replacement.mp3", "#111111", "lease-replacement")));
    expect(metadata(bridge.props!.source.html, 120).position).toBe(0);
  });

  it.each([120, 20, Number.NaN, Number.POSITIVE_INFINITY])("restores once at metadata for duration %s and preserves later seeking and explicit reset", duration => {
    const result = metadata(buildMobileMediaPlayerHtml({ instanceId: "lease-runtime", kind: "audio", locale: "en", mediaType: "audio/mpeg",
      title: "Voice", uri: "file:///cache/voice.mp3", background: "#000000", surface: "#111111", ink: "#ffffff", initialTime: 30 }), duration, true);
    expect(result.position).toBe(Number.isFinite(duration) ? Math.min(30, duration) : 30);
    expect(result.playCalls).toBe(0);
    expect(result.afterSecondMetadata).toBe(12);
    expect(result.afterReset).toBe(0);
  });

  it("accepts only exact status, pauses in background, reloads once and fails closed after repeated process loss", () => {
    const onStatusChange = vi.fn();
    root = createRoot(document.createElement("div"));
    act(() => root!.render(createElement(MobileMediaPlayer, {
      background: "#000000",
      border: "#333333",
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
    expect(bridge.mounts).toBe(3);
    act(() => { bridge.props?.onRenderProcessGone(); });
    expect(onStatusChange).toHaveBeenLastCalledWith(expect.objectContaining({ state: "error" }));
  });

  it("releases on native pressure and rejects status from the retired renderer generation", () => {
    const onStatusChange = vi.fn();
    root = createRoot(document.createElement("div"));
    act(() => root!.render(createElement(MobileMediaPlayer, {
      background: "#000000", border: "#333333", ink: "#ffffff", instanceId: "lease-pressure",
      kind: "audio", locale: "en", mediaType: "audio/mpeg", onStatusChange,
      surface: "#111111", title: "Voice", uri: "file:///cache/preview-lease-pressure.mp3"
    })));
    const retired = bridge.props;
    act(() => bridge.onResourcePressure());
    expect(bridge.stopLoading).toHaveBeenCalled();
    expect(bridge.mounts).toBe(2);
    act(() => retired?.onMessage({ nativeEvent: { data: JSON.stringify({
      type: "joko-media-player/status", instanceId: "lease-pressure", state: "playing",
      currentTime: 1, duration: 2, error: null
    }) } }));
    expect(onStatusChange).not.toHaveBeenCalledWith(expect.objectContaining({ state: "playing" }));
  });

  it("releases the exact renderer before replacing its owner presentation", () => {
    root = createRoot(document.createElement("div"));
    const render = (surface: string) => createElement(MobileMediaPlayer, {
      background: "#000000", border: "#333333", ink: "#ffffff", instanceId: "lease-owner",
      kind: "audio" as const, locale: "en" as const, mediaType: "audio/mpeg", surface,
      title: "Owner", uri: "file:///cache/preview-lease-owner.mp3"
    });
    act(() => root!.render(render("#111111")));
    act(() => root!.render(render("#222222")));
    expect(JSON.parse(bridge.postMessage.mock.calls.at(-1)![0])).toMatchObject({ command: "pause" });
    expect(bridge.stopLoading).toHaveBeenCalledOnce();
    expect(bridge.mounts).toBe(2);
  });

  it("pauses and stops loading when the exact preview unmounts", () => {
    root = createRoot(document.createElement("div"));
    act(() => root!.render(createElement(MobileMediaPlayer, {
      background: "#000000",
      border: "#333333",
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

function sendStatus(status: Pick<MobileMediaPlayerStatus, "instanceId" | "state" | "currentTime" | "duration">): void {
  act(() => bridge.props?.onMessage({ nativeEvent: { data: JSON.stringify({ type: "joko-media-player/status", error: null, ...status }) } }));
}

function metadata(html: string, duration: number, exerciseControls = false): {
  position: number; playCalls: number; status: MobileMediaPlayerStatus; afterSecondMetadata?: number; afterReset?: number;
} {
  const messages: MobileMediaPlayerStatus[] = [];
  const play = vi.fn();
  const dom = new JSDOM(html, { runScripts: "dangerously", beforeParse(window: Window & typeof globalThis) {
    Object.defineProperty(window, "ReactNativeWebView", { value: { postMessage: (value: string) => messages.push(JSON.parse(value) as MobileMediaPlayerStatus) } });
    Object.defineProperty(window.HTMLMediaElement.prototype, "duration", { get: () => duration });
    Object.defineProperty(window.HTMLMediaElement.prototype, "play", { value: play });
    Object.defineProperty(window.HTMLMediaElement.prototype, "pause", { value: () => undefined });
  } });
  try {
    const media = dom.window.document.querySelector("audio,video") as HTMLMediaElement;
    media.dispatchEvent(new dom.window.Event("loadedmetadata"));
    const result = { position: media.currentTime, playCalls: play.mock.calls.length, status: messages.at(-1)!,
      afterSecondMetadata: undefined as number | undefined, afterReset: undefined as number | undefined };
    if (exerciseControls) {
      media.currentTime = 12;
      media.dispatchEvent(new dom.window.Event("loadedmetadata"));
      result.afterSecondMetadata = media.currentTime;
      dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: JSON.stringify({
        type: "joko-media-player/command", instanceId: result.status.instanceId, command: "reset"
      }) }));
      result.afterReset = media.currentTime;
    }
    return result;
  } finally { dom.window.close(); }
}
