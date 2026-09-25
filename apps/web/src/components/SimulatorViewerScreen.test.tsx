// @vitest-environment jsdom

import { Blob as NodeBlob } from "node:buffer";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import { fitSimulatorScreenSize, SimulatorViewerScreen } from "./SimulatorViewerScreen.js";
import type { Translator } from "./types.js";

const roots: Root[] = [];
const route = { instanceId: "owned", generation: 2n, leaseId: "lease" } as const;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window.navigator, "clipboard");
  Reflect.deleteProperty(window, "ClipboardItem");
});

it("fits the Simulator viewport within both available width and panel height", () => {
  expect(fitSimulatorScreenSize({ width: 400, height: 800 }, 700, 900)).toEqual({
    width: 450, height: 900
  });
  expect(fitSimulatorScreenSize({ width: 400, height: 800 }, 300, 900)).toEqual({
    width: 300, height: 600
  });
  expect(fitSimulatorScreenSize({ width: 800, height: 400 }, 700, 900)).toEqual({
    width: 700, height: 350
  });
  expect(fitSimulatorScreenSize({ width: 0, height: 800 }, 700, 900)).toBeNull();
});

it("fits the current frame to its owning Inspector viewport and clears the size when hidden", async () => {
  vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:fitted-frame",
    revokeObjectURL: vi.fn() });
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    queueMicrotask(() => callback(0));
    return 1;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const watch = async function* (_sessionId: string, _route: typeof route, signal: AbortSignal) {
    yield { kind: "frame", sequence: 1n, receivedAtMs: Date.now(),
      jpeg: new Uint8Array([0xff, 0xd8, 1, 0xff, 0xd9]), nativeRoute: "inactive" } as const;
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
  };
  const controller = { watchSimulatorFrames: watch,
    getSimulatorViewerControls: async () => ({ viewportWidth: 393, viewportHeight: 852,
      orientation: "PORTRAIT", nativeTouchAvailable: false,
      multiTouchAvailable: false }) } as unknown as AppController;
  const viewport = document.createElement("div");
  viewport.className = "inspector__body";
  const card = document.createElement("article");
  card.className = "simulator-viewer__card";
  const container = document.createElement("div");
  card.append(container);
  viewport.append(card);
  document.body.append(viewport);
  Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 1_000 });
  vi.spyOn(card, "getBoundingClientRect").mockReturnValue({ top: 80 } as DOMRect);
  const root = createRoot(container);
  roots.push(root);
  const render = async (enabled: boolean, controlEnabled = true) => act(async () => root.render(
    <SimulatorViewerScreen controller={controller} sessionId="task" route={route}
      enabled={enabled} controlEnabled={controlEnabled} ownerDocument={document}
      viewportRef={{ current: viewport }}
      onReconcile={async () => undefined}
      t={(key, values) => translate("en", key, values)} />));
  await render(true);
  await vi.waitFor(() => expect(container.textContent).toContain("393×852"));
  const slot = container.querySelector<HTMLElement>(".simulator-viewer__screen")!;
  const fitted = container.querySelector<HTMLElement>(".simulator-viewer__screen-frame")!;
  let slotWidth = 700;
  Object.defineProperty(slot, "clientWidth", { configurable: true, get: () => slotWidth });
  vi.spyOn(slot, "getBoundingClientRect").mockReturnValue({ top: 150 } as DOMRect);
  await act(async () => { window.dispatchEvent(new Event("resize")); await Promise.resolve(); });
  expect(Number.parseFloat(fitted.style.height)).toBeCloseTo(930);
  expect(Number.parseFloat(fitted.style.width)).toBeCloseTo(429.01, 1);
  slotWidth = 250;
  await act(async () => { window.dispatchEvent(new Event("resize")); await Promise.resolve(); });
  expect(Number.parseFloat(fitted.style.width)).toBeCloseTo(250);
  expect(Number.parseFloat(fitted.style.height)).toBeCloseTo(541.98, 1);
  await render(true, false);
  expect(fitted.classList.contains("is-fitted")).toBe(true);
  slotWidth = 300;
  await act(async () => { window.dispatchEvent(new Event("resize")); await Promise.resolve(); });
  expect(Number.parseFloat(fitted.style.width)).toBeCloseTo(300);
  expect(Number.parseFloat(fitted.style.height)).toBeCloseTo(650.38, 1);
  await render(false);
  expect(fitted.style.width).toBe("");
  expect(fitted.style.height).toBe("");
});

