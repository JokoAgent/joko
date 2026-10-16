// @vitest-environment jsdom
import { act, createElement, forwardRef, useImperativeHandle, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MobileSharedConnectionScreen } from "./MobileSharedConnectionScreen";
import type { MobileClient, MobileState } from "./mobile-client";

interface RendererProps {
  readonly source: { readonly html: string };
  readonly onMessage: (event: { nativeEvent: { data: string } }) => void;
  readonly onError: () => void;
  readonly onContentProcessDidTerminate: () => void;
  readonly onRenderProcessGone: () => boolean;
}
const native = vi.hoisted(() => ({
  renderers: [] as { props: RendererProps; injectJavaScript: ReturnType<typeof vi.fn> }[]
}));
vi.mock("./connection-runtime.connjs", () => ({ default: { css: "", script: "" } }));
vi.mock("./MobileKeyboardAvoidingView", () => ({
  MobileKeyboardAvoidingView: ({ children }: { children?: ReactNode }) => createElement("div", {}, children),
  useMobileKeyboardState: () => ({ height: 0, visible: false })
}));
vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
  Platform: { OS: "ios" }, StyleSheet: { create: (styles: unknown) => styles },
  Text: ({ children, accessibilityRole }: { children?: ReactNode; accessibilityRole?: string }) =>
    createElement("span", { role: accessibilityRole }, children)
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => createElement("div", {}, children),
  useSafeAreaInsets: () => ({ top: 0, left: 0, bottom: 0, right: 0 })
}));
vi.mock("react-native-webview", () => ({ WebView: forwardRef((props: RendererProps, ref) => {
  // Each keyed native renderer owns a distinct imperative handle. React attaches
  // the replacement's ref during commit, before the old passive cleanup runs.
  const [renderer] = useState(() => {
    const value = { props, injectJavaScript: vi.fn() }; native.renderers.push(value); return value;
  });
  renderer.props = props;
  useImperativeHandle(ref, () => renderer, [renderer]);
  return createElement("div", { "data-document": props.source.html });
}) }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function instanceId(renderer: (typeof native.renderers)[number]): string {
  const document = new DOMParser().parseFromString(renderer.props.source.html, "text/html");
  const initial = document.querySelector("script")!.textContent!;
  return (JSON.parse(initial.slice("window.jokoConnectionInitial=".length, -1)) as { instanceId: string }).instanceId;
}
function ready(renderer: (typeof native.renderers)[number]): void {
  renderer.props.onMessage({ nativeEvent: { data: JSON.stringify({ type: "ready", instanceId: instanceId(renderer) }) } });
}

describe("native connection renderer ownership", () => {
  beforeEach(() => { native.renderers.length = 0; });
  it.each(["onError", "onContentProcessDidTerminate", "onRenderProcessGone"] as const)(
    "%s retires only the failed renderer and keeps the replacement bridge usable", async (recovery) => {
      const container = document.createElement("div"); const root = createRoot(container);
      const state = { saved: [], nearby: [], status: "disconnected", connectionMode: "nearby", discoveryState: "idle", busy: false } as unknown as MobileState;
      const client = { state, cancel: vi.fn() } as unknown as MobileClient;
      await act(async () => { root.render(createElement(MobileSharedConnectionScreen, {
        client, state, locale: "en", dark: false, defaultDeviceName: "Test device",
        onThemeChange: async () => undefined, onConnected() {}
      })); });
      const first = native.renderers[0]!;
      await act(async () => { ready(first); });
      expect(first.injectJavaScript).toHaveBeenCalledOnce();
      await act(async () => { first.props[recovery](); });
      expect(native.renderers).toHaveLength(2);
      const replacement = native.renderers[1]!;
      expect(instanceId(replacement)).not.toBe(instanceId(first));
      expect(replacement.injectJavaScript).not.toHaveBeenCalled();
      expect(first.injectJavaScript).toHaveBeenLastCalledWith("window.jokoConnection?.close();true;");
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
      await act(async () => { ready(first); });
      expect(replacement.injectJavaScript).not.toHaveBeenCalled();
      await act(async () => { ready(replacement); });
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(replacement.injectJavaScript).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(`"instanceId":"${instanceId(replacement)}"`));
      await act(async () => { first.props.onMessage({ nativeEvent: { data: JSON.stringify({
        type: "action", instanceId: instanceId(first), id: 1, name: "cancelPairing", args: []
      }) } }); });
      expect(client.cancel).not.toHaveBeenCalled();
      await act(async () => { replacement.props.onMessage({ nativeEvent: { data: JSON.stringify({
        type: "action", instanceId: instanceId(replacement), id: 1, name: "cancelPairing", args: []
      }) } }); });
      expect(client.cancel).toHaveBeenCalledOnce();
      const firstCallCount = first.injectJavaScript.mock.calls.length;
      await act(async () => { root.unmount(); });
      expect(first.injectJavaScript).toHaveBeenCalledTimes(firstCallCount);
      expect(replacement.injectJavaScript).toHaveBeenLastCalledWith("window.jokoConnection?.close();true;");
      expect(replacement.injectJavaScript.mock.calls.filter(([script]) => script === "window.jokoConnection?.close();true;")).toHaveLength(1);
    });
});
