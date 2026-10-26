import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { CollaborationGoalTreeSchema, CollaborationGoalStatus, CollaborationWorkerStatus, PermissionMode,
  CreateCollaborationWorkerRequestSchema, CreateCollaborationWorkerResponseSchema, GetSettingsResponseSchema } from "@joko/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { mobileNetwork, type PairedCredential } from "./network";
import { mobileNetworkFixtureEndpointPublicKey } from "./test/mobile-network-transport";

vi.mock("@joko/connection-transport", async importOriginal => {
  const { controlledMobileConnectionTransport } = await import("./test/mobile-network-transport");
  return controlledMobileConnectionTransport(await importOriginal<typeof import("@joko/connection-transport")>());
});
const credential: PairedCredential = { endpointPublicKey: mobileNetworkFixtureEndpointPublicKey, profileId: "phone", connectionId: "connection", deviceId: "device", serverId: "node",
  origin: "http://192.168.1.20:4318", displayName: "Phone", authKey: "private-auth" };
afterEach(() => vi.restoreAllMocks());
it("binds optional worker input and actual capacity to the authenticated generated service", async () => {
  const tree = create(CollaborationGoalTreeSchema, { goal: { goalId: "goal", leadId: "lead", leadSessionId: "task", backendId: "backend", targetId: "target",
    sessionGeneration: 7n, backendInstanceGeneration: 2n, title: "Team", objective: "Coordinate work", status: CollaborationGoalStatus.ACTIVE,
    createdAt: { seconds: 1_792_000_000n }, updatedAt: { seconds: 1_792_000_001n }, revision: { value: 3n } },
    workers: [{ workerId: "worker", goalId: "goal", sessionId: "worker-task", sessionGeneration: 8n, backendInstanceGeneration: 2n, label: "reviewer", role: "reviewer", assignment: "",
      status: CollaborationWorkerStatus.IDLE, route: { backendId: "backend", targetId: "target", permissionMode: PermissionMode.ASK },
      createdAt: { seconds: 1_792_000_000n }, updatedAt: { seconds: 1_792_000_001n }, revision: { value: 4n } }] });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer private-auth");
    if (String(url).endsWith("/GetSettings")) return new Response(toBinary(GetSettingsResponseSchema, create(GetSettingsResponseSchema, { settings: { collaboration: {
      workerSoftLimit: 4, workerHardLimit: 12, workerIdleReleaseMinutes: 20, version: { revision: { value: 1n } }
    } } })), { headers: { "content-type": "application/proto" } });
    const request = fromBinary(CreateCollaborationWorkerRequestSchema, init?.body as Uint8Array);
    expect(request).toMatchObject({ operationId: "request", callerLeadSessionId: "task", expectedGoalRevision: { value: 3n }, assignment: "", targetId: "target", permissionMode: PermissionMode.ASK });
    return new Response(toBinary(CreateCollaborationWorkerResponseSchema, create(CreateCollaborationWorkerResponseSchema, { tree, worker: tree.workers[0] })), { headers: { "content-type": "application/proto" } });
  });
  const rpc = mobileNetwork.collaborationRpc!(credential, "task", 7n, signal => signal.throwIfAborted());
  await expect(rpc.createWorker(tree.goal!, { role: "reviewer", targetId: "target", initialTask: "", permissionMode: PermissionMode.ASK }, "reviewer", "request", new AbortController().signal))
    .resolves.toMatchObject({ workers: [{ assignment: "", status: CollaborationWorkerStatus.IDLE }] });
  expect(await mobileNetwork.getCollaborationSettings!(credential)).toMatchObject({ workerSoftLimit: 4, workerHardLimit: 12, workerIdleReleaseMinutes: 20 });
});