it("shows current route telemetry, rotates from a fresh viewport and copies an exact PNG", async () => {
  vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:viewer-frame",
    revokeObjectURL: vi.fn() });
  const png = new NodeBlob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1])],
    { type: "image/png" }) as Blob;
  const fetcher = vi.fn(async () => ({ blob: async () => png }));
  vi.stubGlobal("fetch", fetcher);
  class FakeClipboardItem {
    constructor(readonly data: Record<string, Promise<Blob>>) {}
  }
  Object.defineProperty(window, "ClipboardItem", { configurable: true, value: FakeClipboardItem });
  const clipboardWrite = vi.fn(async (items: FakeClipboardItem[]) => {
    expect(items).toHaveLength(1);
    expect(await items[0]!.data["image/png"]).toBe(png);
  });
  Object.defineProperty(window.navigator, "clipboard", { configurable: true,
    value: { write: clipboardWrite } });
  let orientation: "PORTRAIT" | "LANDSCAPE" = "PORTRAIT";
  const getControls = vi.fn(async () => ({ viewportWidth: orientation === "PORTRAIT" ? 393 : 852,
    viewportHeight: orientation === "PORTRAIT" ? 852 : 393,
    orientation, nativeTouchAvailable: true, multiTouchAvailable: orientation === "LANDSCAPE" }));
  const command = vi.fn(async (_session: string, _id: string, _route: typeof route,
    input: { action: string; orientation?: "PORTRAIT" | "LANDSCAPE" }) => {
    if (input.action === "rotate") orientation = input.orientation!;
    return input.action === "copyScreenshot"
      ? { replayed: false, screenshotBlobId: "exact-image" } : { replayed: false };
  });
  const release = vi.fn();
  const watch = async function* (_sessionId: string, _route: typeof route, signal: AbortSignal) {
    yield { kind: "frame", sequence: 1n, receivedAtMs: 1,
      jpeg: new Uint8Array([0xff, 0xd8, 1, 0xff, 0xd9]), nativeRoute: "inactive" } as const;
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
  };
  const controller = { watchSimulatorFrames: watch, getSimulatorViewerControls: getControls,
    controlSimulatorViewerCommand: command, getArtifactUrl: async () => "blob:artifact",
    releaseArtifactUrl: release } as unknown as AppController;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<SimulatorViewerScreen controller={controller}
    sessionId="task" route={route} enabled ownerDocument={document}
    onReconcile={async () => undefined}
    t={(key, values) => translate("en", key, values)} />));
  expect(container.textContent).toContain("393×852");
  expect(container.textContent).toContain("WDA MJPEG");
  expect(container.textContent).toContain("Native touch");
  expect(container.textContent).toContain("Multi-touch unavailable");
  const button = (label: string): HTMLButtonElement | undefined =>
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(candidate => candidate.textContent === label);
  await act(async () => button("Rotate device")?.click());
  expect(command).toHaveBeenCalledWith("task", expect.any(String), route,
    { action: "rotate", orientation: "LANDSCAPE" }, expect.any(AbortSignal));
  expect(container.textContent).toContain("852×393");
  expect(container.textContent).not.toContain("Multi-touch unavailable");
  await act(async () => button("Copy screenshot")?.click());
  expect(clipboardWrite).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledWith("blob:artifact", expect.anything());
  expect(release).toHaveBeenCalledWith("exact-image");
  expect(container.textContent).toContain("Screenshot copied to clipboard.");
  clipboardWrite.mockRejectedValueOnce(new Error("Clipboard permission denied"));
  await act(async () => button("Copy screenshot")?.click());
  expect(container.textContent).toContain("Could not copy the screenshot to the clipboard.");
  expect(button("Home")?.disabled).toBe(false);
  expect(command.mock.calls.filter(call => call[3].action === "copyScreenshot")).toHaveLength(2);
  Object.defineProperty(document, "hidden", { configurable: true, value: true });
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(container.textContent).not.toContain("852×393");
  expect(container.textContent).toContain("Paused");
});

