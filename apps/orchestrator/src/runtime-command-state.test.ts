import { describe, expect, it } from "vitest";

import {
  materializedRuntimeCommands,
  normalizeRuntimeCommands,
  runtimeCommandsObservation,
  sameRuntimeCommands
} from "./runtime-command-state.js";

describe("runtime command state", () => {
  it("redacts, sorts, and deterministically deduplicates Backend observations", () => {
    const commands = normalizeRuntimeCommands([
      { name: "zeta", description: "https://example.test?token=secret-value", source: "skill", path: "z/SKILL.md", loaded: true },
      { name: "alpha", description: "second", source: "prompt", path: "a.md", loaded: false },
      { name: "alpha", description: "first", source: "prompt", path: "a.md", loaded: true }
    ]);

    expect(commands).toEqual([
      { name: "alpha", description: "first", source: "prompt", path: "a.md", loaded: true },
      expect.objectContaining({ name: "zeta", source: "skill", loaded: true })
    ]);
    expect(commands[1]?.description).not.toContain("secret-value");
    expect(sameRuntimeCommands(commands, normalizeRuntimeCommands([...commands].reverse()))).toBe(true);
  });

  it("fails closed for malformed persisted catalogs", () => {
    expect(() => normalizeRuntimeCommands([
      { name: "/forged", description: "", source: "prompt", loaded: true }
    ])).toThrow(/invalid invocation name/u);
    expect(materializedRuntimeCommands({
      format: 1,
      generation: 1,
      observedAt: 1,
      commands: [{ name: "bad name", description: "", source: "prompt", loaded: true }]
    })).toBeUndefined();
    expect(runtimeCommandsObservation(2, [
      { name: "review", description: "Review", source: "extension", loaded: true }
    ], 10)).toMatchObject({ format: 1, generation: 2, observedAt: 10 });
  });
});
