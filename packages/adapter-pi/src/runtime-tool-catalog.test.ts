import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  MAXIMUM_PI_RUNTIME_TOOL_CATALOG_BYTES,
  PI_RUNTIME_TOOL_CATALOG_STATUS_KEY,
  PI_RUNTIME_TOOL_CATALOG_CHUNK_BYTES,
  PiRuntimeToolCatalogAssembler
} from "./runtime-tool-catalog.js";

function tool(index: number, description = `Tool ${index}`): Record<string, unknown> {
  return {
    name: `tool_${index}`,
    description,
    parameters: { type: "object", properties: {} },
    promptGuidelines: [],
    sourceInfo: {
      path: `C:\\runtime\\tool-${index}.ts`,
      source: `tool-${index}.ts`,
      scope: "temporary",
      origin: "top-level"
    }
  };
}

function catalogStatuses(document: Readonly<Record<string, unknown>>): {
  readonly bytes: Buffer;
  readonly events: readonly Record<string, unknown>[];
} {
  const bytes = Buffer.from(JSON.stringify(document), "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const count = Math.ceil(bytes.byteLength / PI_RUNTIME_TOOL_CATALOG_CHUNK_BYTES);
  return {
    bytes,
    events: Array.from({ length: count }, (_, index) => ({
      method: "setStatus",
      statusKey: PI_RUNTIME_TOOL_CATALOG_STATUS_KEY,
      statusText: JSON.stringify({
        format: 1,
        catalogId: sha256,
        index,
        count,
        byteLength: bytes.byteLength,
        sha256,
        payload: bytes
          .subarray(index * PI_RUNTIME_TOOL_CATALOG_CHUNK_BYTES, (index + 1) * PI_RUNTIME_TOOL_CATALOG_CHUNK_BYTES)
          .toString("base64url")
      })
    }))
  };
}

function projectCatalog(
  document: Readonly<Record<string, unknown>>,
  redactValues: readonly string[] = []
) {
  const assembler = new PiRuntimeToolCatalogAssembler();
  let result = { kind: "pending" } as ReturnType<PiRuntimeToolCatalogAssembler["consume"]>;
  for (const event of catalogStatuses(document).events) result = assembler.consume(event, redactValues);
  return result;
}

describe("Pi runtime tool catalog projection", () => {
  it("preserves live schemas, activity, prompt guidance, and source metadata without leaking secrets", () => {
    const secret = "catalog-secret-value";
    const result = projectCatalog({
      format: 1,
      complete: true,
      activeToolNames: ["extension_lookup"],
      tools: [{
        name: "extension_lookup",
        description: `Look up data without exposing ${secret}`,
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["query"],
          properties: {
            query: {
              type: "string",
              title: "Query",
              description: `Never paste ${secret}`,
              minLength: 1,
              maxLength: 128
            },
            mode: { type: "string", enum: ["fast", secret] }
          }
        },
        promptGuidelines: [`Keep ${secret} private.`],
        sourceInfo: {
          path: "C:\\runtime\\extensions\\lookup.ts",
          source: `managed-${secret}`,
          scope: "temporary",
          origin: "top-level",
          baseDir: "C:\\runtime\\extensions"
        }
      }]
    }, [secret]);

    expect(result).toMatchObject({
      kind: "catalog",
      tools: [{
        name: "extension_lookup",
        active: true,
        description: "Look up data without exposing [REDACTED]",
        promptGuidelines: ["Keep [REDACTED] private."],
        sourceInfo: {
          path: "C:\\runtime\\extensions\\lookup.ts",
          source: "managed-[REDACTED]",
          scope: "temporary",
          origin: "top-level"
        },
        inputSchema: {
          allowsAdditionalFields: false,
          fields: expect.arrayContaining([
            expect.objectContaining({
              fieldPath: "query",
              required: true,
              description: "Never paste [REDACTED]",
              constraints: { minimumLength: 1, maximumLength: 128 }
            }),
            expect.objectContaining({ fieldPath: "mode", enumValues: ["fast", "[REDACTED]"] })
          ])
        }
      }]
    });
  });

  it("keeps explicit upstream capture failure distinct from a valid empty catalog", () => {
    expect(new PiRuntimeToolCatalogAssembler().consume({
      method: "setStatus",
      statusKey: PI_RUNTIME_TOOL_CATALOG_STATUS_KEY,
      statusText: JSON.stringify({ format: 1, complete: false, reason: "capture_failed" })
    })).toEqual({ kind: "unavailable", reason: "capture_failed" });

    expect(projectCatalog({ format: 1, complete: true, activeToolNames: [], tools: [] }))
      .toEqual({ kind: "catalog", tools: [] });
  });

  it("rejects malformed or internally inconsistent snapshots instead of guessing", () => {
    expect(() => projectCatalog({
      format: 1,
      complete: true,
      activeToolNames: ["missing"],
      tools: []
    })).toThrow("unknown runtime tool active");
    expect(() => projectCatalog({
      format: 1,
      complete: true,
      activeToolNames: [],
      tools: [{
        name: "bad tool name",
        description: "invalid",
        parameters: { type: "object" },
        sourceInfo: { path: "x", source: "x", scope: "temporary", origin: "top-level" }
      }]
    })).toThrow("invalid tools[0].name");
  });

  it("ignores ordinary extension statuses", () => {
    expect(new PiRuntimeToolCatalogAssembler().consume({
      method: "setStatus",
      statusKey: "extension-owned",
      statusText: "ready"
    })).toEqual({ kind: "unrelated" });
  });

  it("assembles a 513-tool catalog larger than two MiB out of order without clipping fields or secrets", () => {
    const secret = "runtime-catalog-managed-secret";
    const longDescription = `description-${"d".repeat(4_500)}`;
    const longGuideline = `guideline-${"g".repeat(4_500)}-${secret}`;
    const longPath = `C:\\runtime\\${"p".repeat(4_500)}\\tool.ts`;
    const tools = Array.from({ length: 513 }, (_, index) => tool(index, longDescription));
    tools[512] = {
      ...tools[512],
      description: `${longDescription}-${secret}`,
      promptGuidelines: Array.from({ length: 65 }, (_, index) => index === 64 ? longGuideline : `guideline-${index}`),
      sourceInfo: {
        path: longPath,
        source: `source-${"s".repeat(4_500)}-${secret}`,
        scope: "temporary",
        origin: "top-level",
        baseDir: `C:\\${"b".repeat(4_500)}`
      },
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: `schema-${secret}`,
            enum: [secret]
          }
        }
      }
    };
    const encoded = catalogStatuses({
      format: 1,
      complete: true,
      activeToolNames: ["tool_0", "tool_512"],
      tools
    });
    expect(encoded.bytes.byteLength).toBeGreaterThan(2 * 1024 * 1024);
    expect(encoded.events.length).toBeGreaterThan(2);

    const assembler = new PiRuntimeToolCatalogAssembler();
    const reversed = [...encoded.events].reverse();
    expect(assembler.consume(reversed[0]!, [secret])).toEqual({ kind: "pending" });
    expect(assembler.consume(reversed[0]!, [secret])).toEqual({ kind: "pending" });
    expect(assembler.consume({
      method: "setStatus",
      statusKey: "ordinary-extension",
      statusText: "ready"
    }, [secret])).toEqual({ kind: "unrelated" });
    let result = assembler.consume(reversed[1]!, [secret]);
    for (const event of reversed.slice(2)) result = assembler.consume(event, [secret]);

    expect(result.kind).toBe("catalog");
    if (result.kind !== "catalog") return;
    expect(result.tools).toHaveLength(513);
    expect(result.tools[0]?.description).toBe(longDescription);
    expect(result.tools[512]).toMatchObject({
      active: true,
      description: `${longDescription}-[REDACTED]`,
      promptGuidelines: expect.arrayContaining([`guideline-${"g".repeat(4_500)}-[REDACTED]`]),
      sourceInfo: {
        path: longPath,
        source: `source-${"s".repeat(4_500)}-[REDACTED]`,
        baseDir: `C:\\${"b".repeat(4_500)}`
      },
      inputSchema: {
        fields: [expect.objectContaining({
          fieldPath: "query",
          description: "schema-[REDACTED]",
          enumValues: ["[REDACTED]"]
        })]
      }
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("rejects conflicting duplicates and invalid hashes without publishing a partial catalog", () => {
    const encoded = catalogStatuses({
      format: 1,
      complete: true,
      activeToolNames: [],
      tools: [tool(0, "x".repeat(PI_RUNTIME_TOOL_CATALOG_CHUNK_BYTES + 100))]
    });
    expect(encoded.events).toHaveLength(2);

    const duplicateAssembler = new PiRuntimeToolCatalogAssembler();
    expect(duplicateAssembler.consume(encoded.events[0]!)).toEqual({ kind: "pending" });
    const firstEnvelope = JSON.parse(String(encoded.events[0]?.statusText)) as Record<string, unknown>;
    expect(() => duplicateAssembler.consume({
      ...encoded.events[0],
      statusText: JSON.stringify({ ...firstEnvelope, payload: "YQ" })
    })).toThrow("conflicting duplicate");

    const hashAssembler = new PiRuntimeToolCatalogAssembler();
    const corrupted = encoded.events.map((event) => {
      const envelope = JSON.parse(String(event.statusText)) as Record<string, unknown>;
      return {
        ...event,
        statusText: JSON.stringify({ ...envelope, sha256: "0".repeat(64) })
      };
    });
    expect(hashAssembler.consume(corrupted[1]!)).toEqual({ kind: "pending" });
    expect(() => hashAssembler.consume(corrupted[0]!)).toThrow("invalid content hash");
  });

  it("reports a declared platform-capacity overflow as typed unavailable before decoding payload bytes", () => {
    const assembler = new PiRuntimeToolCatalogAssembler();
    expect(assembler.consume({
      method: "setStatus",
      statusKey: PI_RUNTIME_TOOL_CATALOG_STATUS_KEY,
      statusText: JSON.stringify({
        format: 1,
        catalogId: "platform-limit",
        index: 0,
        count: 1,
        byteLength: MAXIMUM_PI_RUNTIME_TOOL_CATALOG_BYTES + 1,
        sha256: "0".repeat(64),
        payload: "not valid base64url!"
      })
    })).toEqual({ kind: "unavailable", reason: "catalog_too_large" });
  });
});
