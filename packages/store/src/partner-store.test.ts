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
