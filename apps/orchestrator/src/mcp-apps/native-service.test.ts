import { create } from "@bufbuild/protobuf";
import { Code, type HandlerContext } from "@connectrpc/connect";
import { McpAppNativeOperation, McpAppNativeServiceOperateRequestSchema } from "@joko/contracts";
import { expect, it, vi } from "vitest";
import type { McpAppsManager } from "./manager.js";
import type { ConnectionManager } from "../connection-manager.js";
import { createMcpAppNativeService } from "./native-service.js";

function fixture() {
  let current = true;
  const connection = { id: "connection", deviceId: "native-device" };
  const host = { open: vi.fn(async () => ({ viewId: "view", html: "Private View", csp: "default-src 'none'", prefersBorder: true,
    policy: { frameDomains: ["https://frames.example.test"] } })), releaseCaller: vi.fn(async () => {}), teardown: vi.fn(async () => {}),
    dispatch: vi.fn(async () => {}), poll: vi.fn(async () => []), cancelOpen: vi.fn(async () => {}) };
  const manager = { host, nativeDevice: vi.fn(() => true), callerForDevice: vi.fn(() => "device:connection"), retainNativeView: vi.fn() };
  const connections = { authenticate: vi.fn(() => connection), fence: vi.fn(() => { if (!current) throw new Error("revoked"); }), onRevoked: vi.fn(() => () => {}) };
  const operate = createMcpAppNativeService(manager as unknown as McpAppsManager, connections as unknown as ConnectionManager).operate!;
  const request = create(McpAppNativeServiceOperateRequestSchema, { operation: McpAppNativeOperation.OPEN, view: { sessionId: "task", cardId: "card", uiOwnerId: "native-owner", openId: "open" } });
  const context = (headers: Record<string, string> = {}) => ({ requestHeader: new Headers(headers), signal: new AbortController().signal }) as HandlerContext;
  return { manager, connections, host, operate, request, context, revoke: () => { current = false; } };
}
it("excludes browser fetch and non-native devices before reading private documents", async () => {
  const f = fixture();
  for (const name of ["origin", "sec-fetch-mode", "sec-fetch-site", "sec-fetch-dest"]) {
    await expect(f.operate(f.request, f.context({ [name]: "cors" }))).rejects.toMatchObject({ code: Code.PermissionDenied });
  }
  f.manager.nativeDevice.mockReturnValue(false);
  await expect(f.operate(f.request, f.context())).rejects.toMatchObject({ code: Code.PermissionDenied });
  expect(f.host.open).not.toHaveBeenCalled();
});
it("binds private native documents and transport to the original authenticated device and task", async () => {
  const f = fixture(), response = await f.operate(f.request, f.context());
  expect(response.document).toMatchObject({ html: "Private View", viewId: "view", frameDomains: ["https://frames.example.test"] });
  expect(f.manager.callerForDevice).toHaveBeenCalledWith("connection", "native-device", "native-owner");
  expect(f.host.open).toHaveBeenCalledWith("device:connection", "task", "card", {}, "open");
  expect(f.manager.retainNativeView).toHaveBeenCalledWith("view", expect.any(Function));
  f.request.operation = McpAppNativeOperation.MESSAGE; f.request.view!.viewId = "view";
  f.request.messageJson = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  await f.operate(f.request, f.context());
  expect(f.host.dispatch).toHaveBeenCalledWith("device:connection", "task", "view", { jsonrpc: "2.0", id: 1, method: "tools/list" });
});
it("reclaims a late native open when the Connection is revoked during resource loading", async () => {
  const f = fixture();
  f.host.open.mockImplementation(async () => { f.revoke(); return { viewId: "view", html: "Private View", csp: "", prefersBorder: true, policy: { frameDomains: [] } }; });
  await expect(f.operate(f.request, f.context())).rejects.toMatchObject({ code: Code.FailedPrecondition });
  expect(f.host.teardown).toHaveBeenCalledWith("device:connection", "task", "view");
  expect(f.manager.retainNativeView).not.toHaveBeenCalled();
});
