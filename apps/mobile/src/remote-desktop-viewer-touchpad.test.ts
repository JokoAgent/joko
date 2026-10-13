// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { remoteDesktopViewerHtml } from "./remote-desktop-viewer";

type Packet = { type: string; epoch: string; sequence: number; events: Record<string, unknown>[];
  x: number; y: number; width: number; height: number };
const scope = window as unknown as { ReactNativeWebView: { postMessage(value: string): void };
  __jokoRemoteDesktop: { receive(value: object): void } };
let stop: (() => void) | undefined;
afterEach(() => {
  stop?.(); stop = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  document.documentElement.innerHTML = "<head></head><body></body>";
});

function viewer(fitToInsets = false, topInset = 0, bottomInset = 0, desktop = { width: 800, height: 600 }) {
  vi.useFakeTimers(); let resized!: () => void;
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resized = callback; } observe() {} });
  const posted: Packet[] = [];
  const canvas = { drawImage: vi.fn(), clearRect: vi.fn(), setTransform: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(canvas as unknown as CanvasRenderingContext2D);
  scope.ReactNativeWebView = { postMessage(raw) { posted.push(JSON.parse(raw)); } };
  const html = remoteDesktopViewerHtml("#111111", "#eeeeee", true);
  document.documentElement.innerHTML = html;
  const stage = document.getElementById("stage")!;
  let width = 800, height = 600;
  Object.defineProperties(stage, { clientWidth: { get: () => width }, clientHeight: { get: () => height } });
  Object.assign(stage, { setPointerCapture: vi.fn() });
  new Function(html.match(/<script>([\s\S]*?)<\/script>/u)![1]!)();
  const receive = (value: object) => scope.__jokoRemoteDesktop.receive(value);
  receive({ type: "init", epoch: "fold-current", ...desktop, webrtc: false,
    sequenceBase: 100, sequenceLimit: 10_000 });
  const configure = (fit: boolean, top: number, bottom: number, extra: object = {}) => receive({
    type: "viewport", epoch: "fold-current", fitToInsets: fit, topInset: top, bottomInset: bottom, ...extra });
  configure(fitToInsets, topInset, bottomInset);
  receive({ type: "control", enabled: true });
  receive({ type: "mouseButtons", epoch: "fold-current", enabled: false, nativeControls: true,
    labels: { left: "Left", right: "Right", wheel: "Wheel" } });
  const touch = (event: string, id = 1, fields: object = {}) => receive({ type: "nativeTouchpad", epoch: "fold-current", id, event, ...fields });
  const packets = () => posted.filter(value => value.type === "input");
  const ack = () => receive({ type: "ack", epoch: "fold-current", sequence: packets().at(-1)!.sequence });
  const pointer = (type: string, id: number, x: number, y: number) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, { pointerId: { value: id }, clientX: { value: x }, clientY: { value: y } });
    stage.dispatchEvent(event);
  };
  stop = () => receive({ type: "stop" });
  return { receive, configure, touch, posted, packets, ack, pointer, resized, canvas,
    resize: (w: number, h: number) => { width = w; height = h; resized(); },
    image: document.getElementById("image")!, video: document.getElementById("video")!, cursor: document.getElementById("cursor")!,
    background: document.getElementById("bg")!, backgroundCanvas: document.getElementById("bg-canvas") as HTMLCanvasElement };
}

