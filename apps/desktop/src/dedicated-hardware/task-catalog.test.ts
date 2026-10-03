import { describe, expect, it } from "vitest";

import { createDefaultDedicatedHardwareSettings } from "./settings.js";
import {
  parseDedicatedHardwareTaskCatalog,
  selectDedicatedHardwareTaskSlots
} from "./task-catalog.js";

function catalog() {
  return {
    version: 1,
    profileId: "profile-1",
    serverId: "server-1",
    connectionGeneration: "7",
    snapshotRevision: "42",
    tasks: [{
      sessionId: "session-1",
      sessionGeneration: "3",
      targetId: "target-1",
      title: "Current task",
      pinned: true,
      userSendAt: 1_700_000_000_000,
      sidebarOrder: 0,
      catalogEligible: true,
      priorityRank: null,
      activity: { phase: "running", attention: false }
    }]
  } as const;
}

describe("dedicated hardware task catalog", () => {
  it("accepts the exact owner and task generation identities", () => {
    expect(parseDedicatedHardwareTaskCatalog(catalog())).toEqual(catalog());
    expect(parseDedicatedHardwareTaskCatalog({ ...catalog(), connectionGeneration: "0", snapshotRevision: "0" })).toBeDefined();
  });

  it("rejects aliases, duplicate sessions, malformed revisions, and unbounded catalogs", () => {
    const valid = catalog();
    const duplicate = { ...valid, tasks: [valid.tasks[0], valid.tasks[0]] };
    for (const invalid of [
      { ...valid, pinnedAt: 1 },
      { ...valid, connectionGeneration: "01" },
      { ...valid, snapshotRevision: 42 },
      duplicate,
      { ...valid, tasks: Array.from({ length: 101 }, (_, index) => ({
        ...valid.tasks[0], sessionId: `session-${index}`
      })) },
      { ...valid, tasks: [{ ...valid.tasks[0], sidebarOrder: -1 }] },
      { ...valid, tasks: [{ ...valid.tasks[0], sessionGeneration: "legacy" }] },
      { ...valid, tasks: [{ ...valid.tasks[0], activity: { phase: "idle", attention: false } }] },
      { ...valid, tasks: [{ ...valid.tasks[0], activity: { phase: "running", attention: 1 } }] },
      { ...valid, tasks: [{ ...valid.tasks[0], activity: { phase: null, attention: false, title: "guess" } }] },
      { ...valid, tasks: [{ ...valid.tasks[0], extra: true }] }
    ]) {
      expect(parseDedicatedHardwareTaskCatalog(invalid)).toBeUndefined();
    }
  });

  it("selects eligible sidebar, last-sent, and priority tasks deterministically with an owner fence", () => {
    const baseTask = catalog().tasks[0];
    const tasks = [
      { ...baseTask, sessionId: "a", sessionGeneration: "1", sidebarOrder: 2, userSendAt: 100, priorityRank: null },
      { ...baseTask, sessionId: "b", sessionGeneration: "2", sidebarOrder: 0, userSendAt: null, priorityRank: 2 },
      { ...baseTask, sessionId: "c", sessionGeneration: "3", sidebarOrder: 1, userSendAt: 200, priorityRank: 1 },
      { ...baseTask, sessionId: "hidden", sidebarOrder: 0, userSendAt: 999, priorityRank: 0, catalogEligible: false }
    ];
    const source = { ...catalog(), connectionGeneration: "9", snapshotRevision: "11", tasks };
    const defaults = createDefaultDedicatedHardwareSettings("creator-micro-2");
    const settings = {
      ...defaults,
      layout: { ...defaults.layout, taskKeys: ["AG00", "AG01", "AG02"] as const }
    };

    const sidebar = selectDedicatedHardwareTaskSlots({ ...settings, taskSource: "sidebar" }, source);
    expect(sidebar.slots.map((slot) => slot.sessionId)).toEqual(["b", "c", "a"]);
    expect(sidebar).toMatchObject({
      profileId: "profile-1", serverId: "server-1", connectionGeneration: "9", snapshotRevision: "11"
    });
    expect(selectDedicatedHardwareTaskSlots({ ...settings, taskSource: "last-sent" }, source)
      .slots.map((slot) => slot.sessionId)).toEqual(["c", "a", "b"]);
    expect(selectDedicatedHardwareTaskSlots({ ...settings, taskSource: "priority" }, source)
      .slots.map((slot) => slot.sessionId)).toEqual(["c", "b", "a"]);

    const exactTie = { ...source, tasks: [
      { ...baseTask, sessionId: "ä", sidebarOrder: 0, userSendAt: 1, priorityRank: 1 },
      { ...baseTask, sessionId: "z", sidebarOrder: 0, userSendAt: 1, priorityRank: 1 }
    ] };
    expect(selectDedicatedHardwareTaskSlots({ ...settings, taskSource: "sidebar" }, exactTie)
      .slots.map((slot) => slot.sessionId).slice(0, 2)).toEqual(["z", "ä"]);
  });

  it("preserves custom bindings and creates explicit empty slots up to min(task keys, six)", () => {
    const defaults = createDefaultDedicatedHardwareSettings("creator-micro-2");
    const settings = {
      ...defaults,
      taskSource: "custom" as const,
      customTaskSlots: [
        { kind: "command" as const, command: "new-task" as const },
        { kind: "skill" as const, serverId: "s", resourceId: "r", name: "Skill" },
        { kind: "none" as const }, { kind: "none" as const }, { kind: "none" as const }, { kind: "none" as const }
      ] as const,
      layout: { ...defaults.layout, taskKeys: ["AG00", "AG01"] as const }
    };
    const custom = selectDedicatedHardwareTaskSlots(settings, { ...catalog(), tasks: [] });
    expect(custom.slots).toHaveLength(2);
    expect(custom.slots[0]?.binding).toEqual({ kind: "command", command: "new-task" });
    expect(custom.slots[1]?.binding).toEqual({ kind: "skill", serverId: "s", resourceId: "r", name: "Skill" });

    const empty = selectDedicatedHardwareTaskSlots(
      { ...settings, taskSource: "sidebar" },
      { ...catalog(), tasks: [] }
    );
    expect(empty.slots).toEqual([
      { slot: 0, sessionId: null, sessionGeneration: null, targetId: null, title: null, binding: null },
      { slot: 1, sessionId: null, sessionGeneration: null, targetId: null, title: null, binding: null }
    ]);
  });
});
