import { describe, expect, it } from "vitest";

import { buildCreatorManagedKeymap, readCreatorManagedHidMapping } from "./creator-keymap.js";
import { DEDICATED_HARDWARE_KEYMAP_MAX_BYTES } from "./keymap-controller.js";
import { DEDICATED_HARDWARE_PHYSICAL_KEYS, type DedicatedHardwarePhysicalKey } from "./settings.js";

const CONTEXT = { profileIndex: 1, layerIndex: 2 };
const ORIGINAL = JSON.stringify({
  metadata: { retain: "document" },
  profiles: [
    { name: "other profile", layers: [{ layout: { keymap: [["other"]] } }] },
    {
      metadata: { retain: "profile" },
      layers: [
        { name: "other layer", layout: { keymap: [["other layer"]] } },
        {
          id: 42, name: "active", metadata: { retain: "layer" },
          layout: { keymap: [["factory"]], encoders: [], buttons: ["factory"], joystick: {}, retain: "layout" }
        }
      ]
    }
  ]
}, null, 2);

describe("Creator current-layer keymap", () => {
  it("rewrites the explicit active layer and inversely maps all physical cells without losing other data", () => {
    const result = buildCreatorManagedKeymap(ORIGINAL, ["AG02", "ACT07", "ACT10"], CONTEXT);
    const document = JSON.parse(result);
    const original = JSON.parse(ORIGINAL);
    expect(document.metadata).toEqual(original.metadata);
    expect(document.profiles[0]).toEqual(original.profiles[0]);
    expect(document.profiles[1].metadata).toEqual(original.profiles[1].metadata);
    expect(document.profiles[1].layers[0]).toEqual(original.profiles[1].layers[0]);
    const layer = document.profiles[1].layers[1];
    expect(layer).toMatchObject({ id: 42, name: "active", metadata: { retain: "layer" } });
    expect(layer.layout).toEqual({
      retain: "layout", buttons: [], joystick: { type: "VENDOR", sectors: [] },
      encoders: [["KV_OAI_ENC_CC", "KV_OAI_ENC_CW", "KV_OAI_ENC_CLK"]],
      keymap: [
        ["KV_OAI_ACT06", "KV_OAI_ACT07"],
        ["KV_OAI_AG00", "KV_OAI_ACT08", "KV_OAI_ACT09", "KV_OAI_ACT10"],
        ["KV_OAI_ACT11", "KV_OAI_AG01", "KV_OAI_ACT12", "KV_OAI_AG03"],
        ["KV_OAI_AG02", "KV_OAI_AG04", "KV_OAI_AG05"]
      ]
    });
    const inverse = readCreatorManagedHidMapping(result, CONTEXT)!;
    expect(inverse.size).toBe(13);
    expect(inverse.get("AG00")).toBe("AG02");
    expect(inverse.get("AG01")).toBe("ACT07");
    expect(inverse.get("AG02")).toBe("ACT10");
    expect(new Set(inverse.values())).toEqual(new Set(DEDICATED_HARDWARE_PHYSICAL_KEYS));
    expect(buildCreatorManagedKeymap(result, ["AG02", "ACT07", "ACT10"], CONTEXT)).toBe(result);
    layer.layout.joystick = { sectors: [], type: "VENDOR" };
    const reordered = JSON.stringify(document);
    expect(readCreatorManagedHidMapping(reordered, CONTEXT)?.size).toBe(13);
    expect(buildCreatorManagedKeymap(reordered, ["AG02", "ACT07", "ACT10"], CONTEXT)).toBe(reordered);
  });

  it("keeps extra task keys on ACT codes and assigns every remaining code once, including empty selection", () => {
    const contents = buildCreatorManagedKeymap(ORIGINAL,
      ["AG01", "AG02", "AG03", "AG04", "AG05", "ACT06", "ACT07", "ACT08"], CONTEXT);
    const inverse = readCreatorManagedHidMapping(contents, CONTEXT)!;
    expect(inverse.get("AG00")).toBe("AG01");
    expect(inverse.get("AG05")).toBe("ACT06");
    expect(inverse.get("ACT06")).toBe("ACT07");
    expect(inverse.get("ACT07")).toBe("ACT08");
    expect(inverse.get("ACT08")).toBe("AG00");
    expect(inverse.size).toBe(13);
    const empty = readCreatorManagedHidMapping(buildCreatorManagedKeymap(ORIGINAL, [], CONTEXT), CONTEXT)!;
    expect(empty.get("ACT06")).toBe("AG00");
    expect(empty.get("AG05")).toBe("ACT12");
    expect(empty.size).toBe(13);
  });

  it("requires all managed fields and a unique current firmware grid before admitting an inverse mapping", () => {
    const managed = buildCreatorManagedKeymap(ORIGINAL, ["AG00"], CONTEXT);
    const mutations = [
      (layout: Record<string, unknown>) => { layout.buttons = ["old"]; },
      (layout: Record<string, unknown>) => { layout.joystick = { type: "VENDOR", sectors: [1] }; },
      (layout: Record<string, unknown>) => { layout.encoders = [["KV_OAI_ENC_CC"]]; },
      (layout: Record<string, unknown>) => { layout.keymap = [["KV_OAI_AG00"]]; },
      (layout: Record<string, unknown>) => { (layout.keymap as string[][])[0]![1] = "KV_OAI_AG00"; },
      (layout: Record<string, unknown>) => { (layout.keymap as string[][])[0]![1] = "KV_OAI_AG06"; }
    ];
    for (const mutate of mutations) {
      const document = JSON.parse(managed);
      mutate(document.profiles[1].layers[1].layout);
      const contents = JSON.stringify(document);
      expect(readCreatorManagedHidMapping(contents, CONTEXT)).toBeUndefined();
      expect(readCreatorManagedHidMapping(buildCreatorManagedKeymap(contents, ["AG00"], CONTEXT), CONTEXT)?.size).toBe(13);
    }
    expect(readCreatorManagedHidMapping(ORIGINAL, CONTEXT)).toBeUndefined();
  });

  it("rejects missing, invalid or unavailable active context and noncanonical task selections", () => {
    for (const context of [
      { profileIndex: -1, layerIndex: 2 }, { profileIndex: 2, layerIndex: 2 },
      { profileIndex: 1, layerIndex: 0 }, { profileIndex: 1, layerIndex: 3 },
      { profileIndex: 1, layerIndex: 1.5 }
    ]) {
      expect(() => buildCreatorManagedKeymap(ORIGINAL, [], context)).toThrow();
      expect(readCreatorManagedHidMapping(ORIGINAL, context)).toBeUndefined();
    }
    for (const keys of [["AG00", "AG00"], ["AG01", "AG00"], ["AG06"]]) {
      expect(() => buildCreatorManagedKeymap(ORIGINAL, keys as DedicatedHardwarePhysicalKey[], CONTEXT)).toThrow();
    }
  });

  it("bounds UTF-8 originals and generated documents before any write can occur", () => {
    const unicode = JSON.parse(ORIGINAL);
    unicode.padding = "é".repeat(300_000);
    expect(() => buildCreatorManagedKeymap(JSON.stringify(unicode), [], CONTEXT)).toThrow("size boundary");
    const document = { profiles: [{ layers: [{ layout: {} }] }], padding: "" };
    document.padding = "x".repeat(DEDICATED_HARDWARE_KEYMAP_MAX_BYTES - JSON.stringify(document).length);
    expect(() => buildCreatorManagedKeymap(JSON.stringify(document), [], { profileIndex: 0, layerIndex: 1 }))
      .toThrow("size boundary");
  });
});
