import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, stat, truncate, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLAUDE_SESSION_STORE_LIMITS,
  ClaudeSessionStoreError,
  adoptClaudeSessionStoreChild,
  claimClaudeSessionStoreSession,
  cleanupClaudeSessionStoreOperation,
  createClaudeDurableSessionStore,
  createClaudeSessionStoreAuthority,
  createClaudeSessionStoreSessionAccess,
  createClaudeSessionStoreWorkspaceAccess,
  discardClaudeSessionStoreImport,
  prepareClaudeSessionStoreDerivation,
  prepareClaudeSessionStoreImport,
  readClaudeSessionStoreOperation,
  recoverClaudeSessionStoreOperation,
  rebindClaudeSessionStoreGeneration,
  sealClaudeSessionStoreImport,
  type ClaudeSessionStoreAuthority,
  type ClaudeSessionStoreOperationAccess,
  type ClaudeSessionStoreSessionAccess
} from "./claude-session-store.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ClaudeDurableSessionStore", () => {
  it("constructs exact access discriminants even from untrusted serializable objects", () => {
    const sessionId = randomUUID();
    const session = createClaudeSessionStoreSessionAccess({
      generation: 1,
      workspaceAuthority: "workspace.exact-session",
      sessionId,
      kind: "workspace"
    } as Parameters<typeof createClaudeSessionStoreSessionAccess>[0]);
    const workspace = createClaudeSessionStoreWorkspaceAccess({
      generation: 1,
      workspaceAuthority: "workspace.exact-workspace",
      kind: "session",
      sessionId
    } as Parameters<typeof createClaudeSessionStoreWorkspaceAccess>[0]);
    expect(session).toEqual({
      kind: "session",
      generation: 1,
      workspaceAuthority: "workspace.exact-session",
      sessionId
    });
    expect(workspace).toEqual({
      kind: "workspace",
      generation: 1,
      workspaceAuthority: "workspace.exact-workspace"
    });
  });

  it("round-trips opaque entries, captures operation-local SDK keys and durably reserves before ack", async () => {
    const fixture = await createFixture();
    const operation = prepareClaudeSessionStoreImport(fixture.authority, {
      operationId: randomUUID(),
      sourceWorkspaceAuthority: "workspace.source",
      sourceSessionId: fixture.sourceSessionId,
      targetWorkspaceAuthority: "workspace.target"
    });
    const sourceKey = { projectKey: "sdk-source-key", sessionId: fixture.sourceSessionId };
    const uuidEntry = {
      type: "user",
      uuid: randomUUID(),
      timestamp: "2026-09-26T00:00:00.000Z",
      message: { content: [{ text: "private body", type: "text" }], role: "user" },
      extra: [null, true, 3]
    };
    const marker = { type: "mode", mode: "plan" };
    const importer = createClaudeDurableSessionStore(fixture.authority, operation);
    await importer.append(sourceKey, [uuidEntry, marker]);
    await importer.append(sourceKey, [{ ...uuidEntry }, marker]);
    await expect(importer.load(sourceKey)).rejects.toMatchObject({ code: "OPERATION_NOT_READY" });
    await expect(importer.append(
      { ...sourceKey, subpath: "subagents/agent-private" },
      [{ type: "assistant" }]
    )).rejects.toMatchObject({ code: "INVALID_KEY" });
    sealClaudeSessionStoreImport(fixture.authority, operation);

    const targetKey = { projectKey: "sdk-target-key", sessionId: fixture.sourceSessionId };
    const first = await importer.load(targetKey);
    expect(first).toEqual([uuidEntry, marker, marker]);
    (first?.[0] as { message?: unknown }).message = "mutated snapshot";
    expect(await importer.load(targetKey)).toEqual([uuidEntry, marker, marker]);
    await expect(importer.load({ ...targetKey, projectKey: "wrong-target-key" })).rejects.toMatchObject({
      code: "INVALID_KEY"
    });

    const childSessionId = randomUUID();
    let releaseReservation!: () => void;
    let reservationStarted!: () => void;
    const started = new Promise<void>((resolve) => { reservationStarted = resolve; });
    const reservationGate = new Promise<void>((resolve) => { releaseReservation = resolve; });
    const forkStore = createClaudeDurableSessionStore(fixture.authority, operation, {
      onChildReserved: async (reservation) => {
        expect(reservation).toEqual({
          operationId: operation.operationId,
          generation: 1,
          targetWorkspaceAuthority: "workspace.target",
          sessionId: childSessionId
        });
        reservationStarted();
        await reservationGate;
      }
    });
    let appendSettled = false;
    const append = forkStore.append(
      { projectKey: targetKey.projectKey, sessionId: childSessionId },
      [{ type: "user", uuid: randomUUID(), nested: { preserved: "yes" } }]
    ).then(() => { appendSettled = true; });
    await started;
    expect(appendSettled).toBe(false);
    expect(readClaudeSessionStoreOperation(fixture.authority, operation)).toMatchObject({
      state: "child_pending",
      childSessionId,
      childReservationConfirmed: false
    });
    expect(await forkStore.load({ projectKey: targetKey.projectKey, sessionId: childSessionId })).toHaveLength(1);
    releaseReservation();
    await append;
    expect(readClaudeSessionStoreOperation(fixture.authority, operation)).toMatchObject({
      state: "child_reserved",
      childSessionId,
      childReservationConfirmed: true
    });

    const adopted = adoptClaudeSessionStoreChild(fixture.authority, operation, childSessionId);
    expect(adoptClaudeSessionStoreChild(fixture.authority, operation, childSessionId)).toEqual(adopted);
    await expect(forkStore.load({ projectKey: targetKey.projectKey, sessionId: childSessionId }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    importer.close();
    forkStore.close();
    expect(await operationStagingCount(fixture.root, operation.operationId)).toBe(0);
    const reopened = createClaudeDurableSessionStore(fixture.authority, adopted);
    expect(await reopened.load({ projectKey: targetKey.projectKey, sessionId: childSessionId })).toHaveLength(1);
    await reopened.append(
      { projectKey: targetKey.projectKey, sessionId: childSessionId, subpath: "subagents/agent-one" },
      [{ type: "assistant", uuid: randomUUID(), opaque: { answer: 42 } }]
    );
    expect(await reopened.listSubkeys({ projectKey: targetKey.projectKey, sessionId: childSessionId }))
      .toEqual(["subagents/agent-one"]);
    expect(adoptClaudeSessionStoreChild(fixture.authority, operation, childSessionId)).toEqual(adopted);
    reopened.close();
  });

  it("does not adopt a reserved child whose durable transcript is corrupt", async () => {
    const fixture = await createFixture();
    const operation = prepareClaudeSessionStoreImport(fixture.authority, {
      operationId: randomUUID(),
      sourceWorkspaceAuthority: "workspace.adopt-source",
      sourceSessionId: fixture.sourceSessionId,
      targetWorkspaceAuthority: "workspace.adopt-target"
    });
    const store = createClaudeDurableSessionStore(fixture.authority, operation, {
      onChildReserved: async () => undefined
    });
    await store.append(
      { projectKey: "adopt-source", sessionId: fixture.sourceSessionId },
      [{ type: "user", uuid: randomUUID() }]
    );
    sealClaudeSessionStoreImport(fixture.authority, operation);
    await store.load({ projectKey: "adopt-target", sessionId: fixture.sourceSessionId });
    const childSessionId = randomUUID();
    await store.append(
      { projectKey: "adopt-target", sessionId: childSessionId },
      [{ type: "assistant", uuid: randomUUID(), value: "must remain reserved" }]
    );
    store.close();
    const database = new DatabaseSync(await onlyDatabasePath(fixture.root));
    database.prepare("DELETE FROM session_entries WHERE workspace_authority = ? AND session_id = ?")
      .run(operation.target.workspaceAuthority, childSessionId);
    database.close();

    expect(() => adoptClaudeSessionStoreChild(fixture.authority, operation, childSessionId)).toThrowError(
      expect.objectContaining({ code: "CORRUPT" })
    );
    expect(readClaudeSessionStoreOperation(fixture.authority, operation)).toMatchObject({
      state: "child_reserved",
      childSessionId
    });
    expect(await operationStagingCount(fixture.root, operation.operationId)).toBe(1);
  });

  it("supports derived-to-derived sources, exact child deletion and generation CAS rebind", async () => {
    const fixture = await createFixture();
    const first = await createAdoptedChild(fixture, "workspace.one", "project-one");
    const secondOperation = prepareClaudeSessionStoreDerivation(fixture.authority, {
      operationId: randomUUID(),
      sourceWorkspaceAuthority: "workspace.one",
      sourceSessionId: first.sessionId,
      targetWorkspaceAuthority: "workspace.two"
    });
    const bridge = createClaudeDurableSessionStore(fixture.authority, secondOperation, {
      onChildReserved: async () => undefined
    });
    const alias = { projectKey: "project-two", sessionId: first.sessionId };
    const sourceBefore = await bridge.load(alias);
    const secondSessionId = randomUUID();
    await bridge.append(
      { projectKey: alias.projectKey, sessionId: secondSessionId },
      [{ type: "user", uuid: randomUUID(), value: "second" }]
    );
    expect(await bridge.load(alias)).toEqual(sourceBefore);
    await bridge.delete({ projectKey: alias.projectKey, sessionId: secondSessionId });
    expect(readClaudeSessionStoreOperation(fixture.authority, secondOperation).state).toBe("cleaned");
    await expect(bridge.load(alias)).rejects.toMatchObject({ code: "NOT_FOUND" });
    bridge.close();

    const mutableOldAccess = {
      kind: "session" as const,
      generation: first.access.generation,
      workspaceAuthority: first.access.workspaceAuthority,
      sessionId: first.access.sessionId
    };
    const oldStore = createClaudeDurableSessionStore(fixture.authority, mutableOldAccess);
    expect(await oldStore.load({ projectKey: "project-one", sessionId: first.sessionId })).toHaveLength(1);
    const nextAuthority = createClaudeSessionStoreAuthority({
      rootDirectory: fixture.root,
      namespace: "test-owner",
      generation: 2
    });
    const rebound = rebindClaudeSessionStoreGeneration(nextAuthority, {
      workspaceAuthority: "workspace.one",
      sessionId: first.sessionId,
      expectedGeneration: 1
    });
    mutableOldAccess.generation = 2;
    await expect(oldStore.load({ projectKey: "project-one", sessionId: first.sessionId }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    await expect(oldStore.append(
      { projectKey: "project-one", sessionId: first.sessionId },
      [{ type: "mode", value: "stale-writer" }]
    )).rejects.toMatchObject({ code: "CONFLICT" });
    oldStore.close();
    const newStore = createClaudeDurableSessionStore(nextAuthority, rebound);
    expect(await newStore.load({ projectKey: "project-one", sessionId: first.sessionId })).toHaveLength(1);
    await newStore.append(
      { projectKey: "project-one", sessionId: first.sessionId },
      [{ type: "mode", value: "after-restart" }]
    );
    expect(await newStore.load({ projectKey: "project-one", sessionId: first.sessionId })).toHaveLength(2);
    expect(() => rebindClaudeSessionStoreGeneration(fixture.authority, {
      workspaceAuthority: "workspace.one",
      sessionId: first.sessionId,
      expectedGeneration: 2
    })).toThrowError(expect.objectContaining({ code: "CONFLICT" }));
    newStore.close();
  });

  it("claims adopted sessions by Store-discovered generation and rejects future or corrupt state", async () => {
    const fixture = await createFixture();
    const child = await createAdoptedChild(fixture, "workspace.claim", "project-claim");
    const nextAuthority = createClaudeSessionStoreAuthority({
      rootDirectory: fixture.root,
      namespace: "test-owner",
      generation: 2
    });

    const claimed = claimClaudeSessionStoreSession(nextAuthority, {
      workspaceAuthority: child.access.workspaceAuthority,
      sessionId: child.sessionId
    });
    expect(claimed).toEqual({
      kind: "session",
      generation: 2,
      workspaceAuthority: child.access.workspaceAuthority,
      sessionId: child.sessionId
    });
    expect(claimClaudeSessionStoreSession(nextAuthority, {
      workspaceAuthority: child.access.workspaceAuthority,
      sessionId: child.sessionId
    })).toEqual(claimed);
    expect(() => claimClaudeSessionStoreSession(fixture.authority, {
      workspaceAuthority: child.access.workspaceAuthority,
      sessionId: child.sessionId
    })).toThrowError(expect.objectContaining({ code: "CONFLICT" }));

    const claimedStore = createClaudeDurableSessionStore(nextAuthority, claimed);
    expect(await claimedStore.load({ projectKey: "project-claim", sessionId: child.sessionId })).toHaveLength(1);
    claimedStore.close();
    const thirdAuthority = createClaudeSessionStoreAuthority({
      rootDirectory: fixture.root,
      namespace: "test-owner",
      generation: 3
    });
    const recovered = recoverClaudeSessionStoreOperation(thirdAuthority, {
      operationId: child.operation.operationId,
      targetWorkspaceAuthority: child.operation.target.workspaceAuthority,
      expectedChildSessionId: child.sessionId
    });
    expect(recovered.generation).toBe(3);
    expect(readClaudeSessionStoreOperation(thirdAuthority, recovered).state).toBe("adopted");

    const deletedBeforeCleanup = await createAdoptedChild(
      fixture,
      "workspace.claim-delete-first",
      "project-claim-delete-first"
    );
    const deleteFirstStore = createClaudeDurableSessionStore(fixture.authority, deletedBeforeCleanup.access);
    await deleteFirstStore.delete({
      projectKey: "project-claim-delete-first",
      sessionId: deletedBeforeCleanup.sessionId
    });
    deleteFirstStore.close();
    const recoveredAfterDelete = recoverClaudeSessionStoreOperation(nextAuthority, {
      operationId: deletedBeforeCleanup.operation.operationId,
      targetWorkspaceAuthority: deletedBeforeCleanup.operation.target.workspaceAuthority,
      expectedChildSessionId: deletedBeforeCleanup.sessionId
    });
    expect(readClaudeSessionStoreOperation(nextAuthority, recoveredAfterDelete).state).toBe("adopted");
    expect(cleanupClaudeSessionStoreOperation(nextAuthority, recoveredAfterDelete, {
      expectedChildSessionId: deletedBeforeCleanup.sessionId
    }).state).toBe("cleaned");

    const corrupt = await createAdoptedChild(fixture, "workspace.claim-corrupt", "project-claim-corrupt");
    const database = new DatabaseSync(await onlyDatabasePath(fixture.root));
    database.prepare(`
      UPDATE session_entries SET entry_digest = ?
      WHERE workspace_authority = ? AND session_id = ?
    `).run("0".repeat(64), corrupt.access.workspaceAuthority, corrupt.sessionId);
    database.close();
    expect(() => claimClaudeSessionStoreSession(nextAuthority, {
      workspaceAuthority: corrupt.access.workspaceAuthority,
      sessionId: corrupt.sessionId
    })).toThrowError(expect.objectContaining({ code: "CORRUPT" }));
  });

  it("recovers old-generation operations and explicitly cleans every durable state", async () => {
    const fixture = await createFixture();
    const states = [
      "importing",
      "ready",
      "aliased",
      "child_pending",
      "child_reserved",
      "adopted"
    ] as const;
    const operations: Array<{
      access: ClaudeSessionStoreOperationAccess;
      state: typeof states[number] | "durable_ready";
      childSessionId?: string;
    }> = [];

    for (const [index, state] of states.entries()) {
      const access = prepareClaudeSessionStoreImport(fixture.authority, {
        operationId: randomUUID(),
        sourceWorkspaceAuthority: `workspace.recover-source-${index}`,
        sourceSessionId: randomUUID(),
        targetWorkspaceAuthority: `workspace.recover-target-${index}`
      });
      const store = createClaudeDurableSessionStore(fixture.authority, access, {
        onChildReserved: state === "child_pending"
          ? async () => { throw new Error("registration unavailable"); }
          : async () => undefined
      });
      await store.append(
        { projectKey: `recover-source-${index}`, sessionId: access.source.sessionId },
        [{ type: "user", uuid: randomUUID(), marker: state }]
      );
      if (state !== "importing") {
        sealClaudeSessionStoreImport(fixture.authority, access);
      }
      if (!["importing", "ready"].includes(state)) {
        await store.load({ projectKey: `recover-target-${index}`, sessionId: access.source.sessionId });
      }
      let childSessionId: string | undefined;
      if (["child_pending", "child_reserved", "adopted"].includes(state)) {
        childSessionId = randomUUID();
        const append = store.append(
          { projectKey: `recover-target-${index}`, sessionId: childSessionId },
          [{ type: "assistant", uuid: randomUUID(), marker: state }]
        );
        if (state === "child_pending") {
          await expect(append).rejects.toMatchObject({ code: "RESERVATION_FAILED", stateMayHaveChanged: true });
        } else {
          await append;
        }
        if (state === "adopted") {
          adoptClaudeSessionStoreChild(fixture.authority, access, childSessionId);
        }
      }
      store.close();
      operations.push({ access, state, ...(childSessionId === undefined ? {} : { childSessionId }) });
    }

    const durableSource = await createAdoptedChild(
      fixture,
      "workspace.recover-durable-source",
      "recover-durable-source"
    );
    operations.push({
      access: prepareClaudeSessionStoreDerivation(fixture.authority, {
        operationId: randomUUID(),
        sourceWorkspaceAuthority: durableSource.access.workspaceAuthority,
        sourceSessionId: durableSource.sessionId,
        targetWorkspaceAuthority: "workspace.recover-durable-target"
      }),
      state: "durable_ready"
    });

    const nextAuthority = createClaudeSessionStoreAuthority({
      rootDirectory: fixture.root,
      namespace: "test-owner",
      generation: 2
    });
    const first = operations[0]!;
    expect(() => recoverClaudeSessionStoreOperation(nextAuthority, {
      operationId: first.access.operationId,
      targetWorkspaceAuthority: "workspace.wrong"
    })).toThrowError(expect.objectContaining({ code: "INVALID_ACCESS" }));
    expect(() => recoverClaudeSessionStoreOperation(nextAuthority, {
      operationId: randomUUID(),
      targetWorkspaceAuthority: first.access.target.workspaceAuthority
    })).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));

    for (const operation of operations) {
      if (operation.childSessionId !== undefined) {
        expect(() => recoverClaudeSessionStoreOperation(nextAuthority, {
          operationId: operation.access.operationId,
          targetWorkspaceAuthority: operation.access.target.workspaceAuthority,
          expectedChildSessionId: randomUUID()
        })).toThrowError(expect.objectContaining({ code: "INVALID_ACCESS" }));
      }
      const recovered = recoverClaudeSessionStoreOperation(nextAuthority, {
        operationId: operation.access.operationId,
        targetWorkspaceAuthority: operation.access.target.workspaceAuthority,
        ...(operation.childSessionId === undefined
          ? {}
          : { expectedChildSessionId: operation.childSessionId })
      });
      expect(recovered).toMatchObject({
        kind: "operation",
        operationId: operation.access.operationId,
        generation: 2,
        target: { workspaceAuthority: operation.access.target.workspaceAuthority }
      });
      expect(readClaudeSessionStoreOperation(nextAuthority, recovered).state).toBe(
        operation.state === "durable_ready" ? "ready" : operation.state
      );
      const cleaned = cleanupClaudeSessionStoreOperation(nextAuthority, recovered,
        operation.childSessionId === undefined ? {} : { expectedChildSessionId: operation.childSessionId });
      expect(cleaned.state).toBe("cleaned");
      expect(cleanupClaudeSessionStoreOperation(nextAuthority, recovered,
        operation.childSessionId === undefined ? {} : { expectedChildSessionId: operation.childSessionId }))
        .toEqual(cleaned);
      expect(await operationStagingCount(fixture.root, operation.access.operationId)).toBe(0);
    }

    expect(() => recoverClaudeSessionStoreOperation(fixture.authority, {
      operationId: first.access.operationId,
      targetWorkspaceAuthority: first.access.target.workspaceAuthority
    })).toThrowError(expect.objectContaining({ code: "CONFLICT" }));
    const adoptedOperation = operations.find((operation) => operation.state === "adopted")!;
    const adoptedStore = createClaudeDurableSessionStore(nextAuthority, createClaudeSessionStoreSessionAccess({
      generation: 2,
      workspaceAuthority: adoptedOperation.access.target.workspaceAuthority,
      sessionId: adoptedOperation.childSessionId!
    }));
    expect(await adoptedStore.load({
      projectKey: `recover-target-${states.indexOf("adopted")}`,
      sessionId: adoptedOperation.childSessionId!
    })).toHaveLength(1);
    await adoptedStore.delete({
      projectKey: `recover-target-${states.indexOf("adopted")}`,
      sessionId: adoptedOperation.childSessionId!
    });
    adoptedStore.close();
    const finalAuthority = createClaudeSessionStoreAuthority({
      rootDirectory: fixture.root,
      namespace: "test-owner",
      generation: 3
    });
    const recoveredCleanedAdoption = recoverClaudeSessionStoreOperation(finalAuthority, {
      operationId: adoptedOperation.access.operationId,
      targetWorkspaceAuthority: adoptedOperation.access.target.workspaceAuthority,
      expectedChildSessionId: adoptedOperation.childSessionId!
    });
    expect(cleanupClaudeSessionStoreOperation(finalAuthority, recoveredCleanedAdoption, {
      expectedChildSessionId: adoptedOperation.childSessionId!
    }).state).toBe("cleaned");
    const database = new DatabaseSync(await onlyDatabasePath(fixture.root));
    const remaining = database.prepare(`
      SELECT COUNT(*) AS count FROM sessions
      WHERE workspace_authority LIKE 'workspace.recover-target-%'
    `).get() as Record<string, unknown> | undefined;
    database.close();
    expect(Number(remaining?.["count"] ?? -1)).toBe(0);
  });

  it("fails closed when operation and reserved-child receipt states disagree", async () => {
    const fixture = await createFixture();
    const operations: Array<{
      access: ClaudeSessionStoreOperationAccess;
      childSessionId: string;
      corruptReservationState: "pending" | "confirmed";
    }> = [];
    for (const [index, operationState] of (["child_pending", "child_reserved"] as const).entries()) {
      const access = prepareClaudeSessionStoreImport(fixture.authority, {
        operationId: randomUUID(),
        sourceWorkspaceAuthority: `workspace.receipt-source-${index}`,
        sourceSessionId: randomUUID(),
        targetWorkspaceAuthority: `workspace.receipt-target-${index}`
      });
      const store = createClaudeDurableSessionStore(fixture.authority, access, {
        onChildReserved: operationState === "child_pending"
          ? async () => { throw new Error("registration unavailable"); }
          : async () => undefined
      });
      await store.append(
        { projectKey: `receipt-source-${index}`, sessionId: access.source.sessionId },
        [{ type: "user", uuid: randomUUID() }]
      );
      sealClaudeSessionStoreImport(fixture.authority, access);
      await store.load({ projectKey: `receipt-target-${index}`, sessionId: access.source.sessionId });
      const childSessionId = randomUUID();
      const append = store.append(
        { projectKey: `receipt-target-${index}`, sessionId: childSessionId },
        [{ type: "assistant", uuid: randomUUID() }]
      );
      if (operationState === "child_pending") {
        await expect(append).rejects.toMatchObject({ code: "RESERVATION_FAILED" });
      } else {
        await append;
      }
      store.close();
      operations.push({
        access,
        childSessionId,
        corruptReservationState: operationState === "child_pending" ? "confirmed" : "pending"
      });
    }
    const databasePath = await onlyDatabasePath(fixture.root);
    const database = new DatabaseSync(databasePath);
    for (const operation of operations) {
      database.prepare(`
        UPDATE sessions SET reservation_state = ?
        WHERE workspace_authority = ? AND session_id = ?
      `).run(
        operation.corruptReservationState,
        operation.access.target.workspaceAuthority,
        operation.childSessionId
      );
    }
    database.close();
    const nextAuthority = createClaudeSessionStoreAuthority({
      rootDirectory: fixture.root,
      namespace: "test-owner",
      generation: 2
    });
    for (const operation of operations) {
      expect(() => recoverClaudeSessionStoreOperation(nextAuthority, {
        operationId: operation.access.operationId,
        targetWorkspaceAuthority: operation.access.target.workspaceAuthority,
        expectedChildSessionId: operation.childSessionId
      })).toThrowError(expect.objectContaining({ code: "CORRUPT" }));
      expect(() => cleanupClaudeSessionStoreOperation(fixture.authority, operation.access, {
        expectedChildSessionId: operation.childSessionId
      })).toThrowError(expect.objectContaining({ code: "CORRUPT" }));
      expect(readClaudeSessionStoreOperation(fixture.authority, operation.access).generation).toBe(1);
    }
    const verify = new DatabaseSync(databasePath);
    const rows = verify.prepare(`
      SELECT COUNT(*) AS count FROM sessions WHERE workspace_authority LIKE 'workspace.receipt-target-%'
    `).get() as Record<string, unknown> | undefined;
    verify.close();
    expect(Number(rows?.["count"] ?? -1)).toBe(2);
  });

  it("refuses to claim or clean reserved children with drifted batch authority", async () => {
    const fixture = await createFixture();
    const createReserved = async (suffix: string) => {
      const access = prepareClaudeSessionStoreImport(fixture.authority, {
        operationId: randomUUID(),
        sourceWorkspaceAuthority: `workspace.batch-source-${suffix}`,
        sourceSessionId: randomUUID(),
        targetWorkspaceAuthority: `workspace.batch-target-${suffix}`
      });
      const store = createClaudeDurableSessionStore(fixture.authority, access, {
        onChildReserved: async () => undefined
      });
      await store.append(
        { projectKey: `batch-source-${suffix}`, sessionId: access.source.sessionId },
        [{ type: "user", uuid: randomUUID() }]
      );
      sealClaudeSessionStoreImport(fixture.authority, access);
      await store.load({ projectKey: `batch-target-${suffix}`, sessionId: access.source.sessionId });
      const childSessionId = randomUUID();
      await store.append(
        { projectKey: `batch-target-${suffix}`, sessionId: childSessionId },
        [{ type: "assistant", uuid: randomUUID(), suffix }]
      );
      store.close();
      return { access, childSessionId };
    };
    const badDigest = await createReserved("digest");
    const badSubkey = await createReserved("subkey");
    const missingChild = await createReserved("missing");
    const databasePath = await onlyDatabasePath(fixture.root);
    const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
    database.prepare("UPDATE operations SET reservation_batch_digest = ? WHERE operation_id = ?")
      .run("0".repeat(64), badDigest.access.operationId);
    const rootEntry = database.prepare(`
      SELECT uuid, entry_json, entry_bytes, entry_digest
      FROM session_entries WHERE workspace_authority = ? AND session_id = ? AND subpath = ''
      ORDER BY ordinal ASC LIMIT 1
    `).get(badSubkey.access.target.workspaceAuthority, badSubkey.childSessionId) as Record<string, unknown>;
    const session = database.prepare(`
      SELECT next_ordinal FROM sessions WHERE workspace_authority = ? AND session_id = ?
    `).get(badSubkey.access.target.workspaceAuthority, badSubkey.childSessionId) as Record<string, unknown>;
    const nextOrdinal = Number(session["next_ordinal"]);
    const entryUuid = String(rootEntry["uuid"]);
    const entryJson = String(rootEntry["entry_json"]);
    const entryBytes = Number(rootEntry["entry_bytes"]);
    const entryDigest = String(rootEntry["entry_digest"]);
    database.prepare(`
      INSERT INTO session_entries (
        workspace_authority, session_id, subpath, ordinal, uuid,
        entry_json, entry_bytes, entry_digest
      ) VALUES (?, ?, 'subagents/drift', ?, ?, ?, ?, ?)
    `).run(
      badSubkey.access.target.workspaceAuthority,
      badSubkey.childSessionId,
      nextOrdinal,
      entryUuid,
      entryJson,
      entryBytes,
      entryDigest
    );
    database.prepare(`
      UPDATE sessions
      SET revision = revision + 1, entry_count = entry_count + 1,
          byte_count = byte_count + ?, subkey_count = subkey_count + 1,
          next_ordinal = next_ordinal + 1
      WHERE workspace_authority = ? AND session_id = ?
    `).run(entryBytes, badSubkey.access.target.workspaceAuthority, badSubkey.childSessionId);
    database.prepare("DELETE FROM sessions WHERE workspace_authority = ? AND session_id = ?")
      .run(missingChild.access.target.workspaceAuthority, missingChild.childSessionId);
    database.close();

    const nextAuthority = createClaudeSessionStoreAuthority({
      rootDirectory: fixture.root,
      namespace: "test-owner",
      generation: 2
    });
    for (const operation of [badDigest, badSubkey, missingChild]) {
      expect(() => recoverClaudeSessionStoreOperation(nextAuthority, {
        operationId: operation.access.operationId,
        targetWorkspaceAuthority: operation.access.target.workspaceAuthority,
        expectedChildSessionId: operation.childSessionId
      })).toThrowError(expect.objectContaining({ code: "CORRUPT" }));
      expect(() => cleanupClaudeSessionStoreOperation(fixture.authority, operation.access, {
        expectedChildSessionId: operation.childSessionId
      })).toThrowError(expect.objectContaining({ code: "CORRUPT" }));
      expect(readClaudeSessionStoreOperation(fixture.authority, operation.access)).toMatchObject({
        generation: 1,
        state: "child_reserved"
      });
    }
  });

  it("keeps partial imports unusable across reopen and discards only their exact operation", async () => {
    const fixture = await createFixture();
    const operation = prepareClaudeSessionStoreImport(fixture.authority, {
      operationId: randomUUID(),
      sourceWorkspaceAuthority: "workspace.partial",
      sourceSessionId: fixture.sourceSessionId,
      targetWorkspaceAuthority: "workspace.target"
    });
    const first = createClaudeDurableSessionStore(fixture.authority, operation);
    await first.append(
      { projectKey: "source-key", sessionId: fixture.sourceSessionId },
      [{ type: "user", uuid: randomUUID(), privateValue: "do-not-disclose" }]
    );
    first.close();
    const reopened = createClaudeDurableSessionStore(fixture.authority, operation);
    await expect(reopened.load({ projectKey: "target-key", sessionId: fixture.sourceSessionId }))
      .rejects.toMatchObject({ code: "OPERATION_NOT_READY" });
    await expect(reopened.append(
      { projectKey: "different-source-key", sessionId: fixture.sourceSessionId },
      [{ type: "user" }]
    )).rejects.toMatchObject({ code: "INVALID_KEY" });
    reopened.close();
    discardClaudeSessionStoreImport(fixture.authority, operation);
    expect(() => readClaudeSessionStoreOperation(fixture.authority, operation)).toThrowError(
      expect.objectContaining({ code: "NOT_FOUND" })
    );
  });

  it("keeps post-reservation confirmation failures state-changing", async () => {
    const fixture = await createFixture();
    const operation = prepareClaudeSessionStoreImport(fixture.authority, {
      operationId: randomUUID(),
      sourceWorkspaceAuthority: "workspace.confirm-source",
      sourceSessionId: fixture.sourceSessionId,
      targetWorkspaceAuthority: "workspace.confirm-target"
    });
    let callbackCompleted = false;
    let store!: ReturnType<typeof createClaudeDurableSessionStore>;
    store = createClaudeDurableSessionStore(fixture.authority, operation, {
      onChildReserved: async () => {
        callbackCompleted = true;
        store.close();
      }
    });
    await store.append(
      { projectKey: "confirm-source", sessionId: fixture.sourceSessionId },
      [{ type: "user", uuid: randomUUID() }]
    );
    sealClaudeSessionStoreImport(fixture.authority, operation);
    await store.load({ projectKey: "confirm-target", sessionId: fixture.sourceSessionId });
    const childSessionId = randomUUID();
    const error = await store.append(
      { projectKey: "confirm-target", sessionId: childSessionId },
      [{ type: "assistant", uuid: randomUUID() }]
    ).catch((reason: unknown) => reason);
    expect(callbackCompleted).toBe(true);
    expect(error).toMatchObject({ code: "COMMIT_UNKNOWN", stateMayHaveChanged: true });
    expect(readClaudeSessionStoreOperation(fixture.authority, operation)).toMatchObject({
      state: "child_pending",
      childSessionId,
      childReservationConfirmed: false
    });
  });

  it("atomically deletes an exact pending child after reservation registration fails", async () => {
    const fixture = await createFixture();
    const operation = prepareClaudeSessionStoreImport(fixture.authority, {
      operationId: randomUUID(),
      sourceWorkspaceAuthority: "workspace.failed-source",
      sourceSessionId: fixture.sourceSessionId,
      targetWorkspaceAuthority: "workspace.failed-target"
    });
    const store = createClaudeDurableSessionStore(fixture.authority, operation, {
      onChildReserved: async () => { throw new Error("private upstream registration detail"); }
    });
    await store.append(
      { projectKey: "failed-source", sessionId: fixture.sourceSessionId },
      [{ type: "user", uuid: randomUUID() }]
    );
    sealClaudeSessionStoreImport(fixture.authority, operation);
    await store.load({ projectKey: "failed-target", sessionId: fixture.sourceSessionId });
    const childSessionId = randomUUID();
    const error = await store.append(
      { projectKey: "failed-target", sessionId: childSessionId },
      [{ type: "assistant", uuid: randomUUID() }]
    ).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "RESERVATION_FAILED", stateMayHaveChanged: true });
    expect(String(error)).not.toContain("private upstream registration detail");
    await store.delete({ projectKey: "failed-target", sessionId: childSessionId });
    expect(readClaudeSessionStoreOperation(fixture.authority, operation)).toMatchObject({
      state: "cleaned",
      childSessionId,
      childReservationConfirmed: false
    });
    store.close();
    expect(await operationStagingCount(fixture.root, operation.operationId)).toBe(0);
  });

  it("retries only a pending reservation callback without duplicating UUID-less entries", async () => {
    const fixture = await createFixture();
    const operation = prepareClaudeSessionStoreImport(fixture.authority, {
      operationId: randomUUID(),
      sourceWorkspaceAuthority: "workspace.retry-source",
      sourceSessionId: fixture.sourceSessionId,
      targetWorkspaceAuthority: "workspace.retry-target"
    });
    let attempts = 0;
    const store = createClaudeDurableSessionStore(fixture.authority, operation, {
      onChildReserved: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("first registration attempt failed");
      }
    });
    await store.append(
      { projectKey: "retry-source", sessionId: fixture.sourceSessionId },
      [{ type: "user", uuid: randomUUID() }]
    );
    sealClaudeSessionStoreImport(fixture.authority, operation);
    await store.load({ projectKey: "retry-target", sessionId: fixture.sourceSessionId });
    const childSessionId = randomUUID();
    const batch = [{ type: "assistant", uuid: randomUUID() }, { type: "mode", value: "once" }];
    await expect(store.append({ projectKey: "retry-target", sessionId: childSessionId }, batch))
      .rejects.toMatchObject({ code: "RESERVATION_FAILED", stateMayHaveChanged: true });
    await store.append({ projectKey: "retry-target", sessionId: childSessionId }, batch);
    await store.append({ projectKey: "retry-target", sessionId: childSessionId }, batch);
    expect(attempts).toBe(2);
    expect(await store.load({ projectKey: "retry-target", sessionId: childSessionId })).toEqual(batch);
    store.close();
  });

  it("serializes same-session writers across instances while preserving UUID and UUID-less semantics", async () => {
    const fixture = await createFixture();
    const child = await createAdoptedChild(fixture, "workspace.concurrent", "project-concurrent");
    const left = createClaudeDurableSessionStore(fixture.authority, child.access);
    const right = createClaudeDurableSessionStore(fixture.authority, child.access);
    const sharedUuid = randomUUID();
    await Promise.all([
      left.append(
        { projectKey: "project-concurrent", sessionId: child.sessionId },
        [{ type: "assistant", uuid: sharedUuid, value: "same" }, { type: "mode", order: 1 }]
      ),
      right.append(
        { projectKey: "project-concurrent", sessionId: child.sessionId },
        [{ value: "same", uuid: sharedUuid, type: "assistant" }, { order: 2, type: "mode" }]
      )
    ]);
    const loaded = await left.load({ projectKey: "project-concurrent", sessionId: child.sessionId });
    expect(loaded?.filter((entry) => entry.uuid === sharedUuid)).toHaveLength(1);
    expect(loaded?.filter((entry) => entry.type === "mode").map((entry) => entry["order"]))
      .toEqual([1, 2]);
    left.close();
    right.close();
  });

  it("isolates the same SDK project key and Session identity by workspace authority", async () => {
    const fixture = await createFixture();
    const sharedSessionId = randomUUID();
    const first = await createAdoptedChild(
      fixture,
      "workspace.isolated-one",
      "shared-sdk-project",
      sharedSessionId
    );
    const second = await createAdoptedChild(
      fixture,
      "workspace.isolated-two",
      "shared-sdk-project",
      sharedSessionId
    );
    const firstStore = createClaudeDurableSessionStore(fixture.authority, first.access);
    const secondStore = createClaudeDurableSessionStore(fixture.authority, second.access);
    await firstStore.append(
      { projectKey: "shared-sdk-project", sessionId: sharedSessionId },
      [{ type: "mode", workspace: "one" }]
    );
    await secondStore.append(
      { projectKey: "shared-sdk-project", sessionId: sharedSessionId },
      [{ type: "mode", workspace: "two" }]
    );
    expect((await firstStore.load({ projectKey: "shared-sdk-project", sessionId: sharedSessionId }))?.at(-1))
      .toMatchObject({ workspace: "one" });
    expect((await secondStore.load({ projectKey: "shared-sdk-project", sessionId: sharedSessionId }))?.at(-1))
      .toMatchObject({ workspace: "two" });
    firstStore.close();
    secondStore.close();
  });

  it("serializes competing writers across cold process opens", { timeout: 30_000 }, async () => {
    const fixture = await createFixture();
    await Promise.all(Array.from({ length: 6 }, (_, index) => runStoreProcess({
      mode: "list",
      authority: fixture.authority,
      workspaceAuthority: `workspace.cold-${index}`,
      projectKey: "project-cold-open"
    })));
    const child = await createAdoptedChild(fixture, "workspace.process-writers", "project-process-writers");
    await Promise.all(Array.from({ length: 8 }, (_, index) => runStoreProcess({
      mode: "append",
      authority: fixture.authority,
      access: child.access,
      projectKey: "project-process-writers",
      sessionId: child.sessionId,
      marker: index
    })));
    const reopened = createClaudeDurableSessionStore(fixture.authority, child.access);
    const loaded = await reopened.load({ projectKey: "project-process-writers", sessionId: child.sessionId });
    expect(loaded).toHaveLength(9);
    expect(loaded?.filter((entry) => entry.type === "process-marker").map((entry) => entry["marker"]).sort())
      .toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    reopened.close();
  });

  it("fails closed on invalid JSON, budgets, wrong fences and durable corruption without leaking bodies", async () => {
    const fixture = await createFixture();
    const child = await createAdoptedChild(fixture, "workspace.validated", "project-validated");
    const store = createClaudeDurableSessionStore(fixture.authority, child.access);
    const key = { projectKey: "project-validated", sessionId: child.sessionId };
    const secret = "sensitive-transcript-body";
    const invalidValues: unknown[] = [
      { type: "user", value: Number.NaN, secret },
      { type: "user", value: new Date(), secret },
      Object.defineProperty({ type: "user", secret }, "value", { enumerable: true, get: () => secret })
    ];
    for (const value of invalidValues) {
      const error = await store.append(key, [value as { type: string }]).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(ClaudeSessionStoreError);
      expect(String(error)).not.toContain(secret);
    }
    let deep: Record<string, unknown> = { type: "user" };
    for (let index = 0; index <= CLAUDE_SESSION_STORE_LIMITS.maximumJsonDepth; index += 1) deep = { type: "user", deep };
    await expect(store.append(key, [deep as { type: string }])).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    await expect(store.append(key, Array.from(
      { length: CLAUDE_SESSION_STORE_LIMITS.maximumBatchEntries + 1 },
      () => ({ type: "mode" })
    ))).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    const foreignAccess = createClaudeSessionStoreSessionAccess({
      generation: 1,
      workspaceAuthority: "workspace.foreign",
      sessionId: child.sessionId
    });
    const foreign = createClaudeDurableSessionStore(fixture.authority, foreignAccess);
    expect(await foreign.load(key)).toBeNull();
    foreign.close();
    store.close();

    const databasePath = await onlyDatabasePath(fixture.root);
    const database = new DatabaseSync(databasePath);
    database.prepare(`
      UPDATE session_entries SET entry_json = '{"type":"tampered"}'
      WHERE workspace_authority = ? AND session_id = ? AND ordinal = 0
    `).run("workspace.validated", child.sessionId);
    database.close();
    const corrupted = createClaudeDurableSessionStore(fixture.authority, child.access);
    await expect(corrupted.load(key)).rejects.toMatchObject({ code: "CORRUPT" });
    corrupted.close();
  });

  it("maps corrupted operation keys and staging counters to CORRUPT", async () => {
    const fixture = await createFixture();
    const operations = [randomUUID(), randomUUID()].map((operationId, index) => prepareClaudeSessionStoreImport(
      fixture.authority,
      {
        operationId,
        sourceWorkspaceAuthority: `workspace.operation-corrupt-${index}`,
        sourceSessionId: randomUUID(),
        targetWorkspaceAuthority: `workspace.operation-target-${index}`
      }
    ));
    for (const [index, operation] of operations.entries()) {
      const store = createClaudeDurableSessionStore(fixture.authority, operation);
      await store.append(
        { projectKey: `operation-source-${index}`, sessionId: operation.source.sessionId },
        [{ type: "user", uuid: randomUUID() }]
      );
      store.close();
    }
    const database = new DatabaseSync(await onlyDatabasePath(fixture.root));
    database.prepare("UPDATE operations SET source_project_key = ? WHERE operation_id = ?")
      .run("x".repeat(CLAUDE_SESSION_STORE_LIMITS.maximumProjectKeyBytes + 1), operations[0]!.operationId);
    database.prepare(`
      UPDATE operations SET source_entry_count = source_entry_count + 1 WHERE operation_id = ?
    `).run(operations[1]!.operationId);
    database.close();

    for (const operation of operations) {
      expect(() => readClaudeSessionStoreOperation(fixture.authority, operation)).toThrowError(
        expect.objectContaining({ code: "CORRUPT" })
      );
    }
  });

  it("maps corrupted session keys, subpaths and listing metadata to CORRUPT", async () => {
    const fixture = await createFixture();
    const badProject = await createAdoptedChild(fixture, "workspace.bad-project", "project-bad-project");
    const badSubpath = await createAdoptedChild(fixture, "workspace.bad-subpath", "project-bad-subpath");
    const subpathStore = createClaudeDurableSessionStore(fixture.authority, badSubpath.access);
    await subpathStore.append(
      { projectKey: "project-bad-subpath", sessionId: badSubpath.sessionId, subpath: "subagents/valid" },
      [{ type: "assistant", uuid: randomUUID() }]
    );
    subpathStore.close();
    const badListing = await createAdoptedChild(fixture, "workspace.bad-listing", "project-bad-listing");

    const database = new DatabaseSync(await onlyDatabasePath(fixture.root));
    database.prepare("UPDATE sessions SET project_key = ? WHERE workspace_authority = ? AND session_id = ?")
      .run("bad\u0000project", badProject.access.workspaceAuthority, badProject.sessionId);
    database.prepare("UPDATE session_entries SET subpath = ? WHERE workspace_authority = ? AND session_id = ? AND subpath <> ''")
      .run("bad\u0000subpath", badSubpath.access.workspaceAuthority, badSubpath.sessionId);
    database.prepare("DELETE FROM session_entries WHERE workspace_authority = ? AND session_id = ?")
      .run(badListing.access.workspaceAuthority, badListing.sessionId);
    database.prepare(`
      UPDATE sessions SET entry_count = 0, byte_count = 0, next_ordinal = 0
      WHERE workspace_authority = ? AND session_id = ?
    `).run(badListing.access.workspaceAuthority, badListing.sessionId);
    database.prepare("UPDATE sessions SET session_id = ? WHERE workspace_authority = ? AND session_id = ?")
      .run("not-a-uuid", badListing.access.workspaceAuthority, badListing.sessionId);
    database.close();

    const projectStore = createClaudeDurableSessionStore(fixture.authority, badProject.access);
    await expect(projectStore.load({ projectKey: "project-bad-project", sessionId: badProject.sessionId }))
      .rejects.toMatchObject({ code: "CORRUPT" });
    projectStore.close();
    const corruptSubpathStore = createClaudeDurableSessionStore(fixture.authority, badSubpath.access);
    await expect(corruptSubpathStore.listSubkeys({
      projectKey: "project-bad-subpath",
      sessionId: badSubpath.sessionId
    })).rejects.toMatchObject({ code: "CORRUPT" });
    corruptSubpathStore.close();
    const listingStore = createClaudeDurableSessionStore(fixture.authority, createClaudeSessionStoreWorkspaceAccess({
      generation: 1,
      workspaceAuthority: badListing.access.workspaceAuthority
    }));
    await expect(listingStore.listSessions("project-bad-listing")).rejects.toMatchObject({ code: "CORRUPT" });
    listingStore.close();
  });

  it("rejects a reopened database with foreign-key violations", async () => {
    const fixture = await createFixture();
    const child = await createAdoptedChild(fixture, "workspace.orphan", "project-orphan");
    const database = new DatabaseSync(await onlyDatabasePath(fixture.root));
    database.exec("PRAGMA foreign_keys = OFF");
    database.prepare("DELETE FROM sessions WHERE workspace_authority = ? AND session_id = ?")
      .run(child.access.workspaceAuthority, child.sessionId);
    database.close();
    expect(() => createClaudeDurableSessionStore(fixture.authority, child.access)).toThrowError(
      expect.objectContaining({ code: "CORRUPT" })
    );
  });

  it("refuses to append into a session whose durable entry counts no longer match", async () => {
    const fixture = await createFixture();
    const child = await createAdoptedChild(fixture, "workspace.append-corrupt", "project-append-corrupt");
    const databasePath = await onlyDatabasePath(fixture.root);
    const database = new DatabaseSync(databasePath);
    database.prepare("DELETE FROM session_entries WHERE workspace_authority = ? AND session_id = ?")
      .run(child.access.workspaceAuthority, child.sessionId);
    database.close();

    const store = createClaudeDurableSessionStore(fixture.authority, child.access);
    await expect(store.append(
      { projectKey: "project-append-corrupt", sessionId: child.sessionId },
      [{ type: "assistant", uuid: randomUUID(), value: "must-not-commit" }]
    )).rejects.toMatchObject({ code: "CORRUPT" });
    store.close();
    const verify = new DatabaseSync(databasePath);
    const row = verify.prepare(`
      SELECT COUNT(*) AS count FROM session_entries WHERE workspace_authority = ? AND session_id = ?
    `).get(child.access.workspaceAuthority, child.sessionId) as Record<string, unknown> | undefined;
    verify.close();
    expect(Number(row?.["count"] ?? -1)).toBe(0);
  });

  it("refuses to append after equal-length durable entry tampering", async () => {
    const fixture = await createFixture();
    const child = await createAdoptedChild(fixture, "workspace.append-digest", "project-append-digest");
    const databasePath = await onlyDatabasePath(fixture.root);
    const database = new DatabaseSync(databasePath);
    const changed = database.prepare(`
      UPDATE session_entries SET entry_json = replace(entry_json, '"child"', '"other"')
      WHERE workspace_authority = ? AND session_id = ?
    `).run(child.access.workspaceAuthority, child.sessionId);
    database.close();
    expect(Number(changed.changes)).toBe(1);

    const store = createClaudeDurableSessionStore(fixture.authority, child.access);
    await expect(store.append(
      { projectKey: "project-append-digest", sessionId: child.sessionId },
      [{ type: "mode", value: "must-not-commit" }]
    )).rejects.toMatchObject({ code: "CORRUPT" });
    store.close();
    const verify = new DatabaseSync(databasePath);
    const row = verify.prepare(`
      SELECT COUNT(*) AS count FROM session_entries WHERE workspace_authority = ? AND session_id = ?
    `).get(child.access.workspaceAuthority, child.sessionId) as Record<string, unknown> | undefined;
    verify.close();
    expect(Number(row?.["count"] ?? -1)).toBe(1);
  });

  it("does not reinterpret a truncated existing database as a new namespace", async () => {
    const fixture = await createFixture();
    const child = await createAdoptedChild(fixture, "workspace.truncated", "project-truncated");
    const databasePath = await onlyDatabasePath(fixture.root);
    await truncate(databasePath, 0);
    expect(() => createClaudeDurableSessionStore(fixture.authority, child.access)).toThrowError(
      expect.objectContaining({ code: "STORAGE_UNAVAILABLE" })
    );
    expect((await stat(databasePath)).size).toBe(0);
  });

  it("does not recreate a missing initialized namespace database", async () => {
    const fixture = await createFixture();
    const child = await createAdoptedChild(fixture, "workspace.missing", "project-missing");
    const databasePath = await onlyDatabasePath(fixture.root);
    await unlink(databasePath);
    expect(() => createClaudeDurableSessionStore(fixture.authority, child.access)).toThrowError(
      expect.objectContaining({ code: "CORRUPT" })
    );
    await expect(stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function createFixture(): Promise<{
  root: string;
  authority: ClaudeSessionStoreAuthority;
  sourceSessionId: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "joko-claude-session-store-"));
  roots.push(root);
  return {
    root,
    authority: createClaudeSessionStoreAuthority({ rootDirectory: root, namespace: "test-owner", generation: 1 }),
    sourceSessionId: randomUUID()
  };
}

async function createAdoptedChild(
  fixture: { authority: ClaudeSessionStoreAuthority; sourceSessionId: string },
  targetWorkspaceAuthority: string,
  targetProjectKey: string,
  childSessionId = randomUUID()
): Promise<{ sessionId: string; access: ClaudeSessionStoreSessionAccess; operation: ClaudeSessionStoreOperationAccess }> {
  const operation = prepareClaudeSessionStoreImport(fixture.authority, {
    operationId: randomUUID(),
    sourceWorkspaceAuthority: `source.${randomUUID()}`,
    sourceSessionId: fixture.sourceSessionId,
    targetWorkspaceAuthority
  });
  const store = createClaudeDurableSessionStore(fixture.authority, operation, {
    onChildReserved: async () => undefined
  });
  await store.append(
    { projectKey: `source-${randomUUID()}`, sessionId: fixture.sourceSessionId },
    [{ type: "user", uuid: randomUUID(), value: "source" }]
  );
  sealClaudeSessionStoreImport(fixture.authority, operation);
  await store.load({ projectKey: targetProjectKey, sessionId: fixture.sourceSessionId });
  await store.append(
    { projectKey: targetProjectKey, sessionId: childSessionId },
    [{ type: "assistant", uuid: randomUUID(), value: "child" }]
  );
  const access = adoptClaudeSessionStoreChild(fixture.authority, operation, childSessionId);
  store.close();
  return { sessionId: childSessionId, access, operation };
}

async function runStoreProcess(input: {
  readonly mode: "list";
  readonly authority: ClaudeSessionStoreAuthority;
  readonly workspaceAuthority: string;
  readonly projectKey: string;
} | {
  readonly mode: "append";
  readonly authority: ClaudeSessionStoreAuthority;
  readonly access: ClaudeSessionStoreSessionAccess;
  readonly projectKey: string;
  readonly sessionId: string;
  readonly marker: number;
}): Promise<void> {
  const moduleUrl = pathToFileURL(join(import.meta.dirname, "claude-session-store.ts")).href;
  const payload = Buffer.from(JSON.stringify(input), "utf8").toString("base64url");
  const script = `
    const api = await import(process.argv[1]);
    const input = JSON.parse(Buffer.from(process.argv[2], "base64url").toString("utf8"));
    const access = input.mode === "list"
      ? api.createClaudeSessionStoreWorkspaceAccess({
          generation: input.authority.generation,
          workspaceAuthority: input.workspaceAuthority
        })
      : input.access;
    const store = api.createClaudeDurableSessionStore(input.authority, access);
    if (input.mode === "list") await store.listSessions(input.projectKey);
    else await store.append(
      { projectKey: input.projectKey, sessionId: input.sessionId },
      [{ type: "process-marker", marker: input.marker }]
    );
    store.close();
  `;
  await execFileAsync(process.execPath, ["--input-type=module", "--eval", script, moduleUrl, payload], {
    windowsHide: true,
    timeout: 15_000
  });
}

async function onlyDatabasePath(root: string): Promise<string> {
  const directory = join(root, "claude-session-store-v1");
  const names = (await readdir(directory)).filter((name) => name.endsWith(".sqlite"));
  expect(names).toHaveLength(1);
  return join(directory, names[0]!);
}

async function operationStagingCount(root: string, operationId: string): Promise<number> {
  const database = new DatabaseSync(await onlyDatabasePath(root));
  try {
    const row = database.prepare(`
      SELECT COUNT(*) AS count FROM operation_source_entries WHERE operation_id = ?
    `).get(operationId) as Record<string, unknown> | undefined;
    return Number(row?.["count"] ?? -1);
  } finally {
    database.close();
  }
}
