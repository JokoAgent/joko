// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { remoteDesktopViewerHtml } from "./remote-desktop-viewer";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); document.documentElement.innerHTML = "<head></head><body></body>"; });
it("keeps release and replacement key presses ordered behind the outstanding HTTP input ACK", async () => {
  vi.useFakeTimers(); vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const posted: { type: string; sequence: number; events: object[] }[] = [];
  const scope = window as unknown as { ReactNativeWebView: { postMessage(value: string): void }; __jokoRemoteDesktop: { receive(value: object): void } };
  scope.ReactNativeWebView = { postMessage(value) { posted.push(JSON.parse(value)); } };
  const html = remoteDesktopViewerHtml("#111111", "#eeeeee"); document.documentElement.innerHTML = html;
  new Function(html.match(/<script>([\s\S]*?)<\/script>/u)![1]!)();
  scope.__jokoRemoteDesktop.receive({ type: "init", epoch: "input-owner", width: 1200, height: 800, webrtc: false });
  scope.__jokoRemoteDesktop.receive({ type: "control", enabled: true });
  scope.__jokoRemoteDesktop.receive({ type: "events", events: [{ kind: "key", code: "ControlLeft", down: true }, { kind: "key", code: "KeyA", down: true }] });
  const packets = () => posted.filter(message => message.type === "input"); expect(packets()).toHaveLength(1);
  scope.__jokoRemoteDesktop.receive({ type: "releaseInput" });
  scope.__jokoRemoteDesktop.receive({ type: "events", events: [{ kind: "key", code: "KeyB", down: true }] });
  await vi.advanceTimersByTimeAsync(200); expect(packets()).toHaveLength(1);
  scope.__jokoRemoteDesktop.receive({ type: "ack", epoch: "input-owner", sequence: 1 });
  await vi.advanceTimersByTimeAsync(33);
  expect(packets()).toHaveLength(2); expect(packets()[1]).toMatchObject({ sequence: 2,
    events: [{ kind: "release" }, { kind: "key", code: "KeyB", down: true }] });
  scope.__jokoRemoteDesktop.receive({ type: "ack", epoch: "input-owner", sequence: 2 });
  scope.__jokoRemoteDesktop.receive({ type: "events", events: [{ kind: "key", code: "KeyB", down: false }] });
  expect(packets()[2]).toMatchObject({ sequence: 3, events: [{ kind: "key", code: "KeyB", down: false }] });
  scope.__jokoRemoteDesktop.receive({ type: "stop" });
});
