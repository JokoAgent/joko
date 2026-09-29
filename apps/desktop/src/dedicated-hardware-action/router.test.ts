import { describe, expect, it } from "vitest";

import type { DedicatedHardwareAction, DedicatedHardwareActionEvent } from "./actions.js";
import {
  DedicatedHardwareActionRouter,
  type DedicatedHardwareSystemFrontmostCapabilities
} from "./router.js";

interface FakeWindow {
  readonly id: string;
  trusted: boolean;
  ready: boolean;
}

function button(
  action: DedicatedHardwareAction,
  phase: "press" | "release" | "cancel" = "press"
): DedicatedHardwareActionEvent {
  return { kind: "button", phase, action };
}

function scroll(
  phase: "press" | "move",
  direction: "up" | "down" = "down",
  distance = 0.8
): DedicatedHardwareActionEvent {
  return { kind: "scroll", phase, direction, distance };
}

function createHarness() {
  const primary: FakeWindow = { id: "primary", trusted: true, ready: true };
  const task: FakeWindow = { id: "task", trusted: true, ready: true };
  const utility: FakeWindow = { id: "utility", trusted: false, ready: true };
  let focused: FakeWindow | null = task;
  let now = 0;
  let capabilities: DedicatedHardwareSystemFrontmostCapabilities = {
    voice: "available",
    return: "available",
    scroll: "available"
  };
  const router = new DedicatedHardwareActionRouter<FakeWindow>({
    getFocusedWindow: () => focused,
    getPrimaryWindow: () => primary,
    isJokoActionWindow: (window) => window.trusted,
    isWindowReady: (window) => window.ready,
    getSystemFrontmostCapabilities: () => capabilities
  }, { now: () => now });
  return {
    primary,
    task,
    utility,
    router,
    time: (value: number) => { now = value; },
    focus: (window: FakeWindow | null) => { focused = window; },
    capabilities: (next: DedicatedHardwareSystemFrontmostCapabilities) => { capabilities = next; }
  };
}

