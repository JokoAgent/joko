import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { NativeSessionBinding, SessionDescriptor } from "@joko/core";
import { afterEach, describe, expect, it } from "vitest";

import { OperationalStore, OperationInProgressError, OperationPreviouslyFailedError,
  RevisionConflictError, type PrepareNativeSessionDerivationInput,
  type RecordNativeSessionDerivationInput } from "./index.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

describe("native derivation receipts", () => {
  it("orders an external native lifecycle before Product adoption and finalizes it after restart", () => {
    const f = fixture();
    const input = f.claim("external-lifecycle");
    const attempt = f.attempt(input);
    const prepared = f.store.prepareNativeSessionDerivation(attempt);
    expect(prepared).toMatchObject({ state: "prepared", externalLifecycle: true });
    expect(prepared.binding).toBeUndefined();
    const preparedRevision = f.store.health().revision;
    expect(f.store.prepareNativeSessionDerivation(attempt)).toEqual(prepared);
    expect(f.store.health().revision).toBe(preparedRevision);
    expect(() => f.store.prepareNativeSessionDerivation({
      ...attempt,
      targetRevision: attempt.targetRevision + 1n
    })).toThrow(/original effect/u);

    const recorded = f.store.recordNativeSessionDerivation(input);
    expect(recorded).toMatchObject({ state: "recorded", binding: input.binding, externalLifecycle: true });
    f.complete(input, (store) => store.createSession(f.child(input), { derivationOperationId: input.operationId }));
    const productAdopted = f.store.findNativeSessionDerivation(input.operationId)!;
    expect(productAdopted).toMatchObject({ state: "product_adopted", binding: input.binding });
    expect(f.store.findProductAdoptedNativeSessionDerivation(input.sessionId)).toEqual(productAdopted);
    expect(productAdopted.productAdoptedAt).toEqual(expect.any(Number));
    expect(productAdopted.adoptedAt).toBeUndefined();
    expect(f.store.getOperation(input.operationId).status).toBe("completed");
    expect(() => f.store.finishNativeSessionDerivationAdoption({
      operationId: input.operationId,
      expectedRevision: productAdopted.revision - 1n
    })).toThrow(RevisionConflictError);

    f.reopen();
    expect(f.store.listUnadoptedNativeSessionDerivations()).toEqual([productAdopted]);
    const adopted = f.store.finishNativeSessionDerivationAdoption({
      operationId: input.operationId,
      expectedRevision: productAdopted.revision
    });
    expect(adopted).toMatchObject({ state: "adopted", externalLifecycle: true });
    expect(adopted.adoptedAt).toEqual(expect.any(Number));
    const revision = f.store.health().revision;
    expect(f.store.finishNativeSessionDerivationAdoption({
      operationId: input.operationId,
      expectedRevision: productAdopted.revision
    })).toEqual(adopted);
    expect(f.store.health().revision).toBe(revision);
    expect(f.store.listUnadoptedNativeSessionDerivations()).toEqual([]);
    expect(f.store.findProductAdoptedNativeSessionDerivation(input.sessionId)).toBeUndefined();
  });

  it("transfers only a settled lifecycle to the published successor generation with exact CAS fences", () => {
    const f = fixture();
    const input = f.claim("successor-owner");
    const prepared = f.store.prepareNativeSessionDerivation(f.attempt(input));
    const current = f.store.getBackend(input.backendId).descriptor;
    const successor = f.store.reserveBackendInstanceGeneration({
      backendId: input.backendId,
      adapterKind: current.adapterKind
    });
    expect(successor.generation).toBe(current.instanceGeneration + 1);
    expect(f.store.publishBackendInstanceDescriptor({
      descriptor: { ...current, instanceGeneration: successor.generation },
      expectedCurrentGeneration: current.instanceGeneration
    }).status).toBe("published");

    expect(() => f.store.claimNativeSessionDerivationLifecycleOwner({
      operationId: input.operationId,
      expectedRevision: prepared.revision,
      expectedOwnerGeneration: current.instanceGeneration,
      nextGeneration: successor.generation
    })).toThrow(/live native derivation lifecycle/u);
    expect(f.store.findNativeSessionDerivation(input.operationId)).toEqual(prepared);

    f.fail(input);
    const transferred = f.store.claimNativeSessionDerivationLifecycleOwner({
      operationId: input.operationId,
      expectedRevision: prepared.revision,
      expectedOwnerGeneration: current.instanceGeneration,
      nextGeneration: successor.generation
    });
    expect(transferred).toMatchObject({
      state: "prepared",
      backendInstanceGeneration: current.instanceGeneration,
      lifecycleOwnerGeneration: successor.generation
    });
    expect(() => f.store.recordNativeSessionDerivation(input)).toThrow(/stale Backend generation/u);
    expect(() => f.store.claimNativeSessionDerivationLifecycleOwner({
      operationId: input.operationId,
      expectedRevision: transferred.revision,
      expectedOwnerGeneration: current.instanceGeneration,
      nextGeneration: successor.generation
    })).toThrow(/generation owner is stale/u);

    const future = f.store.reserveBackendInstanceGeneration({
      backendId: input.backendId,
      adapterKind: current.adapterKind
    });
    expect(future.generation).toBe(successor.generation + 1);
    expect(() => f.store.claimNativeSessionDerivationLifecycleOwner({
      operationId: input.operationId,
      expectedRevision: transferred.revision,
      expectedOwnerGeneration: successor.generation,
      nextGeneration: future.generation
    })).toThrow(/not the published Backend generation/u);
    expect(f.store.findNativeSessionDerivation(input.operationId)).toEqual(transferred);
  });

  it("allows at most one pending external adoption for a product Session", () => {
    const f = fixture();
    const first = f.claim("pending-navigation-first", "navigate_session");
    f.store.prepareNativeSessionDerivation(f.attempt(first));
    f.store.recordNativeSessionDerivation(first);
    f.complete(first, (store) => store.updateSession("source", { binding: first.binding }, undefined, Date.now(),
      { derivationOperationId: first.operationId }));
    const pending = f.store.findNativeSessionDerivation(first.operationId)!;
    expect(f.store.findProductAdoptedNativeSessionDerivation("source")).toEqual(pending);

    const nextClaim = f.claim("pending-navigation-second", "navigate_session");
    const second = { ...nextClaim, binding: native("pending-navigation-second", first.binding.generation + 1) };
    f.store.prepareNativeSessionDerivation(f.attempt(second));
    f.store.recordNativeSessionDerivation(second);
    expect(() => f.complete(second, (store) => store.updateSession("source", { binding: second.binding }, undefined,
      Date.now(), { derivationOperationId: second.operationId }))).toThrow();
    expect(f.store.findProductAdoptedNativeSessionDerivation("source")).toEqual(pending);
    expect(f.store.findNativeSessionDerivation(second.operationId)?.state).toBe("recorded");
  });

  it("cleans exact failed external attempts before or after their native binding is recorded", () => {
    const f = fixture();
    const preparedInput = f.claim("prepared-cleanup");
    const prepared = f.store.prepareNativeSessionDerivation(f.attempt(preparedInput));
    f.fail(preparedInput);
    const preparedClaim = f.store.claimNativeSessionDerivationCleanup({
      operationId: preparedInput.operationId,
      expectedRevision: prepared.revision
    });
    expect(preparedClaim.record.binding).toBeUndefined();
    expect(f.store.confirmNativeSessionDerivationNativeCleanup({
      operationId: preparedInput.operationId,
      token: preparedClaim.token
    }).state).toBe("workspace_cleanup_pending");
    expect(f.store.finishNativeSessionDerivationCleanup({
      operationId: preparedInput.operationId,
      token: preparedClaim.token,
      outcome: "cleaned"
    }).state).toBe("cleaned");

    const recordedInput = f.claim("recorded-cleanup");
    f.store.prepareNativeSessionDerivation(f.attempt(recordedInput));
    const recorded = f.store.recordNativeSessionDerivation(recordedInput);
    f.fail(recordedInput);
    const recordedClaim = f.store.claimNativeSessionDerivationCleanup({
      operationId: recordedInput.operationId,
      expectedRevision: recorded.revision
    });
    expect(recordedClaim.record.binding).toEqual(recordedInput.binding);
    expect(f.store.finishNativeSessionDerivationCleanup({
      operationId: recordedInput.operationId,
      token: recordedClaim.token,
      outcome: "cleanup_unknown",
      failureCode: "store_cleanup_unknown"
    })).toMatchObject({ state: "cleanup_unknown", failureCode: "store_cleanup_unknown" });
  });

  it.each(["cleanup_claimed", "workspace_cleanup_pending", "cleaned", "cleanup_unknown"] as const)(
    "rejects a late binding after an unbound external attempt reaches %s",
    (cleanupState) => {
      const f = fixture();
      const input = f.claim(`late-${cleanupState}`);
      const prepared = f.store.prepareNativeSessionDerivation(f.attempt(input));
      f.fail(input);
      const claim = f.store.claimNativeSessionDerivationCleanup({
        operationId: input.operationId,
        expectedRevision: prepared.revision
      });
      if (cleanupState === "workspace_cleanup_pending" || cleanupState === "cleaned") {
        f.store.confirmNativeSessionDerivationNativeCleanup({
          operationId: input.operationId,
          token: claim.token
        });
      }
      if (cleanupState === "cleaned" || cleanupState === "cleanup_unknown") {
        f.store.finishNativeSessionDerivationCleanup({
          operationId: input.operationId,
          token: claim.token,
          outcome: cleanupState
        });
      }
      const before = f.store.findNativeSessionDerivation(input.operationId)!;
      const revision = f.store.health().revision;
      expect(before).toMatchObject({ state: cleanupState });
      expect(before.binding).toBeUndefined();
      expect(() => f.store.recordNativeSessionDerivation(input)).toThrow(/no longer accepts a late binding/u);
      expect(f.store.findNativeSessionDerivation(input.operationId)).toEqual(before);
      expect(f.store.health().revision).toBe(revision);
    }
  );

  it("rejects a cross-workspace child that reuses the source native session identity", () => {
    const f = fixture();
    const claimed = f.claim("cross-workspace-source-id");
    const input = {
      ...claimed,
      effectiveWorkspaceRoot: "D:/derived-workspace",
      binding: {
        opaqueRef: "native://cross-workspace-child",
        nativeSessionId: claimed.sourceBinding.nativeSessionId,
        generation: claimed.binding.generation
      }
    };
    const prepared = f.store.prepareNativeSessionDerivation(f.attempt(input));
    expect(() => f.store.recordNativeSessionDerivation(input)).toThrow(/distinct binding/u);
    expect(f.store.findNativeSessionDerivation(input.operationId)).toEqual(prepared);
    expect(f.store.findNativeSessionDerivation(input.operationId)?.binding).toBeUndefined();
  });

  it("fences external adoption to the prepared Store revisions and exact worktree authority", () => {
    const f = fixture();
    const staleInput = f.claim("stale-authority");
    const staleAttempt = f.attempt(staleInput);
    f.store.updateSession("source", { title: "changed while admission was pending" });
    expect(() => f.store.prepareNativeSessionDerivation(staleAttempt)).toThrow(RevisionConflictError);

    const claimed = f.claim("worktree-authority");
    const worktree = {
      leaseId: "lease-worktree-authority", workspaceId: "workspace", path: "D:/derived-worktree",
      repositoryRoot: "D:/workspace", branch: "codex/worktree-authority", sourceRef: "main",
      sourceCommit: "a".repeat(40), sourceStrategy: "explicit" as const, sourceRefreshed: false,
      state: "active" as const, acquiredAt: 10, updatedAt: 10
    };
    const input = { ...claimed, effectiveWorkspaceRoot: worktree.path, worktree };
    const attempt = f.attempt(input, worktree);
    expect(() => f.store.prepareNativeSessionDerivation({
      ...attempt,
      worktree: { ...worktree, path: "D:/another-worktree" }
    })).toThrow(/worktree authority/u);
    const prepared = f.store.prepareNativeSessionDerivation(attempt);
    f.reopen();
    expect(f.store.findNativeSessionDerivation(input.operationId)).toEqual(prepared);
    f.store.recordNativeSessionDerivation(input);
    expect(() => f.complete(input, (store) => store.createSession({
      ...f.child(input),
      worktree: { ...worktree, branch: "codex/wrong-branch" }
    }, { derivationOperationId: input.operationId }))).toThrow(/prepared authority/u);
    expect(f.store.findNativeSessionDerivation(input.operationId)?.state).toBe("recorded");
    f.complete(input, (store) => store.createSession({ ...f.child(input), worktree }, {
      derivationOperationId: input.operationId
    }));
    expect(f.store.getSession(input.sessionId).descriptor.worktree).toEqual(worktree);
    expect(f.store.findNativeSessionDerivation(input.operationId)?.state).toBe("product_adopted");
  });

  it("persists exact direct-lifecycle worktree authority across replay and restart", () => {
    const f = fixture();
    const worktree = {
      leaseId: "lease-direct-worktree", workspaceId: "workspace", path: "D:/direct-worktree",
      repositoryRoot: "D:/workspace", branch: "codex/direct-worktree", sourceRef: "main",
      sourceCommit: "b".repeat(40), sourceStrategy: "explicit" as const, sourceRefreshed: false,
      state: "active" as const, acquiredAt: 20, updatedAt: 20
    };
    const input = { ...f.claim("direct-worktree"), effectiveWorkspaceRoot: worktree.path, worktree };
    const recorded = f.store.recordNativeSessionDerivation(input);
    expect(recorded).toMatchObject({ externalLifecycle: false, state: "recorded", worktree });
    expect(f.store.recordNativeSessionDerivation(input)).toEqual(recorded);
    expect(() => f.store.recordNativeSessionDerivation({
      ...input,
      worktree: { ...worktree, branch: "codex/different-branch" }
    })).toThrow(/original effect/u);
    f.reopen();
    expect(f.store.findNativeSessionDerivation(input.operationId)).toEqual(recorded);
  });

  it("records one exact effect, rejects mismatched receipts, and transfers no adopted identity", () => {
    const f = fixture();
    const input = f.claim("derive");
    const first = f.store.recordNativeSessionDerivation(input);
    const revision = f.store.health().revision;
    expect(f.store.recordNativeSessionDerivation(input)).toEqual(first);
    expect(f.store.health().revision).toBe(revision);
    expect(() => f.store.recordNativeSessionDerivation({ ...input, effectiveWorkspaceRoot: "D:/elsewhere" })).toThrow(/original effect/u);
    expect(() => f.store.recordNativeSessionDerivation({ ...input, binding: native("different") })).toThrow(/original effect/u);
    expect(() => f.store.recordNativeSessionDerivation({ ...f.claim("other"), binding: input.binding })).toThrow(OperationInProgressError);
    expect(() => f.store.recordNativeSessionDerivation({ ...f.claim("source-id"), binding: input.sourceBinding })).toThrow(/distinct binding/u);
    expect(() => f.store.recordNativeSessionDerivation({ ...f.claim("wrong-hash"), expectedBodyHash: `sha256:${"0".repeat(64)}` })).toThrow();
    expect(() => f.store.recordNativeSessionDerivation({ ...f.claim("unowned-source"), sourceBinding: native("not-adopted") })).toThrow(/adoption authority/u);
    expect(f.store.listUnadoptedNativeSessionDerivations()).toEqual([first]);
  });

  it("records an exact late binding after source rebind/deletion, authorization revocation and effect failure", () => {
    const f = fixture();
    const input = f.claim("late");
    f.store.updateSession("source", { binding: native("replacement", 1), deletedAt: 50 });
    f.store.revokeConnection(f.connection.id);
    f.fail(input);
    const record = f.store.recordNativeSessionDerivation(input);
    expect(record.sourceBinding).toEqual(native("source"));
    expect(record.state).toBe("recorded");
    const claimed = f.store.claimNativeSessionDerivationCleanup({ operationId: input.operationId, expectedRevision: record.revision });
    expect(claimed.record.state).toBe("cleanup_claimed");
    expect(f.store.getOperation(input.operationId).status).toBe("failed");
  });

  it.each(["live", "deleted", "rebound"] as const)("protects a %s product's previously adopted binding without conversation events", (state) => {
    const f = fixture();
    const adopted = native("protected");
    f.store.createSession(f.descriptor("protected-product", adopted));
    if (state === "deleted") f.store.updateSession("protected-product", { deletedAt: 40 });
    if (state === "rebound") f.store.updateSession("protected-product", { binding: native("next", 1) });
    expect(() => f.store.recordNativeSessionDerivation({ ...f.claim(`collision-${state}`), binding: adopted })).toThrow(/adopted native binding/u);
    expect(f.store.listUnadoptedNativeSessionDerivations()).toEqual([]);
  });

  it("records binding updates and preserves their adoption across another rebind and restart", () => {
    const f = fixture();
    f.store.updateSession("source", { binding: native("middle", 1) });
    f.store.updateSession("source", { binding: native("latest", 2) });
    f.reopen();
    const input = f.claim("middle-collision");
    expect(() => f.store.recordNativeSessionDerivation({ ...input, binding: native("middle", 1) })).toThrow(/adopted native binding/u);
  });

  it("atomically adopts the child, receipt, history, event and operation response before publication", () => {
    const f = fixture();
    const input = f.claim("atomic");
    f.store.recordNativeSessionDerivation(input);
    const observed: string[] = [];
    f.store.subscribe((event) => {
      if (event.sessionId !== input.sessionId) return;
      observed.push(f.store.findNativeSessionDerivation(input.operationId)!.state);
      observed.push(f.store.getOperation(input.operationId).status);
    });
    const completed = f.complete(input, (store) => {
      const created = store.createSession(f.child(input), { derivationOperationId: input.operationId });
      store.appendEvent({ sessionId: created.descriptor.id, backendId: input.backendId, targetId: input.targetId,
        generation: input.binding.generation, operationId: input.operationId, traceId: "derived", payload: { type: "session_changed" } });
      return { sessionId: created.descriptor.id };
    });
    expect(observed).toEqual(["adopted", "completed"]);
    const receipt = f.store.findNativeSessionDerivation(input.operationId)!;
    expect(receipt.state).toBe("adopted");
    expect(receipt.revision).toBe(f.store.getSession(input.sessionId).revision);
    expect(receipt.revision).toBe(completed.operation.revision);
    expect(f.complete(input, () => { throw new Error("replay must not commit twice"); }).replayed).toBe(true);
    expect(() => f.store.claimNativeSessionDerivationCleanup({ operationId: input.operationId, expectedRevision: receipt.revision })).toThrow(/unadopted failed/u);
    f.store.updateSession(input.sessionId, { deletedAt: 60 });
    f.reopen();
    expect(f.store.findNativeSessionDerivation(input.operationId)?.state).toBe("adopted");
    expect(() => f.store.recordNativeSessionDerivation({ ...f.claim("adopted-collision"), binding: input.binding })).toThrow(/adopted native binding/u);
  });

  it("atomically replaces only the exact source binding under the authenticated navigation receipt", () => {
    const f = fixture();
    const input = f.claim("navigation", "navigate_session");
    const record = f.store.recordNativeSessionDerivation(input);
    expect(() => f.store.updateSession("source", { binding: input.binding }, undefined, Date.now(),
      { derivationOperationId: input.operationId })).toThrow(/authorized product transaction/u);
    expect(() => f.complete(input, (store) => {
      store.updateSession("source", { binding: input.binding }, undefined, Date.now(), { derivationOperationId: input.operationId });
      throw new Error("publication rollback");
    })).toThrow("publication rollback");
    expect(f.store.getSession("source").descriptor.binding).toEqual(input.sourceBinding);
    expect(f.store.findNativeSessionDerivation(input.operationId)).toEqual(record);
    const published: string[] = [];
    f.store.subscribe(() => { published.push(f.store.findNativeSessionDerivation(input.operationId)!.state); });
    f.complete(input, (store) => store.updateSession("source", { binding: input.binding }, undefined, Date.now(),
      { derivationOperationId: input.operationId }));
    expect(published).toEqual(["adopted"]);
    f.reopen();
    expect(f.store.getSession("source").descriptor.binding).toEqual(input.binding);
    expect(f.store.listSessions()).toHaveLength(1);
    expect(f.store.findNativeSessionDerivation(input.operationId)?.state).toBe("adopted");
    expect(f.complete(input, () => { throw new Error("no repeated adoption"); }).replayed).toBe(true);
  });

  it("records consecutive navigation receipts for one product while preserving each exact adoption", () => {
    const f = fixture();
    const first = f.claim("navigation-first", "navigate_session");
    f.store.recordNativeSessionDerivation(first);
    f.complete(first, (store) => store.updateSession("source", { binding: first.binding }, undefined, Date.now(),
      { derivationOperationId: first.operationId }));

    const secondClaim = f.claim("navigation-second", "navigate_session");
    const second = { ...secondClaim, binding: native("navigation-second", first.binding.generation + 1) };
    f.store.recordNativeSessionDerivation(second);
    f.complete(second, (store) => store.updateSession("source", { binding: second.binding }, undefined, Date.now(),
      { derivationOperationId: second.operationId }));

    expect(f.store.getSession("source").descriptor.binding).toEqual(second.binding);
    expect(f.store.findNativeSessionDerivation(first.operationId)).toMatchObject({
      sourceSessionId: "source",
      sessionId: "source",
      sourceBinding: native("source"),
      binding: first.binding,
      state: "adopted"
    });
    expect(f.store.findNativeSessionDerivation(second.operationId)).toMatchObject({
      sourceSessionId: "source",
      sessionId: "source",
      sourceBinding: first.binding,
      binding: second.binding,
      state: "adopted"
    });
    f.reopen();
    expect(f.store.getSession("source").descriptor.binding).toEqual(second.binding);
    expect(f.store.findNativeSessionDerivation(first.operationId)?.state).toBe("adopted");
    expect(f.store.findNativeSessionDerivation(second.operationId)?.state).toBe("adopted");
  });

  it.each(["wrong-product", "wrong-generation", "changed-source"] as const)("rejects %s navigation receipt authority", (boundary) => {
    const f = fixture();
    const input = f.claim("navigation-invalid", "navigate_session");
    if (boundary === "wrong-product") {
      expect(() => f.store.recordNativeSessionDerivation({ ...input, sessionId: "another-product" })).toThrow();
    } else if (boundary === "wrong-generation") {
      expect(() => f.store.recordNativeSessionDerivation({ ...input, binding: { ...input.binding, generation: 5 } })).toThrow();
    } else {
      f.store.recordNativeSessionDerivation(input);
      f.store.updateSession("source", { binding: native("moved-source", 1) });
      expect(() => f.complete(input, (store) => store.updateSession("source", { binding: input.binding }, undefined, Date.now(),
        { derivationOperationId: input.operationId }))).toThrow();
      expect(f.store.findNativeSessionDerivation(input.operationId)?.state).toBe("recorded");
    }
  });

  it("rolls back adoption and its history if any later part of the product transaction fails", () => {
    const f = fixture();
    const input = f.claim("rollback");
    const recorded = f.store.recordNativeSessionDerivation(input);
    expect(() => f.complete(input, (store) => {
      store.createSession(f.child(input), { derivationOperationId: input.operationId });
      throw new Error("final write failed");
    })).toThrow("final write failed");
    expect(() => f.store.getSession(input.sessionId)).toThrow();
    expect(f.store.findNativeSessionDerivation(input.operationId)).toEqual(recorded);
    expect(f.store.getOperation(input.operationId).status).toBe("started");
    f.fail(input);
    expect(f.store.claimNativeSessionDerivationCleanup({ operationId: input.operationId, expectedRevision: recorded.revision }).record.state).toBe("cleanup_claimed");
  });

  it("requires the owning completion transaction and exact descriptor before adopting a receipt", () => {
    const f = fixture();
    const input = f.claim("owner");
    f.store.recordNativeSessionDerivation(input);
    expect(() => f.store.createSession(f.child(input), { derivationOperationId: input.operationId })).toThrow(/authorized product transaction/u);
    expect(() => f.complete(input, (store) => store.createSession({ ...f.child(input), id: "wrong-child" }, { derivationOperationId: input.operationId }))).toThrow(/authorized product transaction/u);
    expect(() => f.complete(input, (store) => store.createSession({ ...f.child(input), derivationOrigin: { kind: "fork", sourceSessionId: "source" } }, { derivationOperationId: input.operationId }))).toThrow(/authorized product transaction/u);
    expect(f.store.findNativeSessionDerivation(input.operationId)?.state).toBe("recorded");
  });

  it("holds the native reservation against both create and rebind throughout cleanup and unknown outcome", async () => {
    const f = fixture();
    const input = f.claim("race");
    const record = f.store.recordNativeSessionDerivation(input);
    f.store.createSession(f.descriptor("competitor", native("competitor")));
    const compete = () => {
      expect(() => f.store.createSession(f.descriptor("competing-attach", input.binding))).toThrow(OperationInProgressError);
      expect(() => f.store.updateSession("competitor", { binding: { ...input.binding, generation: 1 } })).toThrow(OperationInProgressError);
    };
    compete();
    expect(() => f.store.claimNativeSessionDerivationCleanup({ operationId: input.operationId, expectedRevision: record.revision })).toThrow(/unadopted failed/u);
    f.fail(input);
    const claimed = f.store.claimNativeSessionDerivationCleanup({ operationId: input.operationId, expectedRevision: record.revision });
    await Promise.resolve(); // Another authenticated request can run during the native delete await.
    compete();
    const unknown = f.store.finishNativeSessionDerivationCleanup({ operationId: input.operationId, token: claimed.token,
      outcome: "cleanup_unknown", failureCode: "delete_timeout" });
    compete();
    expect(() => f.store.claimNativeSessionDerivationCleanup({ operationId: input.operationId, expectedRevision: unknown.revision })).toThrow(/unadopted failed/u);
    expect(f.store.getSession("competitor").descriptor.binding).toEqual(native("competitor"));
  });

  it("fences cleanup with receipt revision and a unique token, and confirms deletion idempotently", () => {
    const f = fixture();
    const input = f.claim("cleanup");
    const record = f.store.recordNativeSessionDerivation(input);
    f.fail(input);
    expect(() => f.store.claimNativeSessionDerivationCleanup({ operationId: input.operationId, expectedRevision: record.revision - 1n })).toThrow(RevisionConflictError);
    const claim = f.store.claimNativeSessionDerivationCleanup({ operationId: input.operationId, expectedRevision: record.revision });
    expect(() => f.store.confirmNativeSessionDerivationNativeCleanup({
      operationId: input.operationId,
      token: "wrong-owner"
    })).toThrow(/owner is stale/u);
    expect(() => f.store.finishNativeSessionDerivationCleanup({ operationId: input.operationId, token: "wrong-owner", outcome: "cleaned" })).toThrow(/owner is stale/u);
    const workspaceCleanup = f.store.confirmNativeSessionDerivationNativeCleanup({
      operationId: input.operationId,
      token: claim.token
    });
    expect(workspaceCleanup.state).toBe("workspace_cleanup_pending");
    expect(f.store.listUnadoptedNativeSessionDerivations()).toEqual([workspaceCleanup]);
    f.reopen();
    f.store.recoverStartup();
    expect(f.store.findNativeSessionDerivation(input.operationId)).toEqual(workspaceCleanup);
    const cleaned = f.store.finishNativeSessionDerivationCleanup({ operationId: input.operationId, token: claim.token, outcome: "cleaned" });
    const revision = f.store.health().revision;
    expect(f.store.finishNativeSessionDerivationCleanup({ operationId: input.operationId, token: claim.token, outcome: "cleaned" })).toEqual(cleaned);
    expect(f.store.health().revision).toBe(revision);
    expect(f.store.listUnadoptedNativeSessionDerivations()).toEqual([]);
    expect(() => f.store.claimNativeSessionDerivationCleanup({ operationId: input.operationId, expectedRevision: cleaned.revision })).toThrow();
    expect(() => f.store.recordNativeSessionDerivation({ ...f.claim("uuid-reused"), binding: input.binding })).toThrow(OperationInProgressError);
  });

  it("recovers only known recorded bindings and never retries a delete with an interrupted ACK", () => {
    const f = fixture();
    const recordedInput = f.claim("recorded");
    f.store.recordNativeSessionDerivation(recordedInput);
    const claimedInput = f.claim("claimed");
    const recorded = f.store.recordNativeSessionDerivation(claimedInput);
    f.fail(claimedInput);
    const claimed = f.store.claimNativeSessionDerivationCleanup({ operationId: claimedInput.operationId, expectedRevision: recorded.revision });
    const unknownInput = f.claim("no-uuid");
    f.reopen();
    f.store.recoverStartup();
    expect(f.store.getOperation(recordedInput.operationId).status).toBe("failed");
    expect(f.store.getOperation(unknownInput.operationId).status).toBe("failed");
    expect(f.store.findNativeSessionDerivation(unknownInput.operationId)).toBeUndefined();
    const retained = f.store.findNativeSessionDerivation(recordedInput.operationId)!;
    expect(retained.state).toBe("recorded");
    const interrupted = f.store.findNativeSessionDerivation(claimedInput.operationId)!;
    expect(interrupted).toMatchObject({ state: "cleanup_unknown", failureCode: "interrupted", cleanupToken: claimed.token });
    expect(() => f.store.finishNativeSessionDerivationCleanup({ operationId: claimedInput.operationId, token: claimed.token, outcome: "cleaned" })).toThrow(/owner is stale/u);
    expect(() => f.store.claimNativeSessionDerivationCleanup({ operationId: claimedInput.operationId, expectedRevision: interrupted.revision })).toThrow();
    expect(f.store.claimNativeSessionDerivationCleanup({ operationId: recordedInput.operationId, expectedRevision: retained.revision }).record.state).toBe("cleanup_claimed");
    expect(() => f.store.claimAuthorizedDeferredEffectOperation(f.connection.id, f.connection.authKeyDigest,
      { id: unknownInput.operationId, kind: "clone_session", body: { sourceSessionId: "source" } })).toThrow(OperationPreviouslyFailedError);
  });

  it("recovers an interrupted cleanup even when every operation is already failed", () => {
    const f = fixture();
    const input = f.claim("only-cleanup");
    const recorded = f.store.recordNativeSessionDerivation(input);
    f.fail(input);
    f.store.claimNativeSessionDerivationCleanup({ operationId: input.operationId, expectedRevision: recorded.revision });
    f.reopen();
    f.store.recoverStartup();
    expect(f.store.findNativeSessionDerivation(input.operationId)?.state).toBe("cleanup_unknown");
  });

  it("allows explicit reattachment after a product tombstone without granting derivation cleanup", () => {
    const f = fixture();
    const binding = native("existing");
    f.store.createSession(f.descriptor("existing-product", binding));
    f.store.updateSession("existing-product", { deletedAt: 30 });
    expect(f.store.createSession(f.descriptor("reattached-product", binding)).descriptor.binding).toEqual(binding);
    expect(() => f.store.recordNativeSessionDerivation({ ...f.claim("cannot-own"), binding })).toThrow(/adopted native binding/u);
  });
});

