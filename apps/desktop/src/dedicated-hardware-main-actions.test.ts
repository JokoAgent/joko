import { describe, expect, it, vi } from "vitest";

import { DedicatedHardwareActionRouter } from "./dedicated-hardware-action/router.js";
import { createDedicatedHardwareMainActionRuntime } from "./dedicated-hardware-main-actions.js";

function harness() {
  const sent: Array<{ window: string; event: unknown }> = [];
  const systemVoice = { handle: vi.fn(() => true), cancel: vi.fn() };
  const systemInput = { handle: vi.fn(() => true), cancel: vi.fn() };
  let focused: string | null = "main";
  let windowDeliveryAllowed = true;
  let now = 0;
  const router = new DedicatedHardwareActionRouter<string>({
    getFocusedWindow: () => focused,
    getPrimaryWindow: () => "main",
    isJokoActionWindow: (window) => window === "main" || window === "task",
    isWindowReady: () => true,
    getSystemFrontmostCapabilities: () => ({ voice: "available", return: "available", scroll: "available" })
  }, { now: () => now });
  const runtime = createDedicatedHardwareMainActionRuntime({
    router,
    sendWindow: (window, event) => { sent.push({ window, event }); return windowDeliveryAllowed; },
    systemInput: systemInput as never,
    systemVoice
  });
  return {
    runtime,
    sent,
    systemVoice,
    systemInput,
    setFocused: (value: string | null) => { focused = value; },
    setWindowDeliveryAllowed: (value: boolean) => { windowDeliveryAllowed = value; },
    time: (value: number) => { now = value; }
  };
}

describe("dedicated hardware main action runtime", () => {
  it("keeps a window voice hold on its press owner", () => {
    const owner = harness();
    expect(owner.runtime.handle("codex-micro", { kind: "button", phase: "press", action: { kind: "voice" } })).toBe(true);
    owner.setFocused("task");
    expect(owner.runtime.handle("codex-micro", { kind: "button", phase: "release", action: { kind: "voice" } })).toBe(true);
    expect(owner.sent.map((item) => item.window)).toEqual(["main", "main"]);
  });

  it("rejects a second device from completing another device's held gesture", () => {
    const owner = harness();
    expect(owner.runtime.handle("codex-micro", { kind: "scroll", phase: "press", direction: "down", distance: 0.8 })).toBe(true);
    expect(owner.runtime.handle("creator-micro-2", { kind: "scroll", phase: "release" })).toBe(false);
    expect(owner.runtime.handle("codex-micro", { kind: "scroll", phase: "release" })).toBe(true);
    expect(owner.sent).toHaveLength(2);
  });

  it("keeps the physical model and original window through a short-tap voice toggle", () => {
    const owner = harness();
    expect(owner.runtime.handle("codex-micro", { kind: "button", phase: "press", action: { kind: "voice" } })).toBe(true);
    owner.time(100);
    expect(owner.runtime.handle("codex-micro", { kind: "button", phase: "release", action: { kind: "voice" } })).toBe(true);
    owner.setFocused("task");
    owner.time(200);
    expect(owner.runtime.handle("creator-micro-2", { kind: "button", phase: "press", action: { kind: "voice" } })).toBe(false);
    expect(owner.runtime.handle("codex-micro", { kind: "button", phase: "press", action: { kind: "voice" } })).toBe(true);
    owner.time(220);
    expect(owner.runtime.handle("codex-micro", { kind: "button", phase: "release", action: { kind: "voice" } })).toBe(true);
    expect(owner.sent.map((item) => item.window)).toEqual(["main", "main", "main", "main"]);
  });

  it("releases the physical voice owner when a toggle-finish press cannot be delivered", () => {
    const owner = harness();
    expect(owner.runtime.handle("codex-micro", {
      kind: "button", phase: "press", action: { kind: "voice" }
    })).toBe(true);
    owner.time(100);
    expect(owner.runtime.handle("codex-micro", {
      kind: "button", phase: "release", action: { kind: "voice" }
    })).toBe(true);

    owner.setWindowDeliveryAllowed(false);
    owner.time(200);
    expect(owner.runtime.handle("codex-micro", {
      kind: "button", phase: "press", action: { kind: "voice" }
    })).toBe(false);

    owner.setWindowDeliveryAllowed(true);
    expect(owner.runtime.handle("creator-micro-2", {
      kind: "button", phase: "press", action: { kind: "voice" }
    })).toBe(true);
  });

  it("uses only the bounded system adapters while another application is focused", () => {
    const owner = harness();
    owner.setFocused(null);
    expect(owner.runtime.handle("codex-micro", { kind: "button", phase: "press", action: { kind: "command", command: "submit" } })).toBe(true);
    expect(owner.systemInput.handle).toHaveBeenCalledTimes(1);
    expect(owner.runtime.handle("codex-micro", { kind: "button", phase: "press", action: { kind: "fixed-link", linkId: "documentation" } })).toBe(false);
    expect(owner.sent).toHaveLength(0);
  });

  it("sends exact cancellation to a retired sticky window", () => {
    const owner = harness();
    expect(owner.runtime.handle("codex-micro", { kind: "button", phase: "press", action: { kind: "voice" } })).toBe(true);
    owner.runtime.retireWindow("main");
    expect(owner.sent.at(-1)).toEqual({
      window: "main",
      event: {
        kind: "button", phase: "cancel", action: { kind: "voice" },
        activationId: "1", ownerActivationId: "1", activationKind: "start", releaseKind: "cancel"
      }
    });
  });

  it("delivers the router's single voice release classification to the system owner", () => {
    const owner = harness();
    owner.setFocused(null);
    expect(owner.runtime.handle("codex-micro", {
      kind: "button", phase: "press", action: { kind: "voice" }
    })).toBe(true);
    owner.time(450);
    expect(owner.runtime.handle("codex-micro", {
      kind: "button", phase: "release", action: { kind: "voice" }
    })).toBe(true);
    expect(owner.systemVoice.handle).toHaveBeenNthCalledWith(1, expect.objectContaining({
      activationId: "1", ownerActivationId: "1", activationKind: "start", releaseKind: null
    }));
    expect(owner.systemVoice.handle).toHaveBeenNthCalledWith(2, expect.objectContaining({
      activationId: "1", ownerActivationId: "1", activationKind: "start", releaseKind: "hold"
    }));
  });
});
