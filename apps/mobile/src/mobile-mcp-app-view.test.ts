import { create } from "@bufbuild/protobuf";
import { McpAppNativeDocumentSchema, McpAppNativeOperation, McpAppNativeServiceOperateResponseSchema, McpAppOperation, McpAppServiceOperateResponseSchema } from "@joko/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { MobileMcpAppView } from "./mobile-mcp-app-view";
import type { MobileMcpAppApi } from "./mobile-mcp-app-api";
const native = vi.hoisted(() => ({ close: vi.fn(async () => {}), prepare: vi.fn(), sequence: 0 }));
vi.mock("expo-crypto", () => ({ getRandomBytes: (count: number) => new Uint8Array(count).fill(++native.sequence) }));
vi.mock("./mobile-mcp-app-document", () => ({ prepareMcpAppNativeDocument: native.prepare }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
const document = create(McpAppNativeDocumentSchema, { viewId: "view", html: "private", csp: "default-src 'none'" });
function fixture() {
  let complete!: () => void;
  const teardown = new Promise<void>(resolve => { complete = resolve; });
  const metadata = vi.fn(async (request: Parameters<MobileMcpAppApi["metadata"]>[0]) => {
    if (request.operation === McpAppOperation.TEARDOWN) await teardown;
    return create(McpAppServiceOperateResponseSchema);
  });
  const rpc = vi.fn(async (request: Parameters<MobileMcpAppApi["native"]>[0]) => {
    if (request.operation === McpAppNativeOperation.OPEN) return create(McpAppNativeServiceOperateResponseSchema, { document });
    if (request.operation === McpAppNativeOperation.POLL) return new Promise<ReturnType<typeof create<typeof McpAppNativeServiceOperateResponseSchema>>>(() => {});
    return create(McpAppNativeServiceOperateResponseSchema);
  });
  native.prepare.mockResolvedValue({ resourceUrl: "http://127.0.0.1:1/resource.html", source: { uri: "http://127.0.0.1:2/proxy.html" }, close: native.close });
  const removed = vi.fn(), view = new MobileMcpAppView({ ownerKey: "owner", metadata, native: rpc }, "task", "card", vi.fn(), removed, vi.fn());
  return { view, metadata, rpc, removed, complete };
}
it("keeps the original native surface and response bridge alive until Host teardown completes", async () => {
  const f = fixture(); await f.view.open({ platform: "mobile" });
  f.view.inject = vi.fn();
  f.view.receive(JSON.stringify({ key: "wrong", message: { jsonrpc: "2.0", id: 1, method: "tools/list" } }));
  expect(f.rpc.mock.calls.filter(([r]) => r.operation === McpAppNativeOperation.MESSAGE)).toHaveLength(0);
  f.view.receive(JSON.stringify({ key: f.view.bridgeKey, message: { jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready" } }));
  const closing = f.view.close();
  expect(f.view.closing).toBe(true); expect(f.view.disposed).toBe(false); expect(native.close).not.toHaveBeenCalled();
  f.view.receive(JSON.stringify({ key: f.view.bridgeKey, message: { jsonrpc: "2.0", id: "teardown", result: {} } }));
  expect(f.rpc.mock.calls.some(([r]) => r.operation === McpAppNativeOperation.MESSAGE && r.messageJson?.includes("teardown"))).toBe(true);
  f.complete(); await closing;
  expect(f.removed).toHaveBeenCalledOnce(); expect(native.close).toHaveBeenCalledOnce(); expect(f.view.disposed).toBe(true);
});
it("bounds native retention even when the Host teardown response is lost", async () => {
  vi.useFakeTimers(); const f = fixture(); await f.view.open({ platform: "mobile" });
  const closing = f.view.close(); await vi.advanceTimersByTimeAsync(1000); await closing;
  expect(f.view.disposed).toBe(true); expect(native.close).toHaveBeenCalledOnce();
});
it("reclaims a late successful open using its original API without preparing a new native resource", async () => {
  const f = fixture(); let finish!: (value: ReturnType<typeof create<typeof McpAppNativeServiceOperateResponseSchema>>) => void;
  f.rpc.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const opening = f.view.open({ platform: "mobile" }); await f.view.close();
  f.complete(); finish(create(McpAppNativeServiceOperateResponseSchema, { document })); await opening;
  expect(native.prepare).not.toHaveBeenCalled();
  expect(f.metadata.mock.calls.map(([r]) => r.operation)).toEqual([McpAppOperation.CANCEL_OPEN, McpAppOperation.TEARDOWN]);
});
