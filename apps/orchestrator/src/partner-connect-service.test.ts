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

  it("maps activity, history, private threads, and revision-fenced delegation control", async () => {
    const fixture = await createFixture(2_000);
    const service = createPartnerConnectService(fixture.manager, () => ({ connectionId: "connection-1" }));
    const first = await fixture.manager.createPartner(partnerInput(fixture.partnerStore, "Aster"));
    const second = await fixture.manager.createPartner(partnerInput(fixture.partnerStore, "Beryl"));
    const delivery = await fixture.manager.sendPrivateMessage({
      callerSessionId: first.canonicalSessionId!,
      targetPartnerId: second.id,
      content: "Please inspect the recovery boundary."
    });

    const sessions = await service.listPartnerSessions(create(contract.ListPartnerSessionsRequestSchema, {
      partnerId: second.id
    }), context());
    expect(sessions.sessions).toEqual([
      expect.objectContaining({
        sessionId: second.canonicalSessionId,
        role: contract.PartnerSessionRole.CANONICAL,
        available: true,
        readOnly: false
      })
    ]);
    const threads = await service.listPartnerPrivateThreads(create(
      contract.ListPartnerPrivateThreadsRequestSchema,
      { partnerId: second.id }
    ), context());
    expect(threads.threads).toEqual([
      expect.objectContaining({ threadId: delivery.reservation.thread.id, messageCount: 1 })
    ]);
    const thread = await service.getPartnerPrivateThread(create(contract.GetPartnerPrivateThreadRequestSchema, {
      partnerId: second.id,
      threadId: delivery.reservation.thread.id
    }), context());
    expect(thread.messages).toEqual([
      expect.objectContaining({ content: "Please inspect the recovery boundary.", sequence: 1n })
    ]);
    const read = await service.markPartnerPrivateThreadRead(create(
      contract.MarkPartnerPrivateThreadReadRequestSchema,
      { partnerId: second.id, threadId: delivery.reservation.thread.id, throughSequence: 1n }
    ), context());
    expect(read.readState?.throughSequence).toBe(1n);

    await vi.waitFor(
      () => expect(fixture.manager.activity(second.id).latestReplyCursor).toBeDefined(),
      { timeout: 5_000 }
    );
    const beforeRead = await service.getPartner(create(contract.GetPartnerRequestSchema, {
      partnerId: second.id
    }), context());
    expect(beforeRead.partner?.activity?.unreadReplyCount).toBe(1n);
    const marked = await service.markPartnerRead(create(contract.MarkPartnerReadRequestSchema, {
      partnerId: second.id,
      throughCursor: beforeRead.partner!.activity!.latestReplyCursor
    }), context());
    expect(marked.activity?.unreadReplyCount).toBe(0n);

    const delegation = await fixture.manager.startDelegation({
      callerSessionId: first.canonicalSessionId!,
      targetPartnerId: second.id,
      title: "Recovery audit",
      objective: "Audit the recovery boundary."
    });
    const listed = await service.listPartnerDelegations(create(contract.ListPartnerDelegationsRequestSchema, {
      partnerId: first.id
    }), context());
    expect(listed.delegations).toEqual([
      expect.objectContaining({
        delegationId: delegation.delegation.id,
        targetPartnerId: second.id,
        childSessionId: expect.any(String)
      })
    ]);
    await expect(service.cancelPartnerDelegation(create(contract.CancelPartnerDelegationRequestSchema, {
      partnerId: first.id,
      delegationId: delegation.delegation.id,
      expectedRevision: revision(999n)
    }), context())).rejects.toMatchObject({ code: Code.Aborted });
    const current = await service.getPartnerDelegation(create(contract.GetPartnerDelegationRequestSchema, {
      partnerId: first.id,
      delegationId: delegation.delegation.id
    }), context());
    const cancelled = await service.cancelPartnerDelegation(create(contract.CancelPartnerDelegationRequestSchema, {
      partnerId: first.id,
      delegationId: delegation.delegation.id,
      expectedRevision: current.delegation!.revision
    }), context());
    expect(cancelled.delegation?.status).toBe(contract.PartnerDelegationStatus.CANCELLED);
  });
});

async function createFixture(streamDelayMs = 0) {
  const directory = mkdtempSync(join(tmpdir(), "joko-partner-service-"));
  const operationalStore = new OperationalStore(join(directory, "operational.db"));
  const partnerStore = new PartnerStore(join(directory, "partners.db"));
  const repository = new OperationalArtifactRepository(operationalStore);
  const artifacts = new ArtifactStore({ rootDirectory: join(directory, "artifacts"), repository, ingestRoots: [directory] });
  await artifacts.initialize();
  const sessionHost = new SessionHost(operationalStore, artifacts, [new FakeBackendAdapter({
    ...PROFILE,
    streamDelayMs
  })]);
  await sessionHost.initialize();
  const manager = new PartnerManager({
    store: partnerStore,
    operationalStore,
    sessionHost,
    workspaceService: { register: async (input) => input },
    homesRoot: join(directory, "partner-homes")
  });
  cleanups.push(async () => {
    await sessionHost.dispose();
    partnerStore.close();
    operationalStore.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { manager, partnerStore };
}

function partnerInput(store: PartnerStore, displayName: string) {
  return {
    expectedDirectoryRevision: store.directoryState().revision,
    displayName,
    avatar: "orbit",
    identitySource: `You are ${displayName}, a long-lived work partner.`,
    templateId: "general",
    capabilities: {
      modelChain: [{
        backendId: PROFILE.id,
        providerId: "test",
        modelId: "text",
        effort: "medium",
        fastMode: false
      }],
      permissionMode: "ask",
      planMode: false
    },
    usesDirectoryDefaults: false
  } as const;
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
