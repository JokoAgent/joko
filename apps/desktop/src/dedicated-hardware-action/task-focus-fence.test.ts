import { describe, expect, it } from "vitest";

import type { DedicatedHardwareAction } from "./actions.js";
import type { DedicatedHardwareRoutedActionEvent } from "./routed-actions.js";
import {
  DedicatedHardwareTaskFocusFence,
  parseDedicatedHardwareTaskFocusAcknowledgement,
  sendDedicatedHardwareActionDelivery
} from "./task-focus-fence.js";

type FocusTask = Extract<DedicatedHardwareAction, { readonly kind: "task" }>;

function task(overrides: Partial<FocusTask> = {}): FocusTask {
  return {
    kind: "task",
    profileId: "profile",
    serverId: "server",
    connectionGeneration: "2",
    snapshotRevision: "3",
    sessionId: "session",
    sessionGeneration: "4",
    targetId: "target",
    focusWindow: true,
    ...overrides
  };
}

describe("DedicatedHardwareTaskFocusFence", () => {
  it("consumes only the exact owner and task once", () => {
    const fence = new DedicatedHardwareTaskFocusFence<object>();
    const owner = {};
    const other = {};
    const focusRequestId = fence.arm(owner, task());
    expect(fence.consume(other, focusRequestId, task())).toBe(false);
    expect(fence.consume(owner, focusRequestId, task({ snapshotRevision: "5" }))).toBe(false);
    expect(fence.consume(owner, focusRequestId, task())).toBe(true);
    expect(fence.consume(owner, focusRequestId, task())).toBe(false);
  });

  it("retires an owner and refuses background focus requests", () => {
    const fence = new DedicatedHardwareTaskFocusFence<object>();
    const owner = {};
    const focusRequestId = fence.arm(owner, task());
    fence.retireOwner(owner);
    expect(fence.consume(owner, focusRequestId, task())).toBe(false);
    expect(() => fence.arm(owner, task({ focusWindow: false }))).toThrow(TypeError);
  });

  it("does not let an identical older task acknowledgement consume a newer activation", () => {
    const fence = new DedicatedHardwareTaskFocusFence<object>();
    const owner = {};
    const first = fence.arm(owner, task());
    const second = fence.arm(owner, task());
    expect(second).not.toBe(first);
    expect(fence.consume(owner, first, task())).toBe(false);
    expect(fence.consume(owner, second, task())).toBe(true);
  });

  it("clears only the failed send identity when an identical newer activation supersedes it", () => {
    const fence = new DedicatedHardwareTaskFocusFence<object>();
    const owner = {};
    let failed = "";
    let newer = "";
    expect(sendDedicatedHardwareActionDelivery({
      fence,
      owner,
      event: taskPress(),
      send: (delivery) => {
        failed = delivery.focusRequestId ?? "";
        newer = fence.arm(owner, task());
        throw new Error("send failed");
      }
    })).toBe(false);
    expect(fence.consume(owner, failed, task())).toBe(false);
    expect(fence.consume(owner, newer, task())).toBe(true);
  });

  it("sends a strict delivery and rejects malformed acknowledgements", () => {
    const fence = new DedicatedHardwareTaskFocusFence<object>();
    const owner = {};
    let sent: unknown;
    expect(sendDedicatedHardwareActionDelivery({
      fence,
      owner,
      event: taskPress(),
      send: (delivery) => { sent = delivery; }
    })).toBe(true);
    expect(sent).toEqual({ version: 1, event: taskPress(), focusRequestId: "1" });
    expect(parseDedicatedHardwareTaskFocusAcknowledgement({
      version: 1,
      focusRequestId: "1",
      task: task()
    })).toEqual({ version: 1, focusRequestId: "1", task: task() });
    for (const value of [
      { version: 1, focusRequestId: "0", task: task() },
      { version: 1, focusRequestId: "01", task: task() },
      { version: 1, focusRequestId: "1", task: task({ focusWindow: false }) },
      { version: 1, focusRequestId: "1", task: task(), extra: true },
      { focusRequestId: "1", task: task() }
    ]) expect(() => parseDedicatedHardwareTaskFocusAcknowledgement(value)).toThrow(TypeError);
  });
});

function taskPress(): DedicatedHardwareRoutedActionEvent {
  return { kind: "button", phase: "press", action: task() };
}
