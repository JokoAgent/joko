import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeBackendAdapter, PI_LIKE_PROFILE } from "@joko/testkit";
import {
  OperationalStore,
  PartnerStore,
  PartnerStoreError,
  type PartnerCapabilitiesRecord,
  type PartnerProfileRecord
} from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OperationalArtifactRepository } from "./artifact-repository.js";
import { ArtifactStore } from "./artifact-store.js";
import { PartnerManager, partnerSessionRuntimeFallback, type PartnerManagerOptions } from "./partner-manager.js";
import { SessionHost } from "./session-host.js";

const cleanups: Array<() => Promise<void> | void> = [];
const PARTNER_PROFILE = {
  ...PI_LIKE_PROFILE,
  capabilities: [
    ...PI_LIKE_PROFILE.capabilities.map((capability) => capability.key === "permission.modes"
      ? { key: "permission.modes", supported: true, options: ["ask", "auto", "bypassPermissions"] }
      : capability),
    { key: "permission.change", supported: true }
  ]
} as const;
const EFFORTLESS_PARTNER_PROFILE = {
  ...PARTNER_PROFILE,
  id: "fake-effortless-partner",
  displayName: "Effortless Partner Fake",
  models: [{
    ...PARTNER_PROFILE.models[0]!,
    thinkingLevels: []
  }]
} as const;

class OffSentinelFakeBackendAdapter extends FakeBackendAdapter {
  override async inspectSession(...args: Parameters<FakeBackendAdapter["inspectSession"]>) {
    return { ...await super.inspectSession(...args), effort: "off" };
  }
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("PartnerManager", () => {
  it("creates a durable home Target and exactly one canonical Session", async () => {
    const fixture = await createFixture();
    const created = await fixture.manager.createPartner(createInput(fixture.partnerStore, "Aster"));

    expect(created).toMatchObject({
      displayName: "Aster",
      initializationState: "ready",
      invitationStage: "ready",
      profileVersion: 1
    });
    expect(created.canonicalSessionId).toBeDefined();
    const target = fixture.operationalStore.getTarget(created.homeTargetId).descriptor;
    expect(target).toMatchObject({ backendId: PI_LIKE_PROFILE.id, managed: true, trusted: true });
    expect(fixture.operationalStore.getTarget(created.homeTargetId).metadata).toMatchObject({
      kind: "partner_home",
      partnerId: created.id,
      workspaceId: created.homeTargetId
    });
    expect(fixture.registerWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      id: created.homeTargetId,
      displayName: "Aster home",
      trusted: true
    }));
    const session = fixture.operationalStore.getSession(created.canonicalSessionId!).descriptor;
    expect(session).toMatchObject({
      backendId: PI_LIKE_PROFILE.id,
      targetId: created.homeTargetId,
      title: "Aster",
      providerId: "test",
      modelId: "text",
      effort: "medium",
      permissionMode: "ask",
      planMode: false,
      archived: false
    });
    expect(session.appendSystemPrompt).toBe(created.identitySource);

    const updatedIdentity = "You are Aster's current version-two identity.";
    const updated = await fixture.manager.updatePartner(created.id, created.revision, {
      identitySource: updatedIdentity
    });
    expect(updated).toMatchObject({
      canonicalSessionId: created.canonicalSessionId,
      profileVersion: 2,
      initializationState: "ready"
    });
    expect(fixture.operationalStore.getSession(created.canonicalSessionId!).descriptor.appendSystemPrompt)
      .toBe(updatedIdentity);

    const homes = readdirSync(fixture.homesRoot);
    expect(homes).toHaveLength(1);
    const home = join(fixture.homesRoot, homes[0]!);
    expect(readFileSync(join(home, "IDENTITY.md"), "utf8")).toContain("version-two identity");
    expect(existsSync(join(home, "AVATAR.svg"))).toBe(true);
    expect(JSON.parse(readFileSync(join(home, ".joko-partner.json"), "utf8"))).toMatchObject({
      format: 1,
      partnerId: created.id,
      profileVersion: 2,
      usesDirectoryDefaults: false
    });
  });

