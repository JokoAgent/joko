import { describe, expect, it, vi } from "vitest";

import {
  ANDROID_TOOL_NAMES,
  type AndroidToolCallResult,
  type AndroidToolDescriptor,
  type AndroidToolProvider
} from "@joko/tool-android";

import {
  ANDROID_BRIDGE_PROVIDER_ID,
  AndroidToolBridgeProvider
} from "./android-tool-bridge.js";

const context = {
  sessionId: "session-1",
  targetId: "target-1",
  generation: 4
} as const;

describe("AndroidToolBridgeProvider", () => {
  it("exposes only the discovery and dispatch tools and gates future snapshots", () => {
    let enabled = false;
    const fake = providerFixture();
    const bridge = new AndroidToolBridgeProvider({
      provider: () => fake.provider,
      enabledForNewSessions: () => enabled
    });

    expect(bridge.tools.map((tool) => tool.name)).toEqual(["list_tools", "call_tool"]);
    expect(bridge.tools.every((tool) => tool.serverId === ANDROID_BRIDGE_PROVIDER_ID)).toBe(true);
    expect(bridge.tools.every((tool) => tool.requiresPermission)).toBe(true);
    expect(bridge.tools.map(({ name, inputSchema }) => ({ name, inputSchema }))).toEqual([
      {
        name: "list_tools",
        inputSchema: {
          type: "object",
          properties: {
            category: {
              type: "string",
              enum: ["android"],
              description: "Tool category. Omit to list categories overview."
            }
          },
          additionalProperties: false
        }
      },
      {
        name: "call_tool",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Tool name from list_tools" },
            args: {
              type: "object",
              description: "Arguments object for the selected tool（传 JSON 对象本身，不要序列化成字符串）",
              additionalProperties: {}
            }
          },
          required: ["name", "args"],
          additionalProperties: false
        }
      }
    ]);
    expect(bridge.includeInSnapshot).toBe(false);
    enabled = true;
    expect(bridge.includeInSnapshot).toBe(true);
  });

  it("returns the category overview and the private eight-action catalog", async () => {
    const fake = providerFixture();
    const bridge = new AndroidToolBridgeProvider({
      provider: () => fake.provider,
      enabledForNewSessions: () => true
    });

    expect(textPayload(await bridge.callTool("list_tools", {}, undefined, context))).toEqual({
      ok: true,
      categories: [{ name: "android", tool_count: 8 }],
      hint: 'Use list_tools({category:"android"}) to inspect the Android tool list.'
    });
    const category = textPayload(await bridge.callTool(
      "list_tools",
      { category: "android" },
      undefined,
      context
    )) as { tools: Array<{ name: string; readOnly: boolean }>; workflow: string };
    expect(category.tools.map(({ name }) => name)).toEqual(ANDROID_TOOL_NAMES);
    expect(category.tools.slice(0, 3).every(({ readOnly }) => readOnly)).toBe(true);
    expect(category.tools.slice(3).every(({ readOnly }) => !readOnly)).toBe(true);
    expect(category.workflow).toContain("get_device_state");
    expect(fake.callTool).not.toHaveBeenCalled();
  });

  it("validates and dispatches with authenticated Session identity", async () => {
    const fake = providerFixture({
      content: [{ type: "text", text: '{"ok":true}' }],
      structuredContent: { must_not_escape: true }
    });
    const bridge = new AndroidToolBridgeProvider({
      provider: () => fake.provider,
      enabledForNewSessions: () => true
    });
    const signal = new AbortController().signal;

    const result = await bridge.callTool("call_tool", {
      name: "input_text",
      args: JSON.stringify({ device_serial: "emulator-5554", text: "private value" })
    }, signal, context);

    expect(fake.callTool).toHaveBeenCalledWith("session-1", "input_text", {
      device_serial: "emulator-5554",
      text: "private value"
    }, signal);
    expect(result).toEqual({
      content: [{ type: "text", text: '{"ok":true}' }],
      isError: false
    });
    expect(result).not.toHaveProperty("structuredContent");
  });

  it("returns INVALID_ARGS and UNKNOWN_TOOL envelopes before runtime dispatch", async () => {
    const fake = providerFixture();
    const bridge = new AndroidToolBridgeProvider({
      provider: () => fake.provider,
      enabledForNewSessions: () => true
    });

    const invalid = await bridge.callTool("call_tool", {
      name: "status",
      args: { unexpected: true }
    }, undefined, context);
    expect(invalid.isError).toBe(true);
    expect(textPayload(invalid)).toMatchObject({
      ok: false,
      errorCode: "INVALID_ARGS",
      data: { message: expect.any(String), tool: "status" }
    });

    const unknown = await bridge.callTool("call_tool", {
      name: "shell",
      args: {}
    }, undefined, context);
    expect(unknown.isError).toBe(true);
    expect(textPayload(unknown)).toMatchObject({
      ok: false,
      errorCode: "UNKNOWN_TOOL",
      data: { message: expect.any(String), requested: "shell", available: ANDROID_TOOL_NAMES }
    });
    expect(fake.callTool).not.toHaveBeenCalled();
  });

  it("preserves image content, keeps an existing instance callable after disable, and closes sessions", async () => {
    let enabled = true;
    const fake = providerFixture({
      content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }]
    });
    const bridge = new AndroidToolBridgeProvider({
      provider: () => fake.provider,
      enabledForNewSessions: () => enabled
    });
    enabled = false;

    const result = await bridge.callTool("call_tool", {
      name: "get_device_state",
      args: {}
    }, undefined, { ...context, sessionId: "session-frozen" });
    bridge.closeSession("session-frozen");

    expect(bridge.includeInSnapshot).toBe(false);
    expect(result.content).toEqual([{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }]);
    expect(fake.callTool).toHaveBeenCalledWith("session-frozen", "get_device_state", {}, undefined);
    expect(fake.closeSession).toHaveBeenCalledWith("session-frozen");
  });

  it("rejects bridge tools outside the fenced public catalog", async () => {
    const fake = providerFixture();
    const bridge = new AndroidToolBridgeProvider({
      provider: () => fake.provider,
      enabledForNewSessions: () => true
    });
    await expect(bridge.callTool("status", {}, undefined, context)).rejects.toThrow("not part of this generation");
    expect(fake.callTool).not.toHaveBeenCalled();
  });
});

