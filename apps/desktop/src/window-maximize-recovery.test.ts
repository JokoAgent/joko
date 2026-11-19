import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installWindowsMainWindowMaximizeRecovery } from "./window-maximize-recovery.js";

class NativeWindowFixture extends EventEmitter {
  readonly webContents = new EventEmitter();
  readonly hooks = new Map<number, (parameter: Buffer) => void>();
  visible = true;
  minimized = false;
  fullscreen = false;
  destroyed = false;
  maximized = true;

  isVisible = () => this.visible;
  isMinimized = () => this.minimized;
  isFullScreen = () => this.fullscreen;
  isDestroyed = () => this.destroyed;
  isMaximized = () => this.maximized;
  maximize = vi.fn(() => {
    this.maximized = true;
    this.emit("maximize");
  });

  unmaximize(): void {
    this.maximized = false;
    this.emit("unmaximize");
  }

  hookWindowMessage(message: number, listener: (parameter: Buffer) => void): void {
    this.hooks.set(message, listener);
  }

  sendWindowMessage(message: number, value: number): void {
    const parameter = Buffer.alloc(8);
    parameter.writeUInt32LE(value);
    this.hooks.get(message)?.(parameter);
  }
}

function fixture() {
  const window = new NativeWindowFixture();
  const screen = new EventEmitter();
  type Inputs = Parameters<typeof installWindowsMainWindowMaximizeRecovery>;
  const requestRestore = installWindowsMainWindowMaximizeRecovery(window as unknown as Inputs[0], screen as unknown as Inputs[1]);
  return { window, screen, requestRestore };
}

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] }));
afterEach(() => vi.useRealTimers());

it("recovers a late OS restore once the display reconfiguration settles", () => {
  const { window, screen } = fixture();
  screen.emit("display-metrics-changed");
  vi.advanceTimersByTime(650);
  expect(window.maximize).not.toHaveBeenCalled();
  window.unmaximize();
  vi.advanceTimersByTime(250);
  screen.emit("display-removed");
  vi.advanceTimersByTime(299);
  expect(window.maximize).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(window.maximize).toHaveBeenCalledExactlyOnceWith();
  expect(window.isMaximized()).toBe(true);
});

it("recovers the same OS occurrence if the display notification arrives just after the restore", () => {
  const { window, screen } = fixture();
  window.unmaximize();
  vi.advanceTimersByTime(650);
  expect(window.maximize).not.toHaveBeenCalled();
  screen.emit("display-metrics-changed");
  vi.advanceTimersByTime(300);
  expect(window.maximize).toHaveBeenCalledTimes(1);
});

it.each(["window control", "system restore", "title bar", "Win+Down", "manual drag"])("honors the %s during a display change", (gesture) => {
  const { window, screen, requestRestore } = fixture();
  screen.emit("display-metrics-changed");
  if (gesture === "window control") requestRestore();
  if (gesture === "system restore") window.sendWindowMessage(0x0112, 0xf123);
  if (gesture === "title bar") window.sendWindowMessage(0x00a3, 2);
  if (gesture === "Win+Down") window.webContents.emit("before-input-event", {},
    { type: "keyDown", key: "ArrowDown", meta: true, isAutoRepeat: false, modifiers: [] });
  window.unmaximize();
  if (gesture === "manual drag") window.emit("will-move");
  screen.emit("display-added");
  vi.advanceTimersByTime(2_400);
  expect(window.maximize).not.toHaveBeenCalled();
  expect(window.isMaximized()).toBe(false);
});

it("keeps ordinary restored windows, non-visible windows and retired windows out of recovery", () => {
  const { window, screen } = fixture();
  window.unmaximize();
  vi.advanceTimersByTime(2_001);
  screen.emit("display-metrics-changed");
  vi.advanceTimersByTime(300);
  expect(window.maximize).not.toHaveBeenCalled();
  for (const [event, property, value] of [["hide", "visible", false], ["minimize", "minimized", true],
    ["enter-full-screen", "fullscreen", true], ["closed", "destroyed", true]] as const) {
    window.maximized = true;
    window.emit("maximize");
    screen.emit("display-metrics-changed");
    window.unmaximize();
    window[property] = value;
    window.emit(event);
    window[property] = !value;
    vi.advanceTimersByTime(300);
    expect(window.maximize).not.toHaveBeenCalled();
  }
  expect(screen.eventNames()).toEqual([]);
});
