import { describe, expect, it } from "vitest";
import {
  DEDICATED_HARDWARE_MODELS,
  DEDICATED_HARDWARE_PHYSICAL_KEYS,
  DEDICATED_HARDWARE_ACTION_TEXT_MAX_CHARACTERS,
  DEDICATED_HARDWARE_COMMANDS,
  createDefaultDedicatedHardwareSettings,
  createUnavailableDedicatedHardwareSnapshot,
  parseDedicatedHardwareBinding,
  parseDedicatedHardwareAction,
  parseDedicatedHardwareActionDelivery,
  parseDedicatedHardwareActionEvent,
  parseDedicatedHardwarePreviewInput,
  parseDedicatedHardwareSettings,
  parseDedicatedHardwareSnapshot,
  parseDedicatedHardwareTaskCatalog,
  resetDedicatedHardwareSettingsValue,
  setDedicatedHardwareMerge,
  toggleDedicatedHardwareTaskKey
} from "./dedicated-hardware.js";

describe("dedicated hardware strict v1 model", () => {
  it("creates independent, disabled defaults for both current models", () => {
    const codex = createDefaultDedicatedHardwareSettings("codex-micro");
    const creator = createDefaultDedicatedHardwareSettings("creator-micro-2");

    expect(DEDICATED_HARDWARE_MODELS).toEqual(["codex-micro", "creator-micro-2"]);
    expect(codex.enabled).toBe(false);
    expect(creator.enabled).toBe(false);
    expect(codex.version).toBe(1);
    expect(codex.layout.version).toBe(1);
    expect(Object.keys(codex.layout.keys)).toEqual(DEDICATED_HARDWARE_PHYSICAL_KEYS);
    expect(codex.customTaskSlots).toHaveLength(6);
    expect(codex.layout.taskKeys).toEqual(["AG00", "AG01", "AG02", "AG03", "AG04", "AG05"]);
    expect(codex.layout.merges).toEqual([{ origin: "ACT10", cover: "ACT11" }]);
    expect(creator.layout.merges).toEqual([]);
    expect(codex.layout.keys.ACT12).toEqual({ keycapId: "submit", binding: { kind: "command", command: "submit" } });
    expect(creator.layout.keys.ACT12).toEqual({ keycapId: "empty-3", binding: { kind: "command", command: "submit" } });
    expect(parseDedicatedHardwareSettings(codex)).toEqual(codex);
    expect(parseDedicatedHardwareSettings(creator)).toEqual(creator);

    const changed = { ...codex, layout: { ...codex.layout, taskKeys: [] } };
    expect(parseDedicatedHardwareSettings(changed)?.layout.taskKeys).toEqual([]);
    expect(creator.layout.taskKeys).toEqual(["AG00", "AG01", "AG02", "AG03", "AG04", "AG05"]);
  });

  it("accepts only the exact current settings shape and neutral keycap vocabulary", () => {
    const current = createDefaultDedicatedHardwareSettings("codex-micro");
    const withTopLevelAlias = { ...current, deviceEnabled: false };
    const { merges: _merges, ...legacyLayout } = current.layout;
    const withLegacyKeycap = {
      ...current,
      layout: { ...current.layout, keys: { ...current.layout.keys, ACT12: { ...current.layout.keys.ACT12, keycapId: "legacy-cap" } } }
    };
    const withUnknownKey = {
      ...current,
      layout: { ...current.layout, keys: { ...current.layout.keys, ACT13: { keycapId: "submit", binding: { kind: "none" } } } }
    };

    expect(parseDedicatedHardwareSettings(withTopLevelAlias)).toBeUndefined();
    expect(parseDedicatedHardwareSettings({ ...current, layout: legacyLayout })).toBeUndefined();
    expect(parseDedicatedHardwareSettings(withLegacyKeycap)).toBeUndefined();
    expect(parseDedicatedHardwareSettings(withUnknownKey)).toBeUndefined();
    expect(parseDedicatedHardwareSettings({ ...current, customTaskSlots: current.customTaskSlots.slice(0, 5) })).toBeUndefined();
    expect(parseDedicatedHardwareSettings({ ...current, lighting: { brightnessPercent: 101, autoDim: "off" } })).toBeUndefined();
  });

  it("fails closed for legacy, arbitrary-link, and malformed bindings", () => {
    expect(parseDedicatedHardwareBinding({ kind: "command", command: "submit" })).toEqual({ kind: "command", command: "submit" });
    expect(parseDedicatedHardwareBinding({ kind: "fixed-link", linkId: "product-feedback" })).toEqual({ kind: "fixed-link", linkId: "product-feedback" });
    expect(parseDedicatedHardwareBinding({ kind: "external-url", url: "https://example.com" })).toBeUndefined();
    expect(parseDedicatedHardwareBinding({ kind: "command", command: "voice" })).toBeUndefined();
    expect(parseDedicatedHardwareBinding({ kind: "none", action: null })).toBeUndefined();
    expect(parseDedicatedHardwareBinding({ kind: "skill", serverId: "server", resourceId: "skill", name: " Skill" })).toBeUndefined();
    expect(parseDedicatedHardwareBinding({ kind: "composer-text", text: "" })).toBeUndefined();
  });

  it("owns an independent exact command and action-event contract", () => {
    expect(DEDICATED_HARDWARE_COMMANDS).toContain("submit");
    expect(DEDICATED_HARDWARE_COMMANDS).not.toContain("none");
    expect(DEDICATED_HARDWARE_COMMANDS).not.toContain("voice");
    expect(parseDedicatedHardwareActionEvent({
      kind: "button", phase: "press", action: { kind: "command", command: "submit" }
    })).toEqual({ kind: "button", phase: "press", action: { kind: "command", command: "submit" } });
    expect(parseDedicatedHardwareActionEvent({ kind: "scroll", phase: "move", direction: "down", distance: .8 }))
      .toEqual({ kind: "scroll", phase: "move", direction: "down", distance: .8 });
    expect(parseDedicatedHardwareActionEvent({ kind: "scroll", phase: "move", direction: "up", distance: .500_001 }))
      .toEqual({ kind: "scroll", phase: "move", direction: "up", distance: .500_001 });
    expect(parseDedicatedHardwareActionEvent({ kind: "scroll", phase: "cancel" }))
      .toEqual({ kind: "scroll", phase: "cancel" });
    for (const value of [
      { kind: "button", phase: "press", action: { kind: "command", commandId: "submit" } },
      { kind: "button", phase: "pressed", action: { kind: "voice" } },
      { kind: "button", phase: "press", action: { kind: "voice" }, source: "legacy" },
      { kind: "scroll", phase: "move", direction: "left", distance: 1 },
      { kind: "scroll", phase: "move", direction: "up", distance: .5 },
      { kind: "scroll", phase: "move", direction: "up", distance: 1.01 },
      { kind: "scroll", phase: "release", direction: "up" }
    ]) expect(() => parseDedicatedHardwareActionEvent(value)).toThrow(TypeError);
  });

  it("accepts only strict deliveries with an activation identity for focus task presses", () => {
    const task = {
      kind: "task", profileId: "profile", serverId: "server", connectionGeneration: "1", snapshotRevision: "2",
      sessionId: "session", sessionGeneration: "3", targetId: "target", focusWindow: true
    } as const;
    const delivery = {
      version: 1 as const,
      event: { kind: "button" as const, phase: "press" as const, action: task },
      focusRequestId: "1"
    };
    expect(parseDedicatedHardwareActionDelivery(delivery)).toEqual(delivery);
    expect(parseDedicatedHardwareActionDelivery({
      version: 1,
      event: { kind: "button", phase: "press", action: { ...task, focusWindow: false } },
      focusRequestId: null
    })).toEqual({
      version: 1,
      event: { kind: "button", phase: "press", action: { ...task, focusWindow: false } },
      focusRequestId: null
    });
    for (const value of [
      delivery.event,
      { ...delivery, focusRequestId: null },
      { ...delivery, focusRequestId: "0" },
      { ...delivery, focusRequestId: "01" },
      { ...delivery, focusRequestId: "1".repeat(65) },
      { ...delivery, event: { ...delivery.event, action: { ...task, focusWindow: false } } },
      { ...delivery, extra: true }
    ]) expect(() => parseDedicatedHardwareActionDelivery(value)).toThrow(TypeError);
  });

  it("accepts only Main-classified voice deliveries with exact physical and owner activations", () => {
    const press = {
      version: 1 as const,
      event: {
        kind: "button" as const, phase: "press" as const, action: { kind: "voice" as const },
        activationId: "1", ownerActivationId: "1", activationKind: "start" as const, releaseKind: null
      },
      focusRequestId: null
    };
    const toggle = {
      version: 1 as const,
      event: {
        kind: "button" as const, phase: "press" as const, action: { kind: "voice" as const },
        activationId: "2", ownerActivationId: "1", activationKind: "toggle-finish" as const, releaseKind: null
      },
      focusRequestId: null
    };
    const hold = {
      version: 1 as const,
      event: { ...press.event, phase: "release" as const, releaseKind: "hold" as const },
      focusRequestId: null
    };
    expect(parseDedicatedHardwareActionDelivery(press)).toEqual(press);
    expect(parseDedicatedHardwareActionDelivery(toggle)).toEqual(toggle);
    expect(parseDedicatedHardwareActionDelivery(hold)).toEqual(hold);

    for (const event of [
      { kind: "button", phase: "press", action: { kind: "voice" } },
      { ...press.event, activationId: "2" },
      { ...toggle.event, activationId: "1" },
      { ...press.event, releaseKind: "tap" },
      { ...press.event, phase: "release", releaseKind: null },
      { ...press.event, phase: "cancel", releaseKind: "hold" },
      { ...press.event, phase: "cancel", releaseKind: "cancel", extra: true }
    ]) expect(() => parseDedicatedHardwareActionDelivery({
      version: 1, event, focusRequestId: null
    })).toThrow(TypeError);
  });

  it("enforces identity, Unicode, character, and UTF-8 action budgets", () => {
    const task = {
      kind: "task", profileId: "p".repeat(256), serverId: "server", connectionGeneration: "1", snapshotRevision: "2",
      sessionId: "s".repeat(512), sessionGeneration: "3", targetId: "target", focusWindow: false
    };
    expect(parseDedicatedHardwareAction(task)).toEqual(task);
    const maximum = "a".repeat(DEDICATED_HARDWARE_ACTION_TEXT_MAX_CHARACTERS);
    expect(parseDedicatedHardwareAction({ kind: "composer-text", text: maximum })).toEqual({ kind: "composer-text", text: maximum });
    for (const value of [
      { ...task, profileId: " profile" },
      { ...task, profileId: "p".repeat(257) },
      { ...task, sessionId: "s".repeat(513) },
      { ...task, snapshotRevision: "02" },
      { ...task, focusWindow: "yes" },
      (({ focusWindow: _focusWindow, ...legacyTask }) => legacyTask)(task),
      { ...task, targetId: "other", legacyTarget: "target" },
      { kind: "skill", serverId: "server", resourceId: "resource", name: "\ud800" },
      { kind: "composer-text", text: "bad\ntext" },
      { kind: "composer-text", text: "😀".repeat(2_001) },
      { kind: "fixed-link", linkId: "https://example.invalid" }
    ]) expect(() => parseDedicatedHardwareAction(value)).toThrow(TypeError);
  });

  it("keeps merges canonical and prevents merged switches from becoming task keys", () => {
    const original = createDefaultDedicatedHardwareSettings("creator-micro-2").layout;
    const withTask = toggleDedicatedHardwareTaskKey(original, "ACT10", true);
    expect(withTask.taskKeys).toContain("ACT10");

    const merged = setDedicatedHardwareMerge(withTask, "ACT10", "right");
    expect(merged.merges).toEqual([{ origin: "ACT10", cover: "ACT11" }]);
    expect(merged.taskKeys).not.toContain("ACT10");
    expect(merged.taskKeys).not.toContain("ACT11");
    expect(toggleDedicatedHardwareTaskKey(merged, "ACT11", true)).toBe(merged);
    expect(parseDedicatedHardwareSettings({ ...createDefaultDedicatedHardwareSettings("creator-micro-2"), layout: merged })).toBeDefined();

    const overlapping = { ...merged, merges: [...merged.merges, { origin: "ACT11", cover: "ACT12" }] };
    expect(parseDedicatedHardwareSettings({ ...createDefaultDedicatedHardwareSettings("creator-micro-2"), layout: overlapping })).toBeUndefined();
    const nonCanonicalTasks = { ...merged, taskKeys: ["AG01", "AG00"] };
    expect(parseDedicatedHardwareSettings({ ...createDefaultDedicatedHardwareSettings("creator-micro-2"), layout: nonCanonicalTasks })).toBeUndefined();
  });

  it("parses exact state and preview envelopes", () => {
    const snapshot = createUnavailableDedicatedHardwareSnapshot();
    expect(parseDedicatedHardwareSnapshot(snapshot)).toEqual(snapshot);
    const { settingsError: _settingsError, ...legacyState } = snapshot.models["codex-micro"];
    expect(parseDedicatedHardwareSnapshot({ ...snapshot, models: { ...snapshot.models, "codex-micro": legacyState } })).toBeUndefined();
    expect(parseDedicatedHardwareSnapshot({ ...snapshot, models: { ...snapshot.models, "codex-micro": { ...snapshot.models["codex-micro"], settingsError: "corrupt" } } })).toBeUndefined();
    expect(parseDedicatedHardwareSnapshot({ ...snapshot, models: { ...snapshot.models, legacy: snapshot.models["codex-micro"] } })).toBeUndefined();
    expect(parseDedicatedHardwarePreviewInput({ version: 1, model: "codex-micro", kind: "key", key: "ACT12", pressed: true })).toEqual({ version: 1, model: "codex-micro", kind: "key", key: "ACT12", pressed: true });
    expect(parseDedicatedHardwarePreviewInput({ version: 1, model: "codex-micro", kind: "stick", x: 0.4, y: -0.3, pressed: false })).toEqual({ version: 1, model: "codex-micro", kind: "stick", x: 0.4, y: -0.3, pressed: false });
    expect(parseDedicatedHardwarePreviewInput({ version: 1, model: "creator-micro-2", kind: "encoder", delta: -1, pressed: true })).toEqual({ version: 1, model: "creator-micro-2", kind: "encoder", delta: -1, pressed: true });
    expect(parseDedicatedHardwarePreviewInput({ version: 1, model: "codex-micro", kind: "stick", x: 2, y: 0, pressed: false })).toBeUndefined();
    expect(parseDedicatedHardwarePreviewInput({ version: 1, model: "codex-micro", kind: "encoder", delta: 2, pressed: false })).toBeUndefined();
  });

  it("accepts only the fenced current task-catalog envelope", () => {
    const catalog = {
      version: 1 as const,
      profileId: "profile",
      serverId: "server",
      connectionGeneration: "12",
      snapshotRevision: "31",
      tasks: [{
        sessionId: "session", sessionGeneration: "4", targetId: "target", title: "Build",
        pinned: true, userSendAt: 1_725_000_000_000, sidebarOrder: 0, catalogEligible: true, priorityRank: 1
      }]
    };
    expect(parseDedicatedHardwareTaskCatalog(catalog)).toEqual(catalog);
    expect(parseDedicatedHardwareTaskCatalog({ ...catalog, connectionGeneration: "012" })).toBeUndefined();
    expect(parseDedicatedHardwareTaskCatalog({ ...catalog, tasks: [{ ...catalog.tasks[0], pinnedAt: 1 }] })).toBeUndefined();
    expect(parseDedicatedHardwareTaskCatalog({ ...catalog, tasks: [...catalog.tasks, { ...catalog.tasks[0] }] })).toBeUndefined();
    expect(parseDedicatedHardwareTaskCatalog({ ...catalog, tasks: Array.from({ length: 101 }, (_, index) => ({ ...catalog.tasks[0], sessionId: `session-${index}` })) })).toBeUndefined();
  });

  it("preserves enablement for layout and full resets", () => {
    const current = {
      ...createDefaultDedicatedHardwareSettings("creator-micro-2"),
      enabled: true,
      lighting: { brightnessPercent: 30, autoDim: "off" as const },
      layout: { ...createDefaultDedicatedHardwareSettings("creator-micro-2").layout, encoderMode: "custom" as const }
    };
    const layoutOnly = resetDedicatedHardwareSettingsValue("creator-micro-2", current, "layout");
    const all = resetDedicatedHardwareSettingsValue("creator-micro-2", current, "all");
    expect(layoutOnly.enabled).toBe(true);
    expect(layoutOnly.lighting.brightnessPercent).toBe(30);
    expect(layoutOnly.layout.encoderMode).toBe("session-switch");
    expect(all.enabled).toBe(true);
    expect(all.lighting.brightnessPercent).toBe(100);
  });
});
