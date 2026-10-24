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

  it("preserves heterogeneous scalar unions without inventing one branch as the field type", () => {
    expect(projectPiInputSchema({
      type: "object",
      properties: {
        expectedRevision: {
          anyOf: [
            { type: "string", pattern: "^[0-9]+$", maxLength: 32 },
            { type: "integer", minimum: 0 }
          ],
          description: "Optional optimistic-concurrency revision."
        }
      }
    }, "schedule_update")).toMatchObject({
      fields: [{
        fieldPath: "expectedRevision",
        type: "unknown",
        required: false,
        description: "Optional optimistic-concurrency revision."
      }]
    });
  });

  it("projects nullable fields through their concrete branch while retaining nested fields", () => {
    expect(projectPiInputSchema({
      type: "object",
      properties: {
        expireAt: {
          anyOf: [
            { type: "integer", minimum: 0, description: "Unix-millisecond expiration." },
            { type: "null" }
          ]
        },
        preRunHook: {
          anyOf: [
            {
              type: "object",
              properties: { command: { type: "string", minLength: 1 } },
              required: ["command"],
              additionalProperties: false
            },
            { type: "null" }
          ]
        }
      }
    }, "schedule_update")).toMatchObject({
      fields: expect.arrayContaining([
        expect.objectContaining({ fieldPath: "expireAt", type: "integer", required: false }),
        expect.objectContaining({ fieldPath: "preRunHook", type: "object", required: false }),
        expect.objectContaining({ fieldPath: "preRunHook.command", type: "string", required: true })
      ])
    });
  });

  it("keeps existing document oneOf metrics, sheet selectors and formula cells in the catalog", () => {
    const cell = { oneOf: [
      { type: "string", maxLength: 32_000 }, { type: "number" }, { type: "boolean" }, { type: "null" },
      { type: "object", properties: {
        formula: { type: "string", minLength: 1, maxLength: 8_192 },
        result: { oneOf: [{ type: "string", maxLength: 32_000 }, { type: "number" }, { type: "boolean" }] }
      }, required: ["formula", "result"], additionalProperties: false }
    ] };
    const schema = { type: "object", properties: {
      slides: { type: "array", items: { type: "object", properties: {
        metrics: { type: "array", items: { type: "object", properties: {
          value: { oneOf: [{ type: "string", maxLength: 1_000 }, { type: "number" }] }
        }, required: ["value"] } }
      } } },
      sheet: { oneOf: [{ type: "string", minLength: 1, maxLength: 31 }, { type: "integer", minimum: 1 }] },
      rows: { type: "array", items: { type: "array", items: cell } }
    } };
    const original = JSON.stringify(schema);
    const result = projectPiInputSchema(schema, "document_tools");
    expect(result.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldPath: "slides[].metrics[].value", type: "unknown", required: true }),
      expect.objectContaining({ fieldPath: "sheet", type: "unknown", required: false }),
      expect.objectContaining({ fieldPath: "rows[][]", type: "unknown", required: true })
    ]));
    expect(result.fields.some(field => field.fieldPath.startsWith("rows[][]."))).toBe(false);
    expect(JSON.stringify(schema)).toBe(original);
  });

  it.each(["anyOf", "oneOf"] as const)("retains nullable and literal %s projections", keyword => {
    expect(projectPiInputSchema({ type: "object", properties: {
      mode: { [keyword]: [{ type: "string", const: "read" }, { type: "string", const: "write" }] },
      settings: { [keyword]: [{ type: "object", properties: { enabled: { type: "boolean" } } }, { type: "null" }] }
    } }, "union_tools")).toMatchObject({ fields: [
      { fieldPath: "mode", type: "string", enumValues: ["read", "write"] },
      { fieldPath: "settings", type: "object" },
      { fieldPath: "settings.enabled", type: "boolean" }
    ] });
  });

  it("rejects malformed, unsupported and cyclic document union branches", () => {
    const project = (value: unknown) => projectPiInputSchema({ type: "object", properties: { value } }, "document_tools");
    expect(() => project({ oneOf: [] })).toThrow("unsupported schema type");
    expect(() => project({ oneOf: [{ type: "string" }, { type: "invented" }] })).toThrow("unsupported schema type");
    expect(() => project({ oneOf: [{ type: "string" }, false] })).toThrow("invalid value.oneOf[1] object");
    expect(() => project({ oneOf: [{ type: "string" }, { type: "object", properties: { formula: { type: "invented" } } }] }))
      .toThrow("unsupported schema type");
    expect(() => project({ oneOf: [{ type: "string" }, { type: "object", properties: { formula: { type: "string", minLength: -1 } } }] }))
      .toThrow("invalid value.formula.minLength");
    const cyclic: Record<string, unknown> = { oneOf: [{ type: "string" }] };
    (cyclic["oneOf"] as unknown[]).push({ type: "object", properties: { formula: cyclic } });
    expect(() => project(cyclic)).toThrow("cyclic object graph");
  });

  it.each(["anyOf", "oneOf"] as const)("retains original identity when rejecting nullable %s cycles", keyword => {
    const objectUnion: Record<string, unknown> = {};
    objectUnion[keyword] = [{ type: "object", properties: { again: objectUnion } }, { type: "null" }];
    expect(() => projectPiInputSchema({ type: "object", properties: { value: objectUnion } }, "document_tools"))
      .toThrow("cyclic object graph");
    const arrayUnion: Record<string, unknown> = {};
    arrayUnion[keyword] = [{ type: "array", items: arrayUnion }, { type: "null" }];
    expect(() => projectPiInputSchema({ type: "object", properties: { value: arrayUnion } }, "document_tools"))
      .toThrow("cyclic object graph");
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