function providerFixture(result: AndroidToolCallResult = { content: [] }) {
  const descriptors: readonly AndroidToolDescriptor[] = ANDROID_TOOL_NAMES.map((name, index) => ({
    name,
    description: name,
    inputSchema: name === "input_text"
      ? objectSchema({
          device_serial: { type: "string", minLength: 1, maxLength: 255 },
          text: { type: "string", minLength: 1, maxLength: 4_096 }
        }, ["text"])
      : objectSchema({}),
    annotations: {
      readOnlyHint: index < 3,
      destructiveHint: false,
      openWorldHint: false
    }
  }));
  const callTool = vi.fn(async () => result);
  const closeSession = vi.fn();
  const provider = {
    listTools: () => descriptors,
    callTool,
    closeSession
  } as unknown as AndroidToolProvider;
  return { provider, callTool, closeSession };
}

function textPayload(result: { readonly content: readonly unknown[] }): unknown {
  const first = result.content[0] as { readonly type?: string; readonly text?: string } | undefined;
  if (first?.type !== "text" || first.text === undefined) throw new Error("Missing Android text payload.");
  return JSON.parse(first.text) as unknown;
}

function objectSchema(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[] = []
): Readonly<Record<string, unknown>> {
  return {
    type: "object",
    properties,
    ...(required.length === 0 ? {} : { required }),
    additionalProperties: false
  };
}
