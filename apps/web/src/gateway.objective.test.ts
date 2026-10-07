import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  GetSnapshotResponseSchema,
  ObjectiveSchema,
  ObjectiveStatus,
  PauseObjectiveResponseSchema,
  ResumeObjectiveResponseSchema,
  SetObjectiveResponseSchema,
  SnapshotSchema,
  UpdateObjectiveResponseSchema
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";
import { createOrchestratorGateway } from "./gateway.js";
import type { ObjectiveView } from "./model.js";

const OBJECTIVE_STATUS_CASES = [
  [ObjectiveStatus.ACTIVE, "active"],
  [ObjectiveStatus.PAUSED, "paused"],
  [ObjectiveStatus.BLOCKED, "blocked"],
  [ObjectiveStatus.COMPLETE, "complete"],
  [ObjectiveStatus.BUDGET_LIMITED, "budgetLimited"],
  [ObjectiveStatus.USAGE_LIMITED, "usageLimited"],
  [ObjectiveStatus.DISPATCH_UNKNOWN, "dispatchUnknown"]
] as const;

describe("Objective mutation gateway", () => {
  it.each(OBJECTIVE_STATUS_CASES)("accepts Set result status %s as %s", async (status, expectedStatus) => {
    const gateway = objectiveGateway((method, input) => {
      expect(method.localName).toBe("setObjective");
      expect(input).toMatchObject({
        sessionId: "session-1",
        text: "Ship the feature",
        expectedSessionGeneration: 9n,
        limits: { noProgressTurnLimit: 3 }
      });
      return create(SetObjectiveResponseSchema, { objective: objective(status) });
    });
    await gateway.connect();

    await expect(gateway.setObjective(
      "session-1",
      9n,
      "Ship the feature",
      { noProgressTurnLimit: 3 }
    )).resolves.toMatchObject({ status: expectedStatus });
    gateway.disconnect();
  });

  it.each(OBJECTIVE_STATUS_CASES)("accepts Update result status %s as %s", async (status, expectedStatus) => {
    const gateway = objectiveGateway((method, input) => {
      expect(method.localName).toBe("updateObjective");
      expect(input).toMatchObject({
        sessionId: "session-1",
        expectedRevision: { value: 1n },
        expectedOwnerGeneration: 1n,
        text: "Ship the updated feature"
      });
      return create(UpdateObjectiveResponseSchema, {
        objective: objective(status, { text: "Ship the updated feature" })
      });
    });
    await gateway.connect();

    await expect(gateway.updateObjective(currentObjective("active"), {
      text: "Ship the updated feature"
    })).resolves.toMatchObject({ status: expectedStatus });
    gateway.disconnect();
  });

  it.each(OBJECTIVE_STATUS_CASES)("accepts Resume result status %s as %s", async (status, expectedStatus) => {
    const gateway = objectiveGateway((method, input) => {
      expect(method.localName).toBe("resumeObjective");
      expect(input).toMatchObject({
        sessionId: "session-1",
        expectedRevision: { value: 1n },
        expectedOwnerGeneration: 1n
      });
      return create(ResumeObjectiveResponseSchema, { objective: objective(status) });
    });
    await gateway.connect();

    await expect(gateway.resumeObjective(currentObjective("paused")))
      .resolves.toMatchObject({ status: expectedStatus });
    gateway.disconnect();
  });

  it("keeps Pause response status strict", async () => {
    const gateway = objectiveGateway((method) => {
      expect(method.localName).toBe("pauseObjective");
      return create(PauseObjectiveResponseSchema, { objective: objective(ObjectiveStatus.ACTIVE) });
    });
    await gateway.connect();

    await expect(gateway.pauseObjective(currentObjective("active"), "Wait for review"))
      .rejects.toThrow("mismatched Objective mutation");
    gateway.disconnect();
  });
});

function objective(
  status: ObjectiveStatus,
  overrides: { readonly text?: string; readonly revision?: bigint; readonly ownerGeneration?: bigint } = {}
) {
  return create(ObjectiveSchema, {
    sessionId: "session-1",
    text: overrides.text ?? "Ship the feature",
    status,
    noProgressTurnLimit: 3,
    turnsUsed: 0,
    tokensUsed: 0n,
    noProgressTurns: 0,
    ownerGeneration: overrides.ownerGeneration ?? 2n,
    sessionGeneration: 9n,
    startedAt: { seconds: 1n, nanos: 0 },
    version: { revision: { value: overrides.revision ?? 2n } }
  });
}

function currentObjective(status: ObjectiveView["status"]): ObjectiveView {
  return {
    sessionId: "session-1",
    text: "Ship the feature",
    status,
    noProgressTurnLimit: 3,
    turnsUsed: 0,
    tokensUsed: 0,
    noProgressTurns: 0,
    ownerGeneration: 1n,
    sessionGeneration: 9n,
    startedAt: 1_000,
    revision: 1n
  };
}

function objectiveGateway(resolve: (method: any, input: any) => unknown) {
  const transport = {
    unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
      const message = method.localName === "getSnapshot"
        ? create(GetSnapshotResponseSchema, {
            snapshot: create(SnapshotSchema, {
              generation: 1n,
              resumeCursor: { generation: 1n, sequence: 0n }
            })
          })
        : resolve(method, input);
      return response(method, message);
    }),
    stream: vi.fn(async (method: any) => response(method, idleStream(), true))
  } as unknown as Transport;
  return createOrchestratorGateway(
    {
      id: "connection-objective",
      deviceId: "device-test",
      name: "Browser",
      origin: "https://orchestrator.example",
      serverId: "server-test"
    },
    "secret",
    {},
    () => transport
  );
}

function response(method: any, message: unknown, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}

async function* idleStream(): AsyncGenerator<never> {
  await new Promise<void>(() => undefined);
}
