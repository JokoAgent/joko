import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { PartnerStore } from "./partner-store.js";
import { PartnerStoreError, type PartnerCapabilitiesRecord } from "./partner-types.js";

const cleanups: Array<() => Promise<void>> = [];
let creationSequence = 0;

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("PartnerStore", () => {
  it("persists three exact permission modes across defaults, inherited profiles, versions, CAS and reopen", async () => {
    const f = await fileStore();
    f.store.setDirectoryDefaults(f.store.directoryState().revision, { ...capabilities(), permissionMode: "bypassPermissions" });
    let inherited = f.store.createPartner({ ...draft("Permission follower"), expectedDirectoryRevision: f.store.directoryState().revision,
      usesDirectoryDefaults: true });
    expect(inherited.capabilities.permissionMode).toBe("bypassPermissions");
    const explicit = f.store.createPartner({ ...draft("Explicit permission"), expectedDirectoryRevision: f.store.directoryState().revision });
    for (const permissionMode of ["ask", "auto", "bypassPermissions"] as const) {
      const baseline = f.store.directoryState().revision;
      f.store.setDirectoryDefaults(baseline, { ...capabilities(), permissionMode });
      expectStoreError(() => f.store.setDirectoryDefaults(baseline, { ...capabilities(), permissionMode: "auto" }), "PARTNER_DIRECTORY_CHANGED");
      inherited = f.store.getPartner(inherited.id);
      expect(inherited.capabilities.permissionMode).toBe(permissionMode);
      expect(f.store.listProfileVersions(inherited.id)[0]?.capabilities.permissionMode).toBe(permissionMode);
      expect(f.store.getPartner(explicit.id).capabilities.permissionMode).toBe("ask");
    }
    const edited = f.store.updatePartner(explicit.id, explicit.revision, { capabilities: { ...capabilities(), permissionMode: "bypassPermissions" } });
    expectStoreError(() => f.store.updatePartner(explicit.id, explicit.revision, { capabilities: capabilities() }), "PARTNER_CHANGED");
    for (const invalid of ["trusted", "full_access", "unknown"]) {
      expectStoreError(() => f.store.updatePartner(explicit.id, edited.revision, {
        capabilities: { ...capabilities(), permissionMode: invalid as PartnerCapabilitiesRecord["permissionMode"] }
      }), "PARTNER_INVALID");
    }
    f.store.close(); const reopened = new PartnerStore(f.path); cleanups.push(async () => reopened.close());
    expect(reopened.directoryState().defaultCapabilities?.permissionMode).toBe("bypassPermissions");
    expect(reopened.getPartner(explicit.id).capabilities.permissionMode).toBe("bypassPermissions");
    expect(reopened.listProfileVersions(explicit.id).map(version => version.capabilities.permissionMode)).toEqual(["bypassPermissions", "ask"]);
  });

  it("rejects the exact prior two-mode development baseline without altering its records", async () => {
    const f = await fileStore(); const profile = readyPartner(f.store, "old-baseline-owner", "Baseline owner", "baseline-canonical");
    f.store.close();
    const database = new DatabaseSync(f.path);
    database.prepare("UPDATE partner_schema_version SET baseline_id = ? WHERE singleton = 1")
      .run("4a3630a6dfc08c6dbcce8faa757895125063c252e8eafe4bd3ce513820a06603");
    database.close();
    expect(() => new PartnerStore(f.path)).toThrow("Rebuild incompatible development data explicitly");
    const unchanged = new DatabaseSync(f.path);
    expect(unchanged.prepare("SELECT permission_mode, revision FROM partners WHERE id = ?").get(profile.id))
      .toMatchObject({ permission_mode: "ask", revision: Number(profile.revision) });
    expect(unchanged.prepare("SELECT baseline_id FROM partner_schema_version").get())
      .toMatchObject({ baseline_id: "4a3630a6dfc08c6dbcce8faa757895125063c252e8eafe4bd3ce513820a06603" });
    unchanged.close();
  });

  it("fences hidden group profile links independently of canonical and history ownership", async () => {
    const f = await fileStore(), profile = readyPartner(f.store, "group-owner", "Group owner", "group-canonical");
    const link = f.store.bindGroupSession({ partnerId: profile.id, expectedRevision: profile.revision, profileVersion: profile.profileVersion, sessionId: "group-lane" });
    expect(link).toMatchObject({ role: "group", partnerId: profile.id, profileVersion: profile.profileVersion });
    expect(f.store.findPartnerByCanonicalSession("group-lane")).toBeUndefined();
    expectStoreError(() => f.store.bindGroupSession({ partnerId: profile.id, expectedRevision: profile.revision, profileVersion: profile.profileVersion, sessionId: "group-canonical" }), "PARTNER_CHANGED");
    const edited = f.store.updatePartner(profile.id, profile.revision, { description: "Updated group persona" });
    const ready = f.store.markReady(edited.id, edited.revision);
    expect(f.store.getSessionLink("group-lane")?.profileVersion).toBe(profile.profileVersion);
    expect(f.store.advanceGroupSessionProfile("group-lane", profile.profileVersion, ready.revision).profileVersion).toBe(ready.profileVersion);
    expectStoreError(() => f.store.advanceGroupSessionProfile("group-lane", profile.profileVersion, ready.revision), "PARTNER_STORE_UNAVAILABLE");
  });
  it("persists an independent introduction across partial patches, defaults and reopen without changing identity", async () => {
    const f = await fileStore(), input = { ...draft("Introduction"), description: "Original introduction", expectedDirectoryRevision: f.store.directoryState().revision };
    const original = f.store.createPartner(input);
    expectStoreError(() => f.store.createPartner({ ...input, description: "A different create body" }), "PARTNER_CREATION_CONFLICT");
    const updated = f.store.updatePartner(original.id, original.revision, { description: "  New introduction\r\nSecond line  " });
    expect(updated).toMatchObject({ description: "New introduction\nSecond line", identitySource: original.identitySource,
      capabilities: original.capabilities, profileVersion: original.profileVersion + 1 });
    expectStoreError(() => f.store.updatePartner(original.id, original.revision, { description: "Stale" }), "PARTNER_CHANGED");
    for (const description of ["x".repeat(12_001), "Invalid\0text", "Bearer synthetic-secret-value-123456789012345678901234567890"]) {
      expectStoreError(() => f.store.updatePartner(original.id, updated.revision, { description }), "PARTNER_INVALID");
    }
    f.store.setDirectoryDefaults(f.store.directoryState().revision, capabilities());
    const inherited = f.store.updatePartner(original.id, updated.revision, { usesDirectoryDefaults: true });
    expect(inherited.description).toBe(updated.description); f.store.close();
    const reopened = new PartnerStore(f.path); cleanups.push(async () => reopened.close());
    expect(reopened.getPartner(original.id).description).toBe(updated.description);
    const cleared = reopened.updatePartner(original.id, inherited.revision, { description: "" });
    expect(cleared).toMatchObject({ description: "", identitySource: original.identitySource });
  });

  it("persists a single task route independently of primary defaults, freezes profile versions and clears it after reopen", async () => {
    const f = await fileStore(), partner = readyPartner(f.store, "task-owner", "Task owner", "task-canonical");
    const task = { ...route("task-backend", "task-provider", "task-model"), fastMode: true };
    const selected = f.store.updatePartner(partner.id, partner.revision, { taskModelOverride: task });
    expect(selected.taskModelOverride).toEqual(task); expect(selected.capabilities).toEqual(partner.capabilities);
    expectStoreError(() => f.store.updatePartner(partner.id, partner.revision, { taskModelOverride: null }), "PARTNER_CHANGED");
    f.store.setDirectoryDefaults(f.store.directoryState().revision, capabilities());
    const inherited = f.store.updatePartner(partner.id, selected.revision, { usesDirectoryDefaults: true });
    const primary = { ...capabilities(), modelChain: [route("backend-one", "provider-one", "new-primary")] };
    f.store.setDirectoryDefaults(f.store.directoryState().revision, primary);
    expect(f.store.getPartner(partner.id)).toMatchObject({ usesDirectoryDefaults: true, taskModelOverride: task, capabilities: primary });
    expect(f.store.listProfileVersions(partner.id).find(version => version.version === selected.profileVersion)).toMatchObject({ taskModelOverride: task, capabilities: partner.capabilities });
    expect(f.store.listProfileVersions(partner.id).find(version => version.version === partner.profileVersion)?.taskModelOverride).toBeUndefined();
    expect(inherited.taskModelOverride).toEqual(task); f.store.close();
    const reopened = new PartnerStore(f.path); cleanups.push(async () => reopened.close());
    const current = reopened.getPartner(partner.id); expect(current.taskModelOverride).toEqual(task);
    const cleared = reopened.updatePartner(partner.id, current.revision, { taskModelOverride: null });
    expect(cleared.taskModelOverride).toBeUndefined(); expect(cleared.capabilities).toEqual(primary);
    expect(reopened.listProfileVersions(partner.id)[0]?.taskModelOverride).toBeUndefined();
  });

  it("persists reversible shutdown before effects, retains per-Session manual pause preferences and fences admission until confirmed resume", async () => {
    const f = await fileStore(); const partner = readyPartner(f.store, "pause-owner", "Pause owner", "canonical-pause");
    const target = readyPartner(f.store, "pause-target", "Pause target", "canonical-target");
    const delegation = f.store.createDelegation({ id: "pause-delegation", requesterPartnerId: partner.id, targetPartnerId: target.id,
      parentSessionId: "canonical-pause", title: "Owned child", objective: "Bound delegated work." });
    f.store.bindDelegationSession(delegation.id, delegation.revision, "delegate-child");
    const pause = f.store.claimPartnerPause(partner.id, partner.revision);
    expect(f.store.getPartner(partner.id)).toMatchObject({ lifecycle: "paused", pauseCleanupPending: true });
    expect(f.store.isPartnerSessionPaused("canonical-pause")).toBe(true);
    expect(f.store.isPartnerSessionPaused("delegate-child")).toBe(true);
    expect(f.store.isPartnerSessionPaused("canonical-target")).toBe(false);
    expect(f.store.getDelegation(delegation.id).status).toBe("cancelled");
    expect(f.store.isPartnerSessionPaused("independent-task")).toBe(false);
    expectStoreError(() => f.store.setLifecycle(partner.id, f.store.getPartner(partner.id).revision, "active"), "PARTNER_CHANGED");
    f.store.capturePartnerPause(partner.id, pause.id, [
      { sessionId: "canonical-pause", wasQueuePaused: false, closeCompleted: false },
      { sessionId: "delegate-child", wasQueuePaused: true, closeCompleted: false }
    ]);
    expect(f.store.isPartnerSessionPaused("delegate-child")).toBe(true);
    f.store.advancePartnerPauseSession(partner.id, pause.id, { sessionId: "canonical-pause", queuePauseRevision: 9n, closeCompleted: true });
    f.store.recordPartnerPauseFailure(partner.id, pause.id); f.store.close();
    const reopened = new PartnerStore(f.path); cleanups.push(async () => reopened.close());
    expect(reopened.getPartnerPause(partner.id)).toMatchObject({ id: pause.id, phase: "closing", failure: "runtime_close_pending", sessions: [
      { sessionId: "canonical-pause", wasQueuePaused: false, queuePauseRevision: 9n, closeCompleted: true },
      { sessionId: "delegate-child", wasQueuePaused: true, closeCompleted: false }
    ] });
    expectStoreError(() => reopened.preparePartnerResume(partner.id, pause.id), "PARTNER_CHANGED");
    reopened.advancePartnerPauseSession(partner.id, pause.id, { sessionId: "delegate-child", closeCompleted: true });
    reopened.settlePartnerPause(partner.id, pause.id); expect(reopened.getPartner(partner.id).pauseCleanupPending).toBe(false);
    reopened.preparePartnerResume(partner.id, pause.id); expect(reopened.isPartnerSessionPaused("canonical-pause")).toBe(true);
    const resumed = reopened.finishPartnerResume(partner.id, pause.id);
    expect(resumed.lifecycle).toBe("active"); expect(resumed.canonicalSessionId).toBe(partner.canonicalSessionId);
    expect(resumed.profileVersion).toBe(partner.profileVersion); expect(reopened.getPartnerPause(partner.id)).toBeUndefined();
    expect(reopened.isPartnerSessionPaused("delegate-child")).toBe(false);
  });

  it("retains paused ownership after a failed resume and keeps stale or unrelated shutdown checkpoints from changing it", async () => {
    const f = await fileStore(); const partner = readyPartner(f.store, "pause-retry", "Pause retry", "retry-session");
    const pause = f.store.claimPartnerPause(partner.id, partner.revision);
    expectStoreError(() => f.store.claimPartnerPause(partner.id, partner.revision), "PARTNER_CHANGED");
    expectStoreError(() => f.store.capturePartnerPause(partner.id, "other-owner", []), "PARTNER_CHANGED");
    f.store.capturePartnerPause(partner.id, pause.id, []); f.store.settlePartnerPause(partner.id, pause.id);
    f.store.preparePartnerResume(partner.id, pause.id); f.store.recordPartnerPauseFailure(partner.id, pause.id);
    expect(f.store.getPartnerPause(partner.id)).toMatchObject({ phase: "resuming", failure: "state_commit_pending" });
    expect(f.store.getPartner(partner.id)).toMatchObject({ lifecycle: "paused", pauseCleanupPending: true });
    expectStoreError(() => f.store.updatePartner(partner.id, f.store.getPartner(partner.id).revision, { displayName: "Too early" }), "PARTNER_CHANGED");
    f.store.finishPartnerResume(partner.id, pause.id);
    expectStoreError(() => f.store.finishPartnerResume(partner.id, pause.id), "PARTNER_CHANGED");
  });

  it("preserves paused readiness across profile and shared default edits and transfers every owned task to confirmed deletion", async () => {
    const f = await fileStore(); f.store.setDirectoryDefaults(f.store.directoryState().revision, capabilities());
    let partner = readyPartner(f.store, "pause-settings", "Paused settings", "settings-session");
    partner = f.store.updatePartner(partner.id, partner.revision, { usesDirectoryDefaults: true });
    partner = f.store.markReady(partner.id, partner.revision);
    const pause = f.store.claimPartnerPause(partner.id, partner.revision);
    f.store.capturePartnerPause(partner.id, pause.id, [{ sessionId: "settings-session", wasQueuePaused: false, closeCompleted: false },
      { sessionId: "foreign-child", wasQueuePaused: true, closeCompleted: false }]);
    for (const sessionId of ["settings-session", "foreign-child"]) f.store.advancePartnerPauseSession(partner.id, pause.id, { sessionId, closeCompleted: true });
    f.store.settlePartnerPause(partner.id, pause.id);
    let edited = f.store.updatePartner(partner.id, f.store.getPartner(partner.id).revision, { displayName: "Saved paused settings" });
    expect(edited).toMatchObject({ lifecycle: "paused", initializationState: "ready", invitationStage: "ready", pauseCleanupPending: false });
    f.store.setDirectoryDefaults(f.store.directoryState().revision, { ...capabilities(), permissionMode: "auto" });
    edited = f.store.getPartner(partner.id); expect(edited).toMatchObject({ initializationState: "ready", capabilities: { permissionMode: "auto" } });
    f.store.preparePartnerResume(partner.id, pause.id); f.store.recordPartnerPauseFailure(partner.id, pause.id);
    const deletion = f.store.claimPartnerDeletion({ requestId: "pause-settings-delete", partnerId: partner.id, expectedRevision: edited.revision, confirmName: edited.displayName });
    expect(deletion.sessionIds).toContain("foreign-child"); expect(f.store.getPartnerPause(partner.id)).toBeUndefined();
    expect(f.store.isPartnerSessionRetiring("foreign-child")).toBe(true);
  });

  it("persists restart ownership and prevents mutable profile or deletion races until shutdown is ready", async () => {
    const f = await fileStore(); const partner = readyPartner(f.store, "restart-owner", "Restart owner", "canonical-restart");
    const input = { requestId: "restart-persisted-intent", partnerId: partner.id, expectedRevision: partner.revision,
      sourceBindingFingerprint: "a".repeat(64), sourceGeneration: 1 };
    f.store.retirePartnerRestart("restart-retired-intent");
    expectStoreError(() => f.store.claimPartnerRestart({ ...input, requestId: "restart-retired-intent" }), "PARTNER_INVALID");
    const restart = f.store.claimPartnerRestart(input);
    expect(f.store.claimPartnerRestart(input)).toEqual(restart);
    expect(f.store.retirePartnerRestart(input.requestId)).toEqual(restart);
    expectStoreError(() => f.store.updatePartner(partner.id, partner.revision, { displayName: "Changed" }), "PARTNER_CHANGED");
    expectStoreError(() => f.store.claimPartnerDeletion({ requestId: "deletion-during-restart", partnerId: partner.id,
      expectedRevision: partner.revision, confirmName: partner.displayName }), "PARTNER_CHANGED");
    expect(f.store.isPartnerSessionRestarting("canonical-restart")).toBe(true);
    f.store.settlePartnerRestart(input.requestId, false); f.store.close();
    const reopened = new PartnerStore(f.path); cleanups.push(async () => reopened.close());
    expect(reopened.getPartnerRestart(input.requestId)).toMatchObject({ phase: "closing", failure: "runtime_close_pending" });
    expect(reopened.isPartnerRestartRetired("restart-retired-intent")).toBe(true);
    reopened.settlePartnerRestart(input.requestId, true);
    expect(reopened.isPartnerSessionRestarting("canonical-restart")).toBe(false);
    expect(reopened.updatePartner(partner.id, partner.revision, { displayName: "After restart" }).displayName).toBe("After restart");
  });
  it("claims confirmed deletion before effects and durably fences absent or duplicated intents", async () => {
    const fixture = await fileStore(); const input = { expectedDirectoryRevision: 1n, ...draft("Delete me") };
    const profile = fixture.store.createPartner(input);
    expectStoreError(() => fixture.store.setLifecycle(profile.id, profile.revision, "deleted"), "PARTNER_INVALID");
    expectStoreError(() => fixture.store.claimPartnerDeletion({ requestId: "deletion-wrong-name", partnerId: profile.id,
      expectedRevision: profile.revision, confirmName: "Delete" }), "PARTNER_INVALID");
    expect(fixture.store.getPartner(profile.id)).toEqual(profile);
    fixture.store.retirePartnerDeletion("deletion-absent-request");
    expectStoreError(() => fixture.store.claimPartnerDeletion({ requestId: "deletion-absent-request", partnerId: profile.id,
      expectedRevision: profile.revision, confirmName: profile.displayName }), "PARTNER_INVALID");
    const claimed = fixture.store.claimPartnerDeletion({ requestId: "deletion-confirmed-request", partnerId: profile.id,
      expectedRevision: profile.revision, confirmName: profile.displayName });
    expect(claimed).toMatchObject({ phase: "closing", partnerId: profile.id });
    expect(fixture.store.listPartners()).toEqual([]);
    expect(fixture.store.retirePartnerDeletion(claimed.requestId)).toEqual(claimed);
    expect(fixture.store.claimPartnerDeletion({ requestId: claimed.requestId, partnerId: profile.id,
      expectedRevision: profile.revision, confirmName: "Changed caller body" })).toEqual(claimed);
    fixture.store.close(); const reopened = new PartnerStore(fixture.path); cleanups.push(async () => reopened.close());
    expect(reopened.getPartnerDeletion(claimed.requestId)).toEqual(claimed);
    expect(reopened.isPartnerDeletionRetired("deletion-absent-request")).toBe(true);
    reopened.advancePartnerDeletion(claimed.requestId); reopened.completePartnerDeletion(claimed.requestId);
    expectStoreError(() => reopened.getPartner(profile.id), "PARTNER_NOT_FOUND");
    expect(reopened.getPartnerCreation(input.requestId)).toBeUndefined();
    expectStoreError(() => reopened.createPartner(input), "PARTNER_CREATION_RETIRED");
    expectStoreError(() => reopened.createPartner({ ...input, id: profile.id, requestId: "creation-request-reused-id",
      expectedDirectoryRevision: reopened.directoryState().revision }), "PARTNER_CREATION_RETIRED");
  });

  it("erases profile versions and unused private photos while retaining a shared photo", async () => {
    const fixture = await fileStore();
    const photo = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=", "base64");
    const first = fixture.store.createPartner({ expectedDirectoryRevision: 1n, ...draft("First"), avatar: { base64: photo.toString("base64") } });
    const second = fixture.store.createPartner({ expectedDirectoryRevision: fixture.store.directoryState().revision,
      ...draft("Second"), avatar: { base64: photo.toString("base64") } });
    const remove = (profile: typeof first, id: string): void => {
      fixture.store.claimPartnerDeletion({ requestId: id, partnerId: profile.id, expectedRevision: profile.revision, confirmName: profile.displayName });
      fixture.store.advancePartnerDeletion(id); fixture.store.completePartnerDeletion(id);
    };
    remove(first, "deletion-first-photo");
    if (typeof second.avatar === "string") throw new Error("An image is required.");
    expect(fixture.store.readPartnerAvatar(second.id, second.revision, second.avatar.sha256).content).toEqual(new Uint8Array(photo));
    const db = new DatabaseSync(fixture.path);
    expect(db.prepare("SELECT count(*) AS count FROM partner_profile_versions WHERE partner_id = ?").get(first.id)).toMatchObject({ count: 0 });
    remove(second, "deletion-second-photo");
    expect(db.prepare("SELECT count(*) AS count FROM partner_avatar_images").get()).toMatchObject({ count: 0 });
    expect(db.prepare("SELECT count(*) AS count FROM partner_profile_versions").get()).toMatchObject({ count: 0 });
    db.close();
  });
  it("atomically owns image bytes outside public profiles and reads only the exact live revision across reopen", async () => {
    const fixture = await fileStore();
    const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=";
    const created = fixture.store.createPartner({ expectedDirectoryRevision: 1n, ...draft("A".repeat(200)), avatar: { base64 } });
    expect(typeof created.avatar).toBe("object");
    const image = created.avatar as Exclude<typeof created.avatar, string>;
    expect(image).toMatchObject({ mimeType: "image/png", byteLength: Buffer.from(base64, "base64").length });
    expect(JSON.stringify({ ...created, revision: String(created.revision) })).not.toContain(base64);
    expect(fixture.store.readPartnerAvatar(created.id, created.revision, image.sha256).content).toEqual(new Uint8Array(Buffer.from(base64, "base64")));
    expectStoreError(() => fixture.store.readPartnerAvatar(created.id, created.revision, "a".repeat(64)), "PARTNER_NOT_FOUND");
    fixture.store.close(); const reopened = new PartnerStore(fixture.path); cleanups.push(async () => reopened.close());
    expect(reopened.readPartnerAvatar(created.id, created.revision, image.sha256).image).toEqual(image);
    const updated = reopened.updatePartner(created.id, created.revision, { displayName: "Updated" });
    expectStoreError(() => reopened.readPartnerAvatar(created.id, created.revision, image.sha256), "PARTNER_CHANGED");
    expect(reopened.readPartnerAvatar(created.id, updated.revision, image.sha256).image).toEqual(image);
    reopened.claimPartnerDeletion({ requestId: "deletion-avatar-request", partnerId: created.id, expectedRevision: updated.revision, confirmName: updated.displayName });
    const deleted = reopened.getPartner(created.id);
    expectStoreError(() => reopened.readPartnerAvatar(created.id, deleted.revision, image.sha256), "PARTNER_NOT_FOUND");
  });

  it("rejects invalid image/name inputs without advancing revisions and reclaims replaced private bytes", async () => {
    const fixture = await fileStore();
    const input = { expectedDirectoryRevision: 1n, ...draft("Aster") };
    for (const avatar of [{ base64: "not-an-image" }, { base64: "PHN2Zz48L3N2Zz4=" }, { base64: "A".repeat(7_000_000) }]) {
      expectStoreError(() => fixture.store.createPartner({ ...input, avatar }), "PARTNER_INVALID");
    }
    expectStoreError(() => fixture.store.createPartner({ ...input, displayName: "A".repeat(201) }), "PARTNER_INVALID");
    expect(fixture.store.directoryState().revision).toBe(1n);
    const created = fixture.store.createPartner({ ...input, avatar: { base64: "/9j/2w==" } });
    const image = created.avatar as Exclude<typeof created.avatar, string>;
    const replacement = fixture.store.updatePartner(created.id, created.revision, { avatar: "spark" });
    expect(replacement.avatar).toBe("spark");
    const database = new DatabaseSync(fixture.path);
    try { expect(database.prepare("SELECT sha256 FROM partner_avatar_images WHERE sha256 = ?").get(image.sha256)).toBeUndefined(); }
    finally { database.close(); }
  });

  it("replays a durable creation intent across edits and reopen without replacing the current profile", async () => {
    const fixture = await fileStore();
    const input = { expectedDirectoryRevision: 1n, ...draft("Aster") };
    const created = fixture.store.createPartner(input);
    const updated = fixture.store.updatePartner(created.id, created.revision, { displayName: "Aster updated", identitySource: "Keep the newer identity." });
    const revision = fixture.store.directoryState().revision;
    expect(fixture.store.createPartner(input)).toEqual(updated);
    expect(fixture.store.directoryState().revision).toBe(revision);
    expect(fixture.store.getPartnerCreation(input.requestId)).toEqual(updated);
    fixture.store.close();
    const reopened = new PartnerStore(fixture.path);
    cleanups.push(async () => reopened.close());
    expect(reopened.createPartner(input)).toEqual(updated);
    expect(reopened.listPartners()).toHaveLength(1);
    expect(reopened.listProfileVersions(created.id)).toHaveLength(2);
  });

  it("fences a creation request body and original directory identity before admitting a new intent", () => {
    const store = memoryStore(["one", "two"]);
    const input = { expectedDirectoryRevision: 1n, ...draft("Aster") };
    const created = store.createPartner(input);
    expectStoreError(() => store.createPartner({ ...input, displayName: "Beryl" }), "PARTNER_CREATION_CONFLICT");
    expectStoreError(() => store.createPartner({ ...input, expectedDirectoryRevision: 2n }), "PARTNER_CREATION_CONFLICT");
    expectStoreError(() => store.createPartner({ ...input, id: "other-id" }), "PARTNER_CREATION_CONFLICT");
    expectStoreError(() => store.createPartner({ ...input, requestId: "invalid" }), "PARTNER_INVALID");
    expectStoreError(() => store.createPartner({ ...input, requestId: "creation-request-stale" }), "PARTNER_DIRECTORY_CHANGED");
    expect(store.getPartnerCreation("creation-request-absent")).toBeUndefined();
    expect(store.getPartnerCreation(input.requestId)).toEqual(created);
    expect(store.directoryState().revision).toBe(2n);
  });

  it("replays inherited creation intent after directory defaults change without reverting capabilities", () => {
    const store = memoryStore(["one"]);
    store.setDirectoryDefaults(1n, capabilities());
    const input = { expectedDirectoryRevision: 2n, ...draft("Aster"), usesDirectoryDefaults: true };
    const created = store.createPartner(input);
    const next = { ...capabilities(), planMode: true };
    store.setDirectoryDefaults(3n, next);
    const current = store.getPartner(created.id);
    expect(store.createPartner({ ...input, capabilities: next })).toEqual(current);
    expect(current.capabilities.planMode).toBe(true);
    expect(store.directoryState().revision).toBe(4n);
  });

  it("durably retires an absent creation ID before a delayed create and never retires an existing result", async () => {
    const fixture = await fileStore();
    const input = { expectedDirectoryRevision: 1n, ...draft("Aster") };
    expect(fixture.store.retirePartnerCreation(input.requestId)).toBeUndefined();
    fixture.store.close();
    const reopened = new PartnerStore(fixture.path);
    cleanups.push(async () => reopened.close());
    expectStoreError(() => reopened.createPartner(input), "PARTNER_CREATION_RETIRED");
    expect(reopened.retirePartnerCreation(input.requestId)).toBeUndefined();
    const next = { ...input, requestId: "creation-request-replacement" };
    const created = reopened.createPartner(next);
    expect(reopened.retirePartnerCreation(next.requestId)).toEqual(created);
    expect(reopened.createPartner(next)).toEqual(created);
    expect(reopened.listPartners()).toHaveLength(1);
  });

  it("keeps deleted creation identities retired even when a new intent reuses the display name", () => {
    const store = memoryStore(["one", "two"]);
    const input = { expectedDirectoryRevision: 1n, ...draft("Aster") };
    const created = store.createPartner(input);
    const deletion = store.claimPartnerDeletion({ requestId: "deletion-created-request", partnerId: created.id, expectedRevision: created.revision, confirmName: created.displayName });
    const deleted = store.getPartner(created.id);
    expect(store.getPartnerCreation(input.requestId)).toEqual(deleted);
    expect(store.retirePartnerCreation(input.requestId)).toEqual(deleted);
    expectStoreError(() => store.createPartner(input), "PARTNER_CREATION_RETIRED");
    store.advancePartnerDeletion(deletion.requestId); store.completePartnerDeletion(deletion.requestId);
    expect(store.getPartnerCreation(input.requestId)).toBeUndefined();
    const replacement = store.createPartner({ ...input, requestId: "creation-request-new-partner", expectedDirectoryRevision: 4n });
    expect(replacement.id).not.toBe(deleted.id);
    expectStoreError(() => store.getPartner(deleted.id), "PARTNER_NOT_FOUND");
  });

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
    store.claimPartnerDeletion({ requestId: "deletion-name-reuse", partnerId: first.id, expectedRevision: archived.revision, confirmName: first.displayName });
    const deleted = store.getPartner(first.id);
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

  it("retains a five-route chain in defaults and immutable profiles across reopen, rejecting a sixth atomically", async () => {
    const fixture = await fileStore();
    const next = { ...capabilities(), modelChain: Array.from({ length: 5 }, (_, index) =>
      route("backend-one", "provider-one", `model-${index + 1}`)) };
    fixture.store.setDirectoryDefaults(1n, next);
    const partner = fixture.store.createPartner({ ...draft("Route keeper"), expectedDirectoryRevision: 2n, usesDirectoryDefaults: true });
    const before = fixture.store.directoryState();
    expectStoreError(() => fixture.store.setDirectoryDefaults(before.revision, { ...next,
      modelChain: [...next.modelChain, route("backend-one", "provider-one", "model-6")] }), "PARTNER_INVALID");
    expect(fixture.store.directoryState()).toEqual(before);
    fixture.store.close();
    const reopened = new PartnerStore(fixture.path); cleanups.push(async () => reopened.close());
    expect(reopened.directoryState().defaultCapabilities).toEqual(next);
    expect(reopened.getPartner(partner.id).capabilities).toEqual(next);
    expect(reopened.listProfileVersions(partner.id)[0]?.capabilities).toEqual(next);
  });

  it("rejects duplicate model routes and rolls back creation without advancing the directory", () => {
    const store = memoryStore(["one"]);
    expectStoreError(() => store.createPartner({
      expectedDirectoryRevision: 1n,
      ...draft("Aster"),
      capabilities: {
        ...capabilities(),
        modelChain: [
          route("backend-one", "provider-one", "model-one"),
          route("backend-one", "provider-one", "model-one")
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
    requestId: `creation-request-${++creationSequence}`,
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
