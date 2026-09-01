import { describe, expect, it } from "vitest";

import { loadPiBuiltInToolCatalog, projectPiInputSchema } from "./tool-catalog.js";

describe("Pi built-in tool catalog", () => {
  it("projects all definitions exported by the installed Pi runtime", { timeout: 20_000 }, async () => {
    const tools = await loadPiBuiltInToolCatalog({ cwd: process.cwd() });

    expect(tools.map((tool) => tool.name)).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls"
    ]);
    expect(tools.filter((tool) => tool.enabled).map((tool) => tool.name)).toEqual([
      "read",
      "bash",
      "edit",
      "write"
    ]);
    expect(tools.find((tool) => tool.name === "read")).toMatchObject({
      requiresPermission: false,
      streamingUpdates: false,
      inputSchema: {
        fields: expect.arrayContaining([
          expect.objectContaining({ fieldPath: "path", type: "string", required: true }),
          expect.objectContaining({ fieldPath: "offset", type: "number", required: false })
        ])
      }
    });
    expect(tools.find((tool) => tool.name === "bash")).toMatchObject({
      requiresPermission: true,
      streamingUpdates: true,
      inputSchema: {
        fields: expect.arrayContaining([
          expect.objectContaining({ fieldPath: "command", type: "string", required: true })
        ])
      }
    });
    expect(tools.find((tool) => tool.name === "edit")?.inputSchema.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldPath: "edits", type: "array", required: true }),
      expect.objectContaining({ fieldPath: "edits[]", type: "object", required: true }),
      expect.objectContaining({ fieldPath: "edits[].oldText", type: "string", required: true }),
      expect.objectContaining({ fieldPath: "edits[].newText", type: "string", required: true })
    ]));
  });

  it("uses managed defaultTools only as enablement state, without hiding installed definitions", async () => {
    const tools = await loadPiBuiltInToolCatalog({
      cwd: process.cwd(),
      enabledToolNames: ["grep", "find", "ls"]
    });

    expect(tools).toHaveLength(7);
    expect(tools.filter((tool) => tool.enabled).map((tool) => tool.name)).toEqual(["grep", "find", "ls"]);
  });

  it("preserves TypeBox literal unions as backend-neutral string enums", () => {
    expect(projectPiInputSchema({
      type: "object",
      required: ["action"],
      properties: {
        action: {
          anyOf: [
            { const: "list", type: "string" },
            { const: "wait", type: "string" },
            { const: "cancel", type: "string" }
          ]
        }
      }
    }, "subagent_status")).toMatchObject({
      fields: [{
        fieldPath: "action",
        type: "string",
        required: true,
        enumValues: ["list", "wait", "cancel"]
      }]
    });
  });

  it("projects more than 256 fields and schemas deeper than eight levels without recursion limits", () => {
    const properties = Object.fromEntries(
      Array.from({ length: 257 }, (_, index) => [`field_${index.toString().padStart(3, "0")}`, {
        type: "string",
        description: index === 256 ? "d".repeat(16_385) : `Field ${index}`
      }])
    );
    let nested: Record<string, unknown> = { type: "string", pattern: "p".repeat(4_097) };
    for (let level = 9; level >= 1; level -= 1) {
      nested = {
        type: "object",
        properties: { [`level_${level}`]: nested }
      };
    }
    const result = projectPiInputSchema({
      type: "object",
      properties: {
        ...properties,
        nested
      }
    }, "large_schema");

    expect(result.fields.length).toBeGreaterThan(257);
    expect(result.fields).toContainEqual(expect.objectContaining({
      fieldPath: "field_256",
      description: "d".repeat(16_385)
    }));
    expect(result.fields).toContainEqual(expect.objectContaining({
      fieldPath: "nested.level_1.level_2.level_3.level_4.level_5.level_6.level_7.level_8.level_9",
      constraints: { pattern: "p".repeat(4_097) }
    }));
  });
});
