import { describe, expect, it } from "vitest";

import {
  DEDICATED_HARDWARE_COMMANDS,
  DEDICATED_HARDWARE_KEYCAP_IDS,
  DEDICATED_HARDWARE_MODELS,
  DEDICATED_HARDWARE_MODEL_IDS,
  createDefaultDedicatedHardwareSettings,
  dedicatedHardwareMergeNeighbor,
  parseDedicatedHardwareBinding,
  parseDedicatedHardwareSettings
} from "./settings.js";

describe("dedicated hardware strict v1 settings", () => {
  it("publishes only the two canonical model identities and official display names", () => {
    expect(DEDICATED_HARDWARE_MODEL_IDS).toEqual(["codex-micro", "creator-micro-2"]);
    expect(DEDICATED_HARDWARE_MODELS["codex-micro"].displayName).toBe("Codex Micro");
    expect(DEDICATED_HARDWARE_MODELS["creator-micro-2"].displayName).toBe("Creator Micro 2");
    expect(DEDICATED_HARDWARE_KEYCAP_IDS.every((keycap) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(keycap))).toBe(true);
  });

  it("creates disabled, independent model defaults with the model-specific cap merge", () => {
    const codex = createDefaultDedicatedHardwareSettings("codex-micro");
    const creator = createDefaultDedicatedHardwareSettings("creator-micro-2");

    expect(codex.enabled).toBe(false);
    expect(creator.enabled).toBe(false);
    expect(codex.layout.merges).toEqual([{ origin: "ACT10", cover: "ACT11" }]);
    expect(creator.layout.merges).toEqual([]);
    expect(codex.layout.keys.ACT10).toEqual({ keycapId: "microphone", binding: { kind: "voice" } });
    expect(creator.layout.keys.ACT10).toEqual({ keycapId: "empty-1", binding: { kind: "voice" } });
    expect(codex.layout.taskKeys).toEqual(["AG00", "AG01", "AG02", "AG03", "AG04", "AG05"]);
    expect(parseDedicatedHardwareSettings(codex)).toEqual(codex);
    expect(codex.layout.keys.AG00).not.toBe(creator.layout.keys.AG00);
    expect(codex.customTaskSlots).not.toBe(creator.customTaskSlots);
  });

  it("accepts every current command and strict skill/fixed-link identities", () => {
    for (const command of DEDICATED_HARDWARE_COMMANDS) {
      expect(parseDedicatedHardwareBinding({ kind: "command", command })).toEqual({ kind: "command", command });
    }
    expect(parseDedicatedHardwareBinding({
      kind: "skill", serverId: "server", resourceId: "skill://package/resource", name: "Review"
    })).toEqual({ kind: "skill", serverId: "server", resourceId: "skill://package/resource", name: "Review" });
    expect(parseDedicatedHardwareBinding({ kind: "fixed-link", linkId: "product-feedback" })).toEqual({
      kind: "fixed-link", linkId: "product-feedback"
    });
    expect(parseDedicatedHardwareBinding({ kind: "fixed-link", linkId: "https://example.com" })).toBeUndefined();
    expect(parseDedicatedHardwareBinding({ kind: "skill", serverId: "server", resourceId: "resource" })).toBeUndefined();
    expect(parseDedicatedHardwareBinding({ kind: "skill", serverId: " server", resourceId: "resource", name: "Skill" })).toBeUndefined();
    expect(parseDedicatedHardwareBinding({ kind: "skill", serverId: "server\ud800", resourceId: "resource", name: "Skill" })).toBeUndefined();
    expect(parseDedicatedHardwareBinding({ kind: "composer-text", text: "line\nbreak" })).toBeUndefined();
    expect(parseDedicatedHardwareBinding({ kind: "composer-text", text: "😀".repeat(2_000) })).toBeUndefined();
  });

  it("rejects old, partial, aliased, unknown, and over-budget shapes instead of normalizing", () => {
    const current = createDefaultDedicatedHardwareSettings("codex-micro");
    for (const invalid of [
      { ...current, version: 0 },
      { ...current, deviceEnabled: false },
      { ...current, enabled: 0 },
      { ...current, extra: true },
      { ...current, lighting: { brightnessPercent: 101, autoDim: "3-minutes" } },
      { ...current, lighting: { brightnessPercent: 50, autoDim: "3-minutes", legacy: true } },
      { ...current, customTaskSlots: current.customTaskSlots.slice(0, 5) },
      { ...current, customTaskSlots: [
        ...current.customTaskSlots.slice(0, 5),
        { kind: "skill", serverId: "s".repeat(257), resourceId: "r", name: "n" }
      ] },
      { ...current, layout: { ...current.layout, separateMicrophoneKeys: false } },
      { ...current, layout: { ...current.layout, keys: { ...current.layout.keys, ACT10_ACT11: current.layout.keys.ACT10 } } }
    ]) {
      expect(parseDedicatedHardwareSettings(invalid)).toBeUndefined();
    }
  });

  it("requires canonical adjacent non-overlapping merges and ordered non-merged task keys", () => {
    const base = createDefaultDedicatedHardwareSettings("creator-micro-2");
    expect(dedicatedHardwareMergeNeighbor("AG00", "right")).toBe("AG01");
    expect(dedicatedHardwareMergeNeighbor("AG00", "down")).toBe("AG03");
    expect(dedicatedHardwareMergeNeighbor("ACT12", "right")).toBeUndefined();

    const valid = {
      ...base,
      layout: {
        ...base.layout,
        merges: [{ origin: "AG00", cover: "AG01" }, { origin: "ACT10", cover: "ACT11" }],
        taskKeys: ["AG02", "AG03", "AG04", "AG05"]
      }
    };
    expect(parseDedicatedHardwareSettings(valid)).toEqual(valid);

    for (const layout of [
      { ...base.layout, merges: [{ origin: "AG00", cover: "AG02" }] },
      { ...base.layout, merges: [{ origin: "AG00", cover: "AG01" }, { origin: "AG01", cover: "AG04" }] },
      { ...base.layout, merges: [{ origin: "ACT10", cover: "ACT11" }, { origin: "AG00", cover: "AG01" }] },
      { ...base.layout, merges: [{ origin: "AG00", cover: "AG01" }], taskKeys: ["AG00"] },
      { ...base.layout, taskKeys: ["AG01", "AG00"] }
    ]) {
      expect(parseDedicatedHardwareSettings({ ...base, layout })).toBeUndefined();
    }
  });

  it("does not permit release-dependent voice on stick or encoder inputs", () => {
    const base = createDefaultDedicatedHardwareSettings("creator-micro-2");
    expect(parseDedicatedHardwareSettings({
      ...base,
      layout: { ...base.layout, stick: { ...base.layout.stick, up: { kind: "voice" } } }
    })).toBeUndefined();
    expect(parseDedicatedHardwareSettings({
      ...base,
      layout: { ...base.layout, encoder: { ...base.layout.encoder, click: { kind: "voice" } } }
    })).toBeUndefined();
  });
});