it("shows actual JPEG frames only for the visible route, revokes old URLs and stops on hide", async () => {
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  const created = vi.fn(() => `blob:viewer-${created.mock.calls.length}`);
  const revoked = vi.fn();
  vi.stubGlobal("URL", { ...URL, createObjectURL: created, revokeObjectURL: revoked });
  let stopped = false;
  const watch = vi.fn(async function* (_sessionId: string, _route: typeof route, signal: AbortSignal) {
    try {
      yield { kind: "connecting", attempt: 0, nativeRoute: "inactive" } as const;
      yield { kind: "frame", sequence: 1n, receivedAtMs: 1,
        jpeg: new Uint8Array([0xff, 0xd8, 1, 0xff, 0xd9]), nativeRoute: "inactive" } as const;
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    } finally { stopped = true; }
  });
  const controller = { watchSimulatorFrames: watch } as unknown as AppController;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const render = async (enabled: boolean) => act(async () => root.render(
    <SimulatorViewerScreen controller={controller} sessionId="task" route={route}
      enabled={enabled} ownerDocument={document}
      onReconcile={async () => undefined}
      t={(key, values) => translate("en", key, values)} />));
  await render(true);
  expect(watch).toHaveBeenCalledWith("task", route, expect.any(AbortSignal),
    expect.objectContaining({ preferNativeH264: false }));
  expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:viewer-1");
  Object.defineProperty(document, "hidden", { configurable: true, value: true });
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(container.querySelector("img")).toBeNull();
  expect(container.textContent).toContain("paused");
  expect(stopped).toBe(true);
  expect(revoked).toHaveBeenCalledWith("blob:viewer-1");
  await render(false);
  expect(watch).toHaveBeenCalledTimes(1);
  vi.unstubAllGlobals();
});

it("keeps MJPEG quality available on fallback and resubscribes the current route", async () => {
  vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:quality",
    revokeObjectURL: vi.fn() });
  const watch = vi.fn(async function* (_task: string, _route: typeof route, signal: AbortSignal,
    _profile: { mjpegFramesPerSecond: number; jpegQuality: number; mjpegScalingPercent: number }) {
    yield { kind: "frame", sequence: 1n, receivedAtMs: 1,
      jpeg: new Uint8Array([0xff, 0xd8, 1, 0xff, 0xd9]), nativeRoute: "inactive" } as const;
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<SimulatorViewerScreen
    controller={{ watchSimulatorFrames: watch } as unknown as AppController}
    sessionId="task" route={route} enabled ownerDocument={document}
    onReconcile={async () => undefined}
    t={(key, values) => translate("en", key, values)} />));
  const quality = container.querySelector<HTMLSelectElement>(".simulator-viewer__quality select")!;
  expect(quality.value).toBe("balanced");
  expect(quality.querySelector('option[value="experimental60"]')).toBeNull();
  expect(watch.mock.calls[0]?.[3]).toMatchObject({ preferNativeH264: false,
    mjpegFramesPerSecond: 10, jpegQuality: 45, mjpegScalingPercent: 70 });
  await act(async () => { quality.value = "high";
    quality.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(watch).toHaveBeenCalledTimes(2);
  expect(watch.mock.calls[1]?.[3]).toMatchObject({ preferNativeH264: false,
    mjpegFramesPerSecond: 20, jpegQuality: 70, mjpegScalingPercent: 100 });
  expect(container.querySelector("img")).not.toBeNull();
});

