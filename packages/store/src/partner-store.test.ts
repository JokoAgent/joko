import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { PartnerStore } from "./partner-store.js";
import { PartnerStoreError, type PartnerCapabilitiesRecord } from "./partner-types.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("PartnerStore", () => {
  it("persists a strict profile, immutable versions, and directory counts across reopen", async () => {
    const fixture = await fileStore();
    const created = fixture.store.createPartner({
      expectedDirectoryRevision: 1n,
      id: "partner-one",
      homeTargetId: "partner-home-one",
      ...draft("Aster")
    });
    expect(created).toMatchObject({
      id: "partner-one",
      revision: 1n,
      profileVersion: 1,
      lifecycle: "active",
      initializationState: "pending",
      invitationStage: "home",
      usesDirectoryDefaults: false
    });
    const updated = fixture.store.updatePartner(created.id, created.revision, {
      identitySource: "You are Aster, a careful research partner.\r\n\r\nUse evidence carefully.",
      capabilities: { ...capabilities(), planMode: true }
    });
    expect(updated).toMatchObject({ revision: 2n, profileVersion: 2, initializationState: "pending" });
    expect(updated.identitySource).toBe("You are Aster, a careful research partner.\n\nUse evidence carefully.");
    expect(fixture.store.listProfileVersions(created.id).map((item) => item.version)).toEqual([2, 1]);
    expect(fixture.store.directoryState()).toMatchObject({ revision: 3n, activeCount: 1, archivedCount: 0 });

    fixture.store.close();
    const reopened = new PartnerStore(fixture.path);
    cleanups.push(async () => reopened.close());
    expect(reopened.getPartner(created.id)).toEqual(updated);
    expect(reopened.listProfileVersions(created.id)).toHaveLength(2);
  });

  it("keeps active and archived names unique while allowing reuse after a soft delete", () => {
    const store = memoryStore(["one", "two", "three"]);
    const first = store.createPartner({ expectedDirectoryRevision: 1n, ...draft("Nova") });
    expectStoreError(
      () => store.createPartner({ expectedDirectoryRevision: 2n, ...draft("  NOva  ") }),
      "PARTNER_NAME_CONFLICT"
    );
    const archived = store.setLifecycle(first.id, first.revision, "archived");
    expectStoreError(
      () => store.createPartner({ expectedDirectoryRevision: 3n, ...draft("nova") }),
      "PARTNER_NAME_CONFLICT"
    );
    const deleted = store.setLifecycle(first.id, archived.revision, "deleted");
    expect(deleted.lifecycle).toBe("deleted");
    const replacement = store.createPartner({ expectedDirectoryRevision: 4n, ...draft("nova") });
    expect(replacement.id).not.toBe(first.id);
  });

  it("revision-fences profile edits, lifecycle changes, and initialization retries", () => {
    const store = memoryStore(["one"]);
    const created = store.createPartner({ expectedDirectoryRevision: 1n, ...draft("Mica") });
    expectStoreError(() => store.updatePartner(created.id, 9n, { displayName: "Other" }), "PARTNER_CHANGED");
    const archived = store.setLifecycle(created.id, created.revision, "archived");
    expectStoreError(() => store.prepareInitialization(created.id, created.revision), "PARTNER_CHANGED");
    const active = store.setLifecycle(created.id, archived.revision, "active");
    const pending = store.prepareInitialization(active.id, active.revision);
    const failed = store.failInitialization(pending.id, pending.revision, "session_unavailable");
    expect(failed).toMatchObject({ initializationState: "error", invitationStage: "failed", initializationErrorCode: "session_unavailable" });
    const retry = store.prepareInitialization(failed.id, failed.revision);
    expect(retry).toMatchObject({ initializationState: "pending", invitationStage: "home" });
  });

  it("binds exactly one canonical Session and refuses cross-partner reuse", () => {
    const store = memoryStore(["one", "two"]);
    const first = store.createPartner({ expectedDirectoryRevision: 1n, ...draft("Aster") });
    const second = store.createPartner({ expectedDirectoryRevision: 2n, ...draft("Beryl") });
    const bound = store.bindCanonicalSession({
      partnerId: first.id,
      expectedRevision: first.revision,
      expectedProfileVersion: first.profileVersion,
      sessionId: "session-one"
    });
    expect(bound).toMatchObject({ initializationState: "pending", invitationStage: "session" });
    const ready = store.markReady(bound.id, bound.revision);
    expect(ready).toMatchObject({
      canonicalSessionId: "session-one",
      initializationState: "ready",
      invitationStage: "ready"
    });
    expect(store.findPartnerByCanonicalSession("session-one")?.id).toBe(first.id);
    expectStoreError(() => store.bindCanonicalSession({
      partnerId: second.id,
      expectedRevision: second.revision,
      expectedProfileVersion: second.profileVersion,
      sessionId: "session-one"
    }), "PARTNER_SESSION_CONFLICT");
    expectStoreError(() => store.bindCanonicalSession({
      partnerId: first.id,
      expectedRevision: ready.revision,
      expectedProfileVersion: ready.profileVersion,
      sessionId: "session-other"
    }), "PARTNER_SESSION_CONFLICT");
    const replaced = store.replaceCanonicalSession({
      partnerId: first.id,
      expectedRevision: ready.revision,
      expectedProfileVersion: ready.profileVersion,
      expectedCanonicalSessionId: "session-one",
      sessionId: "session-recovered"
    });
    expect(replaced).toMatchObject({
      canonicalSessionId: "session-recovered",
      initializationState: "pending",
      invitationStage: "session"
    });
  });

  it("validates model chains and rolls back rejected creation without advancing the directory", () => {
    const store = memoryStore(["one"]);
    expectStoreError(() => store.createPartner({
      expectedDirectoryRevision: 1n,
      ...draft("Aster"),
      capabilities: {
        ...capabilities(),
        modelChain: [
          route("backend-one", "provider-one", "model-one"),
          route("backend-two", "provider-two", "model-two")
        ]
      }
    }), "PARTNER_INVALID");
    expect(store.directoryState()).toMatchObject({ revision: 1n, activeCount: 0 });
    expect(store.listPartners()).toEqual([]);
  });

  it("applies revision-fenced directory defaults atomically while preserving explicit overrides", () => {
    const store = memoryStore(["one", "two"]);
    const firstDefaults = capabilities();
    expect(store.setDirectoryDefaults(1n, firstDefaults)).toEqual([]);
    const inherited = store.createPartner({
      expectedDirectoryRevision: 2n,
      ...draft("Aster"),
      usesDirectoryDefaults: true
    });
    const explicit = store.createPartner({ expectedDirectoryRevision: 3n, ...draft("Beryl") });
    const nextDefaults = {
      ...firstDefaults,
      modelChain: [route("backend-one", "provider-one", "model-two")],
      planMode: true
    } as const;
    const changed = store.setDirectoryDefaults(4n, nextDefaults);
    expect(changed).toHaveLength(1);
    expect(store.getPartner(inherited.id)).toMatchObject({
      revision: 2n,
      profileVersion: 2,
      usesDirectoryDefaults: true,
      capabilities: nextDefaults,
      initializationState: "pending"
    });
    expect(store.getPartner(explicit.id)).toEqual(explicit);
    expect(store.directoryState()).toMatchObject({ revision: 5n, defaultCapabilities: nextDefaults });
    expectStoreError(() => store.setDirectoryDefaults(4n, nextDefaults), "PARTNER_DIRECTORY_CHANGED");
  });

  it("fails closed on an incompatible schema baseline", async () => {
    const fixture = await fileStore();
    fixture.store.close();
    const database = new DatabaseSync(fixture.path);
    database.prepare("UPDATE partner_schema_version SET baseline_id = ? WHERE singleton = 1").run("0".repeat(64));
    database.close();
    expect(() => new PartnerStore(fixture.path)).toThrowError(PartnerStoreError);
  });

  it("preserves canonical Session history and advances read state monotonically", () => {
    const store = memoryStore(["partner-one"]);
    const ready = readyPartner(store, "partner-one", "Aster", "session-one");
    const replaced = store.replaceCanonicalSession({
      partnerId: ready.id,
      expectedRevision: ready.revision,
      expectedProfileVersion: ready.profileVersion,
      expectedCanonicalSessionId: "session-one",
      sessionId: "session-two"
    });

    expect(store.listSessionLinks(ready.id)).toEqual([
      expect.objectContaining({ sessionId: "session-two", partnerId: ready.id, role: "canonical" }),
      expect.objectContaining({ sessionId: "session-one", partnerId: ready.id, role: "history" })
    ]);
    expect(store.findPartnerBySession("session-one")?.id).toBe(ready.id);
    expect(store.findPartnerBySession("session-two")?.id).toBe(ready.id);
    expect(replaced.canonicalSessionId).toBe("session-two");
    expect(store.markRead(ready.id, 8n).throughCursor).toBe(8n);
    expect(store.markRead(ready.id, 3n).throughCursor).toBe(8n);
  });

  it("reserves bounded private messages before delivery and releases failed reservations", () => {
    let now = 10_000;
    const ids = ["thread-one", "message-one", "message-two", "message-three", "thread-two", "message-four"];
    const store = new PartnerStore(":memory:", {
      now: () => now,
      idFactory: () => ids.shift() ?? "fallback-id"
    });
    cleanups.push(async () => store.close());
    const first = readyPartner(store, "partner-one", "Aster", "session-one");
    const second = readyPartner(store, "partner-two", "Beryl", "session-two");

    const firstMessage = store.reservePrivateMessage({
      senderPartnerId: first.id,
      recipientPartnerId: second.id,
      senderSessionId: "session-one",
      recipientSessionId: "session-two",
      content: "Please inspect the failing boundary."
    });
    expect(firstMessage).toMatchObject({
      remainingMessages: 11,
      conversationEnded: false,
      message: { deliveryStatus: "pending", sequence: 1 },
      thread: { status: "active", messageCount: 1, maxMessages: 12 }
    });
    expect(store.listPendingPrivateMessages()).toHaveLength(1);
    expect(store.markPrivateMessageDelivered(firstMessage.message.id, "run-one"))
      .toMatchObject({ deliveryStatus: "delivered", runId: "run-one" });

    const secondMessage = store.reservePrivateMessage({
      senderPartnerId: first.id,
      recipientPartnerId: second.id,
      senderSessionId: "session-one",
      recipientSessionId: "session-two",
      content: "One additional detail."
    });
    expectStoreError(() => store.reservePrivateMessage({
      senderPartnerId: first.id,
      recipientPartnerId: second.id,
      senderSessionId: "session-one",
      recipientSessionId: "session-two",
      content: "This third consecutive message must wait."
    }), "PARTNER_PRIVATE_WAIT");
    expect(store.markPrivateMessageFailed(secondMessage.message.id, "Target queue rejected the input."))
      .toMatchObject({ deliveryStatus: "failed" });
    expect(store.getPrivateThread(firstMessage.thread.id, first.id).messages).toHaveLength(1);

    expect(store.markPrivateThreadRead(firstMessage.thread.id, first.id, 1).throughSequence).toBe(1);
    expect(store.markPrivateThreadRead(firstMessage.thread.id, first.id, 0).throughSequence).toBe(1);
    now += 15 * 60_000;
    expect(store.listPrivateThreads(first.id)).toContainEqual(expect.objectContaining({
      id: firstMessage.thread.id,
      status: "closed",
      closeReason: "idle_timeout"
    }));
    const afterIdle = store.reservePrivateMessage({
      senderPartnerId: second.id,
      recipientPartnerId: first.id,
      senderSessionId: "session-two",
      recipientSessionId: "session-one",
      content: "Starting a fresh round after the idle boundary."
    });
    expect(afterIdle.thread.id).not.toBe(firstMessage.thread.id);
    expect(store.getPrivateThread(firstMessage.thread.id).thread).toMatchObject({
      status: "closed",
      closeReason: "idle_timeout"
    });
  });

  it("replays a stable private-message reservation without consuming another slot", () => {
    const store = memoryStore(["thread-one", "unused"]);
    const first = readyPartner(store, "partner-one", "Aster", "session-one");
    const second = readyPartner(store, "partner-two", "Beryl", "session-two");
    const input = {
      id: "message-stable",
      senderPartnerId: first.id,
      recipientPartnerId: second.id,
      senderSessionId: "session-one",
      recipientSessionId: "session-two",
      content: "Deliver this exactly once."
    } as const;

    const reserved = store.reservePrivateMessage(input);
    const replay = store.reservePrivateMessage(input);

    expect(replay).toEqual(reserved);
    expect(store.getPrivateThread(reserved.thread.id, first.id).messages).toEqual([reserved.message]);
    expectStoreError(() => store.reservePrivateMessage({ ...input, content: "Different body." }), "PARTNER_INVALID");
  });

  it("persists revision-fenced delegation recovery and target Session ownership", () => {
    const store = memoryStore(["generated"]);
    const requester = readyPartner(store, "partner-one", "Aster", "session-one");
    const target = readyPartner(store, "partner-two", "Beryl", "session-two");
    const created = store.createDelegation({
      id: "delegation-one",
      requesterPartnerId: requester.id,
      targetPartnerId: target.id,
      parentSessionId: "session-one",
      title: "Inspect retry safety",
      objective: "Inspect the retry path and report concrete evidence."
    });
    expect(store.listRecoverableDelegations()).toEqual([created]);
    const bound = store.bindDelegationSession(created.id, created.revision, "session-child");
    expect(store.getSessionLink("session-child")).toMatchObject({
      partnerId: target.id,
      role: "delegation",
      delegationId: created.id,
      parentSessionId: "session-one"
    });
    expectStoreError(
      () => store.transitionDelegation({ delegationId: created.id, expectedRevision: created.revision, status: "queued" }),
      "PARTNER_DELEGATION_CHANGED"
    );
    expectStoreError(
      () => store.transitionDelegation({ delegationId: bound.id, expectedRevision: bound.revision, status: "queued" }),
      "PARTNER_INVALID"
    );
    const queued = store.transitionDelegation({
      delegationId: bound.id,
      expectedRevision: bound.revision,
      status: "queued",
      runId: "run-child"
    });
    const running = store.transitionDelegation({
      delegationId: queued.id,
      expectedRevision: queued.revision,
      status: "running"
    });
    const completed = store.transitionDelegation({
      delegationId: running.id,
      expectedRevision: running.revision,
      status: "completed",
      resultSummary: "The retry path is idempotent."
    });
    expect(completed).toMatchObject({
      status: "completed",
      childSessionId: "session-child",
      runId: "run-child",
      resultSummary: "The retry path is idempotent."
    });
    expect(store.createDelegation({
      id: "delegation-one",
      requesterPartnerId: requester.id,
      targetPartnerId: target.id,
      parentSessionId: "session-one",
      title: "Inspect retry safety",
      objective: "Inspect the retry path and report concrete evidence."
    })).toEqual(completed);
    expect(store.listRecoverableDelegations()).toEqual([]);
  });
});

