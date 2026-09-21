import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeBackendAdapter, PI_LIKE_PROFILE } from "@joko/testkit";
import {
  OperationalStore,
  PartnerStore,
  type PartnerCapabilitiesRecord,
  type PartnerProfileRecord
} from "@joko/store";
import { afterEach, describe, expect, it } from "vitest";

import { OperationalArtifactRepository } from "./artifact-repository.js";
import { ArtifactStore } from "./artifact-store.js";
import { PartnerManager, partnerSessionRuntimeFallback } from "./partner-manager.js";
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
  const manager = new PartnerManager({
    store: partnerStore,
    operationalStore,
    sessionHost,
    homesRoot,
    ...(prepareAvatar === undefined ? {} : { prepareAvatar })
  });
  cleanups.push(async () => {
    await sessionHost.dispose();
    partnerStore.close();
    operationalStore.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { manager, operationalStore, partnerStore, sessionHost, homesRoot };
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
