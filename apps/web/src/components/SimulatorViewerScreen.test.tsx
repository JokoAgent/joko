// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import { SimulatorViewerScreen } from "./SimulatorViewerScreen.js";

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
});

it("shows actual JPEG frames only for the visible route, revokes old URLs and stops on hide", async () => {
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  const created = vi.fn(() => `blob:viewer-${created.mock.calls.length}`);
  const revoked = vi.fn();
  vi.stubGlobal("URL", { ...URL, createObjectURL: created, revokeObjectURL: revoked });
  let stopped = false;
  const watch = vi.fn(async function* (_sessionId: string, _route: typeof route, signal: AbortSignal) {
    try {
      yield { kind: "connecting", attempt: 0 } as const;
      yield { kind: "frame", sequence: 1n, receivedAtMs: 1,
        jpeg: new Uint8Array([0xff, 0xd8, 1, 0xff, 0xd9]) } as const;
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

it("requires an explicit retry after finite stream loss and does not retain the old picture", async () => {
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:recovered",
    revokeObjectURL: vi.fn() });
  let calls = 0;
  const watch = async function* (_sessionId: string, _route: typeof route, signal: AbortSignal) {
    calls += 1;
    if (calls === 1) { yield { kind: "disconnected", attempt: 3 } as const; return; }
    yield { kind: "frame", sequence: 1n, receivedAtMs: 1,
      jpeg: new Uint8Array([0xff, 0xd8, 1, 0xff, 0xd9]) } as const;
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<SimulatorViewerScreen
    controller={{ watchSimulatorFrames: watch } as unknown as AppController}
    sessionId="task" route={route} enabled ownerDocument={document}
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
      format: "annex-b" } as const;
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<SimulatorViewerScreen
    controller={{ watchSimulatorFrames: watch } as unknown as AppController}
    sessionId="task" route={route} enabled ownerDocument={document}
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
