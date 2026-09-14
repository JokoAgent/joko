import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ExtensionLibraryManager,
  type ExtensionLibraryAuthority,
  type ExtensionLibraryManagerOptions
} from "./extension-library-manager.js";
import { copyExtensionLibrary } from "./extension-library-transfer.js";

const EXTENSION_ID = `extension_${"c".repeat(32)}`;
const authority: ExtensionLibraryAuthority = {
  extensionId: EXTENSION_ID,
  extensionRevision: 1n,
  resourceId: "resource-library",
  resourceRevision: 1n,
  discoveredRevision: "sha256:library",
  backendId: "pi",
  backendRevision: 1n,
  backendGeneration: 1,
  name: "Canvas",
  library: { schemaVersion: 1, extensionEntry: "extensions/canvas.ts" }
};
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function fixture(options: Partial<Omit<ExtensionLibraryManagerOptions, "rootDirectory">> = {}) {
  const temporaryPath = await mkdtemp(join(tmpdir(), "joko-extension-library-manager-"));
  cleanups.push(() => rm(temporaryPath, { recursive: true, force: true }));
  const manager = new ExtensionLibraryManager({
    rootDirectory: join(temporaryPath, "owner"),
    freeBytes: async () => 64 * 1024 * 1024 * 1024,
    ...options
  });
  await manager.initialize();
  cleanups.push(() => manager.close().catch(() => undefined));
  return { temporaryPath, manager };
}

function currentAuthority(expected = authority) {
  return async () => {
    if (expected.extensionRevision !== authority.extensionRevision) throw new Error("stale authority");
  };
}

