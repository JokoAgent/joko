import type { ConnectRouter } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";

import type { OrchestratorApplication } from "./application.js";
import { createConnectServices, registerConnectServices } from "./connect-services.js";

function stubApplication(overrides: Record<string, unknown> = {}): OrchestratorApplication {
  return {
    config: { publicOrigin: "https://orchestrator.example.test" },
    store: {},
    connections: {},
    artifacts: {},
    blobTransfers: {},
    artifactRepository: {},
    workspaces: {},
    sessionHost: {},
    scheduler: {},
    adapters: [],
    browserActivity: [],
    close: async () => undefined,
    ...overrides
  } as unknown as OrchestratorApplication;
}

describe("Connect service composition", () => {
  it("registers every public service and RPC handler", () => {
    const registrations: Array<{ descriptor: { method: Record<string, unknown> }; implementation: Record<string, unknown> }> = [];
    const router = {
      service(descriptor: { method: Record<string, unknown> }, implementation: Record<string, unknown>) {
        registrations.push({ descriptor, implementation });
      }
    } as unknown as ConnectRouter;

    registerConnectServices(router, stubApplication());

    const expectedServices = [
      contract.ConnectionService,
      contract.EventService,
      contract.OperationService,
      contract.BackendService,
      contract.TargetService,
      contract.SessionService,
      contract.PortableSessionService,
      contract.RunService,
      contract.SubagentService,
      contract.ReviewService,
      contract.QueueService,
      contract.SchedulerService,
      contract.InteractionService,
      contract.WorkspaceService,
      contract.WorktreeService,
      contract.ArtifactService,
      contract.HistoryMaintenanceService,
      contract.CredentialService,
      contract.SettingsService,
      contract.ManagedModelRuntimeService,
      contract.ToolService,
      contract.BrowserService,
      contract.RemoteHostService,
      contract.VoiceInputService,
      contract.PiService
    ] as unknown as Array<{ method: Record<string, unknown> }>;
    expect(registrations.map((item) => item.descriptor)).toEqual(expectedServices);
    expect(registrations.reduce((total, item) => total + Object.keys(item.descriptor.method).length, 0))
      .toBe(expectedServices.reduce((total, item) => total + Object.keys(item.method).length, 0));
    for (const { descriptor, implementation } of registrations) {
      for (const rpcName of Object.keys(descriptor.method)) expect(implementation[rpcName]).toBeTypeOf("function");
    }
  });

  it("does not disclose the owner-visible pairing code to a remote caller", async () => {
    const requestPairing = vi.fn(() => ({
      id: "pairing-1",
      code: "493821",
      expiresAt: Date.now() + 60_000
    }));
    const services = createConnectServices(stubApplication({ connections: { requestPairing } }));
    const beginPairing = services.connection.beginPairing as unknown as (
      request: { deviceDisplayName: string },
      context: unknown
    ) => Promise<{ challenge?: { humanCode: string } }> | { challenge?: { humanCode: string } };

    const response = await beginPairing(
      { deviceDisplayName: "Remote device" },
      { requestHeader: new Headers() }
    );

    expect(requestPairing).toHaveBeenCalledWith("Remote device", {
      name: "Remote device",
      kind: "unspecified",
      platform: undefined,
      appVersion: undefined
    });
    expect(response.challenge?.humanCode).toBe("");
  });

  it("only reopens pairing and returns the code to an authenticated owner", async () => {
    const authenticate = vi.fn(() => ({ id: "owner" }));
    const openPairingWindow = vi.fn();
    const requestPairing = vi.fn(() => ({ id: "pairing-2", code: "384201", expiresAt: Date.now() + 60_000 }));
    const services = createConnectServices(stubApplication({ connections: { authenticate, openPairingWindow, requestPairing } }));
    const beginPairing = services.connection.beginPairing as unknown as (
      request: { deviceDisplayName: string },
      context: unknown
    ) => { challenge?: { humanCode: string } };

    const response = beginPairing(
      { deviceDisplayName: "Owner-provisioned device" },
      { requestHeader: new Headers({ authorization: "Bearer owner-key" }) }
    );

    expect(authenticate).toHaveBeenCalledWith("Bearer owner-key");
    expect(openPairingWindow).toHaveBeenCalledOnce();
    expect(response.challenge?.humanCode).toBe("384201");
  });

  it("maps portable task drafts without forwarding a transient password into commit", async () => {
    const connection = {
      id: "connection-one",
      deviceId: "device-one",
      name: "Device",
      authKeyDigest: "digest",
      state: "active",
      pairedAt: 1,
      revision: 1n
    };
    const packageBlob = {
      $typeName: "joko.v1.BlobRef",
      blobId: "package-artifact",
      fileName: "task.jshare",
      mediaType: "application/vnd.joko.session",
      byteSize: 128n,
      sha256Hex: "a".repeat(64),
      disposition: contract.BlobDisposition.ATTACHMENT
    };
    const preview = {
      draftId: "portable-draft-one",
      expiresAt: 60_001,
      encrypted: true,
      passwordRequired: false,
      preview: {
        title: "Portable task",
        workspaceKind: "project" as const,
        exportedAt: "2026-08-25T00:00:00.000Z",
        applicationVersion: "1.2.3",
        formatVersion: 1 as const,
        backendCapability: "native-portable-session-v1",
        fidelity: "full" as const,
        messageCount: 4,
        mediaCount: 2,
        workerCount: 1,
        nativeHistory: true
      }
    };
    const sessionHost = {
      exportPortableSession: vi.fn(async () => ({
        artifact: {
          id: "package-artifact",
          fileName: "task.jshare",
          mimeType: "application/vnd.joko.session",
          byteLength: 128,
          sha256: "a".repeat(64)
        },
        fidelity: "full",
        messageCount: 4,
        mediaCount: 2,
        missingMediaCount: 0,
        workerCount: 1,
        mediaBytes: 64
      })),
      inspectPortableSessionImport: vi.fn(async () => preview),
      unlockPortableSessionImport: vi.fn(async () => preview),
      cancelPortableSessionImport: vi.fn(),
      commitPortableSessionImport: vi.fn(async () => ({
        replayed: false,
        value: {
          sessionId: "session-imported",
          fidelity: "full",
          messageCount: 4,
          mediaCount: 2,
          workerCount: 1,
          replacedSessionIds: []
        }
      }))
    };
    const services = createConnectServices(stubApplication({
      connections: { authenticate: vi.fn(() => connection) },
      sessionHost
    }));
    const context = { requestHeader: new Headers({ authorization: "Bearer owner-key" }) };

    const inspected = await (services.portableSession.inspectPortableSessionImport as any)({ package: packageBlob }, context);
    expect(inspected.draft).toMatchObject({
      draftId: "portable-draft-one",
      encrypted: true,
      passwordRequired: false,
      preview: { title: "Portable task", workspaceKind: contract.WorkspaceKind.USER_PROJECT }
    });
    await (services.portableSession.unlockPortableSessionImport as any)({
      draftId: "portable-draft-one",
      password: "transient package secret"
    }, context);
    const committed = await (services.portableSession.commitPortableSessionImport as any)({
      operationId: "portable-import-operation",
      draftId: "portable-draft-one",
      targetId: "target-one",
      permissionMode: contract.PermissionMode.ASK,
      planMode: false,
      overwrite: false,
      useWorktree: false,
      refreshWorktreeRemote: false
    }, context);

    expect(committed).toMatchObject({
      replayed: false,
      result: { sessionId: "session-imported", fidelity: contract.PortableSessionFidelity.FULL }
    });
    expect(sessionHost.commitPortableSessionImport).toHaveBeenCalledWith(expect.not.objectContaining({
      password: expect.anything(),
      package: expect.anything()
    }));
  });
});
