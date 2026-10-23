import { createClient, createRouterTransport, Code, ConnectError } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { expect, it, vi } from "vitest";
import type { OrchestratorApplication } from "./application.js";
import { createConnectServices } from "./connect-services.js";
import { SessionRuntimeControlRegistry } from "./session-runtime-control.js";

it("serves the owner runtime-control generation through the authenticated Session RPC and fences revoked connections", async () => {
  const registry = new SessionRuntimeControlRegistry();
  const baseline = { backendId: "original", providerId: "account", modelId: "model", effort: "low", fastMode: false };
  registry.acceptDeferred("task", "agent", { ...baseline, backendId: "opaque-source", effort: "high", fastMode: true }, baseline);
  let revoked = false;
  const authenticate = vi.fn(() => { if (revoked) throw new ConnectError("Revoked", Code.Unauthenticated); return { id: "owner" }; });
  const fence = vi.fn(() => { if (revoked) throw new ConnectError("Revoked", Code.PermissionDenied); });
  const read = vi.fn((id: string) => registry.snapshot(id, baseline));
  const app = { config: { publicOrigin: "https://node.invalid" }, store: {}, connections: { authenticate, fence }, artifacts: {}, blobTransfers: {},
    artifactRepository: {}, workspaces: {}, workspaceChanges: {}, sessionHost: { getSessionRuntimeControl: read }, scheduler: {}, adapters: [], browserActivity: [], close: async () => undefined } as unknown as OrchestratorApplication;
  const services = createConnectServices(app);
  const rpc = createClient(contract.SessionService, createRouterTransport(router => { router.service(contract.SessionService, services.session); }));
  const result = await rpc.getSessionRuntimeControl({ sessionId: "task" });
  expect(result.control).toMatchObject({ generation: 1n, baseline, effective: baseline,
    pendingGeneration: 1n, pending: { ...baseline, backendId: "opaque-source", effort: "high", fastMode: true } });
  expect(read).toHaveBeenCalledExactlyOnceWith("task"); expect(fence).toHaveBeenCalledOnce();
  revoked = true; await expect(rpc.getSessionRuntimeControl({ sessionId: "task" })).rejects.toMatchObject({ code: Code.Unauthenticated });
  expect(read).toHaveBeenCalledOnce();
});