it("retries a current native fallback only on user action and retains MJPEG on failed recovery", async () => {
  vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:native-fallback",
    revokeObjectURL: vi.fn() });
  vi.stubGlobal("VideoDecoder", class {
    static async isConfigSupported() { return { supported: true }; }
    configure() {}
    decode() {}
    close() {}
  });
  vi.stubGlobal("EncodedVideoChunk", class { constructor(_input: unknown) {} });
  const watch = vi.fn(async function* (_session: string, _route: typeof route, signal: AbortSignal,
    profile: { preferNativeH264: boolean }) {
    expect(profile.preferNativeH264).toBe(true);
    yield { kind: "frame", sequence: 1n, receivedAtMs: Date.now(),
      jpeg: new Uint8Array([0xff, 0xd8, 1, 0xff, 0xd9]),
      nativeRoute: "fallbackUnavailable" } as const;
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<SimulatorViewerScreen
    controller={{ watchSimulatorFrames: watch,
      getSimulatorViewerControls: async () => ({ viewportWidth: 393, viewportHeight: 852,
        orientation: "PORTRAIT", nativeTouchAvailable: false,
        multiTouchAvailable: false }) } as unknown as AppController}
    sessionId="task" route={route} enabled ownerDocument={document}
    onReconcile={async () => undefined}
    t={(key, values) => translate("en", key, values)} />));
  expect(container.textContent).toContain("Native video is unavailable; showing WDA video.");
  expect(container.textContent).not.toContain("Multi-touch unavailable");
  expect(watch).toHaveBeenCalledTimes(1);
  const retry = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => button.textContent === "Retry native video")!;
  await act(async () => retry.click());
  expect(watch).toHaveBeenCalledTimes(2);
  expect(watch.mock.calls.every(call => call[1] === route)).toBe(true);
  expect(container.textContent).toContain("Native video is still unavailable.");
  expect(container.querySelector(".simulator-viewer__screen img")).not.toBeNull();
  Object.defineProperty(document, "hidden", { configurable: true, value: true });
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(container.textContent).not.toContain("Native video is unavailable; showing WDA video.");
  expect(container.textContent).not.toContain("Native video is still unavailable.");
});

it("requires an explicit retry after finite stream loss and does not retain the old picture", async () => {
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:recovered",
    revokeObjectURL: vi.fn() });
  let calls = 0;
  const watch = async function* (_sessionId: string, _route: typeof route, signal: AbortSignal) {
    calls += 1;
    if (calls === 1) { yield { kind: "disconnected", attempt: 3,
      nativeRoute: "inactive" } as const; return; }
    yield { kind: "frame", sequence: 1n, receivedAtMs: 1,
      jpeg: new Uint8Array([0xff, 0xd8, 1, 0xff, 0xd9]), nativeRoute: "inactive" } as const;
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<SimulatorViewerScreen
    controller={{ watchSimulatorFrames: watch } as unknown as AppController}
    sessionId="task" route={route} enabled ownerDocument={document}
    onReconcile={async () => undefined}
    t={(key, values) => translate("en", key, values)} />));
  expect(container.querySelector("img")).toBeNull();
  expect(container.textContent).toContain("disconnected");
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  expect(calls).toBe(2);
  expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:recovered");
});

