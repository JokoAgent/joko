import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  DedicatedHardwareAction,
  DedicatedHardwareActionEvent
} from "../dedicated-hardware-action/actions.js";
import {
  DEDICATED_HARDWARE_ENCODER_LONG_PRESS_MS,
  DEDICATED_HARDWARE_STICK_SILENCE_TIMEOUT_MS,
  DEDICATED_HARDWARE_TASK_DOUBLE_TAP_MS,
  createDedicatedHardwareInputController
} from "./input-controller.js";
import type { DedicatedHardwareInputEvent } from "./protocol.js";
import {
  createDefaultDedicatedHardwareSettings,
  type DedicatedHardwareEncoderMode,
  type DedicatedHardwareModelId,
  type DedicatedHardwareSettings
} from "./settings.js";
import {
  selectDedicatedHardwareTaskSlots,
  type DedicatedHardwarePublishedTask,
  type DedicatedHardwareTaskCatalog,
  type DedicatedHardwareTaskSlotSelection
} from "./task-catalog.js";

const MODEL: DedicatedHardwareModelId = "codex-micro";

afterEach(() => {
  vi.useRealTimers();
});

describe("dedicated hardware input controller", () => {
  it("keeps preview raw and exclusive, including a held-key neutral fence", () => {
    const events: DedicatedHardwareActionEvent[] = [];
    const previews: DedicatedHardwareInputEvent[] = [];
    const settings = enabledSettings();
    const controller = createDedicatedHardwareInputController({
      emitAction: (_model, event) => events.push(event),
      emitPreview: (_model, input) => previews.push(input)
    });
    controller.updateModel(MODEL, { settings, taskSlots: selection(settings) });
    controller.setPreview(MODEL, true);

    controller.handleInput(MODEL, { kind: "key", key: "AG00", pressed: true });
    controller.handleInput(MODEL, { kind: "stick", x: 0.8, y: 0, pressed: false });
    controller.handleInput(MODEL, { kind: "encoder", delta: 1, pressed: false });

    expect(events).toEqual([]);
    expect(previews).toEqual([
      { kind: "key", key: "AG00", pressed: true },
      { kind: "stick", x: 0.8, y: 0, pressed: false },
      { kind: "encoder", delta: 1, pressed: false }
    ]);

    controller.setPreview(MODEL, false);
    controller.handleInput(MODEL, { kind: "key", key: "AG00", pressed: true });
    expect(events).toEqual([]);
    controller.handleInput(MODEL, { kind: "key", key: "AG00", pressed: false });
    controller.handleInput(MODEL, { kind: "key", key: "AG00", pressed: true });
    expect(events).toEqual([
      button("press", selectedTaskAction())
    ]);
  });

  it("maps board-order task keys to selected slots and treats every empty slot as new task", () => {
    const events: DedicatedHardwareActionEvent[] = [];
    const settings = enabledSettings();
    const controller = createDedicatedHardwareInputController({ emitAction: (_model, event) => events.push(event) });
    controller.updateModel(MODEL, { settings, taskSlots: selection(settings) });

    tapKey(controller, "AG00");
    tapKey(controller, "AG01");

    expect(events).toEqual([
      button("press", selectedTaskAction()),
      button("release", selectedTaskAction()),
      button("press", { kind: "command", command: "new-task" }),
      button("release", { kind: "command", command: "new-task" })
    ]);

    events.length = 0;
    const custom: DedicatedHardwareSettings = { ...settings, taskSource: "custom" };
    controller.updateModel(MODEL, { settings: custom, taskSlots: selection(custom) });
    tapKey(controller, "AG00");
    expect(events).toEqual([
      button("press", { kind: "command", command: "new-task" }),
      button("release", { kind: "command", command: "new-task" })
    ]);
  });

  it("switches a task in the background on one tap and focuses only the same-slot double tap", () => {
    let now = 1_000;
    const events: DedicatedHardwareActionEvent[] = [];
    const settings = { ...enabledSettings(), singleTapTaskKeys: false };
    const controller = createDedicatedHardwareInputController({
      emitAction: (_model, event) => events.push(event),
      now: () => now
    });
    controller.updateModel(MODEL, { settings, taskSlots: selection(settings) });

    tapKey(controller, "AG00");
    now += DEDICATED_HARDWARE_TASK_DOUBLE_TAP_MS;
    tapKey(controller, "AG00");
    now += DEDICATED_HARDWARE_TASK_DOUBLE_TAP_MS + 1;
    tapKey(controller, "AG00");

    expect(events).toEqual([
      button("press", { ...selectedTaskAction(), focusWindow: false }),
      button("release", { ...selectedTaskAction(), focusWindow: false }),
      button("press", selectedTaskAction()),
      button("release", selectedTaskAction()),
      button("press", { ...selectedTaskAction(), focusWindow: false }),
      button("release", { ...selectedTaskAction(), focusWindow: false })
    ]);
  });

  it("lets the first physical switch own a merged key through its release", () => {
    const events: DedicatedHardwareActionEvent[] = [];
    const settings = enabledSettings();
    const controller = createDedicatedHardwareInputController({ emitAction: (_model, event) => events.push(event) });
    controller.updateModel(MODEL, { settings, taskSlots: selection(settings) });

    controller.handleInput(MODEL, { kind: "key", key: "ACT11", pressed: true });
    controller.handleInput(MODEL, { kind: "key", key: "ACT10", pressed: true });
    controller.handleInput(MODEL, { kind: "key", key: "ACT10", pressed: false });
    controller.handleInput(MODEL, { kind: "key", key: "ACT11", pressed: false });
    tapKey(controller, "ACT10");

    expect(events).toEqual([
      button("press", { kind: "voice" }),
      button("release", { kind: "voice" }),
      button("press", { kind: "voice" }),
      button("release", { kind: "voice" })
    ]);
  });

  it("uses the dominant stick axis, an exclusive dead zone, continuous scroll, and one-shot side actions", () => {
    const events: DedicatedHardwareActionEvent[] = [];
    const settings = enabledSettings();
    const controller = createDedicatedHardwareInputController({ emitAction: (_model, event) => events.push(event) });
    controller.updateModel(MODEL, { settings, taskSlots: selection(settings) });

    stick(controller, 0, 0);
    stick(controller, 0, -0.5);
    stick(controller, 0.4, -0.8);
    stick(controller, 0.3, -0.9);
    stick(controller, 0, 0);
    stick(controller, 0.8, 0.2);
    stick(controller, 0.9, 0.1);
    stick(controller, 0, 0);

    expect(events).toEqual([
      { kind: "scroll", phase: "press", direction: "up", distance: 0.8 },
      { kind: "scroll", phase: "move", direction: "up", distance: 0.9 },
      { kind: "scroll", phase: "release" },
      button("press", { kind: "command", command: "toggle-inspector" })
    ]);
  });

  it("cancels a silent continuous stick gesture and requires recentering", () => {
    vi.useFakeTimers();
    const events: DedicatedHardwareActionEvent[] = [];
    const settings = enabledSettings();
    const controller = createDedicatedHardwareInputController({ emitAction: (_model, event) => events.push(event) });
    controller.updateModel(MODEL, { settings, taskSlots: selection(settings) });
    stick(controller, 0, 0);
    stick(controller, 0, -0.75);
    vi.advanceTimersByTime(DEDICATED_HARDWARE_STICK_SILENCE_TIMEOUT_MS - 1);
    expect(events.at(-1)).toEqual({ kind: "scroll", phase: "press", direction: "up", distance: 0.75 });
    vi.advanceTimersByTime(1);
    expect(events.at(-1)).toEqual({ kind: "scroll", phase: "cancel" });

    stick(controller, 0, -0.9);
    expect(events).toHaveLength(2);
    stick(controller, 0, 0);
    stick(controller, 0, -0.9);
    expect(events.at(-1)).toEqual({ kind: "scroll", phase: "press", direction: "up", distance: 0.9 });
  });

  it("maps all encoder turn modes without synthesizing arbitrary keyboard input", () => {
    const events: DedicatedHardwareActionEvent[] = [];
    const controller = createDedicatedHardwareInputController({ emitAction: (_model, event) => events.push(event) });
    const expected: Readonly<Record<Exclude<DedicatedHardwareEncoderMode, "custom">, readonly [string, string]>> = {
      "session-switch": ["previous-task", "next-task"],
      reasoning: ["effort-decrease", "effort-increase"],
      "conversation-scroll": ["scroll-up", "scroll-down"],
      "composer-navigation": ["previous-panel", "next-panel"]
    };
    for (const [mode, commands] of Object.entries(expected) as Array<[
      Exclude<DedicatedHardwareEncoderMode, "custom">,
      readonly [string, string]
    ]>) {
      const settings = withEncoderMode(mode);
      controller.updateModel(MODEL, { settings, taskSlots: selection(settings) });
      controller.handleInput(MODEL, { kind: "encoder", delta: -1, pressed: false });
      controller.handleInput(MODEL, { kind: "encoder", delta: 1, pressed: false });
      expect(events.splice(0)).toEqual(commands.map((command) =>
        button("press", { kind: "command", command } as Parameters<typeof button>[1])
      ));
    }

    const base = enabledSettings();
    const custom: DedicatedHardwareSettings = {
      ...base,
      layout: {
        ...base.layout,
        encoderMode: "custom",
        encoder: {
          ...base.layout.encoder,
          left: { kind: "composer-text", text: "left" },
          right: { kind: "fixed-link", linkId: "documentation" }
        }
      }
    };
    controller.updateModel(MODEL, { settings: custom, taskSlots: selection(custom) });
    controller.handleInput(MODEL, { kind: "encoder", delta: -1, pressed: false });
    controller.handleInput(MODEL, { kind: "encoder", delta: 1, pressed: false });
    expect(events).toEqual([
      button("press", { kind: "composer-text", text: "left" }),
      button("press", { kind: "fixed-link", linkId: "documentation" })
    ]);
  });

  it("distinguishes bounded encoder clicks and long presses in built-in and custom modes", () => {
    vi.useFakeTimers();
    const events: DedicatedHardwareActionEvent[] = [];
    const controller = createDedicatedHardwareInputController({ emitAction: (_model, event) => events.push(event) });
    let settings = withEncoderMode("session-switch");
    controller.updateModel(MODEL, { settings, taskSlots: selection(settings) });

    controller.handleInput(MODEL, { kind: "encoder", delta: 0, pressed: true });
    vi.advanceTimersByTime(DEDICATED_HARDWARE_ENCODER_LONG_PRESS_MS - 1);
    controller.handleInput(MODEL, { kind: "encoder", delta: 0, pressed: false });
    controller.handleInput(MODEL, { kind: "encoder", delta: 0, pressed: true });
    vi.advanceTimersByTime(DEDICATED_HARDWARE_ENCODER_LONG_PRESS_MS);
    controller.handleInput(MODEL, { kind: "encoder", delta: 0, pressed: false });
    expect(events.splice(0)).toEqual([
      button("press", { kind: "command", command: "activate" }),
      button("press", { kind: "command", command: "open-settings" })
    ]);

    const base = enabledSettings();
    settings = {
      ...base,
      layout: {
        ...base.layout,
        encoderMode: "custom",
        encoder: {
          ...base.layout.encoder,
          click: { kind: "command", command: "archive-task" },
          longPress: { kind: "skill", serverId: "server", resourceId: "skill://review", name: "Review" }
        }
      }
    };
    controller.updateModel(MODEL, { settings, taskSlots: selection(settings) });
    controller.handleInput(MODEL, { kind: "encoder", delta: 0, pressed: true });
    controller.handleInput(MODEL, { kind: "encoder", delta: 0, pressed: false });
    controller.handleInput(MODEL, { kind: "encoder", delta: 0, pressed: true });
    vi.advanceTimersByTime(DEDICATED_HARDWARE_ENCODER_LONG_PRESS_MS);
    controller.handleInput(MODEL, { kind: "encoder", delta: 0, pressed: false });
    expect(events).toEqual([
      button("press", { kind: "command", command: "archive-task" }),
      button("press", { kind: "skill", serverId: "server", resourceId: "skill://review", name: "Review" })
    ]);
  });

  it("synchronously cancels held voice and scroll on disconnect, disable, and global cancellation", () => {
    const events: DedicatedHardwareActionEvent[] = [];
    const settings = enabledSettings();
    const controller = createDedicatedHardwareInputController({ emitAction: (_model, event) => events.push(event) });
    controller.updateModel(MODEL, { settings, taskSlots: selection(settings) });
    controller.handleInput(MODEL, { kind: "key", key: "ACT10", pressed: true });
    stick(controller, 0, 0);
    stick(controller, 0, -0.8);
    controller.cancelModel(MODEL, "device-disconnected");
    expect(events).toEqual([
      button("press", { kind: "voice" }),
      { kind: "scroll", phase: "press", direction: "up", distance: 0.8 },
      button("cancel", { kind: "voice" }),
      { kind: "scroll", phase: "cancel" }
    ]);

    controller.handleInput(MODEL, { kind: "key", key: "ACT10", pressed: true });
    stick(controller, 0, -0.9);
    expect(events).toHaveLength(4);
    controller.handleInput(MODEL, { kind: "key", key: "ACT10", pressed: false });
    stick(controller, 0, 0);
    controller.handleInput(MODEL, { kind: "key", key: "ACT10", pressed: true });
    expect(events.at(-1)).toEqual(button("press", { kind: "voice" }));

    const disabled = { ...settings, enabled: false };
    controller.updateModel(MODEL, { settings: disabled, taskSlots: selection(disabled) });
    expect(events.at(-1)).toEqual(button("cancel", { kind: "voice" }));
    controller.cancelAll();
    expect(events.filter((event) => event.kind === "button" && event.phase === "cancel")).toHaveLength(2);
  });

  it("ignores malformed input frames at the pure boundary", () => {
    const events: DedicatedHardwareActionEvent[] = [];
    const settings = enabledSettings();
    const controller = createDedicatedHardwareInputController({ emitAction: (_model, event) => events.push(event) });
    controller.updateModel(MODEL, { settings, taskSlots: selection(settings) });
    controller.handleInput(MODEL, { kind: "stick", x: Number.NaN, y: 0, pressed: false } as DedicatedHardwareInputEvent);
    controller.handleInput(MODEL, { kind: "encoder", delta: 2, pressed: false } as unknown as DedicatedHardwareInputEvent);
    controller.handleInput(MODEL, { kind: "key", key: "AG99", pressed: true } as unknown as DedicatedHardwareInputEvent);
    expect(events).toEqual([]);
  });
});

