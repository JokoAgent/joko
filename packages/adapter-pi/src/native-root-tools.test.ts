import { describe, expect, it, vi } from "vitest";
import { PiNativeRootTools, NATIVE_ROOT_REQUEST_PREFIX } from "./native-root-tools.js";
import type { PiMcpToolDescriptor } from "./config.js";
const tool: PiMcpToolDescriptor = { serverId: "owner_input", name: "request_input", runtimeName: "request_owner_input", description: "Owner input", inputSchema: { type: "object" }, requiresPermission: false, requiresNativeRoot: true };
const event = (requestId = "native-1", serverId = tool.serverId) => ({ method: "input", id: "ui-1", title: NATIVE_ROOT_REQUEST_PREFIX + Buffer.from(JSON.stringify({ requestId, serverId, toolName: tool.name })).toString("base64url") });
describe("native root tool admission", () => {
  it("cannot mint from an inherited bearer, forwarded UI title or another lifecycle", () => {
    const mint = vi.fn(() => "a".repeat(43)), registry = new PiNativeRootTools([tool], mint), root = {};
    expect(registry.request(event(), root)).toMatchObject({ cancelled: true });
    registry.observe({ type: "tool_execution_start", toolCallId: "native-1", toolName: "subagent", args: {} }, root, () => true);
    expect(registry.request(event(), root)).toMatchObject({ cancelled: true });
    registry.observe({ type: "tool_execution_start", toolCallId: "native-1", toolName: tool.runtimeName, args: {} }, root, () => true);
    expect(registry.request(event(), {})).toMatchObject({ cancelled: true }); expect(mint).not.toHaveBeenCalled();
  });
  it("binds the actual root tool arguments, consumes one capture and retires on ToolEnd", () => {
    const mint = vi.fn((_input: { readonly arguments: Readonly<Record<string, unknown>>; readonly assertCurrent: () => void }) => "b".repeat(43)), registry = new PiNativeRootTools([tool], mint), root = {}, args = { purpose: "Original" };
    let current = true;
    registry.observe({ type: "tool_execution_start", toolCallId: "native-1", toolName: tool.runtimeName, args }, root, () => current);
    args.purpose = "Changed";
    expect(registry.request(event(), root)).toEqual({ id: "ui-1", value: "b".repeat(43) });
    expect(mint.mock.calls[0]?.[0]).toMatchObject({ requestId: "native-1", arguments: { purpose: "Original" } });
    expect(registry.request(event(), root)).toMatchObject({ cancelled: true });
    const proof = mint.mock.calls[0]?.[0] as unknown as { assertCurrent(): void }; proof.assertCurrent();
    current = false; expect(() => proof.assertCurrent()).toThrow(); current = true;
    registry.observe({ type: "tool_execution_end", toolCallId: "native-1" }, root, () => true);
    expect(() => proof.assertCurrent()).toThrow();
  });
});