describe("dedicated hardware action router", () => {
  it("keeps direct and sequential task switching on the exact primary window", () => {
    const harness = createHarness();
    expect(harness.router.route(button({
      kind: "task",
      profileId: "profile",
      serverId: "server",
      connectionGeneration: "1",
      snapshotRevision: "2",
      sessionId: "session",
      sessionGeneration: "3",
      targetId: "target",
      focusWindow: true
    }))).toMatchObject({ kind: "route", target: { kind: "window", window: harness.primary } });
    expect(harness.router.route(button({ kind: "command", command: "next-task" })))
      .toMatchObject({ kind: "route", target: { kind: "window", window: harness.primary } });

    harness.primary.ready = false;
    expect(harness.router.route(button({ kind: "command", command: "previous-task" })))
      .toMatchObject({ kind: "drop", reason: "primary-window-unavailable" });
  });

  it("routes renderer actions only to the exact focused trusted ready window", () => {
    const harness = createHarness();
    expect(harness.router.route(button({ kind: "command", command: "open-settings" })))
      .toMatchObject({ kind: "route", target: { kind: "window", window: harness.task } });
    expect(harness.router.route(button({
      kind: "skill",
      serverId: "server",
      resourceId: "skill",
      name: "Review"
    }))).toMatchObject({ kind: "route", target: { kind: "window", window: harness.task } });

    harness.focus(harness.utility);
    expect(harness.router.route(button({ kind: "composer-text", text: "review this" })))
      .toMatchObject({ kind: "drop", reason: "focused-window-unavailable" });
    expect(harness.router.route(button({ kind: "fixed-link", linkId: "documentation" })))
      .toMatchObject({ kind: "drop", reason: "focused-window-unavailable" });
    expect(harness.router.route(button({ kind: "command", command: "submit" })))
      .toMatchObject({ kind: "drop", reason: "focused-window-unavailable" });
    expect(harness.router.route(button({ kind: "voice" })))
      .toMatchObject({ kind: "drop", reason: "focused-window-unavailable" });
    harness.task.ready = false;
    harness.focus(harness.task);
    expect(harness.router.route(button({ kind: "command", command: "submit" })))
      .toMatchObject({ kind: "drop", reason: "focused-window-unavailable" });
  });

  it("allows only voice, Return, and continuous scroll outside Joko", () => {
    const harness = createHarness();
    harness.focus(null);

    expect(harness.router.route(button({ kind: "command", command: "submit" })))
      .toMatchObject({ kind: "route", target: { kind: "system-frontmost", capability: "return" } });
    expect(harness.router.route(button({ kind: "voice" })))
      .toMatchObject({ kind: "route", target: { kind: "system-frontmost", capability: "voice" } });
    expect(harness.router.route(button({ kind: "voice" }, "release")))
      .toMatchObject({ kind: "route", target: { kind: "system-frontmost", capability: "voice" } });
    expect(harness.router.route(scroll("press")))
      .toMatchObject({ kind: "route", target: { kind: "system-frontmost", capability: "scroll" } });
    expect(harness.router.route({ kind: "scroll", phase: "release" }))
      .toMatchObject({ kind: "route", target: { kind: "system-frontmost", capability: "scroll" } });

    for (const action of [
      { kind: "command", command: "open-settings" },
      { kind: "command", command: "feedback" },
      { kind: "composer-text", text: "never inject this" },
      { kind: "fixed-link", linkId: "product-feedback" },
      { kind: "skill", serverId: "server", resourceId: "skill", name: "Skill" }
    ] as const) {
      expect(harness.router.route(button(action))).toMatchObject({ kind: "drop" });
    }
    expect(harness.router.route(button({
      kind: "task",
      profileId: "profile",
      serverId: "server",
      connectionGeneration: "1",
      snapshotRevision: "2",
      sessionId: "session",
      sessionGeneration: "3",
      targetId: "target",
      focusWindow: true
    }))).toMatchObject({ kind: "drop", reason: "focused-window-unavailable" });
    expect(harness.router.route(button({ kind: "command", command: "next-task" })))
      .toMatchObject({ kind: "drop", reason: "focused-window-unavailable" });
  });

  it("fails closed when the system adapter is unsupported, denied, or unknown", () => {
    const harness = createHarness();
    harness.focus(null);
    harness.capabilities({
      voice: "permission-denied",
      return: "unsupported",
      scroll: "unknown"
    });
    expect(harness.router.route(button({ kind: "voice" })))
      .toMatchObject({ kind: "drop", reason: "system-capability-unavailable" });
    expect(harness.router.route(button({ kind: "command", command: "submit" })))
      .toMatchObject({ kind: "drop", reason: "system-capability-unavailable" });
    expect(harness.router.route(scroll("press")))
      .toMatchObject({ kind: "drop", reason: "system-capability-unavailable" });
  });

  it("keeps voice and scroll on independent exact windows across focus changes", () => {
    const harness = createHarness();
    expect(harness.router.route(button({ kind: "voice" })))
      .toMatchObject({ target: { kind: "window", window: harness.task } });
    harness.focus(harness.primary);
    expect(harness.router.route(scroll("press")))
      .toMatchObject({ target: { kind: "window", window: harness.primary } });
    expect(harness.router.route(scroll("move", "up", 1)))
      .toMatchObject({ target: { kind: "window", window: harness.primary } });
    expect(harness.router.route(button({ kind: "voice" }, "release")))
      .toMatchObject({ target: { kind: "window", window: harness.task } });
    expect(harness.router.route({ kind: "scroll", phase: "cancel" }))
      .toMatchObject({ target: { kind: "window", window: harness.primary } });
  });

  it("retains a short-tap voice owner and routes the toggle press back after focus changes", () => {
    const harness = createHarness();
    expect(harness.router.route(button({ kind: "voice" })))
      .toMatchObject({
        target: { kind: "window", window: harness.task },
        event: {
          activationId: "1", ownerActivationId: "1", activationKind: "start", releaseKind: null
        }
      });
    harness.time(100);
    expect(harness.router.route(button({ kind: "voice" }, "release")))
      .toMatchObject({
        target: { kind: "window", window: harness.task },
        event: {
          activationId: "1", ownerActivationId: "1", activationKind: "start", releaseKind: "tap"
        }
      });
    expect(harness.router.heldGestures().voice).toBe(true);

    harness.focus(harness.primary);
    harness.time(200);
    expect(harness.router.route(button({ kind: "voice" })))
      .toMatchObject({
        target: { kind: "window", window: harness.task },
        event: {
          activationId: "2", ownerActivationId: "1", activationKind: "toggle-finish", releaseKind: null
        }
      });
    harness.time(210);
    expect(harness.router.route(button({ kind: "voice" }, "release")))
      .toMatchObject({
        target: { kind: "window", window: harness.task },
        event: {
          activationId: "2", ownerActivationId: "1", activationKind: "toggle-finish", releaseKind: "tap"
        }
      });
    expect(harness.router.heldGestures().voice).toBe(false);

    harness.time(1_000);
    expect(harness.router.route(button({ kind: "voice" })))
      .toMatchObject({ target: { kind: "window", window: harness.primary } });
    harness.time(1_450);
    expect(harness.router.route(button({ kind: "voice" }, "release"))).toMatchObject({
      kind: "route",
      event: {
        activationId: "3", ownerActivationId: "3", activationKind: "start", releaseKind: "hold"
      }
    });
    expect(harness.router.heldGestures().voice).toBe(false);
  });

  it("does not synthesize missing presses, duplicate starts, or one-shot releases", () => {
    const harness = createHarness();
    expect(harness.router.route(button({ kind: "voice" }, "release")))
      .toMatchObject({ kind: "drop", reason: "missing-press" });
    expect(harness.router.route({ kind: "scroll", phase: "release" }))
      .toMatchObject({ kind: "drop", reason: "missing-press" });
    expect(harness.router.route(button({ kind: "command", command: "open-settings" }, "release")))
      .toMatchObject({ kind: "drop", reason: "inactive-phase" });

    expect(harness.router.route(button({ kind: "voice" }))).toMatchObject({ kind: "route" });
    expect(harness.router.route(button({ kind: "voice" })))
      .toMatchObject({ kind: "drop", reason: "duplicate-press" });
  });

  it("cancels lifecycle-owned holds at their original targets without rerouting or replay", () => {
    const harness = createHarness();
    harness.router.route(button({ kind: "voice" }));
    harness.focus(harness.primary);
    harness.router.route(scroll("press"));

    const retired = harness.router.retireWindow(harness.task);
    expect(retired).toEqual([{
      gesture: "voice",
      reason: "window-retired",
      target: { kind: "window", window: harness.task },
      event: {
        kind: "button", phase: "cancel", action: { kind: "voice" },
        activationId: "1", ownerActivationId: "1", activationKind: "start", releaseKind: "cancel"
      }
    }]);
    expect(harness.router.heldGestures()).toEqual({ voice: false, scroll: true });
    expect(harness.router.route(button({ kind: "voice" }, "release")))
      .toMatchObject({ kind: "drop", reason: "missing-press" });

    const disabled = harness.router.cancelHeld("disabled");
    expect(disabled).toEqual([{
      gesture: "scroll",
      reason: "disabled",
      target: { kind: "window", window: harness.primary },
      event: { kind: "scroll", phase: "cancel" }
    }]);
    expect(harness.router.heldGestures()).toEqual({ voice: false, scroll: false });
  });

  it("drops a retired sticky owner instead of redirecting completion to new focus", () => {
    const harness = createHarness();
    harness.router.route(scroll("press"));
    harness.task.ready = false;
    harness.focus(harness.primary);
    expect(harness.router.route(scroll("move")))
      .toMatchObject({ kind: "drop", reason: "held-owner-retired" });
    expect(harness.router.route({ kind: "scroll", phase: "release" }))
      .toMatchObject({ kind: "drop", reason: "missing-press" });
  });

  it("still sends completion to an admitted system owner after capability drift", () => {
    const harness = createHarness();
    harness.focus(null);
    harness.router.route(button({ kind: "voice" }));
    harness.capabilities({ voice: "permission-denied", return: "available", scroll: "available" });
    expect(harness.router.route(button({ kind: "voice" }, "cancel")))
      .toMatchObject({ kind: "route", target: { kind: "system-frontmost", capability: "voice" } });
  });
});
