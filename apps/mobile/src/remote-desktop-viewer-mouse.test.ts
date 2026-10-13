// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { remoteDesktopViewerHtml } from "./remote-desktop-viewer";

type Packet = { type: string; epoch: string; sequence: number; events: Record<string, unknown>[] };
const labels = { left: "Hold left mouse button", right: "Hold right mouse button", wheel: "Scroll or middle click" };
const scope = window as unknown as {
  ReactNativeWebView: { postMessage(value: string): void };
  __jokoRemoteDesktop: { receive(value: object): void };
};
let stop: (() => void) | undefined;
afterEach(() => {
  stop?.(); stop = undefined; vi.useRealTimers(); vi.unstubAllGlobals();
  document.documentElement.innerHTML = "<head></head><body></body>";
});

function viewer(nativeControls = false) {
  vi.useFakeTimers();
  let resized!: () => void;
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resized = callback; } observe() {} disconnect() {} });
  const posted: Packet[] = [];
  scope.ReactNativeWebView = { postMessage(value) { posted.push(JSON.parse(value)); } };
  const html = remoteDesktopViewerHtml("#111111", "#eeeeee", nativeControls);
  document.documentElement.innerHTML = html;
  const stage = document.getElementById("stage")!, rail = document.getElementById("mouse-buttons")!;
  Object.defineProperties(stage, { clientWidth: { value: 800 }, clientHeight: { value: 600 } });
  for (const element of [stage, ...Array.from(rail.querySelectorAll("button"))]) {
    Object.assign(element, { setPointerCapture: vi.fn() });
  }
  new Function(html.match(/<script>([\s\S]*?)<\/script>/u)![1]!)();
  const receive = (value: object) => scope.__jokoRemoteDesktop.receive(value);
  receive({ type: "init", epoch: "current-mouse", width: 800, height: 600, webrtc: false, sequenceBase: 100, sequenceLimit: 10_000 });
  receive({ type: "control", enabled: true });
  const config = (enabled: boolean, native = nativeControls) => receive({ type: "mouseButtons", epoch: "current-mouse", enabled, nativeControls: native, labels });
  config(true);
  const packets = () => posted.filter(message => message.type === "input");
  const ack = () => receive({ type: "ack", epoch: "current-mouse", sequence: packets().at(-1)!.sequence });
  const button = (name: "left" | "right" | "wheel") => document.getElementById("mouse-" + name)!;
  const pointer = (element: HTMLElement, type: string, id = 7, x = 400, y = 300) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, { pointerId: { value: id }, clientX: { value: x }, clientY: { value: y } });
    element.dispatchEvent(event);
  };
  const native = (control: "left" | "right" | "wheel", event: string, y = 300, extra: object = {}) => receive({
    type: "nativeMouse", epoch: "current-mouse", control, event, id: 0, y, ...extra
  });
  stop = () => receive({ type: "stop" });
  return { receive, config, packets, posted, ack, button, pointer, native, stage, rail, resized,
    grip: document.getElementById("mouse-wheel-grip")! };
}