it("renders current H.264 output to a canvas and falls back to JPEG when decoding is unavailable", async () => {
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
  let output: ((frame: { close(): void }) => void) | undefined;
  class FakeDecoder {
    static async isConfigSupported() { return { supported: true }; }
    constructor(callbacks: { output(frame: { close(): void }): void }) { output = callbacks.output; }
    configure() {}
    decode() { output?.({ close: vi.fn() }); }
    close() {}
  }
  vi.stubGlobal("VideoDecoder", FakeDecoder);
  vi.stubGlobal("EncodedVideoChunk", class { constructor(_input: unknown) {} });
  let called = 0;
  const watch = vi.fn(async function* (_task: string, _route: typeof route, signal: AbortSignal,
    preference: { preferNativeH264: boolean }) {
    called += 1;
    expect(preference.preferNativeH264).toBe(true);
    yield { kind: "h264", sequence: 1n, receivedAtMs: 1,
      h264: new Uint8Array([0, 0, 0, 1, 0x67, 0x4d, 0x40, 0x1f,
        0, 0, 0, 1, 0x68, 1, 0, 0, 0, 1, 0x65, 1]),
      width: 16, height: 12, timestampMicros: 1_000, keyFrame: true,
      format: "annex-b", nativeRoute: "active" } as const;
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<SimulatorViewerScreen
    controller={{ watchSimulatorFrames: watch } as unknown as AppController}
    sessionId="task" route={route} enabled ownerDocument={document}
    onReconcile={async () => undefined}
    t={(key, values) => translate("en", key, values)} />));
  expect(called).toBe(1);
  expect(drawImage).toHaveBeenCalledOnce();
  expect(container.querySelector("canvas")?.width).toBe(16);
  expect(container.querySelector("img")).toBeNull();
  const quality = container.querySelector(".simulator-viewer__quality select") as HTMLSelectElement;
  expect(quality.value).toBe("balanced");
  await act(async () => {
    quality.value = "high";
    quality.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(called).toBe(2);
  expect(watch.mock.calls[1]?.[3]).toMatchObject({ preferNativeH264: true,
    framesPerSecond: 30, scalingPercent: 100, orientation: "PORTRAIT" });
  await act(async () => root.unmount());
  roots.pop();
  expect(container.querySelector("canvas")).toBeNull();
  vi.unstubAllGlobals();
});

it("keeps captured touch begin/move/end on one route and sends IME-safe text separately", async () => {
  vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:interactive",
    revokeObjectURL: vi.fn() });
  const watch = async function* (_sessionId: string, _route: typeof route, signal: AbortSignal) {
    yield { kind: "frame", sequence: 1n, receivedAtMs: 1,
      jpeg: new Uint8Array([0xff, 0xd8, 1, 0xff, 0xd9]), nativeRoute: "inactive" } as const;
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
  };
  const control = vi.fn(async (..._args: Parameters<AppController["controlSimulatorViewerInput"]>) =>
    ({ replayed: false }));
  const live = vi.fn(async (..._args: Parameters<AppController["controlSimulatorViewerTouch"]>) =>
    ({ accepted: true }));
  let releaseProfile: (() => void) | undefined;
  const firstProfile = new Promise<{ readonly applied: boolean }>(resolve => {
    releaseProfile = () => resolve({ applied: true });
  });
  const profile = vi.fn<AppController["setSimulatorViewerInteractionProfile"]>()
    .mockImplementationOnce(() => firstProfile)
    .mockResolvedValue({ applied: true });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<SimulatorViewerScreen
    controller={{ watchSimulatorFrames: watch,
      controlSimulatorViewerInput: control,
      controlSimulatorViewerTouch: live,
      setSimulatorViewerInteractionProfile: profile } as unknown as AppController}
    sessionId="task" route={route} enabled ownerDocument={document}
    onReconcile={async () => undefined}
    t={(key, values) => translate("en", key, values)} />));
  const image = container.querySelector("img")!;
  let captured = false;
  Object.defineProperties(image, {
    setPointerCapture: { configurable: true, value: vi.fn(() => { captured = true; }) },
    hasPointerCapture: { configurable: true, value: vi.fn(() => captured) },
    releasePointerCapture: { configurable: true, value: vi.fn(() => { captured = false; }) },
    getBoundingClientRect: { configurable: true,
      value: () => ({ left: 0, top: 0, width: 200, height: 400 }) }
  });
  await act(async () => {
    dispatchPointer(image, "pointerdown", { pointerId: 1, clientX: 50, clientY: 100,
      button: 0, buttons: 1 });
    dispatchPointer(image, "pointerup", { pointerId: 1, clientX: 52, clientY: 102,
      button: 0, buttons: 0 });
    await Promise.resolve();
  });
  expect(live).toHaveBeenNthCalledWith(1, "task", route, expect.objectContaining({
    phase: "begin", sequence: 0, xRatio: 0.25, yRatio: 0.25 }), expect.any(AbortSignal));
  expect(live).toHaveBeenNthCalledWith(2, "task", route, expect.objectContaining({
    phase: "end", sequence: 1, xRatio: 0.26, yRatio: 0.255 }));
  expect(live.mock.calls[0]?.[2].gestureId).toBe(live.mock.calls[1]?.[2].gestureId);
  expect(control).not.toHaveBeenCalled();

  await act(async () => {
    dispatchPointer(image, "pointerdown", { pointerId: 2, clientX: 20, clientY: 40,
      button: 0, buttons: 1 });
    dispatchPointer(image, "pointermove", { pointerId: 2, clientX: 100, clientY: 200,
      button: 0, buttons: 1 });
    dispatchPointer(image, "pointerup", { pointerId: 2, clientX: 180, clientY: 360,
      button: 0, buttons: 0 });
    await new Promise<void>(resolve => setTimeout(resolve, 12));
  });
  expect(live.mock.calls.slice(2).map(call => call[2])).toMatchObject([
    { phase: "begin", sequence: 0, xRatio: 0.1, yRatio: 0.1 },
    { phase: "move", sequence: 1, xRatio: 0.5, yRatio: 0.5 },
    { phase: "end", sequence: 2, xRatio: 0.9, yRatio: 0.9 }
  ]);
  expect(new Set(live.mock.calls.slice(2).map(call => call[2].gestureId)).size).toBe(1);

  const text = container.querySelector<HTMLInputElement>(".simulator-viewer__keyboard input")!;
  await act(async () => {
    setInputValue(text, "hello");
    text.dispatchEvent(new Event("input", { bubbles: true }));
    text.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    await Promise.resolve();
  });
  expect(control.mock.calls[0]?.[3]).toEqual({ action: "typeText", text: "hello" });
  expect(text.value).toBe("");

  await act(async () => {
    dispatchPointer(image, "pointerdown", { pointerId: 3, clientX: 40, clientY: 80,
      button: 0, buttons: 1 });
    await Promise.resolve();
    dispatchPointer(image, "pointercancel", { pointerId: 3, clientX: 40, clientY: 80,
      button: 0, buttons: 0 });
  });
  expect(live.mock.calls.slice(5).map(call => call[2].phase)).toEqual(["begin", "cancel"]);
  expect(control).toHaveBeenCalledTimes(1);
  await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 275)); });
  expect(profile).toHaveBeenCalledOnce();
  expect(profile.mock.calls[0]?.[3]).toBe(true);
  await act(async () => {
    releaseProfile?.();
    await firstProfile;
    await Promise.resolve();
  });
  expect(profile).toHaveBeenCalledTimes(2);
  expect(profile.mock.calls.map(call => call.slice(0, 2))).toEqual([
    ["task", route], ["task", route]
  ]);
  expect(profile.mock.calls[0]?.[2]).toMatch(/^[0-9a-f-]{36}$/u);
  expect(profile.mock.calls[1]?.[2]).toBe(profile.mock.calls[0]?.[2]);
  expect(profile.mock.calls.map(call => call[3])).toEqual([true, false]);
});