  it("accepts a disabled-effort native sentinel for a model without an effort axis", async () => {
    const fixture = await createFixture(
      undefined,
      new OffSentinelFakeBackendAdapter(EFFORTLESS_PARTNER_PROFILE)
    );
    const partnerCapabilities: PartnerCapabilitiesRecord = {
      modelChain: [{
        backendId: EFFORTLESS_PARTNER_PROFILE.id,
        providerId: "test",
        modelId: "text",
        fastMode: false
      }],
      permissionMode: "ask",
      planMode: false
    };
    const created = await fixture.manager.createPartner({
      expectedDirectoryRevision: fixture.partnerStore.directoryState().revision,
      displayName: "Plain partner",
      avatar: "orbit",
      identitySource: "You are a durable plain-model partner.",
      templateId: "general",
      capabilities: partnerCapabilities,
      usesDirectoryDefaults: false
    });

    const updated = await fixture.manager.updatePartner(created.id, created.revision, {
      displayName: "Plain partner updated",
      identitySource: "You are the updated durable plain-model partner."
    });

    expect(updated).toMatchObject({
      canonicalSessionId: created.canonicalSessionId,
      initializationState: "ready",
      invitationStage: "ready",
      profileVersion: 2
    });
    const session = fixture.operationalStore.getSession(created.canonicalSessionId!).descriptor;
    expect(session).toMatchObject({
      title: "Plain partner updated",
      providerId: "test",
      modelId: "text",
      appendSystemPrompt: "You are the updated durable plain-model partner."
    });
    expect(session.effort).toBeUndefined();
  });

  it("surfaces avatar preparation failure and resumes the same profile without duplicating a Session", async () => {
    const fixture = await createFixture(async () => { throw new Error("avatar unavailable"); });
    const failed = await fixture.manager.createPartner(createInput(fixture.partnerStore, "Mica"));
    expect(failed).toMatchObject({
      initializationState: "error",
      invitationStage: "failed",
      initializationErrorCode: "avatar_unavailable"
    });
    expect(failed.canonicalSessionId).toBeUndefined();
    expect(fixture.operationalStore.listSessions({ includeArchived: true, includeDeleted: true })).toEqual([]);

    const resumedManager = new PartnerManager({
      store: fixture.partnerStore,
      operationalStore: fixture.operationalStore,
      sessionHost: fixture.sessionHost,
      workspaceService: fixture.workspaceService,
      homesRoot: fixture.homesRoot
    });
    const ready = await resumedManager.retryInitialization(failed.id, failed.revision);
    expect(ready).toMatchObject({ initializationState: "ready", invitationStage: "ready" });
    expect(fixture.operationalStore.listSessions({ includeArchived: true, includeDeleted: true })).toHaveLength(1);
  });

  it("recovers an interrupted missing canonical Session from its exact profile fence", async () => {
    const fixture = await createFixture();
    const created = fixture.partnerStore.createPartner(createInput(fixture.partnerStore, "Nova"));
    const stale = fixture.partnerStore.bindCanonicalSession({
      partnerId: created.id,
      expectedRevision: created.revision,
      expectedProfileVersion: created.profileVersion,
      sessionId: "missing-session"
    });
    const ready = fixture.partnerStore.markReady(stale.id, stale.revision);
    fixture.partnerStore.prepareInitialization(ready.id, ready.revision);

    await fixture.manager.recoverPending();
    const recovered = fixture.partnerStore.getPartner(created.id);
    expect(recovered).toMatchObject({ initializationState: "ready", invitationStage: "ready" });
    expect(recovered.canonicalSessionId).not.toBe("missing-session");
    expect(fixture.operationalStore.getSession(recovered.canonicalSessionId!).descriptor.targetId)
      .toBe(recovered.homeTargetId);
    expect(fixture.operationalStore.listSessions({ includeArchived: true, includeDeleted: true })).toHaveLength(1);
    expect(fixture.partnerStore.listSessionLinks(recovered.id)).toEqual([
      expect.objectContaining({ sessionId: recovered.canonicalSessionId, role: "canonical" }),
      expect.objectContaining({ sessionId: "missing-session", role: "history" })
    ]);
  });