describe("actual floating mouse controls viewer", () => {
  it("holds one pointer per button and flushes its matching cancel behind the outstanding ACK", async () => {
    const value = viewer(), left = value.button("left");
    expect(value.rail.style.display).toBe("block");
    expect(left.getAttribute("aria-label")).toBe(labels.left);
    value.pointer(left, "pointerdown"); value.pointer(left, "pointerdown", 8);
    expect(value.packets()).toHaveLength(1);
    expect(value.packets()[0]).toMatchObject({ epoch: "current-mouse", sequence: 101,
      events: [{ kind: "button", button: 0, down: true, x: .5, y: .5 }] });
    value.pointer(left, "pointerup", 8);
    expect(left.getAttribute("aria-pressed")).toBe("true");
    value.pointer(left, "pointercancel");
    expect(left.getAttribute("aria-pressed")).toBe("false");
    await vi.advanceTimersByTimeAsync(165); expect(value.packets()).toHaveLength(1);
    value.ack(); await vi.advanceTimersByTimeAsync(33);
    expect(value.packets()[1]).toMatchObject({ sequence: 102,
      events: [{ kind: "button", button: 0, down: false, x: .5, y: .5 }] });
    value.pointer(left, "lostpointercapture"); value.ack(); await vi.advanceTimersByTimeAsync(33);
    expect(value.packets()).toHaveLength(2);
  });

  it("keeps touch movement while a floating button suppresses stage taps and the 400 ms hold", async () => {
    const value = viewer(); value.pointer(value.button("right"), "pointerdown");
    value.pointer(value.stage, "pointerdown", 12);
    value.receive({ type: "control", enabled: true });
    expect(value.button("right").getAttribute("aria-pressed")).toBe("true");
    await vi.advanceTimersByTimeAsync(450);
    value.pointer(value.stage, "pointerup", 12);
    value.ack(); await vi.advanceTimersByTimeAsync(33);
    expect(value.packets()).toHaveLength(1);
    value.pointer(value.stage, "pointerdown", 13); value.pointer(value.stage, "pointermove", 13, 480, 360);
    await vi.advanceTimersByTimeAsync(33);
    expect(value.packets()[1]).toMatchObject({ events: [{ kind: "move", x: .6, y: .6 }] });
    value.pointer(value.stage, "pointerup", 13, 480, 360);
    value.ack(); await vi.advanceTimersByTimeAsync(33);
    expect(value.packets()).toHaveLength(2);
    value.pointer(value.button("right"), "pointerup");
    expect(value.packets()[2]).toMatchObject({ events: [{ kind: "button", button: 2, down: false, x: .6, y: .6 }] });
  });

  it("uses bounded displacement ticks and skips ACK time without accumulating a scroll backlog", async () => {
    const value = viewer(), wheel = value.button("wheel");
    value.pointer(wheel, "pointerdown", 7, 0, 100); value.pointer(wheel, "pointermove", 7, 0, 104);
    await vi.advanceTimersByTimeAsync(66); expect(value.packets()).toHaveLength(0);
    value.pointer(wheel, "pointermove", 7, 0, 200);
    expect(value.grip.style.transform).toBe("translateY(24px)");
    await vi.advanceTimersByTimeAsync(33);
    expect(value.packets()[0]).toMatchObject({ events: [{ kind: "scroll", dx: 0, dy: 30 }] });
    await vi.advanceTimersByTimeAsync(330); expect(value.packets()).toHaveLength(1);
    value.ack(); await vi.advanceTimersByTimeAsync(33);
    expect(value.packets()[1]).toMatchObject({ events: [{ kind: "scroll", dx: 0, dy: 30 }] });
    value.pointer(wheel, "pointercancel"); value.ack(); await vi.advanceTimersByTimeAsync(66);
    expect(value.packets()).toHaveLength(2); expect(value.grip.style.transform).toBe("translateY(0px)");
    value.pointer(wheel, "pointerdown", 7, 0, 100); value.pointer(wheel, "pointermove", 7, 0, -100);
    await vi.advanceTimersByTimeAsync(33);
    expect(value.packets()[2]).toMatchObject({ events: [{ kind: "scroll", dx: 0, dy: -30 }] });
  });

  it("never turns a moved wheel into a middle click and distinguishes taps from cancel", async () => {
    const value = viewer(), wheel = value.button("wheel");
    value.pointer(wheel, "pointerdown", 7, 0, 100); value.pointer(wheel, "pointermove", 7, 0, 110);
    value.pointer(wheel, "pointermove", 7, 0, 100); value.pointer(wheel, "pointerup", 7, 0, 100);
    await vi.advanceTimersByTimeAsync(33); expect(value.packets()).toHaveLength(0);
    value.pointer(wheel, "pointerdown"); value.pointer(wheel, "pointercancel");
    expect(value.packets()).toHaveLength(0);
    value.pointer(wheel, "pointerdown"); value.pointer(wheel, "pointerup", 8);
    value.pointer(wheel, "pointerup");
    expect(value.packets()[0]).toMatchObject({ events: [{ kind: "button", button: 1, down: true }, { kind: "button", button: 1, down: false }] });
  });

  it("routes accessible clicks and wheel arrow keys once without injecting computer arrow keys", async () => {
    const value = viewer();
    value.button("left").dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    expect(value.packets()[0]).toMatchObject({ events: [{ kind: "button", button: 0, down: true }, { kind: "button", button: 0, down: false }] });
    value.ack();
    value.button("wheel").dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp", code: "ArrowUp" }));
    value.button("wheel").dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "ArrowUp", code: "ArrowUp" }));
    await vi.advanceTimersByTimeAsync(33);
    expect(value.packets()[1]).toMatchObject({ events: [{ kind: "scroll", dx: 0, dy: -120 }] });
    value.ack(); value.button("wheel").dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown", code: "ArrowDown" }));
    await vi.advanceTimersByTimeAsync(33);
    expect(value.packets()[2]).toMatchObject({ events: [{ kind: "scroll", dx: 0, dy: 120 }] });
    value.ack(); value.button("wheel").dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    expect(value.packets()[3]).toMatchObject({ events: [{ kind: "button", button: 1, down: true }, { kind: "button", button: 1, down: false }] });
  });

  it.each(["hide", "blur", "resize", "control"] as const)("clears held buttons and wheel on %s without bypassing input ACK", async reason => {
    const value = viewer(); value.pointer(value.button("left"), "pointerdown");
    value.pointer(value.button("wheel"), "pointerdown", 9, 0, 100); value.pointer(value.button("wheel"), "pointermove", 9, 0, 124);
    if (reason === "hide") value.config(false);
    else if (reason === "blur") window.dispatchEvent(new Event("blur"));
    else if (reason === "resize") value.resized();
    else value.receive({ type: "control", enabled: false });
    expect(value.button("left").getAttribute("aria-pressed")).toBe("false");
    expect(value.grip.style.transform).toBe("translateY(0px)");
    if (reason === "blur" || reason === "resize") expect(value.posted.find(message => message.type === "mouseControlsRetired"))
      .toEqual({ type: "mouseControlsRetired", epoch: "current-mouse" });
    await vi.advanceTimersByTimeAsync(165); expect(value.packets()).toHaveLength(1);
    value.ack(); await vi.advanceTimersByTimeAsync(33);
    expect(value.packets()[1]).toMatchObject({ events: reason === "hide"
      ? [{ kind: "button", button: 0, down: false }] : [{ kind: "release" }] });
    value.ack(); await vi.advanceTimersByTimeAsync(99); expect(value.packets()).toHaveLength(2);
  });

  it("uses the same native mouse math with original epochs and rejects retired or malformed commands", async () => {
    const value = viewer(true);
    expect(value.rail.style.display).toBe("none");
    value.native("left", "pointerdown", 0, { epoch: "retired" });
    value.native("left", "pointerdown", 0, { id: 1 });
    value.native("left", "pointerdown", Number.NaN);
    value.native("left", "pointerdown", 0, { extra: true });
    expect(value.packets()).toHaveLength(0);
    value.native("left", "pointerdown"); value.native("left", "pointerdown");
    value.native("left", "pointercancel"); value.ack(); await vi.advanceTimersByTimeAsync(33);
    expect(value.packets()).toHaveLength(2);
    expect(value.packets()[1]).toMatchObject({ events: [{ kind: "button", button: 0, down: false }] });
    value.ack(); value.native("wheel", "pointerdown", 100); value.native("wheel", "pointermove", 124);
    await vi.advanceTimersByTimeAsync(33);
    expect(value.packets()[2]).toMatchObject({ events: [{ kind: "scroll", dx: 0, dy: 30 }] });
    value.native("wheel", "pointercancel"); value.ack();
    value.receive({ type: "mouseButtons", epoch: "retired", enabled: false, nativeControls: true, labels });
    value.native("right", "click");
    expect(value.packets()[3]).toMatchObject({ events: [{ kind: "button", button: 2, down: true }, { kind: "button", button: 2, down: false }] });
    value.receive({ type: "init", epoch: "replacement", width: 800, height: 600, webrtc: false });
    value.native("left", "pointercancel"); value.native("right", "click");
    expect(value.rail.style.display).toBe("none");
    expect(value.packets().at(-1)?.epoch).not.toBe("replacement");
  });
});