it("releases an active gesture without stopping video or dispatching more touch when Agent control becomes busy", async () => {
  vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:agent-busy",
    revokeObjectURL: vi.fn() });
  const watch = vi.fn(async function* (_sessionId: string, _route: typeof route,
    signal: AbortSignal) {
    yield { kind: "frame", sequence: 1n, receivedAtMs: 1,
      jpeg: new Uint8Array([0xff, 0xd8, 1, 0xff, 0xd9]), nativeRoute: "inactive" } as const;
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  const live = vi.fn(async (..._args: Parameters<AppController["controlSimulatorViewerTouch"]>) =>
    ({ accepted: true }));
  const profile = vi.fn(async (..._args: Parameters<AppController[
    "setSimulatorViewerInteractionProfile"]>) => ({ applied: true }));
  const controller = { watchSimulatorFrames: watch, controlSimulatorViewerTouch: live,
    setSimulatorViewerInteractionProfile: profile } as unknown as AppController;
  const t: Translator = (key, values) =>
    translate("en", key, values);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const render = (controlEnabled: boolean) => root.render(<SimulatorViewerScreen
    controller={controller} sessionId="task" route={route} enabled
    controlEnabled={controlEnabled} ownerDocument={document}
    onReconcile={async () => undefined}
    t={t} />);
  await act(async () => render(true));
  const image = container.querySelector("img")!;
  let captured = false;
  const release = vi.fn(() => { captured = false; });
  Object.defineProperties(image, {
    setPointerCapture: { configurable: true, value: () => { captured = true; } },
    hasPointerCapture: { configurable: true, value: () => captured },
    releasePointerCapture: { configurable: true, value: release },
    getBoundingClientRect: { configurable: true,
      value: () => ({ left: 0, top: 0, width: 200, height: 400 }) }
  });
  await act(async () => {
    dispatchPointer(image, "pointerdown", { pointerId: 1, clientX: 50, clientY: 100,
      button: 0, buttons: 1 });
    await Promise.resolve();
  });
  expect(captured).toBe(true);
  expect(live.mock.calls.map(call => call[2].phase)).toEqual(["begin"]);
  await act(async () => render(false));
  expect(captured).toBe(false);
  expect(release).toHaveBeenCalledOnce();
  expect(live.mock.calls.map(call => call[2].phase)).toEqual(["begin"]);
  expect(watch).toHaveBeenCalledOnce();
  expect(container.querySelector("img")?.getAttribute("aria-disabled")).toBe("true");
  vi.unstubAllGlobals();
});

