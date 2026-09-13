import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { NativeSessionBinding, SessionDescriptor } from "@joko/core";
import { afterEach, describe, expect, it } from "vitest";

import { OperationalStore, OperationInProgressError, OperationPreviouslyFailedError,
  RevisionConflictError, type RecordNativeSessionDerivationInput } from "./index.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

describe("native derivation receipts", () => {
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
    expect(() => f.store.finishNativeSessionDerivationCleanup({ operationId: input.operationId, token: "wrong-owner", outcome: "cleaned" })).toThrow(/owner is stale/u);
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