function enabledSettings(): DedicatedHardwareSettings {
  return { ...createDefaultDedicatedHardwareSettings(MODEL), enabled: true };
}

function withEncoderMode(mode: DedicatedHardwareEncoderMode): DedicatedHardwareSettings {
  const settings = enabledSettings();
  return { ...settings, layout: { ...settings.layout, encoderMode: mode } };
}

function selection(
  settings: DedicatedHardwareSettings,
  tasks: readonly DedicatedHardwarePublishedTask[] = [publishedTask()]
): DedicatedHardwareTaskSlotSelection {
  const catalog: DedicatedHardwareTaskCatalog = {
    version: 1,
    profileId: "profile",
    serverId: "server",
    connectionGeneration: "2",
    snapshotRevision: "3",
    tasks
  };
  return selectDedicatedHardwareTaskSlots(settings, catalog);
}

function publishedTask(): DedicatedHardwarePublishedTask {
  return {
    sessionId: "session-a",
    sessionGeneration: "4",
    targetId: "target-a",
    title: "Task A",
    pinned: false,
    userSendAt: 20,
    sidebarOrder: 0,
    catalogEligible: true,
    priorityRank: 0
  };
}

function selectedTaskAction(): Extract<DedicatedHardwareAction, { kind: "task" }> {
  return {
    kind: "task",
    profileId: "profile",
    serverId: "server",
    connectionGeneration: "2",
    snapshotRevision: "3",
    sessionId: "session-a",
    sessionGeneration: "4",
    targetId: "target-a",
    focusWindow: true
  };
}

function tapKey(
  controller: ReturnType<typeof createDedicatedHardwareInputController>,
  key: "AG00" | "AG01" | "ACT10"
): void {
  controller.handleInput(MODEL, { kind: "key", key, pressed: true });
  controller.handleInput(MODEL, { kind: "key", key, pressed: false });
}

function stick(
  controller: ReturnType<typeof createDedicatedHardwareInputController>,
  x: number,
  y: number
): void {
  controller.handleInput(MODEL, { kind: "stick", x, y, pressed: false });
}

function button(
  phase: "press" | "release" | "cancel",
  action: Extract<DedicatedHardwareActionEvent, { kind: "button" }>["action"]
): DedicatedHardwareActionEvent {
  return { kind: "button", phase, action };
}
