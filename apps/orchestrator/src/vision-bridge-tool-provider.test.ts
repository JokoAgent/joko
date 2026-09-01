import { describe, expect, it, vi } from "vitest";

import type { BridgeToolCallContext } from "./mcp-router.js";
import type { VisionBridgeCoordinator, VisionBridgeState } from "./personalization-inference.js";
import { VisionBridgeToolProvider } from "./vision-bridge-tool-provider.js";

const context: BridgeToolCallContext = { sessionId: "session-a", targetId: "target-a", generation: 7 };

describe("VisionBridgeToolProvider", () => {
  it("advertises only the vision and vision-locate runtime tools", () => {
    const value = fixture();

    expect(value.provider.available).toBe(true);
    expect(value.provider.tools.map((tool) => ({ name: tool.name, runtimeName: tool.runtimeName }))).toEqual([
      { name: "vision", runtimeName: "vision" },
      { name: "vision-locate", runtimeName: "vision-locate" }
    ]);
    expect(value.provider.tools.every((tool) => tool.requiresPermission === false)).toBe(true);
  });

  it("makes its catalog unavailable unless the enabled bridge has a usable primary route", () => {
    const disabled = fixture(state({ enabled: false, available: true }));
    const unavailable = fixture(state({ enabled: true, available: false }));

    expect(disabled.provider.available).toBe(false);
    expect(unavailable.provider.available).toBe(false);
  });

  it("rejects unknown tools and bounded path/query/target violations before dispatch", async () => {
    const value = fixture();

    await expect(value.provider.callTool("unknown", {}, undefined, context)).rejects.toThrow(/not part/u);
    await expect(value.provider.callTool("vision", { path: "" }, undefined, context)).rejects.toThrow(/path is required/u);
    await expect(value.provider.callTool("vision", { path: "x".repeat(4_097) }, undefined, context)).rejects.toThrow(/path is required/u);
    await expect(value.provider.callTool("vision", { path: "D:/image.png", query: "x".repeat(4_097) }, undefined, context)).rejects.toThrow(/query is invalid/u);
    await expect(value.provider.callTool("vision-locate", { path: "D:/image.png" }, undefined, context)).rejects.toThrow(/target is required/u);
    await expect(value.provider.callTool("vision-locate", { path: "D:/image.png", target: "x".repeat(2_049) }, undefined, context)).rejects.toThrow(/target is required/u);
    expect(value.describeFile).not.toHaveBeenCalled();
  });

  it("passes product-scoped allowed roots and the exact AbortSignal to the coordinator", async () => {
    const roots = ["D:/workspace", "D:/artifacts"];
    const allowedRoots = vi.fn(() => roots);
    const value = fixture(undefined, allowedRoots);
    const abort = new AbortController();

    await expect(value.provider.callTool(
      "vision",
      { path: "D:/workspace/screenshot.png", query: "focus on the error" },
      abort.signal,
      context
    )).resolves.toEqual({ content: [{ type: "text", text: "description" }], isError: false });
    expect(allowedRoots).toHaveBeenCalledWith(context);
    expect(value.describeFile).toHaveBeenCalledWith({
      path: "D:/workspace/screenshot.png",
      focus: "focus on the error",
      allowedRoots: roots,
      signal: abort.signal
    });
  });

  it("builds the multi-round locate focus without exposing image bytes or credentials", async () => {
    const value = fixture();

    await value.provider.callTool(
      "vision-locate",
      { path: "D:/workspace/screenshot.png", target: "the send button" },
      undefined,
      context
    );
    expect(value.describeFile).toHaveBeenCalledWith(expect.objectContaining({
      path: "D:/workspace/screenshot.png",
      focus: expect.stringContaining("Target: the send button")
    }));
  });
});

function fixture(
  stateValue = state(),
  allowedRoots = vi.fn(() => ["D:/workspace"])
): {
  readonly provider: VisionBridgeToolProvider;
  readonly describeFile: ReturnType<typeof vi.fn>;
} {
  const describeFile = vi.fn(async () => "description");
  const vision = {
    state: vi.fn(() => stateValue),
    describeFile
  } as unknown as VisionBridgeCoordinator;
  return {
    provider: new VisionBridgeToolProvider({ vision, allowedRoots }),
    describeFile
  };
}

function state(overrides: Partial<VisionBridgeState> = {}): VisionBridgeState {
  return {
    enabled: true,
    targetModels: [],
    primary: { backendId: "pi", providerId: "provider-a", modelId: "vision-a" },
    fallback: null,
    available: true,
    unavailableReason: "",
    customizedFields: [],
    ...overrides
  };
}
