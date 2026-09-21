import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { FakeBackendAdapter, PI_LIKE_PROFILE } from "@joko/testkit";
import { OperationalStore, PartnerStore } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OperationalArtifactRepository } from "./artifact-repository.js";
import { ArtifactStore } from "./artifact-store.js";
import { createPartnerConnectService } from "./partner-connect-service.js";
import { PartnerManager } from "./partner-manager.js";
import { SessionHost } from "./session-host.js";

const cleanups: Array<() => Promise<void> | void> = [];
const PROFILE = {
  ...PI_LIKE_PROFILE,
  capabilities: [
    ...PI_LIKE_PROFILE.capabilities.map((capability) => capability.key === "permission.modes"
      ? { key: "permission.modes", supported: true, options: ["ask", "auto", "bypassPermissions"] }
      : capability),
    { key: "permission.change", supported: true }
  ]
} as const;

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("PartnerService", () => {
  it("authenticates and maps defaults, creation, autosave fencing, and lifecycle", async () => {
    const fixture = await createFixture();
    const authenticate = vi.fn(() => ({ connectionId: "connection-1" }));
    const service = createPartnerConnectService(fixture.manager, authenticate);
    const callContext = context();

    const initial = await service.getPartnerDirectory(
      create(contract.GetPartnerDirectoryRequestSchema), callContext
    );
    expect(initial.directory).toMatchObject({
      revision: { value: 1n },
      activeCount: 0,
      archivedCount: 0,
      errorCount: 0,
      templates: expect.arrayContaining([expect.objectContaining({ templateId: "general" })]),
      avatarPresets: ["orbit", "spark", "leaf", "wave"]
    });

    const defaults = await service.updatePartnerDefaults(create(contract.UpdatePartnerDefaultsRequestSchema, {
      expectedDirectoryRevision: initial.directory!.revision,
      capabilities: protoCapabilities()
    }), callContext);
    expect(defaults.directory).toMatchObject({ defaultCapabilities: protoCapabilities() });

    const created = await service.createPartner(create(contract.CreatePartnerRequestSchema, {
      expectedDirectoryRevision: defaults.directory!.revision,
      draft: create(contract.PartnerDraftSchema, {
        displayName: "Aster",
        avatar: "orbit",
        identitySource: "You are Aster, a long-lived work partner.",
        templateId: "general",
        usesDirectoryDefaults: true
      })
    }), callContext);
    expect(created.partner).toMatchObject({
      displayName: "Aster",
      lifecycle: contract.PartnerLifecycle.ACTIVE,
      initializationState: contract.PartnerInitializationState.READY,
      invitationStage: contract.PartnerInvitationStage.READY,
      usesDirectoryDefaults: true,
      canonicalSessionId: expect.any(String)
    });
    const createdRevision = created.partner!.revision!;

    const updated = await service.updatePartner(create(contract.UpdatePartnerRequestSchema, {
      partnerId: created.partner!.partnerId,
      expectedRevision: createdRevision,
      patch: create(contract.PartnerPatchSchema, {
        displayName: "Aster Prime",
        usesDirectoryDefaults: false
      })
    }), callContext);
    expect(updated.partner).toMatchObject({
      displayName: "Aster Prime",
      usesDirectoryDefaults: false,
      initializationState: contract.PartnerInitializationState.READY
    });
    await expect(service.updatePartner(create(contract.UpdatePartnerRequestSchema, {
      partnerId: created.partner!.partnerId,
      expectedRevision: createdRevision,
      patch: create(contract.PartnerPatchSchema, { displayName: "Stale" })
    }), callContext)).rejects.toMatchObject({ code: Code.Aborted });

    const archived = await service.setPartnerLifecycle(create(contract.SetPartnerLifecycleRequestSchema, {
      partnerId: updated.partner!.partnerId,
      expectedRevision: updated.partner!.revision,
      lifecycle: contract.PartnerLifecycle.ARCHIVED
    }), callContext);
    expect(archived.partner?.lifecycle).toBe(contract.PartnerLifecycle.ARCHIVED);
    const listed = await service.listPartners(create(contract.ListPartnersRequestSchema, {
      lifecycle: contract.PartnerLifecycle.ARCHIVED
    }), callContext);
    expect(listed.partners?.map((partner) => partner.partnerId) ?? []).toEqual([created.partner!.partnerId]);
    const restored = await service.setPartnerLifecycle(create(contract.SetPartnerLifecycleRequestSchema, {
      partnerId: archived.partner!.partnerId,
      expectedRevision: archived.partner!.revision,
      lifecycle: contract.PartnerLifecycle.ACTIVE
    }), callContext);
    expect(restored.partner?.lifecycle).toBe(contract.PartnerLifecycle.ACTIVE);
    expect(authenticate).toHaveBeenCalledTimes(8);
  });

  it("fails closed for unavailable ownership and invalid public enums", async () => {
    const unavailable = createPartnerConnectService(undefined, () => ({ connectionId: "connection-1" }));
    expect(() => unavailable.getPartnerDirectory(
      create(contract.GetPartnerDirectoryRequestSchema), context()
    )).toThrow(expect.objectContaining({ code: Code.Unimplemented }));

    const fixture = await createFixture();
    const service = createPartnerConnectService(fixture.manager, () => ({ connectionId: "connection-1" }));
    await expect(service.updatePartnerDefaults(create(contract.UpdatePartnerDefaultsRequestSchema, {
      expectedDirectoryRevision: revision(1n),
      capabilities: create(contract.PartnerCapabilitiesSchema, {
        ...protoCapabilities(),
        permissionMode: contract.PermissionMode.BYPASS_PERMISSIONS
      })
    }), context())).rejects.toMatchObject({ code: Code.InvalidArgument });
  });
});

async function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "joko-partner-service-"));
  const operationalStore = new OperationalStore(join(directory, "operational.db"));
  const partnerStore = new PartnerStore(join(directory, "partners.db"));
  const repository = new OperationalArtifactRepository(operationalStore);
  const artifacts = new ArtifactStore({ rootDirectory: join(directory, "artifacts"), repository, ingestRoots: [directory] });
  await artifacts.initialize();
  const sessionHost = new SessionHost(operationalStore, artifacts, [new FakeBackendAdapter(PROFILE)]);
  await sessionHost.initialize();
  const manager = new PartnerManager({
    store: partnerStore,
    operationalStore,
    sessionHost,
    homesRoot: join(directory, "partner-homes")
  });
  cleanups.push(async () => {
    await sessionHost.dispose();
    partnerStore.close();
    operationalStore.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { manager };
}

function protoCapabilities(): contract.PartnerCapabilities {
  return create(contract.PartnerCapabilitiesSchema, {
    modelChain: [create(contract.PartnerModelRouteSchema, {
      backendId: PROFILE.id,
      providerId: "test",
      modelId: "text",
      effort: "medium",
      fastMode: false
    })],
    permissionMode: contract.PermissionMode.ASK,
    planMode: false
  });
}

function revision(value: bigint): contract.Revision {
  return create(contract.RevisionSchema, { value, etag: `W/"rev-${value.toString()}"` });
}

function context(): HandlerContext {
  return { signal: new AbortController().signal } as HandlerContext;
}
