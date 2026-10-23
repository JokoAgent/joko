import { create } from "@bufbuild/protobuf";
import { createRouterTransport } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { expect, it } from "vitest";
import { createOrchestratorGateway } from "./gateway.js";
import { projectTaskProviderGroupUsage } from "./provider-group-task-usage.js";

function usage(readable = true) {
  return create(contract.GetTaskProviderGroupUsageResponseSchema, { member: { group: { backendId: "group-B", providerId: "provider-B" },
    memberKey: "member-A", nodeName: "Computer A", backendId: "source-A", providerId: "account-A", modelId: "model-A", quotaReadable: readable },
    quota: { usagePercent: 73, limited: false, resetAt: 1_800_000_000_000 } });
}

it("uses the bound member quota and leaves unassigned, private and unknown quotas absent", () => {
  expect(projectTaskProviderGroupUsage(usage())).toMatchObject({ nodeName: "Computer A", usedPercent: 73 });
  expect(projectTaskProviderGroupUsage(usage(false))).toEqual({ group: { backendId: "group-B", providerId: "provider-B" }, memberRoute: { backendId: "source-A", providerId: "account-A" }, nodeName: "Computer A", quotaReadable: false });
  expect(projectTaskProviderGroupUsage(create(contract.GetTaskProviderGroupUsageResponseSchema))).toBeUndefined();
  const unknown = usage(); unknown.quota = undefined;
  expect(projectTaskProviderGroupUsage(unknown)).not.toHaveProperty("usedPercent");
});

it("reads through the generated owner service and rejects old native generations before sending", async () => {
  let requests = 0;
  const gateway = await connectedGateway(async request => { requests++; expect(request).toMatchObject({ sessionId: "task", generation: 7n }); return usage(); });
  try {
    await expect(gateway.readTaskProviderGroupUsage!("task", 7n)).resolves.toMatchObject({ nodeName: "Computer A", usedPercent: 73 });
    await expect(gateway.readTaskProviderGroupUsage!("task", 8n)).rejects.toThrow("generation");
    expect(requests).toBe(1);
  } finally { gateway.disconnect(); }
});

it("discards a late quota response when the original owner connection closes", async () => {
  let finish!: () => void, started!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; }), sent = new Promise<void>(resolve => { started = resolve; });
  const gateway = await connectedGateway(async () => { started(); await pending; return usage(); });
  const read = gateway.readTaskProviderGroupUsage!("task", 7n);
  const assertion = expect(read).rejects.toThrow();
  await sent; gateway.disconnect(); finish(); await assertion;
});

async function connectedGateway(read: (request: contract.GetTaskProviderGroupUsageRequest) => Promise<contract.GetTaskProviderGroupUsageResponse>) {
  const snapshot = create(contract.SnapshotSchema, { sessions: [{ sessionId: "task", backendId: "source-A", targetId: "target", state: contract.SessionState.IDLE,
    nativeBinding: { runtimeGeneration: 7n }, location: { kind: { case: "serviceNode", value: {} } } }] });
  const transport = createRouterTransport(router => {
    router.service(contract.EventService, { getSnapshot: () => ({ snapshot }) });
    router.service(contract.ProviderGroupService, { getTaskProviderGroupUsage: read });
  });
  const gateway = createOrchestratorGateway({ id: "connection", deviceId: "device", name: "Owner", origin: "https://owner.example", serverId: "owner" }, "secret", {}, () => transport);
  await gateway.connect(); return gateway;
}