function native(id: string, generation = 0): NativeSessionBinding {
  return { opaqueRef: `native://${id}`, nativeSessionId: id, generation };
}

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "joko-derivation-store-"));
  const databasePath = path.join(directory, "operational.sqlite");
  let store = new OperationalStore(databasePath);
  cleanup.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.upsertBackend({ id: "native", adapterKind: "fixture", displayName: "Native", version: "1",
    instanceGeneration: 0, health: "healthy", installationState: "installed", authenticationState: "not_required",
    capabilities: new Map(), models: [], tools: [], diagnostics: [] });
  store.upsertTarget({ id: "workspace", backendId: "native", displayName: "Workspace", workspaceRoot: "D:/workspace",
    managed: false, trusted: true });
  const descriptor = (id: string, binding: NativeSessionBinding): SessionDescriptor => ({
    id, binding, backendId: "native", targetId: "workspace", title: id,
    pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false, createdAt: 1, updatedAt: 1
  });
  store.createSession(descriptor("source", native("source")));
  const connection = store.createConnection({ id: "client", name: "Client", authKeyDigest: "client-digest" });
  return {
    get store() { return store; }, connection, descriptor,
    reopen() { store.close(); store = new OperationalStore(databasePath); },
    claim(operationId: string, kind: "clone_session" | "navigate_session" = "clone_session"): RecordNativeSessionDerivationInput {
      const claim = store.claimAuthorizedDeferredEffectOperation(connection.id, connection.authKeyDigest,
        { id: operationId, kind, body: { sourceSessionId: "source" } });
      return { operationId, expectedBodyHash: claim.operation.bodyHash, sourceSessionId: "source",
        sourceBinding: store.getSession("source").descriptor.binding, sessionId: kind === "navigate_session" ? "source" : `child-${operationId}`,
        backendId: "native", backendInstanceGeneration: 0, targetId: "workspace", effectiveWorkspaceRoot: "D:/workspace",
        binding: native(operationId, kind === "navigate_session" ? 1 : 0) };
    },
    attempt(
      input: RecordNativeSessionDerivationInput,
      worktree?: PrepareNativeSessionDerivationInput["worktree"]
    ): PrepareNativeSessionDerivationInput {
      const exactWorktree = worktree ?? input.worktree;
      return {
        operationId: input.operationId,
        expectedBodyHash: input.expectedBodyHash,
        sourceSessionId: input.sourceSessionId,
        sourceBinding: input.sourceBinding,
        sourceSessionRevision: store.getSession(input.sourceSessionId).revision,
        sessionId: input.sessionId,
        backendId: input.backendId,
        backendInstanceGeneration: input.backendInstanceGeneration,
        targetId: input.targetId,
        targetRevision: store.getTarget(input.targetId).revision,
        effectiveWorkspaceRoot: input.effectiveWorkspaceRoot,
        ...(input.remoteWorkspace === undefined ? {} : { remoteWorkspace: input.remoteWorkspace }),
        ...(exactWorktree === undefined ? {} : { worktree: exactWorktree })
      };
    },
    child(input: RecordNativeSessionDerivationInput): SessionDescriptor {
      return { ...descriptor(input.sessionId, input.binding), derivationOrigin: { kind: "clone", sourceSessionId: input.sourceSessionId } };
    },
    fail(input: RecordNativeSessionDerivationInput) {
      store.failEffectOperation(input.operationId, input.expectedBodyHash, new Error("Derivation could not commit."));
    },
    complete<T>(input: RecordNativeSessionDerivationInput, commit: (store: OperationalStore) => T) {
      return store.completeAuthorizedDeferredEffectOperation(connection.id, connection.authKeyDigest, input.operationId, input.expectedBodyHash, commit);
    }
  };
}
