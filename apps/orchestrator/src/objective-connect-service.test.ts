import { create } from "@bufbuild/protobuf";
import { Code, type HandlerContext } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { NotFoundError, StoreClosedError, type ObjectiveRecord } from "@joko/store";
import { describe, expect, it, vi } from "vitest";

import { createObjectiveConnectService } from "./objective-connect-service.js";
import type { ObjectiveManager } from "./objective-manager.js";

describe("ObjectiveService", () => {
  it("emits an initial cleared projection even when after_revision was supplied", async () => {
    const listeners = new Set<(objective: ObjectiveRecord | undefined) => void>();
    const manager = {
      get: vi.fn(() => undefined),
      resumeOnOpen: vi.fn(),
      subscribe: vi.fn((_sessionId: string, listener: (objective: ObjectiveRecord | undefined) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      })
    } as unknown as ObjectiveManager;
    const service = createObjectiveConnectService(manager, () => ({ connectionId: "connection-one" }));
    const iterator = service.watchObjective(create(contract.WatchObjectiveRequestSchema, {
      sessionId: "session-one",
      afterRevision: revision(9n)
    }), context())[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ value: { cleared: true }, done: false });
    expect(manager.resumeOnOpen).toHaveBeenCalledWith("session-one");
    await iterator.return?.();
    expect(listeners.size).toBe(0);
  });

  it("maps exact update oneofs and projects the returned owner/version fences", async () => {
    const current = objective();
    const update = vi.fn(async () => current);
    const manager = { update } as unknown as ObjectiveManager;
    const service = createObjectiveConnectService(manager, () => ({ connectionId: "connection-one" }));

    const response = await service.updateObjective(create(contract.UpdateObjectiveRequestSchema, {
      requestId: "objective-update-one",
      sessionId: current.sessionId,
      expectedRevision: revision(current.revision),
      expectedOwnerGeneration: BigInt(current.ownerGeneration),
      text: "Updated objective",
      tokenBudgetUpdate: { case: "clearTokenBudget", value: true },
      maximumTurnsUpdate: { case: "maximumTurns", value: 8 },
      noProgressTurnLimitUpdate: { case: "noProgressTurnLimit", value: 3 }
    }), context());

    expect(update).toHaveBeenCalledWith({
      operationId: "objective-update-one",
      sessionId: current.sessionId,
      expectedRevision: current.revision,
      expectedOwnerGeneration: current.ownerGeneration,
      text: "Updated objective",
      tokenBudget: null,
      maximumTurns: 8,
      noProgressTurnLimit: 3
    });
    expect(response.objective).toMatchObject({
      sessionId: current.sessionId,
      status: contract.ObjectiveStatus.ACTIVE,
      ownerGeneration: 2n,
      version: { revision: { value: 7n }, generation: 2n }
    });
  });

  it("rejects false clear-limit oneofs instead of treating them as clear commands", async () => {
    const current = objective();
    const update = vi.fn(async () => current);
    const service = createObjectiveConnectService({ update } as unknown as ObjectiveManager, () => ({ connectionId: "connection-one" }));
    const request = {
      requestId: "invalid-clear",
      sessionId: current.sessionId,
      expectedRevision: revision(current.revision),
      expectedOwnerGeneration: BigInt(current.ownerGeneration)
    };

    await expect(service.updateObjective(create(contract.UpdateObjectiveRequestSchema, {
      ...request,
      tokenBudgetUpdate: { case: "clearTokenBudget", value: false }
    }), context())).rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(service.updateObjective(create(contract.UpdateObjectiveRequestSchema, {
      ...request,
      maximumTurnsUpdate: { case: "clearMaximumTurns", value: false }
    }), context())).rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(service.updateObjective(create(contract.UpdateObjectiveRequestSchema, {
      ...request,
      noProgressTurnLimitUpdate: { case: "clearNoProgressTurnLimit", value: false }
    }), context())).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(update).not.toHaveBeenCalled();
  });

  it("preserves NotFound and shutdown error codes", async () => {
    const service = createObjectiveConnectService({
      get: vi.fn()
        .mockImplementationOnce(() => { throw new NotFoundError("Session", "missing"); })
        .mockImplementationOnce(() => { throw new StoreClosedError(); })
    } as unknown as ObjectiveManager, () => ({ connectionId: "connection-one" }));

    await expect(service.getObjective(create(contract.GetObjectiveRequestSchema, { sessionId: "missing" }), context()))
      .rejects.toMatchObject({ code: Code.NotFound });
    await expect(service.getObjective(create(contract.GetObjectiveRequestSchema, { sessionId: "closed" }), context()))
      .rejects.toMatchObject({ code: Code.Unavailable });
  });
});

function context(): HandlerContext {
  return { signal: new AbortController().signal } as HandlerContext;
}

function revision(value: bigint): contract.Revision {
  return create(contract.RevisionSchema, { value, etag: `W/\"rev-${value.toString(10)}\"` });
}

function objective(): ObjectiveRecord {
  return {
    sessionId: "session-one",
    text: "Current objective",
    status: "active",
    maximumTurns: 10,
    noProgressTurnLimit: 3,
    turnsUsed: 1,
    tokensUsed: 42,
    noProgressTurns: 0,
    dispatchRejections: 0,
    ownerGeneration: 2,
    sessionGeneration: 1,
    startedAt: 1_000,
    updatedAt: 2_000,
    revision: 7n
  };
}
