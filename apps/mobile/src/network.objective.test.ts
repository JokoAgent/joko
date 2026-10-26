import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { EntityVersionSchema, GetOperationResponseSchema, ObjectiveSchema, ObjectiveStatus,
  SetObjectiveRequestSchema, SetObjectiveResponseSchema, OperationState } from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mobileNetwork, type PairedCredential } from "./network";
import { projectMobileObjective } from "./mobile-objective";
import { mobileNetworkFixtureEndpointPublicKey } from "./test/mobile-network-transport";

vi.mock("@joko/connection-transport", async importOriginal => {
  const { controlledMobileConnectionTransport } = await import("./test/mobile-network-transport");
  return controlledMobileConnectionTransport(await importOriginal<typeof import("@joko/connection-transport")>());
});

const credential: PairedCredential = { endpointPublicKey: mobileNetworkFixtureEndpointPublicKey, profileId: "phone", connectionId: "connection", deviceId: "device", serverId: "node",
  origin: "http://192.168.1.20:4318", displayName: "Phone", authKey: "private-auth" };
const objective = () => create(ObjectiveSchema, { sessionId: "task", text: "Finish the result", status: ObjectiveStatus.ACTIVE,
  sessionGeneration: 7n, ownerGeneration: 2n, noProgressTurnLimit: 3, startedAt: { seconds: 10n }, version: { revision: { value: 9n }, generation: 2n } });
afterEach(() => vi.restoreAllMocks());
describe("mobile objective generated boundary", () => {
  it("omits untouched limits and preserves explicit unlimited values over the authenticated wire", async () => {
    const requests: ReturnType<typeof fromBinary<typeof SetObjectiveRequestSchema>>[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer private-auth");
      const request = fromBinary(SetObjectiveRequestSchema, init?.body as Uint8Array); requests.push(request);
      const value = objective(); if (request.limits) value.noProgressTurnLimit = request.limits.noProgressTurnLimit;
      return new Response(toBinary(SetObjectiveResponseSchema, create(SetObjectiveResponseSchema, { objective: value })), { headers: { "content-type": "application/proto" } });
    });
    const signal = new AbortController().signal;
    const rpc = mobileNetwork.objectiveRpc!(credential, "task", 7n, current => current.throwIfAborted());
    await expect(rpc.set({ text: " Finish the result " }, "first", signal)).resolves.toMatchObject({ noProgressTurnLimit: 3 });
    await expect(rpc.set({ text: "Finish the result", limits: { maximumTurns: null, tokenBudget: null, noProgressTurnLimit: null } }, "second", signal))
      .resolves.toMatchObject({ noProgressTurnLimit: null });
    expect(requests[0]?.limits).toBeUndefined(); expect(requests[1]?.limits).toBeDefined();
    expect([requests[1]?.limits?.maximumTurns, requests[1]?.limits?.tokenBudget, requests[1]?.limits?.noProgressTurnLimit]).toEqual([undefined, undefined, undefined]);
    expect(requests.map(value => value.expectedSessionGeneration)).toEqual([7n, 7n]);
  });
  it("rejects foreign owners, untyped states, incomplete pending work and unsafe token counts", () => {
    const invalid: Array<(value: ReturnType<typeof objective>) => void> = [value => { value.sessionId = "other"; },
      value => { value.sessionGeneration = 8n; }, value => { value.status = ObjectiveStatus.UNSPECIFIED; },
      value => { value.pendingRunId = "run"; }, value => { value.tokensUsed = BigInt(Number.MAX_SAFE_INTEGER) + 1n; },
      value => { value.version = create(EntityVersionSchema, { revision: { value: 1n }, generation: 3n }); }];
    for (const change of invalid) {
      const value = objective(); change(value);
      expect(() => projectMobileObjective(value, "task", 7n)).toThrow();
    }
    expect(projectMobileObjective(objective(), "task", 7n)).toMatchObject({ revision: 9n, ownerGeneration: 2n });
  });
  it("reads the original node operation ledger without relaxing ordinary client operation identity", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(toBinary(GetOperationResponseSchema,
      create(GetOperationResponseSchema, { operation: { operationId: "objective-request", connectionId: "", state: OperationState.SUCCEEDED } })),
    { headers: { "content-type": "application/proto" } }));
    await expect(mobileNetwork.getServiceOperation!(credential, "objective-request")).resolves.toMatchObject({ state: OperationState.SUCCEEDED });
    await expect(mobileNetwork.getOperation(credential, "objective-request")).rejects.toThrow("mismatched operation identity");
    await expect(mobileNetwork.getServiceOperation!(credential, "other-request")).rejects.toThrow("another owner");
  });
  it("rejects a retired read before dispatch and never turns a failed Get into an empty objective", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new ConnectError("Offline", Code.Unavailable));
    const signal = new AbortController().signal;
    const rpc = mobileNetwork.objectiveRpc!(credential, "task", 7n, current => current.throwIfAborted());
    await expect(rpc.get(signal)).rejects.toThrow();
    const controller = new AbortController(); controller.abort();
    const count = fetcher.mock.calls.length;
    await expect(rpc.get(controller.signal)).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(count);
  });
});
