import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { OperationalStore } from "@joko/store";
import { describe, expect, it, vi } from "vitest";

import type { SessionWorktreeCoordinator } from "./session-worktree-coordinator.js";
import { SessionWorktreeCoordinatorError } from "./session-worktree-coordinator.js";
import { createWorktreeConnectService } from "./worktree-connect-service.js";

describe("WorktreeService removal preview", () => {
  it("authenticates recycle controls, carries exact generation and preserves typed stale failures", async () => {
    const id = "a".repeat(24), generation = "11111111-1111-4111-8111-111111111111";
    const signal = new AbortController().signal;
    const record = { id, generation, sessionId: "task-one", displayName: "Retained task", pathDisplay: "Managed checkout",
      state: "waiting" as const, reason: "in_use" as const, failures: 0, nextAttemptAt: 0 };
    const controlRecycle = vi.fn(async () => record);
    const listRecycleStatus = vi.fn(() => [record]);
    const authenticate = vi.fn(() => ({ connectionId: "owner", authKeyDigest: "digest" }));
    const authorizeConnection = vi.fn();
    const service = createWorktreeConnectService({ controlRecycle, listRecycleStatus } as unknown as SessionWorktreeCoordinator,
      { authorizeConnection } as unknown as OperationalStore, authenticate);
    const context = { signal } as HandlerContext;
    const listed = await service.listWorktreeRecycleStatus(create(contract.ListWorktreeRecycleStatusRequestSchema), context);
    expect(listed.records).toMatchObject([{ id, generation, state: contract.WorktreeRecycleState.WAITING,
      reason: contract.WorktreeRecycleReason.IN_USE, failures: 0 }]);
    await expect(service.controlWorktreeRecycle(create(contract.ControlWorktreeRecycleRequestSchema, {
      id, generation, action: contract.WorktreeRecycleAction.RETRY
    }), context)).resolves.toMatchObject({ record: { id, generation } });
    expect(controlRecycle).toHaveBeenCalledExactlyOnceWith({ id, generation, action: "retry" }, { signal }, expect.any(Function));
    expect(authorizeConnection).toHaveBeenCalledWith("owner", "digest");
    controlRecycle.mockRejectedValueOnce(new SessionWorktreeCoordinatorError("SESSION_CONFLICT"));
    await expect(service.controlWorktreeRecycle(create(contract.ControlWorktreeRecycleRequestSchema, {
      id, generation, action: contract.WorktreeRecycleAction.KEEP
    }), context)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    authenticate.mockImplementation(() => { throw new ConnectError("Authentication required.", Code.Unauthenticated); });
    await expect(service.listWorktreeRecycleStatus(create(contract.ListWorktreeRecycleStatusRequestSchema), context))
      .rejects.toMatchObject({ code: Code.Unauthenticated });
    await expect(service.controlWorktreeRecycle(create(contract.ControlWorktreeRecycleRequestSchema, {
      id, generation, action: contract.WorktreeRecycleAction.KEEP
    }), context)).rejects.toMatchObject({ code: Code.Unauthenticated });
    expect(listRecycleStatus).toHaveBeenCalledOnce();
    expect(controlRecycle).toHaveBeenCalledTimes(2);
  });

  it.each([contract.WorktreeRecycleAction.KEEP, contract.WorktreeRecycleAction.RETRY])(
    "rejects an originally authenticated recycle action after the queued connection is revoked (%s)", async action => {
      const store = new OperationalStore(":memory:");
      try {
        const owner = store.createConnection({ id: "owner", name: "Owner", authKeyDigest: "digest" });
        let start!: () => void;
        const entered = new Promise<void>(resolve => { start = resolve; });
        let resume!: () => void;
        const queued = new Promise<void>(resolve => { resume = resolve; });
        const effect = vi.fn();
        const controlRecycle: SessionWorktreeCoordinator["controlRecycle"] = async (_input, _options, assertCurrent) => {
          start(); await queued; assertCurrent?.(); effect(); return undefined;
        };
        const service = createWorktreeConnectService({ controlRecycle } as unknown as SessionWorktreeCoordinator, store, () => {
          const current = store.authorizeConnection(owner.id, owner.authKeyDigest);
          return { connectionId: current.id, authKeyDigest: current.authKeyDigest };
        });
        const request = service.controlWorktreeRecycle(create(contract.ControlWorktreeRecycleRequestSchema, {
          id: "a".repeat(24), generation: "11111111-1111-4111-8111-111111111111", action
        }), { signal: new AbortController().signal } as HandlerContext);
        const rejected = expect(request).rejects.toMatchObject({ code: Code.Unauthenticated });
        await entered; store.revokeConnection(owner.id); resume();
        await rejected;
        expect(effect).not.toHaveBeenCalled();
      } finally { store.close(); }
    }
  );

  it("rejects missing identity, arbitrary paths and unknown recycle actions before the Owner", async () => {
    const controlRecycle = vi.fn();
    const service = createWorktreeConnectService({ controlRecycle } as unknown as SessionWorktreeCoordinator,
      {} as OperationalStore, () => undefined);
    for (const input of [
      { id: "D:\\checkout", generation: "11111111-1111-4111-8111-111111111111", action: contract.WorktreeRecycleAction.KEEP },
      { id: "a".repeat(24), generation: "", action: contract.WorktreeRecycleAction.RETRY },
      { id: "a".repeat(24), generation: "11111111-1111-4111-8111-111111111111", action: contract.WorktreeRecycleAction.UNSPECIFIED }
    ]) {
      await expect(service.controlWorktreeRecycle(create(contract.ControlWorktreeRecycleRequestSchema, input),
        { signal: new AbortController().signal } as HandlerContext)).rejects.toMatchObject({ code: Code.InvalidArgument });
    }
    expect(controlRecycle).not.toHaveBeenCalled();
  });

  it("preserves Git-not-found separately from transient service unavailability", async () => {
    const probe = vi.fn(async () => ({
      targetId: "target-one",
      eligibility: "git_not_found" as const,
      canRefreshRemote: false
    }));
    const service = createWorktreeConnectService(
      { probe } as unknown as SessionWorktreeCoordinator,
      { getTarget: () => ({ descriptor: { id: "target-one" } }) } as unknown as OperationalStore,
      () => undefined
    );

    await expect(service.probeTargetWorktree(
      create(contract.ProbeTargetWorktreeRequestSchema, { targetId: "target-one" }),
      { signal: new AbortController().signal } as HandlerContext
    )).resolves.toMatchObject({
      targetId: "target-one",
      eligibility: contract.WorktreeEligibility.GIT_NOT_FOUND,
      canRefreshRemote: false
    });
  });

  it("authenticates and forwards the exact public task identity and cancellation scope", async () => {
    const signal = new AbortController().signal;
    const authenticate = vi.fn();
    const previewRemoval = vi.fn(async () => ({ hasWorktree: true, dirty: true }));
    const service = createWorktreeConnectService(
      { previewRemoval } as unknown as SessionWorktreeCoordinator,
      { readSessionArchiveSchedules: () => ({ count: 1, names: ["Nightly"], confirmation: "a".repeat(64) }) } as unknown as OperationalStore,
      authenticate
    );
    const context = { signal } as HandlerContext;

    await expect(service.getSessionWorktreeRemovalPreview(
      create(contract.GetSessionWorktreeRemovalPreviewRequestSchema, { sessionId: "task-one" }),
      context
    )).resolves.toMatchObject({ sessionId: "task-one", hasWorktree: true, dirty: true,
      activeBoundScheduleCount: 1, activeBoundScheduleNames: ["Nightly"], archiveConfirmation: "a".repeat(64) });
    expect(authenticate).toHaveBeenCalledTimes(2);
    expect(previewRemoval).toHaveBeenCalledExactlyOnceWith("task-one", { signal });
  });

  it("rejects malformed task identities before consulting the coordinator", async () => {
    const previewRemoval = vi.fn();
    const service = createWorktreeConnectService(
      { previewRemoval } as unknown as SessionWorktreeCoordinator,
      {} as OperationalStore,
      () => undefined
    );

    await expect(service.getSessionWorktreeRemovalPreview(
      create(contract.GetSessionWorktreeRemovalPreviewRequestSchema, { sessionId: " task-one" }),
      { signal: new AbortController().signal } as HandlerContext
    )).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(previewRemoval).not.toHaveBeenCalled();
  });

  it("does not expose removal state when authentication fails", async () => {
    const previewRemoval = vi.fn();
    const service = createWorktreeConnectService(
      { previewRemoval } as unknown as SessionWorktreeCoordinator,
      {} as OperationalStore,
      () => { throw new ConnectError("Authentication required.", Code.Unauthenticated); }
    );

    await expect(service.getSessionWorktreeRemovalPreview(
      create(contract.GetSessionWorktreeRemovalPreviewRequestSchema, { sessionId: "task-one" }),
      { signal: new AbortController().signal } as HandlerContext
    )).rejects.toMatchObject({ code: Code.Unauthenticated });
    expect(previewRemoval).not.toHaveBeenCalled();
  });
});