function capabilities(): PartnerCapabilitiesRecord {
  return {
    modelChain: [route("backend-one", "provider-one", "model-one")],
    permissionMode: "ask",
    planMode: false
  };
}

function route(backendId: string, providerId: string, modelId: string) {
  return { backendId, providerId, modelId, effort: "medium", fastMode: false } as const;
}

function draft(displayName: string) {
  return {
    displayName,
    avatar: "orbit",
    identitySource: `You are ${displayName.trim()}, a long-lived work partner.`,
    templateId: "general",
    capabilities: capabilities(),
    usesDirectoryDefaults: false
  } as const;
}

function readyPartner(
  store: PartnerStore,
  id: string,
  displayName: string,
  sessionId: string
) {
  const created = store.createPartner({
    expectedDirectoryRevision: store.directoryState().revision,
    id,
    homeTargetId: `home-${id}`,
    ...draft(displayName)
  });
  const bound = store.bindCanonicalSession({
    partnerId: created.id,
    expectedRevision: created.revision,
    expectedProfileVersion: created.profileVersion,
    sessionId
  });
  return store.markReady(bound.id, bound.revision);
}

function memoryStore(ids: string[]): PartnerStore {
  let index = 0;
  const store = new PartnerStore(":memory:", { now: () => 1_000 + index, idFactory: () => ids[index++] ?? `id-${index}` });
  cleanups.push(async () => store.close());
  return store;
}

async function fileStore(): Promise<{ readonly store: PartnerStore; readonly path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "joko-partner-store-"));
  const path = join(directory, "partners.db");
  const store = new PartnerStore(path, { now: () => 1_000 });
  cleanups.push(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { store, path };
}

function expectStoreError(action: () => unknown, code: PartnerStoreError["code"]): void {
  try {
    action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(PartnerStoreError);
    expect((error as PartnerStoreError).code).toBe(code);
  }
}