describe("actual Fold relative touchpad and media viewport", () => {
  it("moves against the actual media transform while mouse intent is off and emits one tap", async () => {
    const value = viewer(); value.touch("start"); value.touch("move", 1, { dx: 80, dy: 60 });
    await vi.advanceTimersByTimeAsync(33);
    expect(value.packets()[0]).toMatchObject({ sequence: 101, events: [{ kind: "move", x: .6, y: .6 }] });
    expect(value.cursor.style.display).toBe("block"); value.touch("end", 1, { tap: true });
    expect(value.packets()).toHaveLength(1); value.ack(); await vi.advanceTimersByTimeAsync(33);
    expect(value.packets()[1]).toMatchObject({ sequence: 102, events: [
      { kind: "button", button: 0, down: true, x: .6, y: .6 }, { kind: "button", button: 0, down: false, x: .6, y: .6 } ] });
    value.touch("end", 1, { tap: true }); value.ack(); await vi.advanceTimersByTimeAsync(33);
    expect(value.packets()).toHaveLength(2);
  });

  it("rejects malformed, stale and wrong-gesture commands without replacing a current gesture", async () => {
    const value = viewer();
    value.touch("start", 1, { epoch: "old" }); value.touch("start", 0); value.touch("start", 1, { extra: true });
    value.touch("move", 1, { dx: 80, dy: 60 }); value.touch("end", 1, { tap: true });
    value.touch("start"); value.touch("start", 2);
    value.touch("move", 2, { dx: 80, dy: 60 }); value.touch("cancel", 2);
    value.touch("move", 1, { dx: Number.NaN, dy: 60 }); value.touch("move", 1, { dx: 80, dy: 60, extra: true });
    await vi.advanceTimersByTimeAsync(33); expect(value.packets()).toHaveLength(0);
    value.touch("end", 1, { tap: "true" }); value.touch("move", 1, { dx: 80, dy: 60 });
    await vi.advanceTimersByTimeAsync(33); expect(value.packets()[0]).toMatchObject({ events: [{ kind: "move", x: .6, y: .6 }] });
  });

  it("moves a held floating button without adding a tap and releases cancellation behind its outstanding ACK", async () => {
    const value = viewer();
    value.receive({ type: "mouseButtons", epoch: "fold-current", enabled: true, nativeControls: true,
      labels: { left: "Left", right: "Right", wheel: "Wheel" } });
    value.receive({ type: "nativeMouse", epoch: "fold-current", control: "left", event: "pointerdown", id: 0, y: 0 });
    value.touch("start"); value.touch("move", 1, { dx: 80, dy: 60 }); value.touch("end", 1, { tap: true });
    value.ack(); await vi.advanceTimersByTimeAsync(33);
    expect(value.packets()[1]).toMatchObject({ events: [{ kind: "move", x: .6, y: .6 }] });
    value.touch("start", 2); value.touch("cancel", 2); await vi.advanceTimersByTimeAsync(66);
    expect(value.packets()).toHaveLength(2); value.ack(); await vi.advanceTimersByTimeAsync(33);
    expect(value.packets()[2]).toMatchObject({ events: [{ kind: "release" }] });
  });

  it.each(["blur", "resize", "layout", "control", "mode", "stop"] as const)(
    "retires actual gestures on %s and cannot let a late end click a new one", async boundary => {
      const value = viewer(); value.touch("start");
      if (boundary === "blur") window.dispatchEvent(new Event("blur"));
      if (boundary === "resize") value.resized();
      if (boundary === "layout") value.configure(true, 100, 200);
      if (boundary === "control") { value.receive({ type: "control", enabled: false }); value.receive({ type: "control", enabled: true }); }
      if (boundary === "mode") value.receive({ type: "mode", mode: "trackpad" });
      if (boundary === "stop") value.receive({ type: "stop" });
      value.touch("end", 1, { tap: true });
      expect(value.packets().flatMap(packet => packet.events).some(event => event.kind === "button")).toBe(false);
      if (boundary !== "stop") {
        value.ack(); value.touch("start", 2); value.touch("end", 1, { tap: true }); value.touch("move", 2, { dx: 20, dy: 0 });
        await vi.advanceTimersByTimeAsync(33);
        expect(value.packets().at(-1)!.events).toEqual([expect.objectContaining({ kind: "move" })]);
      }
    });

  it("fits horizontal shared canvas to the top media pane and uses the same native, JPEG, cursor and input rectangle", async () => {
    const value = viewer(true, 120, 180);
    expect(value.posted.filter(packet => packet.type === "nativeViewport").at(-1)).toMatchObject({ x: 200, y: 120, width: 400, height: 300 });
    for (const media of [value.image, value.video]) expect(media.style).toMatchObject({ width: "400px", height: "300px", left: "200px", top: "120px" });
    value.pointer("pointerdown", 9, 400, 270); value.pointer("pointerup", 9, 400, 270);
    expect(value.packets()[0]).toMatchObject({ events: [{ kind: "button", down: true, x: .5, y: .5 }, { kind: "button", down: false, x: .5, y: .5 }] });
    value.ack(); value.touch("start"); value.touch("move", 1, { dx: 80, dy: 30 });
    await vi.advanceTimersByTimeAsync(33); expect(value.packets()[1]).toMatchObject({ events: [{ kind: "move", x: .7, y: .6 }] });
    expect(value.cursor.style.left).toBe("480px"); expect(value.cursor.style.top).toBe("300px");
  });

  it("projects changed stage dimensions and restores the full media rect when local keyboard insets close", () => {
    const value = viewer(true, 80, 320); value.resize(1000, 800);
    const viewport = value.posted.filter(packet => packet.type === "nativeViewport").at(-1)!;
    expect(viewport).toMatchObject({ y: 80, height: 400 });
    expect(viewport.x).toBeCloseTo(233.33333333333331); expect(viewport.width).toBeCloseTo(533.3333333333334);
    value.configure(false, 0, 0);
    expect(value.posted.filter(packet => packet.type === "nativeViewport").at(-1)).toMatchObject({ x: 0, y: 25, width: 1000, height: 750 });
    const count = value.posted.length;
    value.configure(true, -1, 0); value.configure(true, Number.NaN, 0); value.configure(true, 10, 0, { extra: true });
    value.configure(true, 10, 0, { epoch: "old" });
    expect(value.posted).toHaveLength(count);
  });

  it("keeps the zoomed cursor inside the visible pane without treating lower-pane movement as absolute coordinates", async () => {
    const value = viewer();
    value.pointer("pointerdown", 1, 300, 300); value.pointer("pointerdown", 2, 500, 300);
    value.pointer("pointermove", 2, 900, 300); await vi.advanceTimersByTimeAsync(17);
    value.pointer("pointerup", 1, 300, 300); value.pointer("pointerup", 2, 900, 300);
    value.touch("start"); value.touch("move", 1, { dx: 2000, dy: 0 });
    await vi.advanceTimersByTimeAsync(33);
    expect(value.packets().at(-1)!.events).toEqual([expect.objectContaining({ kind: "move", x: 1, y: .5 })]);
    expect(Number.parseFloat(value.cursor.style.left)).toBe(783);
    expect(value.posted.filter(packet => packet.type === "nativeViewport").at(-1)!.width).toBe(2400);
  });

  it("draws actual JPEG source fractions against the full canvas while only the picture consumes insets, and retires it for native video", async () => {
    const value = viewer(true, 80, 320, { width: 1600, height: 900 });
    Object.defineProperties(value.image, { naturalWidth: { value: 1600 }, naturalHeight: { value: 900 }, complete: { value: true } });
    value.receive({ type: "frame", epoch: "fold-current", frameId: "jpeg-1", jpeg: "AA==" });
    value.image.dispatchEvent(new Event("load")); await vi.advanceTimersByTimeAsync(17);
    expect(value.background.style.display).toBe("block");
    expect(value.backgroundCanvas.width).toBe(800); expect(value.backgroundCanvas.height).toBe(600);
    expect(value.canvas.drawImage).toHaveBeenCalledTimes(3);
    const draws = value.canvas.drawImage.mock.calls;
    expect(draws[0]).toEqual([value.image, 0, 0, 1600, 45, 0, 0, 800, 97.5]);
    expect(draws[1]![0]).toBe(value.image); expect(draws[1]!.slice(1, 4)).toEqual([0, 45, 1600]);
    expect(draws[1]![4]).toBeCloseTo(810); expect(draws[1]!.slice(5)).toEqual([0, 97.5, 800, 405]);
    expect(draws[2]![2]).toBe(855); expect(draws[2]![4]).toBeCloseTo(45);
    const actual = value.posted.filter(packet => packet.type === "nativeViewport").at(-1)!;
    expect(actual.y).toBe(80); expect(actual.height).toBe(200); expect(actual.width).toBeCloseTo(1600 * 200 / 900);
    const attemptId = "123e4567-e89b-42d3-a456-426614174000";
    value.receive({ type: "nativeAttempt", epoch: "fold-current", attemptId });
    value.receive({ type: "nativeVideo", epoch: "fold-current", attemptId });
    expect(value.background.style.display).toBe("none"); expect(value.image.style.visibility).toBe("hidden");
    value.receive({ type: "fallback", epoch: "fold-current", attemptId, capturePending: false, retry: true });
    expect(value.background.style.display).toBe("block"); expect(value.image.style.visibility).toBe("visible");
    value.configure(false, 0, 0); expect(value.background.style.display).toBe("block");
    const count = value.canvas.drawImage.mock.calls.length; await vi.advanceTimersByTimeAsync(34);
    expect(value.canvas.drawImage).toHaveBeenCalledTimes(count + 3);
    value.receive({ type: "stop" }); expect(value.background.style.display).toBe("none");
  });
});