it("falls back only after a definitely undispatched begin and locks unknown native results", async () => {
  vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:touch-fallback",
    revokeObjectURL: vi.fn() });
  const watch = async function* (_sessionId: string, _route: typeof route, signal: AbortSignal) {
    yield { kind: "frame", sequence: 1n, receivedAtMs: 1,
      jpeg: new Uint8Array([0xff, 0xd8, 1, 0xff, 0xd9]), nativeRoute: "inactive" } as const;
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
  };
  const live = vi.fn().mockResolvedValueOnce({ accepted: false })
    .mockRejectedValueOnce(new Error("Native begin outcome unknown"));
  const control = vi.fn(async (..._args: Parameters<AppController["controlSimulatorViewerInput"]>) =>
    ({ replayed: false }));
  const profile = vi.fn(async (..._args: Parameters<AppController[
    "setSimulatorViewerInteractionProfile"]>) => ({ applied: true }));
  const reconcile = vi.fn(async () => undefined);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<SimulatorViewerScreen
    controller={{ watchSimulatorFrames: watch, controlSimulatorViewerInput: control,
      controlSimulatorViewerTouch: live,
      setSimulatorViewerInteractionProfile: profile } as unknown as AppController}
    sessionId="task" route={route} enabled ownerDocument={document}
    onReconcile={reconcile}
    t={(key, values) => translate("en", key, values)} />));
  const image = container.querySelector("img")!;
  let captured = false;
  Object.defineProperties(image, {
    setPointerCapture: { configurable: true, value: () => { captured = true; } },
    hasPointerCapture: { configurable: true, value: () => captured },
    releasePointerCapture: { configurable: true, value: () => { captured = false; } },
    getBoundingClientRect: { configurable: true,
      value: () => ({ left: 0, top: 0, width: 200, height: 400 }) }
  });
  await act(async () => {
    dispatchPointer(image, "pointerdown", { pointerId: 1, clientX: 50, clientY: 100,
      button: 0, buttons: 1 });
    dispatchPointer(image, "pointerup", { pointerId: 1, clientX: 52, clientY: 102,
      button: 0, buttons: 0 });
    await Promise.resolve();
  });
  expect(control).toHaveBeenCalledOnce();
  expect(control.mock.calls[0]?.[3]).toEqual({ action: "tap", xRatio: 0.26, yRatio: 0.255 });
  await act(async () => {
    dispatchPointer(image, "pointerdown", { pointerId: 2, clientX: 60, clientY: 120,
      button: 0, buttons: 1 });
    dispatchPointer(image, "pointerup", { pointerId: 2, clientX: 62, clientY: 122,
      button: 0, buttons: 0 });
    await Promise.resolve();
  });
  expect(control).toHaveBeenCalledOnce();
  expect(container.querySelector("[role=alert]")?.textContent)
    .toContain("Native begin outcome unknown");
  expect(reconcile).toHaveBeenCalledOnce();
  await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 275)); });
  expect(profile.mock.calls.map(call => call[3])).toEqual([true, false]);
});

