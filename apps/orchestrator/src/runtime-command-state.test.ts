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
      { name: "zeta", description: "https://example.test?token=secret-value", source: "skill", inputMode: "text", path: "z/SKILL.md", loaded: true },
      { name: "alpha", description: "second", source: "prompt", inputMode: "text", path: "a.md", loaded: false },
      { name: "alpha", description: "first", source: "prompt", inputMode: "text", path: "a.md", loaded: true }
    ]);

    expect(commands).toEqual([
      { name: "alpha", description: "first", source: "prompt", inputMode: "text", path: "a.md", loaded: true },
      expect.objectContaining({ name: "zeta", source: "skill", inputMode: "text", loaded: true })
    ]);
    expect(commands[1]?.description).not.toContain("secret-value");
    expect(sameRuntimeCommands(commands, normalizeRuntimeCommands([...commands].reverse()))).toBe(true);
  });

  it("fails closed for malformed persisted catalogs", () => {
    expect(() => normalizeRuntimeCommands([
      { name: "/forged", description: "", source: "prompt", inputMode: "text", loaded: true }
    ])).toThrow(/invalid invocation name/u);
    expect(materializedRuntimeCommands({
      format: 1,
      generation: 1,
      observedAt: 1,
      commands: [{ name: "bad name", description: "", source: "prompt", inputMode: "text", loaded: true }]
    })).toBeUndefined();
    expect(runtimeCommandsObservation(2, [
      { name: "review", description: "Review", source: "extension", inputMode: "text", loaded: true }
    ], 10)).toMatchObject({ format: 1, generation: 2, observedAt: 10 });
  });

  it("keeps exact Resource ownership in command identity and equality", () => {
    const commands = normalizeRuntimeCommands([
      { name: "navigate", description: "First", source: "extension", inputMode: "text", path: "extension.ts", resourceId: "resource-a", loaded: true },
      { name: "navigate", description: "Second", source: "extension", inputMode: "text", path: "extension.ts", resourceId: "resource-b", loaded: true }
    ]);

    expect(commands).toHaveLength(2);
    expect(commands.map((command) => command.resourceId)).toEqual(["resource-a", "resource-b"]);
    expect(sameRuntimeCommands(commands, commands.map((command, index) => index === 0
      ? { ...command, resourceId: "resource-changed" }
      : command))).toBe(false);
  });

  it("retains explicit Resource invocation mode and rejects missing or unbound modes", () => {
    const command = { name: "report", description: "Report", source: "skill" as const,
      resourceId: "approved-report", loaded: true, inputMode: "resource_mention" as const };
    expect(runtimeCommandsObservation(2, [command], 10).commands).toEqual([command]);
    expect(sameRuntimeCommands([command], [{ ...command, inputMode: "text" }])).toBe(false);
    for (const candidate of [{ ...command, inputMode: undefined }, { ...command, inputMode: "unknown" },
      { ...command, resourceId: undefined }, { ...command, loaded: false }]) {
      expect(materializedRuntimeCommands({ format: 1, generation: 2, observedAt: 10, commands: [candidate] })).toBeUndefined();
    }
  });
});