  it("applies directory defaults only to inheriting partners and preserves lifecycle Session isolation", async () => {
    const fixture = await createFixture();
    await fixture.manager.updateDirectoryDefaults(fixture.partnerStore.directoryState().revision, capabilities());
    const inherited = await fixture.manager.createPartner({
      ...createInput(fixture.partnerStore, "Aster"),
      usesDirectoryDefaults: true
    });
    const explicit = await fixture.manager.createPartner(createInput(fixture.partnerStore, "Beryl"));
    const beforeExplicit = fixture.partnerStore.getPartner(explicit.id);
    const nextDefaults: PartnerCapabilitiesRecord = {
      modelChain: [{
        backendId: PI_LIKE_PROFILE.id,
        providerId: "vision",
        modelId: "multimodal",
        effort: "high",
        fastMode: false
      }],
      permissionMode: "auto",
      planMode: true
    };
    const affected = await fixture.manager.updateDirectoryDefaults(
      fixture.partnerStore.directoryState().revision,
      nextDefaults
    );
    expect(affected.map((profile) => profile.id)).toEqual([inherited.id]);
    expect(fixture.partnerStore.getPartner(inherited.id)).toMatchObject({
      capabilities: nextDefaults,
      usesDirectoryDefaults: true,
      initializationState: "ready"
    });
    expect(fixture.partnerStore.getPartner(explicit.id)).toEqual(beforeExplicit);

    const sessionId = inherited.canonicalSessionId!;
    const sessionBeforeLifecycle = fixture.operationalStore.getSession(sessionId).descriptor;
    const archived = await fixture.manager.setLifecycle(
      inherited.id,
      fixture.partnerStore.getPartner(inherited.id).revision,
      "archived"
    );
    const restored = await fixture.manager.setLifecycle(inherited.id, archived.revision, "active");
    const deleted = await fixture.manager.setLifecycle(inherited.id, restored.revision, "deleted");
    expect(deleted.lifecycle).toBe("deleted");
    expect(fixture.operationalStore.getSession(sessionId).descriptor).toEqual({
      ...sessionBeforeLifecycle,
      providerId: "vision",
      modelId: "multimodal",
      effort: "high",
      permissionMode: "auto",
      planMode: true,
      updatedAt: expect.any(Number)
    });
  });

  it("rejects an unavailable model edit before changing the last usable profile", async () => {
    const fixture = await createFixture();
    const created = await fixture.manager.createPartner(createInput(fixture.partnerStore, "Aster"));
    await expect(fixture.manager.updatePartner(created.id, created.revision, {
      capabilities: {
        ...created.capabilities,
        modelChain: [{
          backendId: PI_LIKE_PROFILE.id,
          providerId: "test",
          modelId: "missing",
          fastMode: false
        }]
      }
    })).rejects.toMatchObject({ code: "PARTNER_MODEL_UNAVAILABLE" });
    expect(fixture.partnerStore.getPartner(created.id)).toEqual(created);
  });

  it("uses only the configured Partner model chain for runtime fallback", async () => {
    const fixture = await createFixture();
    const primary = capabilities().modelChain[0]!;
    const secondary = {
      backendId: PI_LIKE_PROFILE.id,
      providerId: "vision",
      modelId: "multimodal",
      effort: "high",
      fastMode: false
    } as const;
    const created = await fixture.manager.createPartner({
      ...createInput(fixture.partnerStore, "Route partner"),
      capabilities: { ...capabilities(), modelChain: [primary, secondary] }
    });
    expect(partnerSessionRuntimeFallback(fixture.partnerStore, {
      sessionId: created.canonicalSessionId!,
      current: primary,
      visitedRoutes: [],
      currentHop: 0
    })).toEqual({ owned: true, candidate: secondary });
    expect(partnerSessionRuntimeFallback(fixture.partnerStore, {
      sessionId: created.canonicalSessionId!,
      current: secondary,
      visitedRoutes: [`${primary.providerId}\0${primary.modelId}`],
      currentHop: 1
    })).toEqual({ owned: true });
    expect(partnerSessionRuntimeFallback(fixture.partnerStore, {
      sessionId: "ordinary-session",
      current: primary,
      visitedRoutes: [],
      currentHop: 0
    })).toEqual({ owned: false });
  });