describe("ExtensionLibraryManager", () => {
  it("fences file, stream, and SQLite handles to the exact connection, authority, and binding generation", async () => {
    const { manager } = await fixture();
    await expect(manager.overview({ authority, assertAuthorityCurrent: currentAuthority() })).resolves.toMatchObject({
      state: "ready",
      usage: { files: 0, bytes: 0 }
    });
    let currentRevision = 1n;
    const opened = await manager.openSession({
      authority,
      connectionId: "web-1",
      assertAuthorityCurrent: () => {
        if (currentRevision !== 1n) throw new Error("stale authority");
      }
    });
    expect(opened.bindingGeneration).toBe(1n);
    await manager.write(opened.sessionId, "web-1", { path: "documents/one.txt", bytes: Buffer.from("one") });
    const expectedHash = createHash("sha256").update("streamed").digest("hex");
    const stream = await manager.writeBegin(opened.sessionId, "web-1", {
      path: "documents/two.txt",
      totalBytes: 8,
      sha256: expectedHash
    });
    await manager.writeChunk(opened.sessionId, "web-1", { streamId: stream.streamId, sequence: 0, bytes: Buffer.from("stre") });
    await expect(manager.writeChunk(opened.sessionId, "web-1", {
      streamId: stream.streamId,
      sequence: 0,
      bytes: Buffer.from("bad")
    })).rejects.toMatchObject({ code: "CONFLICT" });
    await manager.writeChunk(opened.sessionId, "web-1", { streamId: stream.streamId, sequence: 1, bytes: Buffer.from("amed") });
    await expect(manager.writeCommit(opened.sessionId, "web-1", stream.streamId)).resolves.toMatchObject({
      path: "documents/two.txt",
      bytes: 8,
      sha256: expectedHash
    });
    await expect(manager.read(opened.sessionId, "web-1", { path: "documents/two.txt" }))
      .resolves.toMatchObject({ bytes: Buffer.from("streamed") });

    const database = await manager.databaseOpen(opened.sessionId, "web-1", { path: "state.sqlite", create: true });
    await manager.databaseMigrate(opened.sessionId, "web-1", database.handleId, [
      { version: 1, statements: ["CREATE TABLE cards(id INTEGER PRIMARY KEY, title TEXT NOT NULL)"] }
    ]);
    await manager.databaseExecute(opened.sessionId, "web-1", database.handleId, "INSERT INTO cards(title) VALUES (?)", ["first"]);
    await expect(manager.databaseExecute(opened.sessionId, "web-1", database.handleId, "SELECT title FROM cards"))
      .resolves.toMatchObject({ rows: [{ title: "first" }] });

    await expect(manager.read(opened.sessionId, "other-connection", { path: "documents/one.txt" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    currentRevision = 2n;
    await expect(manager.read(opened.sessionId, "web-1", { path: "documents/one.txt" }))
      .rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(manager.closeSession(opened.sessionId, "web-1")).resolves.toBe(false);
  });

  it("holds catalog authority changes across commit, retires sessions, and marks uninstall data orphaned", async () => {
    const { manager } = await fixture();
    const opened = await manager.openSession({
      authority,
      connectionId: "web-authority-change",
      assertAuthorityCurrent: currentAuthority()
    });
    await manager.write(opened.sessionId, "web-authority-change", {
      path: "kept.txt",
      bytes: Buffer.from("kept")
    });

    const lease = await manager.acquireAuthorityChange(EXTENSION_ID);
    let queuedStarted = false;
    const queued = manager.overview({
      authority,
      assertAuthorityCurrent: () => { queuedStarted = true; }
    });
    await Promise.resolve();
    expect(queuedStarted).toBe(false);
    await lease.release({ orphaned: [{ extensionId: EXTENSION_ID, name: "Canvas" }] });

    await expect(queued).resolves.toMatchObject({ orphaned: true, usage: { files: 1, bytes: 4 } });
    await expect(manager.closeSession(opened.sessionId, "web-authority-change")).resolves.toBe(false);
  });

  it("rolls back an in-flight SQLite mutation when its connection is revoked", async () => {
    const { manager } = await fixture();
    const connectionId = "web-sql-revocation";
    const opened = await manager.openSession({ authority, connectionId, assertAuthorityCurrent: currentAuthority() });
    const database = await manager.databaseOpen(opened.sessionId, connectionId, { path: "revoked.sqlite", create: true });
    await manager.databaseExecute(opened.sessionId, connectionId, database.handleId, "CREATE TABLE values_table(value INTEGER)");
    const mutation = manager.databaseExecute(opened.sessionId, connectionId, database.handleId, `
      WITH RECURSIVE counter(value) AS (
        VALUES(1) UNION ALL SELECT value + 1 FROM counter WHERE value < 1000000
      ) INSERT INTO values_table SELECT value FROM counter
    `);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    const closing = manager.closeConnection(connectionId);

    await expect(mutation).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await closing;
    const replacement = await manager.openSession({ authority, connectionId: "web-after-revocation", assertAuthorityCurrent: currentAuthority() });
    const readonly = await manager.databaseOpen(replacement.sessionId, "web-after-revocation", {
      path: "revoked.sqlite",
      readonly: true
    });
    await expect(manager.databaseExecute(replacement.sessionId, "web-after-revocation", readonly.handleId, "SELECT count(*) AS count FROM values_table"))
      .resolves.toMatchObject({ rows: [{ count: 0n }] });
  });

  it("relocates with verified copies and 14-day grace, rolls back, detects drift, and explicitly rebinds or unbinds", async () => {
    const { temporaryPath, manager } = await fixture();
    const opened = await manager.openSession({ authority, connectionId: "web-2", assertAuthorityCurrent: currentAuthority() });
    await manager.write(opened.sessionId, "web-2", { path: "projects/alpha.txt", bytes: Buffer.from("alpha") });
    const database = await manager.databaseOpen(opened.sessionId, "web-2", { path: "projects/state.sqlite", create: true });
    await manager.databaseExecute(opened.sessionId, "web-2", database.handleId, "CREATE TABLE state(value TEXT)");
    await manager.databaseExecute(opened.sessionId, "web-2", database.handleId, "INSERT INTO state VALUES ('kept')");

    const customParent = join(temporaryPath, "custom");
    const moved = await manager.relocate({
      authority,
      destination: { kind: "custom", candidate: customParent },
      assertAuthorityCurrent: currentAuthority()
    });
    expect(moved).toMatchObject({ changed: true, files: 2, location: { kind: "custom", generation: 2n } });
    expect(manager.listGrace(EXTENSION_ID)).toHaveLength(1);
    await expect(manager.read(opened.sessionId, "web-2", { path: "projects/alpha.txt" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    const customSession = await manager.openSession({ authority, connectionId: "web-2", assertAuthorityCurrent: currentAuthority() });
    await expect(manager.read(customSession.sessionId, "web-2", { path: "projects/alpha.txt" }))
      .resolves.toMatchObject({ bytes: Buffer.from("alpha") });

    const rolledBack = await manager.rollbackRelocation({
      authority,
      graceId: moved.graceId!,
      assertAuthorityCurrent: currentAuthority()
    });
    expect(rolledBack.location).toMatchObject({ kind: "default", generation: 3n });
    const secondMove = await manager.relocate({
      authority,
      destination: { kind: "custom", candidate: customParent },
      assertAuthorityCurrent: currentAuthority()
    });
    const recoveredParent = join(temporaryPath, "recovered");
    await mkdir(recoveredParent);
    await rename(secondMove.location.path, join(recoveredParent, EXTENSION_ID));
    await expect(manager.overview({ authority, assertAuthorityCurrent: currentAuthority() }))
      .resolves.toMatchObject({ state: "unavailable", reason: "disk_missing" });
    await expect(manager.rebind({ authority, candidate: recoveredParent, assertAuthorityCurrent: currentAuthority() }))
      .resolves.toMatchObject({ location: { kind: "custom", generation: 5n } });
    const unbound = await manager.unbind({ authority, assertAuthorityCurrent: currentAuthority() });
    expect(unbound.detachedPath).toBe(join(recoveredParent, EXTENSION_ID));
    await expect(manager.overview({ authority, assertAuthorityCurrent: currentAuthority() }))
      .resolves.toMatchObject({ state: "ready", usage: { files: 0, bytes: 0 } });
    const reset = await manager.openSession({ authority, connectionId: "web-2", assertAuthorityCurrent: currentAuthority() });
    expect(reset.bindingGeneration).toBe(7n);
  });

  it("replays a durable rollback after the active root moved but before the selected grace copy switched", async () => {
    const { temporaryPath, manager } = await fixture();
    const ownerRoot = join(temporaryPath, "owner");
    const control = join(ownerRoot, "library-state.json");
    const first = await manager.openSession({ authority, connectionId: "web-rollback-crash", assertAuthorityCurrent: currentAuthority() });
    await manager.write(first.sessionId, "web-rollback-crash", { path: "before.txt", bytes: Buffer.from("before") });
    const moved = await manager.relocate({
      authority,
      destination: { kind: "custom", candidate: join(temporaryPath, "rollback-custom") },
      assertAuthorityCurrent: currentAuthority()
    });
    const currentSession = await manager.openSession({
      authority,
      connectionId: "web-rollback-crash",
      assertAuthorityCurrent: currentAuthority()
    });
    await manager.write(currentSession.sessionId, "web-rollback-crash", { path: "after.txt", bytes: Buffer.from("after") });
    const currentOverview = await manager.overview({ authority, assertAuthorityCurrent: currentAuthority() });
    await manager.close();

    const state = JSON.parse(await readFile(control, "utf8")) as {
      revision: string;
      bindings: Array<Record<string, unknown>>;
      grace: Array<Record<string, unknown>>;
      rollbacks: Array<Record<string, unknown>>;
    };
    const current = state.bindings.find((entry) => entry["extensionId"] === EXTENSION_ID)!;
    const selectedGrace = state.grace.find((entry) => entry["graceId"] === moved.graceId)!;
    const startedAt = Date.now();
    const rollbackId = `library_rollback_${"a".repeat(32)}`;
    const nextGraceId = `library_grace_${"b".repeat(32)}`;
    const currentRoot = current["root"] as string;
    const nextGraceRoot = `${currentRoot}.joko-grace-${startedAt}-${nextGraceId.slice(-32)}`;
    state.revision = (BigInt(state.revision) + 1n).toString(10);
    state.rollbacks = [{
      rollbackId,
      extensionId: EXTENSION_ID,
      name: authority.name,
      current,
      selectedGrace,
      nextGraceId,
      nextGraceRoot,
      bindingGeneration: (BigInt(current["generation"] as string) + 1n).toString(10),
      startedAt,
      files: currentOverview.usage.files,
      bytes: currentOverview.usage.bytes
    }];
    await writeFile(control, JSON.stringify(state));
    await rename(currentRoot, nextGraceRoot);

    const recovered = new ExtensionLibraryManager({
      rootDirectory: ownerRoot,
      freeBytes: async () => 64 * 1024 * 1024 * 1024
    });
    await recovered.initialize();
    cleanups.push(() => recovered.close().catch(() => undefined));
    await expect(recovered.overview({ authority, assertAuthorityCurrent: currentAuthority() })).resolves.toMatchObject({
      state: "ready",
      location: { kind: "default", generation: BigInt(current["generation"] as string) + 1n }
    });
    const restored = await recovered.openSession({
      authority,
      connectionId: "web-rollback-crash",
      assertAuthorityCurrent: currentAuthority()
    });
    await expect(recovered.read(restored.sessionId, "web-rollback-crash", { path: "before.txt" }))
      .resolves.toMatchObject({ bytes: Buffer.from("before") });
    await expect(recovered.read(restored.sessionId, "web-rollback-crash", { path: "after.txt" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    const recoveredState = JSON.parse(await readFile(control, "utf8")) as {
      rollbacks: unknown[];
      grace: Array<{ graceId: string; root: string }>;
    };
    expect(recoveredState.rollbacks).toEqual([]);
    const retainedCurrent = recoveredState.grace.find((entry) => entry.graceId === nextGraceId)!;
    await expect(readFile(join(retainedCurrent.root, "after.txt"), "utf8")).resolves.toBe("after");
  });

  it("keeps the old generation readable and rejects every write while a relocation copy is in progress", async () => {
    const copying = deferred();
    const release = deferred();
    const { temporaryPath, manager } = await fixture({
      copyLibrary: async (input) => {
        copying.resolve();
        await release.promise;
        return copyExtensionLibrary(input);
      }
    });
    const session = await manager.openSession({ authority, connectionId: "web-relocating", assertAuthorityCurrent: currentAuthority() });
    await manager.write(session.sessionId, "web-relocating", { path: "stable.txt", bytes: Buffer.from("stable") });
    const relocation = manager.relocate({
      authority,
      destination: { kind: "custom", candidate: join(temporaryPath, "custom") },
      assertAuthorityCurrent: currentAuthority()
    });
    await copying.promise;
    try {
      await expect(manager.overview({ authority, assertAuthorityCurrent: currentAuthority() })).resolves.toMatchObject({
        state: "read_only",
        reason: "operation_in_progress",
        location: { generation: 1n },
        operation: { phase: "copying" }
      });
      await expect(manager.read(session.sessionId, "web-relocating", { path: "stable.txt" }))
        .resolves.toMatchObject({ bytes: Buffer.from("stable") });
      await expect(manager.write(session.sessionId, "web-relocating", { path: "blocked.txt", bytes: Buffer.from("blocked") }))
        .rejects.toMatchObject({ code: "READ_ONLY" });
    } finally {
      release.resolve();
    }
    await expect(relocation).resolves.toMatchObject({ changed: true, location: { kind: "custom", generation: 2n } });
    await expect(manager.read(session.sessionId, "web-relocating", { path: "stable.txt" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("removes an uncommitted relocation copy and restores writes after verification fails", async () => {
    const { temporaryPath, manager } = await fixture({
      copyLibrary: async (input) => {
        await copyExtensionLibrary(input);
        throw new Error("verification interrupted");
      }
    });
    const session = await manager.openSession({ authority, connectionId: "web-relocation-failure", assertAuthorityCurrent: currentAuthority() });
    await manager.write(session.sessionId, "web-relocation-failure", { path: "kept.txt", bytes: Buffer.from("kept") });
    await expect(manager.relocate({
      authority,
      destination: { kind: "custom", candidate: join(temporaryPath, "failed-target") },
      assertAuthorityCurrent: currentAuthority()
    })).rejects.toThrow("verification interrupted");
    const overview = await manager.overview({ authority, assertAuthorityCurrent: currentAuthority() });
    expect(overview).toMatchObject({
      state: "ready",
      location: { kind: "default", generation: 1n }
    });
    expect(overview.operation).toBeUndefined();
    await expect(manager.write(session.sessionId, "web-relocation-failure", { path: "after.txt", bytes: Buffer.from("after") }))
      .resolves.toMatchObject({ path: "after.txt" });
  });

  it("waits for an out-of-lock relocation before completing a graceful shutdown", async () => {
    const copying = deferred();
    const release = deferred();
    const { temporaryPath, manager } = await fixture({
      copyLibrary: async (input) => {
        copying.resolve();
        await release.promise;
        return copyExtensionLibrary(input);
      }
    });
    const session = await manager.openSession({ authority, connectionId: "web-close", assertAuthorityCurrent: currentAuthority() });
    await manager.write(session.sessionId, "web-close", { path: "stable.txt", bytes: Buffer.from("stable") });
    const relocation = manager.relocate({
      authority,
      destination: { kind: "custom", candidate: join(temporaryPath, "close-target") },
      assertAuthorityCurrent: currentAuthority()
    });
    await copying.promise;
    let closed = false;
    const closing = manager.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    release.resolve();
    await expect(relocation).resolves.toMatchObject({ changed: true, location: { kind: "custom" } });
    await closing;
    expect(closed).toBe(true);
    await expect(manager.overview({ authority, assertAuthorityCurrent: currentAuthority() }))
      .rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("keeps uninstall separate from 30-day recoverable deletion and verifies cross-volume copies before source removal", async () => {
    let now = 1_800_000_000_000;
    const crossVolumeRename = async () => {
      throw Object.assign(new Error("cross volume"), { code: "EXDEV" });
    };
    const { manager } = await fixture({ now: () => now, renameDirectory: crossVolumeRename });
    const opened = await manager.openSession({ authority, connectionId: "web-3", assertAuthorityCurrent: currentAuthority() });
    await manager.write(opened.sessionId, "web-3", { path: "work/product.txt", bytes: Buffer.from("persistent") });
    await manager.revokeExtension(EXTENSION_ID, authority.name);
    await expect(manager.overview({ authority, assertAuthorityCurrent: currentAuthority() }))
      .resolves.toMatchObject({ orphaned: true, usage: { files: 1, bytes: 10 } });
    await expect(manager.trashLibrary({ authority, confirmation: "wrong", assertAuthorityCurrent: currentAuthority() }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    const trashed = await manager.trashLibrary({ authority, confirmation: authority.name, assertAuthorityCurrent: currentAuthority() });
    expect(trashed).toMatchObject({ extensionId: EXTENSION_ID, files: 1, bytes: 10, deletedAt: now });
    expect(manager.listTrash(EXTENSION_ID)).toEqual([trashed]);
    await manager.restoreTrash({ trashId: trashed.trashId, confirmation: authority.name });
    const restored = await manager.openSession({ authority, connectionId: "web-3", assertAuthorityCurrent: currentAuthority() });
    expect(restored.bindingGeneration).toBe(2n);
    await expect(manager.read(restored.sessionId, "web-3", { path: "work/product.txt" }))
      .resolves.toMatchObject({ bytes: Buffer.from("persistent") });

    const trashedAgain = await manager.trashLibrary({ authority, confirmation: authority.name, assertAuthorityCurrent: currentAuthority() });
    now += 31 * 24 * 60 * 60_000;
    await expect(manager.purgeExpired()).resolves.toMatchObject({ trash: 1 });
    expect(manager.listTrash()).not.toContainEqual(trashedAgain);
    const recreated = await manager.openSession({ authority, connectionId: "web-3", assertAuthorityCurrent: currentAuthority() });
    expect(recreated.bindingGeneration).toBe(3n);
  });

  it("recovers restore and purge crashes without losing the only verified Library copy", async () => {
    const { temporaryPath, manager } = await fixture();
    const ownerRoot = join(temporaryPath, "owner");
    const control = join(ownerRoot, "library-state.json");
    const opened = await manager.openSession({ authority, connectionId: "web-crash", assertAuthorityCurrent: currentAuthority() });
    await manager.write(opened.sessionId, "web-crash", { path: "kept.txt", bytes: Buffer.from("kept") });
    const trashed = await manager.trashLibrary({ authority, confirmation: authority.name, assertAuthorityCurrent: currentAuthority() });
    await manager.close();

    const restoreState = JSON.parse(await readFile(control, "utf8")) as {
      trash: Array<{
        trashId: string;
        root: string;
        source: { generation: string };
        [key: string]: unknown;
      }>;
    };
    const restoreRecord = restoreState.trash[0]!;
    const restoreParent = join(temporaryPath, "restored-after-crash");
    await mkdir(restoreParent);
    const targetRoot = join(restoreParent, EXTENSION_ID);
    const stagingRoot = join(restoreParent, `.joko-library-restore-${EXTENSION_ID}-${trashed.trashId.slice(-32)}`);
    await rename(restoreRecord.root, stagingRoot);
    await writeFile(join(ownerRoot, "trash", trashed.trashId, "trash.json"), JSON.stringify({
      format: 1,
      phase: "restoring",
      record: restoreRecord,
      destinationKind: "custom",
      targetRoot,
      stagingRoot,
      bindingGeneration: (BigInt(restoreRecord.source.generation) + 1n).toString(10),
      updatedAt: 1_800_000_000_000
    }));

    const restored = new ExtensionLibraryManager({
      rootDirectory: ownerRoot,
      freeBytes: async () => 64 * 1024 * 1024 * 1024
    });
    await restored.initialize();
    cleanups.push(() => restored.close().catch(() => undefined));
    expect(restored.listTrash()).toEqual([]);
    await expect(restored.overview({ authority, assertAuthorityCurrent: currentAuthority() }))
      .resolves.toMatchObject({ state: "ready", location: { kind: "custom", path: targetRoot } });
    const restoredSession = await restored.openSession({
      authority,
      connectionId: "web-crash",
      assertAuthorityCurrent: currentAuthority()
    });
    await expect(restored.read(restoredSession.sessionId, "web-crash", { path: "kept.txt" }))
      .resolves.toMatchObject({ bytes: Buffer.from("kept") });

    const purged = await restored.trashLibrary({ authority, confirmation: authority.name, assertAuthorityCurrent: currentAuthority() });
    await restored.close();
    const purgeState = JSON.parse(await readFile(control, "utf8")) as {
      trash: Array<{ trashId: string; root: string; [key: string]: unknown }>;
    };
    const purgeRecord = purgeState.trash.find((record) => record.trashId === purged.trashId)!;
    await rm(purgeRecord.root, { recursive: true, force: false });
    await writeFile(join(ownerRoot, "trash", purged.trashId, "trash.json"), JSON.stringify({
      format: 1,
      phase: "purging",
      record: purgeRecord
    }));

    const afterPurgeCrash = new ExtensionLibraryManager({
      rootDirectory: ownerRoot,
      freeBytes: async () => 64 * 1024 * 1024 * 1024
    });
    await afterPurgeCrash.initialize();
    cleanups.push(() => afterPurgeCrash.close().catch(() => undefined));
    expect(afterPurgeCrash.listTrash()).toEqual([]);
  });

  it("finishes an interrupted grace-expiry purge without touching the active Library", async () => {
    const { temporaryPath, manager } = await fixture();
    const ownerRoot = join(temporaryPath, "owner");
    const control = join(ownerRoot, "library-state.json");
    const opened = await manager.openSession({ authority, connectionId: "web-grace-crash", assertAuthorityCurrent: currentAuthority() });
    await manager.write(opened.sessionId, "web-grace-crash", { path: "active.txt", bytes: Buffer.from("active") });
    const moved = await manager.relocate({
      authority,
      destination: { kind: "custom", candidate: join(temporaryPath, "custom") },
      assertAuthorityCurrent: currentAuthority()
    });
    await manager.close();

    const state = JSON.parse(await readFile(control, "utf8")) as {
      grace: Array<{ graceId: string; root: string; phase: "ready" | "purging"; [key: string]: unknown }>;
    };
    const grace = state.grace.find((entry) => entry.graceId === moved.graceId)!;
    grace.phase = "purging";
    await writeFile(control, JSON.stringify(state));
    await rm(grace.root, { recursive: true, force: false });

    const recovered = new ExtensionLibraryManager({
      rootDirectory: ownerRoot,
      freeBytes: async () => 64 * 1024 * 1024 * 1024
    });
    await recovered.initialize();
    cleanups.push(() => recovered.close().catch(() => undefined));
    expect(recovered.listGrace()).toEqual([]);
    await expect(recovered.overview({ authority, assertAuthorityCurrent: currentAuthority() }))
      .resolves.toMatchObject({ state: "ready", location: { kind: "custom", path: moved.location.path } });
    const session = await recovered.openSession({ authority, connectionId: "web-grace-crash", assertAuthorityCurrent: currentAuthority() });
    await expect(recovered.read(session.sessionId, "web-grace-crash", { path: "active.txt" }))
      .resolves.toMatchObject({ bytes: Buffer.from("active") });
  });

  it("fails closed on control corruption and explicitly recovers prior state plus untracked default data", async () => {
    const { temporaryPath, manager } = await fixture();
    const opened = await manager.openSession({ authority, connectionId: "web-4", assertAuthorityCurrent: currentAuthority() });
    await manager.write(opened.sessionId, "web-4", { path: "safe.txt", bytes: Buffer.from("safe") });
    await manager.close();
    const control = join(temporaryPath, "owner", "library-state.json");
    await writeFile(control, "corrupt");

    const recovered = new ExtensionLibraryManager({
      rootDirectory: join(temporaryPath, "owner"),
      freeBytes: async () => 64 * 1024 * 1024 * 1024
    });
    await recovered.initialize();
    cleanups.push(() => recovered.close().catch(() => undefined));
    await expect(recovered.overview({ authority, assertAuthorityCurrent: currentAuthority() }))
      .resolves.toMatchObject({ state: "unavailable", reason: "state_corrupt" });
    await expect(recovered.repairState()).resolves.toMatchObject({ recoveredFromPrevious: true, bindings: 1 });
    const session = await recovered.openSession({ authority, connectionId: "web-4", assertAuthorityCurrent: currentAuthority() });
    await expect(recovered.read(session.sessionId, "web-4", { path: "safe.txt" }))
      .resolves.toMatchObject({ bytes: Buffer.from("safe") });
    expect(JSON.parse(await readFile(control, "utf8"))).toMatchObject({ format: 1, bindings: [{ extensionId: EXTENSION_ID }] });
    const preserved = (await readdir(join(temporaryPath, "owner")))
      .find((name) => name.startsWith("library-state.corrupt."));
    expect(preserved).toEqual(expect.any(String));
    await expect(readFile(join(temporaryPath, "owner", preserved!), "utf8")).resolves.toBe("corrupt");
  });
});

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}
