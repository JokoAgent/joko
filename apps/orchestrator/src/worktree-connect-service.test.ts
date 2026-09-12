import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import type { OperationalStore } from "@joko/store";
import { describe, expect, it, vi } from "vitest";

import type { SessionWorktreeCoordinator } from "./session-worktree-coordinator.js";
import { createWorktreeConnectService } from "./worktree-connect-service.js";

describe("WorktreeService removal preview", () => {
  it("authenticates and forwards the exact public task identity and cancellation scope", async () => {
    const signal = new AbortController().signal;
    const authenticate = vi.fn();
    const previewRemoval = vi.fn(async () => ({ hasWorktree: true, dirty: true }));
    const service = createWorktreeConnectService(
      { previewRemoval } as unknown as SessionWorktreeCoordinator,
      {} as OperationalStore,
      authenticate
    );
    const context = { signal } as HandlerContext;

    await expect(service.getSessionWorktreeRemovalPreview(
      create(contract.GetSessionWorktreeRemovalPreviewRequestSchema, { sessionId: "task-one" }),
      context
    )).resolves.toMatchObject({ sessionId: "task-one", hasWorktree: true, dirty: true });
    expect(authenticate).toHaveBeenCalledExactlyOnceWith(context);
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