  it("delivers bounded private messages through canonical tasks and owns unread state", async () => {
    const fixture = await createFixture();
    const sender = await fixture.manager.createPartner(createInput(fixture.partnerStore, "Aster"));
    const recipient = await fixture.manager.createPartner(createInput(fixture.partnerStore, "Beryl"));

    const delivered = await fixture.manager.sendPrivateMessage({
      callerSessionId: sender.canonicalSessionId!,
      targetPartnerId: recipient.id,
      content: "Please check whether the retry boundary is safe."
    });
    expect(delivered.message).toMatchObject({
      senderPartnerId: sender.id,
      recipientPartnerId: recipient.id,
      deliveryStatus: "delivered"
    });
    expect(delivered.reservation.remainingMessages).toBe(11);

    await vi.waitFor(() => {
      expect(fixture.manager.activity(recipient.id).unreadReplyCount).toBe(1);
    });
    const activity = fixture.manager.activity(recipient.id);
    expect(activity.latestReplyCursor).toBeDefined();
    expect(activity.artifactCount).toBe(0);
    expect(fixture.manager.markRead(recipient.id, activity.latestReplyCursor!)).toMatchObject({
      throughCursor: activity.latestReplyCursor
    });
    expect(fixture.manager.activity(recipient.id).unreadReplyCount).toBe(0);

    const thread = fixture.manager.getPrivateThread(delivered.reservation.thread.id, recipient.id);
    expect(thread.messages).toEqual([
      expect.objectContaining({ content: "Please check whether the retry boundary is safe." })
    ]);
    expect(fixture.manager.markPrivateThreadRead(
      thread.thread.id,
      recipient.id,
      thread.messages.at(-1)!.sequence
    ).throughSequence).toBe(1);
    expect(() => fixture.manager.getPrivateThread(thread.thread.id, "unrelated-partner"))
      .toThrowError(PartnerStoreError);
  });

  it("replays a persisted private delivery with the same operation after recovery", async () => {
    const fixture = await createFixture();
    const sender = await fixture.manager.createPartner(createInput(fixture.partnerStore, "Aster"));
    const recipient = await fixture.manager.createPartner(createInput(fixture.partnerStore, "Beryl"));
    const reserved = fixture.partnerStore.reservePrivateMessage({
      senderPartnerId: sender.id,
      recipientPartnerId: recipient.id,
      senderSessionId: sender.canonicalSessionId!,
      recipientSessionId: recipient.canonicalSessionId!,
      content: "Resume this exact delivery after reconnect."
    });
    expect(fixture.partnerStore.listPendingPrivateMessages()).toEqual([
      expect.objectContaining({ id: reserved.message.id, operationId: reserved.message.operationId })
    ]);

    await fixture.manager.retryPendingPrivateMessages();
    await fixture.manager.retryPendingPrivateMessages();

    expect(fixture.partnerStore.listPendingPrivateMessages()).toEqual([]);
    expect(fixture.manager.getPrivateThread(reserved.thread.id, recipient.id).messages).toEqual([
      expect.objectContaining({
        id: reserved.message.id,
        operationId: reserved.message.operationId,
        deliveryStatus: "delivered"
      })
    ]);
    expect(fixture.operationalStore.getOperation(reserved.message.operationId).status).toBe("completed");
  });