it("keeps typed text and locks input after an unconfirmed result until explicit reconciliation", async () => {
  vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:failure",
    revokeObjectURL: vi.fn() });
  const watch = async function* (_sessionId: string, _route: typeof route, signal: AbortSignal) {
    yield { kind: "frame", sequence: 1n, receivedAtMs: 1,
      jpeg: new Uint8Array([0xff, 0xd8, 1, 0xff, 0xd9]), nativeRoute: "inactive" } as const;
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
  };
  const control = vi.fn()
    .mockRejectedValueOnce(new Error("outcome unknown"))
    .mockResolvedValue({ replayed: false });
  const reconcile = vi.fn(async () => undefined);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<SimulatorViewerScreen
    controller={{ watchSimulatorFrames: watch,
      controlSimulatorViewerInput: control } as unknown as AppController}
    sessionId="task" route={route} enabled ownerDocument={document}
    onReconcile={reconcile}
    t={(key, values) => translate("en", key, values)} />));
  const text = container.querySelector<HTMLInputElement>(".simulator-viewer__keyboard input")!;
  await act(async () => {
    setInputValue(text, "keep me");
    text.dispatchEvent(new Event("input", { bubbles: true }));
    text.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
  expect(container.querySelector("[role=alert]")?.textContent).toContain("outcome unknown");
  expect(text.value).toBe("keep me");
  expect(text.disabled).toBe(true);
  expect(reconcile).toHaveBeenCalledOnce();
  const recover = [...container.querySelectorAll("button")]
    .find(button => button.textContent === "Refresh controls")!;
  await act(async () => { recover.click(); await Promise.resolve(); });
  expect(reconcile).toHaveBeenCalledTimes(2);
  expect(text.disabled).toBe(false);
  await act(async () => {
    text.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
  expect(control).toHaveBeenCalledTimes(2);
  expect(text.value).toBe("");
});

function dispatchPointer(target: Element, type: string, input: {
  readonly pointerId: number; readonly clientX: number; readonly clientY: number;
  readonly button: number; readonly buttons: number }): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true,
    clientX: input.clientX, clientY: input.clientY,
    button: input.button, buttons: input.buttons });
  Object.defineProperty(event, "pointerId", { configurable: true, value: input.pointerId });
  Object.defineProperty(event, "isPrimary", { configurable: true, value: true });
  target.dispatchEvent(event);
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
}