  it("recovers a persisted delegation into a distinct target-owned task", async () => {
    const fixture = await createFixture();
    const requester = await fixture.manager.createPartner(createInput(fixture.partnerStore, "Aster"));
    const target = await fixture.manager.createPartner(createInput(fixture.partnerStore, "Beryl"));
    const persisted = fixture.partnerStore.createDelegation({
      id: "delegation-recovery",
      requesterPartnerId: requester.id,
      targetPartnerId: target.id,
      parentSessionId: requester.canonicalSessionId!,
      title: "Inspect retry safety",
      objective: "Inspect the retry path and report the concrete result."
    });

    await fixture.manager.recoverPending();
    await vi.waitFor(async () => {
      const view = await fixture.manager.getDelegation(persisted.id, requester.id);
      expect(view.delegation.status).toBe("completed");
    });
    const view = await fixture.manager.getDelegation(persisted.id, requester.id);
    expect(view).toMatchObject({
      delegation: {
        requesterPartnerId: requester.id,
        targetPartnerId: target.id,
        targetProfileVersion: target.profileVersion,
        status: "completed"
      },
      artifactCount: 0
    });
    expect(view.delegation.childSessionId).toBeDefined();
    expect(view.delegation.resultSummary).toContain("Reply from");
    fixture.operationalStore.putArtifact({
      id: "delegation-artifact",
      sha256: "a".repeat(64),
      byteLength: 12,
      mimeType: "text/plain",
      fileName: "delegation-result.txt",
      storageKey: "sha256/delegation-artifact",
      sessionId: view.delegation.childSessionId!,
      metadata: {}
    });
    expect((await fixture.manager.getDelegation(persisted.id, requester.id)).artifactCount).toBe(1);
    expect(fixture.manager.activity(target.id).artifactCount).toBe(1);
    expect(fixture.partnerStore.getSessionLink(view.delegation.childSessionId!)).toMatchObject({
      partnerId: target.id,
      role: "delegation",
      delegationId: persisted.id,
      parentSessionId: requester.canonicalSessionId
    });
    expect(fixture.operationalStore.getSession(view.delegation.childSessionId!).descriptor).toMatchObject({
      targetId: target.homeTargetId,
      appendSystemPrompt: target.identitySource
    });
    expect(fixture.manager.activity(requester.id).activeDelegationCount).toBe(0);
  });
});

async function createFixture(
  prepareAvatar?: (input: { readonly partner: PartnerProfileRecord; readonly homePath: string }) => Promise<void>,
  adapter: FakeBackendAdapter = new FakeBackendAdapter(PARTNER_PROFILE)
) {
  const directory = mkdtempSync(join(tmpdir(), "joko-partner-manager-"));
  const operationalStore = new OperationalStore(join(directory, "operational.db"));
  const partnerStore = new PartnerStore(join(directory, "partners.db"));
  const repository = new OperationalArtifactRepository(operationalStore);
  const artifacts = new ArtifactStore({
    rootDirectory: join(directory, "artifacts"),
    repository,
    ingestRoots: [directory]
  });
  await artifacts.initialize();
  const sessionHost = new SessionHost(
    operationalStore,
    artifacts,
    [adapter]
  );
  await sessionHost.initialize();
  const homesRoot = join(directory, "partner-homes");
  const registerWorkspace = vi.fn(async (
    input: Parameters<PartnerManagerOptions["workspaceService"]["register"]>[0]
  ) => input);
  const workspaceService: PartnerManagerOptions["workspaceService"] = { register: registerWorkspace };
  const manager = new PartnerManager({
    store: partnerStore,
    operationalStore,
    sessionHost,
    workspaceService,
    homesRoot,
    ...(prepareAvatar === undefined ? {} : { prepareAvatar })
  });
  cleanups.push(async () => {
    await sessionHost.dispose();
    partnerStore.close();
    operationalStore.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { manager, operationalStore, partnerStore, sessionHost, homesRoot, workspaceService, registerWorkspace };
}

function createInput(store: PartnerStore, displayName: string) {
  return {
    expectedDirectoryRevision: store.directoryState().revision,
    displayName,
    avatar: "orbit",
    identitySource: `You are ${displayName}, a long-lived work partner.`,
    templateId: "general",
    capabilities: capabilities(),
    usesDirectoryDefaults: false
  } as const;
}

function capabilities(): PartnerCapabilitiesRecord {
  return {
    modelChain: [{
      backendId: PI_LIKE_PROFILE.id,
      providerId: "test",
      modelId: "text",
      effort: "medium",
      fastMode: false
    }],
    permissionMode: "ask",
    planMode: false
  };
}
